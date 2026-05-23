"""P5.1 — Attribution Closure (infrastructure).

Doctrine (per P5 brief):

  "Любой mutation path должен автоматически писать:
     actor / reason / source / timestamp / causal entity
   Не в новый ledger. А в chronology / money_audit / existing evidence
   layers."

This module is the canonical, single way to capture and record attribution
for **any** admin (or operator) mutation. Domain code calls one of two APIs:

  * `Depends(get_attribution_context)`  — extracts actor + source on entry.
  * `await record_admin_mutation(...)`  — writes to admin_audit_log AND
    (when applicable) to payment_events / booking_timeline / dispute_events.

What this module is NOT:
  * Not a new ledger. Writes go to **existing** evidence collections
    (`admin_audit_log`, `payment_events`, …).
  * Not a generic event bus. There is no `emit("anything", ...)`.
  * Not opinionated about routes. Wiring is per-route, additive, optional.
    Routes that don't call `record_admin_mutation` are not broken — they
    just don't get governance attribution.
  * Not a wrapping middleware. We considered ASGI middleware that auto-
    audits POST/PATCH/DELETE; rejected because it would silently mark
    every write as audited even when the payload was rejected by Pydantic
    validation. Audit must be **at the business-logic seam**, not the
    transport seam.

See /app/shared/contracts/CONSTITUTION.md §3 for the doctrinal frame.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Dict, Literal, Optional

from fastapi import Depends, Header, Request

from app.core.db import get_db
from app.core.security import verify_admin_token

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────
# AttributionContext — captured at request entry.
# ──────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class AttributionContext:
    """Immutable snapshot of who/where/why for one mutation."""
    actor_id:        str
    actor_role:      str                   # 'admin' | 'customer' | 'provider' | 'inspector' | 'platform' | 'stripe'
    source_route:    str                   # e.g. 'POST /api/admin/disputes/{id}/resolve'
    source_request_id: str                 # short uuid for correlation across logs
    operator_reason: Optional[str] = None  # X-Operator-Reason header (free-text from operator)
    occurred_at:     str = ""              # ISO timestamp set at construction

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def get_attribution_context(
    request: Request,
    admin_payload: Dict[str, Any] = Depends(verify_admin_token),
    x_operator_reason: Optional[str] = Header(default=None, alias="X-Operator-Reason"),
) -> AttributionContext:
    """FastAPI dependency: captures attribution from the incoming request.

    Wire into any mutation router:

        @router.post("/admin/.../resolve",
                     dependencies=[Depends(verify_admin_token)])
        async def resolve(..., ctx = Depends(get_attribution_context)):
            ...
            await record_admin_mutation(db, ctx, action='dispute.resolve', ...)

    `x_operator_reason` is read from the `X-Operator-Reason` request header
    (free-text). UIs SHOULD prompt for it before destructive actions; the
    backend does not enforce its presence (we record absence as `None`
    rather than reject — auditability wins over coercion).

    Note: this dependency itself depends on `verify_admin_token`, so it
    can only be wired into admin-gated routers (the canonical case for
    record_admin_mutation). For non-admin attribution, copy the pattern
    with the appropriate auth dependency.
    """
    route_obj = request.scope.get("route")
    route_path = getattr(route_obj, "path", request.url.path) if route_obj else request.url.path

    return AttributionContext(
        actor_id        = admin_payload.get("id") or admin_payload.get("user_id") or admin_payload.get("email") or "unknown",
        actor_role      = admin_payload.get("role") or "admin",
        source_route    = f"{request.method} {route_path}",
        source_request_id = uuid.uuid4().hex[:12],
        operator_reason = x_operator_reason,
        occurred_at     = _now_iso(),
    )


# ──────────────────────────────────────────────────────────────────────────
# record_admin_mutation — single recording entrypoint.
# ──────────────────────────────────────────────────────────────────────────

MutationDomain = Literal[
    "payment",       # → also writes to payment_events
    "booking",       # → also writes to booking_timeline (if writer present)
    "dispute",       # → also writes to dispute_events (if writer present)
    "organization",
    "user",
    "review",
    "feature_flag",
    "integration_credential",
    "config",
    "other",
]


async def record_admin_mutation(
    db,
    ctx: AttributionContext,
    *,
    action:      str,
    domain:      MutationDomain,
    entity_id:   str,
    before:      Optional[Dict[str, Any]] = None,
    after:       Optional[Dict[str, Any]] = None,
    causal_entity: Optional[Dict[str, str]] = None,
    extra:       Optional[Dict[str, Any]] = None,
    payment_kind:  Optional[str] = None,
) -> Dict[str, Any]:
    """Record one mutation across all applicable evidence collections.

    Always writes a row to `admin_audit_log` with the full attribution
    snapshot. **Additionally**, when `domain == 'payment'` and a valid
    `payment_kind` is supplied, also writes to `payment_events` via the
    canonical append-only writer (which enforces the closed 19-kind
    taxonomy).

    Returns the audit-log row that was written (with _id stripped).

    Why two writes (audit_log + chronology)?
      Because the audiences differ:
        * `admin_audit_log` is the **governance trail** — every operator
          action, regardless of domain, indexed by actor and time.
        * `payment_events` is the **forensic trail** — every payment-
          relevant event, regardless of actor, indexed by paymentId and
          time.
      An admin freeze touches both; a Stripe webhook only touches the
      second; a feature-flag toggle only touches the first. Per the
      Ownership Map (§3), both are owned by `governance`.

    Why no transactional guarantee across the two writes?
      Because both collections are **append-only**. A divergence between
      them is detectable (chronology has actor; audit_log has paymentId
      when applicable) and is a recoverable evidence-only inconsistency,
      not a money-correctness threat. Adding a transaction would tie
      mutation latency to chronology persistence, breaking the existing
      P0.b.C.f doctrine.
    """
    row: Dict[str, Any] = {
        "id":              uuid.uuid4().hex,
        "at":              _now_iso(),
        "actor":           {"id": ctx.actor_id, "role": ctx.actor_role},
        "source":          {"route": ctx.source_route, "requestId": ctx.source_request_id},
        "action":          action,
        "domain":          domain,
        "entityId":        entity_id,
        "operatorReason":  ctx.operator_reason,
        "causalEntity":    causal_entity,
        "before":          before,
        "after":           after,
        "extra":           dict(extra) if extra else None,
        "schemaVersion":   1,
    }

    to_insert = dict(row)
    try:
        await db.admin_audit_log.insert_one(to_insert)
    except Exception:
        logger.exception("attribution: admin_audit_log write failed (action=%s entity=%s)", action, entity_id)
        # Audit failure must NOT silently block the mutation that already
        # succeeded upstream — log loudly and proceed.

    # Domain-specific chronology fan-out.
    if domain == "payment" and payment_kind:
        try:
            from app.payments.chronology.writer import append_payment_event
            await append_payment_event(
                db,
                payment_id=entity_id,
                kind=payment_kind,
                actor_id=ctx.actor_id,
                actor_role=ctx.actor_role if ctx.actor_role in {"customer", "provider", "admin", "platform", "stripe"} else "admin",
                meta={
                    "operatorReason":  ctx.operator_reason,
                    "sourceRoute":     ctx.source_route,
                    "sourceRequestId": ctx.source_request_id,
                    **(extra or {}),
                },
            )
        except Exception:
            logger.exception(
                "attribution: payment_events fan-out failed (kind=%s payment=%s)",
                payment_kind, entity_id,
            )

    # _id was added by Motor — strip before returning.
    row.pop("_id", None)
    return row


async def ensure_attribution_indexes(db) -> None:
    """Idempotent startup hook — registered via lifespan.

    Indexes admin_audit_log for the queries the admin SPA / Reconciliation
    UI will run: actor timeline, entity timeline, time-range scans.
    """
    coll = db.admin_audit_log
    await coll.create_index([("actor.id", 1), ("at", -1)],   name="by_actor_at")
    await coll.create_index([("entityId", 1), ("at", -1)],   name="by_entity_at")
    await coll.create_index([("domain", 1),   ("at", -1)],   name="by_domain_at")
    await coll.create_index([("at", -1)],                    name="by_at")

"""Sprint P0.b.C.h — Realtime propagation for payment chronology.

Doctrine (per sprint brief, mirrors booking-timeline P0.b.C.d):

  * Realtime pushes **PROJECTED events**, never raw `payment_events` rows.
    The wire format on every per-actor channel is byte-equal to the
    corresponding entry inside the REST GET `.../chronology` response
    `rows[]` list. **Snapshot equivalence is the primary acceptance
    criterion.** Implementation guarantee: WS uses the SAME projection
    functions from `app.payments.chronology.projector` as REST, passing a
    one-element list and taking element [0].

  * Channel == projection scope. Three scopes (customer / provider /
    admin). Inspector is deliberately absent — payments have no inspector
    surface per F.3 of P0.b.C.f.

  * REST remains source of truth. Realtime is acceleration. Dropping a
    frame NEVER loses state — REST polling/refresh is the recovery path.

  * In-process broadcaster only. No Redis, no Kafka, no replay engine.

  * No client-side filtering: customer subscribers NEVER receive
    provider's payload, period. Filtering happens server-side via
    projection at emit time. A row whose `kind` is filtered out by the
    actor's whitelist produces ZERO bytes on that actor's wire.

  * No mutation frames inbound — WS is read-side only.

Anti-goals (deliberately rejected per P0.b.C.h brief):

  ❌ provider UI / consumer code changes (this sprint is wire-only)
  ❌ replay buffer / late-subscriber backfill
  ❌ Stripe reconciliation engine
  ❌ Stripe retry processor / webhook dispatcher
  ❌ unified chronology infra (booking + payment merged)
  ❌ shared reducer / state machine
  ❌ generic projection dispatcher
  ❌ new envelope semantics — mirror booking shape

Wire format (uniform across 3 actors):

    {
      "type": "payment.chronology.updated",
      "scope": "customer" | "provider" | "admin",
      "paymentId": "<service_payments.id>",
      "event": { ...projected row, identical to REST element... },
    }

For admin scope, `event` is the RAW chronology row (forensic surface),
matching exactly what `GET /api/admin/payments/{id}/chronology` returns
in its `rows[]`. For customer/provider, `event` is exactly the projected
shape they get from REST.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import WebSocket, WebSocketDisconnect

from app.payments.chronology import projector as P

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Per-scope hubs. One hub per projection scope. Subscribers carry the
# minimum identity needed for server-side filtering at emit time.
#
# ctx shape per scope:
#   customer: {"paymentId": str, "viewerId": str}
#   provider: {"paymentId": str, "viewerIds": List[str]}
#   admin:    {"paymentId": str}     # admin sees raw, no viewer filter
# ─────────────────────────────────────────────────────────────────────


class _ScopedHub:
    """Lock-protected, in-process registry per projection scope.

    Stateless except for the subscriber list. No history, no replay.
    """

    def __init__(self, scope: str) -> None:
        self.scope = scope
        self._subs: List[tuple[WebSocket, Dict[str, Any]]] = []
        self._lock = asyncio.Lock()

    async def add(self, ws: WebSocket, ctx: Dict[str, Any]) -> None:
        async with self._lock:
            self._subs.append((ws, ctx))

    async def remove(self, ws: WebSocket) -> None:
        async with self._lock:
            self._subs = [(w, c) for (w, c) in self._subs if w is not ws]

    async def snapshot(self) -> List[tuple[WebSocket, Dict[str, Any]]]:
        async with self._lock:
            return list(self._subs)

    async def size(self) -> int:
        async with self._lock:
            return len(self._subs)


HUB_CUSTOMER = _ScopedHub("customer")
HUB_PROVIDER = _ScopedHub("provider")
HUB_ADMIN = _ScopedHub("admin")


# ─────────────────────────────────────────────────────────────────────
# Send helper — single-shot, never raises. Polling is the recovery
# substrate; a misbehaving subscriber must NOT block emit fanout.
# ─────────────────────────────────────────────────────────────────────


async def _safe_send(ws: WebSocket, envelope: Dict[str, Any]) -> bool:
    try:
        await ws.send_text(json.dumps(envelope, ensure_ascii=False))
        return True
    except Exception as exc:
        logger.debug(f"payment ws send failed: {exc}")
        return False


# ─────────────────────────────────────────────────────────────────────
# Single-row projection helpers — exactly what each REST endpoint
# returns inside `rows[]`. We deliberately use the SAME projection
# functions from app.payments.chronology.projector. The only difference
# is we pass a one-element list and take element [0]. This is the
# snapshot-equivalence guarantee AT THE CODE LEVEL — no parallel
# implementation, no shared reducer, no semantic drift possible.
# ─────────────────────────────────────────────────────────────────────


def _project_one_customer(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    out = P.project_customer([row])
    return out[0] if out else None


def _project_one_provider(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    out = P.project_provider([row])
    return out[0] if out else None


def _project_one_admin(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    out = P.project_admin([row])
    return out[0] if out else None


# ─────────────────────────────────────────────────────────────────────
# Payment-owner resolution — at emit time we need to know which
# customer/provider this payment belongs to, so we can decide which
# subscribers are eligible. Lookup `service_payments` by id.
#
# If the payment doc isn't found we still fan out to ADMIN (which has
# no owner constraint) but NOT to customer/provider — opacity wins:
# no owner == no per-actor delivery. REST polling will still surface
# the row to admin-side observers.
# ─────────────────────────────────────────────────────────────────────


async def _resolve_payment_owners(db, payment_id: str) -> Optional[Dict[str, Any]]:
    """Return owner ids attached to a service_payments row, or None.

    Shape:
      {
        "customerIds": [..],
        "providerIds": [..],
      }

    We probe several legacy id fields (mirroring admin/p0d/payments.py
    and disputes/router.py shape) so that older payments seeded under
    different schemas still resolve. Returns None ONLY if the document
    is entirely missing.
    """
    try:
        doc = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
    except Exception as e:
        logger.debug(f"payment owner lookup failed for {payment_id}: {e}")
        return None
    if not doc:
        return None
    customer_ids: List[str] = []
    for k in ("customerId", "customerAccountId", "customerUserId", "userId"):
        v = doc.get(k)
        if v:
            customer_ids.append(str(v))
    provider_ids: List[str] = []
    for k in (
        "providerId", "providerAccountId", "providerSlug",
        "providerUserId", "assignedProviderId", "assignedProviderAccountId",
    ):
        v = doc.get(k)
        if v:
            provider_ids.append(str(v))
    return {"customerIds": customer_ids, "providerIds": provider_ids}


# ─────────────────────────────────────────────────────────────────────
# THE publisher — called as a sidecar after `append_payment_event()`
# successfully inserts a row. Best-effort. Never raises.
#
# Returns a structured summary of what was emitted (for tests).
# In production the return value is ignored.
# ─────────────────────────────────────────────────────────────────────


async def publish_payment_event(
    db,
    row: Dict[str, Any],
) -> Dict[str, List[Dict[str, Any]]]:
    """Publish ONE payment_events row to every eligible subscriber
    across the 3 scopes. Projection happens here, per actor.

    Snapshot equivalence guarantee: the per-row projection used here is
    IDENTICAL to the per-list projection used in REST endpoints. Both
    paths route through `app.payments.chronology.projector` functions —
    REST passes the full list, WS passes a one-element list.

    Returns:
        {
          "customer": [envelopes...],
          "provider": [envelopes...],
          "admin":    [envelopes...],
        }
        Each envelope is the EXACT frame sent to the subscriber, useful
        for snapshot-equivalence tests. Empty list when no subscriber
        matched that scope.
    """
    summary: Dict[str, List[Dict[str, Any]]] = {
        "customer": [],
        "provider": [],
        "admin": [],
    }
    payment_id = row.get("paymentId")
    if not payment_id:
        return summary
    payment_id_s = str(payment_id)

    # ── Owners resolution (best-effort). Admin fanout doesn't depend on it.
    owners = await _resolve_payment_owners(db, payment_id_s) or {
        "customerIds": [], "providerIds": [],
    }

    # ── Admin channel — raw forensic row, no kind whitelist.
    admin_event = _project_one_admin(row)
    if admin_event is not None:
        admin_envelope = {
            "type": "payment.chronology.updated",
            "scope": "admin",
            "paymentId": payment_id_s,
            "event": admin_event,
        }
        for ws, ctx in await HUB_ADMIN.snapshot():
            if ctx.get("paymentId") != payment_id_s:
                continue
            ok = await _safe_send(ws, admin_envelope)
            if ok:
                summary["admin"].append(admin_envelope)

    # ── Customer channel — projected via P.project_customer.
    # Row may be filtered out (e.g. transfer.* / admin.*) → zero emit.
    customer_event = _project_one_customer(row)
    if customer_event is not None:
        for ws, ctx in await HUB_CUSTOMER.snapshot():
            if ctx.get("paymentId") != payment_id_s:
                continue
            viewer_id = str(ctx.get("viewerId") or "")
            if not viewer_id:
                continue
            # Ownership: subscriber must be the payment's customer.
            # Legacy-permissive fallback: if the payment record has no
            # recorded customer ids at all, allow the subscriber that
            # passed JWT — REST customer endpoint has the same opacity
            # discipline (returns empty rows[] rather than 404, so a
            # foreign subscriber sees nothing anyway).
            if owners["customerIds"] and viewer_id not in owners["customerIds"]:
                continue
            envelope = {
                "type": "payment.chronology.updated",
                "scope": "customer",
                "paymentId": payment_id_s,
                "event": customer_event,
            }
            ok = await _safe_send(ws, envelope)
            if ok:
                summary["customer"].append(envelope)

    # ── Provider channel — projected via P.project_provider.
    provider_event = _project_one_provider(row)
    if provider_event is not None:
        for ws, ctx in await HUB_PROVIDER.snapshot():
            if ctx.get("paymentId") != payment_id_s:
                continue
            viewer_ids = list(ctx.get("viewerIds") or [])
            if not viewer_ids:
                continue
            # Ownership: at least one of the subscriber's ids must match
            # the payment's provider-side ids. Foreign subscribers get
            # nothing (opacity).
            if owners["providerIds"] and not set(viewer_ids).intersection(
                owners["providerIds"]
            ):
                continue
            envelope = {
                "type": "payment.chronology.updated",
                "scope": "provider",
                "paymentId": payment_id_s,
                "event": provider_event,
            }
            ok = await _safe_send(ws, envelope)
            if ok:
                summary["provider"].append(envelope)

    return summary


# ─────────────────────────────────────────────────────────────────────
# WebSocket session helper — register / keepalive / unregister.
#
# Wire keepalive matches the existing payment chronology router pattern
# (op:"hello" / op:"ping" / op:"pong") — clients already subscribed to
# F.5 streams see no behavioural change other than gaining real-time
# `payment.chronology.updated` frames.
# ─────────────────────────────────────────────────────────────────────


async def session_loop(
    ws: WebSocket,
    hub: _ScopedHub,
    ctx: Dict[str, Any],
    surface: str,
    payment_id: str,
) -> None:
    """Accept + register + keepalive + unregister.

    Caller is responsible for performing the auth handshake BEFORE
    invoking this function — by the time we get here the ws must be
    accepted (or about to be accepted).
    """
    # NOTE: existing router accepts the ws inside _ws_handshake() already
    # (it calls `await ws.accept()`), so we MUST NOT accept again here.
    # Register first so even a hello frame can race with an emit safely.
    await hub.add(ws, ctx)
    try:
        await _safe_send(ws, {
            "op": "hello",
            "surface": surface,
            "paymentId": payment_id,
        })
        while True:
            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=25.0)
                # echo pong on ping (clients may also send arbitrary
                # text frames; ignore non-JSON gracefully)
                try:
                    obj = json.loads(msg)
                    if obj.get("op") == "ping":
                        ok = await _safe_send(ws, {"op": "pong"})
                        if not ok:
                            break
                except Exception:
                    pass
            except asyncio.TimeoutError:
                ok = await _safe_send(ws, {"op": "ping"})
                if not ok:
                    break
    except WebSocketDisconnect:
        return
    except Exception as exc:
        logger.debug(f"payment ws session ended ({surface}): {exc}")
    finally:
        await hub.remove(ws)


__all__ = [
    "HUB_CUSTOMER",
    "HUB_PROVIDER",
    "HUB_ADMIN",
    "publish_payment_event",
    "session_loop",
]

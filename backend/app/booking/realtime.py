"""P0.b.C.d — Realtime propagation for booking timeline.

Doctrine (per sprint brief):

  * Realtime pushes **PROJECTED events**, never raw `booking_timeline`
    rows. The wire format on every per-actor channel is byte-equal to
    the corresponding entry in the REST `GET /.../timeline` response
    `events` list. **Snapshot equivalence is the primary acceptance
    criterion.**
  * Channel == projection scope. Four channels:
      customer  / provider  / inspector  / admin
    Each subscriber is bound to ONE scope and ONE addressable id
    (bookingId for customer/provider, jobId for inspector, bookingId
    for admin).
  * REST remains source of truth. Realtime is acceleration. Dropping
    a frame NEVER loses state — the polling/refresh substrate is the
    recovery path.
  * In-process broadcaster only. No Redis, no Kafka, no replay engine.
  * No client-side filtering: customer subscribers NEVER receive
    provider's payload, period. Filtering happens server-side via
    projection at emit time.
  * No mutation frames inbound — WS is read-side only.

Anti-goals (deliberately rejected):
  ❌ EventBus, replay engine, global subscription registry
  ❌ Generic projection dispatcher
  ❌ Raw row broadcast to all actors
  ❌ Client-side permission filtering
  ❌ Realtime as mandatory dependency
  ❌ WebSocket architecture rewrite — reuse chat hub pattern

Wire format (uniform across actors):

    {
      "type": "timeline.updated",
      "scope": "customer" | "provider" | "inspector" | "admin",
      "bookingId": "<request_id>",          # customer/provider/admin
      "jobId":     "<job_id>",              # inspector ONLY
      "event": {                            # PROJECTED, sanitized
          "key":   "...",
          "label": "...",
          ...
      },
    }

For admin scope, `event` is the RAW timeline row (forensic surface).
For customer/provider/inspector, `event` is exactly the projected
shape they get from REST.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import WebSocket, WebSocketDisconnect

from .projections.customer import project_timeline_for_customer
from .projections.provider import project_timeline_for_provider
from .projections.inspector import project_timeline_for_inspector

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Per-scope hubs. One hub per projection scope. Subscribers carry the
# minimum identity needed for server-side filtering at emit time.
# ─────────────────────────────────────────────────────────────────────

class _ScopedHub:
    """Lock-protected, in-process registry per projection scope.

    A subscriber is `(ws, ctx)`. `ctx` schema is scope-specific:
      customer:  {"bookingId": str, "viewerId": str}
      provider:  {"bookingId": str, "viewerIds": List[str]}
      inspector: {"jobId":     str, "requestId": str, "viewerIds": List[str]}
      admin:     {"bookingId": str}                     # admin sees raw, no viewer filter
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
HUB_INSPECTOR = _ScopedHub("inspector")
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
        logger.debug(f"booking ws send failed: {exc}")
        return False


# ─────────────────────────────────────────────────────────────────────
# Single-row projection helpers — exactly what each REST endpoint
# returns inside `events[]`. We deliberately use the SAME projection
# functions; the only difference is we pass a one-element list and
# take element [0]. This is the snapshot-equivalence guarantee at
# the code level.
# ─────────────────────────────────────────────────────────────────────


def _project_one_customer(row: Dict[str, Any], customer_id: str) -> Optional[Dict[str, Any]]:
    out = project_timeline_for_customer([row], customer_id=customer_id)
    return out[0] if out else None


def _project_one_provider(row: Dict[str, Any], provider_ids: List[str]) -> Optional[Dict[str, Any]]:
    out = project_timeline_for_provider([row], provider_ids=provider_ids)
    return out[0] if out else None


def _project_one_inspector(row: Dict[str, Any], inspector_ids: List[str]) -> Optional[Dict[str, Any]]:
    out = project_timeline_for_inspector([row], inspector_ids=inspector_ids)
    return out[0] if out else None


# ─────────────────────────────────────────────────────────────────────
# Booking-owner resolution — needed at emit time to decide which
# subscribers are eligible AND which projection ids to feed.
#
# We probe the same collections the REST routers use; if the booking
# can't be resolved we silently no-op the emit (best-effort).
# ─────────────────────────────────────────────────────────────────────


async def _resolve_booking_owners(db, booking_id: str) -> Optional[Dict[str, Any]]:
    """Return a dict with the actor identifiers attached to a booking,
    or None if no booking row is found.

    Shape:
      {
        "customerIds": [..],   # for matching customer ctx.viewerId
        "providerIds": [..],   # for matching provider ctx.viewerIds
      }
    Inspector ownership is resolved at subscribe time (via job lookup,
    not booking lookup) because inspector subscribes per-jobId.
    """
    for coll_name, id_field in (
        ("web_bookings", "id"),
        ("service_requests", "id"),
        ("car_requests", "_id"),
    ):
        doc = await db[coll_name].find_one({id_field: booking_id}, {"_id": 0})
        if not doc:
            continue
        customer_ids: List[str] = []
        for k in ("customerId", "userId"):
            v = doc.get(k)
            if v:
                customer_ids.append(str(v))
        provider_ids: List[str] = []
        for k in (
            "providerId", "providerAccountId", "providerSlug",
            "assignedProviderId", "assignedProviderAccountId", "providerUserId",
        ):
            v = doc.get(k)
            if v:
                provider_ids.append(str(v))
        return {"customerIds": customer_ids, "providerIds": provider_ids}
    return None


# ─────────────────────────────────────────────────────────────────────
# THE publisher — called as a sidecar after observe_transition()
# successfully writes a row. Best-effort. Never raises.
#
# Returns a structured summary of what was emitted (for tests).
# In production the return value is ignored.
# ─────────────────────────────────────────────────────────────────────


async def publish_timeline_event(
    db,
    row: Dict[str, Any],
) -> Dict[str, Any]:
    """Publish ONE booking_timeline row to every eligible subscriber
    across all four scopes. Projection happens here, per actor.

    Returns:
        {
          "customer":  [envelopes...],
          "provider":  [envelopes...],
          "inspector": [envelopes...],
          "admin":     [envelopes...],
        }
        Only populated when at least one subscriber matched; empty
        list otherwise. The envelopes are the EXACT frames sent to
        each subscriber, useful for snapshot-equivalence tests.
    """
    summary: Dict[str, List[Dict[str, Any]]] = {
        "customer": [],
        "provider": [],
        "inspector": [],
        "admin": [],
    }
    booking_id = row.get("bookingId")
    if not booking_id:
        return summary

    # ── Resolve owners (best-effort; admin still fanouts even without)
    owners = await _resolve_booking_owners(db, str(booking_id)) or {
        "customerIds": [], "providerIds": [],
    }

    # ── Admin channel — RAW row, no projection. Pure forensic surface.
    # We deliberately strip mongo-private fields for JSON safety only;
    # NO semantic filtering at all.
    admin_row = {k: v for k, v in row.items() if k != "_id"}
    admin_envelope = {
        "type": "timeline.updated",
        "scope": "admin",
        "bookingId": str(booking_id),
        "event": admin_row,
    }
    for ws, ctx in await HUB_ADMIN.snapshot():
        if ctx.get("bookingId") and ctx["bookingId"] != str(booking_id):
            continue
        ok = await _safe_send(ws, admin_envelope)
        if ok:
            summary["admin"].append(admin_envelope)

    # ── Customer channel — projected via customer.py per subscriber.
    for ws, ctx in await HUB_CUSTOMER.snapshot():
        if ctx.get("bookingId") != str(booking_id):
            continue
        viewer_id = str(ctx.get("viewerId") or "")
        if not viewer_id:
            continue
        # Ownership: subscriber must be the booking's customer (or the
        # booking must have no recorded customer — legacy permissive,
        # same as customer router's _load_customer_booking).
        if owners["customerIds"] and viewer_id not in owners["customerIds"]:
            continue
        projected = _project_one_customer(row, viewer_id)
        if projected is None:
            # Row filtered out by customer whitelist — emit nothing.
            continue
        envelope = {
            "type": "timeline.updated",
            "scope": "customer",
            "bookingId": str(booking_id),
            "event": projected,
        }
        ok = await _safe_send(ws, envelope)
        if ok:
            summary["customer"].append(envelope)

    # ── Provider channel — projected via provider.py per subscriber.
    for ws, ctx in await HUB_PROVIDER.snapshot():
        if ctx.get("bookingId") != str(booking_id):
            continue
        viewer_ids = list(ctx.get("viewerIds") or [])
        if not viewer_ids:
            continue
        # Ownership: at least one of the subscriber's ids must match
        # the booking's provider-side ids. Foreign subscribers get
        # nothing (opacity).
        if not set(viewer_ids).intersection(owners["providerIds"]):
            continue
        projected = _project_one_provider(row, viewer_ids)
        if projected is None:
            continue
        envelope = {
            "type": "timeline.updated",
            "scope": "provider",
            "bookingId": str(booking_id),
            "event": projected,
        }
        ok = await _safe_send(ws, envelope)
        if ok:
            summary["provider"].append(envelope)

    # ── Inspector channel — keyed by jobId; subscriber ctx stores
    # the requestId already resolved at subscribe time, so we can
    # match without re-querying inspection_jobs on every emit.
    for ws, ctx in await HUB_INSPECTOR.snapshot():
        if ctx.get("requestId") != str(booking_id):
            continue
        viewer_ids = list(ctx.get("viewerIds") or [])
        if not viewer_ids:
            continue
        projected = _project_one_inspector(row, viewer_ids)
        if projected is None:
            continue
        envelope = {
            "type": "timeline.updated",
            "scope": "inspector",
            "jobId": str(ctx.get("jobId") or ""),
            "event": projected,
        }
        ok = await _safe_send(ws, envelope)
        if ok:
            summary["inspector"].append(envelope)

    return summary


# ─────────────────────────────────────────────────────────────────────
# WebSocket handlers — one per scope. Auth via `?token=` (same dual-
# transport convention as chat). Heartbeat: 25s server ping, any
# client frame counts as a pong-back.
# ─────────────────────────────────────────────────────────────────────


async def _ws_session(
    ws: WebSocket, hub: _ScopedHub, ctx: Dict[str, Any], hello_payload: Dict[str, Any]
) -> None:
    """Generic accept-register-keepalive loop shared by all 4 endpoints."""
    await ws.accept()
    await hub.add(ws, ctx)
    try:
        await _safe_send(ws, {"type": "hello", "payload": hello_payload})
        while True:
            try:
                _ = await asyncio.wait_for(ws.receive_text(), timeout=25.0)
                ok = await _safe_send(ws, {"type": "pong"})
                if not ok:
                    break
            except asyncio.TimeoutError:
                ok = await _safe_send(ws, {"type": "ping"})
                if not ok:
                    break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.debug(f"booking ws session ended: {exc}")
    finally:
        await hub.remove(ws)


async def _authenticate(ws: WebSocket, token: Optional[str]) -> Optional[Dict[str, Any]]:
    """Returns decoded JWT payload or None (and closes ws with 4401)."""
    if not token:
        await ws.close(code=4401)
        return None
    try:
        import jwt as _jwt
        from app.core.config import JWT_SECRET, JWT_ALGO
        return _jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except Exception:
        await ws.close(code=4401)
        return None


async def customer_ws_handler(
    ws: WebSocket, booking_id: str, token: Optional[str]
) -> None:
    """`/api/customer/bookings/{booking_id}/timeline/stream`."""
    payload = await _authenticate(ws, token)
    if not payload:
        return
    viewer_id = payload.get("sub") or payload.get("userId") or ""
    ctx = {"bookingId": booking_id, "viewerId": str(viewer_id)}
    await _ws_session(ws, HUB_CUSTOMER, ctx, {"scope": "customer", "bookingId": booking_id})


async def provider_ws_handler(
    ws: WebSocket, booking_id: str, token: Optional[str]
) -> None:
    """`/api/provider/bookings/{booking_id}/timeline/stream`."""
    payload = await _authenticate(ws, token)
    if not payload:
        return
    viewer_ids = [
        str(payload[k]) for k in ("sub", "userId", "accountId", "providerId", "providerSlug")
        if payload.get(k)
    ]
    # dedupe preserving order
    seen: set[str] = set()
    viewer_ids = [x for x in viewer_ids if not (x in seen or seen.add(x))]
    ctx = {"bookingId": booking_id, "viewerIds": viewer_ids}
    await _ws_session(ws, HUB_PROVIDER, ctx, {"scope": "provider", "bookingId": booking_id})


async def inspector_ws_handler(
    ws: WebSocket, job_id: str, token: Optional[str], db
) -> None:
    """`/api/inspector/jobs/{job_id}/timeline/stream`.

    Resolves jobId → requestId at subscribe time so emit-time
    matching is a cheap dict lookup, not a Mongo round-trip.
    """
    payload = await _authenticate(ws, token)
    if not payload:
        return
    viewer_ids = [
        str(payload[k]) for k in (
            "sub", "userId", "accountId", "inspectorId", "inspectorAccountId",
        ) if payload.get(k)
    ]
    seen: set[str] = set()
    viewer_ids = [x for x in viewer_ids if not (x in seen or seen.add(x))]

    # Resolve job → request_id and verify ownership BEFORE accepting.
    job = await db.inspection_jobs.find_one({"_id": job_id})
    if not job:
        job = await db.inspection_jobs.find_one({"id": job_id})
    if not job:
        await ws.close(code=4404)
        return
    job_inspector_ids = [
        str(job[k]) for k in ("inspectorId", "inspectorAccountId", "inspectorUserId")
        if job.get(k)
    ]
    if not set(viewer_ids).intersection(job_inspector_ids):
        # Same 404-opacity as the REST router (close code differs but
        # the semantics are identical — silent reject).
        await ws.close(code=4404)
        return
    request_id = job.get("requestId")
    if not request_id:
        await ws.close(code=4404)
        return

    ctx = {
        "jobId": job_id,
        "requestId": str(request_id),
        "viewerIds": viewer_ids,
    }
    await _ws_session(ws, HUB_INSPECTOR, ctx, {"scope": "inspector", "jobId": job_id})


async def admin_ws_handler(
    ws: WebSocket, booking_id: str, token: Optional[str]
) -> None:
    """`/api/admin/booking-lifecycle/{booking_id}/stream`.

    Admin gets the raw forensic row. Admin role check uses the JWT
    `role` claim. Non-admin tokens are closed with 4403.
    """
    payload = await _authenticate(ws, token)
    if not payload:
        return
    role = payload.get("role") or payload.get("kind") or ""
    if role != "admin":
        await ws.close(code=4403)
        return
    ctx = {"bookingId": booking_id}
    await _ws_session(ws, HUB_ADMIN, ctx, {"scope": "admin", "bookingId": booking_id})


__all__ = [
    "HUB_CUSTOMER",
    "HUB_PROVIDER",
    "HUB_INSPECTOR",
    "HUB_ADMIN",
    "publish_timeline_event",
    "customer_ws_handler",
    "provider_ws_handler",
    "inspector_ws_handler",
    "admin_ws_handler",
]

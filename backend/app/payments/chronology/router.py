"""Sprint P0.b.C.f — F.4 + F.5: REST + WS for payment chronology.

Three actor-scoped REST endpoints + three WS streams. Mirrors the P0.b.C.a..d
WS handshake/keepalive/role-gate pattern, but uses its OWN envelope semantics
and dedup contract (per F.1 invariants).

NOT reused from booking-timeline:
  - reducer / dedup logic
  - envelope semantics
  - projection taxonomy

Reused primitives ONLY:
  - JWT bearer parser (Authorization header / token query param)
  - 4403 close on role mismatch (NO retry — terminal client state)
  - ping/pong keepalive
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
import jwt

from app.core.config import JWT_SECRET, JWT_ALGO
from app.core.db import get_db
from app.payments.chronology import projector as P
from app.payments.chronology.realtime import (
    HUB_ADMIN,
    HUB_CUSTOMER,
    HUB_PROVIDER,
    session_loop,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ── auth helpers (do not import booking-timeline auth — keep payment isolated)

# Role-string normalisation. The auth pipeline stores `provider_owner` /
# `provider_admin` for users who logically act as "provider". Keep this map
# tight — anything else is rejected.
ROLE_ALIASES = {
    "customer": frozenset({"customer"}),
    "provider": frozenset({"provider", "provider_owner", "provider_admin"}),
    "admin": frozenset({"admin"}),
}


def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except Exception as e:
        raise HTTPException(status_code=401, detail={
            "error": True, "code": "INVALID_TOKEN", "message": str(e)
        })


async def _require_role(request_headers, expected_role: str) -> dict:
    auth = request_headers.get("authorization") or request_headers.get("Authorization")
    if not auth or not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail={
            "error": True, "code": "UNAUTHORIZED", "message": "Bearer token required"
        })
    payload = _decode_token(auth.split(" ", 1)[1].strip())
    role = (payload.get("role") or payload.get("kind") or "").lower()
    allowed = ROLE_ALIASES.get(expected_role, frozenset({expected_role}))
    if role not in allowed:
        raise HTTPException(status_code=403, detail={
            "error": True, "code": "FORBIDDEN", "message": f"requires role={expected_role}"
        })
    return payload


# ── shared fetcher (independent of booking-timeline DB layer)

async def _fetch_rows(db, payment_id: str) -> list[dict]:
    cursor = db.payment_events.find({"paymentId": payment_id}).sort("at", 1)
    return [doc async for doc in cursor]


# ──────────────────────────────────────────────────────────────────────────
# REST endpoints (F.4)
# ──────────────────────────────────────────────────────────────────────────

from fastapi import Request


@router.get("/api/customer/payments/{payment_id}/chronology", name="customer_payment_chronology")
async def get_customer_chronology(payment_id: str, request: Request):
    await _require_role(request.headers, "customer")
    db = get_db()
    rows = await _fetch_rows(db, payment_id)
    if not rows:
        # opacity: return empty list, not 404 — paymentId existence is
        # the customer's own knowledge, not a probe-able fact
        return JSONResponse({"surface": "payment-activity.customer",
                             "paymentId": payment_id, "rows": []})
    return JSONResponse({
        "surface": "payment-activity.customer",
        "paymentId": payment_id,
        "rows": P.project_customer(rows),
    })


@router.get("/api/provider/payouts/{payment_id}/chronology", name="provider_payout_chronology")
async def get_provider_chronology(payment_id: str, request: Request):
    await _require_role(request.headers, "provider")
    db = get_db()
    rows = await _fetch_rows(db, payment_id)
    return JSONResponse({
        "surface": "payout-activity.provider",
        "paymentId": payment_id,
        "rows": P.project_provider(rows),
    })


@router.get("/api/admin/payments/{payment_id}/chronology", name="admin_payment_chronology")
async def get_admin_chronology(payment_id: str, request: Request):
    await _require_role(request.headers, "admin")
    db = get_db()
    rows = await _fetch_rows(db, payment_id)
    return JSONResponse({
        "surface": "payment-forensic.admin",
        "paymentId": payment_id,
        "rows": P.project_admin(rows),
    })


# ──────────────────────────────────────────────────────────────────────────
# WS streams (F.5)
# ──────────────────────────────────────────────────────────────────────────


async def _ws_handshake(ws: WebSocket, expected_role: str) -> Optional[dict]:
    """Accept connection only if token resolves to expected_role.
    Mirrors booking-timeline pattern: 4403 close on role mismatch (NO retry)."""
    token = ws.query_params.get("token", "")
    if not token:
        await ws.close(code=4401)
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except Exception:
        await ws.close(code=4401)
        return None
    role = (payload.get("role") or payload.get("kind") or "").lower()
    allowed = ROLE_ALIASES.get(expected_role, frozenset({expected_role}))
    if role not in allowed:
        await ws.close(code=4403)  # terminal — client MUST NOT retry
        return None
    await ws.accept()
    return payload


def _extract_viewer_ids(payload: dict) -> list[str]:
    """Collect candidate viewer ids from a decoded JWT, deduplicated and
    order-preserving. Mirrors the booking-timeline provider handler so a
    user logged in as `provider_owner` matches a service_payments doc
    that stores `providerAccountId`, etc."""
    seen: set[str] = set()
    out: list[str] = []
    for k in ("sub", "userId", "accountId", "providerId", "providerSlug",
              "providerAccountId", "customerAccountId", "customerUserId"):
        v = payload.get(k)
        if not v:
            continue
        s = str(v)
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


@router.websocket("/api/customer/payments/{payment_id}/chronology/stream")
async def customer_chronology_stream(ws: WebSocket, payment_id: str):
    """Sprint P0.b.C.h — subscribes to customer payment chronology hub.

    Wire frames emitted to client:
      - {op:"hello", surface, paymentId}   on accept
      - {op:"ping"} / {op:"pong"}           idle keepalive (25s)
      - {type:"payment.chronology.updated", scope:"customer", paymentId,
         event: <projected row, byte-equal to REST rows[i]>}
    """
    payload = await _ws_handshake(ws, "customer")
    if not payload:
        return
    viewer_id = str(payload.get("sub") or payload.get("userId") or "")
    ctx = {"paymentId": payment_id, "viewerId": viewer_id}
    await session_loop(
        ws, HUB_CUSTOMER, ctx,
        surface="payment-activity.customer",
        payment_id=payment_id,
    )


@router.websocket("/api/provider/payouts/{payment_id}/chronology/stream")
async def provider_chronology_stream(ws: WebSocket, payment_id: str):
    """Sprint P0.b.C.h — subscribes to provider payment chronology hub.

    Wire frames emitted to client:
      - {op:"hello", surface, paymentId}   on accept
      - {op:"ping"} / {op:"pong"}           idle keepalive (25s)
      - {type:"payment.chronology.updated", scope:"provider", paymentId,
         event: <projected row, byte-equal to REST rows[i]>}
    """
    payload = await _ws_handshake(ws, "provider")
    if not payload:
        return
    viewer_ids = _extract_viewer_ids(payload)
    ctx = {"paymentId": payment_id, "viewerIds": viewer_ids}
    await session_loop(
        ws, HUB_PROVIDER, ctx,
        surface="payout-activity.provider",
        payment_id=payment_id,
    )


@router.websocket("/api/admin/payments/{payment_id}/chronology/stream")
async def admin_chronology_stream(ws: WebSocket, payment_id: str):
    """Sprint P0.b.C.h — subscribes to admin payment chronology hub.

    Wire frames emitted to client:
      - {op:"hello", surface, paymentId}   on accept
      - {op:"ping"} / {op:"pong"}           idle keepalive (25s)
      - {type:"payment.chronology.updated", scope:"admin", paymentId,
         event: <raw forensic row, byte-equal to REST rows[i]>}
    """
    payload = await _ws_handshake(ws, "admin")
    if not payload:
        return
    ctx = {"paymentId": payment_id}
    await session_loop(
        ws, HUB_ADMIN, ctx,
        surface="payment-forensic.admin",
        payment_id=payment_id,
    )

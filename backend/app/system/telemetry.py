"""app.system.telemetry — minimal event collector (Sprint QR-1).

POST /api/system/track  → body { type: str, payload?: dict, userId?: str }

Cheap on-write, anonymous OK. Bounded: payload max 8KB, type max 64 chars.
Mongo collection: events { type, userId?, ts, payload, ip, ua }

No retention here — admin can run TTL via Mongo (created index OUT of scope for MVP).
"""
from __future__ import annotations
import json

from fastapi import APIRouter, Request, HTTPException

from app.core.db import get_db
from app.core.utils import now_utc, uid


router = APIRouter()


_MAX_TYPE_LEN = 64
_MAX_PAYLOAD_BYTES = 8192


@router.post("/api/system/track")
async def system_track(request: Request):
    """Fire-and-forget telemetry sink. No auth (anonymous events OK)."""
    db = get_db()
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "invalid json")

    event_type = str(body.get("type") or "").strip()[:_MAX_TYPE_LEN]
    if not event_type:
        raise HTTPException(400, "type required")

    payload = body.get("payload") or {}
    if not isinstance(payload, dict):
        payload = {"value": payload}

    # bound payload size to protect Mongo
    try:
        if len(json.dumps(payload, default=str)) > _MAX_PAYLOAD_BYTES:
            payload = {"_truncated": True}
    except Exception:
        payload = {"_truncated": True}

    user_id = body.get("userId")  # optional, not authenticated
    request_id = body.get("requestId") or payload.get("requestId")

    doc = {
        "id":        uid(),
        "type":      event_type,
        "userId":    str(user_id) if user_id else None,
        "requestId": str(request_id) if request_id else None,
        "payload":   payload,
        "ip":        (request.headers.get("x-forwarded-for", request.client.host if request.client else "")).split(",")[0].strip()[:64],
        "ua":        request.headers.get("user-agent", "")[:200],
        "ts":        now_utc().isoformat(),
    }
    await db.events.insert_one(dict(doc))
    return {"ok": True, "id": doc["id"]}


# ─────────────────────────────────────────────────────────────────────
# Conversion read-out: vehicle attention → market intent
# ─────────────────────────────────────────────────────────────────────
# The single product question Bβ.contextual was built to answer:
#
#   "Does opening /vehicle/:id turn into a saved market subscription?"
#
# Three counts, three rates. Nothing else. Read by humans, not dashboards.
#
#   GET /api/system/conversion/vehicle-to-search
#     → { views, opens, submits, openRate, submitRate, submitFromOpen }
#
# Filters (all optional query params):
#   - sinceIso     ISO-8601 cutoff; events with ts < this are excluded.
#   - vehicleId    only events for this vehicle (drill-down).
#
# Cheap: three count_documents calls.

@router.get("/api/system/conversion/vehicle-to-search")
async def conversion_vehicle_to_search(sinceIso: str = "", vehicleId: str = ""):
    db = get_db()

    base: dict = {}
    if sinceIso:
        base["ts"] = {"$gte": sinceIso}
    if vehicleId:
        base["payload.vehicleId"] = vehicleId

    async def _count(event_type: str) -> int:
        return await db.events.count_documents({**base, "type": event_type})

    views = await _count("vehicle_view")
    opens = await _count("vehicle_to_search_open")
    submits = await _count("vehicle_to_search_submit")

    def _pct(num: int, den: int) -> float:
        return round(num / den * 100, 2) if den > 0 else 0.0

    return {
        "views":           views,
        "opens":           opens,
        "submits":         submits,
        "openRate":        _pct(opens, views),       # % of viewers who opened the modal
        "submitRate":      _pct(submits, views),     # % of viewers who actually subscribed
        "submitFromOpen":  _pct(submits, opens),     # form completion rate
        "filter": {
            "sinceIso":  sinceIso or None,
            "vehicleId": vehicleId or None,
        },
    }

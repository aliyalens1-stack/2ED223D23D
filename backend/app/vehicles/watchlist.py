"""app.vehicles.watchlist — Subscriptions, alerts, notification feed.

The natural endpoint of a temporal system. Once vehicles are *living
objects*, the way users return to the platform isn't "remember to come
back" — it's "your vehicle just changed".

Architecture:

    POST /api/vehicles/:id/watch          ← subscribe (anonymous OK)
    DELETE /api/vehicles/:id/watch
    GET  /api/watchlist/:watcherId        ← list with latest event each
    GET  /api/watchlist/:watcherId/feed   ← unified notification stream
    POST /api/watchlist/:watcherId/seen   ← mark feed as read

Identity:
  - `watcherId` is opaque (UUID generated client-side on first watch
    and stored in localStorage). No auth required for the demo phase.
  - Later this maps cleanly to user.id when the user signs in.

Fanout:
  - `fanout_event(vehicleId, event)` is called from
    refresh.refresh_vehicle and refresh.simulate_change after the
    event has been appended to the vehicle's activity log.
  - For each matching watch (kind allow-list or "all"), one
    notification doc is inserted in `db.notifications`.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.db import db


logger = logging.getLogger("vehicles.watchlist")

router = APIRouter(tags=["vehicles-watchlist"])


# ─────────────────────────────────────────────────────────────────────
# Indexes
# ─────────────────────────────────────────────────────────────────────

async def ensure_watchlist_indexes() -> None:
    try:
        await db.vehicle_watches.create_index([("watcherId", 1), ("vehicleId", 1)], unique=True, background=True)
        await db.vehicle_watches.create_index([("vehicleId", 1)], background=True)
        await db.notifications.create_index([("watcherId", 1), ("createdAt", -1)], background=True)
        await db.notifications.create_index([("vehicleId", 1)], background=True)
    except Exception as e:
        logger.warning(f"watchlist indexes ensure failed (non-fatal): {e}")


# ─────────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────────

# Default kinds users care about. Empty list = wildcard (all kinds).
DEFAULT_KINDS = [
    "price_drop", "price_increase", "mileage_update",
    "listing_disappeared", "relisted",
    "inspection", "inspection_completed",
]


class WatchRequest(BaseModel):
    watcherId: str = Field(..., min_length=8, max_length=64)
    kinds: list[str] = Field(default_factory=list)
    email: Optional[str] = Field(default=None, max_length=255)


class SeenRequest(BaseModel):
    upToIso: Optional[str] = None  # mark all <= this iso as read


# ─────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────

@router.post("/api/vehicles/{vehicle_id}/watch")
async def watch_vehicle(vehicle_id: str, payload: WatchRequest):
    """Subscribe a watcherId to a vehicle. Idempotent."""
    veh = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0, "id": 1, "brand": 1, "model": 1, "thumbnail": 1})
    if not veh:
        raise HTTPException(status_code=404, detail="vehicle_not_found")

    now = datetime.now(timezone.utc)
    kinds = [k.strip().lower() for k in payload.kinds if k.strip()] or list(DEFAULT_KINDS)

    await db.vehicle_watches.update_one(
        {"watcherId": payload.watcherId, "vehicleId": vehicle_id},
        {
            "$set": {
                "watcherId": payload.watcherId,
                "vehicleId": vehicle_id,
                "kinds": kinds,
                "email": payload.email,
                "updatedAt": now,
                "vehicleSnapshot": {
                    "brand": veh.get("brand"),
                    "model": veh.get("model"),
                    "thumbnail": veh.get("thumbnail"),
                },
            },
            "$setOnInsert": {"createdAt": now},
        },
        upsert=True,
    )
    return {"ok": True, "watcherId": payload.watcherId, "vehicleId": vehicle_id, "kinds": kinds}


@router.delete("/api/vehicles/{vehicle_id}/watch")
async def unwatch_vehicle(vehicle_id: str, watcherId: str):
    res = await db.vehicle_watches.delete_one({"watcherId": watcherId, "vehicleId": vehicle_id})
    return {"ok": True, "deleted": res.deleted_count}


@router.get("/api/vehicles/{vehicle_id}/watch")
async def watch_status(vehicle_id: str, watcherId: str):
    """Is this watcher subscribed? Plus per-vehicle subscriber count."""
    doc = await db.vehicle_watches.find_one(
        {"watcherId": watcherId, "vehicleId": vehicle_id},
        {"_id": 0, "kinds": 1, "createdAt": 1},
    )
    total = await db.vehicle_watches.count_documents({"vehicleId": vehicle_id})
    return {
        "watching": bool(doc),
        "kinds": (doc or {}).get("kinds", []),
        "since": (doc or {}).get("createdAt").isoformat() if (doc and doc.get("createdAt")) else None,
        "totalWatchers": total,
    }


@router.get("/api/watchlist/{watcher_id}")
async def list_watchlist(watcher_id: str, limit: int = 50):
    """All watches for a watcher with each vehicle's most-recent event."""
    cur = db.vehicle_watches.find({"watcherId": watcher_id}, {"_id": 0}).sort("createdAt", -1).limit(limit)
    watches = await cur.to_list(limit)

    items = []
    for w in watches:
        vid = w["vehicleId"]
        # Latest event from notifications (cheaper than scanning vehicle.activity).
        latest = await db.notifications.find_one(
            {"watcherId": watcher_id, "vehicleId": vid},
            {"_id": 0},
            sort=[("createdAt", -1)],
        )
        unread = await db.notifications.count_documents({
            "watcherId": watcher_id, "vehicleId": vid, "readAt": None,
        })
        items.append({
            "vehicleId": vid,
            "vehicle": w.get("vehicleSnapshot"),
            "kinds": w.get("kinds", []),
            "since": w.get("createdAt").isoformat() if w.get("createdAt") else None,
            "unread": unread,
            "latestEvent": _serialize_notification(latest) if latest else None,
        })
    return {"watcherId": watcher_id, "items": items, "count": len(items)}


@router.get("/api/watchlist/{watcher_id}/feed")
async def watchlist_feed(watcher_id: str, limit: int = 100):
    """Unified notification stream — newest first."""
    cur = db.notifications.find({"watcherId": watcher_id}, {"_id": 0}).sort("createdAt", -1).limit(limit)
    docs = await cur.to_list(limit)
    unread_total = await db.notifications.count_documents({"watcherId": watcher_id, "readAt": None})
    return {
        "items": [_serialize_notification(d) for d in docs],
        "count": len(docs),
        "unread": unread_total,
    }


@router.post("/api/watchlist/{watcher_id}/seen")
async def mark_seen(watcher_id: str, payload: SeenRequest):
    now = datetime.now(timezone.utc)
    flt: dict = {"watcherId": watcher_id, "readAt": None}
    if payload.upToIso:
        try:
            cutoff = datetime.fromisoformat(payload.upToIso.replace("Z", "+00:00"))
            flt["createdAt"] = {"$lte": cutoff}
        except Exception:
            pass
    res = await db.notifications.update_many(flt, {"$set": {"readAt": now}})
    return {"ok": True, "marked": res.modified_count}


def _serialize_notification(doc: Optional[dict]) -> Optional[dict]:
    if not doc:
        return None
    return {
        "id": doc.get("id"),
        "vehicleId": doc.get("vehicleId"),
        "vehicleSnapshot": doc.get("vehicleSnapshot"),
        "kind": doc.get("kind"),
        "title": doc.get("title"),
        "body": doc.get("body"),
        "severity": doc.get("severity"),
        "savingsEur": doc.get("savingsEur"),
        "mileage": doc.get("mileage"),
        "createdAt": doc.get("createdAt").isoformat() if hasattr(doc.get("createdAt"), "isoformat") else doc.get("createdAt"),
        "readAt": doc.get("readAt").isoformat() if hasattr(doc.get("readAt"), "isoformat") else doc.get("readAt"),
    }


# ─────────────────────────────────────────────────────────────────────
# Fanout — called from refresh.refresh_vehicle / simulate_change
# ─────────────────────────────────────────────────────────────────────

async def fanout_event(vehicle_id: str, event: dict) -> int:
    """Fan a single timeline event out to all relevant watchers.

    Returns the number of notifications inserted.
    """
    kind = event.get("type") or event.get("kind") or ""
    if not kind:
        return 0

    veh_snap = await db.vehicles.find_one(
        {"id": vehicle_id},
        {"_id": 0, "brand": 1, "model": 1, "thumbnail": 1},
    )

    cur = db.vehicle_watches.find(
        {
            "vehicleId": vehicle_id,
            # match either subscribers to this kind, or wildcard subscribers ([] = all)
            "$or": [{"kinds": kind}, {"kinds": {"$size": 0}}],
        },
        {"_id": 0, "watcherId": 1},
    )
    watchers = await cur.to_list(None)
    if not watchers:
        return 0

    now = datetime.now(timezone.utc)
    at = event.get("at")
    if not isinstance(at, datetime):
        at = now

    docs = []
    for w in watchers:
        wid = w["watcherId"]
        docs.append({
            "id": f"notif_{vehicle_id}_{kind}_{int(at.timestamp())}_{wid[:8]}",
            "watcherId": wid,
            "vehicleId": vehicle_id,
            "vehicleSnapshot": veh_snap,
            "kind": kind,
            "title": event.get("title") or kind,
            "body": event.get("text") or event.get("body"),
            "severity": event.get("severity") or "info",
            "savingsEur": event.get("savingsEur"),
            "mileage": event.get("mileage"),
            "createdAt": now,
            "eventAt": at,
            "readAt": None,
        })
    if docs:
        try:
            await db.notifications.insert_many(docs, ordered=False)
        except Exception as e:
            logger.warning(f"notifications fanout partial failure: {e}")
    return len(docs)


# ─────────────────────────────────────────────────────────────────────
# Demo seed
# ─────────────────────────────────────────────────────────────────────

DEMO_WATCHER_ID = "watcher_demo_buyer_8f2c3"


async def seed_demo_watch() -> None:
    """Pre-seed one watcher subscribed to the demo BMW with 3 notifications.

    Idempotent. Lets /feed render with content immediately on a fresh DB.
    """
    from app.vehicles.public_memory import DEMO_VEHICLE_ID

    veh = await db.vehicles.find_one(
        {"id": DEMO_VEHICLE_ID},
        {"_id": 0, "brand": 1, "model": 1, "thumbnail": 1},
    )
    if not veh:
        return

    now = datetime.now(timezone.utc)
    await db.vehicle_watches.update_one(
        {"watcherId": DEMO_WATCHER_ID, "vehicleId": DEMO_VEHICLE_ID},
        {
            "$set": {
                "watcherId": DEMO_WATCHER_ID,
                "vehicleId": DEMO_VEHICLE_ID,
                "kinds": list(DEFAULT_KINDS),
                "vehicleSnapshot": veh,
                "updatedAt": now,
            },
            "$setOnInsert": {"createdAt": now},
        },
        upsert=True,
    )

    # Pre-fill 3 demo notifications mirroring the seeded temporal events.
    samples = [
        {
            "id": f"notif_seed_pdrop_demo",
            "kind": "price_drop",
            "title": "Аналогичная BMW подешевела на €700",
            "body": "Сравнимый F31 320d у того же дилера: €18 400 → €17 700",
            "severity": "success",
            "savingsEur": 700,
            "ago_days": 11,
        },
        {
            "id": f"notif_seed_mileage_demo",
            "kind": "mileage_update",
            "title": "Пробег обновили: +1 500 км",
            "body": "Было 122 900 → стало 124 400 за последний месяц",
            "severity": "info",
            "mileage": 124_400,
            "ago_days": 4,
        },
        {
            "id": f"notif_seed_inspection_demo",
            "kind": "inspection",
            "title": "PASS · второй осмотр",
            "body": "Через 2.5 года эксплуатации — состояние выше среднего.",
            "severity": "success",
            "ago_days": 24,
        },
    ]
    from datetime import timedelta as _td
    for s in samples:
        ago = s.pop("ago_days")
        await db.notifications.update_one(
            {"id": s["id"]},
            {
                "$set": {
                    **s,
                    "watcherId": DEMO_WATCHER_ID,
                    "vehicleId": DEMO_VEHICLE_ID,
                    "vehicleSnapshot": veh,
                    "createdAt": now - _td(days=ago),
                    "eventAt": now - _td(days=ago),
                    "readAt": None,
                },
            },
            upsert=True,
        )

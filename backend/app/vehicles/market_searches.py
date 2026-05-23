"""app.vehicles.market_searches — Saved searches as persistent market intent.

This is NOT a filters UI. It is a *market subscription primitive*.

The contract:

    user describes desire    →    POST /api/searches
                                   ↓
                             db.market_searches
                                   ↓
                          waiting for matches
                                   ↓
                       new vehicle ingested
                                   ↓
                    _match_filter(search, vehicle)
                                   ↓
                  notification: "match_found"
                                   ↓
                       feed → user returns

Multiplier: one ingest → N matches → N notifications → N visits.

Match filter dimensions (all optional, AND-combined):
  - brand          exact case-insensitive
  - model          substring case-insensitive
  - yearMin/Max    inclusive
  - priceMax       inclusive
  - mileageMax     inclusive
  - city           substring case-insensitive on vehicle.location
  - fuel           exact case-insensitive

Why a separate collection (not a polymorphic vehicle_watches):
  - vehicle_watches.vehicleId is a single-object subscription.
  - market_searches.filter is a *segment* subscription.
  These have different query patterns, different fan-out logic,
  and will evolve independently (rarity scoring, demand zones, etc).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.db import db


logger = logging.getLogger("vehicles.market_searches")

router = APIRouter(tags=["market-searches"])


# ─────────────────────────────────────────────────────────────────────
# Indexes
# ─────────────────────────────────────────────────────────────────────

async def ensure_market_search_indexes() -> None:
    try:
        await db.market_searches.create_index([("watcherId", 1), ("createdAt", -1)], background=True)
        await db.market_searches.create_index([("filter.brand", 1)], background=True, sparse=True)
    except Exception as e:
        logger.warning(f"market_searches indexes ensure failed (non-fatal): {e}")


# ─────────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────────

class MarketFilter(BaseModel):
    brand: Optional[str] = Field(default=None, max_length=64)
    model: Optional[str] = Field(default=None, max_length=64)
    yearMin: Optional[int] = Field(default=None, ge=1900, le=2100)
    yearMax: Optional[int] = Field(default=None, ge=1900, le=2100)
    priceMax: Optional[int] = Field(default=None, ge=0)
    mileageMax: Optional[int] = Field(default=None, ge=0)
    city: Optional[str] = Field(default=None, max_length=64)
    fuel: Optional[str] = Field(default=None, max_length=32)


class SaveSearchRequest(BaseModel):
    watcherId: str = Field(..., min_length=8, max_length=64)
    filter: MarketFilter
    label: Optional[str] = Field(default=None, max_length=120)


# ─────────────────────────────────────────────────────────────────────
# Match predicate (the heart of the multiplier)
# ─────────────────────────────────────────────────────────────────────

def _match(filter_: dict, vehicle: dict) -> bool:
    """Return True iff vehicle satisfies the (non-empty fields of) filter.

    Empty-field rule: missing filter dimensions are treated as wildcards.
    Missing vehicle dimensions when the filter requires them → no match.
    """
    if not filter_:
        return False  # empty subscription matches nothing — safety net.

    f_brand = (filter_.get("brand") or "").strip().lower()
    f_model = (filter_.get("model") or "").strip().lower()
    f_city = (filter_.get("city") or "").strip().lower()
    f_fuel = (filter_.get("fuel") or "").strip().lower()
    f_year_min = filter_.get("yearMin")
    f_year_max = filter_.get("yearMax")
    f_price_max = filter_.get("priceMax")
    f_mileage_max = filter_.get("mileageMax")

    v_brand = (vehicle.get("brand") or "").strip().lower()
    v_model = (vehicle.get("model") or "").strip().lower()
    v_city = (vehicle.get("location") or "").strip().lower()
    v_fuel = (vehicle.get("fuel") or "").strip().lower()
    v_year = vehicle.get("year")
    v_price = vehicle.get("price")
    v_mileage = vehicle.get("mileage")

    if f_brand and v_brand != f_brand:
        return False
    if f_model and f_model not in v_model:
        return False
    if f_city and f_city not in v_city:
        return False
    if f_fuel and f_fuel != v_fuel:
        return False
    if f_year_min is not None:
        if v_year is None or v_year < f_year_min:
            return False
    if f_year_max is not None:
        if v_year is None or v_year > f_year_max:
            return False
    if f_price_max is not None and v_price is not None and v_price > f_price_max:
        return False
    if f_mileage_max is not None and v_mileage is not None and v_mileage > f_mileage_max:
        return False
    return True


def _humanize_filter(f: dict) -> str:
    """Compact human label: 'BMW · 320d · 2018–2020 · до €18 000 · Berlin'."""
    parts: list[str] = []
    if f.get("brand"): parts.append(str(f["brand"]))
    if f.get("model"): parts.append(str(f["model"]))
    if f.get("yearMin") and f.get("yearMax"): parts.append(f"{f['yearMin']}–{f['yearMax']}")
    elif f.get("yearMin"): parts.append(f"от {f['yearMin']}")
    elif f.get("yearMax"): parts.append(f"до {f['yearMax']}")
    if f.get("priceMax"): parts.append(f"до €{f['priceMax']:,}".replace(",", " "))
    if f.get("mileageMax"): parts.append(f"до {f['mileageMax']:,} км".replace(",", " "))
    if f.get("city"): parts.append(str(f["city"]))
    if f.get("fuel"): parts.append(str(f["fuel"]))
    return " · ".join(parts) if parts else "любая машина"


# ─────────────────────────────────────────────────────────────────────
# Fanout: called from ingest.ingest_listing on new vehicle creation
# ─────────────────────────────────────────────────────────────────────

async def fanout_new_vehicle(vehicle: dict) -> int:
    """Find all saved searches that match this new vehicle, emit
    `match_found` notification per matching search.

    The multiplier: one ingest, N notifications.
    """
    if not vehicle:
        return 0

    # Pre-filter on Mongo where possible (brand) to avoid scanning all
    # searches. The rest of the predicate is evaluated in Python.
    brand = (vehicle.get("brand") or "").strip()
    pre_filter: dict[str, Any] = {}
    if brand:
        pre_filter["$or"] = [
            {"filter.brand": {"$regex": f"^{brand}$", "$options": "i"}},
            {"filter.brand": {"$in": [None, ""]}},
            {"filter.brand": {"$exists": False}},
        ]

    cur = db.market_searches.find(pre_filter, {"_id": 0})
    inserted = 0
    now = datetime.now(timezone.utc)

    async for s in cur:
        if not _match(s.get("filter") or {}, vehicle):
            continue

        notif = {
            "id": f"notif_match_{s['id']}_{vehicle['id']}",
            "watcherId": s["watcherId"],
            "vehicleId": vehicle["id"],
            "vehicleSnapshot": {
                "brand": vehicle.get("brand"),
                "model": vehicle.get("model"),
                "thumbnail": vehicle.get("thumbnail"),
            },
            "kind": "match_found",
            "title": _match_title(vehicle),
            "body": _match_body(vehicle, s.get("filter") or {}),
            "severity": "success",
            "savingsEur": None,
            "mileage": vehicle.get("mileage"),
            "createdAt": now,
            "eventAt": now,
            "readAt": None,
            "marketSearchId": s["id"],
            "marketSearchLabel": s.get("label") or _humanize_filter(s.get("filter") or {}),
        }
        try:
            await db.notifications.update_one(
                {"id": notif["id"]},
                {"$setOnInsert": notif},
                upsert=True,
            )
            inserted += 1
        except Exception as e:
            logger.warning(f"market match fanout {s['id']} → {vehicle['id']} failed: {e}")

        # Bump search stats.
        try:
            await db.market_searches.update_one(
                {"id": s["id"]},
                {
                    "$inc": {"matchCount": 1},
                    "$set": {"lastMatchAt": now, "lastMatchVehicleId": vehicle["id"]},
                },
            )
        except Exception:
            pass

    return inserted


def _match_title(v: dict) -> str:
    parts: list[str] = []
    if v.get("brand"): parts.append(str(v["brand"]))
    if v.get("model"): parts.append(str(v["model"]))
    if v.get("year"): parts.append(f"· {v['year']}")
    label = " ".join(parts) or "новая машина"
    return f"Рынок нашёл {label}"


def _match_body(v: dict, filter_: dict) -> str:
    extras: list[str] = []
    if v.get("price"):
        extras.append(f"€{v['price']:,}".replace(",", " "))
    if v.get("mileage"):
        extras.append(f"{v['mileage']:,} км".replace(",", " "))
    if v.get("location"):
        extras.append(str(v["location"]))
    extras_s = " · ".join(extras) if extras else "детали внутри"
    label = _humanize_filter(filter_)
    return f"Под подписку «{label}» · {extras_s}"


# ─────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────

@router.post("/api/searches")
async def save_search(payload: SaveSearchRequest):
    """Save a market subscription. Returns the saved doc + how many
    existing vehicles already match (immediate value preview)."""
    f = payload.filter.model_dump(exclude_none=True)
    if not f:
        raise HTTPException(status_code=400, detail="filter_empty")

    now = datetime.now(timezone.utc)
    sid = f"search_{payload.watcherId[:8]}_{int(now.timestamp())}"
    label = (payload.label or _humanize_filter(f))[:120]

    doc = {
        "id": sid,
        "watcherId": payload.watcherId,
        "filter": f,
        "label": label,
        "createdAt": now,
        "matchCount": 0,
        "lastMatchAt": None,
        "lastMatchVehicleId": None,
    }
    await db.market_searches.insert_one(dict(doc))

    # Preview: count existing vehicles that match.
    existing_matches = await _preview_existing_matches(f, limit=200)
    return {
        "ok": True,
        "search": _serialize_search(doc),
        "preview": {
            "existingCount": len(existing_matches),
            "samples": [
                {
                    "vehicleId": m.get("id"),
                    "brand": m.get("brand"),
                    "model": m.get("model"),
                    "year": m.get("year"),
                    "price": m.get("price"),
                    "thumbnail": m.get("thumbnail"),
                }
                for m in existing_matches[:6]
            ],
        },
    }


@router.get("/api/watchlist/{watcher_id}/searches")
async def list_searches(watcher_id: str):
    """All market subscriptions of a watcher with match counts."""
    cur = db.market_searches.find({"watcherId": watcher_id}, {"_id": 0}).sort("createdAt", -1)
    docs = await cur.to_list(200)
    return {
        "watcherId": watcher_id,
        "items": [_serialize_search(d) for d in docs],
        "count": len(docs),
    }


@router.delete("/api/searches/{search_id}")
async def delete_search(search_id: str, watcherId: str):
    res = await db.market_searches.delete_one({"id": search_id, "watcherId": watcherId})
    return {"ok": True, "deleted": res.deleted_count}


@router.post("/api/searches/preview")
async def preview_search(payload: SaveSearchRequest):
    """Live preview of how many vehicles would match — no save, no auth."""
    f = payload.filter.model_dump(exclude_none=True)
    matches = await _preview_existing_matches(f, limit=200)
    return {
        "label": payload.label or _humanize_filter(f),
        "count": len(matches),
        "samples": [
            {
                "vehicleId": m.get("id"),
                "brand": m.get("brand"),
                "model": m.get("model"),
                "year": m.get("year"),
                "price": m.get("price"),
                "thumbnail": m.get("thumbnail"),
            }
            for m in matches[:6]
        ],
    }


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

async def _preview_existing_matches(filter_: dict, limit: int = 200) -> list[dict]:
    """Scan up to `limit` candidate vehicles and apply _match in Python.
    Pre-filter brand at the Mongo level when set."""
    if not filter_:
        return []
    pre: dict = {}
    if filter_.get("brand"):
        pre["brand"] = {"$regex": f"^{filter_['brand']}$", "$options": "i"}
    cur = db.vehicles.find(pre, {
        "_id": 0, "id": 1, "brand": 1, "model": 1, "year": 1,
        "price": 1, "mileage": 1, "location": 1, "fuel": 1, "thumbnail": 1,
    }).limit(limit)
    docs = await cur.to_list(limit)
    return [d for d in docs if _match(filter_, d)]


def _serialize_search(s: dict) -> dict:
    return {
        "id": s.get("id"),
        "filter": s.get("filter"),
        "label": s.get("label"),
        "matchCount": s.get("matchCount", 0),
        "lastMatchAt": s.get("lastMatchAt").isoformat() if hasattr(s.get("lastMatchAt"), "isoformat") else s.get("lastMatchAt"),
        "lastMatchVehicleId": s.get("lastMatchVehicleId"),
        "createdAt": s.get("createdAt").isoformat() if hasattr(s.get("createdAt"), "isoformat") else s.get("createdAt"),
    }


# ─────────────────────────────────────────────────────────────────────
# Demo seed — one saved search for the demo watcher with one match_found
# ─────────────────────────────────────────────────────────────────────

DEMO_SEARCH_ID = "search_demo_bmw_3series"


async def seed_demo_search() -> None:
    from app.vehicles.watchlist import DEMO_WATCHER_ID
    from app.vehicles.public_memory import DEMO_VEHICLE_ID

    now = datetime.now(timezone.utc)

    f = {
        "brand": "BMW",
        "model": "320d",
        "yearMin": 2018,
        "yearMax": 2020,
        "priceMax": 19_000,
        "city": "Berlin",
    }
    await db.market_searches.update_one(
        {"id": DEMO_SEARCH_ID},
        {
            "$set": {
                "id": DEMO_SEARCH_ID,
                "watcherId": DEMO_WATCHER_ID,
                "filter": f,
                "label": "BMW 320d · 2018–2020 · до €19k · Berlin",
                "matchCount": 1,
                "lastMatchAt": now,
                "lastMatchVehicleId": DEMO_VEHICLE_ID,
            },
            "$setOnInsert": {"createdAt": now},
        },
        upsert=True,
    )

    # Pre-fill one match_found notification so /feed has something.
    veh = await db.vehicles.find_one({"id": DEMO_VEHICLE_ID}, {"_id": 0})
    if veh:
        nid = f"notif_match_{DEMO_SEARCH_ID}_{DEMO_VEHICLE_ID}"
        await db.notifications.update_one(
            {"id": nid},
            {
                "$set": {
                    "id": nid,
                    "watcherId": DEMO_WATCHER_ID,
                    "vehicleId": DEMO_VEHICLE_ID,
                    "vehicleSnapshot": {
                        "brand": veh.get("brand"),
                        "model": veh.get("model"),
                        "thumbnail": veh.get("thumbnail"),
                    },
                    "kind": "match_found",
                    "title": _match_title(veh),
                    "body": _match_body(veh, f),
                    "severity": "success",
                    "createdAt": now,
                    "eventAt": now,
                    "readAt": None,
                    "marketSearchId": DEMO_SEARCH_ID,
                    "marketSearchLabel": "BMW 320d · 2018–2020 · до €19k · Berlin",
                },
            },
            upsert=True,
        )

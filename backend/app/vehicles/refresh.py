"""app.vehicles.refresh — Temporal evolution layer.

Vehicles in this platform are NOT static cards. Once ingested, the world
keeps moving around them: price drops, mileage grows, the listing gets
relisted by a different seller, or simply disappears.

This module turns those external mutations into first-class memory
events, so /vehicle/:id timeline becomes a *living* document instead of
a frozen snapshot.

Pipeline per vehicle:

    last_snapshot ←  db.listing_snapshots (or vehicle doc itself)
    fresh        ←  parse_listing(listing_url)
    diff         ←  compute_changes(last_snapshot, fresh)
    if material(diff):
        emit timeline event(s)        ← price_drop, mileage_update, …
        write new snapshot            ← db.listing_snapshots
        update vehicle aggregates     ← lastRefreshAt, lastPrice, …

Loop strategy:
  - Tick every N seconds (default 60s).
  - Each tick processes up to BATCH (default 5) vehicles, oldest
    `lastRefreshAt` first, with `listing_url` set and not refreshed
    within COOLDOWN (default 6h).
  - Failures are non-fatal — the next tick retries.

Idempotency:
  - Snapshots are deduped: identical {price, mileage, available, title}
    is NOT re-written, but `lastRefreshAt` IS bumped.
  - Material thresholds: price ≥ €100 *or* ≥1%, mileage Δ > 0.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.db import db
from app.parsers.universal import parse_listing
from app.parsers.contract import from_legacy, ListingParseResult


logger = logging.getLogger("vehicles.refresh")
router = APIRouter(prefix="/api/vehicles", tags=["vehicles-refresh"])


# ─────────────────────────────────────────────────────────────────────
# Knobs (env overrides)
# ─────────────────────────────────────────────────────────────────────

REFRESH_TICK_SECONDS = int(os.getenv("REFRESH_TICK_SECONDS", "60"))
REFRESH_BATCH = int(os.getenv("REFRESH_BATCH", "5"))
REFRESH_COOLDOWN_HOURS = float(os.getenv("REFRESH_COOLDOWN_HOURS", "6"))

PRICE_DELTA_EUR_THRESHOLD = int(os.getenv("REFRESH_PRICE_DELTA_EUR", "100"))
PRICE_DELTA_PCT_THRESHOLD = float(os.getenv("REFRESH_PRICE_DELTA_PCT", "1.0"))


# ─────────────────────────────────────────────────────────────────────
# Indexes
# ─────────────────────────────────────────────────────────────────────

async def ensure_refresh_indexes() -> None:
    """Indexes for the loop scan + snapshot history."""
    try:
        await db.vehicles.create_index([("lastRefreshAt", 1)], background=True, sparse=True)
        await db.vehicles.create_index([("listing_url", 1)], background=True, sparse=True)
        await db.listing_snapshots.create_index([("vehicleId", 1), ("at", -1)], background=True)
    except Exception as e:
        logger.warning(f"refresh indexes ensure failed (non-fatal): {e}")


# ─────────────────────────────────────────────────────────────────────
# Diff & event synthesis
# ─────────────────────────────────────────────────────────────────────

def _compute_diff(prev: dict, fresh: dict) -> list[dict]:
    """Return a list of timeline-ready event dicts, newest first."""
    events: list[dict] = []
    now = datetime.now(timezone.utc)

    fresh_price = fresh.get("price")
    fresh_mileage = fresh.get("mileage")
    fresh_available = fresh.get("available", True)

    # ── Listing availability transitions ──────────────────────────────
    prev_available = prev.get("available", True)
    if prev_available and not fresh_available:
        events.append({
            "id": f"refresh_disappeared_{int(now.timestamp())}",
            "type": "listing_disappeared",
            "at": now,
            "severity": "warning",
            "title": "Объявление исчезло",
            "text": "Площадка вернула 404 — продавец снял или продал.",
        })
    elif (not prev_available) and fresh_available:
        events.append({
            "id": f"refresh_relisted_{int(now.timestamp())}",
            "type": "relisted",
            "at": now,
            "severity": "info",
            "title": "Объявление снова в продаже",
            "text": "Продавец вернул объявление обратно.",
        })

    # ── Price ─────────────────────────────────────────────────────────
    prev_price = prev.get("price")
    if prev_price and fresh_price and prev_price != fresh_price:
        delta = fresh_price - prev_price
        pct = abs(delta) / prev_price * 100
        material = abs(delta) >= PRICE_DELTA_EUR_THRESHOLD or pct >= PRICE_DELTA_PCT_THRESHOLD
        if material:
            if delta < 0:
                events.append({
                    "id": f"refresh_pdrop_{int(now.timestamp())}",
                    "type": "price_drop",
                    "at": now,
                    "severity": "success",
                    "title": f"Цена упала на €{abs(delta):,}".replace(",", " "),
                    "text": f"Было €{prev_price:,} → стало €{fresh_price:,} (−{pct:.1f}%)".replace(",", " "),
                    "savingsEur": abs(delta),
                })
            else:
                events.append({
                    "id": f"refresh_pup_{int(now.timestamp())}",
                    "type": "price_increase",
                    "at": now,
                    "severity": "warning",
                    "title": f"Цена выросла на €{delta:,}".replace(",", " "),
                    "text": f"Было €{prev_price:,} → стало €{fresh_price:,} (+{pct:.1f}%)".replace(",", " "),
                })

    # ── Mileage ───────────────────────────────────────────────────────
    prev_mileage = prev.get("mileage")
    if prev_price is None and fresh_price is not None:
        # First-time price observation isn't a drop — nothing to emit.
        pass
    if prev_mileage and fresh_mileage and fresh_mileage > prev_mileage:
        delta_km = fresh_mileage - prev_mileage
        # Heuristic: >5 000 km between observations is suspicious in
        # a typical 6h-7d window, surface as warning.
        severity = "warning" if delta_km >= 5_000 else "info"
        events.append({
            "id": f"refresh_mileage_{int(now.timestamp())}",
            "type": "mileage_update",
            "at": now,
            "severity": severity,
            "title": f"Пробег обновили: +{delta_km:,} км".replace(",", " "),
            "text": f"Было {prev_mileage:,} → стало {fresh_mileage:,}".replace(",", " "),
            "mileage": fresh_mileage,
        })

    return events


def _is_material_change(prev: dict, fresh: dict) -> bool:
    """Quick check before bothering with diff computation."""
    if prev.get("available", True) != fresh.get("available", True):
        return True
    if prev.get("price") != fresh.get("price"):
        return True
    if prev.get("mileage") != fresh.get("mileage"):
        return True
    return False


# ─────────────────────────────────────────────────────────────────────
# Step 10B Pass 2 — refresh verdict bucketing.
#
# Critical insight from the audit: the previous heuristic
#     available = bool(parsed["parsed"]) or bool(title or price)
# turned an anti-bot 403 into a `listing_disappeared` event. That is a
# false negative that erodes user trust ("the platform thinks my car is
# gone — but the seller just blocked auto-fetch"). With the canonical
# contract in place, the decision becomes a one-liner over
# `degradedReason`.
# ─────────────────────────────────────────────────────────────────────

# Anti-bot / transient: refresh is *degraded*. Do nothing material —
# don't change `available`, don't write a snapshot, don't emit events.
# Bump `lastRefreshAt` only.
_DEGRADED_REASONS: frozenset[str] = frozenset({
    "antibot",
    "timeout",
    "network",
    "fetch_failed",
    "parse_error",
    "parse_exception",
    "low_extraction_confidence",
})

# Permanent listing disappearance: emit `listing_disappeared` event.
_DISAPPEARED_REASONS: frozenset[str] = frozenset({
    "expired_listing",
})

# Anomalies that should never happen on a previously-good listing_url
# (the URL was once valid). Be defensive — log and treat as degraded so
# we never emit a false `disappeared` event from a parser glitch.
_HARD_ANOMALY_REASONS: frozenset[str] = frozenset({
    "bad_url",
    "unsupported_domain",
    "not_a_listing",
    "unsupported_source",
})


def _refresh_verdict(canonical: ListingParseResult) -> str:
    """Bucket a refresh fetch into 'ok' / 'degraded' / 'disappeared' /
    'hard_anomaly'. Pure function — no DB, no side effects."""
    code = canonical.degradedReason
    if code is None:
        return "ok"
    if code in _DISAPPEARED_REASONS:
        return "disappeared"
    if code in _HARD_ANOMALY_REASONS:
        return "hard_anomaly"
    # http_403/404/429/503 → soft anti-bot/transient bucket.
    # http_410 ("gone") is the one HTTP code that genuinely signals
    # disappearance — explicit marketplace removal.
    if code == "http_410":
        return "disappeared"
    if code in _DEGRADED_REASONS or code.startswith("http_") or code.startswith("fetch_error"):
        return "degraded"
    # Unknown code — degraded, so we never accidentally invent a
    # disappearance.
    return "degraded"


# ─────────────────────────────────────────────────────────────────────
# Single-vehicle refresh
# ─────────────────────────────────────────────────────────────────────

async def refresh_vehicle(vehicle_id: str, *, force: bool = False) -> dict:
    """Re-fetch a single vehicle's listing and emit events. Returns audit dict.

    Args:
        vehicle_id: vehicle.id
        force: bypass cooldown if True
    """
    veh = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0})
    if not veh:
        raise HTTPException(status_code=404, detail="vehicle_not_found")

    url = veh.get("listing_url")
    if not url:
        return {"vehicleId": vehicle_id, "status": "skipped", "reason": "no_listing_url"}

    now = datetime.now(timezone.utc)

    # Cooldown.
    last_refresh = veh.get("lastRefreshAt")
    if last_refresh and not force:
        if isinstance(last_refresh, str):
            try: last_refresh = datetime.fromisoformat(last_refresh.replace("Z", "+00:00"))
            except Exception: last_refresh = None
        if last_refresh:
            if not last_refresh.tzinfo:
                last_refresh = last_refresh.replace(tzinfo=timezone.utc)
            if (now - last_refresh) < timedelta(hours=REFRESH_COOLDOWN_HOURS):
                return {"vehicleId": vehicle_id, "status": "skipped", "reason": "cooldown"}

    # Fetch fresh.
    parsed = await parse_listing(url)
    canonical = from_legacy(parsed)
    verdict = _refresh_verdict(canonical)

    # Step 10B Pass 2 — degraded / hard-anomaly buckets short-circuit
    # BEFORE diff computation. The previous heuristic
    #   available = parsed["parsed"] or title or price
    # turned an anti-bot 403 into a `listing_disappeared` event. With
    # canonical contract that defect is gone.
    if verdict in ("degraded", "hard_anomaly"):
        await db.vehicles.update_one(
            {"id": vehicle_id},
            {"$set": {
                "lastRefreshAt": now,
                "updatedAt": now,
                "lastRefreshDegradedReason": canonical.degradedReason,
            }},
        )
        return {
            "vehicleId": vehicle_id,
            "status": verdict,                          # "degraded" / "hard_anomaly"
            "degradedReason": canonical.degradedReason,
            "events": [],
            "snapshotWritten": False,
        }

    # verdict ∈ {"ok", "disappeared"} — proceed to diff.
    fresh = {
        "price": parsed.get("price") if verdict == "ok" else None,
        "mileage": parsed.get("mileage") if verdict == "ok" else None,
        "title": parsed.get("title"),
        "image": parsed.get("image"),
        "available": verdict == "ok",
    }

    # Previous snapshot (head of history, fall back to vehicle doc).
    prev_snap = await db.listing_snapshots.find_one(
        {"vehicleId": vehicle_id},
        {"_id": 0},
        sort=[("at", -1)],
    )
    prev = prev_snap or {
        "price": veh.get("price") or veh.get("lastPrice"),
        "mileage": veh.get("mileage") or veh.get("lastMileage"),
        "available": veh.get("status") != "disappeared",
        "title": veh.get("importedFrom"),
    }

    events = _compute_diff(prev, fresh)
    snapshot_written = False

    if _is_material_change(prev, fresh) or not prev_snap:
        await db.listing_snapshots.insert_one({
            "vehicleId": vehicle_id,
            "at": now,
            **fresh,
            "source": parsed.get("source"),
        })
        snapshot_written = True

    if events:
        await db.vehicles.update_one(
            {"id": vehicle_id},
            {
                "$push": {"activity": {"$each": events}},
                "$set": {
                    "lastRefreshAt": now,
                    "lastPrice": fresh["price"] if fresh["price"] is not None else veh.get("lastPrice"),
                    "lastMileage": fresh["mileage"] if fresh["mileage"] is not None else veh.get("lastMileage"),
                    "updatedAt": now,
                    **({"price": fresh["price"]} if fresh["price"] is not None else {}),
                    **({"mileage": fresh["mileage"]} if fresh["mileage"] is not None else {}),
                    **({"status": "disappeared"} if not fresh["available"] else {"status": "imported"}),
                },
            },
        )
        # Fan events out to subscribers — retention loop.
        try:
            from app.vehicles.watchlist import fanout_event
            for ev in events:
                await fanout_event(vehicle_id, ev)
        except Exception as e:
            logger.warning(f"fanout failed for {vehicle_id} (non-fatal): {e}")
    else:
        # No events but bump lastRefreshAt so we don't keep hammering.
        await db.vehicles.update_one(
            {"id": vehicle_id},
            {"$set": {"lastRefreshAt": now, "updatedAt": now}},
        )

    return {
        "vehicleId": vehicle_id,
        "status": "ok",
        "events": [{"type": e["type"], "title": e["title"], "severity": e["severity"]} for e in events],
        "snapshotWritten": snapshot_written,
        "fresh": fresh,
        "prev": {k: prev.get(k) for k in ("price", "mileage", "available")},
    }


# ─────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────

class SimulateRequest(BaseModel):
    kind: str = Field(..., pattern="^(price_drop|price_increase|mileage_update|listing_disappeared|relisted)$")
    delta: Optional[int] = None  # eur for price_*, km for mileage_update


@router.post("/{vehicle_id}/refresh")
async def manual_refresh(vehicle_id: str, force: bool = Query(False)):
    """Force a single-vehicle refresh. Useful for admin/debug + UI demo."""
    return await refresh_vehicle(vehicle_id, force=force)


@router.get("/{vehicle_id}/snapshots")
async def list_snapshots(vehicle_id: str, limit: int = Query(50, ge=1, le=200)):
    """Snapshot history for a vehicle (newest first)."""
    cur = db.listing_snapshots.find({"vehicleId": vehicle_id}, {"_id": 0}).sort("at", -1).limit(limit)
    items = await cur.to_list(limit)
    for it in items:
        if hasattr(it.get("at"), "isoformat"):
            it["at"] = it["at"].isoformat()
    return {"vehicleId": vehicle_id, "items": items, "count": len(items)}


@router.post("/{vehicle_id}/simulate-change")
async def simulate_change(vehicle_id: str, payload: SimulateRequest):
    """Demo helper — emit a synthetic temporal event without an external fetch.

    This is what powers the "world feels alive" UX even when the
    upstream marketplace is anti-bot blocked. Marked synthetic=True
    in the activity record.
    """
    veh = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0})
    if not veh:
        raise HTTPException(status_code=404, detail="vehicle_not_found")

    now = datetime.now(timezone.utc)
    cur_price = veh.get("price") or veh.get("lastPrice") or 18_000
    cur_mileage = veh.get("mileage") or veh.get("lastMileage") or 100_000

    event: dict
    set_fields: dict = {"updatedAt": now, "lastRefreshAt": now}

    if payload.kind == "price_drop":
        delta = payload.delta or 600
        new_price = max(0, cur_price - delta)
        event = {
            "id": f"sim_pdrop_{int(now.timestamp())}",
            "type": "price_drop",
            "at": now,
            "severity": "success",
            "title": f"Цена упала на €{delta:,}".replace(",", " "),
            "text": f"Было €{cur_price:,} → стало €{new_price:,}".replace(",", " "),
            "savingsEur": delta,
            "synthetic": True,
        }
        set_fields["price"] = new_price
        set_fields["lastPrice"] = new_price

    elif payload.kind == "price_increase":
        delta = payload.delta or 400
        new_price = cur_price + delta
        event = {
            "id": f"sim_pup_{int(now.timestamp())}",
            "type": "price_increase",
            "at": now,
            "severity": "warning",
            "title": f"Цена выросла на €{delta:,}".replace(",", " "),
            "text": f"Было €{cur_price:,} → стало €{new_price:,}".replace(",", " "),
            "synthetic": True,
        }
        set_fields["price"] = new_price
        set_fields["lastPrice"] = new_price

    elif payload.kind == "mileage_update":
        delta = payload.delta or 1200
        new_m = cur_mileage + delta
        sev = "warning" if delta >= 5_000 else "info"
        event = {
            "id": f"sim_mileage_{int(now.timestamp())}",
            "type": "mileage_update",
            "at": now,
            "severity": sev,
            "title": f"Пробег обновили: +{delta:,} км".replace(",", " "),
            "text": f"Было {cur_mileage:,} → стало {new_m:,}".replace(",", " "),
            "mileage": new_m,
            "synthetic": True,
        }
        set_fields["mileage"] = new_m
        set_fields["lastMileage"] = new_m

    elif payload.kind == "listing_disappeared":
        event = {
            "id": f"sim_disappeared_{int(now.timestamp())}",
            "type": "listing_disappeared",
            "at": now,
            "severity": "warning",
            "title": "Объявление исчезло",
            "text": "Площадка вернула 404 — продавец снял или продал.",
            "synthetic": True,
        }
        set_fields["status"] = "disappeared"

    else:  # relisted
        event = {
            "id": f"sim_relisted_{int(now.timestamp())}",
            "type": "relisted",
            "at": now,
            "severity": "info",
            "title": "Объявление снова в продаже",
            "text": "Продавец вернул объявление обратно.",
            "synthetic": True,
        }
        set_fields["status"] = "imported"

    await db.vehicles.update_one(
        {"id": vehicle_id},
        {"$push": {"activity": event}, "$set": set_fields},
    )
    # Also record a snapshot if it was a market/data change.
    if payload.kind in ("price_drop", "price_increase", "mileage_update"):
        await db.listing_snapshots.insert_one({
            "vehicleId": vehicle_id,
            "at": now,
            "price": set_fields.get("price"),
            "mileage": set_fields.get("mileage"),
            "available": True,
            "synthetic": True,
        })

    # Fan out to subscribers (retention loop).
    try:
        from app.vehicles.watchlist import fanout_event
        await fanout_event(vehicle_id, event)
    except Exception as e:
        logger.warning(f"simulate fanout failed for {vehicle_id} (non-fatal): {e}")

    return {"ok": True, "event": {**event, "at": now.isoformat()}}

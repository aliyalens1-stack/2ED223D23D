"""Sprint 3 Step 5 — Operational Map snapshot.

Pure read-projection. No new collections, no timeline writes.

Sources:
    db.zones                    — pre-seeded zones with center + bbox
    db.users (role=inspector)   — supply + reputation + location + isOnline
    db.inspection_assignments   — offered + accepted
    db.inspection_jobs          — claimed / on_route / arrived / inspecting / submitted
    db.auto_requests            — pending demand (status=pending|searching)

Architectural contract:
    snapshot is deterministic given DB state. No random factors. Pure
    aggregation. Refresh = re-read. No caches at this layer.

Pressure tiers (named constants, single source of truth):
    ratio = demand / max(supply, 1)
    ratio <= 1.0 → low
    ratio <= 2.0 → medium
    ratio <= 4.0 → high
    ratio  > 4.0 → critical

SLA risk (per active job):
    Uses slaDueAt if present, else falls back to createdAt + threshold.
    A job whose due-time has passed → "late". Within SLA_WATCH_MIN of
    due → "watch". Otherwise "ok".
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from app.core.db import get_db
from app.core.geo import _ZONE_BOUNDS as ZONE_BBOX  # {zoneId: (lat_min, lat_max, lon_min, lon_max)}


logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────
# Named constants
# ─────────────────────────────────────────────────────────────────────

PRESSURE_LOW_MAX      = 1.0
PRESSURE_MEDIUM_MAX   = 2.0
PRESSURE_HIGH_MAX     = 4.0

SLA_DEFAULT_HOURS     = 24    # if a job has no slaDueAt, assume 24h from createdAt
SLA_WATCH_MINUTES     = 60    # within 60 min of due → "watch"

# Statuses that consume inspector capacity (count as "busy" supply).
BUSY_JOB_STATUSES = ("claimed", "on_route", "arrived", "inspecting", "accepted")

# Active job statuses surfaced on the map.
ACTIVE_JOB_STATUSES = (*BUSY_JOB_STATUSES, "awaiting_report", "submitted")

# Demand sources — pending requests waiting for dispatch.
PENDING_REQUEST_STATUSES = ("pending", "searching", "open")


def pressure_label(ratio: float) -> str:
    if ratio <= PRESSURE_LOW_MAX:    return "low"
    if ratio <= PRESSURE_MEDIUM_MAX: return "medium"
    if ratio <= PRESSURE_HIGH_MAX:   return "high"
    return "critical"


def _zone_for_point(lat: Optional[float], lng: Optional[float]) -> Optional[str]:
    if lat is None or lng is None:
        return None
    for zid, (lat_min, lat_max, lon_min, lon_max) in ZONE_BBOX.items():
        if lat_min <= lat <= lat_max and lon_min <= lng <= lon_max:
            return zid
    return None


def _sla_risk(job: Dict[str, Any], now: datetime) -> str:
    due_iso = job.get("slaDueAt")
    if not due_iso:
        created_iso = job.get("createdAt") or job.get("claimedAt")
        if not created_iso:
            return "ok"
        try:
            created = datetime.fromisoformat(str(created_iso).replace("Z", "+00:00"))
        except Exception:
            return "ok"
        due = created + timedelta(hours=SLA_DEFAULT_HOURS)
    else:
        try:
            due = datetime.fromisoformat(str(due_iso).replace("Z", "+00:00"))
        except Exception:
            return "ok"
    if now >= due:
        return "late"
    if (due - now).total_seconds() <= SLA_WATCH_MINUTES * 60:
        return "watch"
    return "ok"


# ─────────────────────────────────────────────────────────────────────
# Section readers
# ─────────────────────────────────────────────────────────────────────

async def _read_zones(db) -> List[Dict[str, Any]]:
    """Return raw zone documents, projected to map shape."""
    out: List[Dict[str, Any]] = []
    async for z in db.zones.find({}, {
        "_id": 0, "id": 1, "name": 1, "city": 1, "country": 1,
        "center": 1,
    }):
        out.append({
            "id": z.get("id"),
            "label": z.get("name") or z.get("id"),
            "city": z.get("city"),
            "country": z.get("country"),
            "center": z.get("center"),
        })
    return out


async def _read_inspectors(db) -> List[Dict[str, Any]]:
    """Return inspectors with reputation/location/online flag.

    Excludes hardFloor inspectors from the supply count; they still
    appear in the list with `excludedFromSupply=true` so admin can see
    why supply is short.
    """
    inspectors: List[Dict[str, Any]] = []
    async for u in db.users.find(
        {"$or": [{"role": "inspector"}, {"accountKind": "inspector"}]},
        {
            "_id": 1, "name": 1, "isOnline": 1, "location": 1,
            "reputation": 1, "city": 1,
        },
    ):
        loc = u.get("location") or {}
        lat = loc.get("lat") if isinstance(loc, dict) else None
        lng = loc.get("lng") if isinstance(loc, dict) else None
        rep = u.get("reputation") or {}
        zone = _zone_for_point(lat, lng)
        inspectors.append({
            "id": str(u["_id"]),
            "name": u.get("name"),
            "isOnline": bool(u.get("isOnline")),
            "tier": rep.get("tier") or "bronze",
            "score": int(rep.get("score") or 0),
            "hardFloor": bool(rep.get("hardFloor")),
            "zone": zone,
            "city": u.get("city"),
            "location": ({"lat": lat, "lng": lng} if lat is not None and lng is not None else None),
        })
    return inspectors


async def _read_active_jobs(db) -> List[Dict[str, Any]]:
    """Active inspection jobs eligible to show on the map."""
    now = datetime.now(timezone.utc)
    rows: List[Dict[str, Any]] = []
    async for j in db.inspection_jobs.find(
        {"status": {"$in": list(ACTIVE_JOB_STATUSES)}},
        {
            "_id": 1, "status": 1, "inspectorId": 1, "customerId": 1,
            "vehicle": 1, "vehicleId": 1, "location": 1, "city": 1,
            "createdAt": 1, "claimedAt": 1, "slaDueAt": 1,
        },
    ):
        loc = j.get("location") or {}
        lat = loc.get("lat") if isinstance(loc, dict) else None
        lng = loc.get("lng") if isinstance(loc, dict) else None
        rows.append({
            "id": str(j["_id"]),
            "vehicle": _vehicle_label(j),
            "status": j.get("status"),
            "inspectorId": j.get("inspectorId"),
            "customerId": j.get("customerId"),
            "city": j.get("city"),
            "customerZone": _zone_for_point(lat, lng),
            "slaRisk": _sla_risk(j, now),
            "location": ({"lat": lat, "lng": lng} if lat is not None and lng is not None else None),
        })
    return rows


def _vehicle_label(job: Dict[str, Any]) -> str:
    v = job.get("vehicle") or {}
    if isinstance(v, dict):
        make = v.get("make") or v.get("brand") or ""
        model = v.get("model") or ""
        return f"{make} {model}".strip() or "—"
    if isinstance(v, str):
        return v
    return "—"


async def _read_assignments(db) -> List[Dict[str, Any]]:
    """Live assignment rows surfaced on the map."""
    rows: List[Dict[str, Any]] = []
    async for a in db.inspection_assignments.find(
        {"status": {"$in": ["offered", "accepted"]}},
        {"_id": 0},
    ):
        # Resolve zone via the inspector's location if no job location is stored.
        zone = None
        if a.get("inspectorId"):
            insp = await db.users.find_one(
                {"_id": a["inspectorId"]},
                {"location": 1, "_id": 0},
            )
            if insp and isinstance(insp.get("location"), dict):
                zone = _zone_for_point(insp["location"].get("lat"), insp["location"].get("lng"))
        rows.append({
            "id": a.get("id"),
            "jobId": a.get("jobId"),
            "status": a.get("status"),
            "priority": a.get("priority"),
            "score": a.get("score"),
            "expiresAt": a.get("expiresAt"),
            "distanceKm": a.get("distanceKm"),
            "inspectorId": a.get("inspectorId"),
            "zone": zone,
        })
    return rows


async def _read_demand_per_zone(db) -> Dict[str, int]:
    """Count of pending auto_requests per zone.

    auto_requests carry `cityId` or `zoneId` in some shapes. We honour
    whichever is present; otherwise we attempt point-in-bbox via the
    request's location.
    """
    out: Dict[str, int] = {}
    async for r in db.auto_requests.find(
        {"status": {"$in": list(PENDING_REQUEST_STATUSES)}},
        {"_id": 0, "zoneId": 1, "cityId": 1, "location": 1},
    ):
        zone = r.get("zoneId") or r.get("cityId")
        if not zone:
            loc = r.get("location") or {}
            if isinstance(loc, dict):
                zone = _zone_for_point(loc.get("lat"), loc.get("lng"))
        if zone:
            out[zone] = out.get(zone, 0) + 1
    return out


# ─────────────────────────────────────────────────────────────────────
# Public — compute_snapshot
# ─────────────────────────────────────────────────────────────────────

async def compute_snapshot() -> Dict[str, Any]:
    """Return the full ops-map projection. Pure read."""
    db = get_db()
    zones = await _read_zones(db)
    inspectors = await _read_inspectors(db)
    active_jobs = await _read_active_jobs(db)
    assignments = await _read_assignments(db)
    demand_by_zone = await _read_demand_per_zone(db)

    # Per-zone supply: online + not hardFloor + not yet at max active jobs.
    # We pre-compute a busy set from active_jobs (inspector currently has
    # a non-terminal job).
    busy_inspector_ids = {
        j["inspectorId"] for j in active_jobs
        if j.get("inspectorId") and j.get("status") in BUSY_JOB_STATUSES
    }

    supply_by_zone: Dict[str, int] = {}
    busy_by_zone:   Dict[str, int] = {}
    for ins in inspectors:
        if ins["zone"] is None:
            continue
        if ins["hardFloor"]:
            continue
        if ins["id"] in busy_inspector_ids:
            busy_by_zone[ins["zone"]] = busy_by_zone.get(ins["zone"], 0) + 1
            continue
        if ins["isOnline"]:
            supply_by_zone[ins["zone"]] = supply_by_zone.get(ins["zone"], 0) + 1

    # Build pressure rows aligned with zones list.
    pressure_rows: List[Dict[str, Any]] = []
    for z in zones:
        zid = z["id"]
        if zid is None:
            continue
        demand = int(demand_by_zone.get(zid, 0))
        supply = int(supply_by_zone.get(zid, 0))
        busy = int(busy_by_zone.get(zid, 0))
        ratio = round(demand / max(supply, 1), 2)
        pressure_rows.append({
            "id": zid,
            "label": z["label"],
            "city": z["city"],
            "center": z["center"],
            "demand": demand,
            "supply": supply,
            "busy": busy,
            "ratio": ratio,
            "pressure": pressure_label(ratio),
        })

    # Tag each inspector with `excludedFromSupply` reason for the UI.
    for ins in inspectors:
        if ins["hardFloor"]:
            ins["excludedFromSupply"] = "hardFloor"
            ins["status"] = "blocked"
        elif ins["id"] in busy_inspector_ids:
            ins["excludedFromSupply"] = "busy"
            ins["status"] = "busy"
        elif ins["isOnline"]:
            ins["status"] = "online"
        else:
            ins["status"] = "offline"
        ins["activeJobs"] = sum(
            1 for j in active_jobs
            if j.get("inspectorId") == ins["id"] and j.get("status") in BUSY_JOB_STATUSES
        )

    # Summary cards.
    summary = {
        "totalZones": len(pressure_rows),
        "totalInspectors": len(inspectors),
        "onlineInspectors": sum(1 for i in inspectors if i["status"] == "online"),
        "busyInspectors": sum(1 for i in inspectors if i["status"] == "busy"),
        "blockedInspectors": sum(1 for i in inspectors if i["status"] == "blocked"),
        "activeJobs": len(active_jobs),
        "lateJobs": sum(1 for j in active_jobs if j["slaRisk"] == "late"),
        "watchJobs": sum(1 for j in active_jobs if j["slaRisk"] == "watch"),
        "liveOffers": sum(1 for a in assignments if a["status"] == "offered"),
        "claimedAssignments": sum(1 for a in assignments if a["status"] == "accepted"),
        "criticalZones": sum(1 for p in pressure_rows if p["pressure"] == "critical"),
        "highPressureZones": sum(1 for p in pressure_rows if p["pressure"] in ("high", "critical")),
    }

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "zones": pressure_rows,
        "inspectors": inspectors,
        "assignments": assignments,
        "jobs": active_jobs,
        # `pressure` kept as an alias to `zones` for spec compatibility.
        # The two lists are intentionally the same projection — clients
        # may read either key. Removing one would break the spec shape.
        "pressure": pressure_rows,
        "summary": summary,
    }


__all__ = [
    "compute_snapshot",
    "pressure_label",
    "PRESSURE_LOW_MAX",
    "PRESSURE_MEDIUM_MAX",
    "PRESSURE_HIGH_MAX",
    "SLA_DEFAULT_HOURS",
    "SLA_WATCH_MINUTES",
    "BUSY_JOB_STATUSES",
    "ACTIVE_JOB_STATUSES",
    "PENDING_REQUEST_STATUSES",
]

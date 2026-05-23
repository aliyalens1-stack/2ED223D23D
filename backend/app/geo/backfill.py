"""app.geo.backfill — Geo-4 topology backfill.

Walks `organizations` and resolves each provider's canonical topology
from existing free-text/coordinate fields:

  organizations.city       → exact match against CITY_CATALOGUE name OR code
  organizations.country    → ISO-2 country
  organizations.location   → GeoJSON Point coords (radius-match)

Determinism rules (intentionally strict — better to skip than mislabel):

  1. If `organizations.city` is a known catalogue name AND
     `organizations.country` matches that city's country → bind.
  2. Else if coordinates exist AND match exactly ONE catalogue city
     within ~5 km haversine → bind.
  3. Else → skip + record reason.

This module is pure logic + Mongo I/O. No HTTP, no auth — meant to be
called from `scripts/backfill_provider_topology.py` (one-shot CLI) and
from tests.
"""
from __future__ import annotations
import math
from typing import Optional

from app.marketplace.cities import CITY_CATALOGUE
from app.geo.topology import (
    upsert_topology,
    ALLOWED_RADIUS_KM,
    DEFAULT_RADIUS_KM,
)


# Tolerance for coordinate-based fallback. Strict on purpose: a wider
# tolerance would mislabel suburbs across city boundaries.
COORD_MATCH_KM = 5.0


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


def resolve_city_for_org(org: dict) -> tuple[Optional[dict], str]:
    """Return (catalogue_city_dict, reason).

    `catalogue_city_dict` is None when ambiguous/unknown. `reason` is a
    short tag suitable for logs / reports (`name_match`, `coord_match`,
    `unknown_city`, `ambiguous_coord`, `no_signal`).
    """
    country = (org.get("country") or "").upper().strip()
    raw_city = (org.get("city") or "").strip()

    # Rule 1 — exact name match (case-insensitive). Country must agree
    # if provided; otherwise we accept the unique catalogue match.
    # Match against: canonical name, code, AND addressMarkers (Київ vs
    # Kyiv vs Kiev — all map to the same canonical city).
    if raw_city:
        rc_lower = raw_city.lower()
        name_matches = []
        for c in CITY_CATALOGUE:
            candidates = {c["name"].lower(), c["code"].lower()}
            for marker in c.get("addressMarkers") or []:
                candidates.add(marker.lower())
            if rc_lower in candidates:
                name_matches.append(c)
        if country:
            name_matches = [c for c in name_matches if c["country"] == country]
        if len(name_matches) == 1:
            return name_matches[0], "name_match"
        if len(name_matches) > 1:
            return None, "ambiguous_name"

    # Rule 2 — coordinate fallback. `location.coordinates` is GeoJSON
    # `[lng, lat]`. We accept the catalogue city if it's the UNIQUE
    # match within COORD_MATCH_KM.
    loc = org.get("location") or {}
    coords = loc.get("coordinates") if isinstance(loc, dict) else None
    if isinstance(coords, (list, tuple)) and len(coords) == 2:
        try:
            lng, lat = float(coords[0]), float(coords[1])
        except (TypeError, ValueError):
            return None, "no_signal"
        candidates = [
            c for c in CITY_CATALOGUE
            if _haversine_km(lat, lng, float(c["lat"]), float(c["lng"])) <= COORD_MATCH_KM
            and (not country or c["country"] == country)
        ]
        if len(candidates) == 1:
            return candidates[0], "coord_match"
        if len(candidates) > 1:
            return None, "ambiguous_coord"
        return None, "unknown_city"

    return None, "no_signal"


async def backfill_provider_topology(
    db,
    *,
    radius_km: int = DEFAULT_RADIUS_KM,
    dry_run: bool = False,
) -> dict:
    """One-shot backfill. Returns a deterministic report.

    Args:
        db: Motor database handle.
        radius_km: travel radius to assign — must be in ALLOWED_RADIUS_KM.
            We pick a conservative default; providers can edit later.
        dry_run: when True, computes mappings but writes nothing.

    Report shape (stable — tests assert on it):
        {
            total_orgs, already_bound, bound_now, skipped,
            by_reason: { name_match, coord_match, ambiguous_name,
                          ambiguous_coord, unknown_city, no_signal,
                          missing_owner, no_owner_user },
            skipped_samples: [{slug, reason, city, country}],  # ≤ 20
        }
    """
    if radius_km not in ALLOWED_RADIUS_KM:
        raise ValueError(f"radius_km must be in {ALLOWED_RADIUS_KM}")

    report = {
        "total_orgs": 0,
        "already_bound": 0,
        "bound_now": 0,
        "skipped": 0,
        "by_reason": {},
        "skipped_samples": [],
    }

    cursor = db.organizations.find(
        {"status": "active"},
        {"_id": 0, "slug": 1, "ownerId": 1, "city": 1, "country": 1, "location": 1},
    )
    async for org in cursor:
        report["total_orgs"] += 1
        owner_id = org.get("ownerId")
        if not owner_id:
            report["skipped"] += 1
            report["by_reason"]["missing_owner"] = report["by_reason"].get("missing_owner", 0) + 1
            if len(report["skipped_samples"]) < 20:
                report["skipped_samples"].append({
                    "slug": org.get("slug"), "reason": "missing_owner",
                    "city": org.get("city"), "country": org.get("country"),
                })
            continue

        existing = await db.provider_topology.find_one(
            {"userId": str(owner_id)}, {"_id": 1}
        )
        if existing:
            report["already_bound"] += 1
            continue

        city, reason = resolve_city_for_org(org)
        report["by_reason"][reason] = report["by_reason"].get(reason, 0) + 1

        if not city:
            report["skipped"] += 1
            if len(report["skipped_samples"]) < 20:
                report["skipped_samples"].append({
                    "slug": org.get("slug"), "reason": reason,
                    "city": org.get("city"), "country": org.get("country"),
                })
            continue

        if dry_run:
            report["bound_now"] += 1
            continue

        try:
            await upsert_topology(
                user_id=str(owner_id),
                country_code=city["country"],
                city_id=city["code"],
                travel_radius_km=radius_km,
            )
            report["bound_now"] += 1
        except ValueError:
            # CITY_CATALOGUE mismatch — should not happen because we
            # resolved from the same source. Count as skipped.
            report["skipped"] += 1
            report["by_reason"]["catalogue_drift"] = report["by_reason"].get("catalogue_drift", 0) + 1

    return report

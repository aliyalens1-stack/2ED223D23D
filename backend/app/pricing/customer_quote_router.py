"""Customer-facing pricing quote — request-level fan-out.

A `car_request` produces N `inspection_jobs` (one per city). The pricing
projection is stored per-job, but the CUSTOMER only ever thinks in terms
of the request: "what's my total for the whole booking".

This module bridges those layers:

  GET  /api/customer/requests/{request_id}/quote
       → list of projections (one per job) + aggregate customerTotal +
         worst-case manualReview flag + digest summary.

  POST /api/customer/requests/{request_id}/quote
       body: { basePrice, vehicleLocation?: {lat,lng} }
       → calculates a pricing projection for EACH job of the request,
         persists them as `pending`, returns the same shape as GET.
         Idempotent — re-running refreshes pending projections.
         Confirmed projections stay immutable (per Pricing-2 invariant).

  POST /api/customer/requests/{request_id}/quote/confirm
       → confirms ALL projections for the request in one shot, then
         stamps the request doc with a pricing snapshot. After this
         the projections are immutable.

Payment integration:
  Any payment / order code that needs a price MUST read from the
  snapshot on `car_requests.pricing` (or from the confirmed projection).
  It MUST NEVER recompute price from distance — that breaks the
  immutability invariant.
"""
from __future__ import annotations
from typing import List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, require_account_kind
from app.pricing.tiers import CURRENCY
from app.pricing.projection import (
    confirm_projection,
    get_projection,
)
from app.pricing.freeze import freeze_for_job
from app.pricing.version_registry import current_version
from app.marketplace.cities import CITY_CATALOGUE


# Reverse index: city name (lowercased) → (code, country). Built once at
# import time. Used only by the freeze path to bind a job's city name to
# the canonical CITY_CATALOGUE id so v2 density resolves city-level.
_CITY_NAME_TO_CODE: dict = {}
for _c in CITY_CATALOGUE:
    _candidates = {_c["name"].lower(), _c["code"].lower()}
    for _m in _c.get("addressMarkers") or []:
        _candidates.add(_m.lower())
    for _key in _candidates:
        # First-wins — catalogue order is the canonical priority.
        _CITY_NAME_TO_CODE.setdefault(_key, (_c["code"], _c["country"]))


def _resolve_city_id(city: str) -> tuple[Optional[str], Optional[str]]:
    if not city:
        return None, None
    return _CITY_NAME_TO_CODE.get(city.lower(), (None, None))


# Default inspection base price (EUR) — single global constant for now.
# When per-city / per-vehicle pricing arrives, this becomes a lookup.
DEFAULT_BASE_PRICE_EUR = 199.0


# ── Schemas ───────────────────────────────────────────────────────────
class GeoPoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class CityGeo(BaseModel):
    """Optional override: pin the inspector base for a specific city.
    If a city is missing from the input, we fall back to the city center
    looked up in `db.cities` (`lat`/`lng`). If even that's missing, the
    job is quoted as `distanceKm=0` → included radius."""
    city: str
    location: GeoPoint


class QuoteInput(BaseModel):
    basePrice: Optional[float] = Field(default=None, ge=0)
    vehicleLocation: Optional[GeoPoint] = None
    inspectorBases: List[CityGeo] = Field(default_factory=list)


class QuoteJobLine(BaseModel):
    jobId: str
    city: str
    projection: dict


class QuoteResponse(BaseModel):
    requestId: str
    pricingVersion: str
    currency: str
    customerTotal: float
    manualReview: bool
    status: str  # "pending" | "confirmed" | "mixed"
    digest: str
    jobs: List[QuoteJobLine]


# ── Customer router (kind-gated) ──────────────────────────────────────
quote_router = APIRouter(
    prefix="/api/customer/requests", tags=["pricing:customer_quote"],
)

_customer_required = require_account_kind("customer")
# Customer-safe view: hide inspector payout split.
_INSPECTOR_FIELDS = {"inspectorDistancePayout", "platformDistanceFee"}


def _customer_view(doc: dict) -> dict:
    return {k: v for k, v in doc.items() if k not in _INSPECTOR_FIELDS}


async def _load_request_or_404(db, request_id: str, user_id: str) -> dict:
    req = await db.car_requests.find_one({"_id": request_id})
    if not req:
        raise HTTPException(404, "Request not found")
    if req.get("userId") and req["userId"] != user_id:
        raise HTTPException(403, "Not your request")
    return req


async def _load_jobs(db, request_id: str) -> List[dict]:
    cursor = db.inspection_jobs.find({"requestId": request_id})
    return await cursor.to_list(length=200)


async def _city_center(db, city: str) -> Optional[Tuple[float, float]]:
    """Best-effort city → (lat, lng). Returns None when the city has
    no geo in the catalog."""
    if not city:
        return None
    doc = await db.cities.find_one(
        {"name": city},
        {"_id": 0, "lat": 1, "lng": 1, "latitude": 1, "longitude": 1, "geo": 1},
    )
    if not doc:
        return None
    lat = doc.get("lat") or doc.get("latitude") or (doc.get("geo") or {}).get("lat")
    lng = doc.get("lng") or doc.get("longitude") or (doc.get("geo") or {}).get("lng")
    if lat is None or lng is None:
        return None
    return (float(lat), float(lng))


def _aggregate(projections: List[dict], request_id: str) -> dict:
    total = round(sum(p.get("customerTotal", 0) for p in projections), 2)
    manual = any(p.get("manualReview") for p in projections)
    statuses = {p.get("status") for p in projections}
    if statuses == {"confirmed"}:
        status = "confirmed"
    elif statuses == {"pending"}:
        status = "pending"
    elif not statuses:
        status = "pending"
    else:
        status = "mixed"
    # Digest of digests: "Berlin: 80 km · included • Munich: 504 km · far_remote · +€243"
    digest = " • ".join(
        f"{p.get('_city', '?')}: {p.get('digest', '')}" for p in projections
    ) or "—"
    return {
        "requestId": request_id,
        "pricingVersion": current_version(),
        "currency": projections[0].get("currency", CURRENCY) if projections else CURRENCY,
        "customerTotal": total,
        "manualReview": manual,
        "status": status,
        "digest": digest,
    }


@quote_router.post("/{request_id}/quote")
async def create_or_refresh_quote(
    request_id: str,
    payload: QuoteInput,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
) -> dict:
    """Compute (or refresh) the pricing projection for every job of the
    request. Returns the customer view (no payout split).
    """
    db = get_db()
    await _load_request_or_404(db, request_id, ctx_.user_id)
    jobs = await _load_jobs(db, request_id)
    if not jobs:
        raise HTTPException(409, "Request has no jobs to price")

    base_price = float(payload.basePrice if payload.basePrice is not None else DEFAULT_BASE_PRICE_EUR)
    vehicle_loc: Optional[Tuple[float, float]] = (
        (payload.vehicleLocation.lat, payload.vehicleLocation.lng)
        if payload.vehicleLocation else None
    )
    # Geo-2: client-supplied `inspectorBases` is deprecated. Kept as legacy
    # fallback during the migration window. Canonical source is
    # `provider_topology` (resolved per-job) OR `_city_center()` from
    # CITY_CATALOGUE — both backend-authoritative.
    legacy_city_to_base = {
        cg.city: (cg.location.lat, cg.location.lng) for cg in payload.inspectorBases
    }

    job_lines: List[dict] = []
    for job in jobs:
        job_id = str(job["_id"])
        city = job.get("city", "")

        # Resolution priority (Geo-2 invariant: backend resolves coords):
        # 1. provider_topology for the inspector assigned to this job
        # 2. canonical city centre (CITY_CATALOGUE / db.cities)
        # 3. legacy client payload (deprecated, kept for migration)
        inspector_base: Optional[Tuple[float, float]] = None
        assignee_id = job.get("assignedInspectorId") or job.get("inspectorId")
        if assignee_id:
            topo = await db.provider_topology.find_one(
                {"userId": str(assignee_id)},
                {"_id": 0, "baseLat": 1, "baseLng": 1},
            )
            if topo and topo.get("baseLat") is not None and topo.get("baseLng") is not None:
                inspector_base = (float(topo["baseLat"]), float(topo["baseLng"]))

        if inspector_base is None:
            inspector_base = await _city_center(db, city)

        if inspector_base is None and city in legacy_city_to_base:
            inspector_base = legacy_city_to_base[city]

        # Pricing-v2B: route through version-aware freeze. v2 needs the
        # inspection LOCATION's cityId (where the vehicle is, not where
        # the inspector is based) to resolve density. v1 ignores it.
        city_id, country_code = _resolve_city_id(city)
        saved = await freeze_for_job(
            db,
            job_id=job_id,
            base_price=base_price,
            inspector_base=inspector_base,
            vehicle_location=vehicle_loc,
            city_id=city_id,
            country_code=country_code,
        )
        # Attach city locally for digest assembly. Stripped from the
        # persisted doc — it's a presentation concern.
        saved_view = _customer_view(saved)
        saved_view["_city"] = city
        job_lines.append({"jobId": job_id, "city": city, "projection": saved_view})

    agg = _aggregate([line["projection"] for line in job_lines], request_id)
    return {**agg, "jobs": job_lines}


@quote_router.get("/{request_id}/quote")
async def get_quote(
    request_id: str,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
) -> dict:
    """Read the customer's request-level quote (aggregate over all jobs).

    404 if the request has no projection yet — call POST first.
    """
    db = get_db()
    await _load_request_or_404(db, request_id, ctx_.user_id)
    jobs = await _load_jobs(db, request_id)
    job_lines: List[dict] = []
    for job in jobs:
        proj = await get_projection(db, job_id=str(job["_id"]))
        if proj is None:
            continue
        view = _customer_view(proj)
        view["_city"] = job.get("city", "")
        job_lines.append({"jobId": str(job["_id"]), "city": job.get("city", ""), "projection": view})
    if not job_lines:
        raise HTTPException(404, "No projection for this request — POST /quote first")
    agg = _aggregate([line["projection"] for line in job_lines], request_id)
    return {**agg, "jobs": job_lines}


@quote_router.post("/{request_id}/quote/confirm")
async def confirm_quote(
    request_id: str,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
) -> dict:
    """Customer accepts the quote — confirms every job's projection
    atomically (best-effort: per-job idempotent confirm).

    After confirmation:
      • All projections become immutable.
      • The request doc gets a snapshot under `pricing`:
        {
          pricingVersion, currency, customerTotal, manualReview,
          digest, confirmedAt, jobs: [{jobId, city, customerTotal}]
        }
      • Payment code reads from this snapshot. NEVER recomputes.
    """
    db = get_db()
    await _load_request_or_404(db, request_id, ctx_.user_id)
    jobs = await _load_jobs(db, request_id)

    confirmed_lines: List[dict] = []
    for job in jobs:
        job_id = str(job["_id"])
        confirmed = await confirm_projection(db, job_id=job_id, by_user_id=ctx_.user_id)
        if confirmed is None:
            raise HTTPException(
                409,
                f"Job {job_id} has no projection yet — call POST /quote first.",
            )
        view = _customer_view(confirmed)
        view["_city"] = job.get("city", "")
        confirmed_lines.append({"jobId": job_id, "city": job.get("city", ""), "projection": view})

    agg = _aggregate([line["projection"] for line in confirmed_lines], request_id)

    # Snapshot back onto the request — this is what payments read.
    # Pricing-v2B: snapshot now includes per-job `densitySnapshot` AND
    # the frozen `explanation` array. Future copy / multiplier changes
    # MUST NOT mutate historical quote semantics — same principle as
    # customer-grammar checksums.
    snapshot = {
        "pricingVersion": agg["pricingVersion"],
        "currency": agg["currency"],
        "customerTotal": agg["customerTotal"],
        "manualReview": agg["manualReview"],
        "digest": agg["digest"],
        "confirmedAt": confirmed_lines[0]["projection"].get("confirmedAt"),
        "jobs": [
            {
                "jobId": line["jobId"],
                "city": line["city"],
                "customerTotal": line["projection"].get("customerTotal", 0),
                "digest": line["projection"].get("digest", ""),
                # v2-only — older v1 docs simply lack these and the
                # snapshot reflects that. Payments code never reads them.
                "densitySnapshot": line["projection"].get("densitySnapshot"),
                "explanation": line["projection"].get("explanation"),
            }
            for line in confirmed_lines
        ],
    }
    await db.car_requests.update_one(
        {"_id": request_id},
        {"$set": {"pricing": snapshot}},
    )

    return {**agg, "jobs": confirmed_lines}


__all__ = ["quote_router"]

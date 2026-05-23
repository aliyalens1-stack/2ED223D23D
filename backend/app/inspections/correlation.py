"""app.inspections.correlation — Listing ↔ OCR cross-check.

Purpose: produce **signals**, not penalties. This is the first cross-data-
source correlation layer in the inspection stack. It compares facts the
*customer/listing* told us about a vehicle against facts the *OCR* read
off the physical car, against facts the *VIN* itself encodes.

Architecture invariants (per OCR-1 / forensic firewall doctrine):
  • Signals are admin-only. Inspector and customer surfaces never see them.
  • Signals never auto-block, auto-penalize, auto-flag items, or modify
    `item.status`. They are pure observations.
  • Failure is silent — if listing data is missing, we just emit fewer
    signals (or none). Never raise.
  • Persistence is on a dedicated `inspection_correlations` collection
    (admin-only read path) plus `correlation.signal_raised` timeline
    events that the existing admin forensics rail naturally consumes.

Source axes:
  Listing (claim)       — what the customer/marketplace says
  OCR (evidence)        — what the photograph says
  VIN-decode (derived)  — what the 17-char VIN structurally implies

Signals (initial taxonomy):
  correlation.vin_mismatch         listing.vin ≠ ocr.vin
  correlation.mileage_divergence   |listing.mileageKm − ocr.mileageKm| / listing > threshold
  correlation.year_mismatch        vin_decode.modelYear ∉ [listing.yearFrom-1, yearTo+1]
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from ..parsers.vin import decode_vin

logger = logging.getLogger(__name__)

# Severity scale used by the admin forensics rail. Deliberately a separate
# vocabulary from the inspector's `critical/warning` axis so the surfaces
# never accidentally share language.
SEVERITY_INFO = "info"
SEVERITY_WARN = "warn"
SEVERITY_HIGH = "high"

# A 5% absolute drift between listing-claimed and OCR-read odometer is the
# point where the divergence stops being "rounding / different reading days"
# and becomes worth a forensic look.
MILEAGE_DIVERGENCE_PCT_WARN = 0.05
MILEAGE_DIVERGENCE_PCT_HIGH = 0.15


async def _resolve_listing_view(db, job: dict) -> dict:
    """Pull whatever listing-side facts we can find for this job.

    Returns a flat dict (always — never None) with possibly-None values:
        {
          "vin":        Optional[str],
          "mileageKm":  Optional[int],
          "yearFrom":   Optional[int],
          "yearTo":     Optional[int],
          "source":     str,   # "car_request" | "listing_claim" | "vehicles" | "merged" | "none"
        }
    """
    view: dict = {"vin": None, "mileageKm": None, "yearFrom": None, "yearTo": None, "source": "none"}
    sources_used: list[str] = []

    # 1. inspection_jobs.listingClaim — explicit per-job claim (preferred when present)
    claim = job.get("listingClaim") or {}
    if claim:
        if claim.get("vin"):       view["vin"] = str(claim["vin"]).upper()
        if claim.get("mileageKm") is not None: view["mileageKm"] = int(claim["mileageKm"])
        if claim.get("year") is not None:
            view["yearFrom"] = view["yearTo"] = int(claim["year"])
        sources_used.append("listing_claim")

    # 2. car_requests — has yearFrom/yearTo, brand, model (no VIN by default)
    req_id = job.get("requestId")
    if req_id:
        cr = await db.car_requests.find_one(
            {"id": req_id},
            {"_id": 0, "yearFrom": 1, "yearTo": 1, "brand": 1, "model": 1},
        )
        if cr:
            if view["yearFrom"] is None and cr.get("yearFrom") is not None:
                view["yearFrom"] = int(cr["yearFrom"])
            if view["yearTo"] is None and cr.get("yearTo") is not None:
                view["yearTo"] = int(cr["yearTo"])
            sources_used.append("car_request")

    # 3. vehicles collection — only if explicitly linked via vehicleId on the job
    vehicle_id = job.get("vehicleId")
    if vehicle_id:
        veh = await db.vehicles.find_one(
            {"id": vehicle_id},
            {"_id": 0, "vin": 1, "mileage": 1, "year": 1},
        )
        if veh:
            if view["vin"] is None and veh.get("vin"):
                view["vin"] = str(veh["vin"]).upper()
            if view["mileageKm"] is None and veh.get("mileage") is not None:
                view["mileageKm"] = int(veh["mileage"])
            if view["yearFrom"] is None and veh.get("year") is not None:
                view["yearFrom"] = view["yearTo"] = int(veh["year"])
            sources_used.append("vehicles")

    if len(sources_used) == 1:
        view["source"] = sources_used[0]
    elif len(sources_used) > 1:
        view["source"] = "merged"
    view["_sources"] = sources_used
    return view


def _signal_vin(listing_vin: Optional[str], ocr_vin: Optional[str]) -> Optional[dict]:
    if not (listing_vin and ocr_vin):
        return None
    a = listing_vin.upper().replace(" ", "").replace("-", "")
    b = ocr_vin.upper().replace(" ", "").replace("-", "")
    if a == b:
        return None
    # Count character-position differences for severity calibration
    if len(a) == 17 and len(b) == 17:
        diff = sum(1 for x, y in zip(a, b) if x != y)
        sev = SEVERITY_HIGH if diff >= 3 else SEVERITY_WARN
    else:
        sev = SEVERITY_HIGH  # length-mismatch = serious
        diff = abs(len(a) - len(b))
    return {
        "kind": "correlation.vin_mismatch",
        "severity": sev,
        "sources": {"listing": "listing", "evidence": "ocr"},
        "values": {"listing": a, "evidence": b, "charDiff": diff},
        "summary": f"Listing VIN {a} differs from OCR VIN {b} ({diff} char{'s' if diff!=1 else ''})",
    }


def _signal_mileage(listing_km: Optional[int], ocr_km: Optional[int]) -> Optional[dict]:
    if listing_km is None or ocr_km is None:
        return None
    listing_km = int(listing_km)
    ocr_km = int(ocr_km)
    if listing_km <= 0:
        return None
    delta = ocr_km - listing_km
    pct = abs(delta) / listing_km
    if pct < MILEAGE_DIVERGENCE_PCT_WARN:
        return None
    if pct >= MILEAGE_DIVERGENCE_PCT_HIGH:
        sev = SEVERITY_HIGH
    else:
        sev = SEVERITY_WARN
    direction = "higher" if delta > 0 else "lower"
    return {
        "kind": "correlation.mileage_divergence",
        "severity": sev,
        "sources": {"listing": "listing", "evidence": "ocr"},
        "values": {
            "listingKm": listing_km, "ocrKm": ocr_km,
            "deltaKm": delta, "pct": round(pct, 4),
        },
        "summary": (
            f"OCR mileage {ocr_km:,} km is {direction} than listing-claimed "
            f"{listing_km:,} km by {abs(delta):,} km ({pct*100:.1f}%)"
        ),
    }


def _signal_year(decoded_year: Optional[int], year_from: Optional[int], year_to: Optional[int]) -> Optional[dict]:
    if decoded_year is None or (year_from is None and year_to is None):
        return None
    lo = year_from if year_from is not None else year_to
    hi = year_to if year_to is not None else year_from
    # Generous ±1 tolerance — VIN year can differ from registration year by
    # one model-year cycle without being suspicious.
    if (lo - 1) <= decoded_year <= (hi + 1):
        return None
    drift = min(abs(decoded_year - lo), abs(decoded_year - hi))
    sev = SEVERITY_HIGH if drift >= 3 else SEVERITY_WARN
    return {
        "kind": "correlation.year_mismatch",
        "severity": sev,
        "sources": {"listing": "listing", "evidence": "vin_decode"},
        "values": {
            "vinModelYear": decoded_year,
            "listingYearFrom": year_from, "listingYearTo": year_to,
            "drift": drift,
        },
        "summary": (
            f"VIN-decoded model year {decoded_year} is {drift} year(s) outside "
            f"listing range {year_from}-{year_to}"
        ),
    }


async def compute_correlations(db, job_id: str) -> dict:
    """Compute all listing↔evidence signals for a job. Pure read function.

    Returns:
      {
        "jobId": str,
        "computedAt": ISO,
        "listing": { vin, mileageKm, yearFrom, yearTo, source, _sources },
        "evidence": { vin, mileageKm, vinDecode },
        "signals": [ { kind, severity, sources, values, summary }, ... ],
      }
    """
    now = datetime.now(timezone.utc).isoformat()

    job = await db.inspection_jobs.find_one({"_id": job_id}) or \
          await db.inspection_jobs.find_one({"id": job_id})
    if not job:
        return {"jobId": job_id, "computedAt": now, "listing": None,
                "evidence": None, "signals": [], "error": "job_not_found"}

    report = await db.inspection_reports_v2.find_one(
        {"jobId": job_id},
        {"_id": 0, "extractedVin": 1, "extractedMileageKm": 1},
    ) or {}

    listing = await _resolve_listing_view(db, job)

    ocr_vin = report.get("extractedVin")
    ocr_km = report.get("extractedMileageKm")
    vin_decode = None
    if ocr_vin:
        try:
            vin_decode = decode_vin(ocr_vin)
        except Exception as exc:
            logger.warning(f"[correlation] decode_vin failed for {ocr_vin}: {exc}")

    evidence = {
        "vin": ocr_vin, "mileageKm": ocr_km,
        "vinDecode": vin_decode,
    }

    signals: list[dict] = []
    s = _signal_vin(listing.get("vin"), ocr_vin)
    if s: signals.append(s)
    s = _signal_mileage(listing.get("mileageKm"), ocr_km)
    if s: signals.append(s)
    s = _signal_year(
        vin_decode.get("modelYear") if vin_decode else None,
        listing.get("yearFrom"), listing.get("yearTo"),
    )
    if s: signals.append(s)

    return {
        "jobId": job_id,
        "computedAt": now,
        "listing": listing,
        "evidence": evidence,
        "signals": signals,
    }


async def persist_and_emit(db, job_id: str, actor_id: Optional[str] = None) -> dict:
    """Compute, snapshot, and emit timeline events. Idempotent per `(job, kind)`
    pair — we always overwrite the prior snapshot rather than spawning N
    entries per recompute. Timeline events fire only when a *new* signal
    appears or an existing one changes severity, to keep the admin rail
    from drowning in repetition.
    """
    result = await compute_correlations(db, job_id)
    if result.get("error"):
        return result

    now = result["computedAt"]
    snapshot = {
        "jobId": job_id,
        "computedAt": now,
        "listing": result["listing"],
        "evidence": result["evidence"],
        "signals": result["signals"],
        "updatedAt": now,
    }

    prior = await db.inspection_correlations.find_one({"jobId": job_id}) or {}
    prior_signals = {s["kind"]: s for s in (prior.get("signals") or [])}

    await db.inspection_correlations.update_one(
        {"jobId": job_id},
        {"$set": snapshot, "$setOnInsert": {"createdAt": now}},
        upsert=True,
    )

    # Emit one timeline event per *new or escalated* signal. Same-kind, same-
    # severity recomputes are silent.
    from .timeline import emit_event
    for sig in result["signals"]:
        prev = prior_signals.get(sig["kind"])
        if prev and prev.get("severity") == sig["severity"]:
            continue  # unchanged — do not re-emit
        try:
            await emit_event(
                db, job_id=job_id, event_type="correlation.signal_raised",
                actor_id=actor_id,
                payload={
                    "kind": sig["kind"],
                    "severity": sig["severity"],
                    "summary": sig["summary"],
                    "values": sig["values"],
                    "previousSeverity": (prev or {}).get("severity"),
                },
            )
        except Exception as exc:
            logger.warning(f"[correlation] emit_event failed: {exc}")

    return result

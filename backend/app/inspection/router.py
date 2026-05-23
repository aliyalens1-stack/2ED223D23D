"""app.inspection.router — POST /api/inspection/report/generate (B1)."""
from __future__ import annotations
from typing import Optional
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.parsers.universal import parse_listing
from app.parsers.mobile_de import estimate_market_avg
from app.parsers.contract import from_legacy
from app.inspection.report import build_report
from app.inspection.baselines import get_baseline

logger = logging.getLogger("inspection.router")
router = APIRouter(prefix="/api/inspection", tags=["inspection"])


class ReportRequest(BaseModel):
    # либо url (парсим на месте), либо manual (user fills in missing data)
    url: Optional[str] = Field(None, max_length=2048)
    price: Optional[int] = Field(None, ge=0, le=10_000_000)
    mileage: Optional[int] = Field(None, ge=0, le=2_000_000)
    year: Optional[int] = Field(None, ge=1950, le=2030)
    fuel: Optional[str] = Field(None, max_length=32)
    make: Optional[str] = Field(None, max_length=64)
    model: Optional[str] = Field(None, max_length=128)
    title: Optional[str] = Field(None, max_length=256)


@router.post("/report/generate")
async def generate_report(payload: ReportRequest, request: Request):
    """Generate inspection report from either a mobile.de URL or manual fields.

    Priority: explicit fields in payload override parsed values.
    """
    if not payload.url and not any([payload.price, payload.mileage, payload.year]):
        raise HTTPException(status_code=422, detail={
            "error": True, "code": "VALIDATION_ERROR",
            "message": "Provide either 'url' or at least one of price/mileage/year",
        })

    data: dict = {}
    parse_meta: dict = {"parsed": None, "error": None, "source": None}
    # Step 11D-α — additive publication. Top-level `canonical` carries
    # the full `ListingParseResult` Pydantic dump when a URL was parsed,
    # `None` for the manual-only mode (no parser was run). Surfaces
    # (Expo `inspection-preview.tsx`, Web `InspectPage.tsx`) migrate
    # off `data.car.*` legacy mirror in 11D-β. Legacy mirror stays in
    # response until 11D-γ — never mix migration and deletion.
    canonical_envelope: Optional[dict] = None

    if payload.url:
        try:
            # Step 10B Pass 2 — fix audit E.3.
            # Previously this endpoint called `parse_mobile_de` directly,
            # so autoscout24 / kleinanzeigen / etc. URLs all returned
            # `error="unsupported_source"` even though the dispatcher
            # would have produced a usable payload. Route through the
            # universal dispatcher and the canonical adapter to get one
            # uniform failure model.
            parsed = await parse_listing(payload.url)
            canonical = from_legacy(parsed)
            data.update({k: parsed.get(k) for k in
                         ("title", "make", "model", "price", "mileage", "year",
                          "fuel", "currency", "image", "marketAvg", "source",
                          "sourceUrl", "listingId")})
            parse_meta = {
                "parsed":             bool(parsed.get("parsed")),
                "error":              parsed.get("error"),
                "source":             parsed.get("source"),
                # Canonical envelope so callers can read parse quality
                # without re-implementing the rules.
                "parseCompleteness":  canonical.parseCompleteness,
                "degradedReason":     canonical.degradedReason,
                "ok":                 canonical.ok,
            }
            # Step 11D-α — publish the full canonical dump alongside
            # parseMeta. Same shape as `/api/parse/car-link` and
            # `/api/vehicles/ingest` so all three substrate entry
            # points speak one wire-level contract.
            canonical_envelope = canonical.model_dump()
        except Exception:
            logger.exception("parse_listing failed inside /report/generate")
            parse_meta = {
                "parsed": False, "error": "parse_exception", "source": None,
                "parseCompleteness": "weak", "degradedReason": "parse_error", "ok": False,
            }
            # 11D-α — emit a synthetic canonical envelope for the
            # exception path so surfaces never have to fall back to
            # the legacy mirror when canonical-only consumption lands
            # in 11D-β. `source` is intentionally "unknown" not
            # `null` because the model requires it; `sourceUrl` keeps
            # the user-provided URL so the surface can still render
            # the "✓ Link accepted" line.
            canonical_envelope = {
                "ok": False,
                "source": "unknown",
                "sourceUrl": payload.url,
                "externalId": None,
                "title": None,
                "make": None,
                "model": None,
                "year": None,
                "priceEur": None,
                "mileageKm": None,
                "location": None,
                "vin": None,
                "fuel": None,
                "transmission": None,
                "sellerType": None,
                "images": [],
                "parseCompleteness": "weak",
                "degradedReason": "parse_error",
            }

    # manual overrides
    for fld in ("title", "make", "model", "price", "mileage", "year", "fuel"):
        v = getattr(payload, fld)
        if v is not None:
            data[fld] = v

    # Berlin Launch B1.1 — prefer model-aware baseline over coarse year-only
    model_avg, _key = get_baseline(data.get("make"), data.get("model"), data.get("year"))
    if model_avg:
        data["marketAvg"] = model_avg
    elif not data.get("marketAvg"):
        data["marketAvg"] = estimate_market_avg(data.get("year"))

    report = build_report(data)

    return {
        "report": report,
        # Step 11D-γ — legacy `car.*` mirror removed. ONLY `marketAvg`
        # remains because it is NOT a parser substrate field — it's a
        # downstream `build_report` baseline produced from MakeModel/
        # year heuristics. Surfaces read every parser-extracted vehicle
        # attribute from `canonical.*` instead (Sprint 11D-β surface
        # migration; 11D-β2 closed the freeze gate).
        "car": {
            "marketAvg": data.get("marketAvg"),
        },
        "parseMeta": parse_meta,
        # Step 11D-α — full canonical envelope (Pydantic dump of
        # `ListingParseResult`) — sole parser-substrate publication.
        # `None` when the request used manual fields only (no URL,
        # no parser invocation).
        "canonical": canonical_envelope,
        "pricing": {
            "inspectionFee": 149,
            "currency": "EUR",
            "deliveryHours": 24,
        },
    }

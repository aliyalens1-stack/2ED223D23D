"""app.vehicles.ingest — Listing → Vehicle pipeline.

The single critical move that makes the platform self-populating:

    URL → parse → (vehicle exists? match : create) → seed memory event → return id

Idempotency guarantee:
    POST /api/vehicles/ingest with the same `url` (or same source+listingId)
    will return the SAME vehicleId every time. Memory timeline is NOT
    duplicated — repeat calls add at most a `viewed` event capped to one
    per 24h.

Hard rules:
  - No auth required (the public marketplace ingest path).
  - Public vehicles get `customerId = "public"` so they are visible via
    /vehicle/:id but not in any /account/garage list.
  - Anti-bot soft-fail is propagated: if parsing didn't recognize the
    listing we still return 200 with `recognized=false` and a hint, but
    we do NOT create a vehicle from a hard-fail URL.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.db import db
from app.parsers.universal import parse_listing
from app.parsers.contract import from_legacy, classify_failure_mode, ListingParseResult
from app.parsers.vin import decode_vin


logger = logging.getLogger("vehicles.ingest")
router = APIRouter(prefix="/api/vehicles", tags=["vehicles-ingest"])


# ─────────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────────

class IngestRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)
    vin: Optional[str] = Field(default=None, max_length=24)
    # Optional override — when admin batch-imports, they may want to
    # attribute the vehicle to a known customer up-front.
    customerId: Optional[str] = Field(default=None, max_length=64)


class DecodeVinRequest(BaseModel):
    vin: str = Field(..., min_length=11, max_length=24)


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _stable_id_from_listing(source: str, listing_id: Optional[str], url: str) -> str:
    """Stable vehicle id derived from listing identity.

    Prefers source + listingId (true uniqueness). Falls back to a hash
    of the URL when the listing id was not extracted (still stable
    across calls).
    """
    if source and listing_id:
        h = hashlib.sha1(f"{source}:{listing_id}".encode("utf-8")).hexdigest()[:14]
        return f"vehicle_{source.replace('.', '_')}_{h}"
    h = hashlib.sha1(url.encode("utf-8")).hexdigest()[:18]
    return f"vehicle_url_{h}"


def _normalize_fuel(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    t = raw.strip().lower()
    if "diesel" in t:
        return "Дизель"
    if "petrol" in t or "benzin" in t or "gasoline" in t:
        return "Бензин"
    if "hybrid" in t:
        return "Гибрид"
    if "elektro" in t or "electric" in t or t in ("ev", "bev"):
        return "Электро"
    return raw[:32]


# ─────────────────────────────────────────────────────────────────────
# Step 10B Pass 2 — canonical-driven ingest classification.
#
# Replaces a local hard/soft fail heuristic that used to live in
# `ingest_listing`. The single source of truth is now the canonical
# adapter — `ListingParseResult.degradedReason` decides the bucket.
# ─────────────────────────────────────────────────────────────────────

def _classify_ingest(canonical: ListingParseResult) -> tuple[bool, bool, bool]:
    """Return (recognized, soft_fail, hard_fail) from a canonical result.

    Rules (mirrors the audit D.1/D.2 spec):
      - hard:  bad_url, unsupported_domain, not_a_listing
               (also: source unrecognised AND completeness=weak)
      - soft:  antibot, expired_listing, http_4xx/5xx, timeout, network,
               fetch_failed, low_extraction_confidence, parse_error
      - recognized = canonical.ok (strong or partial extraction)

    Note: `expired_listing` is *soft* — the link is structurally fine,
    the inspector can still be useful (e.g. checking screenshots from
    the cache or contacting the seller through the platform).
    """
    failure = classify_failure_mode(
        canonical.degradedReason,
        source_recognised=canonical.source not in (None, "", "generic", "unknown"),
    )
    return (canonical.ok, failure == "soft", failure == "hard")


# ─────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────

@router.post("/decode-vin")
async def decode_vin_endpoint(payload: DecodeVinRequest):
    """Pure VIN decoder — no DB writes. Useful for client-side previews."""
    return decode_vin(payload.vin)


@router.post("/ingest")
async def ingest_listing(payload: IngestRequest):
    """Listing URL → persistent vehicle.

    Returns:
        {
          "status": "matched" | "created" | "soft_fail",
          "vehicleId": "vehicle_…",
          "vehicle": {…public-safe view…},
          "memoryUrl": "/vehicle/<id>",
          "recognized": bool,
          "softFail": bool,
          "vin": {…decoded…} | null,
        }
    """
    url = payload.url.strip()
    if not url.lower().startswith(("http://", "https://")):
        url = "https://" + url

    # 1) Parse the listing (delegates to existing universal parser).
    parsed = await parse_listing(url)
    source = parsed.get("source")
    listing_id = parsed.get("listingId")
    err = parsed.get("error")

    # Step 10B Pass 2 — canonical-driven classification (single source
    # of truth, replaces the local heuristic). Audit Pass-2 closure.
    canonical = from_legacy(parsed)
    recognized, soft_fail, hard_fail = _classify_ingest(canonical)

    # 2) Hard-fail (unsupported domain / bad url / not_a_listing)
    #    → don't create a vehicle.
    # Step 11D-γ — top-level legacy mirror removed (recognized,
    # softFail, hardFail, error, hint, plus ok/degradedReason/
    # parseCompleteness flat copies). Surfaces read everything from
    # `canonical.*` via shared classifiers (`hasPreviewSignal`,
    # `classifyParseFailure`) — verified zero live legacy reads by
    # the 7 grep gates in Sprint 11D-β2.
    if hard_fail:
        return {
            "status": "soft_fail",
            "vehicleId": None,
            "vehicle": None,
            "memoryUrl": None,
            "canonical": canonical.model_dump(),
        }

    # 3) Decode VIN if provided (or extracted by parser later).
    vin_data = None
    vin_raw = (payload.vin or parsed.get("vin") or "").strip().upper()
    if vin_raw:
        vin_data = decode_vin(vin_raw)

    # 4) Idempotency: lookup existing vehicle by listing identity, then by
    #    listing_url verbatim.
    existing = None
    if source and listing_id:
        existing = await db.vehicles.find_one(
            {"source": source, "external_source_id": listing_id},
            {"_id": 0},
        )
    if not existing:
        existing = await db.vehicles.find_one({"listing_url": url}, {"_id": 0})

    now = datetime.now(timezone.utc)

    if existing:
        # Repeat ingest → optionally emit a `viewed` event (rate-limited
        # to one per 24h to avoid spamming the timeline).
        last_viewed = None
        for ev in (existing.get("activity") or []):
            if ev.get("type") == "viewed":
                at = ev.get("at")
                if isinstance(at, str):
                    try: at = datetime.fromisoformat(at.replace("Z", "+00:00"))
                    except Exception: at = None
                if at and (last_viewed is None or at > last_viewed):
                    last_viewed = at

        emit_view = last_viewed is None or (now - (last_viewed if last_viewed.tzinfo else last_viewed.replace(tzinfo=timezone.utc))) > timedelta(hours=24)
        if emit_view:
            await db.vehicles.update_one(
                {"id": existing["id"]},
                {
                    "$push": {"activity": {
                        "type": "viewed",
                        "at": now,
                        "title": "Карточку открыли снова",
                        "text": "Кто-то снова открыл память автомобиля",
                    }},
                    "$set": {"updatedAt": now},
                    "$inc": {"viewCount": 1},
                },
            )
        await _log_ingest(url, source, "matched", existing["id"])
        return {
            "status": "matched",
            "vehicleId": existing["id"],
            "vehicle": _public_vehicle_view(existing),
            "memoryUrl": f"/vehicle/{existing['id']}",
            # Step 11D-γ — canonical envelope is the only parser
            # representation on the wire now. Surfaces read `ok`,
            # `degradedReason`, `parseCompleteness` from `canonical`
            # directly via shared classifier.
            "canonical": canonical.model_dump(),
            "vin": vin_data,
        }

    # 5) Create a new vehicle from the parsed data.
    vehicle_id = _stable_id_from_listing(source or "generic", listing_id, url)

    brand = parsed.get("make") or parsed.get("brand") or "Auto"
    model = parsed.get("model") or "—"
    year = parsed.get("year")
    if not year and vin_data and vin_data.get("modelYear"):
        year = vin_data["modelYear"]

    seed_event = {
        "type": "imported",
        "at": now,
        "title": f"Привезли с {source or 'площадки'}" if source else "Импорт",
        "text": (parsed.get("title") or url)[:280],
        "mileage": parsed.get("mileage"),
    }
    if soft_fail:
        seed_event["text"] = (
            "Площадка временно блокирует автоматический парсинг. "
            "Карточка сохранена, инспектор откроет ссылку вручную."
        )

    doc = {
        "id": vehicle_id,
        "customerId": payload.customerId or "public",
        "brand": brand,
        "model": model,
        "year": year,
        "mileage": parsed.get("mileage"),
        "price": parsed.get("price"),
        "currency": (parsed.get("currency") or "EUR").upper(),
        "fuel": _normalize_fuel(parsed.get("fuel")),
        "thumbnail": parsed.get("image"),
        "gallery": [parsed.get("image")] if parsed.get("image") else [],
        "listing_url": url,
        "external_source_id": listing_id,
        "source": source or "manual",
        "importedFrom": (parsed.get("title") or source or "URL")[:120],
        "importedOn": now,
        "status": "imported" if recognized else "imported_soft",
        "viewCount": 1,
        "activity": [seed_event],
        "documents": [],
        "createdAt": now,
        "updatedAt": now,
    }
    if vin_data and vin_data.get("valid"):
        doc["vin"] = vin_data["vin"]
        doc["vinDecoded"] = {
            "country": vin_data.get("country"),
            "manufacturer": vin_data.get("manufacturer"),
            "modelYear": vin_data.get("modelYear"),
            "wmi": vin_data.get("wmi"),
        }
        doc["registeredCountry"] = vin_data.get("country")

    await db.vehicles.insert_one(dict(doc))
    await _log_ingest(url, source, "created", vehicle_id)

    # Market subscriptions fanout — one ingest can satisfy N saved searches.
    # The 1→N multiplier that turns ingest into a market sensing primitive.
    try:
        from app.vehicles.market_searches import fanout_new_vehicle
        await fanout_new_vehicle(doc)
    except Exception as e:
        logger.warning(f"market match fanout for new vehicle {vehicle_id} failed: {e}")

    return {
        "status": "created",
        "vehicleId": vehicle_id,
        "vehicle": _public_vehicle_view(doc),
        "memoryUrl": f"/vehicle/{vehicle_id}",
        # Step 11D-γ — canonical envelope is the sole parser
        # representation on the wire (legacy recognized/softFail/
        # hardFail/ok/degradedReason/parseCompleteness removed).
        "canonical": canonical.model_dump(),
        "vin": vin_data,
    }


def _public_vehicle_view(doc: dict) -> dict:
    """Compact preview returned to the caller (full data lives at /memory)."""
    return {
        "id": doc.get("id"),
        "brand": doc.get("brand"),
        "model": doc.get("model"),
        "year": doc.get("year"),
        "mileage": doc.get("mileage"),
        "price": doc.get("price"),
        "currency": doc.get("currency"),
        "thumbnail": doc.get("thumbnail"),
        "source": doc.get("source"),
    }


async def _log_ingest(url: str, source: Optional[str], status: str, vehicle_id: Optional[str]) -> None:
    try:
        await db.ingest_audit.insert_one({
            "url": url,
            "source": source,
            "status": status,
            "vehicleId": vehicle_id,
            "at": datetime.now(timezone.utc),
        })
    except Exception:
        # Audit is best-effort; never block the ingest on logging failure.
        pass

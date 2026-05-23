"""app.parsers.router — public endpoint POST /api/parse/car-link.

Принимает URL объявления (mobile.de), возвращает структурированные данные.
Stateless, без auth (нужен и анонимам перед заказом проверки).

Лёгкий rate-limit: дополнительная защита поверх глобального rate-limit middleware.
"""
from __future__ import annotations
import time
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.parsers.universal import parse_listing
from app.parsers.contract import from_legacy

logger = logging.getLogger("parsers.router")

router = APIRouter(prefix="/api/parse", tags=["parsers"])


class CarLinkRequest(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)


# in-memory rate limit (по IP, 20 запросов / 60 сек на парсер)
_rate_state: dict[str, list[float]] = {}
_RATE_LIMIT = 20
_RATE_WINDOW = 60.0


def _ip_throttle(ip: str) -> bool:
    now = time.time()
    bucket = _rate_state.setdefault(ip, [])
    # cleanup
    cutoff = now - _RATE_WINDOW
    while bucket and bucket[0] < cutoff:
        bucket.pop(0)
    if len(bucket) >= _RATE_LIMIT:
        return False
    bucket.append(now)
    return True


@router.post("/car-link")
async def parse_car_link(payload: CarLinkRequest, request: Request):
    """Parse external car listing URL → canonical preview envelope.

    Phase C.1 — Link Intelligence Core.
    Step 11D-γ — legacy top-level mirror removed. The response now
    publishes ONE canonical envelope and nothing else parser-related.

    ```
    {
      "canonical": {
        "ok": true|false,
        "source": "mobile.de|autoscout24|...|null",
        "sourceUrl": "...",
        "externalId": "...|null",
        "title": "BMW X5 xDrive30d" | null,
        "make": "BMW" | null,  "model": "X5" | null,  "year": 2019 | null,
        "priceEur": 24900 | null,  "mileageKm": 148000 | null,
        "location": null,  "vin": null,
        "fuel": "diesel" | null,  "transmission": null,  "sellerType": null,
        "images": ["https://..."],
        "parseCompleteness": "strong" | "partial" | "weak",
        "degradedReason": "antibot|http_4xx|...|null"
      }
    }
    ```
    Soft-fail UX rule: NEVER show "broken link" — show "✓ Link accepted,
    inspector will open it". Surfaces read this from
    `hasPreviewSignal(canonical)` + `classifyParseFailure(canonical.degradedReason)`
    in `@platform/domain/parsers/canonical`. No surface reads any
    field outside `canonical` anymore (verified by grep gates 1-7
    in Sprint 11D-β2).
    """
    ip = (request.client.host if request.client else None) or "anon"
    if not _ip_throttle(ip):
        raise HTTPException(status_code=429, detail={"error": True, "code": "RATE_LIMITED",
                                                     "message": "Too many parse requests"})

    url = payload.url.strip()
    if not url.lower().startswith(("http://", "https://")):
        url = "https://" + url

    # Hard-fail check 1: syntactically invalid URL (no host)
    from urllib.parse import urlparse as _up
    parsed_url = _up(url)
    host_lc = (parsed_url.hostname or "").lower()
    if not host_lc or "." not in host_lc:
        legacy_bad = {
            "parsed": False, "source": None, "sourceUrl": url,
            "currency": "EUR", "error": "bad_url",
        }
        return {"canonical": from_legacy(legacy_bad).model_dump()}

    try:
        data = await parse_listing(url)
    except Exception:
        logger.exception(f"parse_car_link failed url={url}")
        legacy_err = {
            "parsed": False, "source": None, "sourceUrl": url,
            "currency": "EUR", "error": "parse_error",
        }
        # Soft-fail rather than 500 — surface still accepts the link
        # via canonical.parseCompleteness === "weak" branch.
        return {"canonical": from_legacy(legacy_err).model_dump()}

    # Success path — single canonical envelope, no legacy mirror.
    return {"canonical": from_legacy(data).model_dump()}


@router.get("/supported-sources")
async def supported_sources():
    """List of currently supported listing platforms (Phase C.1)."""
    return {
        "sources": [
            {"id": "mobile.de",        "name": "mobile.de",      "country": "DE", "active": True, "fidelity": "high"},
            {"id": "autoscout24",      "name": "AutoScout24",    "country": "EU", "active": True, "fidelity": "medium"},
            {"id": "kleinanzeigen.de", "name": "Kleinanzeigen",  "country": "DE", "active": True, "fidelity": "medium"},
            {"id": "heycar",           "name": "heycar",         "country": "DE", "active": True, "fidelity": "low"},
            {"id": "pkw.de",           "name": "PKW.de",         "country": "DE", "active": True, "fidelity": "low"},
            {"id": "otomoto.pl",       "name": "Otomoto",        "country": "PL", "active": True, "fidelity": "low"},
            {"id": "leboncoin.fr",     "name": "Leboncoin",      "country": "FR", "active": True, "fidelity": "low"},
            {"id": "willhaben.at",     "name": "Willhaben",      "country": "AT", "active": True, "fidelity": "low"},
            {"id": "marktplaats.nl",   "name": "Marktplaats",    "country": "NL", "active": True, "fidelity": "low"},
            {"id": "lacentrale.fr",    "name": "LaCentrale",     "country": "FR", "active": True, "fidelity": "low"},
            {"id": "subito.it",        "name": "Subito",         "country": "IT", "active": True, "fidelity": "low"},
            {"id": "generic",          "name": "Other / dealer", "country": "ANY","active": True, "fidelity": "best-effort"},
        ]
    }

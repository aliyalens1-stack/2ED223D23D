"""app.core.geo — geographic primitives.

Sprint 21 C9: haversine + resolve_zone, used by quick_request, matching,
provider router, bootstrap (all the sync hot-paths that resolve "which zone
does this lat/lng belong to" without hitting the DB).

Expansion 2026-05-17: regional bounding-boxes now cover 6 countries —
Germany, Austria, Ukraine, Latvia, Lithuania, Estonia, Belarus. Fallback
is no longer "kyiv-center" (which silently put every foreign coord into
the Ukrainian zone); instead it returns the **nearest** zone centre by
great-circle distance — that keeps analytics/ranking honest for any point
on the map.
"""
from __future__ import annotations
import math


def haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance (km) between two (lat,lng) points."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return R * 2 * math.asin(math.sqrt(a))


# Bounding-box → zone-id table. Order matters only for ambiguous overlaps
# (none here). Bboxes are ~6-10km city centers; outside any bbox → nearest
# zone centre fallback (see `_ZONE_CENTRES`).
_ZONE_BOUNDS: dict[str, tuple[float, float, float, float]] = {
    # ── Ukraine ───────────────────────────────────────────────────────────
    "kyiv-center":     (50.44, 50.46, 30.49, 30.55),
    "kyiv-podil":      (50.46, 50.48, 30.49, 30.54),
    "kyiv-obolon":     (50.48, 50.53, 30.46, 30.52),
    "kyiv-pechersk":   (50.42, 50.45, 30.52, 30.58),
    "kyiv-sviatoshyn": (50.44, 50.48, 30.34, 30.40),
    "kyiv-darnytsia":  (50.41, 50.45, 30.58, 30.65),
    "lviv-center":     (49.81, 49.87, 23.98, 24.07),
    "odesa-center":    (46.45, 46.51, 30.70, 30.76),
    "kharkiv-center":  (49.97, 50.02, 36.20, 36.27),
    "dnipro-center":   (48.44, 48.49, 35.02, 35.08),
    # ── Germany ───────────────────────────────────────────────────────────
    "berlin-mitte":    (52.49, 52.55, 13.36, 13.45),
    "berlin-neukolln": (52.46, 52.50, 13.40, 13.48),
    "munich-zentrum":  (48.10, 48.17, 11.53, 11.63),
    "hamburg-altona":  (53.52, 53.59, 9.93, 10.06),
    "cologne-zentrum": (50.91, 50.97, 6.93, 7.00),
    "frankfurt-zentrum": (50.09, 50.14, 8.65, 8.72),
    "stuttgart-zentrum": (48.75, 48.80, 9.15, 9.22),
    "dusseldorf-zentrum": (51.20, 51.26, 6.74, 6.81),
    # ── Austria ───────────────────────────────────────────────────────────
    "vienna-zentrum":  (48.19, 48.23, 16.35, 16.41),
    "salzburg-altstadt": (47.79, 47.83, 13.03, 13.08),
    # ── Latvia ────────────────────────────────────────────────────────────
    "riga-centrs":     (56.93, 56.97, 24.08, 24.14),
    "riga-agenskalns": (56.93, 56.96, 24.02, 24.08),
    # ── Lithuania ─────────────────────────────────────────────────────────
    "vilnius-senamiestis":(54.67, 54.71, 25.27, 25.31),
    "kaunas-centras":  (54.88, 54.92, 23.89, 23.94),
    # ── Estonia ───────────────────────────────────────────────────────────
    "tallinn-kesklinn":(59.42, 59.45, 24.73, 24.78),
    "tartu-kesklinn":  (58.37, 58.39, 26.71, 26.75),
    # ── Belarus ───────────────────────────────────────────────────────────
    "minsk-centralny": (53.88, 53.92, 27.53, 27.59),
    "minsk-frunzensky":(53.88, 53.92, 27.45, 27.53),
    "brest-centr":     (52.08, 52.12, 23.71, 23.76),
}

# Pre-computed centres for nearest-zone fallback. Derived from bbox midpoints.
_ZONE_CENTRES: dict[str, tuple[float, float]] = {
    zid: ((lat_min + lat_max) / 2, (lng_min + lng_max) / 2)
    for zid, (lat_min, lat_max, lng_min, lng_max) in _ZONE_BOUNDS.items()
}


def resolve_zone(lat: float, lng: float) -> str:
    """Resolve coordinates → zone-id.

    1) Point-in-bbox match → exact zone.
    2) Otherwise → nearest zone centre by haversine distance.

    This guarantees a sane answer for ANY coordinate in the 7 supported
    countries (and degrades gracefully for arbitrary points elsewhere).
    """
    for zid, (lat_min, lat_max, lng_min, lng_max) in _ZONE_BOUNDS.items():
        if lat_min <= lat <= lat_max and lng_min <= lng <= lng_max:
            return zid

    # Fallback: nearest by great-circle distance to bbox centre.
    nearest_zid = "kyiv-center"
    nearest_d = float("inf")
    for zid, (clat, clng) in _ZONE_CENTRES.items():
        d = haversine(lat, lng, clat, clng)
        if d < nearest_d:
            nearest_d = d
            nearest_zid = zid
    return nearest_zid


# ── Region / currency lookup (used by billing, pricing, reporting) ───────
CURRENCY_BY_COUNTRY: dict[str, str] = {
    "DE": "EUR", "AT": "EUR",
    "LV": "EUR", "LT": "EUR", "EE": "EUR",
    "BY": "BYN",
    "UA": "UAH",
    # Default for any unmapped country
}

# Locale hint by country → used by pricing/email/i18n fallbacks. Note:
# this is NOT the UI language (which is user-driven via i18next) — it's
# the *transactional* locale for receipts, invoices, legal copy.
LOCALE_BY_COUNTRY: dict[str, str] = {
    "DE": "de-DE", "AT": "de-AT",
    "LV": "lv-LV", "LT": "lt-LT", "EE": "et-EE",
    "BY": "ru-BY",
    "UA": "uk-UA",
}


def currency_for_country(country_code: str | None) -> str:
    """Return ISO-4217 currency for a 2-letter country code. Defaults to EUR."""
    if not country_code:
        return "EUR"
    return CURRENCY_BY_COUNTRY.get(country_code.upper(), "EUR")


def locale_for_country(country_code: str | None) -> str:
    """Return BCP-47 transactional locale for a country code. Defaults to en-US."""
    if not country_code:
        return "en-US"
    return LOCALE_BY_COUNTRY.get(country_code.upper(), "en-US")

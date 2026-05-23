"""app.pricing.density_projection — Pricing-v2 supply-density projection.

Geo-4 made marketplace topology trustworthy (`topologyCompleteness=100%`).
This module is the first consumer that turns that trust into money:
it derives a deterministic density tier per location and exposes the
multiplier that Pricing-v2 applies on top of v1 distance surcharge.

Architectural rules:

  • This is NOT inside checkout, matching, or the pricing-tiers constants.
  • It reads ONLY from the canonical Mongo collections that Geo already
    owns (`provider_topology`, `organizations`). No surge, no time of day,
    no weather, no AI coefficients.
  • Output is a pure function of (cityId, countryCode, current
    provider_topology / organizations state at call time). When the
    caller freezes the snapshot into a quote, the values become
    immutable — re-computing later may yield different numbers but the
    frozen quote stays byte-identical.
  • Fully explainable: every modifier carries a one-line reason.

Density buckets (provider supply only — partners don't deliver the
inspection, so they don't count towards capacity):

  providers_in_city → density tier
  ──────────────────────────────────────
        0           → scarce
       1–2          → low
       3–5          → medium
       6+           → high

The same brackets apply at country level. Effective density used for
pricing is `cityDensity`; we fall back to `countryDensity` only if the
city isn't in the catalogue (defensive — server-side resolution should
prevent that).

Modifier table:

  density   multiplier  manualReview
  ─────────────────────────────────
  high       1.00       inherit
  medium     1.05       inherit
  low        1.15       inherit
  scarce     1.30       force True

`scarce` flips manual review on unconditionally — pricing is honest
about the operational risk of dispatching to a region with no
inspectors.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from typing import Optional

from app.geo.coverage_projection import _CITY_TO_COUNTRY


# Density bracket thresholds — server-decided, must stay stable for the
# v2 version to remain locked. A future tightening of these brackets
# requires Pricing-v3, not an edit.
PROVIDERS_HIGH_MIN = 6
PROVIDERS_MEDIUM_MIN = 3
PROVIDERS_LOW_MIN = 1
# 0 providers → scarce


# Modifier table — locked for Pricing-v2.
DENSITY_MULTIPLIER = {
    "high":   1.00,
    "medium": 1.05,
    "low":    1.15,
    "scarce": 1.30,
}

# Human-readable rationale shown to customers. NO dark patterns,
# NO urgency, NO "high demand now" framing.
DENSITY_REASON = {
    "high":   "Established marketplace coverage",
    "medium": "Moderate inspector coverage",
    "low":    "Limited inspector coverage",
    "scarce": "Remote area with no local inspectors — manual coordination required",
}


def bucket_for_providers(providers: int) -> str:
    """Pure mapping: provider count → density tier label."""
    if providers >= PROVIDERS_HIGH_MIN:
        return "high"
    if providers >= PROVIDERS_MEDIUM_MIN:
        return "medium"
    if providers >= PROVIDERS_LOW_MIN:
        return "low"
    return "scarce"


@dataclass(frozen=True)
class DensitySnapshot:
    """Frozen snapshot embedded into Pricing-v2 projections.

    Once stored in `inspection_pricing_projection.densitySnapshot`, this
    is part of the immutable quote contract — the customer's frozen
    quote will keep reflecting these exact numbers forever, even if the
    marketplace gains/loses providers later.
    """
    cityId: Optional[str]
    countryCode: Optional[str]
    providers: int          # providers in the relevant city (or country if no city)
    partners: int           # partners in the relevant city
    coverageRatio: float    # providers / HIGH threshold, clamped to 1.0
    cityDensity: str        # bucket for the city's provider count
    countryDensity: str     # bucket for the country's provider count
    effectiveDensity: str   # the tier actually used for pricing (city falls back to country)
    densityMultiplier: float
    manualReview: bool
    reason: str


def _coverage_ratio(providers: int) -> float:
    """`how close are we to high-density saturation`. Clamped to 1.0."""
    if PROVIDERS_HIGH_MIN <= 0:
        return 1.0
    return round(min(providers / PROVIDERS_HIGH_MIN, 1.0), 2)


async def resolve_density(
    db,
    *,
    city_id: Optional[str] = None,
    country_code: Optional[str] = None,
) -> DensitySnapshot:
    """Derive a `DensitySnapshot` for the given location.

    Either `city_id` or `country_code` must be provided. When both are
    given, city wins for `effectiveDensity` (it's more specific). When
    only `country_code` is given (e.g. for a country-wide quote), only
    country-level numbers apply.

    Implementation is read-only: it counts `provider_topology` rows and
    `organizations` rows in the same way Geo-3 does. We don't reuse the
    public Geo-3 endpoint here because we need to be callable from
    inside the request pipeline without an HTTP hop.
    """
    cc = (country_code or "").upper() or None
    if not cc and city_id:
        cc = _CITY_TO_COUNTRY.get(city_id)

    if not city_id and not cc:
        raise ValueError("resolve_density requires city_id or country_code")

    # ── City-level counts (skipped if city not provided) ───────────────
    city_providers = 0
    city_partners = 0
    if city_id:
        city_providers = await db.provider_topology.count_documents(
            {"baseCityId": city_id}
        )
        city_partners = await db.organizations.count_documents(
            {"city": city_id, "status": "active"}
        )

    # ── Country-level counts (always, used for fallback + transparency) ─
    country_providers = 0
    country_partners = 0
    if cc:
        country_providers = await db.provider_topology.count_documents(
            {"baseCountry": cc}
        )
        country_partners = await db.organizations.count_documents(
            {"country": cc, "status": "active"}
        )

    city_density = bucket_for_providers(city_providers) if city_id else "scarce"
    country_density = bucket_for_providers(country_providers) if cc else "scarce"

    effective_density = city_density if city_id else country_density
    multiplier = DENSITY_MULTIPLIER[effective_density]

    # scarce flips manual review on; other tiers inherit (False here).
    manual_review = effective_density == "scarce"

    # Headline numbers exposed to consumers reflect the SAME scope as
    # `effectiveDensity`. If city_id was given → city numbers; if only
    # country_code → country numbers. Keeps the snapshot self-consistent.
    if city_id:
        providers, partners = city_providers, city_partners
    else:
        providers, partners = country_providers, country_partners

    return DensitySnapshot(
        cityId=city_id,
        countryCode=cc,
        providers=providers,
        partners=partners,
        coverageRatio=_coverage_ratio(providers),
        cityDensity=city_density,
        countryDensity=country_density,
        effectiveDensity=effective_density,
        densityMultiplier=multiplier,
        manualReview=manual_review,
        reason=DENSITY_REASON[effective_density],
    )


def snapshot_to_dict(snapshot: DensitySnapshot) -> dict:
    """Convert dataclass → dict (the shape that ends up in the frozen
    projection). Stable field order is irrelevant for storage but useful
    for tests."""
    return asdict(snapshot)

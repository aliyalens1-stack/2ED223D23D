"""app.marketplace.trust — Berlin Launch B3 (Trust Layer).

Derives an explicit trust profile for every provider and computes a
multiplicative ranking boost used by `GET /api/marketplace/providers`.

Fields ingested (any of these on the org doc):
  badges[]          — from seed ("tuv", "verified", "expert", …)
  isVerified        — boolean
  yearsExperience   — optional explicit int (if not set, derived heuristically)
  completedBookingsCount, reviewsCount, ratingAvg

Output (attached to each provider in API response as `trustProfile`):
  {
    tuvVerified: bool,
    yearsExperience: int,     # capped 2..20
    vehiclesInspected: int,   # fallback = completedBookingsCount
    reviewsCount: int,
    ratingAvg: float,
    boostFactor: float,       # 1.0 .. ~1.38
    chips: [                  # UI-ready localized chips, DE
      {key, label, tone: "gold"|"success"|"neutral"}
    ]
  }

Boost rules (from Berlin launch spec):
  tuv_verified      → × 1.20
  years ≥ 10        → × 1.10
  reviews ≥ 50      → × 1.05
"""
from __future__ import annotations
from typing import Any


def _yrs_heuristic(org: dict) -> int:
    # explicit override wins
    y = org.get("yearsExperience")
    if isinstance(y, (int, float)) and y > 0:
        return min(20, int(y))
    # derive from completed bookings — crude but stable
    bk = int(org.get("completedBookingsCount") or 0)
    if bk >= 300: return 12
    if bk >= 150: return 9
    if bk >= 60:  return 6
    if bk >= 15:  return 4
    return 2


def compute_trust_profile(org: dict) -> dict[str, Any]:
    badges = org.get("badges") or []
    tuv = any(b in ("tuv", "tuv_geprueft", "tuv_certified") for b in badges)
    # Inspectors in seed sometimes encoded as providerType=inspector + verified
    if not tuv and org.get("providerType") == "inspector" and org.get("isVerified"):
        tuv = True

    years = _yrs_heuristic(org)
    reviews = int(org.get("reviewsCount") or 0)
    rating = float(org.get("ratingAvg") or 0)
    vehicles = int(org.get("vehiclesInspected") or org.get("completedBookingsCount") or 0)

    boost = 1.0
    if tuv: boost *= 1.20
    if years >= 10: boost *= 1.10
    if reviews >= 50: boost *= 1.05
    boost = round(boost, 3)

    chips: list[dict[str, Any]] = []
    if tuv:
        chips.append({"key": "tuv", "label": "TÜV geprüft", "tone": "gold"})
    if years >= 10:
        chips.append({"key": "experience", "label": f"{years}+ Jahre Erfahrung", "tone": "success"})
    elif years >= 5:
        chips.append({"key": "experience", "label": f"{years} Jahre Erfahrung", "tone": "neutral"})
    if vehicles >= 50:
        chips.append({"key": "vehicles", "label": f"{vehicles}+ Fahrzeuge geprüft", "tone": "neutral"})
    if rating >= 4.8 and reviews >= 20:
        chips.append({"key": "rating", "label": f"★ {rating:.1f} ({reviews} Bewertungen)", "tone": "success"})
    if org.get("isVerified") and not tuv:
        chips.append({"key": "verified", "label": "Verifiziert", "tone": "success"})

    return {
        "tuvVerified": tuv,
        "yearsExperience": years,
        "vehiclesInspected": vehicles,
        "reviewsCount": reviews,
        "ratingAvg": round(rating, 2),
        "boostFactor": boost,
        "chips": chips,
    }

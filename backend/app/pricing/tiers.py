"""Pricing projection — distance surcharge tiers (v1).

Deterministic, projection-based pricing for inspection requests.
Customer pays: base inspection price + remote travel compensation.
Tiers are intentionally simple and human — see PRD / chat thread.

Single source of truth. Frontend MUST NEVER hardcode these values —
it calls POST /api/pricing/project to get a frozen projection per job.

Tier table (EUR, v1):

  Distance         Logic                           Rate     MinFee   Manual
  ───────────────  ──────────────────────────────  ───────  ───────  ───────
   0  –  100 km    included                        —        —        no
  101 –  150 km    soft remote                     €0.35/km €25      no
  151 –  250 km    standard remote                 €0.45/km €50      no
  251+      km     far remote (manual review)      €0.60/km €120     YES

`Manual` means the inspector must accept explicitly; we do not auto-confirm.

Inspector payout split (distance compensation only):
  Inspector receives 85 % · platform takes 15 %.
The base inspection price is split by existing logic (untouched).
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import List, Optional


PRICING_VERSION = "v1"

INCLUDED_KM = 100
CURRENCY = "EUR"

# Distance surcharge → 85 % to inspector, 15 % to platform.
INSPECTOR_DISTANCE_PAYOUT_PCT = 0.85
PLATFORM_DISTANCE_FEE_PCT = 0.15


@dataclass(frozen=True)
class RemoteTier:
    tier: str            # canonical id ("included" / "soft_remote" / ...)
    min_km: int          # inclusive
    max_km: Optional[int]  # inclusive; None = unbounded
    rate_per_km: float   # EUR per km BEYOND `INCLUDED_KM`
    minimum_fee: float   # EUR — surcharge can never go below this
    manual_review: bool  # if True → inspector confirmation required


# Order matters: first match wins. `max_km=None` is the catch-all upper tier.
REMOTE_TIERS: List[RemoteTier] = [
    RemoteTier(tier="soft_remote",     min_km=101, max_km=150,  rate_per_km=0.35, minimum_fee=25.0,  manual_review=False),
    RemoteTier(tier="standard_remote", min_km=151, max_km=250,  rate_per_km=0.45, minimum_fee=50.0,  manual_review=False),
    RemoteTier(tier="far_remote",      min_km=251, max_km=None, rate_per_km=0.60, minimum_fee=120.0, manual_review=True),
]


def find_tier(distance_km: float) -> Optional[RemoteTier]:
    """Return the tier that owns `distance_km`, or None if it's inside the
    included radius (0 – INCLUDED_KM)."""
    if distance_km <= INCLUDED_KM:
        return None
    for t in REMOTE_TIERS:
        if t.min_km <= distance_km and (t.max_km is None or distance_km <= t.max_km):
            return t
    return None  # unreachable — far_remote has no upper bound

"""Matching-v2 dispatch policy — locked table + pure projection function.

Design rules (locked, byte-identical forever like pricing-v2):

  1. The policy table is THE source of truth. No subclassing, no overrides,
     no admin tunables. Future ops/UX changes go through Matching-v3.
  2. The function is pure — same density input → same dispatch decision
     forever. No DB calls, no clock reads, no env lookups.
  3. matching never recalculates density. It reads the frozen
     `pricingSnapshot.densitySnapshot.effectiveDensity` and acts on it.
     Economic truth (pricing) and operational truth (dispatch) MUST
     remain consistent for any given job.
  4. `scarce` is intentionally non-broadcast: batchSize=0, ttlMinutes=None
     (∞ until cancelled by ops), policy="concierge". The customer already
     saw "Remote availability check required" in the pricing UI; the
     operational semantics MUST match what the customer was told.
  5. Escalation between policies (e.g. `high` → `medium` after no
     acceptance) is OUT OF SCOPE for Sprint 1. It belongs to the future
     executor — projection is stateless.

Locked policy table:

    density   radius    batch  ttl(min)  policy
    ────────────────────────────────────────────
    high      50 km     3      5         fast_local
    medium    100 km    5      10        standard
    low       150 km    10     20        expanded
    scarce    None      0      None      concierge   (manual escalation)
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from typing import Optional, Dict, Any, Literal


# ─── Locked policy values per density tier ─────────────────────────────
# Tuples kept inline so the table is readable as-data: every change to
# values forces a new file revision, which keeps diffs honest.

Density = Literal["high", "medium", "low", "scarce"]
Policy = Literal["fast_local", "standard", "expanded", "concierge"]


@dataclass(frozen=True)
class DispatchPolicy:
    """Frozen output of the projection. Re-creating with the same
    density yields a byte-identical instance — that's the whole point.

    Fields:
      effectiveDensity   — density tier the matching layer acted on
      dispatchRadiusKm   — geographic radius for provider broadcast
                           (None = no broadcast; concierge handles it)
      batchSize          — N providers to surface concurrently
                           (0 = no broadcast; concierge queue only)
      ttlMinutes         — acceptance window per batch
                           (None = no auto-expiration; manual review)
      policy             — short name (used for telemetry / audit)
    """
    effectiveDensity: Density
    dispatchRadiusKm: Optional[int]
    batchSize: int
    ttlMinutes: Optional[int]
    policy: Policy


# Locked. Any change here is a Matching-v3 conversation, not an edit.
DISPATCH_POLICY: Dict[Density, DispatchPolicy] = {
    "high": DispatchPolicy(
        effectiveDensity="high",
        dispatchRadiusKm=50,
        batchSize=3,
        ttlMinutes=5,
        policy="fast_local",
    ),
    "medium": DispatchPolicy(
        effectiveDensity="medium",
        dispatchRadiusKm=100,
        batchSize=5,
        ttlMinutes=10,
        policy="standard",
    ),
    "low": DispatchPolicy(
        effectiveDensity="low",
        dispatchRadiusKm=150,
        batchSize=10,
        ttlMinutes=20,
        policy="expanded",
    ),
    "scarce": DispatchPolicy(
        # Concierge route — no auto-broadcast, no TTL. Operations queue
        # picks it up. Customer already saw the corresponding pricing-v2C
        # copy: "Remote availability check required".
        effectiveDensity="scarce",
        dispatchRadiusKm=None,
        batchSize=0,
        ttlMinutes=None,
        policy="concierge",
    ),
}


def _extract_effective_density(pricing_snapshot: Dict[str, Any]) -> Density:
    """Return the frozen effectiveDensity from a pricing snapshot.

    Accepts both shapes used today:
      • Pricing-v2 projection doc:
          { "densitySnapshot": { "effectiveDensity": "low", ... }, ... }
      • Request-level snapshot stored on `car_requests.pricing`:
          { "jobs": [ { "densitySnapshot": {...} }, ... ], ... }
        (request-level not consumed by Sprint 1; left as an explicit
        validation error to keep the API contract narrow.)

    Defensive — same density string regardless of where it came from.
    """
    if not isinstance(pricing_snapshot, dict):
        raise ValueError("pricingSnapshot must be a dict")

    density_snapshot = pricing_snapshot.get("densitySnapshot")
    if not isinstance(density_snapshot, dict):
        raise ValueError(
            "pricingSnapshot.densitySnapshot is required — matching reads "
            "frozen density, it does not recompute it"
        )

    tier = density_snapshot.get("effectiveDensity")
    if tier not in DISPATCH_POLICY:
        raise ValueError(
            f"effectiveDensity {tier!r} is not in the locked policy table "
            f"({sorted(DISPATCH_POLICY.keys())})"
        )
    return tier  # type: ignore[return-value]


def project_dispatch_policy(pricing_snapshot: Dict[str, Any]) -> DispatchPolicy:
    """Pure projection: pricing snapshot → dispatch policy.

    No I/O, no DB, no clock. Re-running with the same snapshot yields a
    byte-identical `DispatchPolicy`. This is what later sprints will
    freeze into `matching_dispatch_snapshot`.

    Raises `ValueError` when the snapshot is missing density signal —
    matching MUST refuse to dispatch when it can't read frozen economics.
    """
    density = _extract_effective_density(pricing_snapshot)
    return DISPATCH_POLICY[density]


def policy_to_dict(policy: DispatchPolicy) -> Dict[str, Any]:
    """Convert dataclass → dict for JSON response. Stable shape."""
    return asdict(policy)

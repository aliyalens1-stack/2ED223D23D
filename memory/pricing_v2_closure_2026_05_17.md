# Pricing-v2 — Density-aware deterministic pricing (closure, 17.05.2026)

## Why this is the right time

Geo-4 left the marketplace topology at `topologyCompleteness=100%`. Any
density-aware modifier shipped earlier would have been pseudo-math; now
the underlying signal is real. Pricing-v2 turns that signal into money
with **zero economic guesswork**.

## The hard contract

```
distance ⊕ coverage_density ⊕ market_activation → tier projection
```

NO:
- ❌ surge / dynamic pricing
- ❌ Uber-style multipliers
- ❌ live demand
- ❌ time-of-day
- ❌ weather
- ❌ auctions / bidding
- ❌ opaque AI coefficients

Pricing-v2 is `deterministic density-aware modifiers` — that's the whole
product.

## What ships

### 1. NEW namespace `app/pricing/density_projection.py`
Pure projection. Reads only `provider_topology` + `organizations`. NOT
inside checkout/matching/pricing-tiers — that boundary stays clean.

```python
DENSITY_MULTIPLIER = {
    "high":   1.00,   # Established marketplace coverage
    "medium": 1.05,   # Moderate inspector coverage
    "low":    1.15,   # Limited inspector coverage
    "scarce": 1.30,   # Remote area with no local inspectors — manual coordination
}

# Bracket constants (locked):
PROVIDERS_HIGH_MIN   = 6   # high
PROVIDERS_MEDIUM_MIN = 3   # medium 3-5
PROVIDERS_LOW_MIN    = 1   # low 1-2
# 0 → scarce
```

Public `DensitySnapshot` shape (frozen into v2 quotes):
```json
{
  "cityId": "berlin", "countryCode": "DE",
  "providers": 4, "partners": 3,
  "coverageRatio": 0.67,
  "cityDensity": "medium", "countryDensity": "medium",
  "effectiveDensity": "medium",
  "densityMultiplier": 1.05, "manualReview": false,
  "reason": "Moderate inspector coverage"
}
```

### 2. NEW calculator `app/pricing/projection_v2.py`
Sits **alongside** v1. v1 stays byte-identical forever.

```
final_surcharge = round(v1_base_surcharge × density_multiplier)
manual_review   = v1_tier.manual_review OR density.manualReview
```

`scarce` always flips `manualReview` on — pricing tells the truth about
operational risk.

### 3. Read-only endpoints
- `GET /api/pricing/versions` — registry (v1 + v2, both locked).
- `GET /api/pricing/v2/modifiers` — public modifier table (customer-safe).
- `GET /api/pricing/density/{cityId}` — what density tier this city is right now.
- `POST /api/pricing/v2/preview` — full v2 quote preview (no DB write).

### 4. Version registry updated
- `KNOWN_VERSIONS["v2"]` registered, `locked=True`.
- `current_version()` → `"v2"`. v1 still locked; old confirmed v1 quotes survive forever.

### 5. Tests (39 new, all green — 74 total in Geo+Pricing suite)
`backend/tests/test_pricing_v2.py`:
- Density brackets (zero→scarce, 1-2→low, 3-5→medium, 6+→high, monotonicity).
- Modifier table values locked (1.00/1.05/1.15/1.30).
- Calculator scenarios: included radius, standard_remote × every density bucket, far_remote manualReview inheritance.
- 85/15 payout split with no rounding drift.
- **Determinism**: byte-identical replay; same frozen snapshot → same quote even if marketplace gained providers.
- Rejects tampered multipliers (snapshot integrity guard).
- Pydantic field-set lock for `DensitySnapshot`.
- v1 must remain locked; v2 is registered + current.

## Live snapshot

```
GET /api/pricing/density/berlin  → medium · ×1.05 · 4 providers / 3 partners
GET /api/pricing/density/kyiv    → high   · ×1.00 · 7 providers / 8 partners
GET /api/pricing/density/munich  → scarce · ×1.30 · 0 providers / 0 partners · manualReview

POST /api/pricing/v2/preview {basePrice:199, distanceKm:220, cityId:"berlin"}
  → distanceSurchargeBase=54, densityMultiplier=1.05, densitySurchargeDelta=3,
    distanceSurcharge=57, customerTotal=256, manualReview=false

POST /api/pricing/v2/preview {basePrice:199, distanceKm:220, cityId:"munich"}
  → distanceSurchargeBase=54, densityMultiplier=1.30, densitySurchargeDelta=16,
    distanceSurcharge=70, customerTotal=269, manualReview=TRUE
```

## Customer-facing explanation (no dark patterns)

The v2 projection ships an `explanation: [{label, amount}]` array, e.g.:
```
Base inspection           €199
Distance 220 km · standard_remote  €54
Limited inspector coverage (+15%)   €8
```
No urgency. No "high demand now". No hidden coefficients. The customer
sees structural marketplace cost spelled out.

## Hard invariants (encoded in tests, not just docs)

| Invariant | Test |
|-----------|------|
| Same inputs → same quote forever | `test_byte_identical_on_replay`, `test_same_snapshot_same_quote_after_modifier_change` |
| v1 calculator never edits (only v2 added) | `test_v1_still_locked` |
| Modifier table is locked | `test_*_percent` × 4 |
| Density brackets are locked | `test_bracket_constants_locked` |
| Tampered snapshots refused | `test_rejects_unknown_multiplier` |
| Scarce forces manual review | `test_scarce_forces_manual_review` |
| Payout split is exact (no rounding drift) | `test_inspector_payout_split_85_15` |
| No surge / demand framing | `test_all_tiers_have_reason` greps for "surge"/"demand" |

## What was deliberately NOT done

- ❌ Mutated v1. v1 module is untouched.
- ❌ Wired v2 into the `save_projection` freeze path yet. That's the
  next, separate change: when the customer confirms a request the
  router decides v1 or v2 and stores the chosen snapshot. Today v2 is
  preview-only — production confirms still go through v1 until we flip
  the freeze path. This separation lets ops verify v2 numbers against
  v1 numbers side-by-side before the marketplace switches.
- ❌ No surge, no AI, no time-of-day, no weather (per architectural rule).
- ❌ No re-snapshotting of confirmed v1 quotes. They keep their v1
  numbers forever — that's the immutability invariant.

## What unlocks next

| Step | Status |
|------|--------|
| Geo-1/2/3/4 | ✅ closed |
| **Pricing-v2 (this closure)** | ✅ closed (preview path) |
| Pricing-v2 freeze-path migration | ▶ next — route `save_projection` through v2 |
| Matching-v2 economically-aware dispatch | ▶ unblocked — can now read density |

Matching-v2 was deferred for the right reason: with v2 prices in hand,
matching decisions can be **economically coherent** (provider in low-density
region declines → broadcast radius expands to medium-density neighbours)
rather than purely geographic.

## Files added / changed

**Added**
- `backend/app/pricing/density_projection.py`
- `backend/app/pricing/projection_v2.py`
- `backend/app/pricing/projection_v2_router.py`
- `backend/tests/test_pricing_v2.py`

**Changed (non-destructive)**
- `backend/app/pricing/version_registry.py` — registered `v2`, `current_version()` now `"v2"`
- `backend/server.py` — mount `pricing_v2_router`

**NOT touched** (by design)
- `backend/app/pricing/projection.py` (v1 calculator)
- `backend/app/pricing/tiers.py` (v1 tier table)
- `backend/app/pricing/projection_router.py` (v1 endpoints + freeze path)
- `backend/app/payments/*` (snapshot-bound checkout — v1 quotes stay v1)

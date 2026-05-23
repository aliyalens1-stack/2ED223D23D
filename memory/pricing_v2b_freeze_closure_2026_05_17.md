# Pricing-v2B — Freeze-path activation (closure, 17.05.2026)

## Why this came after v2-preview

Preview without freeze is not yet economic truth. v2 was emitting
density-aware numbers in `/api/pricing/v2/preview` but the actual
quote frozen onto `inspection_pricing_projection` was still v1. This
closure flips the freeze path so **new** confirmed quotes become true
v2 snapshots while **old** v1 quotes stay v1 forever.

The discipline is the same one already applied across pricing snapshots,
payments snapshots, and customer-grammar checksums:

    same inputs → same quote forever
    confirmed quotes are LOCKED at their version

## What ships

### 1. Version-aware freeze entry point
`app/pricing/freeze.py::freeze_for_job(...)` — single funnel for every
new quote computation. Logic:

```
if existing.status == "confirmed":
    return existing                  # ← immutable, never recomputed

if current_version() == "v1":
    proj = v1_calculate(...)
else:                                # v2 (current default)
    density = resolve_density(...)
    proj = v2_calculate(...) with density embedded

save_projection(db, job_id, proj)
```

Confirmed quotes are returned unchanged regardless of what
`current_version()` says today. That's the invariant test
`test_v1_confirmed_stays_v1_after_version_flip` locks down.

### 2. Customer quote router migrated
`app/pricing/customer_quote_router.py` now:

- Imports `freeze_for_job` instead of `calculate_projection_*` / `save_projection`.
- Resolves each job's `city` (free-text name) → canonical `cityId` via a
  reverse index built from `CITY_CATALOGUE` (name + code + addressMarkers).
  This is the join that lets v2 resolve density city-level for already-
  existing free-text job rows.
- Embeds per-job `densitySnapshot` + `explanation` into `car_requests.pricing`
  snapshot. v1 jobs leave those fields as `null` — payments don't read them.

### 3. Snapshot extended (per-job)
```json
{
  "pricingVersion": "v2",
  "currency": "EUR",
  "customerTotal": 256,
  "manualReview": false,
  "digest": "Berlin 220 km · density ×1.05 +€57",
  "confirmedAt": "...",
  "jobs": [
    {
      "jobId": "...",
      "city": "Berlin",
      "customerTotal": 256,
      "digest": "220 km · standard_remote · density ×1.05 +€57",
      "densitySnapshot": {              # ← Pricing-v2B
        "cityId": "berlin", "countryCode": "DE",
        "providers": 4, "partners": 3, "coverageRatio": 0.67,
        "cityDensity": "medium", "effectiveDensity": "medium",
        "densityMultiplier": 1.05, "manualReview": false,
        "reason": "Moderate inspector coverage"
      },
      "explanation": [                  # ← frozen text
        {"label": "Base inspection", "amount": 199.0},
        {"label": "Distance 220 km · standard_remote", "amount": 54.0},
        {"label": "Moderate inspector coverage (+5%)", "amount": 3.0}
      ]
    }
  ]
}
```

### 4. Tests (6 new, all green — 80 total in Geo + Pricing suites)
`backend/tests/test_pricing_v2b_freeze.py`:

| # | Test | Invariant |
|---|------|-----------|
| 1 | `test_v2_default_writes_density_snapshot` | New freezes carry full snapshot + explanation |
| 2 | `test_v2_with_inspector_base_and_vehicle` | Haversine path still emits v2 + densitySnapshot |
| 3 | `test_confirmed_doc_is_locked` | Re-freezing a confirmed v2 quote with different inputs returns the frozen doc |
| 4 | `test_v1_confirmed_stays_v1_after_version_flip` | Flip current_version v1↔v2, confirmed v1 stays v1, **no densitySnapshot retrofit** |
| 5 | `test_pending_v2_can_refresh` | Pending docs can re-compute, `createdAt` preserved |
| 6 | `test_explanation_survives_round_trip` | Explanation array verbatim across `freeze → confirm → read` |

## Hard invariants (encoded in tests)

| Invariant | Test |
|-----------|------|
| current_version routes new freezes | `test_v2_default_writes_density_snapshot` |
| Confirmed quotes are byte-frozen | `test_confirmed_doc_is_locked` |
| v1 quotes never silently upgrade | `test_v1_confirmed_stays_v1_after_version_flip` |
| Density snapshot is stored in FULL | `test_v2_default_writes_density_snapshot` |
| Explanation text is frozen | `test_explanation_survives_round_trip` |

## What was deliberately NOT done

- ❌ v1 calculator + tier table untouched. Editing them is forbidden.
- ❌ No retroactive density backfill onto existing v1 confirmed quotes.
  That would violate the immutability contract — old quotes stay v1.
- ❌ No customer-facing UI changes in this closure. The `explanation`
  array now flows through the snapshot; rendering it in the mobile
  quote screen is the next, separate piece of work.
- ❌ Payments code (`snapshot_checkout.py`) NOT touched. It reads the
  same fields it always did — `customerTotal`, `currency`, `manualReview`,
  `digest`. The new `densitySnapshot` / `explanation` are additive.

## Live verification

```
GET  /api/pricing/versions                   → current=v2, locked v1+v2
POST customer quote creation                 → frozen as v2 with densitySnapshot+explanation
POST /api/pricing/v2/preview                 → unchanged (preview path)
80/80 tests green across Geo-3, Geo-4, Pricing-v2, Pricing-v2B suites
```

## What unlocks next

| Step | Status |
|------|--------|
| Geo-1/2/3/4 | ✅ |
| Pricing-v2 (preview)  | ✅ |
| **Pricing-v2B (freeze migration, this closure)** | ✅ |
| Frontend v2 explanation UI | ▶ next (render frozen `explanation[]` in quote screen) |
| Matching-v2 (density-aware dispatch) | ▶ unblocked — economics + dispatch can now share a coherent view |

Matching-v2 can finally read both:
- structural marketplace cost (`densityMultiplier`)
- supply density signal (`coverageRatio`, `effectiveDensity`)

without risk of economics and dispatch diverging — every confirmed quote
carries its own snapshot of both. Operator policy layer becomes the next
natural milestone:

```
high   → radius 50 km · small batch · fast expiration
medium → radius 100 km · standard batch
low    → radius 150 km · broadcast wider · slower expiration
scarce → manual-review path · concierge escalation
```

## Files touched

**Added**
- `backend/app/pricing/freeze.py`
- `backend/tests/test_pricing_v2b_freeze.py`

**Changed (non-destructive)**
- `backend/app/pricing/customer_quote_router.py` — uses `freeze_for_job` + resolves cityId + embeds per-job `densitySnapshot`/`explanation` in snapshot

**NOT touched** (by design)
- `backend/app/pricing/projection.py` (v1 calculator)
- `backend/app/pricing/projection_v2.py` (v2 calculator)
- `backend/app/pricing/tiers.py` (v1 tier table)
- `backend/app/payments/snapshot_checkout.py` (checkout reads only the universal fields)

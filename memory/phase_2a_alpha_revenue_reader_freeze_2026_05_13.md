# 🔒 PHASE 2A-α — REVENUE READER CONTRACT FREEZE

**Date:** 2026-05-13 10:05 UTC
**Status:** ✅ **SHIPPED & FROZEN**
**Predecessors:** Phase 1A ✅ · Phase 1B ✅ · Redis Truthfulness ✅
**Successor:** Phase 2A-β (admin UI surface) — NOT STARTED, deliberately deferred

---

## 1. Scope (locked, exactly as specified)

| Concern | Decision |
|---|---|
| read-only | ✅ no insert / no update path touched |
| writer changes | ✅ none |
| webhook changes | ✅ none |
| checkout changes | ✅ none |
| currency conversion | ✅ none — no FX, no normalization |
| summing across currencies | ✅ never — strict per-currency bucket |
| legacy aggregate | ✅ `/api/admin/revenue/summary` byte-identical response keys, regression-tested |
| cluster/currency breakdown | ✅ new canonical endpoint `/api/admin/revenue/cluster-summary` |
| frontend UI | ⛔ NOT touched — frozen until 2A-β |

**Master invariant:** *money is grouped by currency BEFORE it is summed.*

---

## 2. Endpoint

```
GET /api/admin/revenue/cluster-summary?period=today|week|month
Auth: admin only (401 anonymous, 403 non-admin, 200 admin) — verified live
```

### Response shape (HARD-LOCKED)

```json
{
  "period": "month",
  "windowStart": "2026-04-13T10:05:23.404+00:00",
  "totalsByCluster": {
    "<cluster_label>": {
      "<currency_label>": { "count": <int>, "amount": <int|null> }
    }
  }
}
```

Top-level keys: exactly `{period, windowStart, totalsByCluster}`. Contract-frozen
by `test_response_shape_has_only_locked_top_level_keys` — adding a fourth key
will fail the test.

### Bucket label semantics

| Label | Meaning |
|---|---|
| `cluster_label = "<concrete>"` | Any Phase-1B-stamped cluster string (`inspection`, `repair`, `billing_boost`, …) — verbatim from doc. |
| `cluster_label = "manual_review"` | Doc carries Phase 1B writer breadcrumb `clusterCreateMeta.strategy='manual_review'` (or `clusterBackfillMeta.strategy='manual_review'`). Overrides any `cluster` field on the doc — the writer's pending decision dominates. |
| `cluster_label = "unknown"` | Doc has NO `cluster` field. Not inferred — admin must see how many slipped past writers. |
| `currency_label = "<concrete>"` | Any currency string from doc (`EUR`, `UAH`, …). |
| `currency_label = "unknown"` | Doc has NO `currency` field. Not defaulted to UAH. |

### `amount` trust rule (HARD-LOCKED)

```
amount = sum(doc.amount)  IFF  cluster != "manual_review"  AND  currency != "unknown"
amount = null             OTHERWISE
```

Rationale:
- `manual_review` → writer-side decision is pending; do NOT publish a sum.
- `unknown` currency → no comparable unit; summing N integers across unknown
  units would be misleading.

`count` is ALWAYS an integer — rows are counted even when their monetary
aggregate is untrusted. The frontend can render the bucket with a
"pending / unverified" affordance, but MUST NOT default `null` to `0`.

### Period dimension

| `period` query param | Window |
|---|---|
| `today` | from local midnight UTC |
| `week` | `now - 7d` |
| `month` (default) | `now - 30d` |
| (anything else) | normalizes to `month` |

`windowStart` is the ISO 8601 lower bound (`createdAt >= windowStart`).

### Source collections

- `payment_transactions`
- `provider_purchases`

Aggregated together at the Python layer (identical pipeline ran on each).
Currencies remain strictly separated at every group level — there is no path
through which two different currency values can be summed.

### Excluded rows

- `status not in ("paid", "completed")` — pending and failed never enter
  any bucket.

---

## 3. Live verification (against current preview DB)

Empty DB:
```bash
$ curl … cluster-summary?period=month
{"period":"month","windowStart":"…","totalsByCluster":{}}
```

After seeding 3 docs (1 trusted UAH, 1 missing-currency, 1 manual_review):
```json
{
  "period": "month",
  "windowStart": "2026-04-13T10:04:43.753855+00:00",
  "totalsByCluster": {
    "repair": {
      "UAH":     {"count": 1, "amount": 56000},
      "unknown": {"count": 1, "amount": null}
    },
    "manual_review": {
      "EUR":     {"count": 1, "amount": null}
    }
  }
}
```

→ Matches the user-specified canonical example byte-for-byte semantically.
   `manual_review.EUR.amount = null` even though currency is known, because
   the cluster bucket itself is untrusted. `repair.unknown.amount = null`
   because the currency is missing.

Auth probe:
- Anonymous → **401**
- Customer token → **403**
- Admin token → **200**

---

## 4. Test coverage

`backend/tests/test_phase_2a_cluster_summary.py` — **11/11 PASS** (1.71s)

| Test | Invariant under test |
|---|---|
| `test_basic_inspection_eur_sums_within_currency` | trusted cluster+currency → integer amount |
| `test_no_cross_currency_summation` | EUR and UAH in same cluster → two independent sub-buckets, NO cluster-level merger |
| `test_manual_review_bucket_amount_is_null` | writer breadcrumb overrides cluster field; amount=null |
| `test_unknown_currency_yields_null_amount` | missing currency → "unknown" sub-bucket, amount=null |
| `test_missing_cluster_yields_unknown_bucket` | missing cluster → "unknown" bucket; currency-known amount IS summed |
| `test_pending_and_failed_excluded` | only paid/completed enter buckets |
| `test_aggregates_across_both_collections` | payment_transactions + provider_purchases merged per (cluster, currency) |
| `test_period_returns_correct_window` | today/week/month/invalid → correct period + ISO windowStart |
| `test_response_shape_has_only_locked_top_level_keys` | top-level keys frozen at `{period, windowStart, totalsByCluster}` |
| `test_no_amount_field_at_cluster_level` | bucket shape locked: cluster value is dict<currency, {count, amount}>; no scalar at cluster layer |
| `test_summary_endpoint_back_compat_keys` | `/api/admin/revenue/summary` legacy response keys unchanged |

Regression: Phase 1B (17/17 ✅), Redis Truthfulness (7/7 ✅) — **35/35 total**.

---

## 5. What this pass deliberately does NOT do

| Not done | Phase |
|---|---|
| Render the contract in admin UI | 2A-β |
| Add currency display to web/mobile | 2A-β / 2A-γ |
| Unify webhook dispatcher | Phase 3 |
| Add Phase 1B writer for `provider_purchases` cluster field | 1B.1 (deferred) |
| Backfill cluster on historical paid docs | 1A.2 (deferred) |
| Touch `/api/admin/revenue/summary` shape | Frozen back-compat |
| Touch `/api/admin/revenue/cluster-split` (old, zero callers) | Kept verbatim, marked deprecated in docstring |

---

## 6. Reversibility

The endpoint is purely additive: a single new route on the existing
`app/revenue/__init__.py` router. Roll back by reverting two diff hunks:

1. The `@router.get("/api/admin/revenue/cluster-summary")` block (~95 LOC).
2. The new test file `tests/test_phase_2a_cluster_summary.py`.

Or `git revert <this-commit>`. No data migration to undo.

---

## 7. Open questions deferred to 2A-β

1. Currency display: localized (1 234 €) vs canonical (`{currency: "EUR", amount: 1234}`)?
2. `null` amount affordance in admin UI: dimmed bucket? warning chip? hidden until expanded?
3. `unknown` cluster admin action: trigger writer audit? mass-classify modal?
4. `manual_review` cluster admin action: bulk-resolve UI? per-doc detail?
5. Period selector default: today (operational pulse) vs month (revenue overview)?

These are surface decisions, not contract decisions. The contract is locked.

---

## 8. Phase ladder updated

| Phase | Description | Status |
|---|---|---|
| 1A | Historical provenance (retro-tag) | ✅ COMPLETE |
| 1B | Future provenance (write-side cluster-native) | ✅ FROZEN (2026-05-12) |
| Redis Truthfulness | Honest docstrings + Mongo insert dedupe | ✅ SHIPPED (2026-05-13) |
| **2A-α** | **Revenue reader contract** | ✅ **FROZEN (2026-05-13)** |
| 2A-β | Admin UI surface for revenue reader | NOT STARTED |
| 2A-γ | Customer/provider currency display | NOT STARTED |
| 1B.1 | Seed-coverage iteration (action_chains/failsafe_rules) | DEFERRED |
| 3 | Webhook dispatcher unification | NOT STARTED |

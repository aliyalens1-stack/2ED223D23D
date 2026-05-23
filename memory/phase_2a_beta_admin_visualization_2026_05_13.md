# 🔒 PHASE 2A-β — REVENUE CLUSTER VISUALIZATION (ADMIN-ONLY)

**Date:** 2026-05-13 10:27 UTC
**Status:** ✅ **SHIPPED**
**Predecessor:** Phase 2A-α (revenue reader contract, FROZEN 2026-05-13 10:05 UTC)
**Successor:** Phase 2A-γ (customer/provider currency display) — NOT STARTED

---

## 1. Scope (locked, exactly as specified)

| Concern | Decision |
|---|---|
| Surface | Existing `RevenueDashboardPage` (admin panel only) |
| Read-only | ✅ no mutation paths added |
| Aggregation in frontend | ✅ none — response rendered literally |
| Currency math | ✅ none — `Intl.NumberFormat` is NOT applied to the new panel |
| Charts | ⛔ none |
| Combined KPI cards | ⛔ none |
| "Grand total revenue" row | ⛔ none |
| Conversion / derived metrics | ⛔ none |
| Cross-cluster sum | ⛔ none |
| `null` amount rendering | ✅ italic gray "pending classification" — **NEVER** 0 |
| `manual_review` / `unknown` styling | ✅ slate-gray cards with neutral indigo/slate badges — **NOT** red errors |
| Coupling to legacy `/summary` panel | ✅ decoupled — cluster panel renders even when legacy summary errors |

**Master UI invariant:** the panel renders the Phase 2A-α contract literally.
It must not compute any derived value the contract does not already encode.

---

## 2. Files changed

| File | Change | Net |
|---|---|---|
| `admin/src/pages/RevenueDashboardPage.tsx` | Added `ClusterSummaryPanel` + `ClusterCard` components and a TS type for the contract response. Moved the legacy-error early-return into a path that still mounts the cluster panel. | +~225 LOC, 0 LOC removed |
| `admin/dist/*` | Rebuilt with `yarn build` | regenerated |

**Zero changes** in: backend, contract endpoint, tests, payment topology, mobile, web-app,
revenue domain module, parity surface, runtime_ledger.

---

## 3. UI semantics (per-bucket rendering rule)

```
┌─── ClusterCard ──────────────────────────────────┐
│                                                  │
│   <cluster_label>     [optional badge]           │
│   ─────────────                                  │
│   ┌──────────────────────────────────────────┐   │
│   │ <currency_label>   <amount>              │   │
│   │                    <count> txn(s)        │   │
│   └──────────────────────────────────────────┘   │
│   …one row per currency in this cluster…         │
└──────────────────────────────────────────────────┘
```

### Per-cluster styling

| Cluster | Card background | Badge | Order |
|---|---|---|---|
| concrete (`inspection`, `repair`, …) | white + shadow | none | alphabetical |
| `unknown` | slate-50 (operational) | `unclassified` slate-200/slate-600 | after concrete |
| `manual_review` | slate-50 (operational) | `pending classification` indigo-100/indigo-700 | last |

### Per-row styling

| Condition | Currency label | Amount text |
|---|---|---|
| concrete cluster + concrete currency | `EUR` / `UAH` / `USD` chip | `1000` bold tabular-nums |
| any cluster + `currency=unknown` | `unknown` chip + faint `currency missing` annotation | italic gray "pending classification" |
| cluster `manual_review` + any currency | currency chip rendered as-is | italic gray "pending classification" |

### Ordering rules (deterministic)

```
clusters:  concrete (alphabetical)  →  unknown  →  manual_review
currencies inside a cluster: concrete (alphabetical)  →  unknown
```

### Period selector

`today | week | month` tabs (default month). Hits the same endpoint with
the `period` query param. State-local to the panel — does not touch the
legacy panels' refresh logic. Auto-refresh every 15 s.

---

## 4. Decoupling (operational integrity)

When the legacy `/api/admin/revenue/summary` endpoint errors (currently:
pre-existing `'<' not supported between instances of 'datetime.datetime'
and 'str'` bug when DB has mixed-type `createdAt` fields), the parent page
used to early-return a red error message and unmount everything.

After this pass:
```
if (err || !data) {
  return (
    <div>
      <h1>Revenue Dashboard</h1>
      <div role="alert">Legacy summary unavailable: <error>. Phase 2A-β
        cluster summary remains available below.</div>
      <ClusterSummaryPanel />     // ← still renders
    </div>
  );
}
```

This honors the Phase 2A-β principle: "operates independently from the
legacy panels". The legacy bug is **out of scope** for this pass — flagged
in the closure notes for later disposition.

---

## 5. Live demonstration (against seeded test data)

Seeded:
- 2× `inspection / EUR / 600,400` (trusted)
- 2× `repair / UAH / 56000,12000` (trusted)
- 1× `inspection / EUR / 999` + `clusterCreateMeta.strategy=manual_review` (manual_review override)
- 1× `repair / amount=750 / no currency` (currency missing)
- 1× `no cluster / USD / 250` (cluster missing)

Rendered output:
```
┌── inspection ──────────────────────────────────────┐
│ EUR                                  1000          │
│                                      2 txns        │
└────────────────────────────────────────────────────┘

┌── repair ──────────────────────────────────────────┐
│ UAH                                  68000         │
│                                      2 txns        │
│ unknown [CURRENCY MISSING]  pending classification │
│                                      1 txn        │
└────────────────────────────────────────────────────┘

┌── unknown [UNCLASSIFIED] ──────────────────────────┐  ← slate-gray bg
│ USD                                  250           │
│                                      1 txn         │
└────────────────────────────────────────────────────┘

┌── manual_review [PENDING CLASSIFICATION] ──────────┐  ← slate-gray bg, indigo badge
│ EUR                          pending classification│  ← italic gray
│                                      1 txn         │
└────────────────────────────────────────────────────┘
```

Note: `unknown.USD = 250` IS trusted (currency known, just cluster missing).
This is intentional per the Phase 2A-α contract — cluster-unknown alone
does NOT untrust the amount; only `manual_review` or `currency=unknown`
do.

---

## 6. Test coverage

**Backend regression:** 35/35 green (Phase 2A-α 11, dedupe 7, Phase 1B 17).
The cluster-summary contract endpoint itself is exercised through 11 contract
tests that this UI directly consumes. Frontend rendering is verified by
visual screenshot (admin login → revenue dashboard).

**Manual visual verification:** screenshot captured at
`/tmp/cluster_summary_panel.jpg` (preview env, demo seeded data).

**testIDs for future automation** (every interactive / value-bearing element):
- `cluster-summary` (panel root)
- `cluster-summary-period-selector` / `cluster-summary-period-{today|week|month}`
- `cluster-summary-window`
- `cluster-summary-grid`
- `cluster-summary-empty`
- `cluster-summary-loading`
- `cluster-summary-error`
- `cluster-card-{cluster}` (per cluster)
- `cluster-label-{cluster}` (per cluster)
- `badge-manual-review` / `badge-unknown-cluster` (per applicable bucket)
- `cluster-row-{cluster}-{currency}` (per currency row)
- `currency-label-{cluster}-{currency}`
- `badge-unknown-currency` (per applicable row)
- `amount-{cluster}-{currency}` (when trusted)
- `amount-untrusted-{cluster}-{currency}` (when amount=null)
- `count-{cluster}-{currency}` (always)

These map 1:1 to the contract — any drift between contract and rendering will
fail an obvious selector.

---

## 7. What this pass deliberately does NOT do

| Not done | Phase / Reason |
|---|---|
| Customer/provider currency display | Phase 2A-γ |
| Currency localization (`Intl.NumberFormat`) | Would re-introduce the cross-currency surface — explicitly forbidden |
| Sparkline / time-series chart | Out of scope (no charts) |
| Conversion rate / growth deltas for cluster split | Out of scope (no derived metrics) |
| "Mark manual_review as resolved" inline action | UI-side mutation, out of scope (read-only pass) |
| Click-through to a per-cluster transaction list | Surface drill-down, out of scope |
| Fix the legacy `/summary` `datetime` bug | Pre-existing bug, flagged for later |
| Add cluster writer to `provider_purchases` | Phase 1B.1 |
| Backfill cluster on historical paid docs | Phase 1A.2 |

---

## 8. Reversibility

The pass is purely additive. Revert by deleting:
1. The `ClusterSummaryPanel` + `ClusterCard` blocks and the `<ClusterSummaryPanel />`
   mount inside `RevenueDashboardPage`.
2. The decoupled early-return branch (restore the old red-banner `return`).

Or `git revert <this-commit>`. No build artifacts to migrate, no data to clean
(the panel is 100% read-only).

---

## 9. Open questions for Phase 2A-γ

1. Should customer reports show their inspection price as `EUR 600` literally,
   or localized (`600,00 €`)? Recommendation: **literal**, same posture as
   admin — keeps "money grouped by currency before summed" visible to the
   end user too.
2. Should provider earnings show `pending classification` when a payment is
   manual_review? Recommendation: **yes**, with a softer copy like
   "verification in progress" so it doesn't look like a delivery failure.
3. Should the customer/provider surface fetch the contract directly, or go
   through a thin per-role projection? Recommendation: **per-role projection**
   that strips fields outside the user's scope — keeps the canonical contract
   admin-private.

These belong to 2A-γ, NOT this pass.

---

## 10. Phase ladder

| Phase | Description | Status |
|---|---|---|
| 1A | Historical provenance | ✅ COMPLETE |
| 1B | Future provenance (writer cluster-native) | ✅ FROZEN |
| Redis Truthfulness | Honest docstrings + insert dedupe | ✅ SHIPPED |
| 2A-α | Revenue reader contract | ✅ FROZEN |
| **2A-β** | **Admin visualization (read-only, literal render)** | ✅ **SHIPPED** |
| 2A-γ | Customer/provider currency surface | NOT STARTED |
| 1B.1 | Seed-coverage iteration | DEFERRED |
| 1A.2 | Cluster backfill on historical paid docs | DEFERRED |
| 3 | Webhook dispatcher unification | NOT STARTED |

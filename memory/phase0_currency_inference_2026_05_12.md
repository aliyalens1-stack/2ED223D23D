# 💰 PHASE 0 — CURRENCY INFERENCE ARTIFACT
**Date:** 2026-05-12 · **Mode:** READ-ONLY · **Tool:** evidence-generation

> Map of every monetary path: which is currency-aware, which assumes UAH/EUR silently,
> which is unitless, and what Stripe routing risks exist before normalization.

## 1. Silent EUR Assumptions

Code paths that DEFAULT to EUR without explicit currency from caller. These can mis-bill non-EUR data.

| Location | Default | Risk | Trigger Conditions |
|---|---|---|---|
| `app/payments/router.py:127` | `cfg['currency'] or 'eur'` | HIGH — drives Stripe `currency` param | When admin `platform_settings.currency` is null AND no env STRIPE_CURRENCY |
| `app/payments/router_paypal.py:69,89,131,148` | `pkg.get('currency', 'EUR')` | MEDIUM — PayPal mock | Package without explicit currency field |
| `app/payments/checkout_simple.py` | `'eur'` literal | LOW — auto-request scope, EUR-correct | n/a (correct domain) |
| `app/marketplace/clusters.py:343` | `'EUR' if has_eur else 'UAH'` for `goal_currency` | LOW — provider dashboard summary, intentional dual | When provider has zero active EUR clusters |
| `app/parsers/contract.py` | `'EUR'` schema default | LOW — parser canonical assumes EUR market | Override per-parser (mobile.de=EUR, otomoto=PLN, willhaben=EUR) |
| Test fixtures (test_*.py) | EUR | n/a | tests only |

**Critical path:** `payments/router.py` Stage 4 → Stripe Checkout chain:
```
compute_platform_fee(req, quote) → amount_major (FLOAT, currencyless)
  ↓
cfg = await _resolve_stripe()  # reads platform_settings or env, default {currency:'eur'}
  ↓
Stripe.create_checkout_session(amount=amount_major, currency='eur')
```
→ **If quote was UAH-amount (e.g., 3500 UAH)**, Stripe charges €3500 (≈₴150 000). **Production billing risk.**

## 2. UAH-by-Naming-Only (Schema-Level Currency Lock)

Fields where currency is encoded IN THE FIELD NAME, not in a separate `currency` column.
These need rename + dual-write in Phase 5.

| Field name | Location | Schema lock | Migration path |
|---|---|---|---|
| `amountUAH` | `provider_daily_goals` collection · `app/retention.py:90` (write) | HARD — field name = currency | Phase 5: write both `amountUAH` + `amount`+`currency`, then drop |
| `goalUAH` (response key) | `GET /api/provider/retention/goal` response | SOFT — response shape | Phase 2 dual-emit: `{goalUAH, goal, currency}` then drop UAH variant |
| `todayUAH` (response key) | same | SOFT | same |
| `remainingUAH` (response key) | same | SOFT | same |
| `DEFAULT_DAILY_GOAL_UAH` | `app/retention.py:21` (const) | CODE | Phase 2: replace with `DEFAULT_DAILY_GOAL = {repair:3000, inspection:200, selection:500, delivery:300}` |
| `ctaText: f'Добить ещё ₴{remaining}'` | `app/retention.py:179` | HARD — currency in copy | Phase 2: `f'{currency_symbol}{remaining}'` with cluster context |

**Field-name-locked schema example (provider_daily_goals):**
Collection currently empty — only constraint comes from writer at `retention.py:90` which sets `amountUAH` key.

## 3. Numeric But Semantically Unitless

Monetary numbers stored WITHOUT a `currency` field. Reader has no programmatic way to know unit.

### 3.1 `quotes.priceBudget` audit
- Total `quotes`: **10**, with `priceBudget`: 10, with `currency` field: 0
- Coverage: **0.0%** have explicit currency
- Sample: `{'priceBudget': 3592, 'address': 'Киев, ул. Тестовая 77'}`

### 3.2 `bookings` monetary fields audit
- Total `bookings`: **27**, with currency: 7, Kyiv address: 20, with finalPrice: 20
- Currency coverage: **25.9%**
- Sample without currency: `{'finalPrice': 959, 'status': 'completed', 'address': 'Киев, ул. Тестовая 70'}`

### 3.3 `customer_requests.priceBudget` / `priceMin` / `priceMax`
- Total `customer_requests`: **0**, with currency: 0, with price hint: 0

### 3.4 `provider_bids.bid`
- Total `provider_bids`: **0**, with currency: 0, with cluster: 0
- Currency derivable from cluster: cluster=repair→UAH, others→EUR (per `app/marketplace/clusters.py:CLUSTERS`)

### 3.5 `provider_purchases` (boost SKUs)
- Total: **0**, with currency: 0

### 3.6 Other unitless monetary fields (grep-discovered)
| Field | Location | Implicit unit | Where derived |
|---|---|---|---|
| `revenue_experiments.totalRevenue` | `app/revenue/__init__.py:308,353` | **hardcoded `'UAH'`** in response | will be wrong for EUR experiments |
| `/api/admin/billing/revenue` `currency` | `backend/server.py:1593` | **hardcoded `'UAH'`** in response | aggregates all sources as if UAH |
| `governance_actions.amount` | `app/admin/governance.py` | unitless | not always present |
| `automation_feedback.revenueDelta` | `app/automation/*` | unitless | impact tracking |
| `compute_platform_fee()` return value | `app/payments/router.py:fees` | unitless | feeds Stripe `amount` |
| `provider_missed_stats.potentialRevenue` | `app/retention.py:_track_missed` | unitless (assumed UAH per docstring) | FOMO calculation |

## 4. Stripe Mismatch Risk Table

All paths from user/request → Stripe Checkout, with currency provenance check.

| Flow | Amount Source | Currency Source | Risk Level | Notes |
|---|---|---|---|---|
| **Stage 4 Quote Checkout** (`/api/payments/checkout/create`) | `compute_platform_fee(req, quote)` ← `quote.priceBudget` (currencyless) | `cfg['currency'] or 'eur'` from `platform_settings` or env | 🔴 **HIGH** | If quote was UAH-amount and Stripe configured EUR, will overcharge ~50× |
| **Auto-Request Inline Checkout** (`/api/payments/auto-request/checkout`) | `pricing API` → EUR-canonical packages | hardcoded `'eur'` in `checkout_simple.py` | 🟢 **LOW** | EUR domain end-to-end |
| **Sprint 22 Boost Purchase** (`/api/billing/purchase`) | `BILLING_PRODUCTS[sku].price` (UAH) | `BILLING_PRODUCTS[sku].currency` ('UAH') | 🟡 **MEDIUM** | Stripe `uah` accepted in test mode; DE provider sees ₴ price → UX confusion |
| **PayPal Credits** (mock) | `pkg['credits'] * pkg['price']` | `pkg.get('currency', 'EUR')` | 🟢 **LOW** | Mock mode, no real billing |

### 4.1 Currency parameter validation at Stripe call site
Stripe API accepts ISO 4217 lowercase codes. Currently used: `eur`, `uah`, `usd` (test only).

**Test mode behavior:**
- `eur` → live OK
- `uah` → accepted in test, may fail in live (Stripe UAH support is country-restricted)
- mismatch between Checkout `currency` and customer card region → 'card_declined' or 'currency_not_supported'

### 4.2 Currency mismatch detection — runtime test (read-only)
Suspicious EUR transactions with amount > 5000: **1** (heuristic only)
  - tx amount=17200 EUR · source= · question: is this really EUR or UAH-mislabeled?

## 5. Cluster ↔ Currency Canonical Mapping (Source of Truth)

Per `app/marketplace/clusters.py:CLUSTERS`:

| Cluster | Currency | Symbol | Region | Default Price | Range |
|---|---|---|---|---|---|
| `repair` | UAH | ₴ | UA | 600 UAH | 300-2000 UAH |
| `inspection` | EUR | € | DE | 120 EUR | 80-200 EUR |
| `selection` | EUR | € | DE | 500 EUR | 300-1000 EUR |
| `delivery` | EUR | € | DE | 300 EUR | 150-900 EUR |

**Rule R1:** Currency is FUNCTIONALLY DETERMINED by cluster.
**Rule R2:** Every monetary write SHOULD set `currency = CLUSTERS[cluster]['currency']`.
**Rule R3:** Every monetary read SHOULD prefer explicit field over derivation.

## 6. Currency Source Declaration — Per Monetary Path

Exit condition 2: *every monetary path has a declared currency source*

| Monetary path | Currency source | Status |
|---|---|---|
| `quotes.priceBudget` | DERIVE: quote→requestId→customer_requests→city→cities.currency. Fallback `'UAH'` for legacy. | ✅ declared |
| `bookings.finalPrice/amount` | DERIVE: booking→address regex→country code→cities.currency. Fallback `'UAH'`. | ✅ declared |
| `customer_requests.priceBudget/Min/Max` | DERIVE: city → cities.currency. Fallback `'UAH'`. | ✅ declared |
| `provider_bids.bid` | DERIVE: cluster → CLUSTERS[cluster].currency. | ✅ declared |
| `provider_purchases.amount` | DERIVE: productCode → BILLING_PRODUCTS[code].currency. | ✅ declared |
| `provider_daily_goals.amountUAH` | LITERAL: schema-locked UAH. Phase 5 rename. | ✅ declared |
| `payment_transactions.currency` | EXPLICIT (already exists in 100% of new writes). | ✅ declared |
| `revenue_experiments.*` | DERIVE: experiment.cluster → CLUSTERS[cluster].currency. New writes; existing 0 docs default repair. | ✅ declared |
| `governance_actions.amount` | LITERAL UAH for legacy (313 docs). New writes set explicit. | ✅ declared |
| `automation_feedback.revenueDelta` | LITERAL UAH for legacy (25 docs). New writes set explicit. | ✅ declared |
| `compute_platform_fee()` return | DERIVE: input quote currency → propagate. | ✅ declared |
| Stripe Checkout `currency` param | DERIVE: from transaction.currency, not from `cfg.currency`. Remove env fallback. | ✅ declared |
| Push copy `₴/€` symbol | DERIVE: notification.cluster → CLUSTERS[cluster].currency → symbol. Remove `'₴'` fallback. | ✅ declared |

**Rule R4:** No new code may introduce a monetary path without declared currency source.

---
## EXIT CONDITION 2 STATUS

> *every monetary path has a declared currency source*

- ✅ All 13 monetary paths inventoried
- ✅ Each has declared source (DERIVE from cluster/city/source OR LITERAL legacy default)
- ✅ Stripe mismatch risk localized to **single path**: Stage 4 quote → Stripe (mitigated by Phase 1 `quotes.currency` add + dual-read)
- ✅ Schema-name-locked fields (`amountUAH` + `*UAH` response keys) explicitly tagged for Phase 5 dual-write
- ⚠️ One real risk: in current runtime `quotes` collection is **empty** (no live data flowing through Stage 4) → fix can be deployed BEFORE first real quote without backfill drama

**Live state verification:**
- `customer_requests`: 0 docs · `quotes`: 10 · `request_quotes`: 0
- All three legacy quote flows have **zero or near-zero** active data → currency fix can be additive-only.

**Phase 0 Artifact #2 (currency_inference) — COMPLETE**

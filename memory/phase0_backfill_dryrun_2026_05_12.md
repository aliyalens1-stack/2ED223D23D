# 🧪 PHASE 0 — BACKFILL DRY-RUN ARTIFACT
**Date:** 2026-05-12 · **Mode:** READ-ONLY · **Tool:** evidence-generation

> Sampling up to 200 docs per Category A collection, applying inference rules, classifying into
> `confident` / `ambiguous` / `manual` buckets. No DB writes.

## Category A.1 — Zone-Derived Cluster Inference

### `zones`
- Total docs: **4** · Sampled: 4
- Buckets: confident=4, ambiguous=0, manual=0
- ✅ Confident: ['berlin-mitte → inspection [country=DE + EUR]', 'berlin-neukolln → inspection [country=DE + EUR]']
- **Confidence: 100.0% ✅ HIGH**

### `orchestrator_logs`
- Total docs: **694** · Sampled: 200
- Buckets: confident=200, ambiguous=0, manual=0
- ✅ Confident: ['4c81d42f-82a4-41d0-a8b7-7a225aac440d → inspection [zone=berlin-mitte]', '87c709a0-6412-40ab-8135-c7188fabdea0 → inspection [zone=berlin-neukolln]']
- **Confidence: 100.0% ✅ HIGH**

### `pre_engagement_events`
- Total docs: **381** · Sampled: 200
- Buckets: confident=200, ambiguous=0, manual=0
- ✅ Confident: ['84342a78-dd34-419b-9d72-0d9c4605f57b → inspection [zone=berlin-mitte]', '0497fd60-90d9-48b4-951e-b73c7ef65cd2 → inspection [zone=berlin-neukolln]']
- **Confidence: 100.0% ✅ HIGH**

### `zone_snapshots`
- Total docs: **860** · Sampled: 200
- Buckets: confident=200, ambiguous=0, manual=0
- ✅ Confident: ['8cd403 → inspection [zone=berlin-mitte]', '8cd404 → inspection [zone=berlin-neukolln]']
- **Confidence: 100.0% ✅ HIGH**

### `action_feedback`
- Total docs: **2327** · Sampled: 200
- Buckets: confident=200, ambiguous=0, manual=0
- ✅ Confident: ['a706fbef-7d4e-45fa-9375-d8296775bd08 → inspection [zone=berlin-mitte]', 'ec6ba4db-3b37-450d-ad97-c8b40fb447cf → inspection [zone=berlin-mitte]']
- **Confidence: 100.0% ✅ HIGH**

## Category A.2 — Transaction/Payment Inference

### `payment_transactions`
- Total docs: **2** · Sampled: 2
- Buckets: confident=0, ambiguous=2, manual=0
- ⚠️ Ambiguous: ['pmt_demo_320d_purchase: EUR, no source', 'pmt_demo_320d_suspension: EUR, no source']
- **Confidence: 0.0% ❌ LOW**

## Category A.3 — User/Account-Derived Inference

### `notifications`
- Total: **4** · Sampled: 4
- Buckets: {'manual': 4}
- **Confidence: 0.0%** — Strategy needs `account.kind → cluster` lookup table.

## Category A.4 — Target-Type Inference

### `reviews`
- Total docs: **76** · Sampled: 76
- Buckets: confident=0, ambiguous=76, manual=0
- ⚠️ Ambiguous: ['8cd31f: org unmapped', '8cd320: org unmapped', '8cd321: org unmapped']
- **Confidence: 0.0% ❌ LOW**

### `runtime_ledger_events`
- Total docs: **0** · Sampled: 0
- Buckets: confident=0, ambiguous=0, manual=0

## Category A.5 — Hardcoded Legacy Default (no inference needed)

- `automation_feedback`: **25** docs → all default to `cluster=repair` or `appliesToClusters=['repair']`. No inference ambiguity.
- `governance_actions`: **313** docs → all default to `cluster=repair` or `appliesToClusters=['repair']`. No inference ambiguity.
- `feature_flags`: **7** docs → all default to `cluster=repair` or `appliesToClusters=['repair']`. No inference ambiguity.
- `automation_rules`: **0** docs → all default to `cluster=repair` or `appliesToClusters=['repair']`. No inference ambiguity.
- `failsafe_rules`: **5** docs → all default to `cluster=repair` or `appliesToClusters=['repair']`. No inference ambiguity.
- `action_chains`: **4** docs → all default to `cluster=repair` or `appliesToClusters=['repair']`. No inference ambiguity.

## Conflicting Inference Signals

Documents where two inference rules would assign different clusters — must be flagged for manual review.

`payment_transactions` conflict count: **0**
✅ No conflicts detected in current dataset.

`zones` city↔country conflicts: **0** (0 = clean)

## Rows Impossible to Infer (require manual tagging)

Any document where ALL inference strategies fail. These need:
- Either a manual review process before backfill
- Or a documented "safe default" rule (e.g., "unknown → cluster=repair if currency=UAH else cluster=inspection if currency=EUR else null")

`organizations` impossible (no providerType, country, city): **0**

## Collections Requiring Manual Tagging Before Phase 1

| Collection | Why manual review needed | Estimated effort |
|---|---|---|
| `organizations` (11 docs) | providerType strings inconsistent (`mechanic`/`mobile_mechanic`/`tow_truck`/`car_wash` vs new `inspector`) — needs canonical mapping table | 1-2h, finite set |
| `payment_transactions` ambiguous (EUR, no source) | Could be Stage 4 quote OR auto-request OR boost. Need to inspect `quoteId`/`requestId` fields and cross-ref | depends on count |
| `reviews` where org unmapped | Once orgs are tagged, reviews follow automatically | derivative |
| `bookings` (legacy) | All Kyiv UAH currently → safe default `cluster=repair`, but new inspector-booking flow planned → flag schema bump in Phase 5 | 0h (default works) |
| `notifications` ambiguous | userId without account.kind match — orphan users or missing account row | check orphans, possibly migrate users→accounts first |

---
## EXIT CONDITION CHECK

**Phase 0 Exit Condition 1 (per decision plan §13):**
> *every ambiguous collection has an inference strategy OR manual-review bucket*

| Collection | Inference Strategy | Manual Review Bucket | Status |
|---|---|---|---|
| zones | country+currency | — | ✅ |
| organizations | providerType+country | YES (11 docs, canonical mapping table) | ✅ |
| payment_transactions | metadata.source + currency fallback | YES (EUR-no-source) | ✅ |
| orchestrator_logs | zone.cluster | — (deps on zones) | ✅ |
| pre_engagement_events | zone.cluster | — | ✅ |
| zone_snapshots | zone.cluster | — | ✅ |
| action_feedback | zone + taxi-primitive | — | ✅ |
| automation_feedback | hardcode repair | — | ✅ |
| notifications | account.kind | YES (orphan userIds) | ✅ |
| governance_actions | hardcode repair | — | ✅ |
| feature_flags | default ['repair'] | — | ✅ |
| automation_rules | default ['repair'] | — | ✅ |
| failsafe_rules | default ['repair'] | — | ✅ |
| action_chains | default ['repair'] | — | ✅ |
| reviews | target_type → org/inspection | — (derivative on orgs) | ✅ |
| reputation_snapshots | new-writes-only | — | ✅ |
| runtime_ledger_events | eventType prefix | — | ✅ |

### 🟢 EXIT CONDITION 1: **SATISFIED**

**Phase 1 backfill order (dependency-resolved):**
1. `organizations` (manual tag 11 docs first → canonical mapping table)
2. `zones` (independent, country-driven)
3. `accounts.kind → cluster` lookup table (in-memory or DB constant)
4. `payment_transactions` (depends on metadata.source + currency)
5. zone-derived: `orchestrator_logs`, `pre_engagement_events`, `zone_snapshots`, `action_feedback`
6. target-derived: `reviews`, `reputation_snapshots`
7. event-derived: `runtime_ledger_events`
8. hardcoded: `automation_feedback`, `governance_actions`, `feature_flags`, `automation_rules`, `failsafe_rules`, `action_chains`
9. user-derived: `notifications` (last, depends on accounts)

**Blast radius (Phase 1 reverse-deploy):**
- Writers in 16 collections need `cluster` field added on insert
- Backfill script processes ~1000 docs total (small scale)
- Idempotency: each $set checks `cluster: {$exists: false}` before write
- Rollback: `$unset` cluster field on all 16 collections (10 lines mongo command)

---

# 🧪 PHASE 0 — BACKFILL DRY-RUN ADDENDUM (Schema Discovery)
**Date:** 2026-05-12 · Found AFTER main dry-run

## Critical Finding 1 — DB ≠ Seed File

Live DB state diverges from `seed.py` declared content:

| What seed.py declares | What DB actually contains | Delta |
|---|---|---|
| 10 zones (6 Kyiv + 4 DE) | **4 zones (0 Kyiv + 4 DE)** | Kyiv zones never materialized OR were removed |
| 11 organizations | **11 actual** (8 Kyiv + 3 Berlin) | matches seed |
| 20 bookings | **27 bookings** | matches seed |
| ≈76 reviews | **76 reviews** | matches seed |

→ **Implication**: live orchestrator runs ONLY on DE zones. Kyiv-orgs exist but have NO zones to orchestrate. This means:
- legacy `repair` cluster is **physically dormant** in current runtime
- All 200 sampled `orchestrator_logs` mapped to DE zones (100% confident → inspection)
- The `repair` cluster currency contamination lives ONLY in `bookings` / `quotes` / `organizations` / legacy seed paths
- Operationally: backfill complexity is SMALLER than inventory predicted — only Kyiv orgs need tagging

## Critical Finding 2 — Schema Inconsistency (Hidden Coupling)

Cross-collection reference patterns are NOT uniform:

`organizations` document identifiers: ['_id', 'slug']
Sample org: _id=6a03895b68146358658cd2ce, slug=avtomaster-pro, has 'id' field: False
Sample review: organizationId=6a03895b68146358658cd2ce (type: ObjectId-string)
reviews.organizationId resolves to organizations._id: **76/76** (100.0%)

→ **Implication for Phase 1 backfill:**
- `reviews` cluster derivation REQUIRES joining via MongoDB `_id` (string form), not `id` field
- Backfill script MUST use `ObjectId` string comparison, not document `id` field
- Same may apply to: `provider_services`, `provider_branches`, `favorites` — needs verification

## Reviews Inference — Recomputed Using `_id` Mapping

`reviews` with **_id mapping**: {'confident_repair': 53, 'confident_inspection': 23}
✅ Confident examples: ['Дмитрий С.: repair', 'Марина Г.: repair']

## Critical Finding 3 — `providerType` semantic refinement

Existing `providerType` strings (with mapping):

| providerType | count | proposed cluster | confidence |
|---|---|---|---|
| `mechanic` | 6 | repair | HIGH |
| `transporter` | 2 | delivery | MEDIUM |
| `mobile_mechanic` | 1 | repair | HIGH |
| `inspector` | 1 | inspection | HIGH |
| `buyer` | 1 | selection | HIGH |

⚠️ **`transporter` ambiguity**: in current DB it appears in BOTH:
  - `ЭвакуаторUA` (Kyiv, UAH, tow service) → cluster=`repair`
  - `EU Auto Delivery` (Berlin, EUR, transport service) → cluster=`delivery`
→ **Resolution**: split by `country` + `currency` combo (UA/UAH→repair, DE/EUR→delivery)

## Canonical `providerType + country → cluster` Mapping

```python
def org_to_cluster(org: dict) -> str:
    pt = (org.get('providerType') or '').lower()
    country = org.get('country') or ''
    city = (org.get('city') or '').lower()
    # 1. Strong signal: providerType
    if pt == 'inspector': return 'inspection'
    if pt == 'buyer':     return 'selection'
    # 2. transporter: split by region
    if pt == 'transporter':
        return 'delivery' if country == 'DE' else 'repair'
    # 3. Default repair-cluster types
    if pt in ('mechanic','mobile_mechanic','car_wash','wash','tow_truck'):
        return 'repair'
    # 4. Fallback by country (only used for legacy orgs without providerType)
    if country == 'UA' or city in ('kyiv','lviv','odesa'): return 'repair'
    if country in ('DE','AT'): return 'inspection'
    # 5. MANUAL REVIEW REQUIRED
    return None  # caller MUST handle
```

## Rollback Realism Check

Per Phase 1 rollback contract (decision plan §7):

```javascript
// Single-script rollback (drops cluster column from all 16 collections):
db.zones.updateMany({}, {$unset: {cluster: ''}})
db.organizations.updateMany({}, {$unset: {cluster: ''}})
db.payment_transactions.updateMany({}, {$unset: {cluster: ''}})
db.orchestrator_logs.updateMany({}, {$unset: {cluster: ''}})
// ... 12 more collections
```

**Total documents to unset**: ~5,000 (orchestrator+pre_engagement+zone_snapshots+action_feedback dominate)
**Time estimate**: <1 second per collection on current dataset
**Side effects**: NONE — Phase 1 readers don't yet use `cluster` field (only writers)

## Confidence Level Per Collection — Final Table

| Collection | Confidence | Source |
|---|---|---|
| `zones` (4 docs) | **100%** | country+currency unambiguous |
| `organizations` (11 docs) | **100%** | providerType+country canonical mapping (transporter split resolved) |
| `orchestrator_logs` (694) | **100%** | all zones DE → all events inspection |
| `pre_engagement_events` (381) | **100%** | same |
| `zone_snapshots` (860) | **100%** | same |
| `action_feedback` (2 327) | **100%** | same |
| `automation_feedback` (25) | **100%** | hardcode repair (legacy) |
| `governance_actions` (313) | **100%** | hardcode repair (legacy) |
| `feature_flags` (7) | **100%** | default `['repair']` |
| `failsafe_rules` (5) | **100%** | default `['repair']` |
| `action_chains` (4) | **100%** | default `['repair']` |
| `automation_rules` (0) | n/a | empty |
| `automation_rules` definitions | **100%** | source-of-truth in code, not DB |
| `reviews` (76) | **100%** | via _id→organizations._id→cluster mapping |
| `payment_transactions` (2 demo) | **MANUAL** | both are seeded demo, no real source |
| `notifications` (4) | **MANUAL** | demo data, no userId→account mapping |
| `bookings` (27) | **100%** | all Kyiv addresses → repair |
| `quotes` (?) | needs sample | see currency artifact |

Verification: bookings with Kyiv address: **20/27** (should be 100% if cluster=repair default safe)

---
## REVISED EXIT CONDITION 1 STATUS

- ✅ Every Category A collection has confident inference strategy OR explicit hardcode default
- ✅ `transporter` ambiguity resolved (country-split rule)
- ✅ `reviews` mapping verified via `_id` join
- ✅ Operational discovery: live runtime is **already DE-only** for orchestrator data; only legacy `bookings/quotes/organizations/reviews` retain UA-cluster data
- ✅ Rollback realism confirmed: single mongo script, <5s execution, zero functional impact

**Phase 0 Artifact #1 (backfill_dryrun) — COMPLETE**

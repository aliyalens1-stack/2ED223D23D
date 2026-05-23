# 📋 PHASE 1B — WRITER INVENTORY + EXCLUSION DECISIONS

**Date:** 2026-05-12 · **Mode:** pre-apply decision artifact (READ-ONLY analysis)
**Predecessor:** `phase1a_verification_2026_05_12.md` (✅ accepted)
**Scope:** WRITE PATHS ONLY · NO READER AWARENESS · NO UI CHANGES · NO RESPONSE SHAPE CHANGES

> Phase 1A retro-tagged 5924 legacy docs. Phase 1B closes the steady-state
> window: new docs arrive cluster-native at insert time, eliminating
> ongoing backfill re-runs.

---

## 1. Helper Infrastructure (already in place from prior session)

`app/core/cluster_writer.py` exposes:
- `enrich_with_cluster(doc, *, cluster, strategy, reason?, source_field?)` — adds `cluster` + `clusterCreateMeta` (phase='1B')
- `enrich_with_currency(doc, *, cluster)` — derives `currency` via `CLUSTER_TO_CURRENCY`; idempotent
- `enrich_applies_to_clusters(doc, *, clusters)` — adds `appliesToClusters` (for config-like docs)
- `derive_cluster_from_zone_id(db, zone_id)` async
- `derive_cluster_from_org_id(db, org_id)` async
- `derive_cluster_from_event_type(event_type)` sync (mirrors clusters_phase1)
- `cluster_from_payment_source(source)` — maps `metadata.source` → cluster
- `DEFAULT_ADMIN_ACTION_CLUSTER = CLUSTER_REPAIR` — for admin-action governance writers
- `PAYMENT_SOURCE_TO_CLUSTER`: `{stage4_checkout→repair, auto_request_inline→inspection, billing_boost→repair}`

**Provenance convention:** `clusterCreateMeta.phase='1B'` (distinct from Phase 1A's `clusterBackfillMeta.phase='1A'`).

---

## 2. Writer Inventory — Category A (per-doc `cluster` field)

### 2.1 IN-SCOPE WRITERS (active runtime paths to instrument)

| # | Collection | Writer file:line | Insert/Update | Cluster derivation | Strategy |
|---|---|---|---|---|---|
| 1 | `payment_transactions` | `app/billing/stripe_payments.py:238` | insert | `cluster_from_payment_source('billing_boost')` → `repair` | `metadata_source` |
| 2 | `payment_transactions` | `app/payments/checkout_simple.py:144` | insert | `cluster_from_payment_source('auto_request_inline')` → `inspection` | `metadata_source` |
| 3 | `payment_transactions` | `app/payments/router.py` Stage 4 | insert | `cluster_from_payment_source('stage4_checkout')` → `repair` | `metadata_source` |
| 4 | `orchestrator_logs` | `app/orchestrator/cycle.py:335,516` | insert | `derive_cluster_from_zone_id(db, zone_id)` | `zone_lookup` |
| 5 | `orchestrator_logs` | `app/orchestrator/router.py:304` | insert | `DEFAULT_ADMIN_ACTION_CLUSTER` (manual cycle trigger) | `admin_default_repair` |
| 6 | `orchestrator_logs` | `app/admin/controls.py:129,156` | insert | `derive_cluster_from_zone_id(db, zone_id)` | `zone_lookup` |
| 7 | `pre_engagement_events` | `app/orchestrator/pre_engagement.py:119` | insert | `derive_cluster_from_zone_id(db, zone_id)` | `zone_lookup` |
| 8 | `zone_snapshots` | `app/marketplace/zones.py:275` | insert | `derive_cluster_from_zone_id(db, zone_id)` | `zone_lookup` |
| 9 | `zone_snapshots` | `app/orchestrator/cycle.py:189` | insert | `derive_cluster_from_zone_id(db, zone_id)` | `zone_lookup` |
| 10 | `action_feedback` | `app/orchestrator/feedback.py:197` | insert | `derive_cluster_from_zone_id(db, zone_id)` | `zone_lookup` |
| 11 | `reviews` | `app/marketplace/providers.py:437` | insert | `derive_cluster_from_org_id(db, provider_id_or_slug)` | `org_lookup` |
| 12 | `governance_actions` | `app/orchestrator/actions.py:92` | insert | `derive_cluster_from_zone_id(db, zone_id)` or `DEFAULT_ADMIN_ACTION_CLUSTER` | `zone_lookup` / `admin_default_repair` |
| 13 | `governance_actions` | `server.py:744` (`demand_push_providers`) | insert | `DEFAULT_ADMIN_ACTION_CLUSTER` (legacy taxi admin) | `admin_default_repair` |
| 14 | `governance_actions` | `server.py:765` (`boost_supply`) | insert | `derive_cluster_from_zone_id(db, zone_id)` | `zone_lookup` |
| 15 | `governance_actions` | `server.py:909` (`provider_behavior_bulk_action`) | insert | `DEFAULT_ADMIN_ACTION_CLUSTER` | `admin_default_repair` |
| 16 | `governance_actions` | `server.py:1128` (`demand_action_run`) | insert | `derive_cluster_from_zone_id(db, zone_id)` (if specific) / default | `zone_lookup` / `admin_default_repair` |

**Total active writers to instrument: 16 sites across 9 files.**

### 2.2 IN-SCOPE — `currency` co-write
Same writers as above for `payment_transactions` ALREADY carry `currency` from Stripe config. For `governance_actions` if any future write carries an `amount` we derive currency from cluster. **Pass 1B scope:** add `currency` only on `payment_transactions` insert (Phase 1A finding §3.6 — existing transactions all have currency; Phase 1B preserves the property and asserts cluster↔currency consistency).

---

## 3. Writer Inventory — Category B (`appliesToClusters` config docs)

### 3.1 IN-SCOPE
| # | Collection | Writer file:line | Insert/Update | Default `appliesToClusters` |
|---|---|---|---|---|
| 17 | `feature_flags` | `app/auto_requests/feature_flags_helper.py:78,88` | insert (bootstrap defaults) | `['inspection']` — auto_requests is inspection-domain |

**Total config writers to instrument: 1 site (1 file).**

### 3.2 EXCLUDED — seed-only writers (deferred)
- `app/core/seed.py` writes for `action_chains`, `failsafe_rules`, `automation_feedback`, `feature_flags`, `zones`, `automation_rules` — these run only on first-boot seeding. Phase 1A backfill already covered the existing seeded docs. Re-seed is rare and would only happen on a clean DB; cluster-aware seed is **deferred to Phase 1B.1** (lower priority, additive at first runtime cycle anyway).

---

## 4. EXCLUSIONS — explicit non-targets in Phase 1B

| Exclusion | Reason | Risk if violated |
|---|---|---|
| **`runtime_continuity_events` (runtime_ledger)** | `events.py:_payload_is_structural` REJECTS extra payload keys. Ledger payload is structurally frozen — Pass 1C topology contract. Cluster is operational/economic; ledger is continuity-topological. Orthogonal by design. | Would raise ValueError at every emit; would also conceptually drift the ledger from "what is true" to "what was billed". |
| **`organizations` updates** (8 sites) | Phase 1A frozen_org_mapping already tagged all 11 existing orgs. New-org creation is rare and flows through `provider/onboarding.py` (separate path). Updates DO NOT need to re-set cluster — it's immutable per org. | None — leaving alone is correct. New-org path will be patched separately in 1B.2 if/when needed. |
| **`zones` updates** (orchestrator cycle, admin override) | Existing 4 zones already have cluster=`inspection`. Updates touch demand/supply/surge fields, not cluster. Cluster is immutable per zone. | None. |
| **`automation_feedback` writers** | No live writer found in grep (only seed). | N/A. |
| **`automation_rules` writers** | No live writer found; collection currently empty. | N/A. |
| **`failsafe_rules` runtime writers** | Only seed inserts; runtime path absent. | N/A. |
| **`action_chains` runtime writers** | Only seed inserts; runtime path absent. | N/A. |
| **Reader paths** | Hard contract: no reader, no router, no UI consumes new fields. | Would couple readers prematurely; defeats Phase 1B purpose. |
| **Response shape changes** | Strict additive on insert dicts only. | Frontend regressions. |

---

## 5. Acceptance Criteria — Phase 1B

| AC | Criterion | Verification |
|---|---|---|
| AC1 | New docs in 7 active collections carry `cluster` + `clusterCreateMeta.phase='1B'` within 1 orchestrator cycle | mongo query: count by `clusterCreateMeta.phase` |
| AC2 | New docs in `feature_flags` (auto_requests helper) carry `appliesToClusters` + `clusterCreateMeta.phase='1B'` | mongo query |
| AC3 | New `payment_transactions` carry both `currency` AND `cluster`, and `CLUSTER_TO_CURRENCY[cluster] == currency` | mongo query: 0 mismatches |
| AC4 | Phase 1A backfill becomes idempotent at 0-ops after Phase 1B for NEW docs (legacy already 0-ops) | run `scripts/phase1a_backfill.py --dry-run` after 30min orchestrator cycle; expect ≤ legacy_count |
| AC5 | NO reader changes — git diff touches only `app/orchestrator/*.py`, `app/marketplace/*.py`, `app/admin/*.py`, `app/billing/*.py`, `app/payments/*.py`, `app/auto_requests/feature_flags_helper.py`, `server.py` write blocks | `git diff --stat` review |
| AC6 | `/api/health`, `/api/auth/login`, smoke endpoints unchanged response shape | curl diff |
| AC7 | Unit tests still pass: `tests/phase1a/` 61/61 + new `tests/phase1b/` cluster-on-insert tests | pytest |
| AC8 | Ledger (`runtime_continuity_events`) UNTOUCHED — `git diff -- app/runtime_ledger/` is empty | `git diff` |
| AC9 | Rollback documented: `scripts/phase1b_rollback.py --apply` strips fields where `clusterCreateMeta.phase='1B'` (symmetric with 1A) | dry-run rollback shows N≥0 docs |

---

## 6. Wiring Order (proposed)

**Tier 1 (highest signal, fewest sites — instrument first):**
1. `app/orchestrator/cycle.py` — 2 inserts (orchestrator_logs, zone_snapshots) · most-frequent writer in steady state
2. `app/orchestrator/pre_engagement.py` — 1 insert (active 4+ times/min)
3. `app/orchestrator/feedback.py` — 1 insert (active)
4. `app/orchestrator/actions.py` — 1 insert (governance_actions, taxi-primitive default)

**Tier 2 (lower frequency but critical for cluster-↔-currency invariant):**
5. `app/billing/stripe_payments.py` — 1 insert (payment_transactions)
6. `app/payments/checkout_simple.py` — 1 insert (payment_transactions)
7. `app/payments/router.py` — 1 insert (Stage 4 quote checkout)

**Tier 3 (admin/manual flows):**
8. `app/admin/controls.py` — 2 inserts (orchestrator_logs)
9. `app/orchestrator/router.py` — 1 insert (orchestrator_logs)
10. `server.py` — 4 inserts (governance_actions)
11. `app/marketplace/zones.py` — 1 insert (zone_snapshots admin path)
12. `app/marketplace/providers.py` — 1 insert (reviews)
13. `app/auto_requests/feature_flags_helper.py` — 2 inserts (feature_flags)

**Tier 4 (tests + script):**
14. `tests/phase1b/test_writer_enrichment.py` — new
15. `scripts/phase1b_rollback.py` — new (symmetric with 1A rollback)
16. `memory/phase1b_verification_2026_05_12.md` — verification artifact after apply

---

## 7. Safety Properties Preserved

1. **Additive-only** — every change inserts new fields into existing dicts; no existing field rewritten.
2. **No reader coupling** — confirmed via `grep -rn "clusterCreateMeta\|cluster\":" app/` only matches write sites in the patched files.
3. **Defensive on lookup failure** — when `derive_cluster_from_zone_id` returns None (zone removed mid-cycle), enrichment passes `cluster=None` + `strategy='manual_review'`. Doc is written WITHOUT cluster but WITH provenance — matches Phase 1A AC6 "no guessing on ambiguous rows".
4. **Idempotent re-execution** — if the same code path inserts twice due to retry, both docs get fresh `clusterCreateMeta.createdAt` but consistent `cluster` (deterministic input → deterministic output).
5. **Ledger orthogonality preserved** — Pass 1C topology contract remains intact.

---

## 8. Decision Points (require approval before mutation)

1. **Exclusion list §4** — confirm runtime_ledger is excluded by design (NOT a bug).
2. **Seed deferral §3.2** — confirm seed-only writers can be Phase 1B.1 (live writers first).
3. **Wiring order §6** — confirm Tier 1 → 4 sequencing OR specify alternative order.
4. **`governance_actions` default cluster** — confirm `DEFAULT_ADMIN_ACTION_CLUSTER = repair` for taxi-legacy admin pushes (matches Phase 1A `hardcode_repair_legacy` strategy).
5. **`feature_flags` default** — confirm `appliesToClusters=['inspection']` for new auto_requests feature flags (NEW domain default, vs Phase 1A which tagged existing 7 flags as `['repair']` — legacy).

---

**Status:** WRITER INVENTORY COMPLETE. Awaiting go/no-go on decision points §8 before any code mutation.

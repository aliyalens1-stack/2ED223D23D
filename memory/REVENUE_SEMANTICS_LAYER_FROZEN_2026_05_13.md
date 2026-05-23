# 🧊 REVENUE SEMANTICS LAYER — FROZEN

**Frozen at:** 2026-05-13 10:35 UTC
**Authorized by:** user confirmation following the Legacy /summary Datetime Coercion pass.

---

## What "frozen" means here

This is a **boundary marker**, not a code change. It records the moment when
the revenue layer first reached a state in which:

> **reader semantics and writer semantics agree.**

That alignment is more important than any individual endpoint working. It
means the next time someone opens the admin revenue surface, they see a
consistent narrative: writers, readers, admin UI, and operational dedupe
all describe the same monetary reality.

---

## Frozen surfaces

| Layer | Status | Locked by |
|---|---|---|
| Historical provenance (Phase 1A) | ✅ stable | `memory/phase1a_*` |
| Future provenance (Phase 1B writer cluster-native) | ✅ stable | `memory/phase1b_tier4_freeze_2026_05_12.md` |
| Operational dedupe (Redis Truthfulness) | ✅ stable | `memory/redis_truthfulness_pass_2026_05_13.md` |
| Revenue read contract (Phase 2A-α) | ✅ stable | `memory/phase_2a_alpha_revenue_reader_freeze_2026_05_13.md` |
| Admin visualization semantics (Phase 2A-β) | ✅ stable | `memory/phase_2a_beta_admin_visualization_2026_05_13.md` |
| Legacy revenue reader (datetime coercion) | ✅ stable | `memory/legacy_summary_datetime_coercion_2026_05_13.md` |

---

## Touch this layer only if

1. The next task is **explicitly authorized as Phase 1A.2** (historical normalization closure), AND
2. The work is treated as a **dedicated migration pass**, not a small fix.

Phase 1A.2 requirements (when it does happen):
- explicit migration script with **explicit rollback**
- explicit provenance breadcrumb on every touched doc
- explicit normalization contract (target canonical shape declared upfront)
- explicit handling of the two known latent defects:
  - mixed-type `createdAt` across `payment_transactions` + `provider_purchases`
  - `$gte: start_iso` silent-undercount on BSON Date rows (the second defect
    that this layer intentionally did NOT fix in the coercion pass)

These belong to a different class of work — they are data semantics + BSON
ordering + historical normalization. They are NOT a continuation of the
current pass.

---

## Do NOT do (without explicit re-authorization)

- ⛔ Phase 2A-γ (customer/provider currency surface) — postponed by user
- ⛔ Phase 3 (webhook dispatcher unification) — out of scope for this freeze
- ⛔ Phase 1B.1 (cluster writer for `provider_purchases`) — deferred
- ⛔ Any "small fix" inside `app/revenue/` — the layer is frozen
- ⛔ Touching `/api/admin/revenue/summary`, `/cluster-summary`, or the
  `ClusterSummaryPanel` UI

---

## Test footprint (locked baseline)

**45/45 backend tests green at freeze time:**
- 10 datetime coercion (`tests/test_revenue_datetime_coercion.py`)
- 11 Phase 2A-α cluster summary contract (`tests/test_phase_2a_cluster_summary.py`)
- 7 dedupe_bucket (`tests/test_dedupe_bucket.py`)
- 17 Phase 1B writer enrichment (`tests/phase1b/`)

Any future change to revenue must keep this baseline passing AND add tests
that lock its own contract. Drop in counts = freeze violation.

---

## Phase ladder at freeze time

```
1A historical provenance       ✅ stable
1B future provenance           ✅ stable
Redis Truthfulness             ✅ stable
2A-α revenue read contract     ✅ stable
2A-β admin visualization       ✅ stable
Legacy /summary coercion       ✅ stable
─────────────────────────────────────  ← FREEZE LINE
1A.2 historical normalization     DEFERRED (next logical step, separate class of work)
1B.1 provider_purchases writer    DEFERRED
2A-γ customer/provider currency   DEFERRED
3   webhook dispatcher unification DEFERRED
```

The freeze is intentional. The next move is **not "more revenue"**. It is
either Phase 1A.2 (explicit migration), or moving the system's center of
gravity to a different surface entirely.

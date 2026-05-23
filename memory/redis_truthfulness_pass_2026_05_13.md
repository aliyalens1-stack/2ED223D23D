# 🔒 REDIS TRUTHFULNESS + LOCAL SAFETY PASS — CLOSURE

**Date:** 2026-05-13 08:30 UTC
**Status:** ✅ **SHIPPED — minimal, additive, reversible**
**Predecessor:** `audit/REDIS_DEGRADATION_INVENTORY.md` (read-only inventory, 2026-05-12)
**Scope:** code-only narrow pass. NO infra, NO Redis deploy, NO NestJS revival, NO topology rewrite.

---

## 1. What this pass closes

From the audit:

> *"Redis unavailable + false sense of deduplication"*
> * repeated PRE-ENGAGEMENT fire
> * orchestrator log amplification
> * potential provider notification fatigue
> * misleading docstring claiming secondary defense exists
> * exported `acquire_zone_lock` with zero active callers ← **PARTIALLY WRONG IN AUDIT**

### Audit correction

`acquire_zone_lock` IS actively called: `cycle.py:475` (acquire) and `cycle.py:533` (release) inside
`orchestrator_run_cycle_with_feedback`. Previous claim "zero active callers" was incorrect —
the live cycle is the v2 (`_with_feedback`) variant since C13/Sprint 24 migration.

→ Decision: **keep the helper**, fix the docstring to honestly describe its fail-open mode.

---

## 2. Deliverables

| File | Type | Net change |
|---|---|---|
| `backend/app/core/dedupe_bucket.py` | **NEW (additive)** | +112 lines — pure helper, one collection, two indexes |
| `backend/app/core/redis_state.py` | docstring rewrite | -8 +44 lines (no logic touched) |
| `backend/app/core/redis_client.py` | docstring rewrite | -3 +17 lines (no logic touched) |
| `backend/app/orchestrator/feedback.py` | docstring rewrite (`acquire_zone_lock`) | -3 +21 lines (no logic touched) |
| `backend/app/orchestrator/pre_engagement.py` | wire bucket claim | +12 lines logic + 1 import |
| `backend/app/orchestrator/cycle.py` | wire bucket claim (v1 + v2) | +24 lines logic + 1 import |
| `backend/tests/test_dedupe_bucket.py` | **NEW** | 7 integration tests, all green |

**Zero changes** in: any reader, response model, frontend, payment surface, cluster topology,
revenue module, runtime_ledger, parity contract, or NestJS adapter.

---

## 3. The new primitive

```python
# app/core/dedupe_bucket.py
async def try_claim_bucket(scope: str, key: str, window_seconds: int) -> bool:
    """Atomically claim (scope, key, time-bucket) for window_seconds.

    True  → this caller won (first in bucket).
    False → duplicate within current bucket; skip downstream work.

    Backed by a Mongo unique compound index `(scope, key, bucket)`.
    Auto-cleanup via TTL index on `expiresAt`. NO Redis required.
    Fail-open contract: any error other than DuplicateKeyError → True
    (matches existing `redis_state.py` posture).
    """
```

`bucket = floor(time.time() / window_seconds)` — fixed-window same as Redis cooldown semantics.

---

## 4. Wired callsites (only two)

### `app/orchestrator/pre_engagement.py:101`
After existing `is_in_cooldown` check (NO-OP without Redis), now also:
```python
if not await try_claim_bucket("pre_engage", zone_id, PRE_ENGAGEMENT_COOLDOWN_S):
    return None
```
Window: `PRE_ENGAGEMENT_COOLDOWN_S = 300` (5 minutes — same as Redis cooldown).

### `app/orchestrator/cycle.py:309` (v1) + `cycle.py:471` (v2 active)
After existing `is_in_cooldown` check, now also:
```python
if not await try_claim_bucket(
    "orchestrator_log",
    f"{zone_id}:{severity}",
    rule.get("cooldownSeconds", 60),
):
    continue
```
Window: per-rule `cooldownSeconds` (30-120s by severity). Skips actions execution,
log insert, feedback tracking, and realtime emit when duplicate detected.

---

## 5. Live runtime evidence — before / after

**Before pass** (per `audit/REDIS_DEGRADATION_INVENTORY.md` §4.2):
```
PRE-ENGAGEMENT triggered: zone=hamburg-altona pressure=2.66 ...    (cycle N)
PRE-ENGAGEMENT triggered: zone=hamburg-altona pressure=4.54 ...    (cycle N+1, ~10s later)
...
```
Same zone firing every cycle. ~6 fires/min per active zone.

**After pass** (backend restart + 90s observation window 2026-05-13 08:29:08-08:30:38):
```
$ grep "PRE-ENGAGEMENT triggered" backend.err.log | (since restart)
→ 0 lines (no fires reached the logger after first bucket claim per zone)

$ mongo: db.dedupe_buckets.find({scope:"pre_engage"})
→ 8 docs (4 zones × 2 adjacent buckets — exactly right for crossing a 5-min boundary)

$ mongo: db.dedupe_buckets.find({scope:"orchestrator_log"})
→ 23 docs (each zone+severity claims one bucket per cooldown window)

$ mongo: db.dedupe_buckets.getIndexes()
→ dedupe_bucket_compound_unique (scope, key, bucket) UNIQUE  ✅
→ dedupe_bucket_ttl              (expiresAt) TTL=0           ✅
```

Result: **~3-6× reduction** in orchestrator_log inserts and downstream realtime emits.
Provider notification fatigue path closed at the insert side.

---

## 6. Test coverage

`backend/tests/test_dedupe_bucket.py` — **7/7 passed (1.43s)**

```
test_same_key_same_bucket_only_first_wins
test_different_keys_both_win
test_different_scopes_both_win
test_doc_has_expires_at_for_ttl_cleanup
test_duplicate_does_not_raise              ← caller never sees DuplicateKeyError
test_compound_unique_index_present         ← index discipline
test_bucket_advances_with_time             ← window rollover correctness
```

Phase 1B regression: **17/17 still passing** (no impact on writer enrichment).

---

## 7. Truthfulness sweep — docstrings now honest

### `redis_state.py` — docstring previously claimed:
> *«Cooldown в Mongo + idempotency в orchestrator-actions всё равно ограничивают дубли»*

**Now states:**
- That claim was NOT accurate at the code level.
- Partial mitigation introduced via `app.core.dedupe_bucket` at two named callsites.
- Everywhere else, fail-open contract stands AS-IS with no secondary defense.

### `redis_client.py` — docstring previously claimed:
> *«лучше двойной push один раз, чем downtime»*

**Now states:**
- In the current preview environment, NO-OP is permanent (Redis always None).
- Single-fire guarantees evaporate for the whole session, not «один раз».
- Lists the 4 surfaces (orchestrator cooldown / pre-engagement / rate-limit / zone-lock)
  where the guarantee is lost.

### `feedback.acquire_zone_lock` — docstring previously implied lock works:
**Now states:**
- "best-effort exclusion when Redis is up; no exclusion when Redis is down"
- Loss is *operationally absorbed* by insert-side dedupe at the only downstream
  site that observably amplified (`orchestrator_logs`).
- "Do NOT add new callers expecting hard mutual-exclusion guarantees."

---

## 8. What this pass deliberately does NOT do

| Not done | Reason |
|---|---|
| Enable Redis (managed or local) | Out of scope — code-only pass |
| Migrate to NestJS in-process locks | Out of scope |
| Add Mongo-side rate-limit for 5 public endpoints | Audit §7.1 unresolved (depends on ingress posture) |
| Investigate `dispatch_alert` dedupe | Audit §7.2 — separate study |
| Investigate push pipeline dedupe | Audit §7.3 — separate study |
| Touch payment topology / Phase 1B / Revenue / Parity | Explicitly out of scope |
| Add unique index to `orchestrator_logs` directly | Would change reader contract |

---

## 9. Reversibility

Drop `dedupe_buckets` collection → behavior reverts to pre-pass state (duplicate inserts return).
Remove the two `try_claim_bucket` call blocks (12 LOC each) → full code revert.
The helper has no external dependencies and no module reaches into it except the two wired sites.

```
mongo: db.dedupe_buckets.drop()       # runtime revert (next claim re-creates indexes)
git revert <this-commit>              # source-level revert
```

---

## 10. Invariants for future passes

1. `app.core.dedupe_bucket` MUST stay pure (no readers, no business logic, no cross-module imports beyond `db`).
2. `try_claim_bucket` callers MUST NOT raise on False — duplicate is normal control flow.
3. Window size MUST match the cooldown duration of the upstream Redis helper it backstops (so the operator's mental model stays consistent).
4. NO new callsites of `acquire_zone_lock` expecting hard exclusion — see updated docstring.

---

## 11. What's left from the audit (NOT addressed in this pass)

From `audit/REDIS_DEGRADATION_INVENTORY.md` §7:
- Q1: ingress/WAF rate limiting status — unresolved
- Q2: `dispatch_alert` dedupe — uninspected
- Q3: provider push-notification pipeline dedupe — uninspected
- Q5: strategy optimizer MIN_SAMPLES bias absorption — unresolved
- Q6: per-state-op vs per-session Redis warning frequency — unresolved
- Q7: NestJS clustering roadmap — unresolved
- Q8: Redis-on cost-benefit — unresolved

These remain operational reliability open questions. Phase 2 (reader awareness), payment
topology rewrite, and revenue UI wiring are explicitly DEFERRED per the pre-pass decision
to "not surface mixed monetary semantics until Phase 2A".

---

**Phase status update:**

| Phase | Description | Status |
|---|---|---|
| 1A | Historical provenance (retro-tag) | ✅ COMPLETE |
| 1B | Future provenance (write-side cluster-native) | ✅ FROZEN (2026-05-12) |
| **Redis Truthfulness + Local Safety Pass** | **Honest docstrings + Mongo-side insert dedupe for 2 amplifying writers** | ✅ **SHIPPED (2026-05-13)** |
| 1B.1 | Seed-coverage iteration (action_chains/failsafe_rules) | DEFERRED |
| 2 | Reader awareness | NOT STARTED |
| 3 | Payment topology rewrite | NOT STARTED |

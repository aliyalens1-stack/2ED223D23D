# Q2-R1 Sprint — Reliability & Operational Integrity
## Step 1 — Full pytest + integration sweep (BASELINE)

**Date:** 2026-05-13
**Total tests discovered:** 1393 (across 75 test files, +5 fixtures, excludes phase1a/phase1b script-style tests)

---

## Run history

| Run | Trigger | Passed | Failed | Errors | Skipped | Runtime |
|-----|---------|-------:|-------:|-------:|--------:|--------:|
| 1   | Cold (no env)             | 1159 | 108 | 116 |  9 | 3:47 |
| 2   | + `TEST_BYPASS_TOKEN`     | 1133 | 110 | 136 | 14 | 3:44 |
| 3   | + DB isolation fix        | **1237** | 136 | **15** |  5 | 5:17 |

Pass rate climbed from **83%** → **88.7%** after the test-isolation fix.

---

## Critical fix applied this step

### Root cause
`tests/test_runtime_ledger_*.py` (5 files) used `os.environ.setdefault("DB_NAME", "...")` to switch to an isolated test DB. **`setdefault` is a no-op** when `DB_NAME` is already set by `app.core.config.load_dotenv()` (which always runs at backend import time). The fixture then opened a client on the **production DB** `test_database` and called `await db.users.drop()` — **wiping all seeded users mid-sweep** (admin, customer, provider, inspector). Every subsequent test that needed login → 401 cascade.

### Fix
Replaced `setdefault` with hard assignment in 5 files:
- `tests/test_runtime_ledger.py`
- `tests/test_runtime_ledger_engagement.py`
- `tests/test_runtime_ledger_interpretation.py`
- `tests/test_runtime_ledger_verification.py`
- `tests/test_runtime_ledger_widening.py`

```python
# Before (broken)
os.environ.setdefault("DB_NAME", "test_runtime_ledger_verification_db")
# After
os.environ["DB_NAME"] = "test_runtime_ledger_verification_db"
```

### Side fix
Added `TEST_BYPASS_TOKEN=q2r1_test_bypass_secret_a8c2f47e` to `backend/.env` to engage the rate-limit bypass (5/60s on `/login`, `/register`) for the test harness. Without it, batch sweeps cascade-fail with 429s after the first few logins.

### Side fix #2
Created `/app/backend/pytest.ini` with `norecursedirs = phase1a phase1b` because the legacy phase1a script tests use `sys.exit(0)` at module level, which crashes pytest collection.

---

## Remaining failure groups (run #3)

| Group                                      | Files | Failed | Root cause hypothesis                                |
|--------------------------------------------|------:|-------:|------------------------------------------------------|
| **Redis-dependent**                         |     1 |      8 | Redis disabled (port 6379) — fallback NO-OP doesn't satisfy hardening tests |
| **Stripe payments**                         |     2 |     14 | `STRIPE_SECRET_KEY` not set → 500 "Stripe is not configured" |
| **Live assignments / ops map**              |     2 |     22 | Likely seed-data dependent (inspector_jobs lifecycle), need re-investigation after re-seed |
| **Quick request sprint17**                  |     1 |     10 | TBD (deep investigation needed) |
| **Provider earnings + workbench**           |     2 |     11 | TBD |
| **Phase 1B hardening**                      |     1 |      7 | **Was passing after re-seed of `inspection_jobs`** — re-seed needs to be persistent |
| **Paid inspection e2e**                     |     1 |  4 + 14e | **Was passing after re-seed** — same as above |
| **Notifications / reputation / parsers**    |     5 |     19 | TBD |
| **Various small**                           |     6 |     14 | TBD |

---

## Persistent risks identified

1. **Seed data is not re-applied on backend restart for `inspection_jobs`.**
   `seed_data()` runs on startup and re-creates admin/customer/provider users, but `seed_inspector_jobs.py` is a one-shot manual script. When tests pollute `inspection_jobs` collection (or destructive tests wipe it), Phase-1B / Paid-E2E suites fail until manual re-seed. **Recommendation:** wire `seed_inspector_jobs` into a pytest `session`-scope fixture or backend startup behind `TESTING=1` flag.

2. **No isolated test DB by policy.** Tests currently run against `test_database` (same DB the live preview uses). A single mis-scoped fixture (like the `setdefault` bug above) can wipe canonical state. **Recommendation:** introduce `BACKEND_TEST_DB_NAME` env override and a `conftest.py` autouse fixture that points the backend at a sandbox DB **before** any test module imports.

3. **`TEST_BYPASS_TOKEN` is now in `backend/.env`.** This is fine for the preview pod but must NEVER ship in production deployment. Document this in `memory/architecture.md` under "Test Infrastructure".

---

## Endpoints / collections touched

- `seed_data()` reseed of users on each backend boot — confirmed working after dropping users.
- `seed_inspector_jobs.py` — manual re-run needed.
- No data in production DBs (`auto_platform`, `admin`) was affected.

---

## Next sprint steps (per user plan)

- **Step 2:** Redis activation (canonical async coordination layer)
- **Step 3:** OpenAPI hygiene (duplicate operation IDs in `stripe_webhook`, `proxy_to_nestjs`)
- **Step 4:** Orchestrator observability surface (`/admin/orchestrator`)
- **Step 5:** Parser reliability layer (dedup, freshness, confidence, replay protection)

Waiting for confirmation to proceed to Step 2.

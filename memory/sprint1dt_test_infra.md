# Sprint 1D.T — Test Infrastructure Stabilization (DONE)

## Goal (per direction)
Tiny technical mini-sprint between 1D.1 and 1D.2. Stabilize the test
suite so future sprints can run combined regressions without 429s, race
conditions, or "случайно красные" tests. Strict scope: ONLY test infra.
No business logic touched.

## Definition of Done — all green
| # | Item | Status |
|---|---|---|
| 1 | `TESTING` flag (env-driven) | ✅ `app/core/config.py:TESTING` |
| 2 | Rate limiter bypass — env path (`TESTING=1`) | ✅ unconditional bypass when set |
| 3 | Rate limiter bypass — header path (`X-Test-Bypass: <token>`) | ✅ guarded by `TEST_BYPASS_TOKEN` shared secret |
| 4 | Stable session-cached fixtures (admin/provider/customer tokens) | ✅ `tests/conftest.py` |
| 5 | `issue_test_jwt(...)` helper — mint JWT in-process, no /login call | ✅ `tests/conftest.py:issue_test_jwt` |
| 6 | `auth_headers(token)` helper — Bearer + bypass merged | ✅ |
| 7 | Combined run 1C + 1D.1 + 1D.T | ✅ **44/44 passed** in 84s, **zero 429s** |

## Design decisions

### Two bypass paths, both production-safe by default
1. **`TESTING=1`** env var → unconditional bypass. Documented as "use ONLY
   in dedicated test pods". Default `0`.
2. **`X-Test-Bypass: <token>`** header → request-scoped bypass guarded by
   the `TEST_BYPASS_TOKEN` env shared secret. When the env var is empty
   (production default), the header is **completely ignored**. Bypass is
   impossible without explicit operator action.

The header path is the one tests actually use — `TESTING` is for
dedicated CI pods. Both are evaluated lazily inside `check_rate_limit`
(not at module import) so env changes via `--reload` are picked up
without restarting the worker.

### Sync warm-up cache for fixtures
Earlier draft used pytest-asyncio session-scoped async fixtures. That
caused `RuntimeError: Event loop is closed` when async fixtures of
session scope tried to interact with function-scoped event loops in
mixed test files. Diagnosis: `pytest-asyncio 0.21+` ties session
fixtures to the first loop they're awaited in; subsequent function
loops can't reuse them.

**Fix:** session state lives in plain module-level dicts populated by
sync `httpx.Client` calls (via `_ensure_admin_login`,
`_ensure_provider_signup`, `_ensure_customer_signup`). Tokens are
strings — no loop binding. Each test that needs an async client gets a
fresh function-scoped one. Single warm-up POST per identity per session.

This pattern is reusable for any future test sprint regardless of
async framework version drift.

### `client` fixture is function-scoped
Each test gets its own `httpx.AsyncClient`. Setup cost is negligible
(one TCP open) and it eliminates the entire class of "loop closed"
errors. The bypass headers are injected at client construction so test
code never sees the token.

### `issue_test_jwt(...)` — escape hatch for unit-style tests
Some future tests will only need a valid token shape (e.g. testing
JWT validation, testing capability resolver internals). They don't
need a fresh `/auth/register` round-trip. `issue_test_jwt` wraps
`identity_runtime.issue_account_jwt` with sane defaults — accepts a
plain dict (the AccountView.to_json() shape) and returns a string token.

## Files changed
| Action | Path | Note |
|---|---|---|
| MOD | `/app/backend/app/core/config.py` | +`TESTING` +`TEST_BYPASS_TOKEN` |
| MOD | `/app/backend/.env` | +`TEST_BYPASS_TOKEN=<random-32>` (preview-only) |
| MOD | `/app/backend/prod_readiness.py:check_rate_limit` | +bypass evaluation |
| MOD | `/app/backend/tests/conftest.py` | full rewrite — sync warm-up cache, function-scoped client, issue_test_jwt |
| ADD | `/app/backend/tests/test_sprint1dt_test_infra.py` | 9 cases proving bypass + fixtures |

## Validation snapshot
```
$ pytest tests/test_sprint1c_identity_runtime.py \
         tests/test_sprint1d1_inspector_gate.py \
         tests/test_sprint1dt_test_infra.py
tests/test_sprint1c_identity_runtime.py ...... [ 40%]
tests/test_sprint1d1_inspector_gate.py ...... [ 79%]
tests/test_sprint1dt_test_infra.py ........... [100%]
============== 44 passed in 84.43s (0:01:24) =================
```

Pre-1D.T: same combined run failed with 5 × HTTP 429 because both
1C and 1D.1 hit `/api/auth/register` >5 times within 60s.
Post-1D.T: zero 429s, fully reproducible.

## Production-safety guarantees
- **Default state in production**: `TESTING=0`, `TEST_BYPASS_TOKEN=""`.
  No bypass possible. Rate limiter behaves exactly as before 1D.T.
- **Token leak risk**: token lives only in `/app/backend/.env` (the
  same file that already holds `MONGO_URL`). Not in source, not in
  frontend code, not in mobile bundle, not in admin panel.
- **Operator awareness**: rotating the token is a one-line change
  (regenerate, restart backend). Tests pull from same env so they
  re-pick up automatically when invoked from /app/backend.
- **No middleware order surprises**: `check_rate_limit` is unchanged
  except for the early-return checks at the top — the rest of the
  bucket logic runs for un-bypassed requests exactly as before.

## What this DOES NOT cover (intentionally)
- ❌ Idempotency-Key bypass — same `prod_readiness.py` module. Could
  follow the same pattern in a future micro-sprint if tests start
  hitting it.
- ❌ Circuit-breaker reset for tests — not needed yet (tests don't
  exercise the NestJS proxy retry path).
- ❌ Auto-revoking test users created by fixtures — they linger in
  Mongo. Cheap (3 docs per session), not worth a teardown right now.
- ❌ Pytest plugin to auto-load `TEST_BYPASS_TOKEN` from `.env` — tests
  expect the operator to `export TEST_BYPASS_TOKEN=...` before
  pytest. We could add a `dotenv` autoload in conftest if it becomes
  ergonomic friction.

## Next: Sprint 1D.2 — Customer Domain (credits / packages / requests)
Per direction, customer is a **principal**, not a capability holder.
The pattern there will be:
```python
from app.core.identity_runtime import IdentityContext, decode_and_resolve

def require_account_kind(*kinds: str):
    """Gate an endpoint by `account.kind` rather than capability.
    Use for principals (customer, admin) — not for professionals."""
    ...

# Customer endpoint:
async def my_credits(ctx: IdentityContext = Depends(require_account_kind("customer"))):
    ...
```

This adds **one new helper** — `require_account_kind` — and reuses the
same `IdentityContext` machinery from 1C. No new resolver, no new
collection. Smallest possible delta, exactly like 1D.1.

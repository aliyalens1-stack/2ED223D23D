# Sprint 1D.1 — Inspector Auto Requests Gate (DONE)

## Goal (per direction)
First incremental migration of a business module to capability-based
authorization. Strict scope: ONLY `app/auto_requests/router_inspector.py`.
Customer / admin / payments / reports view / web-app / mobile UI /
organizations untouched.

## Acceptance Criteria — all green (17/17 pytest)

| # | Criterion | Status |
|---|---|---|
| 1 | provider@test.com логинится | ✅ via `POST /auth/register` role=provider_owner |
| 2 | JWT содержит accountId (≠ user_id) | ✅ verified — points to real `accounts._id` |
| 3 | `/api/inspector/jobs` доступен provider'у | ✅ 200 with `{jobs:[],count:int}` |
| 4 | customer получает 403 на `/api/inspector/jobs` | ✅ — tested all 11 endpoints, every one returns 403 |
| 5 | provider может claim job | ✅ |
| 6 | job получает `inspectorAccountId` | ✅ Mongo + response body both carry it; ≠ `inspectorId` |
| 7 | lifecycle claimed → on_route → arrived → inspecting | ✅ all transitions reaffirm `inspectorAccountId` |
| 8 | provider может submit report | ✅ — credit consumed; `inspection_reports` doc has `inspectorAccountId` |
| 9 | credit consume работает как раньше | ✅ smoke-tested via report flow |
| 10 | старые поля `inspectorId` не ломают legacy UI | ✅ — service.py ownership unchanged, dual-write only |

## What changed (single file)
- `/app/backend/app/auto_requests/router_inspector.py` — full rewrite.

## What did NOT change (scope freeze)
- `app/auto_requests/service.py` — service ownership lookups still use
  `inspectorId == users._id`. **Intentional.** Switching service ownership
  to `inspectorAccountId == accounts._id` is Sprint 1D.2 territory.
- `app/auto_requests/reports.py` — same.
- All other domain routers (customer/admin/marketplace/candidates/media).
- All identity-runtime code (Sprint 1C is locked).

## Architecture deltas

### Before 1D.1
```python
from app.auto_requests.auth import get_user_id_required

@router.post("/{job_id}/claim")
async def claim(job_id: str, uid: str = Depends(get_user_id_required)):
    res = await svc.claim_job(job_id, inspector_id=uid)
    ...
```
- Any authenticated user could hit `/api/inspector/*`. Customer with a
  valid JWT got past the gate; only the service-layer ownership check
  protected jobs.
- `inspection_jobs.inspectorId` was a `users._id` string. There was no
  link to the new `accounts` collection.

### After 1D.1
```python
from app.core.identity_runtime import IdentityContext, require_capability_v2

_inspect_required = require_capability_v2("inspect")

@router.post("/{job_id}/claim")
async def claim(job_id: str, ctx: IdentityContext = Depends(_inspect_required)):
    res = await svc.claim_job(job_id, inspector_id=ctx.user_id)
    await _set_inspector_account_id(job_id, ctx.account.id)
    ...
```
- `require_capability_v2("inspect")` is the SINGLE gate for all 11
  inspector endpoints. Customer/admin (caps=[]) → 403 with
  `"capability required (inspect)"` — zero ambiguity, zero
  role-string magic.
- Each `inspection_job` document now carries BOTH
  `inspectorId` (legacy `users._id`) AND `inspectorAccountId`
  (new `accounts._id`). Old code reading `inspectorId` keeps working;
  new code can adopt the account id without a coordinated migration.
- `inspection_reports` likewise dual-written on `/report` submission.

### Endpoints touched (11)
All under `/api/inspector/jobs/...` plus `/api/inspector/checklist`.
Every single one is now capability-gated. Pre-1D.1, `GET /jobs` and
`/checklist` were public — that leaked open-job listings and the
inspection scoring criteria to anyone with a JWT (or none).

## Subtle bug caught by testing agent (and fixed)
First iteration's response payload was missing `inspectorAccountId` for
`/claim`, `/on-route`, `/arrived`, `/start-inspection`, `/cancel`,
`/report` because `svc.claim_job` and `rsvc.transition_status` return
**Pydantic** `InspectionJobOut`, not dicts. The
`if isinstance(res, dict): res = {**res, ...}` merge was dead code.

Mongo state was always correct (the `_set_inspector_account_id` helper
runs an unconditional `update_one`), but the response shape lied.

**Fix:** added `_to_dict(obj)` helper that calls `.model_dump()` /
`.dict()` if available, else `dict(obj)`. Every endpoint now serializes
the service-layer result, merges `inspectorAccountId`, and returns the
plain dict.

## Test strategy (kept reusable for 1D.2/1D.3)
The Sprint 1D.1 test file (`tests/test_sprint1d1_inspector_gate.py`)
seeds minimal `car_requests` + `inspection_jobs` documents directly
into Mongo (no public API for that exists in scope). Provider/customer
accounts are registered on demand via `/api/auth/register`.

This pattern (register on demand → seed minimal Mongo state → exercise
the gated endpoint → assert response + Mongo state) is the template
for next module migrations.

## Files changed
| Action | Path | Note |
|---|---|---|
| MOD | `/app/backend/app/auto_requests/router_inspector.py` | Full rewrite — capability gate + dual-write `inspectorAccountId` |
| ADD | `/app/backend/tests/test_sprint1d1_inspector_gate.py` | 17 cases (created by testing agent) |
| ADD | `/app/test_reports/iteration_2.json` + `pytest/sprint1d1_results.xml` | test artifacts |
| MOD | `/app/memory/test_credentials.md` | Documented provider/customer test patterns |
| ADD | `/app/memory/sprint1d1_inspector_gate.md` | This document |

## Cross-suite test note
Sprint 1C and 1D.1 suites combined exceed the auth rate-limit (5/60s on
`/api/auth/login` + `/api/auth/register`) and produce 429s when run
back-to-back. Each suite **runs green in isolation**:

```
$ pytest tests/test_sprint1c_identity_runtime.py
18 passed in 4.98s

$ pytest tests/test_sprint1d1_inspector_gate.py
17 passed in 4.65s
```

Future sprints should either share a session-scoped fixture pool of
test users, or temporarily disable the auth rate limiter for the
test environment. NOT a code regression — infrastructure artifact.

## Next: Sprint 1D.2 — Customer credits / packages
Following the same template:
1. Identify the capability that customers need (probably no capability —
   they're principals; gate by `account.kind == "customer"` instead).
2. Replace any `Depends(verify_user_token)` returning raw JWT with
   `Depends(decode_and_resolve)` returning `IdentityContext`.
3. Where the legacy code wrote `userId` to credit/package docs, add
   `customerAccountId = ctx.account.id` in dual-write mode.
4. Test in isolation, then run combined Sprint 1C/1D.1/1D.2 with rate
   limit disabled or session-scoped reuse.

DO NOT bundle 1D.2 with any other module.

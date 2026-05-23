# Sprint 1C — Identity Runtime Closure (DONE)

## Goal (per direction)
**NOT migration of business endpoints.** Close the identity-runtime layer so
that `accountId != userId` is real (not a shim), so that capability checks
have a single resolver, and so that switch-account is supported as a
first-class concept. Strict scope freeze: bizdomain code (marketplace,
payments, ranking, reports) untouched.

## Definition of Done — all green
| Item | Status | Evidence |
|---|---|---|
| Backup before migration (additive safety net) | ✅ | `memory/db_backup_pre_migration.json` (5 MB, 5065 docs across 52 collections) |
| `accounts` + `account_capabilities` populated for legacy users | ✅ | 3 accounts (admin, customer, inspector), 1 capability (inspect) |
| `JWT.accountId != JWT.sub` (logically — points to real `accounts._id`) | ✅ | login admin: sub=`69fb2af5...`, accountId=`69fb3382...` |
| `/auth/login` issues JWT via `identity_runtime.issue_account_jwt` | ✅ | `app/system/auth.py:auth_login` |
| `/auth/register` creates real `accounts` row before issuing JWT | ✅ | new helper `ensure_account_for_user()` in `identity_runtime`; new users get `isLegacy=false` |
| `/auth/me` returns `{ user, accounts[], activeAccount }` | ✅ | shape verified by test agent |
| `POST /auth/switch-account` (stateless — no DB mutation) | ✅ | issues new JWT bound to target accountId; foreign / non-existent accountId returns identical 403 (no info leak) |
| V1 `require_capability` → adapter to V2 (single source of truth) | ✅ | `app/core/capability.py` — lazy delegate to `identity_runtime.require_capability_v2` |
| Capability checks read from `account_capabilities` (not just JWT claim) | ✅ | `require_capability_v2` calls `decode_and_resolve` → `resolve_capabilities` |
| 0 zero callsites of legacy v1 broken | ✅ | grep confirmed: only docstring example used v1; no real `Depends(require_capability(...))` in repo |
| Bizdomain endpoints non-regressed | ✅ | smoke tests on `/api/health`, `/api/cities`, `/api/marketplace/providers`, `/api/admin-panel/`, `/api/web-app/` all 200 |
| Test coverage | ✅ | `tests/test_sprint1c_identity_runtime.py` — 18/18 PASS |

## What landed in 1C

### 1. `app/core/identity_runtime.py`
- Added `ensure_account_for_user(user_doc) -> AccountView` — idempotent helper
  that creates `accounts` + `account_capabilities` rows for a legacy users doc.
  Same upsert logic as `scripts/migrate_users_to_accounts.py` so the script
  and the live runtime never drift.
- Existing `get_user_accounts`, `get_account`, `resolve_capabilities`,
  `get_active_account`, `issue_account_jwt`, `decode_and_resolve`,
  `require_capability_v2` unchanged — already correct in the codebase.

### 2. `app/system/auth.py` — full rewrite
- `/login` minted JWT and shim-derived accountId. **Now**: calls
  `ensure_account_for_user` (backfills missing rows on first login of any
  pre-1C user), then `get_active_account`, then `issue_account_jwt`. Returns
  `{ accessToken, user, accounts[], activeAccount }`.
- `/register` previously set `accountId = user_id` ("Sprint 1A: account_id
  == user_id"). **Now**: creates real `accounts` row immediately; JWT carries
  real `accounts._id`. No shim path for new users.
- `/me` now returns `{ user, accounts[], activeAccount }` — frontend can
  branch on `activeAccount.kind` / `activeAccount.capabilities`.
- **NEW** `POST /api/auth/switch-account` — stateless. Body
  `{ accountId }`. Verifies ownership, issues fresh JWT bound to the target
  account. **Zero DB mutation** — multi-device sessions stay independent
  exactly as the architecture brief required.
- Forgot/reset password — verbatim, untouched.

### 3. `app/core/capability.py`
- V1 `require_capability` body replaced with a thin adapter that lazily
  imports and delegates to `identity_runtime.require_capability_v2`. Lazy
  import is required because `identity_runtime` imports the vocabulary
  (KNOWN_CAPABILITIES / ACCOUNT_KINDS) from this module — top-level import
  would be circular.
- `_LEGACY_ROLE_TO_CAPS` / `derive_*` helpers retained — still used by the
  legacy-fallback path inside `identity_runtime` for users that haven't
  been migrated yet (defensive belt-and-braces).

## What is **NOT** done in 1C (intentionally — out of scope freeze)
- ❌ No business-endpoint rewrite — that is **Sprint 1D**.
- ❌ Existing `provider.py` / `customer.py` / `marketplace/*.py` still use
  legacy role-based gates. They are **safe** because the legacy users.role
  field is preserved AND `require_capability_v2` honors it via fallback —
  but they should migrate to capability gates in 1D.
- ❌ No `organization_members` business logic — collection exists (created
  by `init_capability_collections.py`) but is unused. This is Sprint 1E /
  2A territory per direction.
- ❌ No frontend account-switcher UI — the contract is locked
  (`{user, accounts[], activeAccount}` + `POST /switch-account`), so 1E
  can build against a stable shape.
- ❌ V1 `require_capability` could not be deleted because its symbol is
  re-exported in `__all__` and may be imported by future code. Leaving
  the adapter in place is cheap and avoids breaking imports.

## Forward-compatibility guarantees
- `accountId` in JWT is now durably distinct from `userId`. A user with
  multiple accounts (customer + inspector + dealer) gets one JWT per
  active context. Switch-account swaps the JWT, never the DB.
- `/auth/me` shape is **stable contract** for the multi-account UI.
  `accounts[]` is always present (even when length=1) so the frontend
  account-switcher renders the same code path for "single-persona" and
  "multi-persona" users.
- Migration script + `ensure_account_for_user` use identical upsert keys
  (`{userId, kind}`). Running migration repeatedly, or registering
  legacy users that pre-existed, never duplicates rows.
- `users.role` kept for ≥3 releases — fallback path in
  `identity_runtime._user_doc_to_legacy_account` still synthesizes a
  shim `AccountView` if a `users` row somehow exists without a matching
  `accounts` row (would only happen if something inserts directly into
  `users` bypassing `ensure_account_for_user`).

## Files changed
| Action | Path | Note |
|---|---|---|
| MOD | `/app/backend/app/system/auth.py` | full rewrite — single source of truth via identity_runtime |
| MOD | `/app/backend/app/core/identity_runtime.py` | added `ensure_account_for_user` + `__all__` export |
| MOD | `/app/backend/app/core/capability.py` | V1 `require_capability` → adapter to V2 |
| ADD | `/app/backend/tests/test_sprint1c_identity_runtime.py` | 18 cases — all pass |
| ADD | `/app/test_reports/iteration_1.json` + `pytest/sprint1c_results.xml` | test agent artifacts |
| ADD | `/app/memory/db_backup_pre_migration.json` | pre-migration safety net (5 MB) |

## Next: Sprint 1D — Business endpoints to capability gates
Now that the runtime is real (not a shim), bizdomain code can migrate
incrementally:
1. Replace `if user.role == 'provider_owner'` checks with
   `Depends(require_capability('inspect'))`.
2. Replace `verify_user_token` returns of raw payload with
   `IdentityContext` (so endpoint code reads `ctx.account` and
   `ctx.has('repair')` instead of `payload.role`).
3. Per-domain rollout — start with one module (e.g.
   `app/auto_requests/router_inspector.py`), green-test, then next.

DO NOT do this in a single sweep — that's the migration disaster the
direction warned about. Module-by-module, each with its own tests.

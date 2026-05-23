# Sprint 1A — Capability compatibility layer (DONE)

## Goal
Prepare the codebase for the identity → account → capabilities split **without** touching data, breaking JWTs, or moving any endpoints. Pure additive.

## Architecture target (Sprint 1B onward)
```
PERSON     → users          (identity only — name, email, phone, locale, kyc_status)
ACCOUNT    → accounts       (business/persona context — earnings, rating, public profile)
PERMISSION → account_capabilities  (kind: 'inspector' | 'service_provider' | 'dealer' | 'transport')
ORG        → organizations  (teams, networks)
```

`users.role` is **kept** as legacy compat field for ≥2-3 releases. Never deleted in 1A.

## What landed in 1A

### 1. DB safety net
- `/app/memory/db_backup_pre_migration.json` — full read-only dump of all 84 collections (18 092 docs, 18 MB).
- Generator: `/app/backend/scripts/backup_pre_migration.py` (re-runnable, non-destructive).

### 2. Capability abstraction module (`/app/backend/app/core/capability.py`)
Public API (this contract is stable across 1B/1C/1D/1E — only the internal implementation will change):
| Helper | Purpose |
|---|---|
| `KNOWN_CAPABILITY_KINDS` | `('inspector', 'service_provider', 'dealer', 'transport')` |
| `derive_capabilities_from_legacy(user)` | Maps `users.role` → list of caps. `provider`/`provider_owner` → `['inspector']`. |
| `derive_active_account_id(user)` | Returns user._id (in 1C will become `accounts._id`). |
| `build_active_account_snapshot(user)` | Returns the `activeAccount` blob shape used by `/auth/me` and the (future) account-mode switcher. Has `isLegacy: true` flag in 1A. |
| `has_capability(user_or_payload, kind)` | Predicate. Accepts both raw users-doc and JWT payload. |
| `has_any_capability(user_or_payload, kinds)` | Union of caps. |
| `require_capability(*kinds)` | FastAPI `Depends(...)` — capability-aware middleware. Reads `caps` claim from JWT first; falls back to legacy `role` mapping. **Not yet attached to any endpoint** — used only when 1D/1E migrate routes. |

### 3. Auth endpoints additive update (`app/system/auth.py`)
- `POST /auth/login` now puts `caps: [...]` and `accountId: <user_id>` in JWT payload **in addition to** `role`. Old clients ignoring these keys keep working.
- `POST /auth/login` response.user includes `caps` array + `activeAccount` blob.
- `POST /auth/register` mirrors the same shape.
- `GET /auth/me` returns `caps` + `activeAccount`.
- All other `/auth/*` endpoints unchanged.

### 4. JWT shape (forward-compatible)
```jsonc
{
  "sub": "<user_id>",
  "email": "...",
  "role": "customer | admin | provider | provider_owner | ...", // legacy — kept ≥2 releases
  "caps": ["inspector"],            // ← new, additive
  "accountId": "<user_id>",         // ← new, additive (will become real accounts._id in 1C)
  "iat": ..., "exp": ...
}
```
Old tokens (issued before 1A) continue to work — `require_capability` falls back to `role` when `caps` is absent.

### 5. Smoke tests (`/app/backend/tests/test_sprint1a_capability.py`)
10/10 pass:
- Customer login → `caps=[]`, `activeAccount.kind='customer'`
- Admin login → `caps=[]`, `activeAccount.kind='admin'`
- Provider register → `caps=['inspector']`, `activeAccount.kind='inspector'`
- JWT carries new claims for all roles
- Legacy `/api/customer/credits` unaffected
- Pure-Python helpers cover all 8 role mappings + dual JWT/doc shape + union check

## What is **NOT** done in 1A (intentionally)
- ❌ No new MongoDB collections (1B)
- ❌ No data migration (1C)
- ❌ No dual-write to new model (1D)
- ❌ No frontend swap from `role` to `caps` (1E)
- ❌ No endpoint moved from `verify_user_token`/`require_role` to `require_capability` — that's 1D's job (per-route opt-in, not big-bang)

## Risks/regressions checked
| Surface | Status |
|---|---|
| Legacy `/api/auth/me` shape | Additive only — old keys preserved |
| Legacy `/api/customer/*` (role-based) | Unchanged, still works |
| Legacy `/api/admin/*` (`verify_admin_token`) | Untouched |
| JWT decode in NestJS subprocess | Unaffected — claims are additive, NestJS reads only `sub`/`role` |
| Existing tests | All 4 services healthy after restart |

## Next: Sprint 1B
Create `accounts`, `account_capabilities`, `organizations` collections + indexes. Still no data migration — empty collections, idle. The capability helpers will start preferring new-collection reads with fallback to legacy.

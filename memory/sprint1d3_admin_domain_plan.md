# Sprint 1D.3 — Admin Domain Migration (PLAN — code follows)

> Status: **plan only**. Code changes gated until this document is approved.
> Prior art: `/app/memory/sprint1d1_inspector_gate.md`, `/app/memory/sprint1d2_customer_domain.md`.

---

## 1. Goal

Close the identity-layer by migrating every admin-only surface from legacy
`verify_admin_token` / inline `role == "admin"` checks to the principal gate
**`require_admin()`** (which is sugar over `require_account_kind("admin")`).

After 1D.3:

- `inspector` → `require_capability_v2("inspect")` (done, 1D.1)
- `customer`  → `require_account_kind("customer")` (done, 1D.2)
- **`admin`**  → **`require_admin()`** (this sprint)

Every principal has exactly ONE gate, every gate has exactly ONE source of truth
(`identity_runtime.decode_and_resolve`). Nothing ad-hoc survives.

---

## 2. Why `admin` is `account.kind`, not `capability`

Already encoded in `identity_runtime.require_admin` docstring — repeating here
so the decision is recorded in the plan:

| Reason | Detail |
|---|---|
| Identity, not skill | Admin is **WHO** you are (governance persona), not **WHAT** you do professionally. Capabilities are action verbs (`inspect`, `repair`, `tow`, `sell`). Putting `admin` next to them turns the capabilities table into an ACL trash heap. |
| Governance ≠ marketplace action | Marketplace providers compete on capabilities. Governance actors do not appear in matching / ranking / distribution. Two different axes. |
| Future stricter checks | 2FA, IP allowlist, time-bounded sessions, per-call audit log — all belong in ONE wrapper. `require_admin()` is that wrapper; adding a check there covers every admin endpoint for free. |
| Drift prevention | `ACCOUNT_KINDS` literal contains `admin`. `KNOWN_CAPABILITIES` does not. The boot-time drift trap in `require_account_kind` would raise `ValueError` the moment someone typos `require_account_kind("admn")` — a mis-registered capability gate would silently accept no one. |

**Not considered**: splitting admin into `super_admin` / `ops_admin` / `support_admin`.
Out of scope. When it happens, those become **sub-kinds** or a stricter per-capability
check inside `require_admin()` — the public gate symbol stays the same.

---

## 3. Scope (what 1D.3 touches)

### 3.1 Primary — `app/admin/*.py` (governance domain)

| File | Endpoints | Current gate | After 1D.3 |
|---|---:|---|---|
| `app/admin/controls.py` | — (helpers) | `verify_admin_token` (imports) | unchanged signature; adapter stays |
| `app/admin/dashboard.py` | 2 | `Depends(verify_admin_token)` | `Depends(require_admin())` |
| `app/admin/forecast.py` | 2 | `Depends(verify_admin_token)` | `Depends(require_admin())` |
| `app/admin/stripe_settings.py` | N | `Depends(verify_admin_token)` | `Depends(require_admin())` |
| `app/admin/router.py` | aggregator | — | — |

### 3.2 Secondary — `/api/admin/*` routes living outside `app/admin/`

These are admin endpoints by URL, but code lives in other domains. 1D.3
migrates **only the gate**, never the business logic.

| File | Admin endpoints (examples) | Notes |
|---|---|---|
| `app/marketplace/auction.py` | `/api/admin/auction/*` | `Depends(verify_admin_token)` → `require_admin()` |
| `app/marketplace/matching.py` | `/api/admin/matching/weights` | ditto |
| `app/marketplace/providers.py` | `/api/admin/providers/{slug}/promote` etc | ditto |
| `app/marketplace/quick_request.py` | `/api/admin/ranking/*` | ditto |
| `app/marketplace/zones.py` | `/api/admin/zones/*` | ditto |
| `app/orchestrator/router.py` | `/api/admin/governance/*` | ditto |
| `app/packages/router_admin.py` | `/api/admin/packages/*` | ditto |
| `app/auto_requests/router_admin.py` | `/api/admin/auto-requests/*` | ditto |
| `app/billing/router.py` | admin-only billing routes | ditto |
| `app/billing/stripe_payments.py` | admin-only stripe routes | ditto |
| `app/provider/router.py` | admin-only provider actions | ditto |
| `app/performance/__init__.py` | `/api/admin/performance/leaderboard` | ditto |
| `app/revenue/__init__.py` | `/api/admin/revenue/*` | ditto |
| `app/referrals.py` | admin ref routes | ditto |
| `app/retention.py` | admin retention routes | ditto |
| `app/domination.py` | `/api/admin/domination` | ditto |
| `app/growth/nudges.py` | admin nudges | ditto |
| `app/growth/reactivation.py` | `/api/admin/growth/reactivation*` | ditto |
| `app/chat/router.py` | admin-inspect chats | **+ inline `role == "admin"` (see 3.3)** |
| `app/auto_requests/router_media.py` | admin-inspect media | **+ inline `role == "admin"` (see 3.3)** |
| `app/system/system.py` | `/api/system/errors/stats` | ditto |
| `server.py` | ~15 admin endpoints still inline | migrate gate only |

**Total**: 27 files using `verify_admin_token`, **66 unique `/api/admin/*` route patterns**
(grepped — see Audit §10).

### 3.3 Inline `role == "admin"` callsites (non-adapter path — must also migrate)

Grep-confirmed list (5 occurrences, 4 files) bypassing the adapter:

| File:line | Code | Fix |
|---|---|---|
| `app/chat/router.py:195` | `is_admin = role == "admin"` | Pull `ctx.account.kind == "admin"` from `decode_and_resolve` |
| `app/chat/router.py:250` | `is_admin = role == "admin"` | ditto |
| `app/auto_requests/router_media.py:161` | `is_admin = bool(user and user.get("role") == "admin")` | Pull from `ctx.account.kind` |
| `app/performance/__init__.py:277` | `if role == "admin" and providerSlug: ...` | Guard via `ctx.account.kind == "admin"` |
| `app/core/seed.py:36` | `"role": "admin"` | **NOT AUTH** — seed-only; keep as legacy stamp. `ensure_account_for_user` (1C) auto-creates the matching `accounts` row on first `/auth/me` call. |

### 3.4 Forward-write (additive — no schema migration)

Where admin actions are persisted for audit, the new canonical field is written
**alongside** the legacy one. Reads stay on legacy. No collection migration in 1D.3.

| Collection | Legacy field | New field (forward-write) | File(s) writing |
|---|---|---|---|
| `governance_actions` | `email` (implicit) | `adminAccountId`, `adminUserId` | `server.py` demand/behavior/flow endpoints |
| `monetization_actions` | — | `adminAccountId`, `adminUserId` | `server.py` promote/priority endpoints |
| `demand_action_executions` | `triggeredBy: "admin"` | `adminAccountId`, `adminUserId` | `server.py` demand action run |
| `audit_log` (if present, via `write_audit`) | `userId` | `adminAccountId` | `prod_readiness.write_audit` — **wrap call-site, not helper** |
| Stripe settings history | `updatedBy: email` | `adminAccountId` | `app/admin/stripe_settings.py` |

Scope discipline: only write-paths in scope for 1D.3 — **no reads rewritten**.
Backfill of historic rows is a separate sprint (2D or later).

---

## 4. Out of Scope (explicit scope freeze)

- ❌ Admin frontend (`/app/admin`) — 1E territory (account switcher UI).
- ❌ Repair / wash / tow / sell endpoints.
- ❌ Ranking engine rewrite (Phase 4).
- ❌ `organization_members` / multi-tenant (2A).
- ❌ Service-layer refactor (`app/*/service.py`) — gate-layer only.
- ❌ Migration of historic legacy audit rows to add `adminAccountId`.
- ❌ NestJS proxy paths — FastAPI gate upstream already catches them at
  `UNGUARDED_ADMIN_PATHS` middleware in `server.py`; no change needed.
- ❌ Any new admin feature. 1D.3 is a pure re-seating of existing endpoints
  on the new gate.

---

## 5. Compatibility Strategy

### 5.1 Two-lane adapter (already in place — just audited, not rewritten)

```
                                   ┌───────────────────────────────────────────┐
Old call-sites                     │ app.core.security.verify_admin_token      │
  Depends(verify_admin_token)      │   (adapter — returns legacy-shape dict)   │
  _=Depends(verify_admin_token)    │                                           │
         ─────────────────────────▶│  ┌─────────────────────────────────────┐  │
                                   │  │ identity_runtime.require_admin()    │  │
New call-sites                     │  │   (sugar over                       │  │
  ctx = Depends(require_admin())   │  │    require_account_kind("admin"))   │◀──── SINGLE SOURCE OF TRUTH
         ─────────────────────────▶│  └─────────────────────────────────────┘  │
                                   └───────────────────────────────────────────┘
                                                       │
                                                       ▼
                                         decode_and_resolve(request)
                                         → IdentityContext (1C)
```

- **Zero-edit upgrade**: files using `Depends(verify_admin_token)` with `_=` discard
  keep working verbatim. Their runtime is now `require_admin()` — they just don't see
  the new context.
- **Incremental upgrade**: new code writing `ctx = Depends(require_admin())` gets
  an `IdentityContext` with `ctx.user_id`, `ctx.user_email`, `ctx.account.id`.
  Prior inline `payload.get("email", "admin")` callers can switch one-by-one.
- **Rollback lane**: if `require_admin()` misbehaves, flipping
  `verify_admin_token` back to its pre-1D.3 body restores the legacy path
  (see §8). The adapter is the only touched symbol.

### 5.2 Migration order (smallest blast radius first)

1. **Pass A — audit & tests** (no production code edits)
   - Lock current adapter behaviour in `test_sprint1d3_admin_gate.py`.
   - All 126 existing 1D.2 tests continue to pass.
2. **Pass B — inline `role == "admin"` cleanup** (5 sites)
   - Switch to `ctx.account.kind == "admin"` via `decode_and_resolve`.
   - Keeps same behaviour, just reads from the single runtime.
3. **Pass C — `app/admin/*.py` direct upgrade**
   - Swap `Depends(verify_admin_token)` → `Depends(require_admin())` only where
     the handler benefits from `IdentityContext` (audit write, admin email).
   - Others keep the adapter — **no forced mass edit**.
4. **Pass D — `/api/admin/*` routes outside `app/admin/`** (governance-audit
   endpoints that write admin identity) — forward-write pass.
5. **Pass E — remove `verify_admin_token` adapter** — **NOT in 1D.3**. The
   adapter stays at least until 1E ships; it costs nothing and protects
   against unknown callers.

**Note on existing `verify_admin_token` body**: the adapter is **already in place**
from a prior commit. Pass A & B become the dominant effort; Pass C is a surgical
win-condition upgrade; Pass D is the real audit-write work.

### 5.3 JWT claim compatibility

- No new claims. `accountId` / `kind` / `caps` have shipped since 1C.
- Old JWTs (1A/1B) without `accountId` still resolve via `get_active_account` →
  legacy-shim account from `users.role`. `derive_account_kind_from_legacy`
  maps `role == "admin"` → `kind == "admin"`. No re-login required.

---

## 6. Auth Contract (1D.3 frozen)

```python
# governance endpoints — canonical form
from fastapi import APIRouter, Depends
from app.core.identity_runtime import require_admin, IdentityContext

router = APIRouter()
_admin_required = require_admin()   # instantiate once at module load

@router.get("/api/admin/zones")
async def admin_zones(ctx: IdentityContext = Depends(_admin_required)):
    # ctx.user_id, ctx.user_email, ctx.account.id, ctx.account.kind == "admin"
    ...
```

```python
# legacy callers — UNCHANGED (back-compat)
from fastapi import APIRouter, Depends
from app.core.security import verify_admin_token

router = APIRouter()

@router.get("/api/admin/thing")
async def admin_thing(_: dict = Depends(verify_admin_token)):
    # _ is the legacy-shape dict — same fields as pre-1D.3 + bonus kind/caps/accountId
    ...
```

**Error surface**:
- Missing / malformed bearer → **401** `Unauthorized`
- Valid token, non-admin `account.kind` → **403** `Forbidden: account kind required (admin). Active kind: ...`
- Expired token → **401** `Token expired`
- `accountId` claim points to account not owned by `sub` → falls back to primary
  account (existing `get_active_account` behaviour); if primary is not admin,
  **403**.

---

## 7. Testing Plan

### 7.1 New file — `tests/test_sprint1d3_admin_gate.py`

Structure follows `test_sprint1d2_customer_gate.py` (pytest in repo style).

**Unit layer (fast, no network)**

| Case | Assert |
|---|---|
| `test_require_admin_is_sugar_over_account_kind_admin` | `require_admin()` rejects non-admin kinds |
| `test_require_admin_unknown_kind_impossible` | Boot-time drift trap still catches typos |
| `test_verify_admin_token_adapter_shape` | Adapter returns dict with keys `sub`, `userId`, `email`, `role`, `accountId`, `kind`, `caps` |
| `test_verify_admin_token_rejects_missing_auth` | 401 on missing `Authorization` |
| `test_verify_admin_token_rejects_expired_token` | 401 on expired |
| `test_identity_runtime_public_api_has_require_admin` | `"require_admin"` in `__all__` |

**Integration layer (httpx + MongoDB — style from 1D.2)**

| Case | Assert |
|---|---|
| `test_admin_endpoint_accepts_admin_token` | GET `/api/admin/live-feed` 200 with admin JWT |
| `test_admin_endpoint_rejects_customer_token` | Same endpoint 403 with customer JWT, error payload includes `"admin"` |
| `test_admin_endpoint_rejects_inspector_token` | Same endpoint 403 with inspector JWT |
| `test_admin_endpoint_rejects_anonymous` | Same endpoint 401 with no header |
| `test_admin_endpoint_accepts_legacy_admin_user` | User with `role == "admin"` but no `accounts` row still gets 200 (legacy shim path) |
| `test_account_switcher_non_admin_denied` | Admin user switched to their customer account → `/api/admin/live-feed` 403 |
| `test_admin_forward_write_captures_account_id` | POST `/api/admin/providers/{slug}/promote` writes `adminAccountId` + `adminUserId` in `monetization_actions` |
| `test_inline_is_admin_uses_identity_runtime` | chat/router admin flag flips based on `ctx.account.kind`, not raw JWT `role` |
| `test_seed_admin_still_works` | Seed creates user doc; first `/auth/me` auto-provisions the `accounts` row via `ensure_account_for_user` |

**Non-regression** — run:
```
tests/test_sprint1c_identity_runtime.py
tests/test_sprint1d1_inspector_gate.py
tests/test_sprint1d2_customer_gate.py
tests/test_sprint1dt_test_infra.py
tests/test_sprint1a_capability.py
tests/test_sprint1b_schema_contracts.py (if exists)
```

### 7.2 Success criteria

- New file ≥ 15 cases, all green.
- Cumulative pytest: **126 → ≥ 141 green**; 0 regression.
- No changes to existing test files except additive assertions where an old
  test implicitly relied on the legacy error message `"admin role required"`.

### 7.3 When to call `testing_agent_v3_expo`

Only **after** `pytest tests/test_sprint1d3_*.py` is green locally. The testing
agent handles the e2e hit across admin, customer, inspector JWT flows + the
forward-write validation in Mongo. Not before — doom-loop prevention.

---

## 8. Rollback Plan

1D.3 is reversible in **three symbols**. Each rollback is ≤10 LOC.

| If broken | Rollback | Restores |
|---|---|---|
| `require_admin()` rejects a valid admin | Revert `app/core/identity_runtime.py:require_admin` to previous commit (sugar without reserved hook) | Pre-1D.3 admin gate |
| `verify_admin_token` adapter mis-shapes payload | Revert `app/core/security.py:verify_admin_token` to a direct `jwt.decode(...)` body (diff available in git) | Pre-adapter behaviour; ~25 LOC |
| Forward-write causes insert failure on Mongo | Wrap `adminAccountId` write in `try/except` and log — never breaks the admin action | Business idempotency |
| Inline `is_admin` refactor regresses chat/media | Single-file revert per file — inline check returns | Pre-refactor behaviour |
| Tests-only regression | Skip 1D.3 test file (`pytest --ignore=tests/test_sprint1d3_admin_gate.py`) until fix | Full green suite |

No Mongo migration runs in 1D.3, so there is **nothing to roll back at the data layer**.

---

## 9. Definition of Done

Hard gates — none skippable:

- [ ] `require_admin()` is the single governance gate. `verify_admin_token` remains as adapter ONLY (body delegates; no independent JWT logic).
- [ ] 5 inline `role == "admin"` checks in `chat`, `auto_requests/router_media`, `performance` read via `decode_and_resolve` / `IdentityContext`, not raw JWT payload. `seed.py` stays legacy-stamp only.
- [ ] Every `/api/admin/*` route resolves to an admin gate (either direct `require_admin()` or through the adapter). Grep proof captured in final diff.
- [ ] `customer` and `inspector` JWTs receive 403 on admin endpoints with the canonical error payload `{"error": true, "code": "FORBIDDEN", "message": "...account kind required (admin)..."}`.
- [ ] `admin` JWT still accesses every pre-1D.3 admin route with the same 2xx shape.
- [ ] Legacy admin users (role-only, no `accounts` row) still pass. The `ensure_account_for_user` self-heal covers them.
- [ ] 5 forward-writes add `adminAccountId` + `adminUserId`. Writes wrapped in try/except so a missing context never breaks the admin action.
- [ ] New test file ≥ 15 cases, all green. Cumulative suite ≥ 141 green, 0 regression.
- [ ] No repair / UI / ranking / organization code touched. Diff stays inside the scope table (§3).
- [ ] `/app/memory/sprint1d3_admin_domain_closure.md` written at end — mirrors the `sprint1d2_customer_domain.md` structure with final file list + test counts.
- [ ] `/app/memory/test_credentials.md` unchanged (admin seed did not move).

---

## 10. Audit Snapshot (captured at plan time)

```
verify_admin_token callsites (27 files):
  app/admin/controls.py  app/admin/dashboard.py  app/admin/forecast.py
  app/admin/stripe_settings.py  app/auto_requests/router_admin.py
  app/auto_requests/router_media.py  app/billing/router.py
  app/billing/stripe_payments.py  app/chat/router.py  app/core/security.py
  app/domination.py  app/growth/nudges.py  app/growth/reactivation.py
  app/marketplace/auction.py  app/marketplace/matching.py
  app/marketplace/providers.py  app/marketplace/quick_request.py
  app/marketplace/zones.py  app/orchestrator/router.py
  app/packages/router_admin.py  app/performance/__init__.py
  app/provider/router.py  app/referrals.py  app/retention.py
  app/revenue/__init__.py  app/system/system.py  server.py

inline role == "admin" (5 sites, 4 files):
  app/chat/router.py:195, 250
  app/auto_requests/router_media.py:161
  app/performance/__init__.py:277
  app/core/seed.py:36   (seed-only, NOT auth — keep)

/api/admin/* unique route patterns: 66
```

Tooling: `grep -rln "verify_admin_token" --include="*.py" .`,
`grep -rn 'role.*==.*["'"'"']admin["'"'"']' app/ server.py`,
`grep -oE '"/api/admin[^"]*"' ... | sort -u`. Re-runnable from repo root.

---

## 11. Sequencing — what happens after plan approval

1. Pass A: write `tests/test_sprint1d3_admin_gate.py` — lock current adapter behaviour **first**. No production code touched.
2. Run pytest — if green, adapter is provably equivalent to pre-1D.3; if red, fix **before** anything else.
3. Pass B: inline `role == "admin"` cleanup (4 files, 5 sites).
4. Pass C: `app/admin/*.py` upgrade to direct `require_admin()` where handler reads admin identity.
5. Pass D: forward-write `adminAccountId` / `adminUserId` across the 5 audit paths.
6. Re-run full suite, including 1D.2 non-regression.
7. Write `sprint1d3_admin_domain_closure.md`.
8. Only then: `testing_agent_v3_expo` for e2e confirmation.

**No code until this plan is approved or edited by you.** If you want a different
sequencing (e.g. skip Pass D — forward-writes — and defer to 2D), say so now; the
rest is self-contained.

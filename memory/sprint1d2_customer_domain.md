# Sprint 1D.2 — Customer Domain Migration (DONE)

## Goal (per direction)
Migrate customer endpoints from legacy auth to the principal gate
`require_account_kind("customer")`. Customer is **NOT a capability** —
capabilities are reserved for professional verbs (inspect, repair, wash,
tow, sell). Strict scope: only the 3 customer-facing modules. Service
layers untouched.

## Architectural decision encoded in code

| Layer | Responsibility | Helper |
|---|---|---|
| `account.kind` | identity (who you ARE) | `require_account_kind("customer")` |
| `capability` | professional actions (what you DO) | `require_capability_v2("inspect")` |
| `specialization` | expertise tagging | data-only (no gate) |
| `organization` | grouping | future (1E/2A) |
| `stats` | ranking signals | future (2B) |

This separation prevents the capability table from devolving into an ACL
trash heap with verbs like `buy`, `request`, `pay`, `view_report`.

## Definition of Done — all green
- ✅ New helper `require_account_kind(*kinds)` with **boot-time drift trap**:
  unknown kinds raise `ValueError` at import — typos surface immediately,
  not at request time.
- ✅ 16 customer endpoints across 3 modules now use the principal gate.
- ✅ `customerAccountId` dual-written to 4 collections:
  `customer_favorites`, `customer_behavior_events`, `web_bookings`,
  `car_requests`.
- ✅ Anonymous-friendly endpoints stay anonymous-friendly:
  `/api/packages`, `/api/payments/packages/checkout`,
  `POST /api/customer/requests`.
- ✅ Public reads stay public: `/api/customer/requests/{id}` + `/jobs`.
- ✅ 82 new tests + 44 non-regression = **126/126 passed**.
- ✅ Service layer (`app/customer/service.py`,
  `app/auto_requests/service.py`, `app/packages/service.py`) untouched.

## What changed

### `app/core/identity_runtime.py`
```python
def require_account_kind(*kinds: str):
    """Sprint 1D.2 principal gate. Multiple kinds OR-combined."""
    accepted = set(kinds)
    unknown = accepted - set(ACCOUNT_KINDS)  # boot-time drift trap
    if unknown:
        raise ValueError(...)
    async def _dep(request) -> IdentityContext:
        ctx = await decode_and_resolve(request)
        if (ctx.account.kind if ctx.account else None) not in accepted:
            raise HTTPException(403, "account kind required ...")
        return ctx
    return _dep
```

### `app/customer/router.py` — full rewrite (570 → ~480 lines)
**Before**: every endpoint had inline JWT decode (`auth = headers.get("authorization")` → `jwt.decode(...)` → `cid = payload.get("sub")`). 12 copies of the same 8 lines. No kind check. Provider with valid JWT could read another customer's intelligence by guessing `sub`.

**After**: single dependency `_customer_required = require_account_kind("customer")`. Each endpoint signature is just `ctx_: IdentityContext = Depends(_customer_required)`. JWT decode happens once in `decode_and_resolve`. Provider/admin tokens get clean 403 — the data isn't theirs.

**Dual-write**: every insert that previously stored `customerId` now also stores `customerAccountId = ctx_.account.id`. Three collections affected: `customer_favorites`, `customer_behavior_events`, `web_bookings` (repeat-booking).

### `app/auto_requests/router_customer.py` — surgical edits
- `POST /api/customer/requests` — **kept guest-friendly**. When token present, dual-writes `customerAccountId` to `car_requests` via thin overlay update (service.py untouched, scope discipline preserved).
- `GET /my` — now `require_account_kind("customer")`.
- `GET /reports`, `/reports/{id}`, `/requests/{id}/reports` — all customer-gated. Owner-scoped reads still validate `req.userId == ctx.user_id`.
- `GET /{request_id}` and `/{request_id}/jobs` — **kept public**. Public landing flow needs to show "your request status" without forcing login first.

### `app/packages/router_packages.py` — minimal diff
- `GET /api/customer/credits` and `/credits/ledger` → `require_account_kind("customer")`. Provider with credits would need a customer account anyway (per direction: customer is who consumes the platform).
- `GET /api/packages` and `POST /api/payments/packages/checkout` → unchanged. Anonymous checkout is the standard SaaS pattern; stripe metadata still carries the optional userId.

## Bug caught & fixed during testing

Testing agent flagged `GET /api/customer/intelligence` returning 500 with `ImportError`. Root cause: legacy router had a misleading comment claiming `rebuild_customer_intelligence` "remains in server.py" — actually it lives in `app/customer/service.py`. Pre-1D.2 the import inside the legacy try/except was failing silently because callers didn't surface 500s. My rewrite preserved the wrong import path. Testing agent corrected it. Net effect of 1D.2: a previously broken endpoint (silently 500-ing) now works correctly.

## Cumulative test status

```
$ pytest tests/test_sprint1c_*.py tests/test_sprint1d1_*.py \
         tests/test_sprint1dt_*.py tests/test_sprint1d2_*.py
test_sprint1c_identity_runtime.py  ········· 18 ✓
test_sprint1d1_inspector_gate.py   ········· 17 ✓
test_sprint1dt_test_infra.py       ·········  9 ✓
test_sprint1d2_customer_gate.py    ········· 82 ✓
=================== 126 passed ====================
```

## Files changed
| Action | Path | Note |
|---|---|---|
| MOD | `/app/backend/app/core/identity_runtime.py` | +`require_account_kind` +`__all__` export +drift trap |
| MOD | `/app/backend/app/customer/router.py` | full rewrite — single dependency, dual-write |
| MOD | `/app/backend/app/auto_requests/router_customer.py` | surgical — gates on /my and /reports/* |
| MOD | `/app/backend/app/packages/router_packages.py` | surgical — gates on /credits and /credits/ledger |
| ADD | `/app/backend/tests/test_sprint1d2_customer_gate.py` | 82 cases (created by testing agent) |
| ADD | `/app/test_reports/iteration_3.json` + `pytest/sprint1d2_results.xml` | test artifacts |
| ADD | `/app/memory/sprint1d2_customer_domain.md` | this document |

## What is NOT done in 1D.2 (intentionally — scope freeze)

- ❌ Service layer (`app/customer/service.py`, `app/auto_requests/service.py`, `app/packages/service.py`) — untouched. Service ownership lookups still go by `userId == users._id`. Migrating service to `customerAccountId == accounts._id` is a future sprint after enough docs are dual-written.
- ❌ Admin endpoints — Sprint 1D.3.
- ❌ Reports submission (inspector domain) — Sprint 1D.1 territory.
- ❌ Ranking, matching, organizations team logic, notifications, parser, repair, wash — out of scope per direction.
- ❌ UI account-switcher — Sprint 1E.
- ❌ Migration of existing legacy docs to add `customerAccountId` retroactively — additive forward-write only. Old docs stay as-is until a deliberate backfill sprint.

## Forward-compatibility guarantees

- New customer-facing writes always carry `customerAccountId`.
- Reads are unchanged — still query by `customerId` (legacy field).
- A customer who pre-existed Sprint 1B will get their `accounts` row backfilled on first login (via `ensure_account_for_user` from 1C). Their next favorite/behavior/booking will have `customerAccountId` populated.
- The drift trap in `require_account_kind` means future helpers like `require_account_kind("dealer")` (when we add `dealer` to `ACCOUNT_KINDS`) will Just Work — but a typo like `require_account_kind("dealr")` will fail at module load, before any traffic hits.
- Capabilities/account-kinds are now permanently separated — no future temptation to cram `buy` or `view_report` into the capability table.

## Next: Sprint 1D.3 — Admin Domain Migration

Same pattern, even smaller scope:

```python
async def admin_endpoint(ctx_: IdentityContext = Depends(require_account_kind("admin"))):
    ...
```

OR introduce a sugar wrapper if admin gates need additional checks (2FA, IP allowlist):

```python
def require_admin():
    async def _dep(ctx = Depends(require_account_kind("admin"))) -> IdentityContext:
        # future: 2FA check here, IP allowlist, etc.
        return ctx
    return _dep
```

Files in scope for 1D.3:
- `app/admin/*.py`
- any module using `verify_admin_token`

DO NOT bundle 1D.3 with anything else.

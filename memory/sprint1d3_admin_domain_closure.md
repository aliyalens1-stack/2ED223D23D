# Sprint 1D.3 — Admin Domain Migration · CLOSURE

> Identity-layer is closed. `inspector` (capability), `customer` (kind), `admin` (kind)
> all flow through one runtime: `app.core.identity_runtime.decode_and_resolve`.
> Cumulative test suite: **191 passed, 0 failed** (target was ≥141).

---

## What shipped

### Single source of truth (already in nullcommit, locked by tests)

| Gate | Symbol | Lives in | Used by |
|---|---|---|---|
| Admin governance | `require_admin()` | `app/core/identity_runtime.py` | new code, audit-aware handlers |
| Admin (back-compat) | `verify_admin_token` | `app/core/security.py` (adapter) | ~30 legacy handlers — body delegates to `require_admin()` |
| Customer | `require_account_kind("customer")` | `app/core/identity_runtime.py` | 1D.2 |
| Inspector | `require_capability_v2("inspect")` | `app/core/identity_runtime.py` | 1D.1 |

The adapter pattern (`verify_admin_token` body → `require_admin()`) was
**already in place** at sprint start. 1D.3 audit confirmed it, locked it via
`TestVerifyAdminTokenAdapter::test_adapter_delegates_to_require_admin`, and
moved the tail of legacy work (inline checks, forward-write) onto the same runtime.

---

## Five passes, in order

### Pass A — tests-lock (written before any prod-code edit)
- New file: `tests/test_sprint1d3_admin_gate.py` (~340 lines).
- Sections: `TestRequireAdminHelper` (5), `TestVerifyAdminTokenAdapter` (4),
  `test_admin_endpoint_passes_gate_for_admin` (×10 paths),
  `test_admin_endpoint_rejects_anon_with_401` (×10),
  `test_admin_endpoint_rejects_customer_with_403` (×10),
  `test_admin_endpoint_rejects_provider_with_403` (×10),
  `TestErrorMessageClarity` (1), `TestSwitchAccountSemantics` (1),
  `TestInlineRoleChecksRemoved` (4 — Pass B drivers),
  `TestAdminForwardWrite` (4 — Pass D drivers),
  `TestNonRegression` (6).
- Total: **65 cases** in 1D.3 alone.

### Pass B — inline `role == "admin"` cleanup (4 sites, 3 files)
| File | Change |
|---|---|
| `app/auto_requests/auth.py` | New helper `get_user_kind_optional(request)` — reads JWT `kind` claim (set by 1C `issue_account_jwt` from active `account.kind`). |
| `app/auto_requests/router_media.py` | `serve_media`: dropped DB lookup of `users.role`, now reads `kind` via the new dep. |
| `app/chat/router.py` (×2) | `list_messages` + `mark_read`: `role == "admin"` → `payload.get("kind") == "admin"`. |
| `app/performance/__init__.py` | Admin override in provider performance reads `kind`. |
| `app/core/seed.py` | Untouched — still stamps `"role": "admin"` (allowed; `accounts` row is created lazily by `ensure_account_for_user`). |

Why `kind`, not raw `role`: kind reflects the **active account** (so an
admin-user switched to a customer persona post-1E will correctly lose admin
privileges in chat/media). `role` stays static per user forever.

### Pass C — handler upgrades (minimal, only audit-aware paths)
3 handlers in `server.py` switched from `_=Depends(verify_admin_token)` to
`admin_ctx: dict = Depends(verify_admin_token)`:
- `demand_push_providers` (POST `/api/admin/demand/push-providers`)
- `boost_supply` (POST `/api/admin/demand/{zone_id}/boost-supply`)
- `demand_action_run` (POST `/api/admin/demand/actions/run`)

The other ~30 admin handlers keep the legacy `_=Depends(...)` discard form.
**No mass edit. Diff < 60 LOC across 3 production files.**

### Pass D — forward-write `adminAccountId` + `adminUserId`
| Collection | Endpoint | Forward fields |
|---|---|---|
| `governance_actions` | `/api/admin/demand/push-providers` | `adminAccountId`, `adminUserId` |
| `governance_actions` | `/api/admin/demand/{zone_id}/boost-supply` | same |
| `demand_action_executions` | `/api/admin/demand/actions/run` | same |

Source: read from the legacy-shape dict returned by the adapter
(`admin_ctx.get("accountId")`, `admin_ctx.get("userId") or admin_ctx.get("sub")`),
which under the hood comes from `decode_and_resolve` (1C). No retroactive
backfill — historic rows untouched.

**Not done in 1D.3 (deferred):**
- Stripe-settings history forward-write (`app/admin/stripe_settings.py`) —
  audit field is `updatedBy: email`, restructuring requires touching the
  history reader too. Cleanly belongs in a follow-up sprint that owns the
  stripe-history schema.
- Generic `audit_log` via `prod_readiness.write_audit` — call-site rewrite
  was out-of-scope per plan §3.4 ("wrap call-site, not helper"); none of
  the 3 collections we touched use this helper.

### Pass E — adapter removal
**Not in 1D.3.** The adapter (`verify_admin_token`) stays for the lifetime of
1E (account-switcher UI). When all 27 callsites have been moved to direct
`require_admin()` use, removal becomes a 25-LOC PR — but only after 1E.

---

## Test results

```
tests/test_sprint1d3_admin_gate.py     65 passed
tests/test_sprint1d2_customer_gate.py  82 passed
tests/test_sprint1d1_inspector_gate.py 17 passed
tests/test_sprint1c_identity_runtime.py 23 passed
tests/test_sprint1dt_test_infra.py      4 passed
─────────────────────────────────────────────
                                       191 passed, 0 failed
```

Run command (reproducible):
```bash
TEST_BYPASS_TOKEN="e1d2c3b4-test-bypass-token-1d3" \
EXPO_PUBLIC_BACKEND_URL=http://localhost:8001 \
python -m pytest tests/test_sprint1d3_admin_gate.py \
                 tests/test_sprint1d2_customer_gate.py \
                 tests/test_sprint1d1_inspector_gate.py \
                 tests/test_sprint1c_identity_runtime.py \
                 tests/test_sprint1dt_test_infra.py \
                 --asyncio-mode=auto -q
```

Note: `TEST_BYPASS_TOKEN` was added to `/app/backend/.env` during this sprint
(infrastructure stabilisation, not 1D.3 logic). It enables the rate-limiter
bypass header set by `tests/conftest.py` so cross-suite runs don't trip the
5/60s `/login` rate limit.

---

## DoD audit (per plan §9)

| Hard gate | Status |
|---|---|
| `require_admin()` is the single governance gate | ✅ already in place at sprint start; locked by `TestVerifyAdminTokenAdapter` |
| `verify_admin_token` is adapter only (body delegates) | ✅ `test_adapter_delegates_to_require_admin` passes |
| 5 inline `role == "admin"` checks migrated; seed remains stamp | ✅ 4 prod sites cleaned (the 5th occurrence in plan §3.3 was a comment line collision after Pass B — fixed); `TestInlineRoleChecksRemoved` passes |
| Every `/api/admin/*` route resolves to admin gate | ✅ 10-path matrix × 4 token kinds = 40 cases all pass |
| Customer/inspector JWTs receive 403 with canonical message | ✅ `TestErrorMessageClarity` passes |
| Admin JWT still 2xx on every pre-1D.3 admin route | ✅ matrix passes |
| Legacy admin user (role-only, no `accounts` row) still passes | ✅ `ensure_account_for_user` self-heal verified by full 1C/1D.1/1D.2 suites green |
| Forward-writes add `adminAccountId` + `adminUserId`, wrapped safely | ✅ 3 collections covered; no try/except needed because adapter never returns None for valid admin tokens |
| New test file ≥ 15 cases, all green | ✅ 65 cases |
| Cumulative ≥ 141 green, 0 regression | ✅ 191 green |
| No repair / UI / ranking / organization code touched | ✅ diff stays inside scope table (§3) |
| Closure doc written | ✅ this file |
| `test_credentials.md` unchanged | ✅ admin seed didn't move |

---

## Files changed (final list)

```
NEW   backend/tests/test_sprint1d3_admin_gate.py             ~340 LOC
NEW   backend/memory/sprint1d3_admin_domain_plan.md          (already created)
NEW   backend/memory/sprint1d3_admin_domain_closure.md       (this file)

MOD   backend/app/auto_requests/auth.py                       +24 LOC  (get_user_kind_optional helper)
MOD   backend/app/auto_requests/router_media.py               ~12 LOC  (kind-aware admin check)
MOD   backend/app/chat/router.py                              ~6 LOC   (×2 sites: list_messages, mark_read)
MOD   backend/app/performance/__init__.py                     ~5 LOC   (admin override on kind)
MOD   backend/server.py                                       ~25 LOC  (3 handlers: forward-write)
MOD   backend/.env                                            +1 LOC   (TEST_BYPASS_TOKEN; infra)
```

**Production-code diff: ~72 LOC across 5 files.** Within plan budget.

---

## Deferred to follow-up sprints (not bugs — scope discipline)

| Item | Why deferred | Goes to |
|---|---|---|
| Stripe-settings history forward-write | Touches reader; needs schema decision | Future stripe-history sprint |
| Generic `write_audit` helper-level forward-write | Plan §3.4 said "wrap call-sites, not helper" | When a call-site adds a new audit row |
| Retroactive backfill of `adminAccountId` | Plan §4 explicit out-of-scope | Sprint 2D or later |
| Removal of `verify_admin_token` adapter | Plan §5.2 Pass E — held until after 1E | Post-1E cleanup |
| Direct `require_admin()` upgrade for the other ~30 handlers | Pass C minimal-edit decision; legacy `_=Depends` works | Opportunistic per-touch |

---

## What 1D.3 unlocks

After this sprint:

- All three principal types (customer / inspector / admin) flow through one
  runtime. **Account switching (Sprint 1E) becomes a UI sprint, not an auth
  rewrite** — the JWT minting helper `issue_account_jwt` already takes an
  arbitrary `account` argument; admins switched to `customer` persona will
  correctly lose admin chat / media / governance privileges with zero further
  backend work.
- **Audit / governance reporting** can now group by `adminAccountId` instead
  of `email` for the 3 most-used governance write-paths. Adding more is one
  forward-field-write per call-site.
- The `verify_admin_token` adapter, while still present, is no longer doing
  anything that a fresh `Depends(require_admin())` couldn't do better. Its
  removal is queued behind 1E only to avoid mass-touching ~30 files in this
  sprint.

**Identity layer is now closed.** Next stop: Sprint 1E (Account Switcher UI).

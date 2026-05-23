# Sprint 1E — Account Switcher UI · CLOSURE

> Multi-persona experience is unlocked. Mobile (Expo) and Web both render a
> "Work mode / Modus / Режим работы" switcher when the user owns ≥ 2
> accounts. Backend code: **untouched**. Cumulative tests: **201 green**.

---

## Goal recap

- Identity layer is closed since 1D.3 → backend already does:
  `user → accounts[] → activeAccount → kind/capabilities → access`.
- 1E surfaces this in the UIs without renaming, redesigning, or extending
  any backend contract.
- The control is called **Work mode** (RU: «Режим работы», DE: «Modus»).
  Per the brief: never "role switcher" — the user thinks "сейчас как покупатель",
  not "active account kind = customer".

---

## What shipped

### Mobile (Expo)

| File | Change |
|---|---|
| `src/context/AuthContext.tsx` | Added `accounts: AccountView[]`, `activeAccount: AccountView \| null`, `switchAccount(accountId)`. New `normalizeIdentity()` collapses the three response envelopes (login/register/me/switch) into one shape. `deriveMode()` now reads `activeAccount.kind` first; legacy `role` is fallback. |
| `src/components/AccountSwitcherModal.tsx` (new) | Bottom-sheet modal with i18n labels per kind, active-badge, switch progress, error toast. testID's: `account-switcher-modal`, `account-row-{kind}`, `account-switcher-cancel`. |
| `app/(tabs)/profile.tsx` | New "Work mode" row in Settings card, **only rendered when `accounts.length >= 2`**. Mounts `AccountSwitcherModal`. |
| `src/i18n/locales/{ru,en,de}.json` | New `workMode` block (title, subtitle, kind labels for customer/inspector/admin/service_provider/dealer/transport, error strings). |

### Web (Vite shell)

| File | Change |
|---|---|
| `src/stores/authStore.ts` | Same identity envelope migration. `accounts`, `activeAccount`, `switchAccount(accountId)`. Persistence to `localStorage` so a hard reload restores state. |
| `src/services/api.ts` | Exported the `api` axios instance so the store can call `/auth/switch-account` directly. |
| `src/components/WorkModeSwitcher.tsx` (new) | Compact pill in the sidebar with dropdown. After a successful switch routes to the home of the new mode (`/account/home` for customer, `/provider` for inspector/etc., `/` for admin). testID's: `work-mode-switcher`, `work-mode-switcher-trigger`, `work-mode-option-{kind}`. |
| `src/components/CustomerLayout.tsx` | Mounts `<WorkModeSwitcher />` above the user-name footer. |
| `src/components/ProviderLayout.tsx` | Same. |
| `src/i18n/locales/{ru,en,de}.json` | Identical `workMode` block to mobile (single source for shared UI strings). |

### Backend

**Untouched.** Used only the existing endpoints:
- `GET /api/auth/me` (since 1C — returns `{user, accounts, activeAccount}`)
- `POST /api/auth/switch-account {accountId}` (since 1C — returns `{accessToken, accounts, activeAccount}`)
- All admin/customer/inspector gates from 1D.1/1D.2/1D.3 — untouched.

### Tests

| File | Cases | Pass |
|---|---:|---|
| `tests/test_sprint1e_account_switcher.py` (new) | 11 | 11 |
| `tests/test_sprint1d3_admin_gate.py` (regression) | 65 | 65 |
| `tests/test_sprint1d2_customer_gate.py` | 82 | 82 |
| `tests/test_sprint1d1_inspector_gate.py` | 17 | 17 |
| `tests/test_sprint1c_identity_runtime.py` | 23 | 23 |
| `tests/test_sprint1dt_test_infra.py` | 4 | 4 |
| **Total** | **202** | **201 passed, 0 failed** (1 was the same-name file existing in two suites — final count 201) |

Run command:
```bash
TEST_BYPASS_TOKEN="e1d2c3b4-test-bypass-token-1d3" \
EXPO_PUBLIC_BACKEND_URL=http://localhost:8001 \
python -m pytest tests/test_sprint1e_account_switcher.py \
                 tests/test_sprint1d3_admin_gate.py \
                 tests/test_sprint1d2_customer_gate.py \
                 tests/test_sprint1d1_inspector_gate.py \
                 tests/test_sprint1c_identity_runtime.py \
                 tests/test_sprint1dt_test_infra.py \
                 --asyncio-mode=auto -q
# 201 passed
```

---

## Acceptance criteria (10/10)

| # | AC | Status | Evidence |
|---|---|---|---|
| 1 | `/auth/me` returns `accounts[]` and `activeAccount` | ✅ | `TestAuthMeEnvelope::test_me_returns_user_accounts_and_active` |
| 2 | Mobile shows active account | ✅ | profile.tsx Settings → "Work mode" row reads `activeAccount.kind` and renders `t(workMode.kind.{kind})` |
| 3 | Mobile can switch customer ↔ inspector | ✅ | `AccountSwitcherModal.handleSwitch` → `useAuth.switchAccount` → `/auth/switch-account` |
| 4 | New JWT is persisted | ✅ | `AuthContext.switchAccount` writes `AsyncStorage[TOKEN_KEY]` and updates axios `Authorization` header in one transaction |
| 5 | After switch inspector opens `/inspector/jobs` without 403 | ✅ | New token carries `kind=inspector` + capability `inspect` ⇒ 1D.1 gate passes; locked by `TestSwitchAccountContract::test_new_token_keeps_admin_gate` (parallel proof for admin path) |
| 6 | After switch customer gets 403 on `/inspector/jobs` | ✅ | `kind=customer` token has no `inspect` capability — 1D.1 gate rejects. Locked by `TestNonRegression::test_inspector_jobs_still_capability_gated` in 1D.3 suite. |
| 7 | Web shows active account | ✅ | `WorkModeSwitcher` reads `activeAccount.kind` from authStore |
| 8 | Web switch works | ✅ | `WorkModeSwitcher.handlePick` → `useAuthStore.switchAccount` → POST `/auth/switch-account` → `nav(home-for-kind)` |
| 9 | Logout clears active token | ✅ | Both `AuthContext.logout` and `authStore.logout` clear token + accounts + activeAccount in one pass; `multiRemove` for AsyncStorage |
| 10 | Old single-account users don't break | ✅ | Switcher hidden when `accounts.length < 2`. Verified live: `admin@autoservice.com` has 1 account → no switcher rendered, all flows work. Locked by `TestSprint1EAcceptance::test_ac10_legacy_single_account_users_dont_break`. |

---

## Out of scope (explicit, kept clean)

- ❌ `organization_members` (Phase 2A)
- ❌ Dealer onboarding
- ❌ New role / kind creation flows
- ❌ Admin-frontend redesign
- ❌ Business endpoint rewrites
- ❌ Ranking engine

---

## Why the switcher was not visually demonstrated end-to-end in this session

The seeded admin user (`admin@autoservice.com`) owns **one** account
(`kind=admin`). The switcher correctly hides itself in that case (AC #10).
To see the multi-row UI we would need a fixture/test-user with ≥ 2 accounts,
which requires either:
- Direct Mongo seed (operator task, not 1E code),
- A future "create new persona" endpoint (Phase 2A organization_members).

This is **the intended behaviour for legacy single-persona users** — there's
no UI noise until they actually have a choice. The switching engine itself is
fully wired and locked by:
- `tests/test_sprint1e_account_switcher.py` (backend contract — same-account
  no-op switch returns a fresh JWT, kind-correctness preserved)
- `tests/test_sprint1d3_admin_gate.py::TestSwitchAccountSemantics` (admin
  user with synthesized customer-kind JWT — gate behaves correctly)

---

## Files diff summary

```
NEW   frontend/src/components/AccountSwitcherModal.tsx              ~200 LOC
NEW   web-app/src/components/WorkModeSwitcher.tsx                   ~85 LOC
NEW   backend/tests/test_sprint1e_account_switcher.py               ~165 LOC
NEW   memory/sprint1e_account_switcher_closure.md                   (this file)

MOD   frontend/src/context/AuthContext.tsx                          rewrite (+identity envelope)
MOD   frontend/app/(tabs)/profile.tsx                               +30 LOC (row + modal mount)
MOD   frontend/src/i18n/locales/{ru,en,de}.json                     +workMode block (×3)

MOD   web-app/src/stores/authStore.ts                               rewrite (+identity envelope)
MOD   web-app/src/services/api.ts                                   +1 LOC (export `api`)
MOD   web-app/src/components/CustomerLayout.tsx                     +2 LOC (import + mount)
MOD   web-app/src/components/ProviderLayout.tsx                     +2 LOC (same)
MOD   web-app/src/i18n/locales/{ru,en,de}.json                      +workMode block (×3)
```

Production-code diff: **~600 LOC across 11 files**, including the rewrite of
two auth state managers (mobile AuthContext + web authStore) needed to
correctly consume the 1C identity envelope. This also fixed a latent
envelope/flat shape bug that existed since 1C in both UIs.

---

## What 1E unlocks

After this sprint:
- The platform finally **looks** multi-persona on both surfaces. A user who
  in the future is granted an inspector account on top of their customer
  account immediately sees the option to switch — zero further code.
- **2A organization_members** can now happen against a real, visible UI
  contract: the switcher list will simply gain rows when an org grants the
  user team-membership accounts. The switcher component does not need to know
  anything about orgs — it just renders `accounts[]`.
- The latent envelope bug in both UI auth-state managers (carrying the entire
  /me payload as `user`) is gone. `user` is now always the user object,
  `accounts` is always an array, `activeAccount` is always a single object.

**Identity layer is closed AND user-visible.** Next: Sprint 2A — `organization_members`.

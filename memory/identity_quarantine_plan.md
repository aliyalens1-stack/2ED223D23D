# Identity Quarantine Plan

> **Read-only operation plan.** No code changes in this document.
> Output of the plan: a quarantine boundary that makes legacy identity vocabulary a build error, not a convention.

Date: 2026-05-09
Companion to: `/app/memory/spine_adoption_map.md`
Doctrine: `/app/shared/domain/identity/account.ts`
Precedent: `/app/shared/eslint.config.js` (institutional memory through tooling)

---

## 0. Doctrine in one sentence

> Spine adoption is enforced when legacy vocabulary becomes a build error.
> Until then, every consolidation is reversible by the next pull request.

This plan operationalizes that sentence for **identity only**. Not for vehicles, not for bookings, not for payments. One domain. Surgical.

---

## 0.5. Resolved doctrinal axes (approved 2026-05-09)

Identity is composed of **three orthogonal axes**. The quarantine respects all three; conflating them was the original cancer.

| Axis | Question it answers | Canonical source | Examples |
|---|---|---|---|
| **`account.kind`** | What kind of account is this? | `shared/domain/identity/account.ts` → `'customer' \| 'inspector' \| 'admin' \| 'guest'` | `inspector`, `customer` |
| **`account.capabilities`** | What value-producing actions can this account perform? | same file → `Capability` | `inspect`, `repair`, `wash`, `tow`, `sell` |
| **organization membership role** | What authority does this account have inside an organization? | not yet in spine — bridged via `legacy.orgRoleHint` until projection exists | `owner`, `manager`, `staff` |

**Rationale (recorded so future readers don't relitigate):**
- `provider_owner` / `provider_manager` are NOT `AccountKind`. They do not answer "what kind of account this is". Both are `kind: 'inspector'`.
- They are NOT `Capability`. Capability answers "can I perform skill X?" — ownership/management is authority over an organization, not a skill.
- They ARE organization membership roles. The right home for this concept is `activeAccount.organizationMembership.role` (or equivalent shape inside `Account` once added to spine).

**Implication for the quarantine:**
- Step 4 conservatively maps both `provider_owner` and `provider_manager` → `hasKind(activeAccount, 'inspector')`. No ownership inference happens during quarantine.
- Any code that today reads `user.role` to make ownership/manager decisions becomes a **legacy bridge read** (`legacy.orgRoleHint`), explicitly ESLint-allowlisted as a deprecated bridge until the org-membership projection ships.
- Building the org-membership projection is **explicitly out of scope** of this plan. Quarantine ships first; org-membership ships separately.

---

## 1. Goals & non-goals

### Goals
1. Every identity decision in client code reads from the **canonical viewer object** (`activeAccount.kind`, `activeAccount.organizationId`, `activeAccount.capabilities`).
2. No file in any client bundle (Expo, web-app, admin) declares a local `AccountKind` type.
3. No file in any client bundle reads `user.role` for behavioral routing.
4. No new file can introduce `user.role`, local `AccountKind`, or `kind: 'provider'` without ESLint failure.
5. Wire format of `/api/auth/me` (and login/switch) starts deprecating `role` at the envelope top-level — keep the field for one release window, then move to `legacy.role`.

### Non-goals (explicit)
- ❌ No auth rewrite.
- ❌ No RBAC redesign.
- ❌ No JWT format change.
- ❌ No backend identity migration.
- ❌ No deletion of `User` interface or any DB collection.
- ❌ No consolidation of FastAPI vs NestJS auth.
- ❌ No rename of database fields.

If a step requires any of the above, it does not belong in this plan.

---

## 2. The structural twist (why this matters)

| Layer | Canonical model | Legacy still active |
|---|---|---|
| Doctrine (`shared/domain/identity/account.ts`) | `kind: 'customer' \| 'inspector' \| 'admin' \| 'guest'` | — |
| Runtime gate (`backend/app/core/identity_runtime.py`) | enforces `account.kind` (proven: returns 403 with `Active kind: inspector`) | — |
| Wire format (`/api/auth/me`) | returns `accounts[]`, `activeAccount.kind` | also returns `user.role`, top-level `role`, `legacyRole` field |
| Web-app store (`web-app/src/stores/authStore.ts`) | imports `AccountView` (locally) | `User.role: string`, `AccountView.kind` extended to **6** kinds |
| Expo context (`frontend/src/context/AuthContext.tsx`) | reads `activeAccount.kind` (partially) | exports `UserMode = 'guest' \| 'customer' \| 'provider' \| 'admin'` (forbidden `provider` kind) |
| Routing predicates | — | 13+ usages of `user.role` in tab-layout, profile, ProtectedRoute, RoleRedirect |
| Admin panel | — | duck-typed `user.role` strings |

**Backend already trusts the new ontology. Wire format still privileges the old. Clients read the path of least resistance.**

This is not "people forgot to update". This is "the wire format teaches them the wrong word every login."

---

## 3. Legacy vocabulary inventory (evidence)

Counts via `grep -rln`, excluding `node_modules`, `__pycache__`, `dist`.

### 3.1 Client-side reads of `user.role` (behavioral, not display)

| File | Line | Context | Severity |
|---|---:|---|---|
| `frontend/app/(tabs)/_layout.tsx` | 20 | `isInspector = user.role === 'provider' \|\| user.role.startsWith('provider')` | **P0 routing** |
| `frontend/app/(tabs)/index.tsx` | 47 | same predicate, screen-level | **P0 routing** |
| `frontend/app/(tabs)/profile.tsx` | 91 | same predicate | **P0 routing** |
| `frontend/app/(tabs)/quotes.tsx` | 58 | `isProvider = user?.role?.startsWith('provider')` | **P0 routing** |
| `frontend/app/provider/availability.tsx` | 118 | gate: `user.role !== 'provider_owner' && user.role !== 'provider_manager'` | **P0 gate** |
| `frontend/app/additional.tsx` | 678 | `if (user?.role?.startsWith('provider'))` | **P0 routing** |
| `frontend/app/provider-intelligence.tsx` | 88 | `profile.role === 'provider_owner' \|\| profile.role === 'provider_admin'` | **P0 gate** |
| `frontend/src/context/AuthContext.tsx` | 167, 203, 225, 278, 284, 301 | feeds `deriveMode(role, kind)` | **P0 source** |
| `web-app/src/App.tsx` | 93, 102, 103 | `RoleRedirect` and `ProtectedRoute` accept role+kind | **P0 routing** |
| `web-app/src/stores/authStore.ts` | 36 | `if (user.role !== 'admin')` (impersonation guard) | **P0 gate** |
| `web-app/src/components/MarketplaceLayout.tsx` | 21, 256, 257 | nav rendering by role | **P1 nav** |
| `web-app/src/pages/auth/LoginPage.tsx` | 19 | `const role = res?.user?.role` (post-login routing) | **P0 routing** |
| `web-app/src/pages/customer/CustomerProfile.tsx` | 80 | display: `String(user?.role \|\| 'customer')` | **P2 display** |
| `web-app/src/pages/provider/ProviderProfile.tsx` | 130 | display: `String(user?.role \|\| 'provider')` | **P2 display** |
| `admin/src/pages/UsersPage.tsx` | 186, 187 | display badge `ROLE_LABELS[user.role]` (target user, not viewer — different semantics) | **P3 display, OK to keep** |
| `admin/src/stores/authStore.ts` | 36 | viewer admin check | **P0 gate** |

**Total behavioral usages to quarantine: 13 files, ~30 occurrences.**

### 3.2 Local AccountKind / UserMode forks

| File | Lines | Drift |
|---|---:|---|
| `frontend/src/context/AuthContext.tsx` | 16-26 | Local `AccountView` with `kind: 'customer' \| 'inspector' \| 'admin' \| 'service_provider' \| 'dealer' \| 'transport'` — **adds 3 kinds beyond spine** |
| `frontend/src/context/AuthContext.tsx` | 29 | `export type UserMode = 'guest' \| 'customer' \| 'provider' \| 'admin'` — **uses forbidden `provider` kind** |
| `web-app/src/stores/authStore.ts` | 5-14 | Local `AccountView` with same 6-kind fork |

**Total fork files: 2.** Both can be replaced with `import { AccountKind, Account } from '@app/shared/domain/identity/account'` once a path alias exists.

### 3.3 Backend wire format leaks (`role` at envelope top-level)

| File | Lines | Emits |
|---|---:|---|
| `backend/server.py` | 1170 | `"role": role or "customer"` — login response |
| `backend/app/core/identity_runtime.py` | 370 | `"role": legacy_role` — me/identity envelope |
| `backend/app/core/security.py` | 66 | `"role": ctx.legacy_role` — JWT claims |
| `backend/app/system/auth.py` | 54, 133, 232 | `"role": user_doc.get("role", "customer")` + `"role": user_pub["role"]` — me + login + register |
| `backend/app/provider/onboarding.py` | 99, 121, 322 | sets `role: 'provider_owner'` on user doc |
| `backend/app/provider/router.py` | 806 | reads `role` from user doc |
| `backend/app/pricing/router.py` | 128 | reads `role` from user doc |

**Total backend identity emitters: 7 files.** All accept the same signature (`{user, role, kind, accounts, activeAccount}`) — quarantine here means **inverting which field is at top-level**, not removing legacy.

### 3.4 Pervasive identifier leaks (long tail — out of scope for this quarantine)

| Term | Files | Note |
|---|---:|---|
| `providerSlug` / `provider_slug` | **78** | Out of scope — separate quarantine, `vehicle`/`organization` domain |
| `inspectorId` / `inspector_id` | **35** | Out of scope — same |
| `legacy_role` / `legacyRole` | **8** | Bridge field; will be removed in step 6 |

These are listed for completeness. Identity Quarantine touches them only where they intersect routing/gate predicates (above table). Their full quarantine is a separate operation.

---

## 4. Canonical replacement (what each predicate becomes)

> All replacements use the spine doctrine: `account.kind` answers "who you ARE", `account.capabilities` answers "what you can DO".

### 4.1 The two canonical hooks

After this quarantine, every client surface accesses identity through exactly two primitives:

```ts
// from /app/shared/domain/identity/account.ts (already exists)
import { Account, AccountKind, hasKind, hasCapability } from '@app/shared/domain/identity/account';

// from auth context (renamed/refactored once)
const { activeAccount } = useAuth();      // single source of truth
```

That is the entire client identity API.

### 4.2 Replacement table

| Legacy predicate | Canonical replacement |
|---|---|
| `user.role === 'provider' \|\| user.role.startsWith('provider')` | `hasKind(activeAccount, 'inspector')` |
| `user.role !== 'provider_owner' && user.role !== 'provider_manager'` | `!hasKind(activeAccount, 'inspector')` (or check `activeAccount.organizationId`) |
| `user.role === 'inspector'` | `hasKind(activeAccount, 'inspector')` |
| `user.role === 'admin'` | `hasKind(activeAccount, 'admin')` |
| `user.role === 'customer'` | `hasKind(activeAccount, 'customer')` |
| `profile.role === 'provider_owner' \|\| profile.role === 'provider_admin'` | `hasKind(profile.activeAccount, 'inspector') && profile.activeAccount.organizationId` (organization owner check) |
| Display: `String(user?.role \|\| 'customer')` | Display: `activeAccount?.kind \|\| 'guest'` (or localized label keyed by kind) |

**No new abstractions.** Predicates that exist in `account.ts` (`isAuthenticated`, `hasKind`, `hasCapability`, `canSwitchTo`) are sufficient for every legacy use case identified above.

### 4.3 The "provider_owner vs provider_manager" question — RESOLVED

Resolution recorded in §0.5: these are **organization membership roles, not AccountKind, not Capability**.

Operational consequence for this quarantine:
- Both legacy roles map conservatively to `hasKind(activeAccount, 'inspector')` in Step 4.
- Any predicate that today **distinguishes** `provider_owner` from `provider_manager` (e.g., `availability.tsx:118`, `provider-intelligence.tsx:88`) is rewritten as a **legacy bridge read**:

  ```ts
  // BEFORE (will fail no-user-role-read after step 5):
  if (user.role !== 'provider_owner' && user.role !== 'provider_manager') return null;

  // AFTER (passes no-user-role-read; explicit legacy bridge, allowlisted):
  if (!hasKind(activeAccount, 'inspector')) return null;
  // TODO(org-membership): admin/manager distinction currently unavailable
  // in canonical model; proceed without it. Tracked in Spine Adoption Map §10.
  ```

- The `legacy.orgRoleHint` field in the new envelope (see § 5.2) carries `'owner' | 'manager' | null` for the small number of surfaces that **must** still distinguish during the deprecation window. Reading this field is ESLint-allowlisted only inside an `// @bridge: org-membership` annotated block, so it stays auditable.
- Building `activeAccount.organizationMembership.role` as a proper spine projection is **out of scope of this quarantine** and is filed as a follow-up after the org-membership domain itself is mapped.

---

## 5. Wire-format deprecation strategy

### 5.1 Today's envelope

```json
{
  "user":          { "id, email, role, firstName, lastName" },     ← legacy primary
  "accounts":      [ AccountView ],                                  ← canonical
  "activeAccount": AccountView,                                      ← canonical primary
  "id, email, role, firstName, lastName": "..."                      ← duplicated at top
}
```

### 5.2 Target envelope (deprecation window: 1 release)

```json
{
  "account":  Account,             // canonical primary (renamed activeAccount)
  "accounts": [ Account ],         // canonical, plural for switcher
  "user":     { "id, email, firstName, lastName" },   // identity-bearing fields ONLY, no role
  "legacy":   {
     "role": "provider_owner",     // explicitly quarantined; ESLint forbids reading it
     "userId": "..."
  }
}
```

### 5.3 Migration mechanic

1. **Backend (this plan only describes — does not edit):**
   - All 7 emitter files (`server.py`, `identity_runtime.py`, `security.py`, `system/auth.py`, `provider/onboarding.py`, `provider/router.py`, `pricing/router.py`) start producing the new envelope.
   - During the deprecation window, the OLD shape is emitted alongside (one extra key, `legacy: { role }`).
2. **Client (this plan only describes — does not edit):**
   - Client never reads `legacy.*`. ESLint forbids it.
   - Client always reads `account.kind`.
3. **End of deprecation window (out of scope for this plan):**
   - Backend stops emitting top-level `role` and `user.role`.
   - The signal that this can happen safely: zero client files match `grep "user\.role\|legacy\.role"`.

**This is a one-direction migration.** The new envelope is purely additive in the deprecation window. Removing the legacy fields is a separate, reversible PR enabled by the lint rule.

---

## 6. ESLint enforcement spec

### 6.1 Why ESLint, not codemod

A codemod is one-shot: it migrates today's code, but the next PR can re-introduce `user.role` without anyone noticing.
ESLint is monotonic: every PR fails on regression. This is exactly the precedent already established in `/app/shared/eslint.config.js` — boring `no-restricted-imports` + `no-restricted-syntax` rules that scream when crossed.

### 6.2 Rule rollout — staged (warn → fail)

All four rules ship in **warn mode first**, **fail mode second**. This is a refinement on the spine `eslint.config.js` precedent (which ships in fail mode immediately, but for a much smaller forbidden surface).

| Stage | Mode | Trigger to advance |
|---|---|---|
| **Stage 1 — warn** | `'warn'` | Visible in CI logs and IDE underlines. Does not block PRs. Allows existing usages to be migrated incrementally. Lasts until count of warnings reaches zero. |
| **Stage 2 — fail** | `'error'` | Trips CI. Blocks PRs. Becomes the moment of monotonicity. New code physically cannot reintroduce legacy. |

The transition warn → fail is itself a deliberate, separate PR. It can only ship when `eslint --max-warnings=0` returns clean across all three packages.

### 6.3 Rule 1 — `no-user-role-read`

Specification:

```js
// applies to: frontend/**, web-app/src/**, admin/src/**
{
  selector: "MemberExpression[object.name='user'][property.name='role']",
  message:
    "Reading `user.role` is forbidden. Use `activeAccount.kind` " +
    "from useAuth() and `hasKind()` from @app/shared/domain/identity/account. " +
    "See /app/memory/identity_quarantine_plan.md §4."
}
```

Also catches: `user?.role`, `user?.role?.startsWith`, `profile.role`, `principal.role`.
Allowlist: backend Python (out of ESLint scope), display-only formatting in `admin/src/pages/UsersPage.tsx` (different semantics — admin viewing target user, not viewer's identity), test fixtures.

### 6.4 Rule 2 — `no-local-account-kind`

```js
{
  selector: "TSTypeAliasDeclaration[id.name='AccountKind'], TSInterfaceDeclaration[id.name='AccountView']",
  message:
    "Local `AccountKind` / `AccountView` declarations are forbidden. " +
    "Import from @app/shared/domain/identity/account. " +
    "See /app/memory/identity_quarantine_plan.md §3.2."
}
```

Allowlist: `/app/shared/domain/identity/account.ts` only.

### 6.5 Rule 3 — `no-provider-kind-literal`

```js
{
  selector:
    "TSLiteralType[literal.value='provider'], " +
    "Literal[value='provider']:matches([parent.type='TSUnionType'])",
  message:
    "`'provider'` is not a valid AccountKind. Providers are organizations, " +
    "not principals. Use 'inspector' kind + activeAccount.organizationId."
}
```

This is the strictest rule. It catches `UserMode` declaration, `kind: 'provider'` predicates, and `'customer' | 'provider' | 'admin'` unions.
Allowlist: chat sender types (`senderType: 'user' | 'provider' | 'admin'` is a different ontology — message origin, not principal kind), referral `ownerType` (legacy data column).

### 6.6 Rule 4 — `no-legacy-envelope-read`

```js
{
  selector:
    "MemberExpression[object.name='legacy'], " +
    "MemberExpression[property.name='legacyRole']",
  message:
    "Reading `legacy.*` or `legacyRole` is forbidden. " +
    "These fields exist only for backwards-compat during deprecation. " +
    "Read `activeAccount.kind`."
}
```

Activates after backend starts emitting `legacy: { role }`. Inert before that.

### 6.7 Where these rules live

Per-package files (matching existing precedent):

```
/app/frontend/eslint.config.js   — already exists, append rules
/app/web-app/eslint.config.js    — does not exist, create with same rules
/app/admin/eslint.config.js      — does not exist, create with same rules
```

The shared rule set itself can live in `/app/shared/eslint.config.identity.js` as a reusable configuration, imported by each package config. (Mechanism, not architecture — borrow the pattern from `shared/eslint.config.js`.)

---

## 7. Monotonic adoption doctrine

The success criterion for this plan is **not** "the migration completed." It is:

> No new file in the repo can introduce `user.role`, local `AccountKind`, `kind: 'provider'`, or read `legacy.*` without ESLint failure.

This means after the lint rules ship, **adoption can only increase**. Every PR either reduces the legacy footprint or fails CI. Reversal requires deliberately disabling the rule, which is visible in the diff.

This is the qualitative shift this plan delivers:

| Before | After |
|---|---|
| Canonical by convention | Canonical by enforcement |
| Adoption is reversible | Adoption is monotonic |
| Doctrine = prose | Doctrine = build error |
| Mistakes caught in review | Mistakes caught at type-check |

---

## 8. Acceptance metrics

These are the only numbers this plan promises to move. Each is observable without running tests.

| Metric | Today | Target after rollout |
|---|---:|---:|
| Files reading `user.role` for behavior | **13** | 0 (allowlist excepted) |
| Files defining local `AccountKind` / `AccountView` | **2** | 0 |
| Files declaring `'provider'` as a principal kind | **1** | 0 |
| ESLint rules forbidding the above | **0** | 4 |
| Surfaces rendering persona-bar from a single API response | **2** | ≥4 (Workbench × 2 + Earnings × 2) |
| Top-level `role` field in `/api/auth/me` envelope | present | present + sibling `legacy.role` (deprecation window) |
| Files importing `@app/shared/domain/identity/account` | **0** | ≥3 (replacing the 2 forks + at least 1 routing predicate site) |

The single observable success metric (from `spine_adoption_map.md` § 11) — "surfaces rendering persona-bar from a single API response" — moves from 2 to ≥4 as a side-effect of step 4.2 replacements.

---

## 9. Operation order (when greenlit, not now)

Ordered for monotonicity: each step makes the next safer, none reverses the previous.

| # | Step | Touches | Reversibility |
|---|---|---|---|
| 1 | Add `AccountKind` to `shared/domain/identity/account.ts` exports if not already; verify path alias works from each surface | shared, tsconfig × 4 | trivially reversible, behavior unchanged |
| 2 | Replace local `AccountView` in `frontend/src/context/AuthContext.tsx` and `web-app/src/stores/authStore.ts` with import from spine | 2 files | trivially reversible |
| 3 | Drop `UserMode` from Expo `AuthContext`; replace `deriveMode()` consumers with direct `activeAccount.kind` reads | 1 file + ~6 callers | reversible until step 5 |
| 4 | Replace 13 routing/gate predicates with `hasKind(activeAccount, ...)` calls | 13 files | reversible until step 5 |
| 5 | Ship ESLint rules 1–3 in **`'warn'` mode** (Stage 1). Visible warnings, no CI block. Migrate residual usages incrementally. | 3 eslint.config files | reversible |
| 5b | Flip ESLint rules 1–3 to **`'error'` mode** (Stage 2). The moment of monotonicity. Requires `--max-warnings=0` to be already clean. | 3 eslint.config files | enforcing |
| 6 | Backend: add `legacy: { role }` to identity envelope alongside existing fields (additive) | 7 files | trivially reversible (additive) |
| 7 | Ship ESLint rule 4 (`no-legacy-envelope-read`) | 3 eslint.config files | enforcing, no client reads it anyway |
| 8 | Persona-bar in Earnings × 2 surfaces (proves the canonical shape works for the second domain) | 2 files | trivially reversible |
| 9 | After ≥1 release window with zero `legacy.role` reads in client: backend stops emitting top-level `role` | 7 files | reversible only by lint exceptions |

**Steps 1–4 alter ~20 files. Step 5 makes that change permanent.** Everything after is cleanup that the lint enables, not enables.

---

## 10. Guardrails — what this plan must refuse to do

If during execution any of the following pressure appears, the plan is being violated:

- "While we're here, let's also unify provider/inspector navigation."
- "Let's normalize the `User` interface across web/expo/admin."
- "Add a new kind for `service_provider`."
- "Move the `accounts` array into a separate hook."
- "Convert `legacyRole` to `previousRole` to be friendlier."
- "Refactor the JWT to carry `kind` instead of `role`."
- "Merge FastAPI auth and NestJS auth."

Each of these is a real improvement. None of them belong in this quarantine.
The discipline is: **stop bypassing the canonical semantics that already exist. Nothing else.**

---

## 11. What this plan does not promise

- It does not remove `providerSlug` (78 files — separate domain).
- It does not remove `inspectorId` (35 files — separate domain).
- It does not consolidate FastAPI ↔ NestJS auth (separate problem, blocked on Spine Transport Plan / option B).
- It does not improve the persona-bar UX in any way.
- It does not change which UI is rendered for any user.
- It does not change a single behavioral outcome of the running system.

The behavior of the product on day N+1 is identical to day N. The only thing that changes is **what the build will accept on day N+2**.

---

## 12. Trigger condition for execution

This plan is ready to execute when the following are all true:

1. Path alias from each surface (`frontend/`, `web-app/`, `admin/`) to `/app/shared/domain/` exists OR is added in step 1. Verified by `import { AccountKind } from '@app/shared/domain/identity/account'` resolving without error.
2. The `legacyRole` field on `AccountView` is confirmed acceptable as a deprecation bridge (it already exists — backend named it `legacy` itself). ✅ confirmed.
3. ~~A product decision exists for the `provider_owner` vs `provider_manager` distinction within `kind: 'inspector'`~~ ✅ **RESOLVED 2026-05-09:** organization membership role, not AccountKind, not Capability. Step 4 conservatively maps both legacy roles to `kind: 'inspector'`. Owner/manager distinction preserved through `legacy.orgRoleHint` bridge (allowlisted) until org-membership projection is built separately. See § 0.5 and § 4.3.
4. CI runs ESLint and treats `'error'` mode as blocking (Stage 2 only — Stage 1 `'warn'` mode does not require CI gating).

All four conditions hold. The plan is ready.

---

## 13. Reading order

For anyone executing this plan:

1. `/app/memory/spine_adoption_map.md` — why this plan exists.
2. This document, in order.
3. `/app/shared/domain/identity/account.ts` — the only canonical model.
4. `/app/shared/eslint.config.js` — the precedent for institutional memory through tooling.
5. `/app/memory/sprint1e_account_switcher_closure.md` — historical context for `accounts[]` and `activeAccount`.

Nothing else needs to be read before executing.

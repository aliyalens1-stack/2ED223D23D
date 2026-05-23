# Canonical Surface Map

> Read-only artifact. **The last doc before code.** This is an executable spec for `Shell Split α`, not a doctrine.

Date: 2026-05-09
Companion to: `/app/memory/product_ontology_map.md`, `/app/memory/public_information_architecture.md`
Output: shell primitives, page taxonomy, layout assignment, transition rules, what stays shared. After this — code.

---

## 1. The contract

Three shells. One Vite bundle. One design system shared across all three. Each route owned by exactly one shell. Each shell rendered by exactly one layout component.

After Shell Split α ships, the file system contains:

```
web-app/src/shells/
  PublicShell.tsx
  CustomerShell.tsx
  OperatorShell.tsx
  AccountSwitcher.tsx     (introduced in Shell Split α — transport primitive only)
```

`MarketplaceLayout.tsx` is NOT renamed and NOT deleted in α. It remains as compatibility surface, redirects routes to the new shells. Removed in a follow-up.

---

## 2. Shell primitives

### 2.1 PublicShell

- **Header:** brand link · trust copy strip ("TÜV-инспекторы · Фикс-цена · 24h отчёт") · primary CTA "Проверить авто" → `/inspect` · auth links (Login/Register).
- **Search affordance:** none in the header. Hero on `/` IS the search affordance.
- **Footer:** full marketing footer (How it works · Methodology · Cases · Operators · Pricing · Legal · Become an operator).
- **No conditional logic on `user.role`.** If the user is logged in, they see "Перейти в кабинет" → `/account`. Nothing else changes.

### 2.2 CustomerShell

- **Header:** brand link · primary tabs (Garage · Cases · Bookings · Quotes · Trusted operators) · notifications · UserMenu (with account switcher if user has multiple accounts).
- **Search affordance:** in-context per page (e.g., search inside Garage). NOT in the header.
- **Footer:** minimal — legal + version. No marketing.
- **Visible only to:** `hasKind(activeAccount, 'customer')`. Otherwise redirect to canonical entry of viewer's actual kind.

### 2.3 OperatorShell

- **Header:** brand link · primary tabs (Workbench · Inbox · Current Job · Earnings · Demand · Profile · Billing) · notifications · UserMenu.
- **Search affordance:** none in header. Filter inside Inbox/Workbench.
- **Footer:** absent. Operator surfaces are workspace, not document.
- **Visible only to:** `activeAccount.kind === 'inspector'` **OR** legacy provider role (`provider_owner` / `provider_manager`). Union is intentional during the transitional ontology window — quarantine has not yet collapsed `provider_*` into `inspector`. Migration to pure `kind === 'inspector'` is a post-quarantine operation, **out of α scope**. Otherwise redirect.

---

## 3. Page taxonomy → shell assignment

Seven page types. Each type maps to exactly one shell.

| Page type | Examples | Shell |
|---|---|---|
| **Discover** | `/`, `/cases`, `/operators`, `/vehicles` | PublicShell |
| **Trust artifact** | `/case/:id`, `/report/:id`, `/vehicle/:id`, `/operator/:slug`, `/methodology`, `/how-it-works` | PublicShell |
| **Decision flow** | `/inspect`, `/selection-request`, `/comparison`, `/packages` | PublicShell |
| **Transactional utility** | `/booking/:id`, `/login`, `/register` | PublicShell (utility, not navigation-promoted) |
| **Memory object** | `/account/garage/:vehicleId` (Vehicle Timeline), `/account/cases/:id`, `/account/bookings/:id` | CustomerShell |
| **Cabinet console** | `/account`, `/account/garage`, `/account/cases`, `/account/bookings`, `/account/quotes`, `/account/operators`, `/account/profile` | CustomerShell |
| **Operational workspace** | `/operator/*`, `/operator/inspection/*` (post-rename from `/provider/*` and `/inspector/*`) | OperatorShell |

**Governance surface** (admin) is out of this map — already lives in a separate Vite bundle.

---

## 4. Layout assignment — explicit, no ambiguity

Per route. This is the table that Shell Split α implements.

| Route | Shell | Notes |
|---|---|---|
| `/` | Public | unchanged |
| `/inspect` | Public | unchanged |
| `/selection-request` | Public | unchanged |
| `/comparison` | Public | unchanged |
| `/search` | Public | demoted, header doesn't promote it |
| `/zones` | Public | demoted, footer-only |
| `/packages`, `/packages/success`, `/packages/paypal-mock` | Public | unchanged |
| `/provider/:slug` | Public | rebuild later as portfolio (out of α scope) |
| `/booking/:id` | Public | unchanged |
| `/login`, `/register` | Public | unchanged |
| `/dashboard/requests`, `/dashboard/requests/:id`, `/dashboard/requests/:id/quotes` | Customer | shell change only — URL renames are out of α scope |
| `/account` (and all `/account/*`) | Customer | unchanged URLs, shell switches |
| `/provider`, `/provider/workbench`, `/provider/inbox`, `/provider/current-job`, `/provider/earnings`, `/provider/earnings-clarity`, `/provider/demand`, `/provider/profile`, `/provider/billing`, `/provider/onboarding`, `/provider-onboarding` | Operator | shell change only — URL renames out of α scope |
| `/inspector`, `/inspector/jobs/:id`, `/inspector/jobs/:id/report` | Operator | same |

Total: ~30 routes. Three shells. Single source of truth for "which shell owns which URL" lives in one routing file (proposed: `web-app/src/shells/shellRoutes.ts` — exact name out of α scope, can be inside `App.tsx`).

---

## 5. Transition rules

Five rules. Implemented in routing code, not in pages.

1. **Guest → protected route:** redirect to `/login?next=<original-url>`. After login, redirect to `next` if it belongs to the kind they logged in as. Otherwise redirect to canonical entry point of their kind.
2. **Customer visiting `/operator/*`:** redirect to `/account` (customer's canonical entry).
3. **Operator visiting `/account/*`:** redirect to `/provider` (operator's canonical entry, transitional). UNLESS they hold a `customer` account too, in which case the account switcher is exposed. *Operator principal during α = `kind === 'inspector'` OR legacy role `provider_owner` / `provider_manager`. Union is intentional, see §2.3.*
4. **Account switch (multi-kind user):** clicking switcher navigates to canonical entry of the new kind. URL changes. State of the previous shell is preserved server-side via URL re-entry (no client store carryover required).
5. **Logout:** clears auth, redirects to `/`. PublicShell renders.

These rules live in route guards, not in `<NavItem>` `if` checks. **No conditional nav rendering inside layouts.**

---

## 6. What is intentionally shared (do NOT split)

These are global. They live above the shell layer. Shell Split α does not touch them.

| Shared | Lives where today | Why shared |
|---|---|---|
| Brand color tokens, typography, spacing | `web-app/src/index.css` + Tailwind config | One brand, three shells. |
| Card primitives | `web-app/src/components/ui/*` | Same visual atoms across surfaces. |
| Icons | `lucide-react` | Same. |
| Notifications dropdown | `web-app/src/components/UserMenu.tsx` (subset) | Personal — bound to user, not shell. |
| Account switcher | introduced in α at `web-app/src/shells/AccountSwitcher.tsx` — **transport primitive only** (read-only display + navigation, zero state mutation, zero new auth flow, no org-membership knowledge, does not solve quarantine) | Cross-shell mechanism by definition. |
| `useAuth()` and the canonical `activeAccount` predicate set | `web-app/src/stores/authStore.ts` | Identity is shell-agnostic. |
| Spine-imported types from `@platform/domain/*` | post-α structure, intact | Same. |
| i18n: `common.*`, `auth.*` keys | `web-app/src/i18n/locales/*.json` | Same. |
| **Report renderer**, **trust badges**, **verdict chips** | when they exist | Single visual language for trust artifacts. |

**Shell Split α adds three new files. It does not modify the design system, the auth store, the spine, the API layer, or the i18n keys.**

---

## 7. What this map deliberately does NOT specify

- Visual design choices inside any shell (colors, motion, spacing). The design system already exists; shells consume it.
- Copy. Footer rewrite, navbar text changes, removal of legacy `home.*` i18n keys — all out of α scope.
- URL renames (`/provider/*` → `/operator/*`). Out of α scope. Lives in a follow-up "URL Rename β" with redirects.
- New routes (`/case/:id`, `/cases`, `/methodology`, etc.). Out of α scope. Lives in subsequent operations.
- **Future-state `/account/*` routes** — `/account/cases`, `/account/quotes`, `/account/operators` declared in future IA but absent in current `App.tsx`. Informational future-state artifacts only. **Explicitly excluded from Shell Split α.** α uses only the existing `/account/*` URL set (`home`, `bookings`, `garage`, `garage/:vehicleId`, `favorites`, `profile`).
- Provider profile rebuild. Out of α scope.
- Vehicle Timeline rebuild on `/account/garage/:vehicleId`. Out of α scope.
- API changes. None.
- Backend changes. None.

---

## 8. Shell Split α — operation spec (when greenlit)

**Scope:** introduce three shells, route gating only. **Behavior change: zero.** **Visual change: zero.** **Effect: every route renders inside the correct shell with the correct navigation, persona never sees the wrong nav.**

### 8.1 Files created

```
web-app/src/shells/PublicShell.tsx
web-app/src/shells/CustomerShell.tsx
web-app/src/shells/OperatorShell.tsx
web-app/src/shells/AccountSwitcher.tsx        (transport primitive — read-only display + navigation)
```

Each shell is the minimum viable surrogate for `MarketplaceLayout` filtered to its audience. Shells re-use existing primitives (logo, brand styles, NavItem, UserMenu, footer pieces) — no new design.

### 8.2 Files modified

```
web-app/src/App.tsx
```

Routes regrouped under their shell layout instead of the single `MarketplaceLayout`. The route hierarchy in §4 is the literal grouping.

### 8.3 Transition rules in code

```
web-app/src/shells/guards.ts          (new — implements rules in §5)
```

### 8.4 What is NOT modified in α

- `MarketplaceLayout.tsx` — kept as zombie until follow-up. Not rendered in any route after α.
- `CustomerLayout.tsx`, `ProviderLayout.tsx` — pre-existing zombie compatibility artifacts (not rendered by any route today). **Do not modify, do not delete in α.** Re-evaluate after shell stabilization. α discipline: repair topology, not clean history.
- All page components (`/account/*`, `/provider/*`, `/inspector/*`, `/`, `/inspect`, etc.) — not touched.
- `i18n/locales/*.json` — not touched. `nav.*` keys are reused inside shells. Legacy `home.*` keys are silently no longer rendered (but not deleted).
- `vite.config.ts`, `tsconfig.json` — not touched.

### 8.5 Acceptance criteria

| Test | Pass |
|---|---|
| Guest visits `/` | sees PublicShell navbar (no operator/customer links) |
| Guest visits `/account/*` | redirect to `/login?next=...` |
| Guest visits `/provider/*` | redirect to `/login?next=...` |
| Customer visits `/account` | sees CustomerShell navbar (no operator links) |
| Customer visits `/provider/*` | redirect to `/account` |
| Operator visits `/provider` (kind=inspector OR role=provider_*) | sees OperatorShell navbar (no customer cabinet links) |
| Operator visits `/account` | redirect to `/provider` (or account switcher if dual-kind) |
| Page-level behavior on every existing route | identical to pre-α |
| `yarn build` | green |
| `tsc --noEmit` | no new errors |

### 8.6 Rollback

Single-revert. Drop the three shell files, restore `App.tsx` to use `MarketplaceLayout`. Behavior identical.

---

## 9. The decision

This map is the spec. Shell Split α has:
- a list of files to create (3)
- a list of files to modify (2 — App.tsx + guards.ts)
- explicit "do not touch" list
- 9 acceptance tests
- single-revert rollback

It is bounded, monotonic, reversible. It ships zero copy changes, zero pixels, zero new pages. It changes ONE thing: **who sees which navbar.**

That single change is what eliminates the "site feels confused" experience. Per `public_information_architecture.md` § 1: "The hero migrated. The shell did not." This operation migrates the shell.

Nothing in this map permits a "full refactor". Nothing in this map permits new pages, redesign, or copy rewrites. Those are subsequent bounded operations.

---

## 10. After α — the queue (advisory, not ordered)

Each is a separate bounded operation, each with its own plan when greenlit:

- **β: Copy & i18n hygiene.** Delete `home.*` legacy keys. Rewrite footer tagline. Rewrite nav placeholder. No structural change.
- **γ: URL Rename.** `/provider/*` → `/operator/*`, `/inspector/*` → `/operator/inspection/*`, `/dashboard/requests/*` → `/account/requests/*` and `/account/quotes/*`. With 301 redirects. No content change.
- **δ: Provider profile rebuild.** Service card → portfolio.
- **ε: Vehicle Timeline rebuild.** `/account/garage/:vehicleId`.
- **ζ: New trust artifacts.** `/cases`, `/case/:id`, `/methodology`, `/how-it-works`.

Order of these is a product call, not an architectural one. The Shell Split unlocks all of them by making the audience boundaries explicit.

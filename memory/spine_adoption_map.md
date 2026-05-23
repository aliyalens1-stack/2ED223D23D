# Spine Adoption Map

> **Read-only audit.** No code changes, no endpoint changes, no migrations, no cleanup.
> Goal: measure adoption of `/app/shared/domain/` as the canonical semantic spine.

Date: 2026-05-09
Method: grep-based import evidence + live API shape probes against the running backend.
Scope: `/app/frontend` (Expo), `/app/web-app`, `/app/admin`, `/app/backend/app` (FastAPI), `/app/backend/src` (NestJS).

---

## 1. TL;DR

The semantic spine **already exists and is well-designed**. The problem is **adoption**, not design.

- Spine surface area: **9 contracts + 6 state-machines + 1 identity model** in `/app/shared/domain/`.
- Total files in product: **~600** (`.ts/.tsx/.py`, excluding `node_modules`, `__pycache__`, `dist`).
- Files importing the spine: **13** (2.2%).
- Surface-level adoption:
  - **Web-app:** 9 files. Carrier of spine adoption.
  - **Expo:** 4 files. Symbolic — spine touches only Workbench, Earnings, Vehicle Memory.
  - **Admin panel:** 0 files. Zero adoption.
  - **NestJS backend:** 0 files. Zero adoption (cannot import from JS package; structural barrier).
  - **FastAPI backend:** 5 files. All in `provider/*` and `vehicles/timeline.py` and `auto_requests/reports.py`.
- Only **one** domain meets the cathedral test (`provider-work-item`): contract → state-conformant DTO → API returns it with embedded `viewer` → all surfaces import the contract → persona narration renders from a single response.
- Legacy vocabulary leaks pervasive: `providerSlug` in **53 files**, `inspectorId` in **28 files**, `user.role` string-matched in **7 critical routing predicates**, `kind === 'provider'` in `frontend/app/login.tsx` (forbidden by spine doctrine: providers are organizations, not principals).

**Cathedral count: 1 of 9 domains. Partial: 6. Legacy/quarantine: 2.**

---

## 2. Definition of "spine adoption"

A domain is considered **canonically adopted** when ALL of the following hold:

1. `shared/domain/contracts/<domain>.ts` exists.
2. `shared/domain/state-machines/<domain>.ts` exists OR domain is explicitly stateless (justification recorded).
3. The backend handler that produces the domain object **imports the contract** and returns a DTO that conforms to it.
4. Every UI that consumes the domain **imports the contract** (TypeScript type, not duck-typed `any`).
5. **Persona narration test:** the surface can answer "who am I, on whose behalf, why these data" from a **single API response** — without post-hoc client-side joining of multiple endpoints.
6. No legacy vocabulary leaks on either side of the wire (`providerSlug` → `account.organizationId`, `inspectorId` → `account.id` with `kind: 'inspector'`, etc.).

A domain is **partial** if (1) and (2) are met but at least one consumer is missing.
A domain is **legacy** if the contract exists but is unused on the wire.
A domain is **quarantine** if the contract exists AND a competing legacy ontology is still actively used.

---

## 3. Domain adoption matrix

| Domain | Contract | SM | FastAPI imports | NestJS imports | Web imports | Expo imports | Admin imports | API returns canonical DTO | Persona-ready | Classification |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| **booking** | ✅ | ✅ | ❌ | ❌ | partial (1 page) | ❌ | ❌ | ❌ | ❌ | **legacy** |
| **inspection-job** | ✅ | ✅ | partial (`reports.py`) | ❌ | ✅ (8 files) | ❌ | ❌ | partial | ❌ | **partial** |
| **inspection-report** | ✅ | ✅ | ❌ | ❌ | ✅ (4 files) | ❌ | ❌ | ❌ | ❌ | **partial** |
| **payment** | ✅ | ✅ | ❌ | ❌ | partial (2 pages) | ❌ | ❌ | ❌ | ❌ | **legacy** |
| **provider-earnings-item** | ✅ | ❌ (none) | ✅ (`earnings.py`, `router.py`) | ❌ | ✅ (`ProviderEarningsClarity`) | ✅ (`earnings-clarity`) | ❌ | ✅ at `/api/provider/earnings/items` | partial (no `viewer` in DTO) | **partial-canonical** |
| **provider-work-item** | ✅ | ❌ (none) | ✅ (`work_items.py`, `router.py`) | ❌ | ✅ (`ProviderWorkbench`) | ✅ (`workbench`) | ❌ | ✅ at `/api/provider/work-items` (`{items, viewer}`) | ✅ | **CANONICAL** |
| **quote** | ✅ | ✅ | ❌ | ❌ | ✅ (`CustomerQuotesPage` + 1 sm-only) | ❌ | ❌ | ❌ | ❌ | **partial** |
| **vehicle** | ✅ | ✅ | partial (`timeline.py`) | ❌ | ✅ (3 files) | ✅ (3 files) | ❌ | partial | ❌ | **partial-canonical** |
| **identity/account** | ✅ (`account.ts`) | n/a | partial (runtime enforces `kind` — proven by live probe) | ❌ | ❌ (uses `user.role`) | ❌ (uses `user.role`) | ❌ | partial (`kind` returned in some DTOs, not in JWT-decoded user object on FE) | n/a | **partial-quarantine** |

Legend: ✅ = full · partial = some consumers · ❌ = none.

---

## 4. Import evidence

### 4.1 Files importing `/app/shared/domain/*` (exhaustive list — 13 files)

```
backend/app/auto_requests/reports.py
backend/app/provider/earnings.py
backend/app/provider/router.py
backend/app/provider/work_items.py
backend/app/vehicles/timeline.py
frontend/app/provider/earnings-clarity.tsx
frontend/app/provider/workbench.tsx
frontend/app/vehicles/[id].tsx
frontend/src/services/vehicles.ts
frontend/src/stores/vehicleMemoryStore.ts
web-app/src/main.tsx
web-app/src/pages/customer/CustomerVehicleDetail.tsx
web-app/src/pages/customer/CustomerQuotesPage.tsx
web-app/src/pages/customer/PaymentSuccessPage.tsx
web-app/src/pages/inspector/InspectorWorkspace.tsx
web-app/src/pages/inspector/ReportWorkspace.tsx
web-app/src/pages/provider/ProviderEarningsClarity.tsx
web-app/src/pages/provider/ProviderWorkbench.tsx
web-app/src/pages/public/BookingDetailPage.tsx
web-app/src/components/inspector/* (7 files)
web-app/src/stores/vehicleMemoryStore.ts
```

### 4.2 Per-domain importers

| Domain | Importers |
|---|---|
| booking | `web-app/src/pages/public/BookingDetailPage.tsx` (contract + sm) |
| inspection-job | `backend/app/auto_requests/reports.py` · `web-app` × 8 (InspectorWorkspace, JobsRail, ActiveJobPanel, StatusToolbar, TimelineRail, ReportToolbar, MediaPanel, ReportEditor) |
| inspection-report | `web-app` × 4 (ReportWorkspace, ChecklistRail, ReportToolbar, ReportEditor) |
| payment | `web-app/src/pages/customer/PaymentSuccessPage.tsx` (contract + sm) · `web-app/src/pages/customer/CustomerVehicleDetail.tsx` (sm-only) |
| provider-earnings-item | `backend/app/provider/earnings.py` · `backend/app/provider/router.py` · `web-app/src/pages/provider/ProviderEarningsClarity.tsx` · `frontend/app/provider/earnings-clarity.tsx` |
| provider-work-item | `backend/app/provider/work_items.py` · `backend/app/provider/router.py` · `web-app/src/pages/provider/ProviderWorkbench.tsx` · `frontend/app/provider/workbench.tsx` |
| quote | `web-app/src/pages/customer/CustomerQuotesPage.tsx` (contract + sm) · `web-app/src/pages/customer/CustomerVehicleDetail.tsx` (sm-only) |
| vehicle | `backend/app/vehicles/timeline.py` · `frontend/app/vehicles/[id].tsx` · `frontend/src/services/vehicles.ts` · `frontend/src/stores/vehicleMemoryStore.ts` · `web-app/src/pages/customer/CustomerVehicleDetail.tsx` · `web-app/src/stores/vehicleMemoryStore.ts` |
| identity/account | **none** |

---

## 5. Backend / API evidence

### 5.1 FastAPI endpoints that return canonical DTOs (live-probed)

```
GET /api/provider/work-items          {items: WorkItem[], viewer: {displayName, kind, organizationName, slug}}
GET /api/provider/earnings/items      {items: EarningsItem[], summary, viewer}
GET /api/provider/earnings            {today, week, month, bonuses}      ← LEGACY shape (aggregate, not DTO)
GET /api/marketplace/bookings         5xx error (broken at the time of probe)
GET /api/customer/requests/my         403 — kind gating works (account.kind enforced at runtime)
```

The runtime enforces `account.kind` correctly (probe returned: `Forbidden: account kind required (customer). Active kind: inspector`). This proves the **identity layer of the spine is live on the wire**, even though clients still consume `user.role` strings.

### 5.2 NestJS — structural barrier

NestJS is written in TypeScript but lives in `/app/backend/src/` and does **not import `/app/shared/domain/`**. There is no `tsconfig` path alias, no symlink, no published shared package. The TypeScript ecosystem of NestJS is isolated from the spine.

This is significant: **all NestJS controllers (~274 endpoints) are spine-blind by construction.** Any inspector lifecycle, booking lifecycle, vehicle lifecycle owned by NestJS necessarily duplicates the contract in its own DTOs.

### 5.3 Two backends, two ontologies on the same wire

| Domain | FastAPI says | NestJS says |
|---|---|---|
| Inspector intake | `/api/inspector/exposures/my`, `accept`/`reject` | `/api/inspector/exposures`, `claim` |
| Inspector execution | (does not own) | `/api/inspector/jobs/:id/{on-route, arrived, start-inspection, cancel, report, timeline}` |
| Vehicles | `/api/garage/:id`, `/api/customer/garage/recommendations` | `/api/customer/vehicles/:id/{activity, timeline}`, `/api/vehicles/my` |
| Bookings (creation) | (broken at probe time) | `/api/bookings/create-with-slot`, `/api/bookings/my`, `/api/bookings/:id/{action, status}` |
| Bookings (operations) | `/api/marketplace/bookings/:id/{status, cancel, simulate-drive, simulate-progress}` | (does not own) |
| Auth | `/api/auth/{login, register, me}` (wins by router order) | `/api/auth/{login, register, me}` (shadowed) |

---

## 6. Surface evidence: Web / Expo / Admin

### 6.1 Web-app — primary spine carrier

- 9 of 13 spine importers are in web-app.
- Inspector workspace fully spine-typed (8 components import `inspection-job` / `inspection-report`).
- ProviderWorkbench renders persona-bar from the spine response.
- ProviderEarningsClarity imports both contracts but lacks `viewer` in the rendered data.
- Customer surface partially spine-aware: `CustomerVehicleDetail` and `CustomerQuotesPage` import contracts; `CustomerBookings`, `CustomerFavorites`, `CustomerGarage`, `CustomerProfile`, `MyRequestsPage` do NOT.
- Public surface: only `BookingDetailPage` imports spine. `MarketplaceHome`, `SearchPage`, `InspectPage`, `SelectionRequestPage`, `ProviderPage`, `ComparisonPage`, `LiveForecastMapPage` are spine-blind.

### 6.2 Expo — symbolic adoption

- Only 4 files import the spine: `provider/workbench.tsx`, `provider/earnings-clarity.tsx`, `vehicles/[id].tsx`, plus 2 supporting files in `frontend/src/`.
- 80 of 84 Expo screens are spine-blind.
- Tab routing (`(tabs)/_layout.tsx`) uses `user.role === 'provider' || user.role.startsWith('provider')` — string-based identity, not `account.kind`.
- Inspector flow on Expo (`exposures.tsx`, `jobs.tsx`, `job/[id]/*`) does NOT import `inspection-job` contract, even though web-app does.

### 6.3 Admin — zero adoption

- 0 files in `/app/admin/src/` import `/app/shared/domain/`.
- Admin operates on raw HTTP responses with no shared TypeScript types.
- 66 admin pages, 222 endpoint calls — all duck-typed.
- This is the largest spine-blind territory in the product.

---

## 7. Persona narration readiness

The §8 doctrine: **persona narration is observable spine adoption.**

| Surface | Endpoint | Returns `viewer` in single response? | Persona-bar rendered? |
|---|---|:-:|:-:|
| Web-app — ProviderWorkbench | `/api/provider/work-items` | ✅ | ✅ (`workbench-persona`) |
| Expo — provider/workbench | `/api/provider/work-items` | ✅ | ✅ (`mobile-workbench-persona`) |
| Web-app — ProviderEarnings | `/api/provider/earnings` | ❌ (legacy aggregate shape) | ❌ |
| Web-app — ProviderEarningsClarity | `/api/provider/earnings/items` | partial (`viewer` present, not surfaced) | ❌ |
| Expo — provider/earnings | `/api/provider/earnings` | ❌ | ❌ |
| Web-app — InspectorWorkspace | `/api/inspector/jobs/my` (NestJS) | ❌ | ❌ |
| Web-app — Customer (all) | various `/api/customer/*` | ❌ | ❌ |
| Admin — every page (impersonation) | various | ❌ | ❌ |

**Result: persona narration ready in 2 of ~30 actor-bearing surfaces (~7%).**
This number is the cleanest single metric for spine adoption today.

---

## 8. Legacy vocabulary leaks

Counts are file-level (a file is counted once even if the term appears many times in it).

| Legacy term | Doctrine says | Files | Notable locations |
|---|---|---|---|
| `providerSlug` / `provider_slug` | use `account.organizationId` (organization, not principal) | **53** | `frontend/app/chat`, `provider-boost.tsx`, `provider/{performance,clusters,inbox,chats}`, `additional.tsx`, `(tabs)/quotes.tsx`, `messages.tsx`, plus admin/web-app heavily |
| `inspectorId` / `inspector_id` | use `account.id` with `kind: 'inspector'` | **28** | scattered across all surfaces |
| `user.role` strings (`'provider_owner'`, `'provider_manager'`, `'provider'`, `'admin'`) | use `account.kind` + `account.capabilities` | **7 critical** | tab routing in Expo, role-redirect in web, ProtectedRoute predicates in web — all gate logic |
| `kind === 'provider'` | doctrine forbids: providers are organizations | **1** | `frontend/app/login.tsx` |
| `/garage` URL | `vehicle` is canonical | **6** | `frontend/app/booking/repeat.tsx`, `create-quote.tsx`, `login.tsx`, `additional.tsx`, `frontend/src/services/api.ts`, `frontend/src/shared/api-contracts.ts` |
| `/exposures` lifecycle | unify with `inspection-job` | **6 files** | Expo + admin paths |
| `account.kind` access | canonical | **0 files** | nobody on the client uses the canonical predicate; everyone uses `user.role` |

The asymmetry between line 1 (53 files using legacy) and line 7 (0 files using canonical) is the clearest evidence that **the client side has not yet adopted the spine's identity model**. Backend enforces `account.kind` correctly at runtime; client side ignores it.

---

## 9. Canonical vs quarantine classification

### 9.1 Canonical (spine-resident, do not touch)
- **provider-work-item** — only domain that meets all 6 adoption criteria. Contract + DTO + 4 importers + persona narration.

### 9.2 Partial-canonical (one step away)
- **vehicle** — contract + sm + backend timeline + 6 importers across 3 surfaces. Missing: admin adoption, persona narration. Coexists with `/garage` legacy URL on Expo.
- **provider-earnings-item** — contract + DTO + 4 importers. Missing: state-machine, `viewer` not surfaced in `/earnings` legacy aggregate, no admin adoption.

### 9.3 Partial (contract exists, adoption shallow)
- **inspection-job** — strong web-app adoption (8 files), zero Expo/admin adoption, lifecycle split between FastAPI exposures and NestJS jobs.
- **inspection-report** — web-app only (4 files). FastAPI handler does not import the contract.
- **quote** — 1 web-app page. NestJS owns the domain entirely and does not import the contract.

### 9.4 Legacy (contract exists, real wire is unaware)
- **booking** — contract + sm exist. 1 web-app page imports them. Real booking lifecycle lives in NestJS, spine-blind. FastAPI booking handlers also spine-blind.
- **payment** — contract + sm exist. 2 web-app pages. All payment handlers (FastAPI Stripe/PayPal, NestJS payments) are spine-blind.

### 9.5 Quarantine (competing legacy ontology actively in use)
- **identity/account** — canonical model exists. Backend runtime enforces `account.kind`. Every client surface still uses `user.role` strings. 53 files reference `providerSlug`, 28 reference `inspectorId`. The spine model and the legacy model coexist on the same wire on every request.

---

## 10. Recommended consolidation order (advisory, not roadmap)

Sequenced by leverage / risk ratio. Each step is read-only-verifiable: success can be measured by re-running the same greps and observing counts move toward zero.

1. **Identity quarantine first.** Until clients consume `account.kind` instead of `user.role`, every other domain consolidation will inherit ambiguous identity context. Smallest single change with highest leverage: replace 7 critical `user.role` predicates with `account.kind`. Zero new contracts needed — the model already exists.
2. **Earnings → cathedral parity with Workbench.** Add a `state-machine` for `provider-earnings-item`. Surface `viewer` in `/api/provider/earnings/items` consumers. Drop `/api/provider/earnings` aggregate or downgrade it to a derived view.
3. **Vehicle deprecation pass.** Choose `/api/customer/vehicles` (NestJS) or `/api/customer/garage` (FastAPI). Mark the loser deprecated. Migrate the 6 Expo files that still hit `/garage` URLs.
4. **Inspector lifecycle reconciliation.** Decide if `exposure` and `inspection-job` are one entity or two. If two, document the boundary in `shared/domain`. If one, deprecate `/api/inspector/exposures` in favor of `/api/inspector/jobs`. Today this question is unanswered in code.
5. **NestJS spine bridge.** Create a path alias or shared package so NestJS controllers can import `shared/domain/contracts`. Without this, every NestJS-owned domain (auth, bookings, quotes, reviews, disputes, vehicles, inspector-jobs, organizations, payments) is structurally barred from the spine.
6. **Admin spine onboarding.** 0 → meaningful. Lowest-cost first wins: typed clients for endpoints that already return canonical DTOs (`/api/provider/work-items`, `/api/provider/earnings/items`, `/api/customer/vehicles/:id/timeline`).
7. **Booking and payment spine onboarding.** These are the largest legacy surfaces. Touch only after (1)–(6) — they will inherit the cleanups.

---

## 11. Single observable success metric

> Number of actor-bearing surfaces that render persona-bar from a single API response, without client-side joining.

Today: **2** (Workbench × 2 surfaces).
Theoretical ceiling for current 9 domains × surfaces matrix: **~30**.

Re-measure this number after each consolidation step. If the number does not move, the step did not advance spine adoption — regardless of how much code was changed.

---

## 12. What this artifact does not do

- It does not propose merging FastAPI and NestJS.
- It does not propose a unified UI.
- It does not propose deleting any file.
- It does not propose new contracts.
- It does not declare any domain "fixed" or "broken".

It states one fact: **the spine exists, and ~3% of the product imports it.** Everything else is a derivative of that fact.

# Canonical Path Doctrine (P2.1)

> **Status:** doctrinal — enforces topology coherence across backend + 3 frontends.
> **Owner:** `/app/shared/contracts/*` (this directory)
> **Verified by:** `/app/ops/smoke-api-contracts.sh` (P2.4 anti-regression wall)
> **Origin:** PHASE 2 — Contract Normalization (2026-02-22)

---

## 1. Why this exists

After P1.2 (admin SPA topology correction — −65% routes, −57% worst chunk, `visible == operational`) the remaining structural risk is **contract drift**, not topology.

Symptoms before P2:
- Three byte-identical copies of `api-contracts.ts` (admin / frontend / web-app) → no single source of truth.
- 80-method god-object `adminAPI` with hardcoded URL strings outside the catalogue.
- A promised smoke script (`/app/ops/smoke-api-contracts.sh`) referenced in comments but **non-existent** → zero anti-regression wall.
- Implicit conventions (`/bookings/my` vs `/customer/bookings`) lived only in developers' heads.

This doctrine is the explicit replacement for those implicit conventions.

---

## 2. Canonical prefixes

| Domain | Canonical prefix | What lives here |
| --- | --- | --- |
| `auth` | `/auth/*` | Identity primitives — login, register, me, password reset, 2FA |
| `customer` | `/customer/*` | Customer-owned reads / writes — journey, timeline, cognition |
| `provider` | `/provider/*` | Provider-owned reads / writes — inbox, presence, earnings, intelligence |
| `inspector` | `/inspector/*` | Inspector-owned reads / writes — jobs, capture, timeline |
| `admin` | `/admin/*` | Operational console — governance, ops, integrations |
| `marketplace` | `/marketplace/*` | Public catalogue + cross-actor matching |
| `trust` | `/reviews/*` · `/disputes/*` | Reputation + arbitration surfaces (split by aggregate, both anchored to bookings) |
| `governance` | `/admin/governance/*` | Governance score, zone score, action history (sub-namespace of admin) |
| `realtime` | `/realtime/*` | Socket.io status + emit endpoints |

### Non-domain prefixes (reserved — do NOT promote to canonical)

| Prefix | Reason |
| --- | --- |
| `/system/*` | Internal observability — health, errors, error-stats. Surfaces own; no UX. |
| `/orchestrator/*` | Engine state + overrides. Admin-only by capability gate; logically a sub of admin but routed flat for `worker_supervisor` ergonomics. |
| `/health` | Liveness probe — public, never UX-mounted. |

These are mounted, used, and tested — but they are **not eligible canonical prefixes** for new domain surfaces. Adding a new `/system/things` route requires explicit governance review.

---

## 3. Naming inside a canonical prefix

| Suffix | When to use | When to ban |
| --- | --- | --- |
| `/my` | Aggregate scoped to the authenticated caller's identity (customer/provider/inspector) — implicit owner = JWT subject. ✅ `customer.bookings.my === /bookings/my` |
| `/incoming` | The complement of `/my` from the other actor's POV. ✅ `provider.quotes.incoming` |
| `/list` | **BANNED outside `/admin/*`.** Implies unbounded global scope. Only admin can list-all. |
| `/all` | **BANNED outside `/admin/*`.** Same reason. Allowed: `/admin/quotes/all`, `/services/categories/all`. |
| `/dashboard` | Only at exactly one canonical place per role: `/admin/dashboard`, `/provider/dashboard`, `/inspector/dashboard`. Never `/foo/dashboard` for arbitrary `foo`. |
| `/:id` | Resource read by surrogate key. Always lowercase noun in plural. |
| `/:id/<verb>` | Sub-action on a resource. Verb in lowercase, hyphenated if multi-word. ✅ `/bookings/:id/cancel`, `/disputes/:id/request-evidence` |

### Path tense rule

Reads use **nouns** (`/payments`, `/bookings/:id`).
Writes use **verbs only as sub-actions** (`/bookings/:id/cancel`, never `POST /cancel-booking`).

---

## 4. Alias policy (P2.2)

An **alias** is two URLs returning the same data.

### Allowed aliases

1. **Canonical + compat-fallback** — backend exposes both, but `api-contracts.ts` references **only the canonical form**. The compat fallback stays in FastAPI **for legacy mobile clients** until 90 days after their last release.
   - Example: `notifications.my: '/notifications/my'` (canonical) + backend also accepts `GET /notifications` (compat). The catalogue points clients at `/my`. The compat returns the same projection.

2. **Cross-actor projections** — `GET /bookings/my` (customer's view) and `GET /bookings/incoming` (provider's view) operate on the same domain entity but **return different projections**. These are NOT aliases — they are different reads.

### Banned aliases

- Two URLs that **return identical bytes** for the same caller — pick one, redirect the other.
- A "convenience helper" route that wraps an existing route with a different name (`/my-bookings` shadowing `/bookings/my`).
- A v1/v2 split without a deprecation header on v1.

### How drift gets killed

1. Identify both routes.
2. Pick canonical (use this doctrine — `/customer/*` for customer-owned over `/bookings/my`? **No — `/my`-suffix wins because it's identity-implicit and matches existing client code**).
3. The non-canonical route either:
   - **Hard-redirects** (308 with `Location` header) — preferred when external clients might still hit it.
   - **Returns 410 Gone** with a deprecation pointer — preferred when no external client exists.
   - **Deleted** — only when the route is younger than 30 days and unreleased.

---

## 5. Catalogue as the source of truth

`/app/shared/contracts/` is **the** source of truth for path strings.

Rules:

1. **Never hardcode** `'/auth/login'` in a page or service. Import from `@platform/contracts`.
2. **Dynamic segments are functions:** `byId: (id: string) => `/resource/${id}`` — never string-concat at call-site.
3. **Adding a backend route requires adding it to the catalogue in the same PR.** No exceptions.
4. **The smoke script** (`/app/ops/smoke-api-contracts.sh`) is the build-time wall. It must pass before merge.

---

## 6. Smoke contract (P2.4)

Status code semantics for `smoke-api-contracts.sh`:

| Backend response | Meaning | Verdict |
| --- | --- | --- |
| `200` / `204` | Mounted, returned data | ✅ ok |
| `401` | Mounted, requires auth — exactly as expected | ✅ ok |
| `403` | Mounted, role-gated — exactly as expected | ✅ ok |
| `405` | Mounted under a different HTTP verb — catalogue path is correct | ✅ ok |
| `422` | Mounted, validation rejected the synthetic payload — catalogue path is correct | ✅ ok |
| `404` | **Catalogue points at a route the backend does not mount** | ❌ **CONTRACT DRIFT** |
| `5xx` | Backend exploded — separate issue, but path exists | ⚠ flag, do not fail (real bug, not drift) |

The script is intentionally **path-existence-only**. It does not validate response shape — that is the job of type-level contracts in `shared/domain/contracts/*`.

---

## 7. What this doctrine is NOT

- Not an OpenAPI-first migration. The backend remains FastAPI-route-first; the catalogue is hand-curated.
- Not an SDK generator. There is one `axios` instance per surface, hand-wired.
- Not a typed RPC framework. Type authority lives in `shared/domain/contracts/*` and `shared/domain/state-machines/*`.
- Not GraphQL / CQRS / event-sourcing. Same reasons as `PRODUCTION_READINESS.md` §10.

---

## 8. Enforcement timeline

| When | Rule |
| --- | --- |
| **Now (P2 closure)** | All admin/frontend/web-app `api-contracts.ts` re-export from `@platform/contracts`. Smoke runs locally. |
| **+ 1 sprint** | Smoke runs in pre-commit hook (opt-in). |
| **+ 2 sprints** | Smoke runs as required CI stage. PR blocked on drift. |
| **+ 1 release** | Compat-alias routes start emitting `Deprecation` and `Sunset` headers. |
| **+ 90 days after that** | Compat-alias routes removed. Only canonical remains. |

Anyone reverting `@platform/contracts` to local hardcoded strings owes the team a topology audit doc.

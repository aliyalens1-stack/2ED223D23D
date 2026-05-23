# Phase 3A · Identity / Account Topology Mapping

**Date:** 2026-02-17 · **Scope:** mapping + inventory only · **Status:** draft for review

> No extraction. No refactor. No behaviour change. This document
> describes the identity surface AS IT IS so that 3B/3C/3D can
> plan against a stable picture.

---

## 0. Executive snapshot

| Property | Value |
|----------|-------|
| Authoritative identity service | `app.core.identity_runtime` |
| JWT algo | `HS256`, secret = `JWT_SECRET` env (default `auto_service_jwt_secret_key_2025_very_secure`) |
| JWT TTL | 7 days (login + register + switch-account) · 5 min (2FA challenge) |
| Auth surfaces | 6 endpoints under `/api/auth/*` + 1 under `/api/auth/2fa/*` cluster |
| Gates in use | 4 official + 2 legacy adapters + 8 ad-hoc / per-router |
| Account kinds (formal) | 6 — see §2 |
| Capability verbs (formal) | 6 — see §2 |
| Trust collections | `users`, `accounts`, `account_capabilities`, `password_reset_tokens`, `two_factor_*`, `account_switch_audit` (implicit via `auth/me`) |
| Mode | DUAL-READ (real `accounts` table + legacy `users.role` shim) |

---

## 1. Endpoint surface · `/api/auth/*`

| Method · Path | Service | Issues JWT? | Returns shape |
|---|---|---|---|
| POST `/api/auth/login` | `app.system.auth.auth_login` | yes (or 2FA challenge token) | `{ accessToken, user, accounts[], activeAccount, mustEnroll2FA }` |
| POST `/api/auth/register` | `app.system.auth.auth_register` | yes | same + `referralApplied` |
| GET `/api/auth/me` | `app.system.auth.auth_me` | no | `{ user, accounts[], activeAccount, id, email, firstName, lastName, role }` ① |
| PATCH `/api/auth/me` | `app.system.auth.auth_me_patch` | no | same envelope as `/me` |
| POST `/api/auth/switch-account` | `app.system.auth.auth_switch_account` | **yes (new JWT)** | `{ accessToken, activeAccount, accounts[] }` |
| POST `/api/auth/forgot-password` | `app.system.auth.compat_forgot_password` | no | `{ ok, message }` |
| POST `/api/auth/reset-password` | `app.system.auth.compat_reset_password` | no | `{ ok, message }` |
| POST `/api/auth/2fa/setup` etc. (cluster) | `app.two_factor.router` | conditionally | TOTP flow |

① — `/me` ships **both** the new envelope AND legacy top-level fields. Marked
   `TODO: remove_after_shared_identity_0B`. Drift trap: client tests may rely
   on either shape.

---

## 2. Vocabularies (single source of truth)

Both live in `app/core/capability.py`:

```python
KNOWN_CAPABILITIES = ("inspect", "repair", "wash", "tow", "transport", "sell")
ACCOUNT_KINDS = ("customer", "admin", "inspector", "service_provider",
                 "dealer", "transport_provider")
SYNTHETIC_PRINCIPALS = ("customer", "admin")   # not professional accounts
```

Distinction is enforced by the architecture, not just by docstring:

| Layer | Vocabulary | Lives in | Gate symbol |
|-------|-----------|----------|-------------|
| **Identity class** (who you ARE) | `ACCOUNT_KINDS` | `accounts.kind` | `require_account_kind`, `require_admin` |
| **Professional capability** (what you can DO) | `KNOWN_CAPABILITIES` | `account_capabilities.capability` | `require_capability_v2` (alias `require_capability`) |
| **Legacy role** (compat shim) | `users.role` | `users.role` | ad-hoc string compares — drift surface, see §6 |

`admin` and `customer` are kinds, NOT capabilities. The capability table
intentionally never grows an `admin` row. This is enforced today by
`require_account_kind` doing `accepted - set(ACCOUNT_KINDS)` boot-time validation.

---

## 3. Trust boundaries (the actual map)

```
              ┌────────────────────────────────────────────┐
              │   PERSON  (users._id)                      │
              │   ├─ email, passwordHash, totp, isActive   │
              │   └─ legacy.role (single-string shim)      │
              └─────────────┬──────────────────────────────┘
                            │  1:N
              ┌─────────────▼──────────────────────────────┐
              │   ACCOUNT  (accounts._id)                   │
              │   ├─ userId, kind, displayName, avatar      │
              │   ├─ publicSlug, organizationId, isPrimary  │
              │   └─ stats, legacyRole                      │
              └─────────────┬──────────────────────────────┘
                            │  1:N
              ┌─────────────▼──────────────────────────────┐
              │   CAPABILITY (account_capabilities)         │
              │   accountId × capability × status           │
              │   (verified / pending)                      │
              └────────────────────────────────────────────┘
```

JWT binds **one** `(userId, accountId)` pair. Switching accounts re-mints
the token; multi-device sessions stay independent (no server-side session).

---

## 4. Gates · who guards what

### 4.1 Official gates — `app.core.identity_runtime`

| Gate | Usages | Returns | Behaviour |
|------|--------|---------|-----------|
| `decode_and_resolve` | 28 | `IdentityContext` | decode JWT + resolve active account + caps |
| `require_capability_v2(*verbs)` | 17 | `IdentityContext` | 403 unless caps ∩ verbs |
| `require_account_kind(*kinds)` | 45 | `IdentityContext` | 403 unless kind ∈ kinds, boot-time validation of unknown kinds |
| `require_admin()` | 23 | `IdentityContext` | sugar over `require_account_kind("admin")`; reserved future hook for 2FA / IP allow-list / per-call audit |

### 4.2 Legacy adapters — `app.core.security`

| Gate | Usages | Returns | Reason it survives |
|------|--------|---------|---------------------|
| `verify_admin_token` | **188** | legacy `{sub, userId, email, role, accountId, kind, caps}` dict | back-compat for ~30 callsites that read `payload.get("email")`; delegates to `require_admin()` + adds inline 2FA enrollment check |
| `verify_user_token` | 39 | raw JWT payload dict | shared dep for chat/notifications/messages flows; does NOT resolve account |
| `app.core.capability.require_capability` | 20 | `IdentityContext` | thin adapter → `require_capability_v2` |

### 4.3 Per-feature optional auth — `app.auto_requests.auth`

| Helper | Returns | Purpose |
|--------|---------|---------|
| `get_user_id_optional(request)` | `str | None` | quietly extract user_id; non-throwing |
| `get_user_kind_optional(request)` | `str | None` | extract `account.kind` claim from JWT (without DB lookup) |
| `get_user_id_required(request)` | `str` | same but 401 on miss |

Surface coverage: 19 callsites; mainly `auto_requests/*` routers for public+gated marketplace endpoints (e.g. browse anonymously, claim requires auth).

### 4.4 Ad-hoc role checks (drift surface)

| File | Compared against | Lines | Notes |
|------|------------------|-------|-------|
| `app/offer_packages/repository.py:468` | `actor_role == "provider"` | 1 | ownership rule; could be `ctx.account.kind == "inspector"` but the verb-vs-kind name still aligns to legacy `role` |
| `app/car_selection_thread/repository.py:99,101,105,257,261,265,304,306` | `"admin"`, `"customer"`, `"provider"` | 8 | repository receives `actor_role` arg from routers; uniform pattern |
| `app/chat/router.py:194,254` | `role == "provider"` | 2 | uses `payload["role"]` from `verify_user_token` |

Total ad-hoc string-role compares: **12 occurrences across 3 files**. None
escape into other modules — these are localised behaviour switches inside
repositories that receive `actor_role` as an argument from a router that
already used a proper gate. Risk grade: **low**, but worth a sweep when
`legacy_role` is sunset.

---

## 5. Sentinels & special accounts

### 5.1 Admin seed sentinel

- Created by `app/core/seed.py:31-42` on every boot (idempotent).
- Email: `ADMIN_EMAIL` env (default `admin@autoservice.com`)
- Password: `ADMIN_PASSWORD` env (default `Admin123!`) — re-hashed on every
  boot, so changing the env effectively rotates the seed admin password.
- `users.role = "admin"` → `accounts.kind = "admin"` via
  `_LEGACY_ROLE_TO_ACCOUNT_KIND`.

### 5.2 Synthetic principals

`SYNTHETIC_PRINCIPALS = ("customer", "admin")` — they are listed in
`ACCOUNT_KINDS` for gate purposes, but the `account_capabilities` table
never carries rows for them (verified by `_LEGACY_ROLE_TO_CAPS["customer"]
= ()` and `["admin"] = ()`).

### 5.3 Test bypass

`TEST_BYPASS_TOKEN` env var exists in `config.py:57` — currently unused in
auth code (only `TESTING` flag is consumed for seed behaviour). **No live
bypass surface.** Worth confirming during 3D extraction.

---

## 6. Visibility matrix (existence privacy in action)

Existence privacy is a **distinct trust layer** from authorization. Even
when authorized, a caller may not learn that a foreign resource exists.

| Surface | Foreign resource → response | Owner-only resource → response |
|---------|-----------------------------|--------------------------------|
| Provider sees another provider's car-selection request | **404** | own request → 200 |
| Customer sees a draft offer-package (any provider) | **404** | delivered package → 200 |
| Provider sees a customer's car-selection request (unassigned) | **404** | assigned to me → 200 |
| Admin sees anything | 200 (governance scope) | n/a |
| Anonymous user reads marketplace listing | 200 (public projection) | n/a |
| Cross-request artifact download | **404** | same request → 200 |
| Chat thread message | scoped by `participantId` | own message visible |

Documented in:
- `app/offer_packages/router_provider.py:20`
- `app/offer_packages/router_customer.py:14`
- `app/car_selection_thread/router_provider.py:13`
- `app/car_selection/router_provider.py:214`
- `app/car_selection_thread/artifacts.py:25`

Pattern: **existence privacy is enforced inside routers via 404, not via
gate denial (403).** Gates handle authentication; 404 handles authorization
+ information leakage prevention.

---

## 7. JWT topology

### 7.1 Issuance points

| Source | File · Symbol | Claims |
|--------|---------------|--------|
| Primary login / register / switch | `identity_runtime.issue_account_jwt` | `sub, email, role, caps[], accountId, kind, iat, exp` |
| 2FA challenge token | `two_factor.service.generate_challenge_token` | short-lived (300s), separate purpose |

### 7.2 Decoding points

`jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])` appears in **17
files** — risk surface for future secret rotation:

```
app/performance/__init__.py        app/marketplace/requests.py
app/referrals.py                   app/system/support_tickets.py
app/auto_requests/auth.py          app/system/auth.py
app/provider/onboarding.py         app/two_factor/router.py
app/provider/router.py             app/core/bootstrap.py
app/billing/router.py              app/core/security.py
app/chat/realtime.py               app/core/identity_runtime.py
app/chat/canonical.py              app/core/capability.py
server.py
```

Of these, **only 2 SHOULD be there:**
- `identity_runtime.decode_and_resolve` (canonical)
- `two_factor.router` (challenge-token decoder, separate purpose)

The other 15 are independent decoders predating Sprint 1C. They all use
the same secret + algo, but each is a place where rotation, claim
validation, or a future JWKS migration must be touched. Listed in §10.

### 7.3 Token lifetimes

| Token | TTL | Refresh? | Server-side state? |
|-------|-----|----------|--------------------|
| Access JWT | 7 days | none (re-login) | stateless |
| 2FA challenge | 5 min | none (one-shot) | `users.totp.pendingChallenge` (Mongo) |
| Password reset | 1 hour | none (one-shot) | `password_reset_tokens` collection |
| 2FA TOTP secret | infinite (until disable) | recovery codes | `users.totp` (encrypted) |

---

## 8. WebSocket / realtime auth

`app/chat/realtime.py` — `app.websocket("/ws/chat")`:
- Reads `?token=` query param.
- Decodes with same `JWT_SECRET / JWT_ALGO` (lazy import from `security.py`).
- Closes connection on bad token.

This is the **only** non-HTTP auth surface today. No subscription-time
capability check — connection is bound to the JWT's `sub`/`role` and
authorization happens per-message at the chat-router layer.

---

## 9. Cross-domain ownership map

Who can mutate what — the domain ownership grid:

| Domain | Customer | Provider/Inspector | Admin | Anonymous |
|--------|----------|---------------------|-------|-----------|
| `users` (own profile) | RW (`/auth/me` patch) | RW | R + isActive flip | — |
| `accounts` | R(own) | R(own) + displayName via /me | R(any) | — |
| `account_capabilities` | — | R(own) | RW (verification) | — |
| `car_selection_requests` | RW(own) | R(assigned) | RW(any, governance) | — |
| `car_selection_offer_packages` | R(delivered to me) + accept/decline | RW(draft, own) + deliver + revise | R(any) + revoke | — |
| `car_selection_thread_messages` | RW(in request) | RW(in assigned request) | R(governance) | — |
| `artifacts` (immutable evidence) | upload(in own thread) | upload(in assigned thread) | R | — |
| `inspection_*` | R(own) | RW(assigned) | RW | — |
| `provider_listings` | R | RW(own) | RW | R (public) |
| `cities` / `services` | R | R | RW | R |
| `notifications` | R(own inbox) | R(own inbox) | R(governance + own) | — |
| `audit_logs` | — | — | R | — |
| `referrals` | RW(own code) | RW(own code) | R | — |
| `2fa_setup` | — | — | RW(self) | — |
| `payments` (Stripe) | RW(own) | R(payouts only) | RW | — |

**Cross-domain quirks worth flagging:**
1. Customer accepting a v1 offer-package after v2 is delivered is **legal**
   (forensic semantics, decision 7.7). Mutates `accept` despite a newer
   version existing.
2. Admin `revoke` on a v2 offer-package does NOT clear v1's `supersededById`
   pointer (decision 7.7).
3. `/auth/me` returns BOTH new envelope AND legacy top-level fields — any
   future surface change must update both shapes simultaneously.
4. `/api/auth/2fa/setup/*` endpoints DO NOT depend on `verify_admin_token`,
   intentionally — admins must be able to enroll before the gate locks
   them out.

---

## 10. Drift inventory (the actual extraction debt)

### 10.1 Independent JWT decoders (15 sites)

Each one is a TODO when JWT rotation lands. They predate Sprint 1C and
each implements `jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])`
inline:

| Module | Reason it has its own decoder | Could replace with |
|--------|-------------------------------|--------------------|
| `app/performance/__init__.py` | telemetry → caller identity | `decode_and_resolve` |
| `app/referrals.py` | reads `sub` for code attribution | `decode_and_resolve` |
| `app/auto_requests/auth.py` | optional auth helpers | keep (optional path) — but factor secret access |
| `app/provider/onboarding.py` | onboarding payload | `decode_and_resolve` + `require_account_kind` |
| `app/provider/router.py` | provider-only routes | `require_account_kind("inspector", "service_provider", "dealer", "transport_provider")` |
| `app/billing/router.py` | Stripe webhook customer attribution | likely keep (webhook-special) |
| `app/chat/realtime.py` | WebSocket query-token auth | keep (WS-special) |
| `app/chat/canonical.py` | thread canonicalisation | `decode_and_resolve` |
| `app/marketplace/requests.py` | marketplace optional auth | factor via `get_user_id_optional` |
| `app/system/support_tickets.py` | support ticket attribution | `decode_and_resolve` |
| `app/system/auth.py` | `/me`, `/me PATCH`, `/switch-account` | replace with `decode_and_resolve` (they already mostly route through identity_runtime for resolution — only token decode is local) |
| `app/two_factor/router.py` | challenge token (DIFFERENT secret purpose) | keep (separate flow) |
| `app/core/bootstrap.py` | startup health checks | keep (bootstrap-only) |
| `app/core/security.py` | the canonical gate | keep |
| `app/core/identity_runtime.py` | the canonical resolver | keep |
| `app/core/capability.py` | predates 1C, no longer used here | dead-code candidate — verify |
| `server.py` | legacy compat (likely dead) | verify & remove |

**Action item for 3D:** sweep all 15 sites in one pass during extraction —
replace inline decoders with `decode_and_resolve` (or document why they
must stay independent).

### 10.2 Ad-hoc role string compares

Listed in §4.4. **12 sites across 3 files.** All inside repository / chat
modules that receive `actor_role` from a properly-gated router; risk grade
**low**. Recommendation: sunset legacy `role` claim only after these are
swept to `kind`.

### 10.3 `verify_admin_token` 188-usage hotspot

The `verify_admin_token` adapter is by far the most-used auth symbol.
It exists to preserve back-compat (~30 callsites read `payload["email"]`
for audit attribution). Two consequences:

- **Single point of failure:** any change in the dict shape ripples through
  ~188 endpoints. Recommendation: pin contract with an explicit
  `LegacyAdminPayload` TypedDict so editor / mypy catch shape drift.
- **2FA-enrollment gate lives inside this adapter,** not inside
  `require_admin()`. Means new code that uses `require_admin()` directly
  (which is what the docstring recommends) **bypasses 2FA enrollment.**
  This is the single biggest drift in the system today. Action item: move
  the 2FA enrollment check from `security.verify_admin_token` into
  `identity_runtime.require_admin()`. ETA: should be done before any new
  admin endpoint is written (Sprint 3B or sooner).

### 10.4 Mutable auth globals

In `app/core/config.py`:

```
JWT_SECRET, JWT_ALGO              ← used in 17 files
ADMIN_EMAIL, ADMIN_PASSWORD       ← used at seed time
TESTING, TEST_BYPASS_TOKEN        ← TEST_BYPASS_TOKEN unused
```

In `app/core/capability.py`:

```
KNOWN_CAPABILITIES, ACCOUNT_KINDS  ← used by both `capability.py` and `identity_runtime.py`
_LEGACY_ROLE_TO_CAPS               ← role → caps mapping
_LEGACY_ROLE_TO_ACCOUNT_KIND       ← role → kind mapping
```

All immutable tuples / module-level dicts. **No runtime mutation surface.**
Good.

### 10.5 Schema drift in `users.role`

Live distribution (current DB):
```
inspector: 2     provider_owner: 1     admin: 1     customer: 1
```

`_LEGACY_ROLE_TO_ACCOUNT_KIND` mapping handles **all 9 historical role
strings** including `provider`, `provider_manager`, `transport`,
`superadmin`. But `register` accepts only `customer | provider_owner`
(line 152), so new roles can't be introduced via API. The other strings
exist only for legacy data — clean target for 1E migration.

### 10.6 `/auth/me` dual envelope

`/me` returns both new + legacy shape. Comment says
`# TODO: remove_after_shared_identity_0B`. Action item for 3D: confirm
no client still reads top-level `user.role` or `email` from `/me`, then
trim.

### 10.7 Organizations drift (discovered during Q6 scan)

`organizations` collection has **11 rows** in production data, but
`accounts.organizationId` is populated in **0 of 3 account rows.** This
means organisations exist as a parallel data island — likely backing
some provider catalogue / listing surface — without being linked to the
identity graph at all.

Consequence for extraction:
- `AccountView.organizationId` is *always* `None` in current responses.
- Any code branching on `account.organizationId` is unreachable.
- Provider-org membership is therefore implicit (probably encoded inside
  whatever module owns the 11 rows).

Action item for 3D: locate the writer of `organizations` rows, decide
whether to (a) backfill `accounts.organizationId` and use the canonical
edge, or (b) demote `accounts.organizationId` to dead field and document
the actual membership lookup path.

---

## 11. What is healthy about this topology

This section is deliberate — not everything is debt, and the healthy parts
should NOT be re-litigated:

1. **`identity_runtime` is genuinely the single source of truth.** Sprint 1C
   closed the parallel-resolver hazard. `require_capability` is now a thin
   adapter, not a competing implementation.
2. **`AccountView` & `IdentityContext` are clean dataclasses with `to_json`.**
   Wire format is stable across surfaces.
3. **Dual-read mode is invisible to callers.** Legacy users without
   `accounts` rows get a synthesized shim; the shim and a real account
   are observably equivalent. This is what made Sprint 1C ship without
   a downtime window.
4. **Kind ≠ capability separation is enforced by code, not docs.**
   `require_account_kind` validates `accepted - set(ACCOUNT_KINDS)` at
   import time — typos surface at boot, not at request.
5. **Existence privacy is consistently 404, not 403.** Across 5+ surfaces.
6. **Admin sentinel is idempotent.** Boot re-hashes password from env;
   no manual seeding scripts. Migration-friendly.
7. **JWT is stateless.** No session table. Switch-account just re-mints.
   Multi-device works without sticky sessions.

---

## 12. What 3B/3C/3D will need to decide

| # | Open question | Suggested phase |
|---|---------------|-----------------|
| Q1 | Should `verify_admin_token` adapter be killed once all 188 callsites adopt `require_admin()`? Or kept indefinitely as the "legacy dict" surface? | 3D plan |
| Q2 | Where does the 2FA enrollment gate canonically live — `require_admin()` or a separate `require_admin_with_2fa()`? (see §10.3) | 3B — runtime ownership |
| Q3 | Should the 15 independent JWT decoders be unified into `decode_and_resolve` even when they only need `sub`? Or is `decode_and_resolve`'s DB-touch overhead an acceptable cost? | 3B |
| Q4 | Should `users.role` be dropped (after migration) or kept indefinitely as audit-history? | 3D |
| Q5 | Are `provider_manager`, `transport`, `superadmin` legacy roles still in production data, or were they abandoned? Worth a one-time DB scan. | 3A follow-up — 30 min query |
| Q6 | Where do organizations fit? `accounts.organizationId` exists but `organizations` collection is empty / un-modelled. Defer to a separate phase? | 3D scope |
| Q7 | Should `KNOWN_CAPABILITIES` and `ACCOUNT_KINDS` move to `app/core/constants.py` (already exists) or stay in `capability.py`? | 3C |

---

## 13. Output of 3A

A stable map of:

- 1 canonical identity service (`identity_runtime`)
- 1 legacy adapter that absorbs 70% of admin traffic (`verify_admin_token`)
- 6 official + 3 ad-hoc gates
- 17 JWT decoder sites (2 canonical, 15 to consolidate)
- 6 account kinds × 6 capabilities × N legacy roles (9 strings)
- 5 trust collections + 1 stateless flow (switch-account)
- 12 ad-hoc role compares in 3 files
- 1 known drift point (2FA enrollment gate)
- 7 open questions ready for 3B/3C/3D

3B will build the **runtime ownership map** on top of this — which
processes wake up, what mutable state they own, how startup ordering
interacts with identity resolution.

3C will build the **worker registry & mutable globals** inventory.

3D will sequence the actual extraction with concrete migration windows.

---

## 14. Sign-off criteria for 3A

- [x] **Q5 answered (DB scan for legacy role strings):** ZERO rows for
      `provider`, `provider_manager`, `transport`, `superadmin` in current
      data. Live distribution is `inspector (2)`, `admin (1)`,
      `provider_owner (1)`, `customer (1)`. The four extra entries in
      `_LEGACY_ROLE_TO_ACCOUNT_KIND` are defensive-only and can be
      sunset in 3D without a migration.
- [x] **Q6 partially answered (organizations drift discovered):**
      `organizations` collection HAS 11 rows, but `accounts.organizationId`
      is populated **0 times**. Organizations are a parallel data island
      not actually linked into the identity graph today. This is a new
      drift point — see §10.7 added below.
- [ ] Q2 (2FA enrollment gate location) — open
- [ ] Numbers in §1, §4, §10 verified by spot-check against `grep` output
- [ ] No code changes proposed in this document (verified)

Once Q2 is ratified, this map is frozen for the duration of Phase 3.

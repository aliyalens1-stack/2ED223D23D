# Provider Identity Topology Audit
**Sprint scope:** B.1 — read-only audit. No endpoints, no contracts,
no renderers, no migrations.
**Doctrine:** semantics ahead of infrastructure. Map perception
fractures, do NOT propose substrate yet.

**Audit target:** `provider@test.com` (live demo provider in
`test_database`). Findings traced through code + live Mongo state.

---

## 0. Tl;dr

The platform has **at least four parallel identity universes** for
one provider, plus **a parallel half-finished migration** (1C runtime)
that is "closed" in code but only partially populated in data. The
provider perceives themselves coherently on **two surfaces**
(mobile profile, mobile account-switcher) and **incoherently or invisibly
on every other surface**, including the two surfaces that matter most
for this sprint: **Workbench** and **Earnings Clarity**.

The provider never **sees** which identity they are operating as.
The system silently picks one for them, per surface, using different rules.

---

## 1. The four parallel identity universes

For the same human (`provider@test.com`, `users._id=…fdd9`):

| Universe | Where it lives | Key field | Value for our provider |
|---|---|---|---|
| **PERSON** (legacy) | `users` | `_id` + `role` | `…fdd9` / `provider_owner` |
| **ACCOUNT** (Sprint 1C) | `accounts` | `_id`, `kind`, `userId` | `…cecc` / `inspector` / `…fdd9` |
| **ORG OWNERSHIP** | `organizations` | `slug`, `ownerId` | `avtomaster-pro` ← `…fdd9` |
| **INSPECTOR ROLE** | `inspection_jobs.inspectorId` | `users._id` | `…fdd9` |
| **PROVIDER SLUG** | `bookings.providerSlug`, `auction_charges.providerSlug`, `quick_request_offers.providerSlug` | `organizations.slug` | `avtomaster-pro` |
| **CAPABILITY** | `account_capabilities` | `accountId`, `capability` | mostly empty (only 1 row in entire DB) |

The provider is simultaneously:

- a **person** with `users.role='provider_owner'`,
- an **inspector account** (`accounts.kind='inspector'`),
- the **owner of a workshop organization** (`avtomaster-pro` —
  the legacy "workshop directory" org, not the new 1B
  `organizations` collection),
- the **payment recipient** of `bookings.providerSlug='avtomaster-pro'`,
- the **assigned inspector** of `inspection_jobs.inspectorId='…fdd9'`.

These five identities are **never reconciled** in any single place.

### The naming itself is fractured

| Mongo doc | Field name | Refers to |
|---|---|---|
| `bookings` | `providerSlug` | `organizations.slug` |
| `inspection_jobs` | `inspectorId` | `users._id` |
| `auction_charges` | `providerSlug` | `organizations.slug` |
| `quick_request_offers` | `providerSlug` | `organizations.slug` |
| `chat_threads` | `providerSlug` (+ `participantUserId`) | both — depending on type |
| `chat` | `userId` | `users._id` |
| `notifications` | `userId` | `users._id` |
| `accounts` | `_id` (account_id), `userId` | itself + `users._id` |
| `payments` | `bookingId` | indirect via booking |
| `audit_logs` | (none consistent) | varies |

A backend dev currently has to remember **per-collection** which
identity to filter by. There is no single resolver that says
"give me everything about this provider" — there are five different
queries against five different keys.

---

## 2. The half-finished 1A → 1B → 1C migration

`/app/backend/app/core/capability.py` and `identity_runtime.py`
describe an architectural plan:

```
PERSON     → users
ACCOUNT    → accounts          (operational context — kind: inspector|service_provider|…)
PERMISSION → account_capabilities  (verb: inspect|repair|wash|…)
ORG        → organizations     (teams)
```

with the correct discipline:
- `account.kind` = noun ("who you are")
- `capability.verb` = action ("what you can do")

### What 1C actually shipped vs claims

The header in `app/system/auth.py` claims:

> "Sprint 1C — Identity Runtime Closure. ALL auth endpoints now go
> through `app.core.identity_runtime`. Single source of truth …"

The runtime code is real. But the data layer is **only lazily migrated**:

| Collection | Expected (1C closed) | Actual (Mongo) |
|---|---|---|
| `users` | unchanged, kept | 5 rows ✅ |
| `accounts` | one row per legacy user | **2 rows** (only `admin` + `provider@test.com`, populated via `ensure_account_for_user` on first login) |
| `account_capabilities` | one row per (account × verb) | **1 row** in the entire DB |
| `organizations` (1B "teams") | new collection — empty in 1B by design | does not exist as a separate collection — the **legacy** `organizations` (workshop directory) is overloaded |
| `organization_members` | new in 1B | empty |
| `specializations` | seeded as controlled vocabulary | not seeded |

So the platform is **simultaneously running the new model and the
old model** at the data layer. Endpoints **read** the new model
(via `IdentityContext`) but **fall back** to legacy via
`derive_capabilities_from_legacy(user_doc)` for anyone whose
`accounts` row was never created.

This is fine as a transitional state — but it means the provider's
perceived "self" depends on **whether they have ever logged in
since 1C**. Providers who haven't logged in have a phantom
"shim account" that exists only in memory, not in DB.

### Concrete consequence

`provider@test.com` has:
- `accounts.kind = 'inspector'`
- but `organizations.name = 'АвтоМастер Про'` (a workshop, not an inspection agency)

The system is internally **inconsistent about what business this
provider is in**. They were classified as `inspector` because
`_LEGACY_ROLE_TO_ACCOUNT_KIND['provider_owner'] = 'inspector'`
(line 92 of `capability.py`) — a hard-coded assumption that ALL legacy
`provider_owner` users are inspectors. This is the mapping that hides
the fracture: the system **decides for the provider** what they are.

---

## 3. Where the provider stops feeling like one operational actor

This is the heart of the audit.

### 3.1 The provider journey across surfaces

Walk the journey of a single login session, in order:

| Step | Surface | Identity provider sees | Identity backend uses |
|---|---|---|---|
| 1 | mobile login screen | email + password | `users.email` |
| 2 | mobile `(tabs)/index.tsx` | "Hi {firstName}" | `users.role` (legacy!) — `isInspector = role.startsWith('provider')` |
| 3 | mobile profile screen | `activeAccount.displayName` + `kind` chip | `accounts.kind` ✅ |
| 4 | mobile **Workbench** | **NO identity context shown** | `_resolve_provider_slug(ctx.user_id)` → `organizations.ownerId` |
| 5 | mobile **Earnings Clarity** | **NO identity context shown** | same as Workbench + `accounts.id == users._id` (legacy shim) |
| 6 | mobile inspector report | "Submit report" — silent | `inspection_jobs.inspectorId == users._id` |
| 7 | mobile chat (provider thread) | counterpart | `chat_threads.providerSlug` + `participantUserId` |
| 8 | web `ProviderInbox.tsx` | `(user as any).providerSlug \|\| 'avtomaster-pro'` ← **hardcoded fallback** | same |
| 9 | web `InspectorWorkspace.tsx` | `activeAccount.displayName` ✅ | `inspectorId = activeAccount.id` (works ONLY because of the legacy shim where `account.id == user._id`) |
| 10 | web customer view of provider | `j.inspectorId.substring(0, 10) + '…'` ← **provider IS a hex prefix** | raw `inspection_jobs.inspectorId` |
| 11 | admin panel | `organizations.slug` + `users.email` | both, separately |
| 12 | payment future | unknown | not yet wired |

### 3.2 The fractures

**Fracture A — "Who am I right now?" is invisible on the operational surfaces.**
The two surfaces where the provider does work (Workbench) and
sees money (Earnings) **never display the provider's identity**.
There is no "вы работаете как Сергей Мастеров — АвтоМастер Про"
header. The screens have a perfect contract for `ProviderWorkItem`
and `ProviderEarningsItem`, but no contract for "who is the
viewer." The provider is the **silent subject** of the projection.

**Fracture B — `(tabs)/index.tsx` regresses to legacy `user.role`.**
The home tab decides between `InspectorHome` and `CustomerHome`
using `user.role.startsWith('provider')`, while the rest of the app
(profile, switcher) was already migrated to `activeAccount.kind`.
The home tab is the one screen where most providers spend most
of their time — and it's the one screen on the wrong source of truth.

**Fracture C — `ProviderInbox.tsx` reads `providerSlug` from a place
the type system explicitly denies.**
```ts
const providerSlug = (user as any)?.providerSlug
  || (user as any)?.organizationSlug
  || 'avtomaster-pro';
```
Three problems in three lines:
1. `(user as any)` — typed-out-of-the-system access.
2. The `User` interface has neither `providerSlug` nor
   `organizationSlug`. The cast is a fiction.
3. The fallback is a **hardcoded slug** for the demo provider.
   In production this would address every unauthenticated provider's
   inbox to `avtomaster-pro`.

This is not a bug. This is a missing identity contract surfacing as
a defensive cast.

**Fracture D — `inspectorId` is `users._id`, but `activeAccount.id`
is `accounts._id`. They coincide today only because the legacy shim
returns `users._id` as the account id.**
The day a user has more than one account, every screen using
`activeAccount.id` as `inspectorId` will silently filter to zero rows.
`InspectorWorkspace.tsx:59` has this exact coupling:
```ts
const inspectorId = activeAccount?.id ?? null;
```
The mobile inspector report does the same. Neither file knows that
this works only by accident of 1A's shim.

**Fracture E — The customer experiences the provider as a hex prefix.**
`MyRequestsPage.tsx:157`:
```ts
{j.inspectorId ? `Inspector: ${j.inspectorId.substring(0, 10)}…` : t('my_requests.waiting_inspector')}
```
The customer literally reads `Inspector: 69fef20f46…`. The provider
has a name, an organization, a kind — none of it reaches the
customer's screen. Customer-facing identity is the most fractured
of all: it is **literally absent**.

**Fracture F — `_resolve_provider_slug` silently picks the first
organization.**
```python
org = await db.organizations.find_one(
    {"ownerId": ctx.user_id, "status": "active"},
    {"_id": 0, "slug": 1},
)
```
For a user owning two organizations (workshop + dealership), the
projector picks whichever Mongo returns first. The provider has no
way to switch context, and no way to know which slug they are
currently being projected as. The Workbench/Earnings response could
silently change between requests (different ordering on a re-balance).

**Fracture G — `account.kind` vocabulary diverges between web,
mobile, and backend.**
- Backend `ACCOUNT_KINDS = ('customer', 'admin', 'inspector',
  'service_provider', 'dealer', 'transport_provider')`.
- Mobile `AccountView.kind` Literal: `'customer' | 'inspector' | 'admin' |
  'service_provider' | 'dealer' | 'transport'` ← **`transport` ≠
  `transport_provider`**.
- `deriveMode` line 96 maps `'transport'` to `'provider'`, but a
  switch-account response carrying `'transport_provider'` from the
  backend would NOT match → `deriveMode` falls through to the legacy
  branch on `user.role`.

A semantic value silently splits depending on the surface.

**Fracture H — Capability granted is invisible.**
The provider has `caps=['inspect']` baked into their JWT, but
**no surface ever shows this**. The provider doesn't know they
are an "inspector" by capability — they only know it because the
home screen routes them to inspection jobs. If admin granted them
`repair` tomorrow, the provider would not see a new menu item;
they'd see no change at all unless they happened to log out and
back in.

---

## 4. Provider Identity Perception Map

> "Where does the provider stop feeling like one actor?"

| Context | Who does provider think they are? | Backend truth source | Surfaced to provider? |
|---|---|---|---|
| login screen | "me, the email holder" | `users.email` | yes (typed in) |
| home tab (mobile) | (no identity shown — only "Hi") | `users.role` (legacy!) | partial (first name) |
| home tab dispatching | "an inspector" (because routed to InspectorHome) | `users.role.startsWith('provider')` | implicit — no label |
| profile screen | `displayName` + kind chip | `accounts.kind` | yes ✅ |
| account switcher | one of N accounts | `accounts[]` | yes ✅ |
| **Workbench (mobile + web)** | **silent subject** | `organizations.ownerId` → `slug` | **NO — never shown** |
| **Earnings Clarity** | **silent subject, currency-segmented** | `organizations.slug` + `inspection_jobs.inspectorId` | **NO — never shown** |
| inspection job detail | "the assigned inspector" | `inspection_jobs.inspectorId` (=`users._id`) | implicit |
| quick-request offer | "АвтоМастер Про" (org-level) | `quick_request_offers.providerSlug` | implicit (it's their slug) |
| auction charge / lead fee | "АвтоМастер Про is being billed" | `auction_charges.providerSlug` | yes — Earnings deducted row |
| chat thread | depends on type=`support` (user-level) or `provider` (slug-level) | `chat_threads.providerSlug` OR `participantUserId` | label varies |
| customer's view of me | "Inspector: 69fef20f46…" | `inspection_jobs.inspectorId` raw | **broken** |
| admin panel view | name (user) + organization (slug) | both | both, but as separate facts |
| payouts (future) | unknown | (not implemented) | n/a |

**The coherent regions:**
- profile + switcher (one source of truth: `accounts`)

**The silent regions:**
- Workbench + Earnings (no identity surface at all)

**The fractured regions:**
- home tab (legacy `role`)
- web ProviderInbox (cast + hardcoded fallback)
- customer view (hex prefix)
- inspector job detail (legacy shim coupling)
- chat (dual identity per thread type)

---

## 5. Where semantics diverge from experience

The platform's **internal semantics** (after 1C) are clean:

> a provider is a `users` row with one or more `accounts`,
> each `account` has a `kind` and a set of `capabilities`,
> work and money attribute to an `accountId` resolved per request.

The **provider's experience** is:

> "I am sometimes my email, sometimes my role, sometimes my
> organization slug, sometimes a hex id, sometimes 'inspector',
> sometimes nothing at all. The system seems to know — but it
> doesn't tell me. When something goes wrong I won't know which
> 'me' the system was talking about."

The gap is not in the data model. The gap is that **identity is
never narrated to the provider**. There is no "I am" surface.

This is the precise sense in which **infrastructure is ahead of
semantics** for this layer — the opposite of the rest of the
project. We have built the runtime; we have not given the provider
an identity perception.

---

## 6. Hypotheses (NOT decisions)

The audit doesn't decide; it surfaces three plausible paths:

### Hypothesis P — Identity is a **projection**
There is one `ProviderIdentity` view computed per request from
all five universes (`users`, `accounts`, `organizations`,
`inspection_jobs.inspectorId`, `bookings.providerSlug`),
returned by a single read endpoint, rendered on every provider
surface as a stable header. No mutation, no new collection.
**Implication:** the provider always sees one coherent self;
the underlying split-brain remains.

### Hypothesis E — Identity is a **capability envelope**
The provider is whichever capabilities they currently hold; "kind"
is removed from the UI vocabulary entirely. Workbench and Earnings
filter by capability, not by `account.kind`. Switching accounts
becomes "switching capability set."
**Implication:** the provider experiences themselves as a verb-set,
not a noun. Could be powerful, but conflicts with the existing
`kind` rendering on profile / switcher.

### Hypothesis A — Identity is an **account abstraction**
The single source of truth becomes `accounts._id` everywhere —
including on `inspection_jobs.inspectorId` and
`organizations.ownerId`. Migration writes `accountId` onto every
existing operational doc. Legacy `users._id` references become
back-compat shims.
**Implication:** finally one key. But this is a substrate migration,
which doctrine forbids in 3.x.

### Hypothesis O — Identity is **multiple orthogonal identities**
The provider explicitly has ≥1 personas: "АвтоМастер Про the
workshop" and "Сергей Мастеров the inspector," and the platform
**stops trying to unify them**. UI surfaces always say which
persona is currently active. Account switcher is the canonical
mechanism. `account.kind` becomes the persona label everywhere.
**Implication:** matches today's data shape; the work is to make
persona visible everywhere it currently is silent.

---

## 7. What this audit does NOT recommend

- ❌ a `provider_identity` collection (substrate)
- ❌ a `GET /api/provider/identity` endpoint (commitment)
- ❌ an `@platform/domain/contracts/provider-identity.ts` (commitment)
- ❌ migrating `inspection_jobs.inspectorId` to `accountId` (substrate)
- ❌ extracting RBAC / permissions framework (substrate)
- ❌ rewriting auth (substrate)
- ❌ deciding between Hypotheses P / E / A / O (premature)

The audit's only product is **this document**.

---

## 8. The one product-semantic question that should drive
   the next decision

> When the provider opens Workbench at 9 AM, what should they
> see at the top of the screen that tells them **which 'self' the
> screen is showing data for**?

If the answer is "their name and one persona label" → Hypothesis O.
If the answer is "their capabilities" → Hypothesis E.
If the answer is "a single computed identity object" → Hypothesis P.
If the answer is "doesn't matter, one account = one self" →
  start by enforcing one-account-per-user (Hypothesis A).

The right next sprint cannot be chosen until product answers
**that one question**. Until then, the audit is the deliverable.

---

## 9. Verbatim list of files where the fracture surfaces in code

(Read-only references, no changes proposed.)

| File | Line(s) | Fracture |
|---|---|---|
| `frontend/app/(tabs)/index.tsx` | 47 | C/B — uses legacy `user.role` instead of `activeAccount.kind` |
| `frontend/src/context/AuthContext.tsx` | 19, 96 | G — `'transport'` vs backend `'transport_provider'` |
| `frontend/app/provider/workbench.tsx` | (entire file) | A — no identity header |
| `frontend/app/provider/earnings-clarity.tsx` | (entire file) | A — no identity header |
| `web-app/src/pages/provider/ProviderInbox.tsx` | 11 | C — `(user as any).providerSlug \|\| 'avtomaster-pro'` |
| `web-app/src/pages/inspector/InspectorWorkspace.tsx` | 59 | D — `inspectorId = activeAccount?.id` |
| `web-app/src/pages/customer/MyRequestsPage.tsx` | 157 | E — `inspectorId.substring(0, 10) + '…'` |
| `backend/app/provider/router.py` | `_resolve_provider_slug` | F — silently picks first organization |
| `backend/app/core/capability.py` | 91-101 | (legacy mapping that hides fracture) |
| `backend/app/system/auth.py` | 226-232 | bridge — `/me` still returns top-level `role` for back-compat |
| `backend/app/chat/router.py` | 4 | dual identity in one collection |

---

## 10. Status

Audit closed. No code touched. Next decision belongs to product:
answer the question in §8, then we can pick a hypothesis.

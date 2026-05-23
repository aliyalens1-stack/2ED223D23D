# Public Information Architecture

> Read-only artifact. No code, no UI components, no routing rewrite.
> Output: a sitemap, a shell model, audience flows, navigation ownership, and a route-by-route diagnosis that converts the doctrine in `product_ontology_map.md` into a navigable structure.

Date: 2026-05-09
Companion to: `/app/memory/product_ontology_map.md`, `/app/memory/spine_adoption_map.md`
Method: code evidence (`MarketplaceLayout.tsx`, `App.tsx`, i18n locales) + doctrinal mapping from the Ontology Map.

---

## 1. TL;DR

The single fastest-moving fact uncovered by this audit:

> **The hero migrated. The shell did not.**

The homepage `<h1>` says "Не покупайте авто вслепую. TÜV-инспектор..." The navbar that wraps it says "Поиск / Карта", the search placeholder says "Услуга, мастерская, проблема…", and the footer says "Маркетплейс автосервисов. Проверенные мастерские и выездные мастера в вашем городе."

Visitors see a platform headline inside a marketplace shell. **The shell is the carrier of legacy ontology, not the pages.** That is why the site feels confused even though the homepage copy is correct.

This document fixes the shell, not the pages. Three shells, audience-scoped navigation, explicit public/private/operator boundaries, and a route-level diagnosis that says where each of today's 40 routes belongs in the target IA.

---

## 2. Definitions

| Term | Meaning |
|---|---|
| **Shell** | A navigation reality. The chrome around a page: navbar, footer, primary calls-to-action, search affordance, branding tone. Independent of bundle. One Vite bundle, three shells. |
| **Surface** | A page or a tightly-grouped page family that lives inside one shell. |
| **Audience** | The principal viewing the surface. Today: `guest`, `customer`, `inspector`, `provider_owner/manager`, `admin`. After identity quarantine: `kind: 'guest' | 'customer' | 'inspector' | 'admin'`. |
| **Canonical entry point** | The single URL a fresh user of a given audience should land on if they do nothing else. The "homepage" of that audience. |
| **Trust artifact** | A surface whose existence is the platform's evidence to the world. Public Vehicle pages, public Cases, public Reports, public Methodology, Provider portfolios. Without trust artifacts, the homepage's claim is unsupported. |

---

## 3. The shell model — three shells, one bundle

### 3.1 Shells

| Shell | Audience | Tone | Density | Primary CTA | Search affordance |
|---|---|---|---|---|---|
| **PublicShell** | `guest`, occasional `customer` | trust narrative, premium-utility, magazine-grade | low (lots of breathing room) | "Проверить авто" | URL-paste / VIN / vehicle search (NOT service search) |
| **CustomerShell** | authenticated `customer` (`kind: 'customer'`) | ownership console, longitudinal | medium | "Добавить авто" / "Запустить проверку" | search WITHIN your own vehicles + a contextual operator search per-vehicle |
| **OperatorShell** | `inspector` and `provider_owner`/`manager` (after quarantine: `kind: 'inspector'` ± `organizationId`) | operational, dashboard-grade, dense | high | none — workspace, not catalog | jobs/exposures filter |

Admin remains a separate Vite bundle at `/api/admin-panel/` (already done — § 9 of `spine_transport_findings.md`).

### 3.2 Why three, not four

- Inspector and provider workspaces share the same operational mental model (Workbench, Earnings, Inbox, current job). They differ in scope (org-level vs solo) but not in shell. **One OperatorShell, two role variants inside it.**
- Customer and Owner are the same person (the platform doesn't separate "buyer" from "owner" — the same `customer` account moves through pre-purchase and post-purchase). **One CustomerShell, two life-cycle phases inside it.**
- Guest and unauthenticated visitor are the same. **PublicShell.**

### 3.3 What is explicitly NOT a shell

- The map is not a shell. It is a peripheral utility.
- Search is not a shell. It is a surface inside PublicShell (vehicle search) or a feature inside CustomerShell (operator search per-vehicle).
- "Marketplace" is not a shell. It is the legacy ontology this audit is dismantling.

---

## 4. Sitemap by shell

This is the **target** sitemap. Routes that exist today are marked. Routes that do not exist are marked NEW.

### 4.1 PublicShell

```
/                              SelectionHero — homepage, decision platform     [exists]
/how-it-works                  Platform doctrine + flow                        [NEW]
/methodology                   Why our 60+ checklist is honest                 [NEW]
/inspect                       Inspect by URL (mobile.de / autoscout24)        [exists]
/selection-request             Submit selection brief                          [exists]
/comparison                    Compare 3-5 vehicles                            [exists]
/cases                         Public inspection cases gallery                 [NEW]
/case/:id                      Single inspection case (verdict, evidence)      [NEW]
/report/:id                    Single report preview (redacted, sample)        [NEW]
/vehicles                      Public vehicle pages index (when owners publish)[NEW]
/vehicle/:id                   Public vehicle timeline (owner-permitted)       [NEW]
/operators                     Operators index (replaces "search masters")     [NEW]
/operator/:slug                Operator portfolio (replaces ProviderPage)      [exists, rebuild]
/packages                      Pricing for decisions, not for services         [exists, reframe]
/packages/success              Payment confirmation                            [exists]
/booking/:id                   Single booking (utility — not nav-promoted)     [exists]
/login, /register              Auth                                            [exists]
/legal/* (privacy, terms)      Legal                                           [exists in footer]
```

Demoted from primary nav (still exist, peripheral utility):
```
/search                        Operator search w/ map — peripheral utility    [exists, demote]
/zones                         Operator coverage map — peripheral utility     [exists, demote]
```

### 4.2 CustomerShell

```
/account                       Ownership console home (Vehicle-feed)          [exists, reframe]
/account/garage                Garage — list of central objects (Vehicles)    [exists, reframe]
/account/garage/:vehicleId     Vehicle Timeline — THE central page            [exists, reframe]
/account/cases                 Active and historical inspection cases         [NEW]
/account/cases/:id             Customer-side case detail                      [NEW]
/account/bookings              Bookings list (per vehicle context)            [exists]
/account/quotes                Quotes for active requests                     [exists, lift]
/account/quotes/:id            Quote detail (currently /dashboard/requests/:id/quotes) [exists, rename]
/account/requests              My selection requests                          [exists, rename]
/account/operators             Trusted operators (replaces "favorites")       [exists, reframe]
/account/profile               Personal profile                               [exists]
/account/packages              My active packages / receipts                  [exists, lift]
```

### 4.3 OperatorShell

```
/operator                       Workbench (canonical entry point)              [exists as /provider]
/operator/inbox                 Inbox / new exposures                          [exists as /provider/inbox]
/operator/current-job           Current job                                    [exists as /provider/current-job]
/operator/earnings              Earnings (Workbench + Earnings already canonical) [exists]
/operator/demand                Demand intelligence                            [exists as /provider/demand]
/operator/profile               Operator profile (mirrors public portfolio)    [exists]
/operator/billing               Billing                                        [exists]
/operator/onboarding            Onboarding                                     [exists]
/operator/inspection            Inspector workspace                            [exists as /inspector]
/operator/inspection/jobs/:id   Job detail                                     [exists]
/operator/inspection/report/:id Report workspace                               [exists]
```

Note: the `/provider/*` URL prefix is legacy from the marketplace ontology. The target prefix is `/operator/*`. URL renames must ship with redirects (see § 12).

---

## 5. Canonical entry points

The single URL a fresh user of each audience should land on:

| Audience | Canonical entry point | Why |
|---|---|---|
| `guest` (cold) | `/` (PublicShell home) | sells the platform, not a service |
| `guest` (with vehicle URL in mind) | `/inspect` | direct decision flow |
| `customer` (returning, has 0 vehicles) | `/account/garage` (empty state → "Add a vehicle") | central object first |
| `customer` (returning, has vehicles) | `/account` (Ownership feed — events on your vehicles) | longitudinal value |
| `customer` (with active case) | `/account/cases/:id` (deep link from email/push) | task-focused |
| `inspector` (start of shift) | `/operator/inbox` (next exposure) | task-focused |
| `provider_owner`/`manager` | `/operator` (Workbench) | org-level overview |

Login redirects are determined by these rules — not by guessing from `user.role` (which is the legacy quarantine target).

---

## 6. Audience flows (concrete URLs, not philosophy)

### 6.1 Buyer flow (cold-to-decision)

```
SEO landing
  → /                           "Не покупайте авто вслепую"
  → /how-it-works               (NEW) — read the platform doctrine
  → /cases                      (NEW) — see real inspection cases
  → /case/:id                   (NEW) — pick one, see evidence
  → /report/:id                 (NEW) — see a sample report
  → /                           returns
  → paste URL in hero
  → /inspect?url=...
  → /packages (or skip if pre-paid)
  → /register or /login         (becomes customer at this point)
  → /account/cases/:id          customer-side tracking
  → email/push → /account/cases/:id (status updates)
  → /booking/:id                view booking
  → final report delivered
  → /account/garage/:vehicleId  Vehicle now lives in their Garage
```

Today: steps marked NEW do not exist. The flow short-circuits at "I'll trust the homepage hero" — i.e., the trust narrative is asserted, not demonstrated.

### 6.2 Owner flow (long-tail, the under-built half)

```
/account                       feed: events on your vehicles
  → "Service interval approaching: 2019 BMW 320d at 87,000 km"
  → /account/garage/:vehicleId  Vehicle Timeline
  → "Find a trusted operator for belt service"
  → embedded operator filter (per-vehicle context)
  → /operator/:slug             portfolio
  → /booking/new?operatorId=...&vehicleId=...
  → /account/bookings/:id
  → completion
  → event lands on Vehicle Timeline
```

This flow is what makes the platform compounding rather than transactional. Today every step exists in fragments but no single navigation thread connects them.

### 6.3 Inspector flow (provider OS — already strongest)

```
/operator/inbox               next exposure (or /operator if multi-job overview)
  → claim
  → on-route
  → arrived
  → start-inspection
  → fill 60+ checklist (/operator/inspection/jobs/:id)
  → /operator/inspection/report/:id
  → submit
  → /operator/earnings (saw it land)
```

This flow is already the most complete in the codebase. No structural change needed beyond the URL prefix rename `/provider` → `/operator`.

### 6.4 Provider organization flow

```
/operator                     Workbench at org scope
  → /operator/inbox           team-wide queue
  → claim assigned to inspector (delegation)
  → /operator/earnings        org-aggregate
  → /operator/billing         settlement
  → /operator/profile         org's public face = /operator/:slug (mirror)
```

Same shell, scope-aware projection. Org-level vs solo is a `viewer.scope` setting on the Workbench/Earnings/Inbox surfaces.

---

## 7. Navigation ownership matrix

Which shell owns which navbar element. **Each row appears in exactly one shell's primary navigation.**

| Element | PublicShell | CustomerShell | OperatorShell |
|---|:-:|:-:|:-:|
| Brand link → `/` | ✅ | ✅ (homepage of shell, not site) | ✅ (homepage of operator) |
| Hero search (URL paste) | ✅ | — | — |
| "How it works" | ✅ | — | — |
| "Cases" | ✅ | — | — |
| "Operators" (index) | ✅ (browse, not "find masters near you") | — | — |
| "Pricing" | ✅ | — | — |
| **Vehicle search** | ✅ (search by VIN / make / model on public vehicle pages) | — | — |
| **Operator search** | demoted to `/operators` peripheral | per-vehicle context, not a top-nav item | — |
| **Map** (`/zones`) | demoted to footer / peripheral | demoted | — |
| Garage / Vehicle Timeline | — | ✅ (primary) | — |
| My Cases | — | ✅ | — |
| My Bookings | — | ✅ | — |
| My Quotes | — | ✅ | — |
| Trusted Operators | — | ✅ (renamed from Favorites) | — |
| Workbench | — | — | ✅ (canonical entry) |
| Inbox | — | — | ✅ |
| Current Job | — | — | ✅ |
| Earnings | — | — | ✅ |
| Demand | — | — | ✅ |
| Inspector workspace | — | — | ✅ |
| Profile (own) | ✅ (login link) | ✅ | ✅ |
| Account switcher | — | ✅ (when user has both `customer` and `inspector` accounts) | ✅ |
| Notifications | — | ✅ | ✅ |
| "Become an operator" | ✅ (CTA in footer / drawer for guests) | ✅ (only if user has no `inspector` account yet) | — |
| Login / Register | ✅ (when guest) | — | — |
| Logout | — | ✅ | ✅ |

### 7.1 The single most important rule

> **Public visitors must never see operator navigation. Operators must never see customer cabinet navigation.**
>
> Today's `MarketplaceLayout` shows `nav.requests` (provider inbox), `nav.current_job` (provider current-job), `nav.earnings` to *anyone* whose `user.role.startsWith('provider')`, even if they're currently browsing public surfaces. Mixing personas inside one shell is the structural source of the "site feels confused" complaint.

The fix is shell-level routing, not per-link conditional rendering.

---

## 8. Public / private / operator boundaries

### 8.1 Auth gates by shell

| Shell | Auth required | Predicate |
|---|---|---|
| PublicShell | no | — |
| CustomerShell | yes | `hasKind(activeAccount, 'customer')` |
| OperatorShell | yes | `hasKind(activeAccount, 'inspector')` |

Identity quarantine (`identity_quarantine_plan.md`) supplies these predicates. **The IA does not introduce new auth concepts.** It commits to using the canonical predicates the quarantine establishes.

### 8.2 Cross-shell deep links

| From | To | Mechanism |
|---|---|---|
| Email/push for case status | `/account/cases/:id` | sign-in if needed → land in CustomerShell |
| Email/push for new exposure | `/operator/inbox` (or specific exposure) | sign-in if needed → land in OperatorShell |
| Public vehicle page | "Save to garage" | sign-in if guest → CustomerShell `/account/garage/:vehicleId` |
| Customer vehicle | "Find an operator" | stays in CustomerShell, opens an inline operator picker contextualized by the vehicle |

### 8.3 Shell switching for dual-account users

A user who is both a `customer` and an `inspector` at different organizations must be able to switch shells without re-login. The mechanism already exists (`account-switcher`) — IA only commits that switching is a **shell-level** action, not a per-page toggle. After switching, the URL moves to that shell's canonical entry point.

---

## 9. Diagnosis — every current route → target shell + verdict

40 routes in `web-app/src/App.tsx`. Tabulated.

| Current route | Shell | Status quo verdict | Target |
|---|---|---|---|
| `/` | PublicShell | ✅ correct ontology | unchanged |
| `/inspect` | PublicShell | ✅ | unchanged |
| `/selection-request` | PublicShell | ✅ | unchanged |
| `/comparison` | PublicShell | ✅ | unchanged |
| `/search` | PublicShell (peripheral) | ❌ marketplace | demote from primary nav, keep URL with redirect from `/operators?q=...` |
| `/zones` | PublicShell (peripheral) | ❌ marketplace | demote to footer/peripheral |
| `/dashboard/requests` | CustomerShell | ⚠️ wrong URL prefix | rename → `/account/requests` |
| `/dashboard/requests/:id` | CustomerShell | ⚠️ same | rename → `/account/requests/:id` |
| `/dashboard/requests/:id/quotes` | CustomerShell | ⚠️ same | rename → `/account/quotes/:id` |
| `/packages` | PublicShell | ⚠️ frame as "decisions", not "services" | reframe copy, no URL change |
| `/packages/success` | PublicShell | ✅ | unchanged |
| `/packages/paypal-mock` | PublicShell | ⚠️ mock should be removed in prod | flag for review (out of IA scope) |
| `/provider/:slug` | PublicShell | ⚠️ service card | rename → `/operator/:slug`, rebuild as portfolio |
| `/booking/:id` | PublicShell (utility) | ✅ keep for shareable booking links | unchanged |
| `/account/home` | CustomerShell | ❌ ecommerce dashboard | reframe as Ownership feed |
| `/account/bookings` | CustomerShell | ✅ | unchanged |
| `/account/garage` | CustomerShell | ⚠️ vehicle list, weak as "central object index" | reframe — Garage = list of central objects |
| `/account/garage/:vehicleId` | CustomerShell | ❌ vehicle detail page is undersized | the most important rebuild — Vehicle Timeline |
| `/account/favorites` | CustomerShell | ⚠️ "favorited masters" framing | rename → `/account/operators`, reframe as "Trusted operators" |
| `/account/profile` | CustomerShell | ✅ | unchanged |
| `/provider` (provider home) | OperatorShell | ⚠️ wrong URL prefix | rename → `/operator` |
| `/provider/workbench` | OperatorShell | ✅ canonical | rename URL → `/operator/workbench`, content unchanged |
| `/provider/inbox` | OperatorShell | ✅ | rename → `/operator/inbox` |
| `/provider/current-job` | OperatorShell | ✅ | rename → `/operator/current-job` |
| `/provider/earnings` | OperatorShell | ✅ | rename → `/operator/earnings` |
| `/provider/earnings-clarity` | OperatorShell | ✅ | rename → `/operator/earnings/clarity` |
| `/provider/demand` | OperatorShell | ✅ | rename → `/operator/demand` |
| `/provider/profile` | OperatorShell | ✅ | rename → `/operator/profile` |
| `/provider/billing` | OperatorShell | ✅ | rename → `/operator/billing` |
| `/provider/onboarding` | OperatorShell | ✅ | rename → `/operator/onboarding` |
| `/provider-onboarding` (alt URL) | PublicShell (CTA from public) | ⚠️ alt URL | redirect → `/operator/onboarding` (with public preview gate) |
| `/inspector` | OperatorShell | ✅ workspace | rename → `/operator/inspection` |
| `/inspector/jobs/:id` | OperatorShell | ✅ | rename → `/operator/inspection/jobs/:id` |
| `/inspector/jobs/:id/report` | OperatorShell | ✅ | rename → `/operator/inspection/report/:id` |
| `/login`, `/register` | PublicShell | ✅ | unchanged |

Net: **24 URL renames** (with redirects), **2 demotions from primary nav**, **5 reframes** (copy/IA only, no URL change), **9 NEW routes** (the missing trust artifacts + customer-side cases routes).

---

## 10. Routes that MUST be created (gap closure)

In priority order. None of these need to ship together. Each is bounded enough to be its own operation later.

| New route | Why critical | Owner shell |
|---|---|---|
| `/case/:id` | Public inspection case is the trust artifact the homepage promises | PublicShell |
| `/cases` | Index of cases — the SEO surface for "проверка авто [model]" queries | PublicShell |
| `/operator/:slug` (rebuilt) | Provider portfolio is what converts the platform from "directory" to "showcase" | PublicShell (it's a public profile) |
| `/operators` | Index of operators — replaces "search masters" with "browse expertise" | PublicShell |
| `/how-it-works` | Platform doctrine page | PublicShell |
| `/methodology` | Trust justification | PublicShell |
| `/report/:id` (preview) | Sample report visibility before payment | PublicShell |
| `/vehicle/:id` | Public Vehicle page (owner-permitted) | PublicShell |
| `/vehicles` | Index of public vehicles (when owner published — for-sale flow) | PublicShell |
| `/account/cases` | Customer's own case management | CustomerShell |
| `/account/cases/:id` | Single case from customer side | CustomerShell |

**Total: 11 new routes.** Five trust artifacts, three browse indexes, two doctrine pages, one customer surface. This is the IA gap, and this is the size of the gap.

---

## 11. Routes that MUST be demoted

| Route | Action | Why |
|---|---|---|
| `/search` | Remove from primary nav, keep as fallback utility (e.g. accessible from `/operators` via "see on map"). Search placeholder copy must change from "Услуга, мастерская, проблема…" to vehicle-context. | Marketplace ontology |
| `/zones` | Remove from primary nav. May exist as a footer link "Operator coverage". | Dispatch theatre, not platform value |
| `nav.search`, `nav.map` (i18n keys + nav links) | Removed from `MarketplaceLayout` primary navigation | Same |
| `home.*` i18n key tree (legacy "Найти мастера рядом") | Remove all consumers, then delete the keys | Two ontologies in same i18n file |
| `footer.tagline = "Маркетплейс автосервисов..."` | Rewrite — replaces marketplace framing with platform framing | Footer is high-impact trust copy |
| `nav.search_placeholder = "Услуга, мастерская, проблема…"` | Rewrite — vehicle-context placeholder ("VIN, ссылка mobile.de, марка/модель") | Hero already does this; navbar must follow |

---

## 12. SEO continuity guardrails

This IA is a target structure. It must not ship by deleting URLs. The following guardrails apply to whichever bounded operation eventually executes the renames:

1. **Every renamed URL ships with a `301` redirect from the old URL.** No `/provider/...` URL is removed without a redirect to `/operator/...`. No `/dashboard/requests/...` URL is removed without redirect to `/account/requests/...`.
2. **No URL is removed that is currently indexed by search engines** without a 301 to the closest canonical equivalent.
3. **Sitemap.xml must reflect the new IA**, but old URLs remain redirect-only for at least one indexing cycle.
4. **`robots.txt` and `meta robots`** are not changed by IA work; they are SEO concerns separate from IA.
5. **Internal links** updated en masse in the same operation that introduces the redirects, not before, not after.

The IA does not commit to a redirect implementation. It commits that none of its commitments may be executed without a redirect plan attached.

---

## 13. What this IA decides (column form, copy-pasteable inputs to the next artifact)

1. **Three shells, one bundle:** PublicShell, CustomerShell, OperatorShell. Admin already separate.
2. **Canonical entry points per audience.**
3. **Public surfaces include 11 new routes.** Five trust artifacts (`/case/:id`, `/cases`, `/report/:id`, `/vehicle/:id`, `/vehicles`), three browse indexes (`/operators`, `/cases`, `/vehicles`), two doctrine pages (`/how-it-works`, `/methodology`), two customer-side case surfaces.
4. **24 URL renames with redirects.** Every `/provider/*` → `/operator/*`. Every `/dashboard/requests/*` → `/account/requests/*` and `/account/quotes/*`. `/inspector/*` → `/operator/inspection/*`.
5. **Two routes demoted:** `/search` and `/zones` exit primary nav.
6. **Footer + navbar copy rewritten.** Marketplace tagline replaced. Legacy `home.*` i18n keys removed.
7. **Provider profile rebuilt as portfolio**, not service card. URL renamed `/provider/:slug` → `/operator/:slug`.
8. **Vehicle Timeline (`/account/garage/:vehicleId`)** is the most important rebuild in the cabinet.
9. **Garage reframed** as "list of central objects", not "list of cars".
10. **Account switcher operates at shell level**, not per-page.

---

## 14. What this IA does NOT decide

- No visual design. No palette. No motion. No typography choices.
- No copy beyond the boundary-defining footer/navbar/placeholder rewrites.
- No React component decomposition.
- No routing implementation choices (loaders, guards, suspense, etc.).
- No new API endpoints or data shapes.
- No order of execution. The IA is a target. Sequencing is the next artifact's job.

---

## 15. The next artifact (advisory)

Per the established sequence:

**`/app/memory/canonical_surface_map.md`** — for each shell, the *layout primitives* (navbar structure, footer structure, primary CTA placement, search affordance shape, account switcher position) and the *page-type taxonomy* (what does a "case page" look like as a layout class, what does a "vehicle timeline page" look like). Read-only, bounded, no UI implementation.

After it: the first bounded UI operation. That operation will have a name like `Shell Split α` (analogous to `Spine Transport Parity α`) and its scope will be: **introduce three shells, route gating only, no copy changes, no new pages.** Bounded, monotonic, reversible.

The discipline is the same as the spine work. Map → Plan → Bounded execution.

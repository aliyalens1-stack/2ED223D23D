# Product Ontology Map

> Read-only artifact. No code, no UI, no routing. Output: a single defensible answer to one question — **what product are we actually building?**

Date: 2026-05-09
Companion to: `/app/memory/spine_adoption_map.md`, `/app/memory/identity_quarantine_plan.md`
Method: code evidence (`web-app/src/`, `shared/domain/contracts/`, `i18n locales`, route map) + doctrinal reasoning.

---

## 0. The one-line answer

> **Auto Search is a vehicle-centric trust platform.**
> It exists so that buyers, owners, and operators can make decisions about *a specific car* with the help of evidence accumulated *on that car* by independent third parties.

Not a marketplace. Not "Uber for masters". Not a comparison tool. A platform whose central object is a car, and whose value is the trust narrative attached to that car over time.

---

## 1. Central object — confirmed: **Vehicle** (in its timeline form)

### 1.1 Why Vehicle wins over the alternatives

| Candidate | Argument | Why rejected as central |
|---|---|---|
| `Request` | Highest transactional volume | Disposable. Lifespan = hours. No memory accrues to it. |
| `Booking` | Money flows through it | Same as Request — terminates. |
| `Provider` | Marketplace logic | Provider exists *to act on* Vehicles. Backwards anchor. |
| `Service` | Catalog logic | Generic SKU. Nothing specific to *this car* attaches to it. |
| `Inspection Case` | Trust artifact | Strong contender, but each case attaches *to* a Vehicle. Multiple cases per Vehicle, not the reverse. |
| **`Vehicle`** | Durable identity. Memory accumulator. Buyer/seller/inspector/owner all act on it. | **Selected.** |

### 1.2 Code evidence — Vehicle is *already* declared first-class

`shared/domain/contracts/vehicle.ts` (excerpt verbatim):

```ts
// P4 hard rules captured by this contract (do NOT collapse):
//   vehicle.status   ≠   customer.intent           ≠   delivery/ownership
//   VehicleOperational   CustomerVehiclePerception   VehicleMemoryStage
//   Status               (buyer's mental model)      (timeline phase)
```

The spine already commits to:
- Vehicle as a real entity (`db.vehicles`, REST at `/api/customer/vehicles/*`).
- Three **orthogonal** projections of a Vehicle (operational / perception / memory).
- An explicit anti-collapse rule preventing fold into one enum.

The user-facing product has not yet adopted this commitment. **The spine is more advanced than the surface that consumes it.**

### 1.3 The precision the user's hypothesis missed

Vehicle alone is data. The central object is **Vehicle + everything that attached to it over time** — the `VehicleMemoryStage` projection.

Behance analogy holds: the central object is not "the file", it is "the project". A static row about a 2019 BMW 320d is nothing. A 2019 BMW 320d with three inspection reports, a maintenance ledger, an ownership transfer, and a verified mileage trail — *that* is the platform.

**Operational implication:** the platform must support a Vehicle that has zero attached events (newly added) AND a Vehicle with hundreds of events (long-owned). The same object, two completely different rendering modes, both first-class.

---

## 2. Platform formula

```
DISCOVER → DECIDE → EXECUTE → OWN → REMEMBER
```

Each stage is a verb on a Vehicle, performed by some actor, producing some artifact.

| Stage | Actor | Action verb | Artifact produced |
|---|---|---|---|
| Discover | buyer | browse, filter, follow | shortlist |
| Decide | buyer | inspect, compare, score | Inspection Report, Comparison |
| Execute | buyer + provider + inspector | book, inspect, repair, transfer | Booking, Quote, Inspection Case |
| Own | owner | maintain, document, repair | service event, maintenance log |
| Remember | owner + future buyer | timeline view, share, transfer | full Vehicle Memory |

### 2.1 The asymmetry that defines today's product gap

Today, surface-area is heavily weighted toward Discover+Decide+Execute (the pre-purchase half). Own and Remember exist in code (`shared/domain/contracts/vehicle.ts` + `vehicleMemoryStore.ts` + `CustomerVehicleDetail.tsx`) but have almost no UI presence. **The right half of the formula is the under-built half, and it is also the half that creates compounding value** — every owner-event today becomes evidence for tomorrow's buyer.

This is the single most important strategic observation in this document.

---

## 3. Six-layer stack

The product does not have one mode; it has six concentric layers. Each has a different audience, a different success metric, a different visual density.

| Layer | Purpose | Primary audience | Success metric | Lives where today |
|---|---|---|---|---|
| **Public Knowledge** | Trust narrative the platform tells the world | unauthenticated visitors, search engines, future buyers | first-visit-to-action conversion, organic traffic | minimally — only `/`, `/inspect`, `/selection-request`, `/comparison`. **No public Vehicle pages, no public Case pages, no public Report previews, no public Provider portfolios in the modern sense.** |
| **Decision Support** | Tools that turn "I'm thinking about this car" → "I am buying this car" | active buyer | report-to-purchase rate | partially — `/inspect`, `/comparison`. Not visible from homepage navigation. |
| **Execution** | Operational work that produces the artifacts: bookings, inspections, payments | buyer + provider + inspector | job completion rate, dispute rate | well — `/booking/:id`, `/account/bookings`, `ProviderWorkbench`, `InspectorWorkspace`. **This is the strongest layer in current code.** |
| **Ownership Console** | Long-term home for a vehicle's life on the platform | owner | vehicles-per-user, events-per-vehicle, return rate | embryonic — `/account/garage`, `/account/garage/:vehicleId`. **Currently dressed as ecommerce dashboard.** |
| **Provider Operating System** | Workspace where a verified operator runs their day | provider, inspector | jobs-completed-per-week, rating, retention | well — `ProviderWorkbench`, `ProviderEarningsClarity`, `InspectorWorkspace`, `ReportWorkspace`. **Best-developed layer in the entire product. Hidden internally.** |
| **Admin Governance** | Trust enforcement, payouts, moderation | platform staff | manual intervention rate, fraud detection | strong in scope (66 admin pages) but **mostly broken at runtime** because NestJS is disabled (see `spine_adoption_map.md` § 3). |

### 3.1 The diagnosis these layers force

The current web-app has all six layers physically present in code, but **not separated mentally in the UI**. A single navbar pretends all six are facets of "the product", when they are six different products that happen to share a database.

This is *the* fracture. Not a CSS issue. Not a layout issue. An IA issue.

---

## 4. What is public, what is not — explicit decision

### 4.1 The current public surface (8 pages)

```
/                    SelectionHero          ✅ correct ontology
/inspect             InspectByURL           ✅ correct ontology
/selection-request   SelectionRequest       ✅ correct ontology
/comparison          ComparisonPage         ✅ correct ontology
/search              SearchPage (map)       ❌ marketplace ontology — legacy
/zones               LiveForecastMapPage    ❌ marketplace ontology — legacy
/provider/:slug      ProviderPage           ⚠️ service card, not portfolio
/booking/:id         BookingDetailPage      ⚠️ utility, not narrative
```

Four routes are correctly platform-grade. Two are legacy "masters near you" surfaces still actively reachable. Two are utility pages that don't carry trust narrative.

### 4.2 What the i18n actually says (forensic evidence)

| Locale key | Says | Verdict |
|---|---|---|
| `selection.hero.title` | "Не покупайте авто вслепую. Проверьте его перед покупкой в Германии и ЕС." | ✅ platform-grade |
| `selection.hero.subtitle` | "TÜV-инспектор проверит авто на месте, пришлёт отчёт, фото и видео." | ✅ trust + methodology |
| `selection.cards.compare.title` | "Сравнить несколько авто" / "Выбор станет очевидным." | ✅ decision support |
| `selection.trust.tuv` / `fixed_price` / `report_24h` / `photos_videos` | TÜV inspectors / fixed price / 24h report / 60+ checklist | ✅ trust artifacts |
| `home.title` (legacy) | "Найти мастера рядом." | ❌ marketplace |
| `home.subtitle` (legacy) | "Сравните мастерские, выездных мастеров, время прибытия, рейтинг и цену." | ❌ marketplace |
| `home.search_placeholder` (legacy) | "Что случилось? Двигатель, тормоза, диагностика…" | ❌ marketplace + reactive ("что случилось") |

**The platform speaks two languages in the same i18n file.** Surface that imports from `selection.*` is platform. Surface that imports from `home.*` is legacy.

### 4.3 What does not exist publicly but must (page-level)

The following routes are absent today and should exist for the platform ontology to be complete:

| Missing route | Owner | Why critical |
|---|---|---|
| `/vehicle/:id` (public, when owner permits) | Vehicle | Central object must have a public face when the owner publishes it (e.g. for sale). |
| `/case/:id` (public showcase of an inspection) | Inspection Case | Trust artifact requires a public form to function as social proof. |
| `/report/:id` (preview, redacted) | Inspection Report | Buyer must see *what a real report looks like* before paying. Behance's "view samples" rule. |
| `/how-it-works` | platform | Platform-grade products explain themselves. The current site does not. |
| `/methodology` | platform | "Why our 60+ checklist is honest" — trust narrative. |
| `/provider/:slug` (rebuilt as portfolio) | provider | Currently a service card. Should be portfolio: cases, reports, methodology, certifications, retention metrics. |

These six routes are not "nice to have". They are the literal trust narrative of the platform. Without them, the homepage's claim ("Не покупайте авто вслепую") has no evidence behind it.

### 4.4 What is explicitly NOT public

These are operational and must remain auth-gated:
- `/account/*` (customer cabinet — though some Vehicle pages may be selectively shareable)
- `/provider/{workbench,inbox,current-job,earnings,demand,billing}` (provider OS)
- `/inspector/*` (inspector workspace + report workspace)
- `/admin/*` (governance)

---

## 5. What is secondary — repair / wash / tow / dispatch

The current `SearchPage` and `LiveForecastMapPage` treat repair-and-dispatch economy as the primary flow. They should not.

### 5.1 Where repair belongs

Repair is **post-purchase services**. It is the right half of the platform formula (Own / Remember). Specifically:
- A vehicle in the customer's Garage gets a "needs maintenance" event.
- The Ownership Console offers context-aware repair: "your 2019 BMW 320d at 87,000 km is approaching belt service — three trusted operators near you."
- This is repair-as-attached-event, not repair-as-search-page.

### 5.2 What this means for `/search` and `/zones`

These two routes carry an ontology that is **neither public-trust narrative nor operational ownership console.** They serve a real but secondary use case (find a repair shop in unfamiliar city) and should be:
- demoted from primary navigation
- repositioned as "Find services for *this car*" entry points from the Ownership Console
- accessible publicly only as a fallback / utility surface

The map is not removed. It is moved from cognitive center to peripheral utility — a reference tool, not a homepage.

---

## 6. Diagnosis of the current web-app — page-by-page

The format: `[current-route] | what-it-IS-today | what-it-SHOULD-BE | layer it belongs to`.

| Route | Current ontology | Correct ontology | Layer |
|---|---|---|---|
| `/` | SelectionHero (correct) | unchanged | Public Knowledge |
| `/inspect` | Inspect by URL (correct) | unchanged | Decision Support |
| `/selection-request` | Submit selection request (correct) | unchanged | Decision Support |
| `/comparison` | Compare 3-5 vehicles (correct) | unchanged | Decision Support |
| **`/search`** | "Find masters near you" map | **Find services for a vehicle in this city** (utility), demoted from primary nav | Public Knowledge (peripheral) |
| **`/zones`** | "Live forecast map" — dispatch theatre | **Operator coverage map** — informational, peripheral | Public Knowledge (peripheral) |
| **`/provider/:slug`** | Service card with rating, services, prices | **Operator portfolio** — completed cases, sample reports (with consent), methodology, certifications, response time, dispute history | Public Knowledge |
| `/booking/:id` | Single-booking utility view | unchanged | Execution |
| `/packages` / `/packages/success` | Pricing | unchanged but should reflect "decision package", not "service tier" | Decision Support |
| `/account/home` | "Повторить заказ", "Избранные мастера", "Рекомендации" — ecommerce dashboard | **Ownership feed** — events on your vehicles, upcoming maintenance, active cases, reports timeline | Ownership Console |
| `/account/bookings` | Booking list | unchanged but enriched with vehicle context per row | Ownership Console |
| `/account/garage` | Vehicle list | **Garage = list of central objects.** Each tile is the cover of a Vehicle Timeline. | Ownership Console |
| `/account/garage/:vehicleId` | Vehicle detail | **Vehicle Timeline page** — central object's full memory: ownership, inspections, reports, maintenance, trusted operators, decisions | Ownership Console (the most important page in the cabinet) |
| `/account/favorites` | Favorited masters | **Followed operators** — operators you trust, with their case feed | Ownership Console |
| `/account/profile` | User profile | unchanged | Ownership Console |
| `/account/quotes/:id` (`/dashboard/requests/:id/quotes`) | Quote list for a request | unchanged | Execution |
| `/provider/dashboard` etc. | Provider OS routes | unchanged structurally; persona narration extends | Provider OS |
| `/inspector/*` | Inspector workspace | unchanged structurally; persona narration extends | Provider OS |

### 6.1 The pattern this table reveals

- Public-platform pages and decision-support pages are **mostly correct**. The hero already migrated.
- Marketplace-legacy pages (`/search`, `/zones`) are **stranded** — still reachable from navbar, still indexed, but ontologically obsolete.
- Provider profile (`/provider/:slug`) is **the single highest-leverage public rebuild** — turning service cards into portfolios is what converts the platform from "directory of contractors" to "showcase of operators".
- The customer cabinet is **the under-built half**. `/account/garage/:vehicleId` is potentially the most important page in the entire product, and today it is the closest a user gets to the central object.
- The provider OS is **the strongest internal layer**, hidden behind auth, contributes nothing to public trust narrative.

---

## 7. Surface decision — keep one bundle, separate IA

### 7.1 The question

Does the web-app split into multiple Vite bundles (public / customer / provider / inspector), or stay as one with internal IA discipline?

### 7.2 The answer: stay as one bundle, separate the navbars

Code evidence: `web-app/vite.config.ts` already does code-splitting per audience (`web-customer`, `web-provider`, `web-inspector`, `web-public`, `web-auth`). The chunks already exist. **The bundling is already correct.**

What is wrong is the **navigation shell**. `MarketplaceLayout.tsx` is a single navbar that shows the same links to a public visitor, a customer, a provider, and an inspector. This is the source of "the site feels confused."

The decision:
- One Vite bundle (no fork into multiple apps).
- Three distinct navigation shells inside it: `PublicShell`, `CustomerShell`, `OperatorShell` (provider+inspector share). Admin remains a separate app at `/api/admin-panel/` (already done — confirmed in `spine_transport_findings.md`).
- Routes are tagged with their shell at the route layer, not by guessing from URL.
- Authenticated users can switch between Customer and Operator shells if they hold both account kinds (the `account-switcher` already exists for this).

This is not a rewrite. It is a navigation refactor. **The right level of intervention.**

### 7.3 What is explicitly out of scope

- No splitting the codebase into multiple repos.
- No yarn workspaces.
- No second Vite app for public.
- No microfrontend.

The existing `@platform/*` transport (closed in α) makes single-bundle the correct choice. Multiple bundles would multiply the spine adoption surface, not reduce it.

---

## 8. The four primary journeys (one paragraph each)

### 8.1 Buyer (pre-purchase)
Lands on the platform via search engine ("проверка авто перед покупкой mobile.de"), reads the methodology page, sees a sample inspection report, sees three real cases with verdicts, books an inspection by pasting a URL. The platform produces a report; the buyer either purchases the car or walks away. Either outcome adds an artifact to the platform's public trust corpus.

### 8.2 Owner (post-purchase)
Has one or more vehicles in their Garage. Each vehicle is a timeline. Maintenance reminders, follow-up inspections, recall notices, transfer-of-ownership tools attach as events. Trusted operators discovered during pre-purchase carry over. Selling a vehicle becomes "publish your timeline as a public Vehicle Page" — a powerful sale signal.

### 8.3 Inspector (provider, executor)
Logs into the operator shell, sees their Workbench with current jobs grouped by state, accepts the next exposure, drives to the vehicle, fills the structured 60+ checklist, photographs evidence, submits the report. The platform pays them. Their public profile auto-accrues their completed-cases portfolio (with redaction rules controlled by the buyer).

### 8.4 Provider organization (multi-operator service)
Onboards a team. Workbench + Earnings show the org-level view. Org membership roles distinguish owner from manager (note: ontology already resolved in `identity_quarantine_plan.md` § 0.5 — these are organization roles, not account kinds). The provider page becomes the org's public face.

---

## 9. The two ontologies still coexist (forensic evidence)

To make this concrete and falsifiable:

| Indicator | Modern ontology says | Legacy ontology says | Verdict |
|---|---|---|---|
| Hero `selection.hero.title` | "Не покупайте авто вслепую. TÜV-инспектор..." | — | ✅ |
| Old hero `home.title` | — | "Найти мастера рядом." | ❌ still in i18n |
| Search-placeholder | "URL c mobile.de / autoscout24" | "Что случилось? Двигатель, тормоза, диагностика…" | both still ship |
| Trust indicators | TÜV / fixed price / 24h / photo+video | rating / ETA / price | both still ship |
| Customer dashboard sections | (none) | "ПОВТОРИТЬ ЗАКАЗ" / "ИЗБРАННЫЕ МАСТЕРА" / "РЕКОМЕНДАЦИИ" | ❌ legacy only |
| Public Vehicle page | does not exist | does not exist | ❌ central object has no public face |
| Public Case page | does not exist | does not exist | ❌ trust artifact has no public face |

This dual residence is the same kind of structural contradiction we documented in `spine_adoption_map.md`: two ontologies on the same wire, surfaces choosing whichever is closer.

---

## 10. What this map decides

In one column. These are the doctrinal commitments this document makes for the next bounded operations to use as input:

1. **Central object: Vehicle (in timeline form).** Already declared in spine. Now also declared in product.
2. **Platform formula: Discover → Decide → Execute → Own → Remember.** Right half is under-built and is the compounding-value half.
3. **Six layers, six audiences, three shells.** Public / Customer / Operator. Admin already separate.
4. **Public Vehicle page, public Case page, public Report preview, public Methodology page, public Provider portfolio** are the five missing trust artifacts.
5. **`/search` and `/zones` are demoted from primary nav.** Repair is post-purchase, attached to Vehicle, not center stage.
6. **Customer cabinet is reframed as Ownership Console**, with `/account/garage/:vehicleId` (Vehicle Timeline) as its central page.
7. **Provider profile is rebuilt as portfolio**, not service card. This is the single highest-leverage public-rebuild.
8. **Persona narration extends from Workbench/Earnings (already done) to every operator surface and to admin impersonation.** This is the §8 thread, unchanged.
9. **Single Vite bundle, three navigation shells.** Existing code-splitting is correct.
10. **No URL changes that break SEO without redirect** — out of scope for this map, must be respected by the next operation.

---

## 11. What this map does not decide

- It does not specify any visual change. No copy. No pixels. No motion.
- It does not propose a sprint plan. The next artifact does.
- It does not change any backend.
- It does not deprecate any existing route.
- It does not rename any entity.
- It does not commit to a date.

If the next session attempts to derive a UI rebuild plan that contradicts § 10, this map is being violated.

---

## 12. The next artifact (advisory)

Per the established sequence, the next artifact is:

**`/app/memory/public_information_architecture.md`** — sitemap + flow diagrams that operationalize § 4.3 and § 6 into a navigable structure. Read-only, bounded, no UI work. After it: `/app/memory/canonical_surface_map.md`. Only after both — the first bounded UI operation.

The sequence is identical to what produced the spine work: map → plan → bounded execution. Not "UI Rebuild v1".

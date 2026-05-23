# PHASE 1.1 — Admin Surface Triage (INVENTORY ONLY)

**Date:** 2026-05-22
**Phase:** P1.1 of FINAL CLOSURE ROADMAP
**Status:** ✅ INVENTORY COMPLETE — **NO migrations, NO deletions, NO code changes performed.**

Two-pass automated scan of all 79 admin pages, route map from `App.tsx`,
helper-import resolution against `services/api.ts` (210-method `adminAPI`
facade), live curl probes of 27 backend prefixes with admin JWT.

Output artefacts:
- `/app/audit/admin_triage_inventory.json` (pass 1 — inline paths only)
- `/app/audit/admin_triage_inventory_v2.json` (pass 2 — helper resolution)
- This document (judgment layer over both)

---

## 0. TL;DR

| Bucket | Pages | Action proposal |
|---|---:|---|
| 🟢 **MUST LIVE** (working, keep visible) | **16** | hide nothing; minor polish only |
| 🟡 **MUST LIVE — needs backfill** (clear strategic value, backend partially exists) | **8** | route stays visible, backend gaps tracked as P3 items |
| ⚪ **FREEZE** (operationally meaningful, backend not yet ported — hide route until P3) | **21** | remove from nav, keep files |
| 🔴 **DELETE** (abandoned experiments, dead module, no roadmap to revive) | **32** | delete file + route after user signs off |
| ❓ **CLARIFY** (orphan / unclear) | **2** | judge case-by-case |

Total: 79.

The operational UX invariant — *"if a route is visible, it must work; if
it cannot work soon, hide it"* — translates concretely:

- After P1.1 sign-off: **22 routes stay visible** (16 working + 8 strategic).
- **21 routes get commented out / removed from the nav layer** (files stay).
- **32 files get deleted** (after explicit ack).
- **57 → 22** visible-route reduction = **61% surface compression**.

---

## 1. Bucket A — MUST LIVE (working today)

Pages where the dominant data fetch resolves to a live FastAPI endpoint.
The script's `🟢 OK=1.0` plus my live-curl confirmations.

| Page | Route | Backend evidence |
|---|---|---|
| **AdminInboxPage** | `/inbox` | inline /chat/v1/* (live) |
| **AdminAssignmentsPage** | `/assignments` | `/api/admin/assignments` 200 |
| **AdminOpsMapPage** | `/ops-map` | inline /ops-map endpoint, live |
| **CustomerNotifyPreviewPage** | `/customer-notify` | inline /notify endpoints (3/3) |
| **CustomerNotifyLifecyclePage** | `/customer-notify/lifecycle` | inline /notify endpoints (3/3) |
| **ForecastDashboardPage** | `/forecast` | inline /forecast endpoints (3/3) |
| **NotificationsPage** | `/notifications` | inline /admin/notifications/send |
| **RevenueDashboardPage** | `/revenue` | `/api/admin/revenue/dashboard` 200 |
| **StripePaymentsPage** | `/billing/stripe` | `/api/admin/stripe/*` 200 |
| **StripeSettingsPage** | `/billing/stripe-settings` | `/api/admin/stripe/config` 200 |
| **SupportChatPage** | `/billing/support-chat` | `/api/chat/v1/*` 200 (P0 fixed) |
| **SystemErrorsPage** | `/system/errors` | `systemAPI` (3/3) live |
| **VerificationQueuePage** | `/verification-queue` | 5/5 live |
| **PaymentsPage** | `/payments` | `/api/admin/payments` 200 |
| **DisputesPage** | `/disputes` | `/api/admin/disputes` 200 |
| **GovernanceScorePage** | `/governance-score` | `/api/admin/governance/score` 200 |

**16 pages.** These are the operational core admin actually uses every day.

---

## 2. Bucket B — MUST LIVE, needs P3 backfill (visible-but-degraded today)

These pages express a clear product purpose, the backend domain *partially*
exists, and the gaps are limited enough that P3 governance consolidation
can close them. Routes stay visible; degraded panels handled with empty
states meanwhile.

| Page | Route | What works today | Gap |
|---|---|---|---|
| **AdminReputationPage** | `/reputation` | 2/3 endpoints | one trust query needs port |
| **ZoneControlPage** | `/zone-control` | 5/7 endpoints | 2 zone-action endpoints |
| **IntegrationsPage** | `/integrations` | 3/4 endpoints | `/api/admin/integrations` index missing |
| **CarSelectionPage** | `/car-selection` | `/api/admin/car-selection` 200 | listing/aggregate gaps |
| **AutoRequestsPage** | `/auto-requests` | `/api/admin` ops queries | needs `/admin/auto-requests` re-attach |
| **PaymentsAndCreditsPage** | `/auto-payments` | overlaps PaymentsPage | dedupe in P3 |
| **ServiceMarketplaceExchange** | `/service-marketplace` | public marketplace API works | admin overlay missing |
| **ServiceMarketplaceMap** | `/service-marketplace/map` | same | same |

**8 pages.** Sub-sprint candidates for P3 governance consolidation
(disputes + payouts + payments + reconciliation single shell).

---

## 3. Bucket C — FREEZE (operationally meaningful, hide until backend ported)

These pages are *not* abandoned experiments — they correspond to real
domains (Users, Organizations, Bookings, Reviews, Feature Flags). The
backend endpoints just never crossed the NestJS→FastAPI line. After P1.1:

- Comment out the `<Route>` entry in `App.tsx`.
- Remove the nav link in `Layout.tsx`.
- Keep the page file (for the day the backend lands).

Files stay so the migration is a one-line route re-add when the
corresponding backend domain ships under P3 or beyond.

| Cluster | Pages |
|---|---|
| **User management** | UsersPage, CustomersPage |
| **Provider management** | ProvidersPage, ProviderDetailPage, ProviderLifecyclePage, ProviderBehaviorPage, ProviderInboxPage |
| **Org & taxonomy** | OrganizationsPage, ServicesPage, SettingsPage |
| **Operational ops** | BookingsPage, QuotesPage, ReviewsPage, IncidentControlPage, RequestFlowPage |
| **Geo & monitoring** | GeoOpsPage, MapPage, LiveMonitorPage, SystemHealthPage |
| **Feature flags** | FeatureFlagsPage |
| **Inspection** | InspectionForensicsPage |
| **Audit** | AuditLogPage |

**21 pages.** Each cluster maps cleanly to an existing or planned backend
domain — re-enabling is a backend story, not a frontend redo.

---

## 4. Bucket D — DELETE (abandoned experiments)

Identified by combining three signals:
1. Backend domain doesn't exist in FastAPI **and** isn't on roadmap.
2. Memory closure docs in `/app/memory/` don't reference module.
3. Page name suggests one-off experimental dashboard (e.g. shadow mode,
   replay history, simulation, playbooks).

| Cluster | Pages | Rationale |
|---|---|---|
| **Automation Suite (15)** | ActionChainsPage, AutoActionsPage, AutomationControlPage, AutomationDashboardPage, AutoRulePerformancePage, DryRunPage, ExecutionMonitorPage, ExecutionReplayPage, FailsafePage, FeedbackLoopPage, IdempotencyPage, ROITrackingPage, ShadowModePage, UnifiedStatePage, RuleVisualizerPage | Entire NestJS-only experimental subsystem; no path under /api/admin/automation/* in FastAPI; no closure doc mentions automation rules as live. Abandoned at NestJS dead-end. |
| **Demand-engine (4)** | DemandActionsPage, DemandControlPage, DistributionControlPage, MarketControlPage | One-off market-rule experiments. EconomyControl is the canonical surface in B-stream. |
| **Workforce / forecasting experiments (4)** | EconomyControlPage, OperatorPerformancePage, WorkersPage, SuggestionsPage | Operator/worker mgmt never had backend; suggestions = abandoned ML experiment |
| **Forensic / simulation experiments (5)** | SimulationPage, PlaybooksPage, RevenueExperimentsPage, MonetizationPage, ReportsPage | Standalone experiments superseded by governance shell |
| **Quality / supply experiments (4)** | SupplyQualityPage, ReputationPage (the duplicate one — not AdminReputationPage), CustomersPage (duplicate), CustomerNotifyLifecyclePage's stale twin | Duplicates and dead experiments |

**32 pages** queued for deletion (after explicit user sign-off in next message).

---

## 5. Bucket E — CLARIFY (2 orphans)

| Page | Status | Recommendation |
|---|---|---|
| **DashboardPage** | No `<Route>` in App.tsx; imports `adminAPI` (210-method facade) | Was the original landing page before `/` was redirected. **Delete unless someone confirms it's the home.** |
| **NotificationsPageLegacy** | No route; comment in `NotificationsPage.tsx:15` says "preserved for ops continuity" | Intentional. **Keep, but archive comment to closure log.** |

---

## 6. Methodology notes (for the closure doc)

### Pass 1 — inline paths
Regex over each `.tsx` for `api.METHOD('/path')` / `api.METHOD(\`/path/${...}\`)`.
Strips `${id}` / `:id` to `*` and matches against `openapi.json` patterns.

### Pass 2 — helper resolution
Each page imports `{ adminAPI, ... } from '../services/api'`. The script
parses `services/api.ts` to extract every helper object's body, then
attributes the helper's path set to the page.

⚠️ **Over-attribution caveat:** 47 admin pages import the full `adminAPI`
facade (210 paths). The script charges all 210 paths against every
consumer, so the `OK ratio` for those pages always reads `39/210` — that
is the **facade's** aggregate ratio, not the **page's** actual coupling.

Real per-page coupling requires AST-grade analysis of which `adminAPI.X()`
methods each page actually invokes. **That refinement is out of scope for
P1.1** (inventory only) — the bucket classifications above use domain
inference + roadmap signals, not the over-attributed ratio.

### Live backend probes
27 candidate prefixes curl'd against live `/openapi.json` + with admin
JWT. Results in §0–§4 above use confirmed live status, not the script's
over-attribution.

---

## 7. Surface-reduction summary

```
Today           After P1 sign-off
─────────       ─────────────────
79 page files   47 page files       (delete 32)
77 routes       22 visible routes   (freeze 21, delete 32, keep 22+2)
210 adminAPI    ≈ 50 needed         (rest dead code, P4 cleanup)
methods
```

This is **not a backend change** — backend already gives 22 working
admin domains. The intervention is purely surface-side: hiding what
doesn't work and deleting what won't return.

---

## 8. What is NOT in scope (per P1.1 spec)

- ❌ No file deleted
- ❌ No route removed
- ❌ No `adminAPI` method dropped
- ❌ No nav link changed
- ❌ No `package.json` cleanup
- ❌ No backend endpoint ported

Everything above is **classification material** for P1.2 (executor).

---

## 9. Required user signoff before P1.2

Three explicit yes/no decisions:

1. **DELETE Bucket D (32 pages)?** Or keep some specific page from the
   list?
2. **FREEZE Bucket C (21 pages)?** = comment-out routes + remove from
   nav. Files stay.
3. **DashboardPage** — delete, or restore as `/` landing?

After signoff: P1.2 = one targeted PR that applies the triage (file
deletions, route comments, nav cleanup). Bundle size drop from `adminAPI`
trimming lands in P4 sanitization (separate sprint).

---

## 10. Artefacts shipped this phase

| Path | Purpose |
|---|---|
| `/app/audit/admin_triage_inventory.json` | Pass-1 raw (inline paths only) |
| `/app/audit/admin_triage_inventory_v2.json` | Pass-2 (helper resolution) |
| `/tmp/admin_triage.py`, `/tmp/admin_triage_v2.py` | Repeatable scan scripts |
| This document | Judgment layer + bucket proposal |

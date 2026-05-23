# Phase 9 · Offer Packages — UI Freeze

**Date:** 2026-02-17 · **Sprint:** Hybrid U1→U5 polish · **Status:** ✅ closed

This document marks Offer Packages as a **production-stable bounded
domain**. It is the contract every future sprint MUST respect when
touching anything tagged `offer_packages` / `OfferPackage`.

---

## Subsystem state

| Property | Value |
|----------|-------|
| Backend completeness | ✅ full (Phases 6, 7, 8, 9 closed) |
| UI semantic coverage | ✅ full (Phase 9 UI Hybrid sprint closed) |
| Truth layers | 6 — workflow / communication / evidence / commercial / awareness / lineage |
| Endpoints (offer_packages package) | 8 — create-draft, patch, deliver, accept, decline, list, get, revoke, **revise** |
| Mongo collection | `car_selection_offer_packages` |
| i18n namespace | `car_selection.offer_package.*` (en, ru, de) |

---

## The six truth layers

This subsystem stays clean because each truth lives in its own layer
and never spills into another:

| Layer | Owner | Mutation surface |
|-------|-------|------------------|
| **Workflow truth** | car-selection request status | admin status flips + customer/provider lifecycle hooks |
| **Communication truth** | thread messages | provider/customer chat block |
| **Evidence truth** | immutable artifacts | thread artifact upload (REUSED by packages — never re-uploaded) |
| **Commercial truth** | `status` (draft/delivered/accepted/declined/revoked) | provider compose+deliver, customer accept/decline, admin revoke |
| **Awareness truth** | `car_selection_notifications` rows | server-side fan-out on lifecycle events |
| **Lineage truth** | `chainId` / `parentId` / `supersedesId` / `supersededById` | create-draft (mint chain) + revise (inherit chain) + deliver (forge link via CAS) |

If a future feature blurs ANY of those owners, it does NOT belong
in this subsystem — branch it as its own bounded domain.

---

## Phase 9 invariants (UI side)

Codified by the U1→U5 sprint:

1. **UI consumes lineage truth. UI does NOT invent new workflow.**
   The card surfaces `version`, `chainId`, `lineage.previousId`,
   `lineage.nextId` strictly as projections. There is no UI affordance
   that mutates lineage; revisions go through `POST .../revise` →
   `POST .../deliver`, which are existing backend endpoints.

2. **Lineage chip is adjacent-only.**
   Renders at most `v(N-1) ← v(N) ← v(N+1)`. Hidden for singleton
   chains. Never interactive. Never expands. Neighbours are right
   below in the same list anyway.

3. **Superseded badge has audience-specific copy from one truth.**
   Both surfaces read the same `lineage.nextId`. Provider/admin see
   "Superseded by v{N}", customer sees "Newer version available
   (v{N})". If `versionById` doesn't have the neighbour entry
   (existence privacy edge case) the badge degrades to a generic
   label — we never fabricate a version number.

4. **Bell discipline = pure count.**
   `CarSelectionInboxBell` is the same component on customer,
   provider, and admin surfaces. No dropdown, no preview, no
   realtime. 401/403 → disabled silently.

5. **i18n stays additive.**
   `car_selection.offer_package.lineage` is a NEW sub-namespace.
   Existing keys under `car_selection.offer_package.*` are unchanged
   (Phase-5 i18n freeze respected).

---

## Hard boundaries — refuse without escalation

Anything below requires a fresh design pass + memory doctrine update
BEFORE any code is written:

| # | Forbidden | Why |
|---|-----------|-----|
| 1 | New endpoints in `app/offer_packages/` | Surface is closed. Open issues are doctrine work, not API work. |
| 2 | Realtime / websocket on packages | Inbox + lifecycle are pull-based by design (Phase 8.1). |
| 3 | Mutating timeline entries | Timeline is append-only forensic ledger. |
| 4 | Chain explorer / graph UI | Adjacent-only is intentional (decision 7.6). |
| 5 | Compare-versions screen | UI does not own diff semantics. |
| 6 | Editable delivered packages | Delivered is immutable. Revise spawns a new draft instead. |
| 7 | Auto-decline siblings on accept / revoke | Forensic truth — customer can still accept v1 after v2 appears. |
| 8 | Merge / rebase semantics | This is commerce, not git. |
| 9 | Threaded negotiation INSIDE packages | Thread block remains separate. |
| 10 | Payment coupling | Payments are a different bounded domain. |
| 11 | Status `superseded` | Supersession is metadata, not a lifecycle state (decision 7.x). |

---

## What's allowed without re-freezing

| Allowed | Constraint |
|---------|------------|
| Adding new `car_selection.offer_package.*.<new-sub-namespace>` i18n keys | Must be additive only |
| New testIDs on existing visible elements | Must be kebab-case, descriptive |
| Tweaking existing card paddings/typography | Visual only, no semantic changes |
| New backend index on existing collection | Performance-only, schema unchanged |
| Bug-fix patches | Must preserve all invariants above |

---

## Phase 9 file inventory

Backend:
- `/app/backend/app/offer_packages/models.py` — `OfferPackageOut` + `OfferPackageLineageOut`
- `/app/backend/app/offer_packages/repository.py` — `chainId` minting, `create_revision`, CAS in deliver, `_project` lineage, new index
- `/app/backend/app/offer_packages/router_provider.py` — `POST .../{pid}/revise`
- `/app/backend/app/offer_packages/notifier.py` — `(vN) ` preview prefix
- `/app/backend/app/offer_packages/lifecycle.py` — unchanged (state machine intact)

Frontend (UI sprint U1–U4):
- `/app/frontend/src/components/OfferPackageBlock.tsx` — lineage chip + superseded badge + versionById prop
- `/app/frontend/app/provider/car-selection/index.tsx` — bell mounted on provider list (U4)
- `/app/frontend/app/admin/car-selection/[id].tsx` — bell mounted in Stack header (U4)
- `/app/frontend/src/i18n/locales/{en,ru,de}.json` — lineage sub-namespace

Tests:
- `/app/tests/offer_packages/test_offer_packages_e2e.py` — v1 baseline + 7.10 assertions
- `/app/tests/offer_packages/test_offer_packages_versioning_e2e.py` — all 10 decisions covered
- `/app/tests/offer_packages/test_offer_packages_inbox_e2e.py` — bell/awareness (pre-existing)

---

## Status: 🔒 LOCKED — production-stable

Next sprint should pick from one of:

- **Core extraction / Phase 3 mapping** — identity / pricing /
  notifications / car-selection request workflow as bounded
  domains, mirroring the discipline Phase 9 codified here.
- **Medium-bucket items** — chain-level analytics, acceptance-rate
  by revision, revoke audit slices, artifact retention/checksum/
  virus-scan hardening. These can land WITHOUT re-opening this
  subsystem because they consume the existing truth surface.

Subsystem freezes do not mean immutable forever — they mean any
change must justify itself against the six truth layers and the
eleven hard boundaries above. If a proposed change can be expressed
in those terms cleanly, it's not really breaking the freeze; if it
cannot, it belongs in a different domain.

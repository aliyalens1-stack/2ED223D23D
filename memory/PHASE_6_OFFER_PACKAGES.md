# Phase 6 — Car-Selection-6 · Offer Packages

**Date:** 2026-02-17
**Scope:** backend domain expansion (mobile UI is next sprint)
**Status:** ✅ Locked. All 38 e2e assertions pass.

---

## 1. What we built and why now

After Phase 5 the subsystem had:
- **workflow truth** locked (lifecycle)
- **communication truth** locked (append-only thread)
- **evidence truth** locked (immutable artifacts)
- **vocabulary truth** locked (i18n freeze)

What was still missing: providers could *communicate* and *attach
evidence*, but they had **no way to deliver a structured commercial
result**. Generic chat attachments are a chat construct; they don't
carry price, acceptance semantics, or governance.

Phase 6 introduces **OfferPackage** — an immutable commercial
deliverable that lives in its own bounded context.

> thread ≠ deliverable · artifact ≠ offer package · workflow ≠ communication

---

## 2. Bounded context layout

```
backend/app/offer_packages/
├── __init__.py              re-exports lifecycle public surface
├── lifecycle.py             STATUSES, TERMINAL_STATUSES, ALLOWED_TRANSITIONS
├── models.py                Pydantic shapes (Create/Update/Decision/Out)
├── repository.py            data access + invariants
├── router_provider.py       /api/provider/car-selection/{rid}/offer-packages*
├── router_customer.py       /api/car-selection/requests/{rid}/offer-packages*
└── router_admin.py          /api/admin/car-selection/{rid}/offer-packages*
```

`server.py` wires the three routers right after the existing
`car_selection_thread` block, keeping a clean Phase-by-Phase ordering.

---

## 3. Lifecycle (locked)

```
draft       → delivered, revoked
delivered   → accepted, declined, revoked
accepted    → ∅   (terminal)
declined    → ∅   (terminal)
revoked     → ∅   (terminal)
```

Boundaries encoded:

- **Content is mutable only in `draft`.** The freeze is enforced in
  `repository.update_draft()` — any caller bypassing returns
  `409 OFFER_PACKAGE_FROZEN`.
- **`delivered` requires content.** A package with no title, no
  summary, and no artifacts returns `409 OFFER_PACKAGE_EMPTY_DELIVER`.
- **Customer can NEVER see drafts.** They resolve to 404 (existence
  privacy — matches the rest of the subsystem).
- **`accepted`/`declined` are commercially binding.** Admin cannot
  revoke them. The transition table simply has no out-edges.

The transition table itself does **not** encode *who* is allowed to
perform a transition — that's a router concern. Provider can only
trigger `deliver`. Customer can only trigger `accept`/`decline`.
Admin can only trigger `revoke`.

---

## 4. Data shape (`car_selection_offer_packages` collection)

```json
{
  "_id": "uuid32",
  "requestId": "<ref car_selection_requests>",
  "providerId": "<ref user>",
  "version": 1,
  "status": "draft | delivered | accepted | declined | revoked",

  "title":      "BMW X5 shortlist",
  "summary":    "Three candidates filtered to budget...",
  "priceCents": 9900,
  "currency":   "EUR",
  "artifactIds": ["<ref car_selection_artifacts>"],

  "createdAt":   "iso",
  "updatedAt":   "iso",
  "deliveredAt": "iso | null",
  "decidedAt":   "iso | null",
  "decidedBy":   "<user> | null",
  "decidedNote": "string | null",

  "timeline": [
    { "type": "created" | "status:<X>", "at": "...",
      "actorId": "...", "actorRole": "provider|customer|admin",
      "note": "...", "data": {"from": "...", "to": "..."} }
  ]
}
```

Indices:
- `(requestId, status, updatedAt -1)` — list-by-request
- `(providerId, status, updatedAt -1)` — provider "my packages"
- `(status, deliveredAt -1)` — admin backlog

---

## 5. Endpoints (10 new — all in `/openapi.json`)

### Provider · `/api/provider/car-selection/{rid}/offer-packages*`
| Method | Path | Purpose |
|--------|------|---------|
| POST   | `/`            | create draft (any subset of content) |
| GET    | `/`            | list MY packages on this request |
| GET    | `/{pid}`       | get one of mine |
| PATCH  | `/{pid}`       | edit draft — fails 409 FROZEN if non-draft |
| POST   | `/{pid}/deliver` | draft → delivered (must have content) |

### Customer · `/api/car-selection/requests/{rid}/offer-packages*`
| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/`             | list visible (delivered + decided), drafts hidden |
| GET    | `/{pid}`        | fetch one (drafts → 404) |
| POST   | `/{pid}/accept` | delivered → accepted (note?) |
| POST   | `/{pid}/decline`| delivered → declined (note?) |

### Admin · `/api/admin/car-selection/{rid}/offer-packages*`
| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/`             | list ALL packages (incl. drafts) |
| GET    | `/{pid}`        | fetch one (any status) |
| POST   | `/{pid}/revoke` | any non-terminal → revoked |

---

## 6. Canonical error codes (added to the unified envelope)

```
OFFER_PACKAGE_NOT_FOUND
OFFER_PACKAGE_FROZEN              — patch attempted on non-draft
OFFER_PACKAGE_INVALID_TRANSITION  — adjacency violation
OFFER_PACKAGE_EMPTY_DELIVER       — deliver with no content
OFFER_PACKAGE_REQUEST_TERMINAL    — parent request closed
```

All raised via the same `_err(http_status, code, message, **details)`
helper used elsewhere in the subsystem, so `prod_readiness`
middleware unwraps them onto the top-level response shape:

```json
{ "error": true, "code": "...", "message": "...", "details": {...} }
```

Frontend code can extend `mapCarSelectionError` (Phase 5) trivially
to cover these new codes — no helper changes required, just
locale strings.

---

## 7. Discipline that did NOT happen (and why)

| Tempting addition | Why rejected |
|---|---|
| `update_message`-style draft notification to customer | Drafts MUST be invisible to customer. Notifying defeats existence privacy. |
| Auto-decline siblings on accept | A customer accepting one offer is a commercial commitment to *that* offer; mass-rejecting siblings hides the audit signal. |
| In-place revisions of delivered packages | A delivered package is an audit artifact. Revisions create a new package (next sprint via `version` field — already reserved). |
| Cascade revoke on request cancel | Admins decide explicitly. Cascading hides governance intent. We surface stale packages instead. |
| Payment hook | Money flow is its own bounded context. Phase 6 only records the agreed `priceCents` at accept-time. |
| Inline thread notification on lifecycle changes | One-inbox discipline: the existing thread notifier owns the inbox surface. Plugging into it is a Phase-7 hook (mobile UI sprint). |

---

## 8. Verification

**e2e smoke test:** `/app/tests/offer_packages/test_offer_packages_e2e.py`
38 assertions, all green. Covers:

```
✓ provider create draft → status=draft, version=1
✓ patch draft, summary changes
✓ unknown artifactId → ARTIFACT_NOT_FOUND (cross-request smuggle guarded by artifacts module)
✓ deliver → status=delivered, deliveredAt stamped, timeline row written
✓ double-deliver → OFFER_PACKAGE_INVALID_TRANSITION
✓ patch after deliver → OFFER_PACKAGE_FROZEN
✓ customer sees delivered package only (drafts hidden, 404 by id)
✓ customer accept → status=accepted, decidedBy=customer, decidedNote stored
✓ decline-after-accept → OFFER_PACKAGE_INVALID_TRANSITION
✓ admin revoke-after-accept → OFFER_PACKAGE_INVALID_TRANSITION
✓ admin lists ALL incl. drafts
✓ admin revokes a draft → status=revoked
✓ empty deliver (no title/summary/artifacts) → OFFER_PACKAGE_EMPTY_DELIVER
✓ foreign RID for customer → 404 (existence privacy)
```

**lint:** `ruff` clean across `app/offer_packages/`.
**openapi:** 10 new paths registered, total openapi paths now 516
(was 506 after Phase 5).
**no regressions:** existing Car-Selection / thread / artifacts
endpoints unaffected.

---

## 9. What's next (Phase 7 candidates)

The backend is now `commercially complete` for v1. Sensible next moves:

1. **Mobile UI for Offer Packages** — Provider draft composer,
   customer accept/decline screen, admin revoke action. The hard
   part (commercial discipline, audit timeline, freeze semantics) is
   done backend-side; the mobile sprint is pure surface work.
2. **Inbox notifications** — wire the lifecycle transitions into the
   existing thread notifier projection (`delivered` → customer,
   `accepted`/`declined` → provider+admin, `revoked` →
   provider+customer). One inbox; no parallel notification surface.
3. **Versioning v2** — when a provider needs to "revise" a delivered
   package, they create a *new* package linking back via
   `supersedesId` and bumping `version`. The original stays frozen.
4. **Admin governance view** — list of all open packages across
   requests for the admin operator screen (Recharts already used in
   the admin SPA, easy add).

Recommended order: **2 → 1 → 3 → 4**. Notifications close the loop
of "deliverable produced → customer sees it"; mobile UI converts
discipline into UX; versioning is a follow-on once revision demand
appears; governance view is reporting.

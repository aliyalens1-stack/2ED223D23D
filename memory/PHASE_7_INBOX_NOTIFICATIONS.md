# Phase 7 — Offer-Package Notifications via Unified Inbox

**Date:** 2026-02-17
**Scope:** backend lifecycle → existing notification projector
**Status:** ✅ Locked. 30/30 inbox e2e assertions pass · 38/38 Phase 6 e2e regression suite still green.

---

## 1. Why this sprint (and why it had to come before mobile UI)

After Phase 6 the offer-package lifecycle existed end-to-end —
provider could deliver, customer could decide, admin could revoke.
But nobody outside the actor knew it happened in real time. A
delivery sat invisible until the recipient happened to refresh.

> delivery without awareness = dead workflow

Phase 7 closes the loop. **Without changing the lifecycle itself or
the contracts of any existing surface**, every offer-package
transition now projects into the same `car_selection_notifications`
collection that the thread already uses. The inbox endpoint
(`GET /api/car-selection/notifications/me`) already serves all three
roles — adding commercial events to it required ZERO new endpoints.

---

## 2. Discipline (encoded in code, not in convention)

| Rule | Where enforced |
|------|----------------|
| **One inbox, not two.** Commercial events live in the same collection (`car_selection_notifications`) as message + lifecycle events. | `notifier.py` writes via `db[NOTIFICATIONS]` directly — that's the only collection touched. |
| **No fake thread messages.** Offer-package events MUST NOT create thread message rows. | `notifier.py` writes only to `NOTIFICATIONS`. The Phase 7 e2e asserts the thread stays at `total=0` after a full deliver/accept/decline/revoke cycle. |
| **Actor never self-notifies.** | `project_offer_package_event` skips rows whose `recipientId == actor_id`. Admin sentinel (`__admin__`) is a flat queue and never equals an individual actor id. |
| **Drafts are silent.** Creating / patching a draft generates ZERO notifications — drafts are invisible to the customer, so notifying anyone leaks the draft's existence. | `FANOUT` table has no entry for `created`/`patched`; only `delivered / accepted / declined / revoked` produce rows. |
| **Notifications are projection, not source of truth.** | Hook runs AFTER the lifecycle write commits. Failure is logged and swallowed at two layers (notifier internal try, repo outer try). A flaky insert cannot roll back a committed commercial decision. |
| **Event types are canonical and forward-stable.** Keys: `offer_package.delivered`, `offer_package.accepted`, `offer_package.declined`, `offer_package.revoked`. | `EVENT_TYPE` dict in `notifier.py`. Adding a new transition requires explicitly extending this map. |
| **`messageId` is always None on these rows.** Lets UI key off `eventType` to route to the offer-package detail (not a thread anchor). | `notifier.py` hard-codes `messageId: None`. |

---

## 3. Fan-out table (locked)

```
transition       targets
─────────────────────────────────────────
delivered    →   customer  +  admin sentinel
accepted     →   provider  +  admin sentinel
declined     →   provider  +  admin sentinel
revoked      →   provider  +  customer     (admin actor — no self-notify)
```

Mirrors the user-supplied spec verbatim. Matches the existing
`_project_message_notifications` rule shape ("notify everyone in the
triad except the actor").

---

## 4. Row shape (forward contract)

```json
{
  "id": "uuid32",
  "recipientId": "<userId | __admin__>",
  "recipientRole": "customer | provider | admin",
  "requestId": "<car_selection_requests._id>",
  "eventType": "offer_package.delivered | accepted | declined | revoked",
  "messageId": null,                ← never a thread anchor
  "offerPackageId": "<car_selection_offer_packages._id>",
  "actorRole": "customer | provider | admin",
  "preview": "<package title, ≤140 chars>",
  "createdAt": "iso",
  "readAt": null | "iso"
}
```

`offerPackageId` is the **new field** vs. existing thread / lifecycle
rows. Existing fields keep their semantics so the inbox UI doesn't
need branch logic on the projection source — it just keys off
`eventType` to decide what to render and where to route.

---

## 5. Files

```
ADDED   /app/backend/app/offer_packages/notifier.py                project_offer_package_event() + FANOUT + EVENT_TYPE
CHANGED /app/backend/app/offer_packages/repository.py              apply_transition() now hooks notifier after CAS commit
ADDED   /app/tests/offer_packages/test_offer_packages_inbox_e2e.py 30 assertions covering fan-out, no-pollution, draft-silence
```

`server.py` — unchanged. No new endpoints. No new collections. The
inbox endpoint already serves these rows because they live in the
same collection it already reads from.

---

## 6. Verification

| Suite | Result |
|-------|--------|
| `test_offer_packages_inbox_e2e.py` (Phase 7) | **30/30 OK ✅** |
| `test_offer_packages_e2e.py` (Phase 6 regression) | **38/38 OK ✅** |
| `ruff` on `app/offer_packages/` | clean |
| Backend supervisor | RUNNING, db connected |

Inbox spot-checks during the run:

```
after deliver:  cust={'offer_package.delivered': 1}
                prov={}                                  ← actor, no self-notify
                admin={'offer_package.delivered': 1}

after accept:   cust=…(prior delivered only)…
                prov={'offer_package.accepted': 1}
                admin={'offer_package.accepted': 1, 'offer_package.delivered': 1}

after revoke:   cust={'offer_package.revoked': 1, ...prior}
                prov={'offer_package.revoked': 1}
                admin=…(no revoke — admin is actor)…
```

---

## 7. What's NOT in Phase 7 (intentionally)

| Tempting addition | Why deferred |
|---|---|
| Realtime push (websocket / SSE) | Outside this bounded context. Current model is poll-based — the inbox endpoint already serves; pushing is a transport upgrade, not a domain change. |
| Email / FCM fan-out | Same — would couple the projector to an integration. Better as a downstream subscriber on the notification collection. |
| Aggregation digests ("3 packages waiting") | UI concern; the inbox row stream is the raw truth. |
| Notification for `draft` lifecycle events | Drafts are invisible to customers; notifying anyone would leak existence. Rejected by design. |
| Sibling auto-decline notifications | Phase 6 deliberately doesn't auto-decline; therefore there's nothing to notify about. |

---

## 8. Subsystem status after Phase 7

The Car-Selection bounded context now has 5 locked truth-layers:

```
car_selection            → workflow truth
car_selection_thread     → communication truth
artifacts                → evidence truth
offer_packages           → commercial truth
notifications (shared)   → awareness truth          ← Phase 7 wired
```

Five orthogonal truths, one projection collection, one inbox surface.
This is exactly the model the user's brief asked for:

> Правильно: offer package lifecycle → existing notification projector
> Неправильно: separate commercial inbox

We picked the right side.

---

## 9. Recommended next sprint

**Phase 8 — Mobile UI for Offer Packages.**

The backend is now `commercially complete with awareness`. The
remaining gap is purely surface:

* **Provider** — draft composer (title + summary + price + currency +
  artifact picker reusing Phase 5 picker), list of own packages on a
  request, deliver button, frozen-state read-only view.
* **Customer** — list of delivered/decided packages on a request,
  detail view with `Accept` / `Decline` (decision modal with
  optional note), restrained terminal state copy.
* **Admin** — list of all packages per request, revoke action, badge
  on the existing CS request detail when packages exist.
* **Inbox row rendering** — extend the inbox screen to handle the
  new `eventType: offer_package.*` keys (route to package detail,
  show restrained labels — Phase 5 i18n freeze rules apply, so
  `mapCarSelectionError` and the `car_selection.*` namespace
  pattern extend straight to a new `car_selection.offer_package.*`
  group).

Discipline to preserve in mobile UI:
- **provider** UI is a *draft composer*, not a chat editor;
- **customer** UI is a *commercial decision surface*, not a chat;
- **admin** UI is a *governance action*, not a moderation tool;
- no kanban, no inline artifact editing, no in-thread negotiation;
- copy goes through `car_selection.*` i18n namespace (extend, don't
  duplicate).

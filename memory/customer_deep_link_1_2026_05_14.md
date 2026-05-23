# Customer-Deep-Link-1 — Semantic landing continuity

**Date:** 2026-05-14
**Sprint name:** Customer-Deep-Link-1
**Closes:** the gap between "something happened" and "customer lands in
the correct epistemic surface." Notifications now carry not only WHAT
to say but WHERE the customer's attention should resolve.

---

## Discipline (Roman, 2026-05-14)

> "Без deep-link layer у вас получится: push → generic app open → customer
> manually searches context. И narrative continuity ломается."

Deep-Link-1 closes that gap with the same architectural rules we've
been holding since Notify-1:

1. **Grammar-owned routing.** Deep-link map lives in
   `customer-grammar/`, not in transport. Transports resolve a
   `(surface, params)` tuple — they don't make semantic destination
   decisions.
2. **Locale-invariant.** Landing surfaces are an epistemic concept,
   not a linguistic one. There is no per-language map.
3. **Transport-independent destinations.** Payload is
   `{ surface, params, routes: { mobile, web } }`. Mobile, web, email
   CTA, future WhatsApp resolve the same surface differently.
4. **Forbidden-route enforced at routing stage.** Same 5 prefixes
   (`ocr.`, `correlation.`, `evidence.`, `internal.`, `suspicion.`)
   that are denied by the notification kernel are also denied by the
   deep-link kernel — they NEVER resolve to any destination.
5. **Checksum-namespaced.** `deep_links` is a first-class namespace
   in `projection-checksums.json`. Drift is localised — a deep-link
   rotation cannot masquerade as notification copy drift.

---

## Surface map (Roman's spec, verbatim)

| Event kind             | Surface          | Rationale (epistemic) |
|------------------------|------------------|------------------------|
| `inspection.started`   | **continuity**       | state of NOW — inspector on site |
| `report.submitted`     | **report-cognition** | interpreted final understanding |
| `item.flagged_critical`| **timeline**         | granular event in process history |
| `item.flagged_warning` | **timeline**         | granular event in process history |

### Routes per surface

| Surface          | Mobile (Expo Router) | Web (Vite SPA) |
|------------------|----------------------|----------------|
| continuity       | `/customer/inspection/{jobId}/continuity` | identical |
| timeline         | `/customer/inspection/{jobId}/timeline` (+`?focus={itemId}`) | identical |
| report-cognition | `/customer/inspection/{jobId}/cognition`   | identical |

SMS transport ignores `routes` by design — SMS carries no URLs in
Notify-1/2/3. Email CTAs reuse the web route.

---

## Files

| Path | Change |
|---|---|
| `frontend/src/customer-grammar/deep-links.json` | **NEW** — canonical surface map, route templates, params required/optional. The single source of truth. |
| `frontend/src/customer-grammar/deep-links.ts`   | **NEW** — pure TS `resolveDeepLink(eventType, metadata)` resolver. Locale-invariant. Re-exports `isForbiddenRoute` so deep-link and notification kernels share one guard. |
| `frontend/src/customer-grammar/types.ts`        | `NotificationDeepLinkKind` rotated to `'continuity' \| 'timeline' \| 'report-cognition'`. |
| `frontend/src/customer-grammar/narrative.ts`    | `NOTIFICATION_DEEP_LINK` no longer hardcoded — loaded from `deep-links.json`. Single source. |
| `frontend/scripts/check-projection-parity.mjs`  | **I13 invariant** added (I13a/b/c/d/e). 13 invariants total. Mirror also reads from `deep-links.json` so the script can't drift from the kernel. |
| `frontend/scripts/check-projection-checksum.mjs` | **`deep_links` namespace** added. Single hash over `(table, fixture resolutions)`. Brings total namespaces to 5: `timeline` + `notifications.{push,email,sms}` + `deep_links`. |
| `frontend/src/customer-grammar/projection-checksums.json` | Regenerated under new namespace shape AND new notification deepLinkKind rotation (9 notification hashes + 1 deep_links hash refreshed). |
| `backend/app/notifications/customer_kernel.py`  | `_load_deep_links()`, `SURFACES`, `EVENT_TO_SURFACE`, `ROUTES_TABLE`, `surface_for()`, `resolve_deep_link()`. `NOTIFICATION_DEEP_LINK` now mirrors `EVENT_TO_SURFACE` (one source). |
| `backend/app/notifications/audit.py`            | `project_and_audit` now calls `resolve_deep_link(kind, metadata)` once per batch and stores the resolved payload as `deepLink` on every audit row. `synthesize_preview` returns the same payload at the top level (uses synthetic `jobId=preview-job`/`itemId=preview-item`). |
| `backend/app/notifications/customer_pipeline.py`| Meta endpoint now exposes the full `deepLink` table (surfaces, eventToSurface, paramsRequired, paramsOptional, routes) so the admin UI can render its legend dynamically. |
| `backend/tests/test_customer_notify.py`         | Allowed deepLink set updated to `{continuity, timeline, report-cognition}`. |
| `backend/tests/test_customer_notify_2.py`       | `(kind, lang, deep_link)` parametrisation rotated. **5 new tests** for deep-link payload, focus-token binding, forbidden-route deep-link denial, and meta endpoint shape. |

---

## I13 invariants (parity script)

| ID  | Asserts |
|-----|---|
| I13a | Every notification-allowlisted kind has a surface mapping. (Set equality between `NOTIFICATION_DEEP_LINK.keys()` and `deep-links.json#event_to_surface.keys()`.) |
| I13b | Every surface value is a member of the declared surfaces list. |
| I13c | Every surface has routes for BOTH `mobile` AND `web`. |
| I13d | Route templates reference ONLY declared required params (no rogue `{userId}` etc.). |
| I13e | Forbidden-route events (ocr./correlation./evidence./internal./suspicion.) NEVER appear in `event_to_surface`. |

---

## Verification

```
$ yarn grammar:check
[lexicon]  OK — locales=[en,de,ru], strings=240, violations=0
[parity]   OK — locales=[en,de,ru], channels=[push,email,sms],
                events=20, rendered=13, dropped=7, notified=4,
                forbidden_routed=6, surfaces=3, invariants=13, violations=0
[checksum] OK — namespaces=[timeline, notifications.{push,email,sms}, deep_links],
                drifts=0

$ pytest backend/tests/test_customer_notify.py
180 passed (kernel parity)

$ pytest backend/tests/test_customer_notify_2.py
29 passed (24 Notify-2 + 5 Deep-Link-1), 1 skipped

TOTAL: 208 passed, 1 skipped
```

### Live API smoke

```
GET /api/admin/customer-notify/meta
→ {
    "deepLink": {
      "surfaces": ["continuity", "timeline", "report-cognition"],
      "eventToSurface": {
        "inspection.started": "continuity",
        "report.submitted": "report-cognition",
        "item.flagged_critical": "timeline",
        "item.flagged_warning": "timeline"
      },
      "routes": { ... }
    },
    ...
  }

POST /api/admin/customer-notify/preview {"kind":"item.flagged_critical","lang":"en"}
→ {
    ...,
    "deepLink": {
      "surface": "timeline",
      "params": { "jobId": "preview-job", "itemId": "preview-item" },
      "routes": {
        "mobile": "/customer/inspection/preview-job/timeline?focus=preview-item",
        "web":    "/customer/inspection/preview-job/timeline?focus=preview-item"
      }
    }
  }
```

---

## What is now structurally impossible

1. **A transport making a semantic destination decision.** Push/email/sms
   receive a resolved `(surface, params, routes)` payload; they cannot
   route off-policy without it being a deep-link kernel change.
2. **Drift between mobile-route and web-route for the same surface.**
   Both come from one template in `deep-links.json`.
3. **A forbidden-route event accidentally resolving to a destination.**
   I13e + Python `is_forbidden_route` guard at the top of
   `resolve_deep_link`.
4. **A semantic drift hiding under copy drift.** The `deep_links`
   namespace is checksum-tracked separately.
5. **Deep-link rotation without parity-test failure.** I13a/b/c/d
   immediately fail if any of the four kinds, surfaces, routes, or
   tokens change in a way that breaks invariants.

---

## What is now possible

1. **Coherent landing.** Tap on `inspection.started` push → land on
   continuity. Tap on `report.submitted` email → land on report-cognition.
   Tap on `item.flagged_critical` push with `itemId` → land on timeline
   with the right event focused.
2. **Adding a new transport** is still a one-line change — the new
   transport reads `payload.routes` and resolves its own concrete URL.
3. **Adding a new surface** is one entry in `deep-links.json` +
   one route template. Parity test validates structural correctness;
   checksum regen captures the semantic change for review.

---

## Order preserved

```
Notify-1     ✅ grammar kernel + lexicon/parity/checksum
Notify-2     ✅ dry-run audit pipeline (projection without send)
Notify-2.5   ✅ admin observability surface
Deep-Link-1  ✅ semantic landing continuity         ← THIS
Notify-3     → real transport adapters (push/email/sms)
Notify-4     → delivery lifecycle (retries, bounces, GDPR)
```

Customer-Deep-Link-1 is **done**. The chain is now complete:

> event  →  projected narrative  →  projected destination  →  audited
> →  observable  →  (Notify-3) transport send  →  customer lands in
> coherent surface

This is no longer a notification feature set. It is a
**policy-controlled customer continuity infrastructure**.

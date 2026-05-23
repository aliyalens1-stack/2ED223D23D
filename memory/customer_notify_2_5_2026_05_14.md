# Customer-Notify-2.5 — Admin Notification Preview UI

**Date:** 2026-05-14
**Sprint name:** Customer-Notify-2.5
**Closes:** the observability gap between Notify-2 (audit pipeline)
and Notify-3 (real send adapters). Notifications are no longer
"invisible until they go out" — admin can inspect every projected
(event × channel × locale × recipient) tuple before any transport is
unlocked.

---

## Discipline (Roman, 2026-05-14)

> "Реальные send adapters — это irreversible complexity multiplier.
> Архитектурно вы готовы. Но product-wise у вас ещё нет notification
> observability surface. А значит вы будете отправлять вслепую."

Notify-2.5 closes that gap. Observability before automation. Same
rule we held through the entire UX-4 cycle:

```
semantics → observability → automation → scale
```

Notify-3 is now a **transport adapter flip**, not a new subsystem.

---

## Surfaces

```
backend
    /api/admin/customer-notify/meta      ← NEW (Notify-2.5)
    /api/admin/customer-notify/preview   ← Notify-2
    /api/admin/customer-notify/audit     ← Notify-2
    /api/admin/customer-notify/project   ← Notify-2

admin SPA
    /api/admin-panel/customer-notify     ← NEW page (Notify-2.5)
      • Projection Provenance card
      • Triple-Channel Preview card
      • Forbidden-Route Inspector card
      • "Would Send" Timeline (audit feed)
```

All endpoints reused — no new write paths. The UI is a pure viewer.

---

## Files

| Path | Change |
|---|---|
| `backend/app/notifications/customer_pipeline.py` | `+/api/admin/customer-notify/meta`. Returns: `allowedKinds`, `forbiddenRoutePrefixes`, `supportedLangs`, `supportedChannels`, `deepLinkMap`, `projection.{policyVersion, policyFile, generatedAt, namespaces, checksums}`, `policyDoc`, `dryRunOnly: true`. SHA-12 of `projection-checksums.json` is the policy version. |
| `admin/src/pages/CustomerNotifyPreviewPage.tsx` | **NEW** — 4-section observability surface. ~480 lines, no external deps. Uses existing axios instance + admin token. |
| `admin/src/App.tsx` | Mount `customer-notify` route, lazy-loaded. |
| `admin/src/components/Layout.tsx` | Nav entry under ANALYTICS section: `🔔 Customer Notify (preview)`. |
| `memory/customer_notify_2_5_2026_05_14.md` | This document. |

---

## UI sections (Roman's spec, point by point)

### 1. Projection Provenance block (Roman pt 3)

Always-visible header card with:

- `DRY RUN ONLY` pill — invariant badge
- `policy v<sha12>` — first 12 chars of SHA-256 over the checksums file
- `<N> namespaces` — count of namespace keys in checksums (currently 2: `timeline`, `notifications`)
- `regenerated <date>` — when checksum baseline was last refreshed
- Policy file path (`frontend/src/customer-grammar/projection-checksums.json`)
- Doc path (`memory/customer_notify_2_2026_05_14.md`)
- Namespace list (`timeline · notifications`)

This is the "this is the policy snapshot you're looking at" anchor.

### 2. Triple-channel comparison card (Roman pt 1)

- Two selects: `Event` (4 allowlisted kinds), `Locale` (en/de/ru)
- Three cards side-by-side: PUSH · EMAIL · SMS
- Each card shows:
  - Channel header + `DRY-RUN` pill
  - Title (or `(no title — SMS carrier shape)` for sms)
  - Body
  - `deepLink`, `lang`, `shape: title+body | body-only`

Renders the kernel's projection deterministically. The same data the
real send adapter would consume in Notify-3.

### 3. Forbidden-route inspector (Roman pt 2)

- Free-text `eventType` input (default `ocr.vin_detected` for the
  obvious demo)
- Reactive verdict:
  - `FORBIDDEN ROUTE` (red) + `matched prefix: ocr.`
  - `ALLOWED` (green) + "on customer notification allowlist"
  - `NOT ALLOWLISTED` (neutral) + "not on customer notification
    allowlist (may still be on timeline allowlist)"
- Reference legend below: full list of 5 forbidden prefixes + 4 allowed
  kinds, colour-coded.

This makes the route-stage policy a visible, inspectable subsystem.
Future ops debugging:

> "Why didn't this push fire?"
> → paste eventType → instantly see verdict + matched prefix.

### 4. "Would Send" timeline (Roman pt 4)

- Filter by `kind` and `channel`
- Last 100 audit rows from `notification_projection_audit`
- Each row shows:
  - timestamp
  - kind (blue, monospace)
  - channel (pill)
  - lang
  - recipient (truncated to first 12 chars)
  - title + body + `deepLink: …` + `source: <timelineId>`
  - `DRY` pill + `not sent` indicator

These are projected notifications. Even with `dryRun=true` /
`sentAt=null`, every prospective customer interruption is visible.

---

## Provenance shown for every row

For each card section AND for each audit row:

- **eventType** (kind)
- **locale**
- **channel**
- **deepLinkKind**
- **sourceTimelineId**
- **policyVersion** (in the top-level provenance card)
- **dryRun** badge

Together these form Roman's "projection provenance block": the
grammar layer is now an *inspectable subsystem*, not an opaque
pipeline.

---

## Verification

```
$ curl /api/admin/customer-notify/meta (with admin JWT)
→ {
    "allowedKinds": ["inspection.started", "item.flagged_critical",
                     "item.flagged_warning", "report.submitted"],
    "forbiddenRoutePrefixes": ["ocr.", "correlation.", "evidence.",
                               "internal.", "suspicion."],
    "supportedLangs": ["en", "de", "ru"],
    "supportedChannels": ["push", "email", "sms"],
    "deepLinkMap": { "inspection.started": "timeline", ... },
    "projection": {
      "policyVersion": "0d4131657472",
      "policyFile":   "frontend/src/customer-grammar/projection-checksums.json",
      "generatedAt":  "2026-05-14T23:10:37.101Z",
      "namespaces":   ["timeline", "notifications"]
    },
    "dryRunOnly": true
  }

$ playwright /api/admin-panel/customer-notify
  → 3 channel cards present
  → forbidden verdict for ocr.vin_detected
  → sms title-null indicator visible
  → provenance DRY-RUN badge visible
  → push body = "Your inspection has begun." (kernel output verbatim)
  → ALL CHECKS PASSED
```

---

## What is now possible

1. **Pre-send copy review** — admin opens the page, scans 4 kinds × 3
   langs × 3 channels = 36 payloads in seconds.
2. **Route policy debugging** — paste any eventType, immediately see
   whether it would be dropped at routing and which prefix matched.
3. **Real-time audit feed** — every time `emit_event` fires a
   customer-allowed kind, the audit row appears in the timeline.
4. **Pre-Notify-3 sign-off surface** — admin can flip `dryRun=false`
   only after manual review of N production rows.

## What is now structurally impossible

1. Pushing a notification feature into production without an admin
   surface to inspect it.
2. Notify-3 (real send) being deployed before someone signs off on
   the actual rendered copy for each (kind, channel, locale).
3. A new forbidden prefix being added to the kernel without showing
   up automatically in the UI legend (the UI reads from `/meta`).
4. The policy version drift going unnoticed — the provenance card
   shows it on every page load.

---

## What we deliberately did NOT add

- Manual "send now" button. **Out of scope** until Notify-3.
- Recipient-level overrides / opt-out UI. Future work.
- Bulk reload / export of audit. Existing JSON endpoint suffices.
- Time-range graphs. Premature.

---

## Order preserved

```
Notify-1   ✅ grammar kernel + lexicon/parity/checksum
Notify-2   ✅ dry-run audit pipeline (projection without send)
Notify-2.5 ✅ admin observability surface  ← THIS
Notify-3   → real transport adapters (push/email/sms)
Notify-4   → delivery lifecycle (retries, bounces, GDPR)
```

Notify-2.5 is **done**. The customer narrative kernel is now:

> a fully observable, policy-controlled customer interruption
> infrastructure, ready to flip on real transports one channel at a time.

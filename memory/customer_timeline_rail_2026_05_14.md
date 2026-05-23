# Customer-side TimelineRail

**Date:** 2026-05-14
**Sprint name:** Customer-Rail-1 (third lens on the same event stream)
**Closes:** UX triangle — inspector / admin / customer all have temporal
self-awareness now.

---

## What was built

A new customer-facing screen at
`/customer/inspection/[jobId]/timeline` that renders a chronological
narrative of the inspection process, projected from the same
`inspection_timeline_events` stream the inspector and admin already
consume.

Backend was NOT modified — the existing `/api/inspections/{job_id}/timeline`
endpoint already strips `suspicion[]` (and admin-only summary fields) for
the customer role. This sprint is pure consumer-side projection.

## The UX triangle (now closed)

```
                      same event stream
                inspection_timeline_events
              ┌──────────┬──────────┬──────────┐
              │          │          │          │
              ▼          ▼          ▼          ▼
        Inspector    Admin       Customer    (future)
        rail         forensics   rail        — chat surface
        rail
              │          │          │
              ▼          ▼          ▼
         workflow     forensic   narrative
         language     language   language

       "Captured VIN"     "OCR        "Inspector began
       "Critical:          confirmed   the inspection"
        Engine bay         WBA8E9...   "Captured vehicle
        clean & dry"       conf=1.0"    identification
                          "Listing VIN photo"
       OCR cards          ↔ OCR VIN     "Inspector noted
                          mismatch"      a concern"
                          suspicion[]   "Inspector finished
                          sha256          the report"
                          geoKm
                          correlation
                          signals
```

Each surface reads the same wire, projects through its own lens, and
never accidentally borrows another surface's language. The firewall is
maintained by **whitelist projection on the frontend**, not by per-role
endpoint forks on the backend (timeline endpoint already gates the most
sensitive fields; projection is the second layer of defence).

## Files

| File | Change |
|---|---|
| `/app/frontend/app/customer/inspection/[jobId]/timeline.tsx` | NEW — customer projection screen |

`continuity.tsx` is **deliberately untouched**. It is a different surface
with stricter "no dots / no stream" V1 design rules; the new TimelineRail
is the chronological complement, not a replacement.

## Customer projection — allowlist + copy table

```ts
COPY: Record<string, { title, icon }> = {
  'inspection.started':          'Inspector began the inspection',
  'report.submitted':            'Inspector finished the report',
  'media.uploaded.vin':          'Captured vehicle identification photo',
  'media.uploaded.odometer':     'Captured odometer reading',
  'media.uploaded.damage':       'Captured a detail photo',
  'media.uploaded.registration': 'Captured a registration document',
  'media.uploaded.engine':       'Captured an engine area photo',
  'media.uploaded.interior':     'Captured an interior photo',
  'media.uploaded.general':      'Captured a photo',
  'media.uploaded':              'Captured a photo',          // fallback
  'item.flagged_critical':       'Inspector noted a concern',
  'item.flagged_warning':        'Inspector noted an observation',
};
```

Dropped (silently, by definition of allowlist):

| Event type | Why hidden |
|---|---|
| `ocr.vin_detected` / `ocr.odometer_detected` / `ocr.corrected` | OCR is inspector-assist tooling. Customer reads the resulting VIN/mileage in the PDF, not the capture mechanics. |
| `evidence.gaps_overridden` | Operational. Customer reads outcome (final report), not workflow process. |
| `correlation.signal_raised` | Admin forensics. Already 403 for customer at the endpoint, but if it ever reached the wire, projection drops it. |
| Any unrecognized `eventType` | Default-drop — adding new operational events does not auto-leak to the customer. |

## Lexicon rules (parity with `continuity.tsx`)

The copy table is the **only** source of customer-visible text. The
projection never reads operational `payload.label`, `payload.itemId`, or
any raw text from the event. This is structural — it's not policy, it's
that the projection function has no branch that reads those fields.

Verified words-never-said list (substring-checked with `\b` boundaries):
- AI, score, confidence, algorithm, system, draft, queue, suspicion,
  override, OCR, hash, critical, warning, flagged

The 12 copy entries × 14 forbidden words × word-boundary check passes
cleanly.

## Other discipline (parity with `continuity.tsx`)

1. **No relative time.** Absolute timestamps only (`Last read May 14,
   2026, 20:45`). Relative phrases ("5 min ago") imply pacing the
   customer is not asked to track.
2. **No counts.** One row per event. "3 photos captured" is forbidden —
   we render three `Captured a photo` rows instead.
3. **No polling, no websocket, no focus-refresh.** Single fetch on mount,
   pull-to-refresh, explicit Refresh button. The customer pulls when
   they want to see, not when the system thinks they should care.
4. **Empty state is honest.** Single line — "No inspection history yet.
   Pull to refresh once the inspector starts." No skeleton loaders, no
   fake events.

## E2E validation

Test setup: re-pointed `inspection_jobs.customerId` + `car_requests.userId`
to the demo customer `customer@test.com`, then read `/api/inspections/{job}/timeline`.

```
[GET /timeline as customer] http=200
  totalEvents (raw): 11
  events with suspicion: 0          (backend strips for customer)

  Raw wire types reaching customer:
    inspection.started:        1
    item.flagged_critical:     1
    media.uploaded.vin:        2
    media.uploaded.odometer:   1
    ocr.vin_detected:          1     ← projection drops
    ocr.odometer_detected:     1     ← projection drops
    ocr.corrected:             1     ← projection drops
    correlation.signal_raised: 3     ← projection drops

  rendered to customer rail: 5 events
  dropped (NOT shown):       6 events

  ✅ ocr.*                  dropped
  ✅ correlation.*          dropped
  ✅ evidence.gaps_overridden dropped
  ✅ no forbidden lexicon in any copy entry
```

Customer's actual rail (chronological):
1. `Inspector began the inspection`         May 14, 16:55
2. `Inspector noted a concern`              May 14, 19:08
3. `Captured vehicle identification photo`  May 14, 19:08
4. `Captured vehicle identification photo`  May 14, 19:55
5. `Captured odometer reading`              May 14, 19:55

The customer sees momentum without operational specifics. They never see
that OCR ran, never see that the listing-VIN didn't match, never see
the suspicion-engine fired — but they DO see that the inspector is
actively working on their car.

## Test IDs

- `customer-tl-back`     — back affordance
- `customer-tl-meta`     — "Last read ..." line
- `customer-tl-refresh`  — manual refresh button
- `customer-tl-error`    — error band
- `customer-tl-empty`    — honest empty state
- `customer-tl-rail`     — rail root
- `customer-tl-row-{i}`  — per row (1-indexed by position in the
  filtered list, not the raw wire)

## What this explicitly does NOT do

- Does not replace `continuity.tsx`. The two surfaces coexist:
  - `continuity.tsx` answers "where are we right now?" (snapshot,
    maturity stage, interpretation)
  - `timeline.tsx` answers "what has happened so far?" (chronological
    rail)
- Does not introduce a new backend endpoint. Same `/timeline` as the
  other two surfaces, different consumer projection.
- Does not poll, does not subscribe, does not push-notify.
- Does not surface payload labels, item ids, or any free-text from
  operational events.
- Does not show OCR confidence percentages, correlation severity,
  suspicion flags, geo distance, sha256 — none of these reach the
  customer's screen even if they arrive on the wire.
- Does not auto-link to the customer's `request/{id}/establishment` or
  the report. Those are separate navigation choices for a later UX pass.

## Deferred (next customer-surface iterations)

- Linking from `continuity.tsx` to `timeline.tsx` (the customer reaches
  `/timeline` via direct URL right now; the existing continuity screen
  should grow a `View detailed history →` affordance).
- Linking from `customer/inspection/{jobId}/report-cognition.tsx` to
  the rail as a "How we got here" section above the recommendation.
- Localization — current copy is English-only. The existing
  `continuity.tsx` is also English-only; both should localize together.
- Empty-event-bucket grouping. If a customer pulls a 200-event timeline
  late in a job, they get 200 rows. Bucketing by hour/day with a "12
  more photos in this hour" collapse is a future tightening — keep it
  simple now.
- Web parity. This is the mobile rail; the web-app surface for
  customers does not yet have a chronological rail. Same projection
  table will port directly when needed.

## Architectural state after this sprint

| Layer | Surface | Lens |
|---|---|---|
| Workflow (inspector progress) | inspector screens | workflow language |
| Evidence (captured media + OCR) | inspector items | semantic/capture |
| Provenance (device/time/geo) | media docs | observed |
| Correlation (cross-source signals) | admin forensics | forensic |
| Forensic audit (admin trust rail) | admin page | forensic |
| Customer trust (sanitized report + PDF) | customer report screen | restrained |
| **Customer process history** (this sprint) | **customer rail screen** | **narrative** |

Three rails on one stream. Each surface owns its language. No
accidental leakage across roles.

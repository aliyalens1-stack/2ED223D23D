# UX-4D — Inspector TimelineRail

**Date:** 2026-05-14
**Surface:** `/app/frontend/app/inspector/inspection/[jobId].tsx`
**Backend:** no changes — reuses existing `/api/inspections/{job}/timeline` endpoint
(UX-4B). Pure consumer-side projection.

---

## Architectural premise

The same event stream — `inspection_timeline_events` — is consumed by two
surfaces with fundamentally different operational purposes:

| Surface           | Lens             | Goal                              |
|-------------------|------------------|-----------------------------------|
| Admin forensics   | suspicion        | trust scoring, fraud investigation |
| Inspector rail    | workflow         | momentum, continuity, memory      |

This step adds the **inspector lens** without forking the data layer. The
suspicion / provenance.sha256 / geoDistanceFromJobKm fields remain on the
wire (the backend gates customer access, but inspector role gets the full
shape because they need to know what their own actions produced). The
frontend projection deliberately treats those fields as opaque — there is
no code path in the inspector UI that reads them.

**This is the architectural firewall**: one stream, two surfaces, no shared
visual idioms. Inspector never gets a "trust score" or "suspicion flag",
even though the data exists.

## Event projection (`prettifyEvent`)

```
inspection.started        → ▶  "Inspection started"
media.uploaded.<ctx>      → 📸 "Captured <ctx-human>"
item.flagged_critical     → 🔴 "Critical: <label>"
item.flagged_warning      → ⚠  "Warning: <label>"
evidence.gaps_overridden  → ✋ "Acknowledged N soft gap(s)"
report.submitted          → ✓  "Report submitted"
<unknown>                 → •  raw eventType (no leakage)
```

`<ctx-human>` map: `vin → VIN`, `odometer → odometer`, `damage → damage`,
`registration → registration`, `engine → engine`, `interior → interior`,
`general → photo`. Unknown contexts pass through as-is.

## UI behaviour

- **Mounted between** progress header card and section navigator. Same
  vertical column as everything else — does not introduce a new lane.
- **Collapsed by default**:
  - Single row with most-recent event icon + title + meta line
    (`Activity · N · 2m ago`)
  - Chevron-down affordance
- **Expanded** (tap to toggle):
  - Vertical rail with axis dots + connecting line
  - Last **12** events, reverse-chronological (newest at top)
  - Each row: icon (toned), title (single-line), relative time
  - No raw timestamps — only `just now / 1m / 5h / yesterday / 3d`
- **Relative time** ticks every 60s via a `setInterval(setNow, 60_000)`.
- **Refetch cadence**: same as `/evidence-gaps` — on `report` mutation
  (PATCH item, POST media, submit). No polling.

## Test IDs

- `insp-tl-rail`              — root card
- `insp-tl-toggle`             — header tap target (collapse/expand)
- `insp-tl-body`               — expanded list container
- `insp-tl-event-<eventType>`  — one per row (e.g. `insp-tl-event-media.uploaded.vin`)

## Validation

Live e2e against seeded `inspecting` job, after one `PATCH critical` and
one `POST media (vin)`:

```
[timeline] totalEvents=3 suspicionCount=1
=== Projected through inspector workflow lens ===
  ▶  Inspection started        (17:04:45 UTC)
  🔴  Critical: Engine bay clean & dry (19:08:48 UTC)
  📸  Captured VIN              (19:08:48 UTC)
```

Backend payload for the VIN upload contained `suspicion=1` and `sha256`.
The inspector projection rendered exactly the icon + title — no suspicion
chip, no hash, no geo. Firewall verified.

## What this closes

UX-4 navigation hierarchy is now temporally complete:

| Axis        | Status                    |
|-------------|---------------------------|
| Spatial     | ✅ section rollups (UX-4C step 2) |
| Semantic    | ✅ inline item gaps + header chips (UX-4C step 1) |
| Temporal    | ✅ TimelineRail (this) — workflow lens |
| Forensic    | ✅ admin rail (UX-4B) — suspicion lens, separate surface |

## What this explicitly does NOT do

- Does not render `suspicion[]` to the inspector — ever.
- Does not show `sha256`, `geoDistanceFromJobKm`, `deviceModel` to the
  inspector — even though the API returns them.
- Does not include "your job is at high risk" badges. Trust scoring is
  not the inspector's problem.
- Does not let the inspector navigate the timeline by tapping events
  (read-only narrative). Section navigation already lives in the chip
  cluster above — duplicating it here would create two competing
  navigation surfaces.
- Does not animate event arrival. Ambient ≠ attention-grabbing.

## Deferred (not done; tracked here so the next pass doesn't redo them)

- Inspector-facing notification when the customer or admin replies/queries
  a timeline event. Currently the rail is one-way (read-only narrative).
- Per-event "jump to section" (could be added by tapping a row → setParams
  `section=<derived sectionId>`), but the user brief explicitly favored
  navigation-spatial-only at this layer.
- Server-side `lastSeenEventId` for "N new events" badging. Worth doing
  once the rail proves itself in the field; until then, the relative time
  is sufficient.
- Customer-side TimelineRail. The backend already strips suspicion for
  customers, but the *projection* needs its own lens (and likely fewer
  event types). Out of scope for this step.

## Next natural step (per inspector OS roadmap)

ML Kit OCR for VIN / odometer auto-detect inside the guided capture
screen — turns `media.uploaded.vin` from a manual gesture into an
assisted one. The TimelineRail will naturally pick up the OCR-confirmed
events without code change, because the eventType taxonomy already covers
context-tagged media.

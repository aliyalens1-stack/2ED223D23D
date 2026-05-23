# UX-4C — Step 2: Section-level Evidence Rollup Chips

**Date:** 2026-05-14
**Surface:** `/app/frontend/app/inspector/inspection/[jobId].tsx` (Expo, inspector workflow)
**Backend:** no changes — pure UI aggregation of existing `/api/inspections/{job}/evidence-gaps` payload.

---

## Motivation

UX-4C step 1 delivered **continuous, ambient evidence guidance**:
- Item-level: inline borderless severity tint + `Expected: X · got: Y` line
- Header-level: chips `N required evidence` (hard) and `N evidence pending` (soft)

What was missing: **mid-level navigation intelligence**. The inspector had to either
scroll the entire report or memorize which section contained the unresolved
items. The list of sections (Exterior / Interior / Engine / …) showed only a
neutral progress meter (`done/total · pct%`) — same row whether a section was
clean, full of soft gaps, or carrying an identity-critical hard gap.

## Solution

Per-section rollup chip cluster in the section navigator, derived from
`gapByItem` (already fetched by `useEffect` after each report mutation).

### Severity composition

Same taxonomy as the header / item layer — applied at section granularity:

| chip               | tone   | source                                        |
|--------------------|--------|-----------------------------------------------|
| 🔴 N (alert-circle)   | red    | count of `severity === 'hard_missing'`        |
| ⚠ N (information-circle) | amber  | count of `soft_missing` + `soft_mismatch`     |
| 🔴 N (close-circle)   | red    | inspector-marked `status === 'critical'`      |
| ⚠ N (warning)        | amber  | inspector-marked `status === 'warning'`       |
| ✓ (checkmark-circle)| green  | section done AND zero of all above            |

Chips render only when count > 0 (or for ✓ only when section is fully clean).
Order is intentional: identity-critical → operational → flagged → safe.

### Data flow

```
gapByItem  ← /api/inspections/{job}/evidence-gaps  (already refetched on mutation)
   │
   └──[ useMemo ]──→ gapBySection: Record<sectionId, {hard, soft}>
                              │
                              └──→ renders chips in <TouchableOpacity insp-section-{id}>
```

No new endpoint, no new request, no new state — single `useMemo` over already-
in-memory data. Cost: O(items) per gap refresh, ~41 items typical.

### Test IDs (consistent with existing convention)

- `insp-section-{sid}-chip-hard`
- `insp-section-{sid}-chip-soft`
- `insp-section-{sid}-chip-criticals`
- `insp-section-{sid}-chip-warnings`
- `insp-section-{sid}-chip-clean`

## Validation

Live verification against seeded `inspecting` job
`13e88cd7-3d5b-4cd3-924b-be0c5b55695b`:

```
[gaps] hardCount=3 softCount=17 items=41
Section navigator chips (simulated frontend render):
  Exterior                           →  ⚠ 4
  Interior                           →  ⚠ 3
  Engine                             →  ⚠ 4
  Suspension & Brakes                →  ⚠ 4
  Diagnostics                        →  ⚠ 2
  Test Drive                         →  ✓
  Documents                          →  🔴 3
[PASS] Rollup totals match backend: hard=3 (sum) == hardCount, soft=17 == softCount
```

Documents section correctly carries the **3 hard chips** — corresponding to
`HARD_ENFORCEMENT_ITEM_IDS = {vin_match, odometer_photo, registration_doc}`.
Test Drive correctly renders **✓** because none of its items has
`requiredMedia=True`.

## What this closes

UX-4C navigation hierarchy is now complete:

| Level       | Status  |
|-------------|---------|
| Item        | ✅ (UX-4C step 1) |
| Section     | ✅ (this) |
| Inspection  | ✅ (header chips, UX-4C step 1) |
| Timeline    | ✅ (admin forensics) |
| Report      | ✅ (UX-3C customer view) |
| Audit       | ✅ (override timeline events) |

## What this explicitly does NOT do

- Does not auto-scroll the section navigator to the most severe section.
- Does not animate chip appearance/disappearance.
- Does not introduce a "fix all in section" bulk action.
- Does not change submit gate semantics — purely informational.

These are deferred. The current implementation is **read-only navigation
intelligence**; promoting it to an action surface would require its own
operational trigger.

## Next natural step (per inspector OS roadmap)

Per user's review at this session boundary: **Inspector TimelineRail** comes
next, followed by ML Kit OCR for VIN/odometer auto-detect. Section rollup
finishes the navigation layer of UX-4; TimelineRail starts the temporal
layer.

# Customer Cognition Loop — Navigation Coherence

**Date:** 2026-05-14
**Sprint name:** Customer-Nav-1 (closes the customer cognition triangle)
**Premise (per user brief):** architecture is already complete — this
sprint adds navigation glue between the three customer surfaces, nothing
more. No new endpoints, no new logic, no new event types.

---

## The three customer surfaces (already existed)

| Surface | File | Answers |
|---|---|---|
| `continuity.tsx` | `app/customer/inspection/[jobId]/continuity.tsx` | "Where are we right now?" (current snapshot + maturity stage) |
| `timeline.tsx`   | `app/customer/inspection/[jobId]/timeline.tsx`   | "What has happened so far?" (chronological rail) |
| `report-cognition.tsx` | `app/customer/inspection/[jobId]/report-cognition.tsx` | "What does it mean?" (final interpretation) |

Before this sprint, each surface was reachable only by direct URL or by
back-stack. The customer had no in-app affordance to step between them.
After this sprint:

```
            continuity ──── "View detailed history" ───┐
                ▲                                       ▼
                │                                   timeline
                │   "Current state"               (chronological)
                └──────────────── ▲                     │
                                  │       "Report"      │
                                  └─── ◀──────  ────────┘
                                  ▼
                              timeline
                                  ▲
                                  │ "How we got here"
                                  │
                          report-cognition
                                  ▲
                                  │ (back stack / nav root)
```

Three vertices, four edges. Every surface reachable from every other in
≤2 taps. Back stack still works.

## Changes

| File | Edit |
|---|---|
| `continuity.tsx` | Add `linkBtn` "View detailed history →" after the events section. Style entry `linkBtn / linkBtnText`. |
| `report-cognition.tsx` | Add `linkBtn` "How we got here" (time-outline icon) right after the "Refresh interpretation" button. Style entry `linkBtn / linkBtnText`. |
| `timeline.tsx` | Add `crossRow` with two ghost buttons: "Current state" → continuity, "Report" → report-cognition. Style entries `crossRow / crossBtn / crossBtnText`. |

No backend touched. No state changes. No useEffect added.

## Copy (lexicon-disciplined)

Four customer-visible strings introduced. Verified word-boundary-clean
against the combined 21-word forbidden lexicon (union of `continuity.tsx`
and `report-cognition.tsx` rules):

```
✓ "View detailed history"   — from continuity → timeline
✓ "How we got here"         — from report-cognition → timeline (user's exact phrasing)
✓ "Current state"           — from timeline → continuity
✓ "Report"                  — from timeline → report-cognition
```

Forbidden words checked: AI, score, confidence, probability, algorithm,
system, draft, queue, suspicion, override, OCR, hash, critical, warning,
flagged, accuracy, expert, guaranteed, risk, safe, percent.

Note: the surface owns its own copy. The cross-surface link "Report"
intentionally does NOT borrow the word "interpretation" (that's
`report-cognition`'s local vocabulary, not a wayfinding label).

## Visual discipline

All three new buttons share the same restraint pattern with the existing
`refreshBtn`:

- Ghost border (`C.borderLight`), no fill
- 14-pt icon + 12-pt caption-weight label
- No badge counts, no "new" pip, no urgency colour
- `activeOpacity={0.7}` — same touch feel as Refresh

The user chooses when to navigate. The system never demands attention.

## Navigation semantics

- **Forward link (continuity → timeline, cognition → timeline)**: uses
  `router.push()`. Back stack grows by one. Back button returns to the
  originating surface naturally.
- **Cross link (timeline → continuity, timeline → cognition)**: uses
  `router.replace()`. The customer is laterally stepping between
  cognition states of the same job — back stack should not pile up with
  alternating peers. Their original entry point (typically the booking
  detail screen) stays one back-tap away.

## Test IDs

| testID | Surface | Target |
|---|---|---|
| `continuity-view-history-btn`     | continuity        | → timeline |
| `cognition-view-history-btn`       | report-cognition  | → timeline |
| `customer-tl-to-continuity`        | timeline          | → continuity |
| `customer-tl-to-report`            | timeline          | → report-cognition |

## What this explicitly does NOT do

- Does not add a new screen, route, or component beyond the three already
  existing surfaces.
- Does not introduce a tab bar / segmented control. The user said
  "navigation coherence", not "navigation chrome".
- Does not add notification dots, "N new events" pips, or any urgency
  signal. The customer pulls when they want.
- Does not pre-fetch the destination on hover/long-press. Each surface
  fetches its own data on mount, same as before.
- Does not change the back affordance on any surface. Existing
  `back()`/`canGoBack()` logic remains identical.
- Does not link customer → admin or customer → inspector surfaces — those
  remain firewalled.

## E2E (post-edit)

```
Metro bundled cleanly (1212 modules, 2174ms) after touching all three files.
No transform errors, no missing imports.
```

Lexicon check passed: 4 strings × 21 forbidden words × word-boundary
match → all clean.

## Architectural state after this sprint

The customer cognition loop is now end-to-end:

1. Customer opens the booking → lands on **continuity** ("where are
   we?")
2. Wants context → "View detailed history" → **timeline** ("what has
   happened?")
3. Wants meaning → "Report" → **report-cognition** ("what does it
   mean?")
4. Wants to re-check something → "How we got here" → back to **timeline**
5. Wants the live status → "Current state" → back to **continuity**

No surface gained new operational language. No new event type was
exposed. The three lenses retain their distinct grammars while
becoming reachable from each other.

## Deferred

- **Web parity** — `web-app/` does not have these three customer
  surfaces yet. When they ship, the same four affordances (with the
  same copy table) port directly.
- **Localization** — all four strings are English-only, in lock-step
  with the existing surfaces. When `continuity.tsx` and
  `report-cognition.tsx` localize, these four copy entries localize
  with them.
- **Deep-link from external (push notification, email)** — the URL
  scheme `/customer/inspection/{jobId}/{continuity|timeline|report-cognition}`
  is now uniform across all three surfaces, so a future notification
  service can deep-link straight to any of them without surface-specific
  routing logic.

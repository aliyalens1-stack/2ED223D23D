# Sprint Customer-Web-1 — web port of customer narrative

**Date:** 2026-05-14
**Status:** **Shipped** — all 6 acceptance gates green
**Scope:** transport only. Zero new grammar.

---

## What this sprint is (and is not)

| Is                                                              | Is not                                          |
|-----------------------------------------------------------------|-------------------------------------------------|
| A **port** of the three customer surfaces to web-app            | A re-implementation of any narrative logic      |
| Importing `getCopy` / `projectTimeline` / `fillDate`             | Re-translating, re-allowlisting, re-fallback'ing |
| Web-specific container, navigation, typography                  | Web-specific copy, grammar, drop policy          |

---

## What shipped

### 1. Vite + tsconfig wiring

Added `@customer-grammar` alias pointing at
`frontend/src/customer-grammar/`. Web-app + mobile import from the
**same module**, on disk, by absolute path. There is no copy of the
copy tables, no re-export, no second source of truth.

```ts
// vite.config.ts
'@customer-grammar': path.resolve(
  __dirname, '..', 'frontend', 'src', 'customer-grammar',
)
```

`tsconfig.json` paths mirror this so IDEs and `tsc` resolve identically.
Existing `fs.allow: ['..']` already permits reads outside the web root.

### 2. Three surfaces consume grammar

| Surface                            | API endpoint                                          | Grammar usage                                        |
|------------------------------------|-------------------------------------------------------|------------------------------------------------------|
| `InspectionTimelinePage.tsx` (NEW) | `GET /api/inspections/:jobId/timeline`                | `getCopy(...).ui[*]`, `projectTimeline(events, lang)`, `fillDate(...)` |
| `InspectionContinuityPage.tsx`     | `GET /api/customer/inspection/:jobId/continuity`      | `getCopy(...).ui[*]`, `MATURITY_KEY` lookup, `fillDate(...)` |
| `ReportCognitionPage.tsx`          | `GET /api/customer/inspection/:jobId/report-cognition`| `getCopy(...).ui[*]`, `fillDate(...)` for `lastInterpreted` |

Every customer-narrative string in those three files is sourced from
`getCopy(i18n.language).ui[...]`. Web introduces zero new vocabulary.

**Backend-owned strings** rendered verbatim:
- `continuity.events[].title` + `.text` (continuity event narratives)
- `continuity.interpretation` (paragraph from the cognition mapper)
- `cognition.sections.*` (the four section bodies)

The four cognition section eyebrows ("What structurally matters", "What
remains uncertain", "What supports the interpretation", "What may
require further review") are documented in the file header as a
**backend-mirror constant** — they describe the backend's section
taxonomy, not the customer's narrative vocabulary. If the backend
renames a section, the constant moves with it. They are explicitly
NOT in the customer-grammar firewall scope.

### 3. New route

```
/dashboard/inspection/:jobId/timeline → InspectionTimelinePage
```

Mounted under the existing `CustomerShell` + `RequireKind({CUSTOMER_KINDS})`
guard. Mirrors mobile's `/customer/inspection/[jobId]/timeline`.

### 4. CI + CODEOWNERS extended

`.github/workflows/customer-grammar.yml` now also triggers on changes
to the three web pages. The three grammar checks (lexicon, parity,
checksum) run unchanged — they gate web by construction (web imports
the same module they validate).

`.github/CODEOWNERS` locks the three web pages under the same
`@customer-grammar-owners @platform-owners` review group as the mobile
surfaces and the policy artifact.

---

## Acceptance — six gates, all green

| # | Gate                                                       | Result |
|---|------------------------------------------------------------|--------|
| 1 | `yarn grammar:check` (lexicon + parity + checksum)         | OK — strings=180/checks=6600/violations=0; events=19/rendered=13/dropped=6/invariants=6/violations=0; drifts=0 |
| 2 | `yarn build` (web-app, vite)                               | OK — 7.59s, `web-customer-*.js` chunk: 113 kB / 27 kB gzip |
| 3 | Same fixture projection output (mobile ≡ web)              | by construction — same `projectTimeline` function, same `copy/*.json` JSON tables, same `forbidden-lexicon.json` |
| 4 | Web page renders same narrative strings as mobile (live)   | OK — RU timeline shows `Назад / ОСМОТР / Ход проверки / Обновить / Текущее состояние / Отчёт / Осмотр недоступен.` (identical to mobile RU) |
| 5 | No forbidden lexicon in web copy                           | OK — grep over web pages for AI/score/OCR/risk/suspicion/flagged/draft/correlation/override/confidence/probability/accuracy/warning/critical/hash returned zero matches outside comment headers |
| 6 | No OCR/correlation/evidence override leak                  | enforced — web calls `projectTimeline()`; the parity-test fixture **explicitly** includes `ocr.vin_detected`, `ocr.odometer_detected`, `correlation.spatial_anomaly`, `evidence.gaps_overridden`, `internal.audit.replay`, `item.flagged_ok` and asserts they are dropped on every locale. Web has no alternate code path |

---

## Files (3 new / 4 edited)

**New:**
- `web-app/src/pages/customer/InspectionTimelinePage.tsx`

**Edited (full rewrites):**
- `web-app/src/pages/customer/InspectionContinuityPage.tsx`
- `web-app/src/pages/customer/ReportCognitionPage.tsx`

**Edited (light):**
- `web-app/vite.config.ts` — `@customer-grammar` alias
- `web-app/tsconfig.json` — paths + include
- `web-app/src/App.tsx` — lazy import + route mount
- `.github/workflows/customer-grammar.yml` — +3 web paths to trigger
- `.github/CODEOWNERS` — +3 web paths locked

No other files touched. No backend changes. No mobile changes. No
customer-grammar changes (checksum baseline therefore unchanged —
verified).

---

## What we now have

```
                          ┌─────────────────────────────────┐
                          │   customer-grammar (canonical)  │
                          │  ─────────────────────────────  │
                          │  • copy/{en,de,ru}.json         │
                          │  • forbidden-lexicon.json       │
                          │  • test-fixtures/*.json         │
                          │  • projection-checksums.json    │
                          │  • narrative.ts                 │
                          │     ├─ getCopy()                │
                          │     ├─ fillDate()               │
                          │     ├─ projectTimeline()        │
                          │     └─ getEventCopy()           │
                          └────┬───────────────────────┬────┘
                               │                       │
            imports identically│                       │imports identically
                               ▼                       ▼
              ┌──────────────────────┐   ┌──────────────────────┐
              │   mobile (Expo RN)   │   │     web (Vite)       │
              │  ───────────────     │   │  ───────────────     │
              │  timeline.tsx        │   │  Timeline page       │
              │  continuity.tsx      │   │  Continuity page     │
              │  report-cognition    │   │  ReportCognition     │
              └──────────────────────┘   └──────────────────────┘
                                                                 
                          ▲ same lexicon firewall            ▲
                          ▲ same parity invariant            ▲
                          ▲ same checksum baseline           ▲
                          ▲ same CI gate                     ▲
```

Customer narrative is now a **policy-controlled subsystem with two
transport surfaces**. Adding email / push / PDF later means a fourth
surface importing the same module — no fourth grammar, no fourth
firewall, no fourth review process.

---

## Out of scope (deferred, intentional)

- **Backend API harmonisation between mobile + web cognition shape.**
  Mobile expects `sections: Array<{title, body}>`; web reads
  `sections: {structurally_matters, remains_uncertain, ...}`.
  Either snapshot is valid; this sprint did NOT modify the API
  contract. A future sprint can unify if needed.
- **Localising the four cognition section eyebrows.** Documented as
  backend-mirror constants. If the backend ever returns them per
  request, the constants disappear and the surface renders the
  response directly.
- **Web-specific cross-nav layout polish.** Current row of `<Link>`
  pills works at all viewports; richer affordances are visual-design
  scope, not grammar scope.

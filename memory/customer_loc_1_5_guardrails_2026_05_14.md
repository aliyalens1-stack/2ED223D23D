# Sprint Customer-Loc-1.5 — pre-Web guardrails

**Date:** 2026-05-14
**Status:** **Shipped** (both guardrails green)
**Purpose:** Before Customer-Web-1, lock customer-grammar as an
**enforceable policy artifact**, not a convention.

---

## Why this sprint (between Loc-1 and Web-1)

After Customer-Loc-1, the customer-grammar module became reusable for
**all** future customer-facing pipelines: mobile, web, email, push,
PDF, chat. Reuse without enforced contracts = drift. This sprint adds
two enforced contracts so the architecture stays defensible as it
fans out.

> Перед Customer-Web-1 сделать маленький invariant test:
> mobile projection output == web projection output
> на одинаковом mock timeline payload.
>
> И отдельно: ваш forbidden-lexicon.json теперь фактически policy
> artifact. CODEOWNERS, mandatory CI, no silent bypass.

---

## Guardrail #1 — projection-parity invariant

### Extraction: pure-function projection

`projectTimeline(events, lang)` lifted out of `timeline.tsx` into
`src/customer-grammar/narrative.ts`. Surfaces (mobile today,
web/email/push tomorrow) all consume the **same** function. They
NEVER reimplement the allowlist locally.

Signature:
```ts
projectTimeline(events: RawTimelineEvent[], lang: string)
  → { rendered: ProjectedRow[], dropped: DroppedRow[] }
```

Each `ProjectedRow` carries `sourceEventType` for forensic
introspection in tests (surfaces must NOT render this field).

### Doctrine fixture

`src/customer-grammar/test-fixtures/timeline-mock.json` — 19 events
including the dangerous tail (`ocr.*`, `correlation.*`,
`evidence.gaps_overridden`, `item.flagged_ok`, `internal.audit.replay`).
With expected `rendered` / `dropped` / `fallback` ID lists. The fixture
is the doctrine — adding a customer-visible event type without
updating it = test failure.

### Six asserted invariants

| ID | Property                                                                  |
|----|---------------------------------------------------------------------------|
| I1 | `set(rendered.sourceEventType)` identical across EN/DE/RU                 |
| I2 | `set(dropped.sourceEventType)` identical across EN/DE/RU                  |
| I3 | Rendered preserves input order — no implicit sort                         |
| I4 | Rendered/dropped IDs match `expectedRenderedIds` / `expectedDroppedIds`   |
| I5 | `media.uploaded.undercarriage` (unknown subtype) falls back to `media.uploaded` title in every locale |
| I6 | No rendered title contains a universal forbidden token (defense in depth) |

### Runner

`scripts/check-projection-parity.mjs` — pure node, zero deps. The
projection function is mirrored in 12 lines so the test runs without
a TS toolchain. The mirror MUST stay structurally identical to
`narrative.ts` (documented in the script header).

### Current state

```
[parity] OK — locales=[en,de,ru], events=19, rendered=13, dropped=6,
              invariants=6, violations=0
```

When `customer-web-1` ships, the web surface will import
`projectTimeline` directly — so the *same* function gates the *same*
fixture in CI. Web has no opportunity to silently re-implement.

---

## Guardrail #2 — policy artifact contract

### `src/customer-grammar/POLICY.md`

Binding document. Frames the customer-grammar module as the boundary
between three truths:

```
operational truth   →  inspector surface
forensic truth      →  admin surface
customer narrative  →  customer surface  ← this module's domain
```

Spells out:
- the seven **protected paths**,
- mandatory codeowner review,
- mandatory `yarn grammar:check` (no `--no-verify`, no comments),
- the explicit change-set rule for adding a new allowlisted event
  (every locale + types.ts + fixture must be touched in the same PR),
- backward-compat **forbidden** — phrases evolve, no legacy keys.

### `.github/CODEOWNERS`

Locks the seven protected paths + the three customer surface files to
`@customer-grammar-owners @platform-owners`. Real handles are
placeholders until the team is assigned. Default ownership = platform
owners so nothing falls through.

### `.github/workflows/customer-grammar.yml`

GitHub Actions workflow. Triggers on PR + push to main/master + any
change under `frontend/src/customer-grammar/**` or the customer
surface paths. Runs:

```
- node scripts/check-customer-lexicon.mjs
- node scripts/check-projection-parity.mjs
```

Both return non-zero on violation. Workflow header forbids
`continue-on-error` and silent-bypass clauses.

### `yarn grammar:check`

Local mirror of the CI gate. Composed of:

- `yarn grammar:lexicon` — forbidden-lexicon firewall
- `yarn grammar:parity` — projection-parity invariants

Single command for code-owners to run before approving a PR.

---

## Verification (all green)

```
$ yarn grammar:check
$ node scripts/check-customer-lexicon.mjs
[lexicon] OK — locales=[en,de,ru], strings=180, checks=6600, violations=0
$ node scripts/check-projection-parity.mjs
[parity] OK — locales=[en,de,ru], events=19, rendered=13, dropped=6,
              invariants=6, violations=0
Done in 0.39s.
```

```
$ tsc --noEmit (narrative.ts + timeline.tsx + types.ts):  0 errors
$ live mobile DE/EN/RU render (post-refactor):           identical to Loc-1
```

---

## Files added (5) / edited (2)

**New:**
- `src/customer-grammar/POLICY.md`
- `src/customer-grammar/test-fixtures/timeline-mock.json`
- `scripts/check-projection-parity.mjs`
- `.github/CODEOWNERS`
- `.github/workflows/customer-grammar.yml`

**Edited:**
- `src/customer-grammar/narrative.ts` — added `projectTimeline()` +
  `RawTimelineEvent` / `ProjectedRow` / `DroppedRow` / `ProjectionResult` types
- `app/customer/inspection/[jobId]/timeline.tsx` — consumes
  `projectTimeline` instead of inline `useMemo` projection
- `frontend/package.json` — added `grammar:lexicon`, `grammar:parity`,
  `grammar:check` scripts

No surface re-renders changed. Mobile timeline behaves identically.

---

## Now ready for Customer-Web-1

The web port is now structurally trivial:

1. Add `web-app/src/pages/customer/{Continuity,Timeline,ReportCognition}.tsx`.
2. `import { getCopy, projectTimeline, fillDate } from '<path>/customer-grammar/narrative'`
   — the module is pure data + pure TS, zero RN deps.
3. Run `yarn grammar:check` in CI for both `frontend/` and (when added) `web-app/`.

Web has **no opportunity** to:
- re-translate a phrase (copy tables are imported, not duplicated),
- re-implement the allowlist (`projectTimeline` is imported),
- accidentally leak a forbidden token (lexicon test runs against the
  shared tables),
- diverge from mobile drop behaviour (parity test runs the same
  function on both surfaces' input).

The Web sprint is now a port, not a re-implementation.

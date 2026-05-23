# customer-grammar/POLICY.md — policy artifact contract

**Status:** binding policy. Treat the files listed below as security
contracts, not as UX details.

---

## Why this file exists

Some artifacts in this repository are not just "code that happens to
work." They define the **boundary between three distinct truths**:

```
operational truth   →  inspector surface
forensic truth      →  admin surface
customer narrative  →  customer surface  ← this module
```

Crossing that boundary in the wrong direction breaks trust in ways
the test suite cannot fully express. The artifacts listed here are
therefore subject to elevated review.

---

## Protected artifacts

| Path                                                          | Role                                          |
|---------------------------------------------------------------|-----------------------------------------------|
| `src/customer-grammar/forbidden-lexicon.json`                 | **Lexicon firewall** — operational vocabulary tokens banned from customer-visible strings, per-locale. |
| `src/customer-grammar/copy/{en,de,ru}.json`                   | **Curated narrative tables** — the only source of customer-visible event titles + UI chrome. |
| `src/customer-grammar/narrative.ts`                           | **Projection function** — `projectTimeline()` is the single allowlist used by every customer surface (mobile, web, future PDF/email/push). |
| `src/customer-grammar/types.ts`                               | **Exhaustive key sets** — `UICopyKey` / `EventCopyKey`. Adding a key is an explicit, surveyed act. |
| `src/customer-grammar/test-fixtures/timeline-mock.json`       | **Doctrine fixture** — operational event stream including events that MUST be dropped. |
| `src/customer-grammar/projection-checksums.json`              | **Semantic baseline** — SHA-256 of the stable-serialised projection per locale. Any drift is a reviewable diff. |
| `scripts/check-customer-lexicon.mjs`                          | Lexicon firewall test. |
| `scripts/check-projection-parity.mjs`                         | Projection-parity invariant test. |
| `scripts/check-projection-checksum.mjs`                       | Projection-checksum invariant test (semantic drift detector). |

---

## Review rules (enforced via CODEOWNERS + CI)

1. **Mandatory review.** Every PR touching any path above requires
   approval from a customer-grammar codeowner. No silent merges, no
   self-merge by the author.

2. **Mandatory tests.** `yarn grammar:check` MUST pass before merge.
   That command runs three checks:
   - `check-customer-lexicon.mjs` — universal + per-locale lexicon firewall
   - `check-projection-parity.mjs` — allowlist / drop / order / fallback / universal-lexicon invariants
   - `check-projection-checksum.mjs` — semantic-drift detection (SHA-256 over the stable-serialised projection per locale)
   All scripts return non-zero on any violation. CI must fail the
   build on failure — no `--no-verify`, no skipped jobs, no comments.

3. **No silent bypass.** If a PR needs to add a new operational
   event type to the customer allowlist, the change set must include:
   - the new key in `copy/en.json`, `copy/de.json`, `copy/ru.json`
     (all three, with curated phrasing per locale),
   - the new key in `types.ts` `EventCopyKey`,
   - the new event id in `test-fixtures/timeline-mock.json`
     under `expectedRenderedIds`,
   - regenerated `projection-checksums.json` (via
     `node scripts/check-projection-checksum.mjs --update`),
   - a passing run of `yarn grammar:check`.

4. **No string injection.** Customer surfaces NEVER concatenate or
   template operational payload fields into rendered narrative. The
   copy table is the only allowed source. The lexicon firewall
   cannot catch a runtime template that interpolates a forensic
   field — only review can.

5. **Backward-compatibility forbidden.** If a phrase no longer
   represents customer truth, change it. Do not version it. Do not
   keep "legacy" keys for older mobile clients. The clients render
   what the module says today.

---

## Reference grammar

The architecture this policy protects:

```
event stream
  → epistemic projection            (projectTimeline)
    → locale-safe narrative grammar (copy/{en,de,ru}.json)
      → customer cognition surface  (continuity, timeline, report-cognition)
```

If a change makes any of those arrows leaky, the change is not allowed
to merge — regardless of UX desirability or schedule pressure.

---

## Glossary — forbidden in customer narrative, per design

These concepts must never leak to customers, in any locale, ever:

- AI / ML / inference / model / algorithm / training
- score / rating / confidence / probability / accuracy / percent
- risk / safe / warning / critical / suspicion / suspicious
- system / queue / draft / override / overridden
- OCR / hash / sha256 / flagged / flag
- expert / guaranteed / recommended-purchase / safe-to-buy /
  expert-approved / green-light / red-flag / yellow-flag

Their per-locale equivalents are listed in `forbidden-lexicon.json`.
The exact list evolves; the policy that it MUST exist and be enforced
does not.

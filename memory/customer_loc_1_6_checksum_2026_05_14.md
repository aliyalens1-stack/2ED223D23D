# Sprint Customer-Loc-1.6 — projection-checksum invariant

**Date:** 2026-05-14
**Status:** **Shipped** (triple-guardrail green, drift detection proven)
**Purpose:** Close the last semantic-drift gap before Customer-Web-1.

---

## Why this guardrail (beyond parity)

Parity asserts **structure**: allowlist sets equal across locales,
drop sets equal, order preserved, fixture IDs match.

Parity does NOT catch:

- silently retitling a copy entry,
- silently changing an icon glyph,
- a fallback chain that resolves to a different table entry,
- introducing a non-deterministic field into the projection result.

Those are **semantic** drifts. Until now they slipped through review
unless someone happened to read every locale's diff in detail. The
checksum invariant makes them **mandatory review items**.

---

## What shipped

### Pure-node checksum runner

```
scripts/check-projection-checksum.mjs
```

For each locale:
1. Run the (mirrored) `projectTimeline()` over the doctrine fixture.
2. Stable-serialise the result (sorted keys at every level, no whitespace).
3. SHA-256 over the canonical string.

Compare the three hashes against the committed baseline. On drift:
- exit 1,
- print `expected` vs `got` per drifted locale,
- print the exact `--update` invocation a codeowner would have to
  approve to commit a new baseline.

The stable-serialiser is a 10-line hand-rolled function — sorted keys
at every nesting level, no external `json-stable-stringify` dep. The
guardrail must not pull a fourth-party serialiser into its trust path.

### Committed baseline

```
src/customer-grammar/projection-checksums.json
```

```json
{
  "_doc": "Projection checksums per locale. DO NOT hand-edit. …",
  "fixture": "src/customer-grammar/test-fixtures/timeline-mock.json",
  "algorithm": "sha256",
  "generatedAt": "2026-05-14T22:09:50.481Z",
  "checksums": {
    "en": "620055f5b62fff92833baa2f5b3d563fd5a733206f9e32c49236d93a4ed89786",
    "de": "2beb7820c6f004eb58718d7a3c61b35f25de83d6d45655845ca769963386198c",
    "ru": "48fb4afa0c2708d92a3b76d8171c08003a89e145d667459f4d90353e71f7125a"
  }
}
```

Hand-editing is policy-forbidden. Regeneration goes through
`yarn grammar:checksum:update` and the diff must be reviewed by a
customer-grammar codeowner in the same PR as the underlying semantic
change.

### Wiring

| Surface              | Status                                                                 |
|----------------------|-------------------------------------------------------------------------|
| `yarn grammar:check` | now runs `lexicon && parity && checksum`                                |
| `package.json`       | + `grammar:checksum`, + `grammar:checksum:update`                       |
| CI workflow          | + 3rd step: "Projection checksum (semantic drift)"                      |
| `.github/CODEOWNERS` | + `projection-checksums.json` + `check-projection-checksum.mjs` locked  |
| `POLICY.md`          | review-rule #2 updated to 3 checks; review-rule #3 requires regenerated baseline in the same PR |

---

## Verification

### Positive path
```
$ yarn grammar:check
[lexicon]  OK — strings=180,  checks=6600, violations=0
[parity]   OK — events=19,    rendered=13, dropped=6, invariants=6, violations=0
[checksum] OK — locales=[en,de,ru], algorithm=sha256, drifts=0
Done in 0.59s.
```

### Negative path (drift-detection proof)

Mutated `report.submitted.title` in `copy/en.json` from
`"Inspector finished the report"` →
`"Inspector finished the report (drift)"`. Ran the checksum:

```
[checksum] FAIL — 1 locale(s) drifted:
  [en]
    expected: 620055f5b62fff92833baa2f5b3d563fd5a733206f9e32c49236d93a4ed89786
    got:      569f97ade091ccc6e8a14888423bda0570b118141f0f9fa16e1b6b528ed3b518

  If this change is INTENTIONAL: run `node scripts/check-projection-checksum.mjs --update`
  and commit the updated projection-checksums.json in the same PR.
  Codeowners will review the hash drift like any policy artifact.

exit code 1
```

Restored the original title → all three checks back to green. The
checksum is a real semantic-drift detector, not a placebo.

---

## What the three guardrails now cover

| Guardrail  | Layer                           | Catches                                                                 |
|------------|---------------------------------|--------------------------------------------------------------------------|
| Lexicon    | Token-level (per-locale)        | Forbidden vocabulary leaks (universal + per-locale).                     |
| Parity     | Structural (cross-locale)       | Allowlist / drop / order / fallback / fixture discrepancies.             |
| Checksum   | Semantic (per-locale stability) | Silent title/icon retitling, ordering changes, fallback chain shifts.    |

Together they make the customer-grammar a **policy-controlled
narrative subsystem**, where every change is:

- explicit (must touch typed key + locales + fixture + baseline),
- reviewable (codeowner-gated, diffable hashes, no silent merges),
- diffable (parity & checksum errors print exact deltas).

---

## Files (1 new / 4 edited)

**New:**
- `scripts/check-projection-checksum.mjs`
- `src/customer-grammar/projection-checksums.json` (baseline)

**Edited:**
- `frontend/package.json` — +2 yarn scripts
- `.github/workflows/customer-grammar.yml` — +1 CI step
- `.github/CODEOWNERS` — +2 locked paths
- `src/customer-grammar/POLICY.md` — review-rule #2 updated, #3 expanded

---

## Customer-Web-1 readiness

All three guardrails will run unchanged on the web port:

```
yarn grammar:check    # works regardless of which surface(s) consume customer-grammar
```

For the web surface to merge:
- it imports `projectTimeline` from this module (cannot reimplement),
- its CI inherits the same workflow,
- the same fixture + same locales + same baseline gate web's projection.

Semantic equivalence with mobile is therefore **structural, not
aspirational**.

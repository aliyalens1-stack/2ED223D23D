# cognition_guardrails

CI scaffold that **cements the customer-cognition doctrine** at the
source-and-DOM level. After Step 5 closed mobile parity, the biggest
remaining risk was forbidden-lexicon drift creeping in through new
contributors, emergency patches, operational copy, telemetry wording,
or third-party integration text. This scaffold catches it before it
ships.

## Single source of truth

All forbidden phrases, required vocabulary, structural invariants, and
the surface-source mapping live in **`guardrails.json`**. The TS
wrappers (`forbidden.ts`, `required.ts`, `structural.ts`, `index.ts`)
re-export the JSON with frozen, typed views for web/Expo runtime use.
The Python scanners under `/app/tests/guardrails/` read the same JSON.
**No duplication anywhere.**

## Three layers

| Layer | Where | Speed | Catches |
|-------|-------|-------|---------|
| **A — Static source scan** | `tests/guardrails/layer_a_static_scan.py` | < 1 s | Forbidden literals, missing required vocabulary, red rejection hex/class fragments — across all surface source files declared in `surface_source_paths`. Strips JS comments first (doctrine prose in comments may legitimately reference forbidden phrases as anti-patterns). |
| **B — Runtime DOM scan** | `tests/guardrails/layer_bc_runtime_scan.py` | ~30 s/surface | Forbidden phrases in **rendered** `inner_text` + attributes (`aria-label`, `placeholder`, `title`, `alt`). Catches runtime interpolation, mapper leak-through, accidental backend copy bleed. |
| **C — Structural assertions** | same runner as B | ~30 s/surface | Per-state DOM invariants from `structural_invariants`. The doctrine of **structural absence** — pre-engagement bridges, fallback cognition documents, skeleton DOM — must NOT exist (count == 0). |

## Running

```bash
# Full three-layer run (preview must be reachable)
./tests/guardrails/run_all.sh

# Fast pre-commit (Layer A only — no browser, no network)
./tests/guardrails/run_all.sh --static
```

Exit code 0 = clean. Exit code 1 = drift.

## Drift detection — proof of life

Verified before this scaffold was sealed:

1. Layer A: inject `Confidence score:` into `RequestIntakePage.tsx` →
   scan reports two violations (`confidence`, `score`), exit 1. Reverts
   and verifies clean again.

2. Layers B+C: structural invariants for `establishment_pre_engagement`
   declare `establishment-continuity-bridge` as `absent`. If a future
   change starts rendering the bridge link before an inspector engages,
   the runner will report violation: `must be 0`.

## Doctrine boundaries

This scaffold deliberately does NOT:

- Run AI-based copy review (it is **regex-deterministic**)
- Score severity, generate "writing suggestions", or recommend
  vocabulary — it asserts **rules**, not opinions
- Lint outside the customer-cognition surfaces declared in the JSON —
  operator/admin/marketplace surfaces operate under different copy
  contracts and are intentionally **out of scope**

## Adding a new customer-cognition surface

1. Add the file path to `surface_source_paths.{surface_key}.files` in
   `guardrails.json` with the appropriate `forbidden_groups` and
   `required_group`.
2. If the surface introduces a new structural state, add an entry under
   `structural_invariants` and register the corresponding URL in
   `RUNTIME_REGISTRY` in `layer_bc_runtime_scan.py`.
3. Run `./tests/guardrails/run_all.sh --static` to confirm clean.

## Expanding the vocabulary

- Adding a new forbidden phrase: tighten the guardrail. Edit the
  appropriate group in `forbidden_lexicon` in `guardrails.json`. No
  source code changes elsewhere.
- Removing a phrase: requires explicit doctrine review. The phrase
  existed for a structural reason; removing it loosens semantic
  restraint.
- Adding required vocabulary: declares that a phrase MUST appear in a
  surface's source. This is the structural anchor that the surface
  speaks the continuity vocabulary.

## Architectural intent

> *"Wording = architecture. Changes here change the semantic boundary."*

These guardrails make that contract enforceable at CI time. Forbidden
lexicon drift across:

- new contributors,
- emergency patches,
- operational copy,
- telemetry wording,
- third-party integrations,

now requires actively editing `guardrails.json` to disable the rule —
which is an explicit doctrine decision, not an accidental commit.

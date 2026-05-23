# OCR-1 — VIN + Odometer Vision OCR

**Date:** 2026-05-14
**Sprint scope (per user brief):** VIN + odometer ONLY. No damage AI, no
paint/panel detection, no realtime CV, no auto-final verdicts.

---

## What was built

A narrow, deterministic vision-OCR loop that triggers automatically when
the inspector captures a VIN plate or odometer photo, presents the
candidate inline, and lets the inspector accept or correct before the
value is persisted to the inspection report.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Inspector captures VIN/odometer  →  POST /media (context tagged)   │
│                                            │                        │
│                                            ▼                        │
│                              run_ocr(base64, kind)  ← ocr.py       │
│                                            │                        │
│                                            ▼                        │
│              gemini-2.5-flash (via emergentintegrations)            │
│                                            │                        │
│                                            ▼                        │
│         { candidate, confidence } → media.ocr (status: "detected")  │
│                                            │                        │
│                          emit  ocr.{kind}_detected  →  timeline     │
│                                            │                        │
│         response.media.ocr  →  pendingOcr[mediaId]  (frontend)      │
│                                            │                        │
│                                            ▼                        │
│              OcrCard renders on item: [Accept] [Edit & Save]        │
│                                            │                        │
│                                            ▼                        │
│            POST /media/{id}/ocr/confirm  {action, value?}           │
│                                            │                        │
│                                            ▼                        │
│   media.ocr.status = "confirmed" | "corrected"                      │
│   report.{extractedVin | extractedMileageKm} = finalValue           │
│   if correct → emit ocr.corrected → timeline                        │
└─────────────────────────────────────────────────────────────────────┘
```

## New / modified files

| File | Change |
|---|---|
| `backend/app/inspections/ocr.py`         | NEW — `run_ocr(base64, kind)` wrapper. Vision LLM + post-processing. |
| `backend/app/inspections/v2.py`          | Hook OCR into media upload; new `POST /media/{id}/ocr/confirm` endpoint; `OcrConfirmBody` model. |
| `backend/.env`                           | Added `EMERGENT_LLM_KEY`. |
| `frontend/.../inspector/inspection/[jobId].tsx` | `pendingOcr` state; `confirmOcr` action; OcrCard render on item; `prettifyEvent` cases for `ocr.*`; styles. |
| `image_testing.md`                       | OCR-1 test contract (per integration playbook requirement). |

## Vision model choice

`gemini-2.5-flash` via `emergentintegrations.llm.chat.LlmChat`.
- Cheap, fast, vision-capable, available under the Emergent LLM key.
- One-shot prompt per image. No streaming. No history.
- Strict JSON output enforced in the system prompt; tolerant parsing
  (markdown fences stripped, regex fallback for JSON-in-prose).

## Post-processing

**VIN** (`_validate_vin`):
- Strip spaces and dashes, uppercase
- Normalize OCR confusables (`O→0`, `I→1`, `Q→0`)
- Regex match 17-char `[A-HJ-NPR-Z0-9]{17}` (ISO 3779: no I, O, Q)
- Reject if not exactly 17 chars
- If empty → returns `{candidate: "", confidence: 0}` (UI shows "no read")

**Odometer** (`_parse_odometer`):
- Strip non-digits
- Reject if 0 or > 1,500,000 (sanity bounds)
- Coerce miles → km via `× 1.609344` if model reports `unit: "mi"`

## Timeline contract

Three new event types, all emitted by the backend:

| eventType | when | payload |
|---|---|---|
| `ocr.vin_detected`      | OCR returns non-empty VIN candidate         | `mediaId, sectionId, itemId, candidate, confidence` |
| `ocr.odometer_detected` | OCR returns non-empty odometer candidate    | `mediaId, sectionId, itemId, candidate, confidence` |
| `ocr.corrected`         | Inspector confirms with `action="correct"`  | `mediaId, kind, from, to` |

**Acceptance is intentionally silent** — no `ocr.confirmed` event. The
candidate becoming the finalValue is the default path; spamming the
TimelineRail with confirmations would dilute it.

## TimelineRail projections (inspector workflow lens)

```
ocr.vin_detected      → 🔍 "VIN detected: WBA8E9C50JK123456"
ocr.odometer_detected → 🔍 "Odometer detected: 92,400 km"
ocr.corrected         → ✏  "Corrected odometer: 92400 → 92500"
```

Same architectural firewall as UX-4D — the admin rail (when it consumes
these events) will project them through its own forensic lens (e.g.
"OCR diverged from inspector input by 100 km" — out of scope here).

## Failure modes (all silent — never block the inspector)

1. **EMERGENT_LLM_KEY missing** → `run_ocr` returns None → no OCR card, no
   timeline event. Inspector can still manually capture + type.
2. **LLM call exception** (network, rate limit) → logged warning, returns
   None. Same effect as above.
3. **Unparseable model response** → tries regex fallback; if still fails,
   logs and returns None.
4. **VIN regex fails** → returns `{candidate: "", confidence: 0}`. Frontend
   `if (ocr.candidate)` guard means no card renders.
5. **Confirm endpoint called when no OCR exists** → 409 "no OCR result".
6. **Confirm called twice** → 409 with current status (idempotency).

## E2E validation

Ran against seeded `inspecting` job with synthesized VIN + odometer images
(printed digits on canvas):

```
[upload VIN]   media.ocr = { candidate: "WBA8E9C50JK123456", confidence: 1.0, status: "detected" }
[upload ODO]   media.ocr = { candidate: "92400", confidence: 1.0, status: "detected", unit: "km" }
[confirm VIN accept]   → status: "confirmed",  report.extractedVin = "WBA8E9C50JK123456"
[confirm ODO correct]  → status: "corrected",  report.extractedMileageKm = 92500
                         correctedFrom: "92400"
[timeline]
  ocr.vin_detected       candidate=WBA8E9C50JK123456
  ocr.odometer_detected  candidate=92400
  ocr.corrected          from=92400 → to=92500 (kind=odometer)
```

All four contract guarantees verified.

## UI behaviour (inspector)

OCR card renders inline on the relevant item (right under the media row)
only when:
- The freshly-uploaded media returned `media.ocr.status === 'detected'`
- The inspector has not yet accepted or corrected it

Card layout:
```
┌──────────────────────────────────────────────────┐
│  🔍  VIN detected           [ 100% ]             │
│  WBA8E9C50JK123456                               │
│  [ ✓ Accept ]   [ ✏ Edit ]                       │
└──────────────────────────────────────────────────┘
```

Confidence pill tone:
- ≥ 85% → green
- 50–84% → amber
- < 50% → red

Tap **Edit** → swaps the candidate row for a TextInput pre-filled with the
candidate. VIN input: `autoCapitalize=characters`, max 17 chars. Odometer:
`keyboardType=numeric`, max 7 digits.

Tap **Save** while editing → `POST confirm action=correct value=<edited>`.
Tap **Accept** in default view → `POST confirm action=accept`.

Card disappears after successful confirm. The TimelineRail refresh runs
immediately after so the inspector sees `ocr.corrected` in the rail.

## Test IDs

- `ocr-card-{mediaId}`              — card root
- `ocr-card-{mediaId}-value`        — candidate display
- `ocr-card-{mediaId}-input`        — edit text field
- `ocr-card-{mediaId}-accept`       — default-view accept button
- `ocr-card-{mediaId}-edit`         — default-view edit button
- `ocr-card-{mediaId}-save`         — edit-view save button
- `ocr-card-{mediaId}-cancel`       — edit-view cancel button

## What this explicitly does NOT do

- Does not OCR any other context (`damage`, `interior`, `registration`,
  `general`). The hook is gated on `capture.context in {"vin","odometer"}`.
- Does not damage-detect, panel-gap-detect, or paint-thickness-detect.
- Does not auto-submit, auto-accept, or auto-flag based on OCR output.
- Does not run on the device (no ML Kit, no on-device model). All OCR is
  server-side.
- Does not retry on failure. If the LLM fails, the inspector falls back to
  manual entry — no degraded retry loop.
- Does not write OCR back into any inspection item `note` or `status`.
  Only `media.ocr.*` and the two `report.extracted*` fields are touched.

## Deferred (out of scope for OCR-1)

- Provider/customer-side display of `extractedVin` / `extractedMileageKm`
  in the report. Backend persists them; PDF and admin views can wire in
  later.
- OCR diff vs the customer-provided listing data (e.g. listing claims
  91,000 km but OCR reads 145,000 km → admin-side surface). Belongs to
  the forensic rail, not this sprint.
- Pre-OCR image quality gating. Currently we send any image, even blurry
  ones, and rely on the LLM to return low confidence. A pre-filter
  (Laplacian variance / brightness check) would save LLM cost on
  obvious-fail captures.
- Streaming OCR / camera-feed live overlay. Out of scope per user brief
  ("no realtime CV").
- ML Kit on-device OCR as a fast path before falling back to server. Same
  reason.

## Next natural step

Per inspector OS roadmap, after OCR-1 there are two parallel paths:
1. **Customer-side TimelineRail** — already-sanitized backend, new lens.
2. **Listing-vs-OCR cross-check** — first cross-data-source validation.
   Pulls listing VIN/mileage from `parser_results` collection and surfaces
   any divergence on the admin forensic rail.

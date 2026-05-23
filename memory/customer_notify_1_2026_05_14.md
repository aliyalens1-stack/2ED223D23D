# Customer-Notify-1 — Notification narrative kernel closure

**Date:** 2026-05-14
**Sprint name:** Customer-Notify-1 (third transport on the same event stream)
**Closes:** the policy boundary between operational/forensic vocabulary
and customer interruption transports (push / email / sms).

---

## What was built

A disciplined **third transport** for the customer-grammar narrative
kernel. The kernel now serves three projections of the same
`inspection_timeline_events` stream:

```
                            same event stream
                      inspection_timeline_events
                                  │
                  ┌───────────────┼───────────────┐
                  ▼               ▼               ▼
              projectTimeline   projectNotification(_, _, "push")
              (rail surface)    projectNotification(_, _, "email")
                                projectNotification(_, _, "sms")
                                  │
                                  ▼
                       (future PDF, WhatsApp, …)

           one event stream
             → one canonical grammar kernel
               → many projections
                 → many transports
                   → many locales
                     → one policy system
```

This is exactly the architectural shape Roman described as the closure
state for the customer cognition surface — projection layer not as
notification feature but as **policy-controlled customer narrative
infrastructure**.

---

## Files

| Path | Change |
|---|---|
| `frontend/src/customer-grammar/types.ts`                    | `NotificationChannel` added; `NotificationCopy.title` now `string \| null`; `NotificationCopyTable` shape pivots to per-channel |
| `frontend/src/customer-grammar/copy/{en,de,ru}.json`        | `notifications` shape becomes `{ <key>: { push: {…}, email: {…}, sms: {…} } }` — per-channel curated copy |
| `frontend/src/customer-grammar/narrative.ts`                | `projectNotification(event, lang, channel)` accepts channel arg; `FORBIDDEN_ROUTE_PREFIXES` + `isForbiddenRoute()` added; route-stage drop is the first action; SMS has no cross-channel fallback |
| `frontend/src/customer-grammar/test-fixtures/timeline-mock.json` | `suspicion.vin_mismatch` added (5th forbidden prefix); `forbiddenRoutedIds` array added |
| `frontend/scripts/check-projection-parity.mjs`              | Invariants extended to I12: I7/I7b/I8 multi-channel; I9 channel-shape (push/email title required, sms title null); I10 lexicon over all channels; **I11 forbidden-route invariant** (covers all 5 prefixes); **I12 channel-isolation invariant** (push/email/sms bodies must differ per locale) |
| `frontend/scripts/check-projection-checksum.mjs`            | Checksum namespaces split: `{ timeline, notifications: { push, email, sms } }` — drift is localised per transport |
| `frontend/src/customer-grammar/projection-checksums.json`   | Regenerated under new namespace shape (timeline + 3 channel hashes per locale) |
| `backend/app/notifications/customer_kernel.py`              | **New** — Python adapter that reads the SAME `copy/{en,de,ru}.json` and exposes `project_customer_notification(event_type, lang, channel)`. Zero drift with TS kernel. |
| `backend/app/notifications/projector.py`                    | `_render_customer_copy()` introduced; customer recipients of `inspection.started` / `report.submitted` / `item.flagged_critical` / `item.flagged_warning` are rendered via the shared kernel. Forbidden-route assertion added at the top of `project_event()`. Inspector / admin kinds untouched. |
| `backend/tests/test_customer_notify.py`                     | **New** — pytest covering: forbidden routing on all 5 prefixes × 3 langs × 3 channels; allowlist coverage; SMS title-null discipline; channel isolation (I12); locale normalisation; allowlist == deep-link keys parity; universal-lexicon firewall on every (event, lang, channel) tuple |

---

## Channel hierarchy (Roman, 2026-05-14)

| Channel | Tone                         | Title  | Example (EN, `inspection.started`)                                       |
|---------|------------------------------|--------|--------------------------------------------------------------------------|
| `push`  | ultra-short, single-sentence | yes    | "Inspection update" / "Your inspection has begun."                       |
| `email` | calm, multi-sentence         | yes    | "Your inspection has begun" / "The inspector is now on site … report …" |
| `sms`   | fallback minimal             | **null** | "Your vehicle inspection has begun."                                     |

**SMS has no fallback.** A missing SMS entry in any locale is a
**parity test failure** (I7), not a runtime fallback. SMS is the most
dangerous transport for tone leakage (no UI chrome, carrier
truncation, plain text) — silent drop is safer than borrowing
another channel's prose.

---

## Forbidden routing (route-stage deny)

The kernel drops these prefixes **before** copy lookup. Operational /
forensic / internal vocabularies that have no place in any customer
transport, ever:

```
ocr.            (vin/odometer detection)
correlation.    (spatial / temporal anomaly signals)
evidence.       (gap override decisions)
internal.       (audit replay, ops telemetry)
suspicion.      (vin mismatch, geo drift)
```

The parity test (**I11**) asserts that the fixture covers all five
prefixes structurally — adding a sixth prefix to the kernel requires
adding a covering fixture event in the same PR.

---

## Three guardrails — all green after closure

| Guardrail | Script                              | Coverage extension                                                             |
|-----------|-------------------------------------|--------------------------------------------------------------------------------|
| Lexicon   | `check-customer-lexicon.mjs`        | Walks all strings in copy/{en,de,ru}.json — including new per-channel bodies |
| Parity    | `check-projection-parity.mjs`       | 12 invariants (was 10): added I11 forbidden-route + I12 channel-isolation     |
| Checksum  | `check-projection-checksum.mjs`     | Namespaced: `{ timeline, notifications: { push, email, sms } }` per locale    |

---

## Backend integration

Before Notify-1:
```
backend/app/notifications/projector.py
  COPY = { kind: { title, body }, ... }   # RU only, 14 kinds, hardcoded
```
This was the most dangerous architectural debt — a second source of
truth for customer-visible text, undisciplined by the lexicon /
parity / checksum guardrails.

After Notify-1:
```
projector.py
  → for customer recipients on the 4 allowed kinds, calls
    customer_kernel.project_customer_notification(kind, lang, channel)
  → for inspector / admin recipients, internal COPY map continues
    (different narrative surfaces, out of scope for Notify-1)
```

The kernel reads the same `copy/{lang}.json` files the frontend
projector reads. Drift between mobile / web / push / email is
structurally impossible.

---

## Verification

```
$ cd /app/frontend && yarn grammar:check
[lexicon] OK — locales=[en,de,ru], strings=<N>, violations=0
[parity]  OK — locales=[en,de,ru], channels=[push,email,sms],
              invariants=12, violations=0
[checksum] OK — namespaces=[timeline, notifications.{push,email,sms}],
              locales=[en,de,ru], drifts=0

$ cd /app && /root/.venv/bin/pytest backend/tests/test_customer_notify.py -q
…passed.
```

---

## What is now structurally impossible

1. **Adding an OCR/correlation/evidence/internal/suspicion event** that
   produces a customer notification → blocked by I11.
2. **Promoting a new operational event to notifications** without
   curated copy in all 3 locales × 3 channels → blocked by I7 + TS
   type system (`NotificationKey` exhaustiveness).
3. **SMS borrowing push or email prose** → blocked by I9 (title-null
   shape) + I12 (body-isolation).
4. **Silent semantic drift** in any transport → blocked by namespaced
   checksum baseline (I11 channel drift can no longer hide behind
   timeline drift).
5. **Backend out-of-sync with frontend grammar** → impossible: same
   JSON file, loaded by both layers.

---

## What is now possible

Adding a new transport (WhatsApp, PDF, in-app banner, voice) is a
ONE-FILE change in `narrative.ts`:

```ts
export type NotificationChannel = 'push' | 'email' | 'sms' | 'whatsapp';
```

…plus copy entries in three JSON files. Everything else — guardrails,
firewall, dedup, projector — follows automatically.

This is the closure state. Customer-Notify-1 is **done**.

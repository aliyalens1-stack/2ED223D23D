# CHRONOLOGY_COVERAGE — booking_timeline attachment inventory

> Read-only inventory. Manual, not generated. Updated when a new
> mutation site is wired or a new semantically material event is
> identified. **Intentionally NOT a registry** — this is a check
> artifact, not an execution dispatcher. The actual `observe_transition`
> calls remain explicit + local at each mutation site.

Last updated: 2026-05-20 (P0.b.C.d closure — realtime propagation live; all attach sites auto-emit)

---

## Legend

- **Attached?** — does the mutation site call `observe_transition()`?
- **Semantically material?** — is this a lifecycle event a real
  customer / provider / inspector / admin actor cares about?
- **Actor visibility** — which projection surfaces render it today.

Visibility legend (current projection state):

| Symbol | Surface |
| --- | --- |
| C | customer projection (`app/booking/projections/customer.py`) |
| P | provider projection (`app/booking/projections/provider.py`) |
| I | inspector projection (`app/booking/projections/inspector.py`) |
| A | admin raw lifecycle endpoint (already shows everything) |
| — | not surfaced (deliberate) |

---

## Attached mutation sites (current state)

| # | Mutation site | Action recorded | Attached? | Material? | Visibility | Notes |
| --- | --- | --- | :---: | :---: | --- | --- |
| 1 | `marketplace.bookings.cancel` (customer cancel) | `cancel` | ✅ | ✅ | C, P, I, A | P0.b.B baseline |
| 2 | `marketplace.bookings.cancel` (rejected attempt) | `cancel:rejected` | ✅ | ✅ | A only (forensic) | P0.b.B baseline |
| 3 | `marketplace.provider.accept` | `mark_confirmed` | ✅ | ✅ | C, P, A | inspector deliberately does NOT see (provider-domain event) |
| 4 | `marketplace.provider.accept` (race / rejected) | `mark_confirmed:rejected` | ✅ | ✅ | A only | P0.b.B baseline |
| 5 | `marketplace.provider.job_action` depart | `mark_on_route` | ✅ | ✅ | C, P, I, A | inspector relabels as "В пути на осмотр" |
| 6 | `marketplace.provider.job_action` arrive | `mark_arrived` | ✅ | ✅ | C, P, I, A | inspector relabels as "На месте" |
| 7 | `marketplace.provider.job_action` start | `mark_in_progress` | ✅ | ✅ | C, P, I, A | inspector relabels as "Осмотр начат" |
| 8 | `marketplace.provider.job_action` complete | `mark_completed` | ✅ | ✅ | C, P, I, A | inspector relabels as "Отчёт отправлен" |
| 9 | `disputes.open` (`POST /api/disputes`) | `open_dispute` | ✅ P0.b.B+ | ✅ | C, P, I, A | inspector relabels as "Открыт спор по осмотру" |
| 10 | `disputes.resolve` (`POST /api/admin/disputes/{id}/resolve`) | `resolve_dispute` | ✅ P0.b.B+ | ✅ | C, P, I, A | `adminNote` scrubbed; provider sees `payoutAmount`, inspector sees neither (different aggregate) |
| 11 | `auto_requests.reports.submit` (full completion) | `mark_completed` | ✅ P0.b.B+ | ✅ | C, P, I, A | only when car_request flips to `completed`; inspector sees own `reportId` + `inspectorPayoutAmount` |

---

## Identified but NOT attached (deliberate)

| # | Site | Reason for skip |
| --- | --- | --- |
| 12 | `marketplace.matcher.distribute` (`system → matched`) | Material but already surfaced via P provider projection's `mark_matched` label. Attach lives inside matcher's `_emit_match` path; verify in P0.b.C.c sprint when inspector projection lands. |
| 13 | `auto_requests.reports.submit` (jobs_done > 0 but < total → `report_ready`) | NOT terminal. Surfacing it would require adding `report_ready` to customer/provider visible-actions whitelists (new projection decision). Deferred — separate sprint. |
| 14 | `service_payments.release` (escrow released) | Money-domain event, lives on `money_audit`. Cross-aggregate bridge deliberately deferred — would create coupling between booking + money lifecycles. See "Tier 2 — payout visibility bridge" in backlog. |
| 15 | `service_payments.refund` | Same — money-domain. See `money_audit` (P0.d). |
| 16 | `provider_trust.recompute_provider_reputation` (called on dispute resolve) | Reputation is derivative, not lifecycle. Don't propagate. |
| 17 | `inspector.jobs.lifecycle.*` (claim/on_route/arrived/inspecting) | Inspector aggregate has its own status machine on `inspection_jobs`. Surfacing on `booking_timeline` is the right call **only** when the inspector chronology projection (P0.b.C.c) lands and we can verify what's material. Otherwise we pollute booking chronology with sub-aggregate noise. |

---

## Intentionally NEVER attached (analytics noise)

These are listed explicitly so a future contributor doesn't "fix" the
gap. Activity-style events corrupt operational chronology.

| Site | Reason |
| --- | --- |
| `provider_viewed_booking` | Engagement metric, not lifecycle. Belongs in product analytics. |
| `customer_opened_page` | Same. |
| `system_heartbeat` / health pings | Operational telemetry, not chronology. |
| `notification_read` / push delivery acks | Communication artifact, not state change. |
| `chat_message_posted` | Lives in `service_chat.timeline` (separate aggregate). |
| `image_uploaded` / report attachment events | Media domain. |

If we ever want any of these visible to an actor, the answer is a
new domain-specific surface (e.g. customer_engagement, dashboards),
NOT the booking lifecycle chronology.

---

## Tier-2 bridge candidates (under consideration, NOT yet planned)

These would ONLY surface narrow signals, NOT internal finance state:

- `payout_pending` — provider on `mark_completed` learns "выплата готовится"
- `payout_released` — provider learns "выплата ушла"

Both would require:
1. A dedicated bridge module that reads `money_audit` events,
2. Explicit whitelist additions in `provider.py` (NEW visible actions),
3. NO leakage of internal payment_intent ids / stripe transfer ids /
   commission split / platform fee accounting.

Deferred until inspector projection (C.c) closes — payout
semantics are even denser than dispute and should not steal
sprint air now.

---

## Discipline guardrails — what this inventory does NOT do

- ❌ It does NOT auto-generate attach calls.
- ❌ It does NOT serve as input to any runtime registry.
- ❌ It does NOT exist as a Python dict.
- ❌ It is NOT validated by CI against `grep observe_transition`.

It is **documentation**. Every entry in "Attached" was a deliberate
local code decision. Sites disappear from "Identified but NOT
attached" only when a sprint promotes them, with the full discipline
of:
  * sprint brief,
  * explicit attach call at the mutation site,
  * projection whitelist update if a new visible action is introduced,
  * snapshot test for the rendered shape,
  * closure doc that argues *why* the row is material.

---

## Quick verification (manual, ad-hoc)

```bash
# Did every site in the "Attached" list call observe_transition?
grep -rn "observe_transition" app/ \
  | grep -vE "(booking/attach\.py|booking/__init__\.py|test_)"
```

Expected (as of P0.b.B+):
- `app/disputes/router.py:open_dispute`
- `app/disputes/router.py:admin_resolve_dispute`
- `app/auto_requests/reports.py:submit_report`
- `app/marketplace/...` (P0.b.B baseline — 3 sites)

If a new line appears here, it should also appear in the table above.
If a table entry has no corresponding line, the inventory drifted.

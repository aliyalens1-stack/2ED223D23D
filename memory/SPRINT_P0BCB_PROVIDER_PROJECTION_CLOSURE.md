# Sprint P0.b.C.b — Provider Projection (CLOSURE)

> 2026-05-20 · status: ✅ DONE
> Customer chronology is calm reassurance. Provider chronology is
> operational execution. Same truth, different emotional semantics.

---

## What shipped

### 1. New endpoint

```
GET /api/provider/bookings/{booking_id}/timeline
```

- Auth: `verify_user_token` (any authenticated user).
- Ownership: booking must have at least one provider-id field
  (`providerId` / `providerAccountId` / `providerSlug` /
  `assignedProviderId` / `assignedProviderAccountId` /
  `providerUserId`) matching the caller's identity claims
  (`sub` / `userId` / `accountId` / `providerId` / `providerSlug`).
- **404 on unassigned OR foreign-owned booking** — intentional
  divergence from the customer router's 403. Opacity of competitor
  bookings is the safer default for provider isolation.

### 2. New projection module

`app/booking/projections/provider.py`
- **Separate file** — zero shared code with `customer.py`. Even
  though ~70% of the surface vocabulary overlaps today, divergence
  is guaranteed and duplication here is semantic insulation.
- Whitelist of visible actions (8 entries + contextual `cancel`).
- Whitelist of safe meta keys (`eta`, `reason`, `payoutAmount`,
  `customerNote`, `note`) — DIFFERENT from customer's whitelist by
  design.
- New tone vocabulary: `action_required`, `neutral`, `in_flight`,
  `settled`, `alert`. Customer uses `positive/neutral/celebratory/
  alert`. Tones diverge because semantics diverge.
- Contextual `cancel` renderer — label depends on initiator
  (customer / self / admin). Admin actor id is never leaked even
  when admin is the source.

### 3. e2e test suite

`backend/tests/test_p0bcb_provider_timeline_e2e.py` — 16 tests:

| # | Test | What it proves |
| --- | --- | --- |
| 1 | endpoint_requires_auth | 401 without token |
| 2 | 404_for_missing_booking | 404 path |
| 3 | 404_for_unassigned_booking | No providerId → opaque 404 |
| 4 | 404_for_other_providers_booking | Foreign owner → opaque 404 (not 403) |
| 5 | empty_timeline_returns_empty_events | 200 + `{events: [], count: 0}` |
| 6 | provider_sees_operational_chronology | matched/confirmed/on_route/arrived/in_progress/completed; isSelfAction correct |
| 7 | **provider_never_sees_pricing_internals** | platformCut / providerCost / internalNote(s) / rankingScore / trustScore / fraudFlag / admin id / rejected — ALL scrubbed |
| 8 | provider_sees_eta_and_payout | `eta`, `payoutAmount`, `customerNote`, `note` surface; nothing else |
| 9 | unknown_actions_silently_dropped | `provider_viewed_booking`, `system_heartbeat` → `events == []` |
| 10 | customer_cancel_labelled_correctly | "Клиент отменил" + internalNotes hidden |
| 11 | admin_cancel_hides_admin_identity | "Отменено администрацией" + admin id scrubbed |
| 12 | own_cancel_marked_self | "Вы отменили заказ" + `isSelfAction=True` |
| 13 | dispute_lifecycle_visible | `dispute_opened` (alert tone) + `dispute_resolved`; admin id + ruling internals hidden |
| 14 | **full_payload_snapshot** | Full rendered event list compared to inline expected — primary architectural invariant against future leaks |
| 15 | events_returned_chronologically | Ascending timestamps |
| 16 | ownership_matches_via_account_id | Provider accountId as bookingId.providerId works |

### 4. Wiring

- `app/booking/projections/__init__.py` re-exports
  `project_timeline_for_provider` + `HIDDEN_FROM_PROVIDER`.
- `app/booking/__init__.py` re-exports `provider_router`.
- `server.py` includes provider router alongside customer + admin
  lifecycle routers (3 lines).

---

## Architectural invariants proven

| Invariant | Mechanism |
| --- | --- |
| **I1 — Whitelist (not blacklist) for actions** | New rows on `booking_timeline` are invisible by default. Test #9 plants `provider_viewed_booking` + `system_heartbeat` → both dropped. |
| **I2 — Whitelist (not blacklist) for meta keys** | Test #8 plants 4 whitelisted + 6 unwhitelisted keys; only whitelisted ones surface. Test #14 captures the exact final payload. |
| **I3 — Rejected attempts are forensic-only** | Test #7 plants `mark_confirmed:rejected` from a competitor + `mark_in_progress:rejected` from admin → both invisible. |
| **I4 — Admin identity never leaks** | Tests #6 / #11 / #13 plant `admin-sara-9001` / `admin-9001-secret-id` / `admin-mod-3` → all scrubbed. Event itself surfaces; actor doesn't. |
| **I5 — Unknown actions cannot fall through** | Test #9: activity-feed noise produces `events == []`. Whitelist `.get(action)` returns `None` → row dropped. |
| **I6 — Provider sees execution chronology, not customer trust signals** | Test #7 plants `trustScore`, `fraudFlag` → scrubbed. Provider's chronology is "what to do next", not "how does the platform feel about this customer". |
| **I7 — Same `booking_timeline` row, different rendered shape per actor** | Tests #6 (provider) + the existing `test_p0bca_*` (customer) + `test_p0ba_actor_projections_differ_per_actor` all read the same physical rows and project different views. No coupling. |

---

## Discipline notes — what we deliberately did NOT do

- ❌ No `project_timeline(rows, actor="provider")` dispatcher
- ❌ No `ROLE_VISIBILITY_MATRIX` registry
- ❌ No `_SAFE_META_KEYS` shared module between customer + provider
- ❌ No abstract `BaseProjection` class
- ❌ No "if scope == provider:" branches anywhere
- ❌ No payout join from `money_audit` — that lives in a separate
  domain and would create cross-aggregate coupling. `payoutAmount`
  is surfaced only when explicitly populated in `booking_timeline.meta`
  (the source-of-truth for the lifecycle aggregate).

When inspector projection lands (P0.b.C.c), it will be a *third*
file with its own labels, its own visible-actions set, its own
meta whitelist, and its own tone vocabulary. Divergence is the
plan; sharing is the trap.

---

## Test results

```
$ pytest tests/test_p0bcb_provider_timeline_e2e.py -v
16 passed in 0.97s

$ pytest tests/test_p0ba_booking_lifecycle_e2e.py \
         tests/test_p0bb_attach_observability_e2e.py \
         tests/test_p0bca_customer_timeline_e2e.py \
         tests/test_p0bcb_provider_timeline_e2e.py
47 passed (31 existing + 16 new) — zero regression
```

---

## Files

```
app/booking/projections/provider.py        290 lines  (new)
app/booking/projections/__init__.py         +9 lines
app/booking/provider_router.py             107 lines  (new)
app/booking/__init__.py                     +2 lines
server.py                                   +1 line
tests/test_p0bcb_provider_timeline_e2e.py  430 lines  (new)
memory/SPRINT_P0BCB_PROVIDER_PROJECTION_CLOSURE.md  (this file)
```

---

## Next candidates

- **P0.b.B+** (recommended next) — provider chronology already
  exposed operational gaps. Walk every provider mutation site,
  ensure `observe_transition()` is attached, and that meta passed
  in matches what the provider whitelist expects (`eta`,
  `payoutAmount`, `note`). This will surface attachment holes
  naturally before inspector semantics, which are higher-density
  and benefit from cleaner observability ground.
- **P0.b.C.c** — Inspector projection (separate file, same
  discipline). Hold this until B+ closes attachment holes.
- **P0.b.C.d** — Admin operator projection (governance lens,
  intentionally permissive but still curated — admin should see
  internalNotes but not raw money_audit row ids, etc.).

# Sprint P0.b.B+ — Chronology Coverage Closure

> 2026-05-20 · status: ✅ DONE · author: e2 agent
> Provider projection (C.b) exposed chronology gaps. B+ walks the
> Tier-1 mutation sites and attaches them — disputes (open + resolve)
> and inspection report completion. No registry. No automation.
> Local, explicit attach at each mutation site.

---

## What shipped

### Three new `observe_transition()` attachments

| # | Mutation site | Action | Booking scope | Actor |
| --- | --- | --- | --- | --- |
| 1 | `app/disputes/router.py::open_dispute` | `open_dispute` | `service_request` | customer / provider |
| 2 | `app/disputes/router.py::admin_resolve_dispute` | `resolve_dispute` | `service_request` | admin |
| 3 | `app/auto_requests/reports.py::submit_report` (when request fully completes) | `mark_completed` | `car_request` | inspector |

Each attach lives at the mutation site, wrapped in a local try/except,
**after** the canonical business write succeeds. None of them can
sabotage the original flow (proven by `test_open_dispute_succeeds_when_booking_timeline_write_fails`).

### Coverage inventory document

`memory/CHRONOLOGY_COVERAGE.md` — read-only inventory:
- 11 attached mutation sites tabulated
- 6 identified-but-not-attached sites with explicit reasoning
- 6 deliberately-never-attached sites (activity noise)
- Tier-2 bridge candidates (payout signals) explicitly deferred to
  post-C.c

The inventory is documentation, not a runtime registry — no
Python dict, no decorator, no CI grep enforcer.

### Snapshot guards preserved

C.a customer + C.b provider projection contracts unchanged.
The new `open_dispute` / `resolve_dispute` rows already had
projection slots from C.a/C.b — they now produce real rendered
events when their data exists. The `mark_completed` row produced
by `reports.submit` flows through the existing provider snapshot
test path.

---

## Invariants proven (`backend/tests/test_p0bb_plus_chronology_coverage_e2e.py` — 6/6 pass)

| # | Test | Invariant |
| --- | --- | --- |
| 1 | `test_open_dispute_attaches_to_booking_timeline` | open_dispute writes `booking_timeline` row with action=`open_dispute`, scope=`service_request`, toStatus=`disputed`, meta={disputeId, reason}. **`description` MUST NOT leak.** |
| 2 | `test_open_dispute_idempotent_via_request_id` | Re-issuing same dispute open does NOT produce duplicate timeline rows (existence check + X-Request-Id dedup). |
| 3 | `test_admin_resolve_dispute_attaches_to_booking_timeline` | resolve writes row with fromStatus=`disputed`, toStatus=`resolved`, meta={disputeId, resolution, payoutAmount, refundAmount}. **`adminNote` MUST NOT leak.** |
| 4 | `test_submit_report_attaches_completion_when_request_completes` | report completion on a 1-of-1 job → car_request flips to `completed` AND `mark_completed` row appears with bookingScope=`car_request`, meta={reportId}. **Score / verdict / summary MUST NOT leak.** |
| 5 | `test_submit_report_does_not_attach_on_partial_progress` | When jobs_done < jobs_total, car_request → `report_ready` but **NO `mark_completed` row written.** Partial progress is inspector-domain signal; surfacing on booking chronology requires deliberate projection decision. |
| 6 | `test_open_dispute_succeeds_when_booking_timeline_write_fails` | Monkey-patched `observe_transition` raises → dispute STILL created (200). Best-effort discipline preserved. |

Full regression sweep (booking-chronology domain):

```
test_p0ba_booking_lifecycle_e2e.py        11/11 ✅
test_p0bb_attach_observability_e2e.py     11/11 ✅
test_p0bca_customer_timeline_e2e.py        9/9  ✅
test_p0bcb_provider_timeline_e2e.py       16/16 ✅
test_p0bb_plus_chronology_coverage_e2e.py  6/6  ✅
                                          ─────────
                                          53/53 passed, ZERO regression
```

---

## Discipline notes — what we deliberately did NOT do

- ❌ No `app/booking/registry.py` with a `MUTATION_SITES` dict.
- ❌ No `@observe` decorator. Attach remains an explicit local call
  at each site.
- ❌ No "auto-observe everything on booking_timeline" middleware.
- ❌ No bridge from `money_audit` into `booking_timeline` —
  cross-aggregate coupling deliberately deferred (Tier 2,
  post-C.c).
- ❌ No surfacing of `report_ready` — that's a new visible action
  that requires a separate projection decision per actor.
- ❌ No leakage of moderation internals (`adminNote`) or report
  content (`verdict`, `summary`, `score`) into chronology. Those
  belong in their own aggregates.

---

## Why this sequencing matters

Per the architect's brief: provider projection (C.b) was the right
pressure-test before inspector projection (C.c) because it forced
the question "what's actually attached and what isn't" *before*
the highest-density semantic surface ever ships. The three sites
attached here (open_dispute, resolve_dispute, report.complete) are
the three lifecycle-material events whose absence would have
contaminated inspector chronology with retrofit work.

C.c can now be built on **closed observability ground**.

---

## Files touched

```
app/disputes/router.py                       +35 lines  (2 attach blocks)
app/auto_requests/reports.py                 +30 lines  (1 attach block)
tests/test_p0bb_plus_chronology_coverage_e2e.py  390 lines  (new)
memory/CHRONOLOGY_COVERAGE.md                190 lines  (new)
memory/SPRINT_P0BB_PLUS_CHRONOLOGY_CLOSURE.md (this file)
```

Net code growth: ~65 lines of production code, ~390 lines of tests,
~190 lines of documentation. Tests-to-code ratio reflects the
emphasis on contract preservation.

---

## Backlog (post-B+)

- **P0.b.C.c — Inspector projection.** Highest-density semantic
  surface. Builds on clean observability ground now that disputes
  + report.complete are wired. Separate file `inspector.py` with
  own labels, own meta whitelist, own tone vocabulary. Do not
  share with C.a / C.b.
- **Tier-2 payout visibility bridge** (payout_pending / payout_released)
  — only after C.c lands. Even then, narrow signals only, no
  internal finance lifecycle.
- **Admin operator projection** (P0.b.C.d) — permissive but still
  curated. Admin should see `internalNotes` but never raw
  `money_audit` row ids or stripe webhook payloads.

# B4.3-A.1 — Reconciliation audit (read-only)

**Date:** 2026-05-22
**Sprint:** B4.3-A.1
**Status:** ✅ CLOSED — 57/57 smoke assertions green, live DB report produced
**Predecessor:** B4.3-A.2 (TOCTOU status hardening — stable write-surface)
**Stays in the same family:** B4.3-A-recovery audit doc

---

## 1. Scope (held narrow per sprint brief)

Read-only audit over `service_payments`:

  → compute escrow buckets
  → detect divergence
  → report only

Anti-goals (held verbatim from sprint brief):

  * ❌ auto-fix
  * ❌ backfill
  * ❌ new balance rows
  * ❌ reserved ledger
  * ❌ boot replay
  * ❌ mutation hooks

Acceptance criteria (all met):

  * ✅ paid / disputed / in_review / disputed_hold counted as outstanding escrow
  * ✅ released / refunded / resolved_partial excluded OR separately bucketed
  * ✅ unknown statuses flagged in `unknown` bucket
  * ✅ totals by provider / customer / paymentId where possible
  * ✅ audit output in `/app/audit/` (JSON + Markdown)
  * ✅ pytest-style synthetic smoke shipped and green

## 2. Files

**NEW** — pure module + DB read:

* `app/payments/reconciliation.py` (~330 LOC, 1 file).
  - Frozen status taxonomy (`STATUS_BUCKETS`, `KNOWN_STATUSES`)
    inventoried from existing code post-B4.3-A.2. New statuses fall
    into `unknown` bucket — not silently absorbed.
  - `classify_status(status)` — pure, no DB.
  - `compute_buckets(rows)` — pure aggregator → 6 buckets ×
    {statuses, count, gross/payout/refund by currency}.
  - `detect_divergences(rows)` — 14 named codes, each pure.
  - `collect_top_n(rows, group_key, bucket_filter, n)` — pure ranking.
  - `generate_report(db, *, limit=None)` — async, **READ-ONLY**:
    a single `find({}, projection)` cursor, no `insert_one` /
    `update_one` / `delete_one` anywhere in the module.

**NEW** — CLI:

* `scripts/run_reconciliation_audit.py` — invokes `generate_report`,
  writes timestamped `reconciliation_<YYYYMMDD_HHMMSS>.json` and `.md`
  to `/app/audit/` (configurable via `--out-dir`). Stdout summary
  unless `--quiet`. Supports `--limit N` for big-collection sampling.

**NEW** — smoke:

* `test_reconciliation_audit_smoke.py` — two phases, **57 assertions**:
  - **PHASE A** pure-functions over a synthetic 17-row dataset
    covering every bucket (incl. `unknown`) and 9 divergence codes.
    No DB. Asserts:
    * classify_status correctness across 8 status literals
    * compute_buckets counts per bucket
    * sum-of-gross by currency for outstanding + pre_escrow
    * sum-of-payout for settled bucket
    * every expected divergence code triggered
    * no false-positives on clean rows
    * KNOWN_STATUSES completeness
    * STATUS_BUCKETS are disjoint
    * top-N ranking deterministic
  - **PHASE B** `generate_report()` against a seeded test DB row set,
    asserting:
    * collection size unchanged before/after report (read-only proof)
    * report shape (all 8 expected keys present)
    * `totalDocs` matches DB count
    * divergence codes from seed are present in live report
    * bucket counts ≥ seeded floor
    * cleanup `delete_many({_smoke_seed_tag: ...})` deletes exactly
      what was seeded (cleanup attribution belongs to the smoke, not
      the audit module)

**NEW** — first live artefacts (`/app/audit/`):

* `reconciliation_20260522_125754.json` (1.3 KB)
* `reconciliation_20260522_125754.md`   (1.0 KB)
  — empty DB report (no `service_payments` rows in current preview),
    serving as the structural baseline. All buckets count=0, no
    divergences. Re-running on a quiet DB should reproduce shape.

## 3. Bucket taxonomy (frozen here)

| Bucket | Statuses | Semantics |
|---|---|---|
| `outstanding_escrow` | `paid`, `disputed`, `disputed_hold`, `in_review` | Money landed on platform, not yet committed to either direction. Platform liability. |
| `settled_to_provider` | `released`, `resolved_partial` | Money committed in provider direction (full or partial). |
| `refunded_to_customer` | `refunded` | Money returned (or scheduled to return) to customer. |
| `terminal_failure` | `failed`, `transfer_reversed` | Money never landed OR was reversed by Stripe. |
| `pre_escrow` | `pending`, `requires_payment_method` | Payment row exists; customer hasn't paid yet. |
| `unknown` | _everything else_ | New / drifted status literals — visible, never silently absorbed. |

These 5 + 1 buckets are deliberately disjoint (smoke asserts this).

## 4. Divergence codes (frozen here)

| Code | Meaning |
|---|---|
| `UNKNOWN_STATUS` | status not in `KNOWN_STATUSES` |
| `RELEASED_NO_TIMESTAMP` | `status=released` but `releasedAt` missing |
| `REFUNDED_NO_TIMESTAMP` | `status=refunded` but `refundedAt` missing |
| `DISPUTED_NO_TIMESTAMP` | `status=disputed*` but `disputedAt` missing |
| `PAID_HAS_RELEASE_FIELDS` | `status=paid` but `releasedAt/releasedBy` set (stale partial transition) |
| `PAID_HAS_REFUND_FIELDS` | `status=paid` but `refundedAt` set |
| `DISPUTED_HAS_RELEASE` | `status=disputed` but `releasedAt` set (resolution started, status didn't flip) |
| `RELEASED_NO_PAYOUT` | `status=released` but `providerPayout <= 0` |
| `PARTIAL_MISSING_FIELDS` | `status=resolved_partial` but `partialPayoutAmount` or `refundAmount` missing |
| `PAID_AFTER_RELEASED` | `paidAt > releasedAt` (impossible chronology) |
| `MISSING_CUSTOMER` | `customerId` missing/empty |
| `MISSING_PROVIDER` | `providerId` missing/empty |
| `NEGATIVE_AMOUNT` | any monetary field < 0 |
| `GROSS_PAYOUT_REFUND_DRIFT` | conservation breach: `gross ≉ payout + refund + commission` (tolerance 0.01) |
| `CURRENCY_MISSING` | `currency` field absent |

Each detector is a pure function. None of them write anywhere. None of
them throw. New codes appear by adding a new branch to `detect_divergences`
and a new smoke row — no framework needed.

## 5. Money-correctness invariants the report makes machine-checkable

Once a non-empty production dataset exists, the JSON output exposes:

  * Σ gross by currency, per bucket
  * Σ provider payout by currency, per bucket
  * Σ refund by currency, per bucket
  * top-10 providers and customers by outstanding gross

This is enough to compute (off-line) the targeted invariant from the
sprint brief follow-on:

```
outstanding_escrow.gross ≈ paid_in - released - refunded - resolved_partial.refund
```

deliberately NOT computed by this module (we don't pull `payment_events`
or `money_audit`). Each truth layer reports independently, the operator
correlates. This preserves the 3-truth-layer doctrine.

## 6. Doctrinal compliance

* **No mutation.** The DB code path is one `find({}, projection)` cursor.
  Smoke Phase B asserts `count_documents` is unchanged before/after.
* **No new collection.** No new field. No new index.
* **No new status literal.** `KNOWN_STATUSES` is inventoried from
  existing code — never invented.
* **No coupling to writers.** Module is freestanding. No imports from
  `writer.py`, `realtime.py`, `escrow/router_payments.py`, etc.
* **No boot replay.** Module is invoked explicitly via the CLI script
  or imported pure functions. No `@app.on_event`, no lifespan hook.
* **No new chronology kinds.** No `payment_events` appends. No
  `money_audit` appends. No `:rejected` rows.

## 7. Operational use

* Re-run anytime:
  `python /app/backend/scripts/run_reconciliation_audit.py`
* Quiet (for cron / CI):
  `... --quiet`
* Big collection:
  `... --limit 10000`
* Output directory:
  `... --out-dir /tmp/recon`

The first run on the current preview slice (empty `service_payments`)
produced a baseline showing all buckets at 0 — proving the empty-DB
edge case is handled cleanly and the artefact format is correct.

## 8. What this sprint did NOT close (deliberately)

* **Auto-remediation for divergences.** Each code is detection-only.
  A divergence record is a structured description; the operator decides
  what to do. Some are benign (legacy rows pre-B4.3-A.2), some need a
  one-off patch — but that decision is human, not framework.
* **Cross-collection reconciliation** between `service_payments` and
  `payment_events` and `money_audit`. Each truth layer is audited
  independently; correlation requires a separate sprint.
* **Stripe-side reconciliation** against `stripe_webhook_events`.
  Same reason — separate sprint.
* **Historic drift backfill.** No data is rewritten.

## 9. Next pickable steps (not in this sprint)

* **Cron / supervisor hook** to run the audit nightly and diff against
  the prior report. Strictly opt-in.
* **Cross-layer reconciliation** (service_payments ↔ payment_events ↔
  money_audit). Same read-only discipline.
* **Stripe drift detector** (stripe_webhook_events ↔ service_payments).
* **Admin endpoint** wrapping `generate_report(db)` for in-UI viewing,
  if/when an admin observability surface needs it.
* **B4.3-B reservation model** — now that A.2 hardened writes and A.1
  produces a measurable picture, the question "do we actually need an
  independent reservation ledger?" can be answered with data instead of
  speculation. Currently the answer is "probably not yet".

# B4.3-A.3 — Nightly reconciliation supervisor hook

**Date:** 2026-05-22
**Sprint:** B4.3-A.3 (operational cadence)
**Status:** ✅ CLOSED — 15/15 pure-function smoke green, E2E HIGH-branch verified
**Predecessor:** B4.3-A.1 (read-only audit module + CLI)
**Stays in the same family:** B4.3-A money-domain audit doctrine

---

## 1. Scope (held narrow per user brief)

Thin orchestration layer above `app.payments.reconciliation.generate_report`:

  → run the existing audit on a cadence
  → if divergences > 0, emit ONE structured warning carrying severity + artefact paths
  → operator opens the artefact and decides

Anti-goals (held verbatim from brief):

  * ❌ NO dashboards
  * ❌ NO auto-fix
  * ❌ NO websocket / push / admin UI
  * ❌ NO alerting abstraction (stdlib `logging` only)
  * ❌ NO new event in `structured_log.EVENTS` (that whitelist is for money events)
  * ❌ NO new collection / index / field
  * ❌ NO coupling to `writer.py` / `realtime.py` / webhooks
  * ❌ NO new bucket / divergence code (taxonomy stays frozen in A.1)

Doctrinal alignment with A.1: this layer is **detection-only**, just like the
audit it wraps. A "structured warning" is a single stdlib log line carrying
the artefact path. The artefact, not the log line, is the source of truth.

---

## 2. Files

**NEW** — runner:

* `scripts/reconciliation_supervisor.py` (~240 LOC, 1 file).
  - `classify_severity(divergence_counts)` — pure, no DB. Returns
    `"NONE" | "WARN" | "HIGH"`. HIGH iff any of `NEGATIVE_AMOUNT` or
    `GROSS_PAYOUT_REFUND_DRIFT` is present.
  - `_run_once(limit, out_dir)` — one-shot: invokes `generate_report`,
    writes `/app/audit/reconciliation_<UTC>.{json,md}` (re-uses
    `render_markdown` from `run_reconciliation_audit.py` to keep the
    artefact format byte-identical), classifies severity, emits ONE
    `INFO` "completed" envelope, plus ONE `WARN`/`ERROR` "divergences_
    detected" envelope if severity ≠ NONE.
  - `_run_loop(...)` — supervisor-friendly long-running mode:
    `--loop --interval-seconds N` or `--loop --hour HH` (anchored to a
    daily UTC clock hour). Never crashes on audit failure — logs a
    `reconciliation.audit.failed` envelope and waits for next slot.
  - CLI: `--limit N`, `--out-dir PATH`, `--loop`, `--interval-seconds`,
    `--hour HH`. Default = one-shot.
  - Exit code: always 0 in one-shot mode (this is detection-only).

**NEW** — sample supervisor program (opt-in, NOT auto-installed):

* `scripts/reconciliation_supervisor.conf` —
  `autostart=false`, `autorestart=true`, runs `--loop --hour 3` (03:00 UTC
  daily). Operator copies it to `/etc/supervisor/conf.d/` and runs
  `supervisorctl reread && update && start`. Header of the file
  documents grep cheat-sheet and disable procedure.

**NEW** — smoke (pure, no DB):

* `test_reconciliation_supervisor_smoke.py` — **15 assertions**:
  - empty mapping → NONE
  - WARN-only codes (single + mixed) → WARN
  - each HIGH code in isolation → HIGH
  - HIGH alongside WARN → HIGH
  - both HIGH codes together → HIGH
  - `HIGH_SEVERITY_CODES` is `frozenset({NEGATIVE_AMOUNT, GROSS_PAYOUT_REFUND_DRIFT})`
  - classifier is idempotent (same input twice = same output)
  - classifier does not mutate its input
  - forward-compat: unknown future divergence code → WARN, not HIGH

**E2E proof (no committed test)**:

* Seeded one synthetic `service_payments` row with `providerPayout=-5.0`
  → `_run_once` against live DB produced TWO log envelopes:
    - `reconciliation.audit.completed` (INFO, severity=HIGH)
    - `reconciliation.audit.divergences_detected` (ERROR, severity=HIGH,
      `highSeverityCodes:["NEGATIVE_AMOUNT"]`, artefact paths populated)
  → seed row deleted in `finally:` block; collection count restored.
  Read-only doctrine of the audit module preserved.

---

## 3. Severity classifier (frozen here)

| Code | Severity | Rationale |
|---|---|---|
| `NEGATIVE_AMOUNT` | **HIGH** | Impossible monetary value present |
| `GROSS_PAYOUT_REFUND_DRIFT` | **HIGH** | Conservation breach |
| `UNKNOWN_STATUS` | WARN | New status literal — visible, not money-breaking |
| `RELEASED_NO_TIMESTAMP` | WARN | Stale field state |
| `REFUNDED_NO_TIMESTAMP` | WARN | Stale field state |
| `DISPUTED_NO_TIMESTAMP` | WARN | Stale field state |
| `PAID_HAS_RELEASE_FIELDS` | WARN | Partial transition stale |
| `PAID_HAS_REFUND_FIELDS` | WARN | Partial transition stale |
| `DISPUTED_HAS_RELEASE` | WARN | Resolution started, status didn't flip |
| `RELEASED_NO_PAYOUT` | WARN | Status mismatch, not money-breaking on its own |
| `PARTIAL_MISSING_FIELDS` | WARN | Missing context |
| `PAID_AFTER_RELEASED` | WARN | Chronology impossible — but doesn't change totals |
| `MISSING_CUSTOMER` | WARN | Identity drift |
| `MISSING_PROVIDER` | WARN | Identity drift |
| `CURRENCY_MISSING` | WARN | Aggregation hole |
| _any future code_ | WARN | Forward-compat default |

Adding a new HIGH code = a deliberate edit to `HIGH_SEVERITY_CODES`
(frozenset literal). Smoke phase asserts current contents exactly.

---

## 4. Log envelope contract (frozen here)

Two envelope shapes, both stdlib `logging` JSON one-liners. Both go to
stdout, captured by supervisor → `reconciliation.out.log`.

### 4.1 Per-run baseline (ALWAYS emitted)

```json
{
  "ts": "2026-05-22T15:06:20.727027+00:00",
  "event": "reconciliation.audit.completed",
  "level": "INFO",
  "scope": "service_payments (READ-ONLY snapshot)",
  "totalDocs": 0,
  "limit": null,
  "severity": "NONE",
  "totalDivergences": 0,
  "artefactJson": "/app/audit/reconciliation_20260522_150620.json",
  "artefactMd":   "/app/audit/reconciliation_20260522_150620.md"
}
```

Purpose: log scrape can prove the cadence ran without parsing
artefacts. `severity` is one of `NONE` / `WARN` / `HIGH`.

### 4.2 Per-run anomaly (emitted only when severity ≠ NONE)

```json
{
  "ts": "2026-05-22T15:06:43.699033+00:00",
  "event": "reconciliation.audit.divergences_detected",
  "level": "ERROR",
  "severity": "HIGH",
  "totalDivergences": 1,
  "countsByCode": {"NEGATIVE_AMOUNT": 1},
  "highSeverityCodes": ["NEGATIVE_AMOUNT"],
  "artefactJson": "/app/audit/...json",
  "artefactMd":   "/app/audit/...md"
}
```

`level=ERROR` when severity=HIGH; `level=WARN` when severity=WARN.
No stack trace (this is detection, not an exception). No retry. No
fan-out.

### 4.3 Loop-mode scheduling envelope

```json
{
  "ts": "...",
  "event": "reconciliation.audit.scheduled",
  "level": "INFO",
  "nextRunInSeconds": 86400
}
```

### 4.4 Loop-mode failure envelope

```json
{
  "ts": "...",
  "event": "reconciliation.audit.failed",
  "level": "ERROR",
  "error": "<truncated to 500 chars>"
}
```

Loop never exits on failure — next slot retries. One-shot mode raises
on failure (operator / supervisor sees the traceback).

---

## 5. Why this layer is justified

A.1 gave us deterministic read-audit.
A.2 hardened the write surface (TOCTOU).
A.3 closes the loop with **operational cadence**, nothing more.

What it explicitly does NOT do — and why that is correct now:

* **No cross-layer reconciliation** (service_payments ↔ payment_events ↔
  money_audit). Each truth layer is independent by doctrine; correlation
  is a separate sprint with a different shape.
* **No Stripe drift detector**. Different read source, different cadence,
  different failure mode — belongs in its own sprint.
* **No admin endpoint** wrapping `generate_report`. Operator workflow is
  already covered by file artefact + log scrape; an HTTP wrapper is a
  premature surface.
* **No auto-fix / backfill / reserved ledger / boot replay.**

---

## 6. Doctrinal compliance

* **No DB mutation.** Supervisor only calls `generate_report` (read-only
  per A.1). Its own footprint is file writes to `/app/audit/` and stdout
  log lines.
* **No new collection / field / index.**
* **No new event in `structured_log.EVENTS`.** Deliberately uses stdlib
  `logging` instead, so the money-event whitelist stays bounded. The
  reconciliation supervisor's events are operational, not transactional.
* **No coupling.** Supervisor imports two things only:
  `app.payments.reconciliation.generate_report` (the audit) and
  `scripts.run_reconciliation_audit.render_markdown` (artefact format).
  Both are inputs to the supervisor, not outputs.
* **Strictly opt-in.** Sample supervisor program ships with
  `autostart=false`; not copied to `/etc/supervisor/conf.d/` by default.
  Until the operator explicitly enables it, the only way to run the
  hook is the same explicit CLI call as A.1.
* **Forward-compat severity default.** A future new divergence code is
  WARN until someone deliberately escalates it to HIGH.

---

## 7. Operational use

```bash
# One-shot (verify cadence locally, run from CI, fire from external cron):
python /app/backend/scripts/reconciliation_supervisor.py

# Sample big collection:
python /app/backend/scripts/reconciliation_supervisor.py --limit 10000

# Enable supervisor-managed nightly run (03:00 UTC):
sudo cp /app/backend/scripts/reconciliation_supervisor.conf \
        /etc/supervisor/conf.d/
sudo supervisorctl reread && sudo supervisorctl update
sudo supervisorctl start reconciliation-supervisor

# Grep cheat-sheet (one per cadence + one per anomaly):
grep '"event":"reconciliation.audit.completed"'             /var/log/supervisor/reconciliation.out.log
grep '"event":"reconciliation.audit.divergences_detected"'  /var/log/supervisor/reconciliation.out.log
grep '"severity":"HIGH"'                                    /var/log/supervisor/reconciliation.out.log
```

---

## 8. Next pickable steps (deliberately NOT in this sprint)

After observing real cadence output on a non-empty production dataset, the
operator can decide:

* **Cross-layer reconciliation** (service_payments ↔ payment_events
  ↔ money_audit). Same read-only discipline. Same artefact contract.
  Separate code module, separate supervisor.
* **Stripe drift detector** (stripe_webhook_events ↔ service_payments).
  Different read source, different cadence. Separate sprint.
* **Anomaly history file** — append severity+counts to a single rolling
  file at `/app/audit/_history.jsonl` for trend grep. Only worth doing
  once a real prod dataset exists to trend against.
* **B4.3-B reservation ledger** — A.1 + A.2 + A.3 together produce
  enough measurement to answer "do we actually need one?" with data
  instead of speculation. Current answer remains: **probably not yet.**

---

## 9. Sprint output summary

| Artefact | Path |
|---|---|
| Runner | `/app/backend/scripts/reconciliation_supervisor.py` |
| Sample supervisor conf (opt-in) | `/app/backend/scripts/reconciliation_supervisor.conf` |
| Smoke (15 assertions, pure) | `/app/backend/test_reconciliation_supervisor_smoke.py` |
| Closure doc (this file) | `/app/memory/B4_3_A_3_reconciliation_supervisor_closure_2026_05_22.md` |
| First artefacts produced | `/app/audit/reconciliation_20260522_150620.{json,md}` |

Sum of net new code: ~240 LOC runner + ~100 LOC smoke. Zero changes to
`app.payments.reconciliation`. Zero changes to `structured_log.EVENTS`.
Zero changes to supervisor config files (sample only).

# `app.workers.receipts_poll` — Ownership Boundary

**Phase 3D PR-01 · Tier A carve-out · move-only extraction**

Source of truth before extraction: `app/notifications/receipts.py:288`
Source of truth after extraction:   `app/workers/receipts_poll/loop.py:receipts_poll_loop`

This package owns exactly one worker: the customer-notify receipts
poller (Sprint Customer-Notify-3A Phase B).

## Single writer owner

`receipts_poll_loop` is the **sole writer** to its owned collection.
No other worker, handler, or background task writes to the same key
space. Cross-checked against `PHASE_3C_WORKER_REGISTRY_AND_GLOBALS.md`
§2 row 15 and §9 Tier A row 1.

## Owned collections

| Collection | Access pattern | Invariant |
|------------|----------------|-----------|
| `notification_delivery_lifecycle` | `update_one` **in-place only** (filter on `providerMessageId + channel + provider`) | **one lifecycle row = one delivery attempt** — NEVER `insert_one`, NEVER `delete_one` |

## Read collections

| Collection | Access pattern |
|------------|----------------|
| `notification_delivery_lifecycle` | `find` for candidates (time-windowed: 15 min ≤ age ≤ 24h, with 5 min recheck backoff) |

## Side effects

| Channel | Behaviour |
|---------|-----------|
| Outbound HTTP | `POST https://exp.host/--/api/v2/push/getReceipts` (Expo getReceipts API; pure transport, no retries) |
| Auth env | `EXPO_ACCESS_TOKEN` (optional) injected as `Authorization: Bearer …` if set |
| Logging | `logging.getLogger("app.workers.receipts_poll.loop")` — log lines: `cnotify receipts loop started`, `cnotify receipts poll: checked=… delivered=… …`, `cnotify receipts transport_error`, `cnotify receipts http_<N>`, `cnotify receipts bad_response`, `cnotify receipts enrich failed`, `cnotify receipts loop cancelled`, `cnotify receipts loop iteration failed` |
| Realtime | **none** — does not emit through `ctx.emit.*` |
| Redis | **none** — does not touch Redis state |
| Metrics | **none** — does not increment any counter |

## Cadence

| Constant | Value | Where |
|----------|-------|-------|
| Loop tick | `DEFAULT_INTERVAL_S = 180.0s` | `contracts.py` |
| Candidate min age | `RECEIPT_MIN_AGE_SECONDS = 900s` (15 min) | `contracts.py` |
| Candidate max age | `RECEIPT_MAX_AGE_SECONDS = 86400s` (24h) | `contracts.py` |
| Per-row recheck backoff | `RECEIPT_RECHECK_BACKOFF_SECONDS = 300s` (5 min) | `contracts.py` |
| Batch size | `BATCH_SIZE = 100` (Expo per-request limit) | `contracts.py` |

## Restart guarantees

| Scenario | Behaviour |
|----------|-----------|
| Process restart mid-poll | In-flight `update_one` is atomic at Mongo level; either applied or not. No partial write. |
| Process restart after partial batch | Remaining candidates re-selected on next tick; `receiptCheckedAt` records progress |
| Receipt comes back "ok" twice | Second update writes the same `deliveredAt` value; downstream filter `providerReceiptStatus != "ok"` prevents redundant re-poll on subsequent ticks |
| Receipt comes back "error" | `providerReceiptStatus = "error"`, `providerReceiptError = <message>`; `deliveredAt` stays null (NOT `failedAt` — that belongs to the SEND attempt) |
| HTTP transport failure | Logged as `cnotify receipts transport_error: …`; loop continues; next tick retries the same candidates after backoff window |
| Loop body raises | Caught + logged as `cnotify receipts loop iteration failed: …`; loop never dies |
| `asyncio.CancelledError` | Logged as `cnotify receipts loop cancelled`; loop returns gracefully |

## Hard invariants (do not regress)

1. **One lifecycle row = one delivery attempt** — the entire reconciliation flow is purely enrichment of an existing row.
2. **Update-only writes** — `_enrich_row` uses `update_one`; no `insert_one`, no `delete_one`, no aggregation pipeline writes.
3. **Channel/provider scoping** — every update filter includes `channel="push" AND provider="expo"`; immune to future drift if email/sms acquire receipt semantics with a different shape.
4. **Cadence stability** — 180s tick; do not tune without a separate cadence-change PR.
5. **No realtime, no Redis, no metrics** — this worker is observational over Mongo only.

## Registration

Registered exactly once at FastAPI lifespan startup via:

```python
from app.workers.receipts_poll import register as register_receipts_poll
register_receipts_poll(app)
```

The hook stores the task at `app.state.cnotify_receipts_task` (unchanged
attribute name — preserves any future shutdown drain logic that may
reference it).

## Public surface (re-exports from package root)

| Symbol | Purpose |
|--------|---------|
| `receipts_poll_loop(db, interval_s=180.0)` | Long-running task body |
| `poll_receipts_once(db)` | Single-pass entrypoint (used by admin manual-trigger surface in `app/notifications/customer_pipeline.py`) |
| `register(app)` | Lifespan registration hook |
| `DEFAULT_INTERVAL_S` + 5 cadence constants | Read-only references for diagnostic surfaces |

## Backwards-compatible re-export

The pre-extraction import path remains valid for one PR cycle (per
Phase 3D §1 P-10):

```python
# Still works (re-exports from app.workers.receipts_poll):
from app.notifications.receipts import poll_receipts_once, receipts_poll_loop
```

Removal of the shim is deferred to a follow-up PR; it is **not** in
scope for PR-01.

## Anti-scope (NOT in this package — intentionally)

- ❌ Retries / dead-letter queue / resend logic
- ❌ Bounce handling (Notify-3B owns that)
- ❌ Orchestrator-style scheduling
- ❌ Per-token exponential backoff (poll is global, time-windowed)
- ❌ Email/SMS receipt semantics (different channels, different package)
- ❌ Push device registration / token rotation

## Sibling references

- Lifecycle row producer: `app/notifications/lifecycle_email.py` (different channel, owns its own lifecycle rows)
- Lifecycle projection: `app/notifications/projector.py` (read-only customer-facing surface)
- Admin manual-trigger surface: `app/notifications/customer_pipeline.py` (calls `poll_receipts_once`)
- Frozen semantics doctrine: `/app/memory/customer_notify_3a_frozen_2026_05_15.md`

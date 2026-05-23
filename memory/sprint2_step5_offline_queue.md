# Sprint 2 · Step 5 — Offline Queue (R2)

Foundation Layer closes with this step. The inspection runtime now survives
tunnel drop, underground parking, app restart, OS kill, flaky LTE, and partial
upload failure without losing inspection state or media intent.

## Scope (locked)
- **single-device durable offline replay only**
- NOT collaborative sync, NOT CRDT, NOT websocket reconciliation.

## Architecture

### Frontend
| File | Role |
|------|------|
| `frontend/src/inspector/runtime/queue.ts` | Core primitives — `enqueue / replay / markDone / markFailed / backoffFor / loadQueue / persistQueue` + `subscribeQueue`. AsyncStorage key `inspector:offline-queue:v1`. |
| `frontend/src/inspector/runtime/SyncStatusBar.tsx` | Persistent UI surface + `useQueueController()` hook (NetInfo + AppState listeners, auto-replay on reconnect/foreground). |
| `frontend/src/inspector/media/uploader.ts` | **Migrated** — now a thin façade over `queue.ts`. `queueAndUpload` enqueues `media_upload`; `loadPending` derives `PendingItem[]` from queue snapshot. Public signatures unchanged. |
| `frontend/app/inspector/job/[id]/runtime.tsx` | Renders `SyncStatusBar`. `submitRuntime` now `enqueue('report_submit')` + triggers replay; UX never blocks on network. |
| `frontend/app/inspector/job/[id]/draft.tsx` | Renders `SyncStatusBar`. `generate()` checks NetInfo; offline → `enqueue('draft_generate')` + Russian copy "Черновик будет сформирован после подключения". |
| `frontend/app/inspector/job/[id]/index.tsx` | Renders `SyncStatusBar` so the bar is visible during the whole inspection session. |

### Backend
| File | Role |
|------|------|
| `backend/app/inspector/offline_replay.py` | `POST /api/inspector/offline-replay/log` (Bearer-required, audit-only write) + `GET /api/admin/offline-replay/recent?jobId&kind&result&limit` (admin-gated, KPIs). New collection: **`offline_replay_log`**. |
| `backend/server.py` | Registers the new router. |
| `backend/app/core/lifespan.py` | Ensures indexes on startup: `createdAt desc`, `(jobId, createdAt desc)`, `(kind, result)`. |
| `backend/prod_readiness.py` | `IDEMPOTENCY_TARGETS` extended with `/api/inspector/jobs/` so every `media/upload`, `draft`, `report` POST is de-duplicated by `Idempotency-Key`. |

## Queue item shape
```json
{
  "id": "q_<uuid>",
  "kind": "media_upload|draft_generate|report_submit",
  "jobId": "...",
  "createdAt": "ISO",
  "attempts": 0,
  "nextRetryAt": "ISO",
  "status": "pending|running|failed|done",
  "idempotencyKey": "...",
  "payload": { ... }
}
```

## Replay policy
- Triggered by **NetInfo reachable** transitions, **AppState → active**, and
  **manual retry** from `SyncStatusBar`.
- **Sequential** (concurrency = 1). No parallel replay.
- Backoff: **5s · 15s · 60s · 5m · 15m**; status → `failed` after 5 attempts.
- Every replay sends `Idempotency-Key`; server middleware returns cached 2xx or
  `409 IDEMPOTENCY_IN_PROGRESS` — duplicate writes are physically impossible.

## Failure UX
- Permanently failed items remain visible in `SyncStatusBar` sheet.
- Explicit **«Повторить»** button → resets attempts to 0, kicks replay.
- Explicit **«Удалить»** button → drops item from queue (user-confirmed loss).

## Recovery on cold restart
- `loadQueue()` on import demotes any `running` items left over from a crash
  back to `pending` (idempotency key still de-dupes server-side if the write
  did land before the crash).
- Replay resumes automatically when `isOnline = true`.

## Audit (offline_replay_log)
Every replay attempt — success or terminal failure — gets a record:
```json
{ "queueId":"...", "kind":"...", "jobId":"...", "attempts":3,
  "result":"success|failed", "latencyMs":1234, "createdAt":"..." }
```
Plus passive `userAgent` / `ip` for cohort triage.

`GET /api/admin/offline-replay/recent` exposes the last N entries with
counts `{total, success, failed}` and `latencyMs.p50/p95`.

## Constraints honoured
| Constraint | How |
|---|---|
| Replay survives app restart | AsyncStorage persistence + `loadQueue()` on import + `running → pending` demotion. |
| Queue corruption never crashes runtime | Each item validated by `isValidItem`; malformed entries silently filtered out. |
| Replay loop stops on logout | `stopReplay()` + controller `paused: true`. |
| Memory bounded | Queue cap = **500**; oldest `done`/`failed` evicted first. |
| Loss of work prevented | `failed` items remain visible; no silent discard. |

## Verification

### Backend (13/13 tests green — `/app/test_reports/iteration_1.json`)
- `POST /api/inspector/offline-replay/log` — 401 without bearer, 200 with any bearer, exact persistence, invalid `kind` coerced to `"unknown"`.
- `GET /api/admin/offline-replay/recent` — admin-only, KPIs correct, filters by `jobId/kind/result` work, `_id` excluded.
- Indexes verified: `createdAt desc`, `(jobId, createdAt desc)`, `(kind, result)`.
- Idempotency middleware covers `/api/inspector/jobs/:id/{draft,report}` — same `Idempotency-Key` returns cached 2xx with `x-idempotent-replay=true` OR 409.
- Regressions: `/api/health`, admin login intact.

### Frontend (manual flow, device-bound)
Per spec § 16, the canonical offline scenario is:
1. Go offline → 2. Upload media → 3. Generate draft → 4. Submit report → 5. Kill app → 6. Reopen → 7. Queue restored → 8. Reconnect → 9. Replay succeeds sequentially → 10. No duplicates → 11. Timeline populated normally → 12. Failed replay visible + retryable.

The `SyncStatusBar` makes each of these states visible. End-to-end inspector-on-device verification is out of scope for the preview env.

## Security fix shipped during testing
`offline_replay.py:119` — `verify_admin_token(request)` was missing `await`.
The async coroutine never executed, so the admin-only audit endpoint was
publicly accessible. **Fixed**; testing agent confirmed 13/13 green and the
`RuntimeWarning` cleared from `backend.err.log`.

Codebase-wide grep shows `offline_replay.py` was the only direct (non-`Depends`)
call site — all other call sites use `Depends(verify_admin_token)` which
FastAPI awaits correctly.

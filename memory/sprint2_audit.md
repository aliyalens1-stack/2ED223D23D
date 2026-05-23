# Sprint 2 Foundation — Audit Report

**Date:** 2026-05-11
**Scope:** Timeline · Contact Unlock · Media Upload · Draft Intelligence · Offline Queue
**Method:** static read of `backend/app/`, `frontend/app/`, `shared/domain/`, live mongo introspection

---

## 0. TL;DR — verdict per layer

| Layer | Status | Honest assessment |
|---|---|---|
| 1. Timeline Engine | 🟡 **40% — spine exists, fan-in missing** | canonical event schema + append API + query API written; **but no lifecycle endpoint calls it**, so `timeline_events` collection is empty in production. |
| 2. Contact Unlock | 🟡 **70% — flow works but double-writes state** | 3-state ladder coded, masking correct, audit trail kept. Two architectural conflicts with lifecycle owner. |
| 3. Media Upload | 🟡 **50% — base happy-path only** | item-bound photos work via base64. **No retry, no pending state, no resume, no MediaRepository abstraction, no optimistic UI**. Pure happy-path. |
| 4. Draft Intelligence | 🔴 **0% — not started** | Zero AI integration. Inspector types every field by hand. No verdict synthesis, no contradiction check, no missing-evidence detection. |
| 5. Offline Queue | 🟡 **20% — per-screen autosave only** | Runtime reducer persists state to AsyncStorage every ~1s. **No upload queue, no replay, no retry, no sync badges, no conflict handling**. Will break in tunnel/parking. |

**Foundation is NOT built.** Two layers look implemented but are functionally dead (Timeline) or conflict-prone (Contact). Three layers are missing or stubs.

---

## 1. What already exists (real, working code)

### Timeline Engine
- `backend/app/inspector/timeline.py` (163 LOC)
  - `CANONICAL_KINDS` dict — 14 event kinds with `(severity, actor, humanReadable)` defaults
  - `append_event(...)` — async helper, idempotent best-effort, writes to `timeline_events` collection + mirrors into `system/realtime.py` ring buffer
  - `POST /api/inspector/timeline/append` — manual append endpoint (auth-gated by `get_user_id_required`)
  - `GET  /api/inspector/timeline` — list by inspectorId+jobId+kinds+limit
- Severity model: `info | success | warning | critical`
- Actor model: `inspector | customer | qa | system | provider`
- Realtime mirror: `record_event` pushes to in-memory deque (500 events), consumed by admin/web via `GET /api/realtime/events?since=...`

### Contact Unlock
- `backend/app/inspector/contact.py` (195 LOC)
- 3 states: `hidden | masked | revealed`
- Phone masking via regex (`+••••••1234`), name masking (first + initials)
- `GET  /api/inspector/jobs/{job_id}/contact` — returns stage-appropriate payload, never leaks
- `POST /api/inspector/jobs/{job_id}/contact/reveal` — sets job status + writes `contact_reveal_log` + mirrors to timeline
- Trigger map: `accepted | on_route | arrived` → respective job status
- Audit trail: `db.contact_reveal_log` (jobId, inspectorId, trigger, newStage, timestamp)

### Media Upload
- `backend/app/auto_requests/job_media.py` (181 LOC) — **JOB-scoped** (used during inspection)
  - `POST   /api/inspector/jobs/{job_id}/media` — upload photo/video tied to category
  - `GET    /api/inspector/jobs/{job_id}/media` — list with stats (photos, videos, byCategory)
  - `DELETE /api/inspector/jobs/{job_id}/media/{media_id}`
  - `GET    /api/inspector/jobs/{job_id}/media/{media_id}` — public blob serve
  - Storage: base64 in `inspection_job_media`
  - Categories: exterior/interior/engine/documents/damage/odometer/vin/test_drive/other
  - Limits: 8 MB photo, 25 MB video; MIME allowlist
- `backend/app/auto_requests/media.py` (159 LOC) — **REPORT-scoped** (after submit)
  - service-layer (no router; called from `router_media.py`)
  - Storage: base64 in `inspection_media`
  - `can_user_view_media` ACL: inspector OR parent-request customer OR admin
- Frontend `frontend/app/inspector/job/[id]/index.tsx`:
  - `uploadMedia(category, mediaType)` via expo-image-picker, awaits POST, refreshes list
  - **No queue, no retry, no optimistic UI, no compression**

### Runtime + Per-screen autosave (proto-offline)
- `frontend/src/inspector/runtime/reducer.ts` (245 LOC) — pure reducer
- `frontend/app/inspector/job/[id]/runtime.tsx` (749 LOC) — uses reducer
  - HYDRATE from AsyncStorage on mount
  - Debounced setItem on every state change (~1s)
  - Per-item severity (auto for paint depth thresholds 300µm/500µm)
  - Photo URIs stored as local strings (NOT uploaded to server)
  - **NB:** R1 only supports `body_paint` section. The other 14 sections are stubs.

### Shared domain
- `shared/domain/state-machines/inspection-report.ts` (460 LOC)
  - `canEdit(jobStatus)`, `canSubmit(draft, jobStatus)`
  - `validateForSubmit(draft)` — minimum completeness check
  - `draftStorageKey(jobId)` — localStorage/AsyncStorage key (`inspector:report-draft:${jobId}`)
  - `AUTOSAVE_DEBOUNCE_MS = 1500`
- `shared/domain/state-machines/inspection-job.ts`
- `shared/domain/contracts/inspection-report.ts` — `ReportDraft`, `ChecklistItemValue`, `ReportVerdict`, `SubmitReportPayload`
- `shared/domain/contracts/inspection-job.ts` — `InspectionJobStatus`

### Checklist
- `backend/app/auto_requests/checklist.py` — 60-item canonical list with 15 groups (documents, body, paint, glass_lights, wheels, engine, fluids, drivetrain, chassis, brakes, electronics, interior, comfort, safety, drive)
- Statuses: `ok | warning | problem | not_checked`
- Verdicts: `recommended | risky | not_recommended`
- Legacy alias support kept for old mobile clients

---

## 2. What is partially built

### Timeline fan-in (CRITICAL gap)
- `append_event` exists but is wired into ONLY:
  - `inspector/contact.py` (reveal endpoint)
  - manual `POST /api/inspector/timeline/append`
- It is **NOT** called from:
  - `service.claim_job` (no `assignment_received` / `assignment_accepted` event)
  - `reports.transition_status` (no `provider_departed`, `provider_arrived`, `inspection_started`)
  - `reports.submit_report` (no `report_submitted`, no `customer_accepted`)
  - `admin_set_report_status` (no `report_approved` / `report_rejected`)
  - `customer_accept_report` (no `customer_accepted`)
  - `job_media.upload_job_media` (no `photo_uploaded`)
  - any payout/dispute endpoint (no `payout_sent`, `customer_disputed`)
- **Result:** `db.timeline_events` does not exist in production (0 docs, namespace missing).

### Contact ownership check
- `contact.py` reads `inspection_jobs.find_one({"_id": job_id})` and compares `inspectorId == uid`.
- But `router_inspector.py` checks `IdentityContext.user_id` (which comes from `account_capabilities` runtime, may differ from legacy `users._id`).
- **Risk:** A new IdentityContext user with `inspectorAccountId` set but no `inspectorId` will get 403 on contact endpoints.

### Contact double-write
- `POST /jobs/{id}/contact/reveal` writes `status=accepted|on_route|arrived` directly into `inspection_jobs`.
- But the same status is ALSO written by:
  - `router_inspector.py POST /jobs/{id}/claim` → `claimed` (different! not `accepted`)
  - `router_inspector.py POST /jobs/{id}/on-route` → `on_route`
  - `router_inspector.py POST /jobs/{id}/arrived` → `arrived`
- **Race:** if frontend calls `/on-route` and `/contact/reveal` separately, the lifecycle gate in `transition_status` (must come from `claimed`) may now reject because contact already pushed status forward.

### Media on report
- `submit_report` doesn't snapshot `inspection_job_media` records into the report.
- `get_report` only returns `inspection_media` (report-scoped). Job-scoped media stays attached to the job.
- **Result:** customer never sees photos taken during inspection runtime — only photos uploaded AFTER submit (which the current frontend doesn't do).

### Frontend offline persistence
- AsyncStorage flush works per-job (`STORAGE_KEY = runtime_v2_${jobId}`).
- Photos persist as **local file URIs** (`file://...`) — they survive app restart, but on a fresh device install they're gone.
- No queue of pending uploads. If `POST /media` fails (network), the photo is on disk but **the app has no record that an upload is pending**.

---

## 3. What is fake / mock

### Inspector dashboard `recentEvents`
- `cabinet.py::get_dashboard` returns `recentEvents` derived from `inspection_jobs` sorted by `updatedAt` — **NOT** from `timeline_events`.
- This is a fallback because `timeline_events` is empty. After Timeline fan-in is wired, this should switch.

### Inspector seed data
- `db.inspection_jobs` has 6 demo records (all `claimed` status, no `onRouteAt/arrivedAt/inspectionStartedAt` fields), inspectorId points to `6a0192563f4f15ebd3bf9c77`.
- `db.inspection_reports` has 13 records but their shape is **legacy** — fields like `operatorId`, `submittedAt`, `findings[]`, `thumbnail` (URL not base64), `verdict: 'risk'` (not in canonical `recommended/risky/not_recommended`). These are PRD demo seeds, NOT real submitted reports.

### Verification documents
- `inspector_verifications.dataBase64` stores the actual document inline. PRD admits it: *"placeholder storage; will move to S3 later"*. Not a Sprint 2 blocker but mirrors the media problem.

### Realtime ring buffer as "spine"
- `system/realtime.py` is in-memory only (deque, max 500). Restart loses it.
- Admin polls `/api/realtime/events?since=...` every 2s. Works for one-process FastAPI. Will break the moment we add a second worker (currently `--workers 1` in supervisor).

---

## 4. What is completely missing

### Draft Intelligence Engine (layer 4)
- Zero code. No `app/inspection/draft.py`, no `app/intelligence/*`, no `synthesize_report`, no `detect_contradictions`, no `estimate_repair_severity`.
- `backend/app/inspection/router.py` exists for "Berlin Launch B1 — POST /api/inspection/report/generate" but I haven't verified its contents — likely a stub or PDF generator, NOT AI verdict synthesis.
- No `emergentintegrations` import anywhere in `backend/app/`.

### Offline Queue persistence (layer 5)
- No `useOfflineQueue` hook.
- No `pending_uploads`, `pending_actions`, `sync_state` keys in AsyncStorage.
- No background retry worker, no exponential backoff, no replay on resume.
- No sync badges in UI.
- No conflict handling.

### MediaRepository abstraction (layer 3)
- All callers hit `db.inspection_job_media.insert_one(...)` and `db.inspection_media.insert_one(...)` directly.
- No `MediaRepository.upload(file, scope, owner)` interface.
- Migrating to S3/R2 later = rewrite every call site.

### Photo compression
- Frontend uploads raw base64 from expo-image-picker. No `expo-image-manipulator` resize.
- 12 MP HEIC photo → ~5 MB base64 → 8 MB after JSON envelope → close to the 8 MB cap on iPhone Pro shots.

### Pending state UI
- No `<PendingBadge />` component anywhere.
- No way for inspector to see "3 photos waiting to upload".

### Contact reveal audit dashboard
- `contact_reveal_log` is written but never read anywhere. No admin endpoint, no inspector view.

### Critical issue flagging in runtime
- `runtime.tsx` has severity (info/warning/critical) but `critical_issue_found` timeline event is never auto-emitted when an item gets severity=critical.

---

## 5. Architectural landmines

### LM1 — Status double-write between contact and lifecycle
`contact.py::trigger_reveal` writes `status='accepted'` directly.
`router_inspector.py::on_route` requires `status='claimed'` (from `_INSPECTOR_TRANSITIONS["on_route"]["from"] == ["claimed"]`).
If the frontend uses contact reveal as the way to advance lifecycle (which it currently doesn't, but is implied by the trigger names), the lifecycle endpoint will reject.

**Fix in Sprint 2:** make contact-reveal write `claimed/on_route/arrived` to match lifecycle. Or remove status mutation from contact and make it derive-only.

### LM2 — Two divergent `inspectorId` references
- Legacy: `inspection_jobs.inspectorId == users._id` (ObjectId hex or string).
- New: `inspection_jobs.inspectorAccountId == account.id` (UUID).
- All Sprint 2 layers must agree on which one is authoritative. Mixing them = silent permission bugs.

**Decision needed:** keep both, but timeline/contact/media MUST use `inspectorId` for owner check (matches existing service layer).

### LM3 — Realtime spine = in-memory deque
- Works today, breaks the moment we scale. Should be replaced by:
  - `timeline_events` as durable spine (already designed)
  - SSE/long-poll reads from `timeline_events` (not from deque) once `since` is supported

**Fix in Sprint 2:** the timeline fan-in commit also flips admin/web realtime sources from deque to `timeline_events.find({timestamp > since}).sort(timestamp, -1).limit(N)`.

### LM4 — Media storage as base64 inside Mongo documents
- 13 reports × 60 items × 4 photos × 5 MB = 15.6 GB **in BSON documents**. Atlas tier limit is 16 MB *per document* — we are seconds away from hitting it.
- Already documented as "v1 acceptable" in `media.py`. Sprint 2 contract: abstraction layer NOW, real S3/R2 swap LATER.

### LM5 — No `timeline_events` indexes
- Collection doesn't even exist. Once we start writing, queries `find({inspectorId, jobId}).sort(timestamp, -1)` will tablescan from event #1.
- **Must** ship `inspectorId+timestamp` and `jobId+timestamp` indexes on first write.

### LM6 — `email_validator` / `pydantic` validators inside `submit_report`
- `submit_report` rebuilds the report doc fully each time. If we add `aiDraft` field via Draft Intelligence, must guarantee insertion order doesn't matter (it doesn't for Mongo, but `_scrub` filters `_id`).

---

## 6. Reusable assets (good news)

| Asset | Reuse for |
|---|---|
| `append_event()` API | All 5 layers — events are the spine |
| `CANONICAL_KINDS` (14 kinds) | Already covers 90% of Sprint 2 cases; add 5-7 for media/offline/AI |
| `system/realtime.py` mirroring | Keep as transport, swap source to `timeline_events.find()` |
| `contact_reveal_log` audit pattern | Mirror for `media_uploads_log`, `ai_overrides_log`, `offline_replay_log` |
| `inspection_job_media` schema | Already item-bound (`jobId + category`), just needs lifecycle states |
| Runtime reducer | Solid foundation for offline queue; replay logic is already pure |
| `shared/domain/state-machines/inspection-report.ts` | `canEdit`, `canSubmit`, `validateForSubmit` are reusable from Web + Expo + Backend pre-flight |
| `emergentintegrations` library | Already in `requirements.txt` (line 21) — Claude Sonnet 4.5 wiring is one import away |
| Inspector cabinet response shape | `warnings[]` + `quickActions[]` pattern reusable for offline status banner |

---

## 7. Collections inventory (live + planned)

### Exists, in use
- `inspection_jobs` — 6 demo docs, ObjectId or string `_id`
- `inspection_reports` — 13 demo docs (legacy shape)
- `inspection_media` — 0 docs (report-scoped)
- `inspection_job_media` — 0 docs (job-scoped, NEW Sprint 2 target)
- `users`, `accounts`, `account_capabilities` — auth/identity
- `car_requests` — customer-side parent
- `inspector_verifications` — KYC docs (base64 inline placeholder)

### Defined but never written
- `timeline_events` — **target #1 for Sprint 2**
- `contact_reveal_log` — code writes but no reader yet
- `user_sessions` — `cabinet.py` reads but no writer
- `payouts`, `disputes` — exist as schema, demo data missing
- `system_logs` — middleware writes, no reader UI

### Planned for Sprint 2 (not yet defined)
- `media_upload_queue` (server-side reconciliation log, optional)
- `report_drafts` (AI synthesis snapshots, optional — can live inline on `inspection_reports.draft`)
- `ai_overrides_log` (when inspector rejects AI suggestion — feeds back into model evaluation)
- `offline_replay_log` (when device replays a queued action — audit-only)

---

## 8. Existing event emitters

Grep for `emit_realtime_event` and `ctx.emit.*`:

| Call site | Event type | Status |
|---|---|---|
| `server.py::emit_booking_status_changed` | `booking:status_changed` | ✅ wired |
| `server.py::emit_provider_new_request` | `provider:new_request` | ✅ wired |
| `server.py::emit_provider_location` | `booking:provider_location` | ✅ wired |
| `marketplace/quick_request.py` | `qr:*` various | ✅ wired |
| `orchestrator/feedback.py` | `orchestrator:*` | ✅ wired |
| `inspector/timeline.py::append_event` | `timeline:{kind}` (mirrored) | ⚠️ defined, almost never called |

**Sprint 2 will create one new emit channel:**
`timeline:{kind}` → mirrored automatically by `append_event` → consumed by admin Live Feed + inspector rail.

---

## 9. Current auth gates (so we don't break them)

| Endpoint group | Gate | Source |
|---|---|---|
| `/api/inspector/jobs/*` (lifecycle) | `require_capability_v2("inspect")` | `core/identity_runtime.py` |
| `/api/inspector/timeline*` | `get_user_id_required` (JWT only) | `auto_requests/auth.py` |
| `/api/inspector/jobs/{id}/contact*` | `get_user_id_required` + ownership check | `inspector/contact.py` |
| `/api/inspector/jobs/{id}/media*` | `get_user_id_required` + ownership check | `auto_requests/job_media.py` |
| `/api/admin/*` | `verify_admin_token` | `core/security.py` |

**Sprint 2 contract:** ALL new endpoints use the same gate as the surrounding domain — no new auth invented.

---

## 10. Recommended implementation path (Sprint 2)

> Each step ships its own commit + smoke test + finish. No giant diffs.

### Step 1 — Timeline fan-in (closes LM3, LM5; unblocks 2-5)
1. Add indexes on first write: `inspectorId+timestamp`, `jobId+timestamp`, `kind+timestamp`.
2. Wire `append_event(...)` into:
   - `service.claim_job` → `assignment_accepted` (severity=success, actor=inspector)
   - `reports.transition_status` → `provider_departed | provider_arrived | inspection_started`
   - `reports.submit_report` → `report_submitted`
   - `reports.admin_set_report_status` → `report_approved | report_rejected`
   - `reports.customer_accept_report` → `customer_accepted`
   - `job_media.upload_job_media` → `photo_uploaded` (with `category`, `mediaId` in payload)
3. Replace `cabinet.get_dashboard.recentEvents` source: read from `timeline_events` (fallback to job updates if empty).
4. **Smoke:** seed a fake job, claim → on_route → arrived → start-inspection → upload photo → submit report → admin approve → customer accept. Then `GET /api/inspector/timeline?jobId=...` returns 8 events in correct order with correct severities.

### Step 2 — Contact Unlock alignment (closes LM1)
1. Remove status mutation from `contact.py::trigger_reveal` — it only logs reveal events.
2. Make lifecycle endpoints (`/claim`, `/on-route`, `/arrived`) emit a `contact:reveal:X` timeline event automatically.
3. Add admin endpoint `GET /api/admin/contact-reveals?since=...` reading `contact_reveal_log` (closes the audit hole — leaks now visible to admin).
4. Verify masking: phone never returned in full on `hidden`/`masked` states (already correct).
5. **Smoke:** claim job → GET contact → `name: "Demo C.", phone: "+••••1234"`; advance to on_route → GET contact → full phone visible; check `contact_reveal_log` has 2 entries.

### Step 3 — Media Upload Architecture (closes LM4)
1. Create `app/media/repository.py` — `class MediaRepository`:
   - `upload(scope, scope_id, owner_id, file, category, type) → MediaMeta`
   - `list(scope, scope_id, filters) → MediaMeta[]`
   - `get_bytes(media_id) → (bytes, mime)`
   - `delete(media_id, owner_id)`
   - V1 backend: GridFS via `motor.motor_asyncio.AsyncIOMotorGridFSBucket`.
   - V2 backend: S3 (skipped for Sprint 2, but interface ready).
2. Migrate `job_media.py` and `media.py` to call repository — same endpoints, same shape, different backing store.
3. Add `media_uploads_log` (jobId, mediaId, status, attempts, lastError) for retry visibility.
4. Add `expo-image-manipulator` resize on frontend before upload (max 1920px JPEG ~ 80% quality).
5. Add `/api/inspector/jobs/{id}/media/{media_id}/status` for client to query upload state.
6. Pending state UI in `runtime.tsx`: photo shows spinner + retry on tap when not yet ack'd by server.
7. **Smoke:** upload 5 photos with airplane mode on/off cycles → all 5 land in GridFS, queue empty, badges clear.

### Step 4 — Draft Intelligence Engine (closes the "manual typing" pain)
1. New module `app/intelligence/draft.py`:
   - `synthesize_draft(job_id) → DraftReport`:
     - Reads `inspection_jobs`, `inspection_job_media`, runtime state (if synced from frontend), checklist items.
     - Calls `LlmChat` with `claude-sonnet-4-5-20250514` (model name per `integration_playbook_expert_v2` response, will reconfirm at impl time).
     - Returns: `verdict, score, riskLevel, summary, topProblems[], contradictions[], missingEvidence[]`.
2. New endpoint `POST /api/inspector/jobs/{id}/draft` — inspector triggers synthesis after some items checked.
3. Modify `submit_report` to accept either a hand-written draft OR an AI draft snapshot with `aiDraftId` reference for audit.
4. `ai_overrides_log` collection: every field where inspector overrode AI suggestion (for model evaluation).
5. Frontend: `runtime.tsx` adds "Generate draft" button that calls the endpoint and pre-fills the report screen.
6. **Smoke:** seed a job with 30/60 items checked → call /draft → get plausible verdict + 3-bullet summary + flagged missing evidence ("test_drive not done", "photos missing for engine").

### Step 5 — Offline Queue (R2)
1. New file `frontend/src/inspector/runtime/queue.ts`:
   - `queueUpload(jobId, mediaId, dataUri, category, type, mimeType)`
   - `queueAction(jobId, endpoint, payload)`
   - Persistence in AsyncStorage under `inspector:queue:v1` (single JSON array, simpler than per-key).
2. `useOfflineQueue` hook drains queue on:
   - app foreground
   - network online event (`@react-native-community/netinfo` — light dep, add only if free in install)
   - manual "Retry now" tap
3. Sync badges in `runtime.tsx` header + jobs list (`5 pending uploads`, `2 actions retry`).
4. Conflict handling: server returns `409 already_done` → action is dropped from queue with `ai_overrides_log`-style audit.
5. Backend tolerance: upload endpoints accept `Idempotency-Key` (already does — `prod_readiness.idempotency_lookup`), so replay is safe.
6. **Smoke:** airplane mode → claim/start/photo×3/submit → queue depth = 5 → airplane off → queue drains in <30s → all 5 events in `timeline_events`.

---

## 11. Out of Sprint 2 (deferred to Sprint 3 per directive)

- Notifications fan-out (uses Timeline as input → built ON TOP of foundation)
- Reputation engine
- Disputes UI
- Live assignments map
- QA review queue
- Verification review by admin
- Push device wake-on-event (only event spine exists, broadcast comes later)

---

## 12. What I need from you before Step 1

**Nothing.** Defaults are locked:
- Step 1 — Timeline fan-in, no external deps.
- Step 2 — Contact alignment, no external deps.
- Step 3 — GridFS via motor (already installed), add `expo-image-manipulator` (~150 KB).
- Step 4 — Claude Sonnet 4.5 via `emergentintegrations` + Emergent LLM key (will fetch via `emergent_integrations_manager`).
- Step 5 — `@react-native-community/netinfo` is the only new dep (24 KB).

Starting Step 1 next message.

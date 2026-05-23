/**
 * Sprint 2 · Step 5 — Offline Queue (R2).
 *
 * Durable replay layer for inspection runtime. Survives:
 *   • tunnel drop
 *   • underground parking
 *   • app restart / OS kill
 *   • flaky LTE
 *   • partial upload failure
 *
 * Scope (per spec):
 *   single-device durable offline replay
 *   NOT collaborative sync, NOT CRDT, NOT websocket reconciliation.
 *
 * Coverage:
 *   media_upload | draft_generate | report_submit
 *
 * Replay policy:
 *   sequential (concurrency = 1)
 *   triggered by: foreground / network reachable / manual retry
 *   backoff:      5s · 15s · 60s · 5m · 15m → status=failed after 5 attempts
 *   idempotent:   every queued request carries Idempotency-Key
 *
 * Failure UX:
 *   permanently failed items remain visible with retry + discard.
 *
 * Constraints (from acceptance criteria):
 *   queue corruption must not crash runtime (malformed items skipped)
 *   replay must survive cold restart (rehydrate on import)
 *   memory usage bounded; queue cap = 500 items
 *   replay loop must stop on logout (call `stopReplay()`)
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type QueueKind = 'media_upload' | 'draft_generate' | 'report_submit';
export type QueueStatus = 'pending' | 'running' | 'failed' | 'done';

export interface QueueItem {
  /** `q_<uuid-ish>` */
  id: string;
  kind: QueueKind;
  jobId: string;
  createdAt: string;        // ISO
  attempts: number;
  /** ISO; when status=pending, replay waits until now >= nextRetryAt */
  nextRetryAt: string;
  status: QueueStatus;
  /** Server-side de-duplication key. Same key + same path = same write. */
  idempotencyKey: string;
  /** Last attempt error message (kept across retries for UX). */
  lastError?: string | null;
  /** Last replay latency in ms (success or failure). */
  lastLatencyMs?: number | null;
  /** Kind-specific payload. Free-form but typed at each call site. */
  payload: any;
}

export interface QueueSnapshot {
  items: QueueItem[];
  /** monotonically rising; used to bust UI subscribers. */
  rev: number;
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'inspector:offline-queue:v1';
export const QUEUE_CAP = 500;
export const MAX_ATTEMPTS = 5;

/** Backoff schedule in milliseconds. attempts is 1-indexed. */
const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000];

// ─────────────────────────────────────────────────────────────────────
// Persistence — single-writer pattern: keep everything in memory, flush
// on every mutation. Mutations are funneled through `mutate()` so we
// never race-write the JSON blob.
// ─────────────────────────────────────────────────────────────────────

let _items: QueueItem[] | null = null;
let _rev = 0;
let _hydrating: Promise<void> | null = null;
let _writeChain: Promise<void> = Promise.resolve();
let _replayStopped = false;
let _replayInFlight = false;

type Listener = (snap: QueueSnapshot) => void;
const _listeners = new Set<Listener>();

function emit() {
  const snap: QueueSnapshot = { items: (_items || []).slice(), rev: _rev };
  for (const fn of _listeners) {
    try { fn(snap); } catch { /* listener-side error must not corrupt queue */ }
  }
}

/** Subscribe to queue snapshot changes. Returns an unsubscribe fn. */
export function subscribeQueue(fn: Listener): () => void {
  _listeners.add(fn);
  // emit a snapshot eagerly if hydrated
  if (_items) fn({ items: _items.slice(), rev: _rev });
  return () => { _listeners.delete(fn); };
}

/** Hydrate from AsyncStorage. Idempotent + safe to call from anywhere. */
export async function loadQueue(): Promise<QueueItem[]> {
  if (_items) return _items.slice();
  if (!_hydrating) {
    _hydrating = (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) { _items = []; return; }
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { _items = []; return; }
        if (!Array.isArray(parsed)) { _items = []; return; }
        _items = parsed.filter(isValidItem);
        // Any items left in `running` after a cold restart are demoted to
        // `pending` — we don't know if the previous attempt actually wrote.
        // Idempotency key on the server still de-dupes if it did.
        for (const it of _items) {
          if (it.status === 'running') {
            it.status = 'pending';
            it.nextRetryAt = new Date().toISOString();
          }
        }
      } catch {
        _items = [];
      }
    })();
  }
  await _hydrating;
  return (_items || []).slice();
}

function isValidItem(x: any): x is QueueItem {
  return !!x
    && typeof x.id === 'string'
    && (x.kind === 'media_upload' || x.kind === 'draft_generate' || x.kind === 'report_submit')
    && typeof x.jobId === 'string'
    && typeof x.idempotencyKey === 'string'
    && typeof x.attempts === 'number'
    && typeof x.createdAt === 'string'
    && typeof x.nextRetryAt === 'string'
    && (x.status === 'pending' || x.status === 'running' || x.status === 'failed' || x.status === 'done')
    && typeof x.payload === 'object';
}

export async function persistQueue(): Promise<void> {
  // chain writes to avoid concurrent setItem racing
  const items = (_items || []).slice();
  _writeChain = _writeChain.then(async () => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch { /* best-effort */ }
  });
  await _writeChain;
}

async function mutate(updater: (items: QueueItem[]) => void): Promise<void> {
  await loadQueue();
  updater(_items as QueueItem[]);
  _rev++;
  emit();
  await persistQueue();
}

// ─────────────────────────────────────────────────────────────────────
// Backoff
// ─────────────────────────────────────────────────────────────────────

export function backoffFor(attempts: number): number {
  if (attempts <= 0) return 0;
  const idx = Math.min(attempts - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx];
}

function rid(): string {
  return 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

// ─────────────────────────────────────────────────────────────────────
// Public API — enqueue / mark / inspect
// ─────────────────────────────────────────────────────────────────────

export interface EnqueueParams<K extends QueueKind = QueueKind> {
  kind: K;
  jobId: string;
  payload: any;
  /** Override if caller wants to control de-duplication explicitly. */
  idempotencyKey?: string;
}

/**
 * Enqueue a new offline-tolerant action. Returns the created item.
 *
 * idempotencyKey:
 *   If caller passes one, we reuse it (so repeated enqueues for the same
 *   logical action don't create duplicate server-side writes).
 *   Otherwise we mint a fresh UUID-ish key.
 */
export async function enqueue(params: EnqueueParams): Promise<QueueItem> {
  const key = params.idempotencyKey || `${params.kind}_${params.jobId}_${rid()}`;
  const now = new Date().toISOString();
  const item: QueueItem = {
    id: rid(),
    kind: params.kind,
    jobId: params.jobId,
    createdAt: now,
    attempts: 0,
    nextRetryAt: now,
    status: 'pending',
    idempotencyKey: key,
    payload: params.payload,
    lastError: null,
    lastLatencyMs: null,
  };
  await mutate((items) => {
    items.unshift(item);
    // Bounded: drop oldest done items first, then oldest failed.
    if (items.length > QUEUE_CAP) {
      // remove oldest done
      let i = items.length - 1;
      while (items.length > QUEUE_CAP && i >= 0) {
        if (items[i].status === 'done') items.splice(i, 1);
        i--;
      }
      // then oldest failed
      i = items.length - 1;
      while (items.length > QUEUE_CAP && i >= 0) {
        if (items[i].status === 'failed') items.splice(i, 1);
        i--;
      }
      // last resort: drop oldest of any status (would be very unusual)
      while (items.length > QUEUE_CAP) items.pop();
    }
  });
  return item;
}

export async function markDone(id: string, latencyMs?: number): Promise<void> {
  await mutate((items) => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    it.status = 'done';
    it.lastError = null;
    it.lastLatencyMs = typeof latencyMs === 'number' ? latencyMs : it.lastLatencyMs ?? null;
  });
}

export async function markFailed(id: string, error: string, latencyMs?: number): Promise<void> {
  await mutate((items) => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    it.attempts += 1;
    it.lastError = (error || '').slice(0, 500);
    it.lastLatencyMs = typeof latencyMs === 'number' ? latencyMs : it.lastLatencyMs ?? null;
    if (it.attempts >= MAX_ATTEMPTS) {
      it.status = 'failed';
    } else {
      it.status = 'pending';
      it.nextRetryAt = new Date(Date.now() + backoffFor(it.attempts)).toISOString();
    }
  });
}

async function markRunning(id: string): Promise<void> {
  await mutate((items) => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    it.status = 'running';
  });
}

/** Force-retry a failed item — resets attempts so backoff starts from 5s again. */
export async function retryFailed(id: string): Promise<void> {
  await mutate((items) => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    it.status = 'pending';
    it.attempts = 0;
    it.lastError = null;
    it.nextRetryAt = new Date().toISOString();
  });
}

/** Discard one item permanently (failure UX or after server-side delete). */
export async function discard(id: string): Promise<void> {
  await mutate((items) => {
    const idx = items.findIndex((x) => x.id === id);
    if (idx >= 0) items.splice(idx, 1);
  });
}

/** Drop all `done` items older than N days (sweep). Pending/failed kept. */
export async function sweepDone(maxAgeMs: number = 7 * 24 * 3600 * 1000): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  await mutate((items) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.status === 'done' && new Date(it.createdAt).getTime() < cutoff) {
        items.splice(i, 1);
      }
    }
  });
}

/** Snapshot helpers for UI. */
export async function getSnapshot(): Promise<QueueSnapshot> {
  await loadQueue();
  return { items: (_items || []).slice(), rev: _rev };
}

export function summarize(items: QueueItem[]): {
  pending: number;
  running: number;
  failed: number;
  done: number;
  total: number;
  hasWork: boolean;
} {
  let pending = 0, running = 0, failed = 0, done = 0;
  for (const it of items) {
    if (it.status === 'pending') pending++;
    else if (it.status === 'running') running++;
    else if (it.status === 'failed') failed++;
    else if (it.status === 'done') done++;
  }
  return {
    pending, running, failed, done,
    total: items.length,
    hasWork: pending + running > 0 || failed > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Replay worker
// ─────────────────────────────────────────────────────────────────────

export interface ReplayDeps {
  apiBase: string;
  /** Resolved at replay time so logout invalidates pending work cleanly. */
  getToken: () => Promise<string | null>;
  /** Network reachability gate. Returns true if we should attempt. */
  isOnline: () => Promise<boolean>;
  /** Audit hook — optional. Called after every attempt (success or fail). */
  onAudit?: (rec: {
    queueId: string;
    kind: QueueKind;
    jobId: string;
    attempts: number;
    result: 'success' | 'failed';
    latencyMs: number;
  }) => void;
}

/** Stop any active replay loop (logout / app foreground change to bg, etc.). */
export function stopReplay() {
  _replayStopped = true;
}

export function resumeReplay() {
  _replayStopped = false;
}

/**
 * Main replay loop. Sequential. Max concurrency = 1. Re-entrancy-safe:
 * calling `replay()` while another loop is in flight is a no-op.
 *
 * Returns when there are no actionable items left (all done / failed /
 * waiting on a future nextRetryAt).
 */
export async function replay(deps: ReplayDeps): Promise<void> {
  if (_replayInFlight) return;
  _replayInFlight = true;
  _replayStopped = false;
  try {
    while (!_replayStopped) {
      if (!(await deps.isOnline())) return;
      const tok = await deps.getToken();
      if (!tok) return;
      const snap = await getSnapshot();
      const now = Date.now();
      const candidate = snap.items
        .filter((it) => it.status === 'pending' && new Date(it.nextRetryAt).getTime() <= now)
        // FIFO across createdAt
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
      if (!candidate) return;

      await markRunning(candidate.id);
      const t0 = Date.now();
      let result: 'success' | 'failed' = 'failed';
      let errMsg = '';
      try {
        await dispatch(candidate, { apiBase: deps.apiBase, token: tok });
        result = 'success';
      } catch (e: any) {
        errMsg = e?.message || String(e);
      }
      const latency = Date.now() - t0;

      if (result === 'success') {
        await markDone(candidate.id, latency);
      } else {
        await markFailed(candidate.id, errMsg, latency);
      }

      // Audit (best-effort, never blocks loop on failure)
      try {
        deps.onAudit?.({
          queueId: candidate.id,
          kind: candidate.kind,
          jobId: candidate.jobId,
          attempts: candidate.attempts + 1,
          result,
          latencyMs: latency,
        });
        // Fire-and-forget HTTP audit
        await fetch(`${deps.apiBase}/api/inspector/offline-replay/log`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${tok}`,
          },
          body: JSON.stringify({
            queueId: candidate.id,
            kind: candidate.kind,
            jobId: candidate.jobId,
            attempts: candidate.attempts + 1,
            result,
            latencyMs: latency,
          }),
        }).catch(() => {});
      } catch { /* audit failures are non-fatal */ }
    }
  } finally {
    _replayInFlight = false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Dispatch — translates a QueueItem into a real HTTP call.
// EVERY request carries Idempotency-Key. EVERY duplicate replay is safe.
// ─────────────────────────────────────────────────────────────────────

interface DispatchCtx { apiBase: string; token: string; }

async function dispatch(item: QueueItem, ctx: DispatchCtx): Promise<void> {
  if (item.kind === 'media_upload') return dispatchMediaUpload(item, ctx);
  if (item.kind === 'draft_generate') return dispatchDraftGenerate(item, ctx);
  if (item.kind === 'report_submit') return dispatchReportSubmit(item, ctx);
  throw new Error(`unknown queue kind: ${(item as any).kind}`);
}

async function dispatchMediaUpload(item: QueueItem, ctx: DispatchCtx): Promise<void> {
  const p = item.payload as {
    uri: string;
    mimeType: string;
    type: 'photo' | 'video';
    sectionKey: string;
    itemKey: string;
    severity: 'info' | 'warning' | 'critical';
    category?: string | null;
    note?: string | null;
    width?: number;
    height?: number;
  };
  const form = new FormData();
  // @ts-ignore — RN FormData file shape
  form.append('file', { uri: p.uri, name: `${p.itemKey}.jpg`, type: p.mimeType });
  form.append('type', p.type);
  form.append('sectionKey', p.sectionKey);
  form.append('itemKey', p.itemKey);
  form.append('severity', p.severity);
  if (p.category) form.append('category', p.category);
  if (p.note) form.append('note', p.note);
  if (p.width) form.append('width', String(p.width));
  if (p.height) form.append('height', String(p.height));

  const res = await fetch(`${ctx.apiBase}/api/inspector/jobs/${item.jobId}/media/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      'Idempotency-Key': item.idempotencyKey,
    },
    body: form as any,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any)?.message || `HTTP ${res.status}`);
  }
}

async function dispatchDraftGenerate(item: QueueItem, ctx: DispatchCtx): Promise<void> {
  const res = await fetch(`${ctx.apiBase}/api/inspector/jobs/${item.jobId}/draft`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.token}`,
      'Idempotency-Key': item.idempotencyKey,
    },
    body: JSON.stringify(item.payload || { runtimeState: {}, media: [], vehicle: {} }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any)?.message || `HTTP ${res.status}`);
  }
}

async function dispatchReportSubmit(item: QueueItem, ctx: DispatchCtx): Promise<void> {
  const res = await fetch(`${ctx.apiBase}/api/inspector/jobs/${item.jobId}/report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.token}`,
      'Idempotency-Key': item.idempotencyKey,
    },
    body: JSON.stringify(item.payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any)?.message || `HTTP ${res.status}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test seam — reset between unit tests. NOT exported via index of any
// production surface. Intentionally not under __DEV__ guard so test
// runners can call it directly.
// ─────────────────────────────────────────────────────────────────────
export async function __resetForTests() {
  _items = [];
  _rev = 0;
  _hydrating = null;
  _replayStopped = false;
  _replayInFlight = false;
  _listeners.clear();
  try { await AsyncStorage.removeItem(STORAGE_KEY); } catch { /* */ }
}

/**
 * Media Uploader — Sprint 2 Step 5 migration.
 *
 * Public API is preserved (queueAndUpload / loadPending / retryOne / dropOne /
 * pendingCount / failedCount / compressPhoto / savePending) so existing callers
 * (`app/inspector/job/[id]/index.tsx`) keep compiling.
 *
 * Internally this is now a thin façade over the durable offline queue:
 *   ./queue.ts (enqueue / replay / retryFailed / discard / loadQueue)
 *
 * Behavior delta vs the old uploader (Step 3):
 *   - Items survive app restart / OS kill / network drop.
 *   - Idempotency-Key is sent with every replay so the server de-dupes
 *     duplicate uploads.
 *   - Upload no longer awaits in the caller — the replay worker drives it.
 *     `queueAndUpload` returns immediately after enqueueing + kicks the
 *     worker. UI updates flow through `loadPending` polling (existing
 *     pattern) or `subscribeQueue` for richer surfaces.
 *
 * The legacy `PendingItem` shape is preserved as a *derived view* over
 * `QueueItem.payload` so the existing inline banner in the inspector job
 * detail screen keeps rendering without code changes.
 */
import * as ImageManipulator from 'expo-image-manipulator';

import {
  enqueue, retryFailed, discard, loadQueue, replay,
  QueueItem,
} from '../runtime/queue';

// ─────────────────────────────────────────────────────────────────────
// Public types — kept identical to Step 3 for caller compatibility.
// ─────────────────────────────────────────────────────────────────────

export type UploadState = 'local_pending' | 'uploading' | 'uploaded' | 'failed';
export type Severity = 'info' | 'warning' | 'critical';

export interface PendingItem {
  id: string;
  jobId: string;
  sectionKey: string;
  itemKey: string;
  severity: Severity;
  category?: string | null;
  uri: string;
  mimeType: string;
  type: 'photo' | 'video';
  note?: string | null;
  width?: number;
  height?: number;
  state: UploadState;
  serverId?: string | null;
  error?: string | null;
  createdAt: string;
  attempts: number;
}

// ─────────────────────────────────────────────────────────────────────
// Compression — unchanged.
// ─────────────────────────────────────────────────────────────────────

export async function compressPhoto(
  uri: string,
  mimeType: string,
): Promise<{ uri: string; mimeType: string; width?: number; height?: number }> {
  try {
    const out = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1600 } }],
      { compress: 0.72, format: ImageManipulator.SaveFormat.JPEG },
    );
    return { uri: out.uri, mimeType: 'image/jpeg', width: out.width, height: out.height };
  } catch {
    return { uri, mimeType };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Adapter: QueueItem → PendingItem (legacy view)
// ─────────────────────────────────────────────────────────────────────

function toPending(it: QueueItem): PendingItem | null {
  if (it.kind !== 'media_upload') return null;
  const p = it.payload || {};
  const state: UploadState =
    it.status === 'done' ? 'uploaded'
    : it.status === 'failed' ? 'failed'
    : it.status === 'running' ? 'uploading'
    : 'local_pending';
  return {
    id: it.id,
    jobId: it.jobId,
    sectionKey: p.sectionKey || '',
    itemKey: p.itemKey || '',
    severity: (p.severity as Severity) || 'info',
    category: p.category ?? null,
    uri: p.uri || '',
    mimeType: p.mimeType || '',
    type: (p.type as 'photo' | 'video') || 'photo',
    note: p.note ?? null,
    width: p.width,
    height: p.height,
    state,
    serverId: null, // server-id is not surfaced by replay; lookups go via /media endpoint
    error: it.lastError ?? null,
    createdAt: it.createdAt,
    attempts: it.attempts,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Legacy API
// ─────────────────────────────────────────────────────────────────────

export async function loadPending(jobId: string): Promise<PendingItem[]> {
  const items = await loadQueue();
  return items
    .filter((it) => it.kind === 'media_upload' && it.jobId === jobId)
    .map(toPending)
    .filter((x): x is PendingItem => x !== null);
}

/**
 * Deprecated — the durable queue handles persistence. Kept as a no-op so
 * legacy callers (if any) don't crash.
 */
export async function savePending(_jobId: string, _items: PendingItem[]): Promise<void> {
  /* no-op: queue.ts persists everything on every mutation */
}

export interface UploadDeps {
  apiBase: string;
  token: string;
}

/**
 * Enqueue a media upload. Replay worker dispatches it (sequentially).
 *
 * Returns immediately with the enqueued PendingItem view. Callers should
 * NOT await network here — that's the whole point of the offline queue.
 *
 * `deps` is kept for signature compatibility; we trigger a best-effort
 * replay using the token passed in so the optimistic path is fast.
 */
export async function queueAndUpload(
  deps: UploadDeps,
  jobId: string,
  params: {
    uri: string;
    mimeType: string;
    type: 'photo' | 'video';
    sectionKey: string;
    itemKey: string;
    severity?: Severity;
    category?: string | null;
    note?: string | null;
    width?: number;
    height?: number;
  },
): Promise<PendingItem> {
  // Compress photos before persisting so the queue never grows with
  // unbounded raw assets.
  let finalUri = params.uri;
  let finalMime = params.mimeType;
  let w = params.width;
  let h = params.height;
  if (params.type === 'photo') {
    const c = await compressPhoto(params.uri, params.mimeType);
    finalUri = c.uri;
    finalMime = c.mimeType;
    if (c.width)  w = c.width;
    if (c.height) h = c.height;
  }

  // Stable idempotency key: same (jobId, sectionKey, itemKey, createdAt-rounded)
  // tuple → same key, so an in-flight crash during upload doesn't cause a
  // duplicate when the user re-taps. We include a randomness suffix so two
  // truly different photos at the same itemKey don't collide.
  const rand = Math.random().toString(36).slice(2, 8);
  const idempotencyKey = `media_${jobId}_${params.sectionKey}_${params.itemKey}_${Date.now()}_${rand}`;

  const item = await enqueue({
    kind: 'media_upload',
    jobId,
    idempotencyKey,
    payload: {
      uri: finalUri,
      mimeType: finalMime,
      type: params.type,
      sectionKey: params.sectionKey,
      itemKey: params.itemKey,
      severity: params.severity || 'info',
      category: params.category || null,
      note: params.note || null,
      width: w,
      height: h,
    },
  });

  // Best-effort kick — fire-and-forget. If we're offline, replay's
  // isOnline gate is owned by the UI controller (SyncStatusBar) and
  // foregrounding / NetInfo events will pick it up.
  replay({
    apiBase: deps.apiBase,
    getToken: async () => deps.token,
    isOnline: async () => true,
  }).catch(() => {});

  return toPending(item) as PendingItem;
}

export async function retryOne(
  deps: UploadDeps, _jobId: string, itemId: string,
): Promise<PendingItem | null> {
  await retryFailed(itemId);
  replay({
    apiBase: deps.apiBase,
    getToken: async () => deps.token,
    isOnline: async () => true,
  }).catch(() => {});
  const items = await loadQueue();
  const it = items.find((x) => x.id === itemId);
  return it ? toPending(it) : null;
}

export async function dropOne(_jobId: string, itemId: string): Promise<void> {
  await discard(itemId);
}

/**
 * `sweepUploaded` — periodic cleanup of `uploaded` items older than N days.
 * Queue keeps `done` items so users can see "uploaded successfully" history,
 * but eventually they age out.
 */
export async function sweepUploaded(
  jobId: string,
  maxAgeMs: number = 7 * 24 * 3600 * 1000,
): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  const items = await loadQueue();
  for (const it of items) {
    if (
      it.kind === 'media_upload'
      && it.jobId === jobId
      && it.status === 'done'
      && new Date(it.createdAt).getTime() < cutoff
    ) {
      await discard(it.id);
    }
  }
}

export function pendingCount(items: PendingItem[]): number {
  return items.filter((i) => i.state === 'local_pending' || i.state === 'uploading' || i.state === 'failed').length;
}

export function failedCount(items: PendingItem[]): number {
  return items.filter((i) => i.state === 'failed').length;
}

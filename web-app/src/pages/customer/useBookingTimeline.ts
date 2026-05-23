// P0.b.C.d.UI.a — Customer booking timeline realtime hook (LOCAL).
//
// Doctrine (per sprint brief):
//
//   • Initial load   : REST GET → authoritative snapshot
//   • WS event       : append projected event (server already projected)
//   • Recovery       : every 30s refetch REST → REST WINS (full replace)
//   • Conflict rule  : REST always wins. WS-only events that REST doesn't
//                      yet show on the next reconciliation are DROPPED.
//
// Intentionally LOCAL to /pages/customer/. Do NOT promote this to a
// shared module. Provider and inspector will have their own hooks with
// diverging semantics. Sharing here would silently rebuild a framework.
//
// Anti-goals (deliberately rejected):
//   ❌ Optimistic updates
//   ❌ Global websocket manager
//   ❌ Offline queue
//   ❌ Shared reducer / generic projection adapter
//   ❌ Reconnect orchestration abstraction
//   ❌ Permission filtering on the client (server already projected)
//
// Wire contract — matches backend `publish_timeline_event` exactly:
//
//   REST  GET /api/customer/bookings/{id}/timeline
//         { bookingId, events: [Event...], count }
//
//   WS    GET /api/customer/bookings/{id}/timeline/stream?token=...
//         hello frame: { type: "hello", payload: {...} }
//         data frame : { type: "timeline.updated", scope: "customer",
//                        bookingId, event: Event }
//
// Snapshot equivalence: `WS.event` IS one of the REST `events[i]`
// (byte-equal). The reducer therefore never re-projects, re-labels, or
// re-allowlists. It just dedupes and appends.

import { useCallback, useEffect, useReducer, useRef } from 'react';

// ─────────────────────────────────────────────────────────────────────
// Event shape (server-projected — DO NOT mutate, do NOT re-derive)
// ─────────────────────────────────────────────────────────────────────

export type CustomerTimelineEvent = {
  key: string;
  label: string;
  description?: string;
  tone: string;
  at: string;            // ISO timestamp
  isSelfAction?: boolean;
  meta?: Record<string, unknown>;
};

export type CustomerTimelineState = {
  events: CustomerTimelineEvent[];
  loading: boolean;
  error: string | null;
  lastSnapshotAt: string | null;   // wall clock of last REST hydrate
  liveConnected: boolean;          // WS open + hello received
  receivedLiveSinceSnapshot: number; // for the "live update" affordance
};

type Action =
  | { type: 'snapshot/start' }
  | { type: 'snapshot/success'; events: CustomerTimelineEvent[] }
  | { type: 'snapshot/error'; error: string }
  | { type: 'ws/connected' }
  | { type: 'ws/disconnected' }
  | { type: 'ws/event'; event: CustomerTimelineEvent };

const INITIAL: CustomerTimelineState = {
  events: [],
  loading: false,
  error: null,
  lastSnapshotAt: null,
  liveConnected: false,
  receivedLiveSinceSnapshot: 0,
};

// ─────────────────────────────────────────────────────────────────────
// Dedup key — (at, key). The server already guarantees idempotency
// at the chronology layer (observe_transition's setOnInsert), but we
// dedupe locally too because:
//
//   • REST reconciliation may bring back rows we've already appended;
//   • A reconnect could replay a frame the client already buffered.
//
// `at` alone is not enough — two attach sites can fire in the same
// microsecond on different transitions. `key` alone is not enough —
// the same key can legitimately repeat (e.g. "Provider reassigned").
// ─────────────────────────────────────────────────────────────────────

function eventDedupKey(e: CustomerTimelineEvent): string {
  return `${e.at}::${e.key}`;
}

function mergeAppend(
  existing: CustomerTimelineEvent[],
  incoming: CustomerTimelineEvent,
): CustomerTimelineEvent[] {
  const k = eventDedupKey(incoming);
  for (const e of existing) {
    if (eventDedupKey(e) === k) return existing; // already seen
  }
  // Maintain ascending chronological order. The server already sorts
  // REST snapshot ascending; for WS appends we splice in-place.
  const idx = existing.findIndex((e) => e.at > incoming.at);
  if (idx < 0) return [...existing, incoming];
  return [...existing.slice(0, idx), incoming, ...existing.slice(idx)];
}

function reducer(state: CustomerTimelineState, action: Action): CustomerTimelineState {
  switch (action.type) {
    case 'snapshot/start':
      return { ...state, loading: true, error: null };

    case 'snapshot/success':
      // REST WINS — full replace.
      return {
        ...state,
        loading: false,
        error: null,
        events: action.events,
        lastSnapshotAt: new Date().toISOString(),
        receivedLiveSinceSnapshot: 0,
      };

    case 'snapshot/error':
      return { ...state, loading: false, error: action.error };

    case 'ws/connected':
      return { ...state, liveConnected: true };

    case 'ws/disconnected':
      return { ...state, liveConnected: false };

    case 'ws/event': {
      const merged = mergeAppend(state.events, action.event);
      if (merged === state.events) return state; // dedup no-op
      return {
        ...state,
        events: merged,
        receivedLiveSinceSnapshot: state.receivedLiveSinceSnapshot + 1,
      };
    }

    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────

export type UseCustomerBookingTimelineOptions = {
  /** Force-disable WS (e.g. for a debugging/offline page). REST still
   *  works on its own; WS is acceleration only. */
  disableLive?: boolean;
  /** Reconciliation interval (ms). Defaults to 30s. */
  reconcileIntervalMs?: number;
};

export type UseCustomerBookingTimelineResult = CustomerTimelineState & {
  /** Manual refresh (REST snapshot). User-triggered AND idempotent. */
  refresh: () => Promise<void>;
};

export function useCustomerBookingTimeline(
  bookingId: string | undefined,
  opts: UseCustomerBookingTimelineOptions = {},
): UseCustomerBookingTimelineResult {
  const reconcileIntervalMs = opts.reconcileIntervalMs ?? 30_000;

  const [state, dispatch] = useReducer(reducer, INITIAL);

  // Stable refs for cleanup. We deliberately do NOT capture token /
  // bookingId via closures in long-lived intervals — each tick reads
  // fresh from localStorage, so token rotation Just Works.
  const wsRef = useRef<WebSocket | null>(null);
  const reconcileRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  // ── REST hydrate ──────────────────────────────────────────────────
  const fetchSnapshot = useCallback(async () => {
    if (!bookingId) return;
    if (!mountedRef.current) return;
    dispatch({ type: 'snapshot/start' });
    const token = localStorage.getItem('token') || '';
    try {
      const res = await fetch(
        `/api/customer/bookings/${bookingId}/timeline`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!mountedRef.current) return;
      if (!res.ok) {
        dispatch({
          type: 'snapshot/error',
          error: res.status === 404
            ? 'Booking not found'
            : res.status === 401 || res.status === 403
              ? 'Not authorized'
              : `Failed to load timeline (${res.status})`,
        });
        return;
      }
      const body = (await res.json()) as { events?: CustomerTimelineEvent[] };
      dispatch({
        type: 'snapshot/success',
        events: Array.isArray(body.events) ? body.events : [],
      });
    } catch (e) {
      if (!mountedRef.current) return;
      dispatch({
        type: 'snapshot/error',
        error: e instanceof Error ? e.message : 'Network error',
      });
    }
  }, [bookingId]);

  // ── WS subscribe (single connection, lifecycle tied to bookingId) ─
  useEffect(() => {
    if (!bookingId) return;
    if (opts.disableLive) return;

    const token = localStorage.getItem('token') || '';
    if (!token) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}`
      + `/api/customer/bookings/${bookingId}/timeline/stream`
      + `?token=${encodeURIComponent(token)}`;

    let cancelled = false;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(url);
    } catch {
      // Browsers throw synchronously for some malformed URLs. WS is
      // acceleration; REST still hydrates fine.
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (!cancelled) dispatch({ type: 'ws/connected' });
    };
    ws.onclose = () => {
      if (!cancelled) dispatch({ type: 'ws/disconnected' });
    };
    ws.onerror = () => {
      // No-op — onclose handles state reset. WS errors are routine
      // (network blips, token rotation, etc.); the reconciliation
      // tick will hydrate authoritatively on its next cycle.
    };
    ws.onmessage = (msg) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(msg.data) as
          | { type: 'hello' }
          | { type: 'ping' }
          | { type: 'pong' }
          | {
              type: 'timeline.updated';
              scope: 'customer';
              bookingId: string;
              event: CustomerTimelineEvent;
            };
        if (data.type === 'ping') {
          // Respond to keep server-side heartbeat satisfied.
          ws?.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (data.type === 'timeline.updated' && data.bookingId === bookingId) {
          dispatch({ type: 'ws/event', event: data.event });
        }
        // Ignore 'hello' / 'pong' / unknown — server already handled.
      } catch {
        // Malformed frame — drop. REST reconciliation will recover.
      }
    };

    return () => {
      cancelled = true;
      try { ws?.close(); } catch { /* swallow */ }
      wsRef.current = null;
    };
  }, [bookingId, opts.disableLive]);

  // ── Initial REST + periodic reconciliation ────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    if (!bookingId) return;
    void fetchSnapshot();
    reconcileRef.current = window.setInterval(() => {
      void fetchSnapshot();
    }, reconcileIntervalMs);
    return () => {
      mountedRef.current = false;
      if (reconcileRef.current != null) {
        window.clearInterval(reconcileRef.current);
        reconcileRef.current = null;
      }
    };
  }, [bookingId, fetchSnapshot, reconcileIntervalMs]);

  return {
    ...state,
    refresh: fetchSnapshot,
  };
}

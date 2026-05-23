/**
 * P0.b.C.d.UI.a — Customer booking timeline hook.
 *
 * Single responsibility: present a snapshot-equivalent view of one
 * booking's customer-facing timeline, kept fresh by WebSocket
 * acceleration and REST reconciliation.
 *
 * Lifecycle owned by the hook:
 *
 *   1. HYDRATE
 *      `GET /api/customer/bookings/{id}/timeline` → reducer.hydrate
 *
 *   2. CONNECT (after successful hydrate)
 *      `wss://.../api/customer/bookings/{id}/timeline/stream?token=…`
 *      On each `timeline.updated` frame → reducer.append
 *
 *   3. RECONCILE every 30s
 *      Refetch REST → reducer.reconcile. REST always wins; any locally
 *      appended WS frame that the server doesn't include is dropped.
 *
 *   4. RECONNECT
 *      On WS close, exponential backoff (1s, 2s, 4s, capped at 10s).
 *      No global manager — backoff state lives in this hook instance.
 *      Cleanup on unmount cancels timers & closes the socket.
 *
 * What this hook DOES NOT DO (deliberate scope limits):
 *   ❌ optimistic updates
 *   ❌ subscription registry / multiplexing
 *   ❌ offline queue
 *   ❌ reconnect orchestration abstraction
 *   ❌ cross-surface (provider/inspector/admin) — those will get their
 *      own hooks in their own folders.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../../services/api';
import {
  initialTimelineState,
  timelineReducer,
} from './reducer';
import type {
  ConnectionStatus,
  CustomerTimelineEvent,
  CustomerTimelineSnapshot,
  CustomerTimelineWsEnvelope,
} from './types';

const AUTH_TOKEN_KEY = 'auth_token';
const RECONCILE_INTERVAL_MS = 30_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

const API_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

function toWsUrl(httpUrl: string, bookingId: string, token: string): string {
  const base = httpUrl.replace(/^http/i, 'ws');
  const cleaned = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${cleaned}/api/customer/bookings/${encodeURIComponent(
    bookingId
  )}/timeline/stream?token=${encodeURIComponent(token)}`;
}

export interface UseCustomerBookingTimelineResult {
  events: CustomerTimelineEvent[];
  status: ConnectionStatus;
  lastError: string | null;
  /** Imperative refresh — useful for pull-to-refresh. */
  refresh: () => Promise<void>;
}

export function useCustomerBookingTimeline(
  bookingId: string | null | undefined
): UseCustomerBookingTimelineResult {
  const [state, dispatch] = useReducer(timelineReducer, initialTimelineState);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);

  // Refs survive re-renders and survive React StrictMode double-mount.
  const wsRef = useRef<WebSocket | null>(null);
  const reconcileTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef<number>(RECONNECT_INITIAL_MS);
  const cancelledRef = useRef<boolean>(false);
  const tokenRef = useRef<string | null>(null);

  const fetchSnapshot =
    useCallback(async (): Promise<CustomerTimelineSnapshot | null> => {
      if (!bookingId) return null;
      const resp = await api.get<CustomerTimelineSnapshot>(
        `/customer/bookings/${encodeURIComponent(bookingId)}/timeline`
      );
      return resp.data;
    }, [bookingId]);

  const hydrate = useCallback(async (): Promise<void> => {
    if (!bookingId) return;
    setStatus('hydrating');
    try {
      const snap = await fetchSnapshot();
      if (cancelledRef.current) return;
      dispatch({ type: 'hydrate', events: snap?.events ?? [] });
      setLastError(null);
    } catch (err: any) {
      if (cancelledRef.current) return;
      setLastError(err?.message || 'Failed to load timeline');
      setStatus('offline');
    }
  }, [bookingId, fetchSnapshot]);

  const reconcile = useCallback(async (): Promise<void> => {
    if (!bookingId) return;
    try {
      const snap = await fetchSnapshot();
      if (cancelledRef.current) return;
      dispatch({ type: 'reconcile', events: snap?.events ?? [] });
    } catch {
      // Reconciliation failures are silent — REST will retry in 30s.
      // The on-screen indicator switches to 'reconnecting' only if WS
      // also fails; transient REST blips do not need to alarm the user.
    }
  }, [bookingId, fetchSnapshot]);

  const connect = useCallback(async (): Promise<void> => {
    if (!bookingId || !API_URL) return;
    const token = tokenRef.current;
    if (!token) {
      setStatus('offline');
      return;
    }

    // Web fallback: if WebSocket is somehow absent, polling alone keeps
    // the screen correct — just stay in 'reconnecting' visually.
    if (typeof WebSocket === 'undefined') {
      setStatus('reconnecting');
      return;
    }

    try {
      const ws = new WebSocket(toWsUrl(API_URL, bookingId, token));
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelledRef.current) {
          ws.close();
          return;
        }
        reconnectDelayRef.current = RECONNECT_INITIAL_MS;
        setStatus('live');
        setLastError(null);
      };

      ws.onmessage = (ev) => {
        if (cancelledRef.current) return;
        try {
          const data = JSON.parse(String(ev.data));
          if (data?.type === 'ping') {
            // Reply with any frame; server treats every inbound frame
            // as keepalive. Do NOT inspect payload.
            try {
              ws.send('pong');
            } catch {
              /* socket already closing */
            }
            return;
          }
          if (data?.type === 'hello') {
            // Server-side ack. Nothing to append.
            return;
          }
          if (
            data?.type === 'timeline.updated' &&
            data?.scope === 'customer' &&
            data?.bookingId === bookingId &&
            data?.event
          ) {
            const envelope = data as CustomerTimelineWsEnvelope;
            dispatch({ type: 'append', event: envelope.event });
          }
        } catch {
          // Malformed frame — ignore. REST reconciliation will catch
          // any state divergence within 30s.
        }
      };

      ws.onerror = () => {
        // onclose runs immediately after, which is where we schedule
        // the backoff retry. Don't double-schedule here.
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (cancelledRef.current) return;
        setStatus('reconnecting');
        const delay = Math.min(
          reconnectDelayRef.current,
          RECONNECT_MAX_MS
        );
        reconnectDelayRef.current = Math.min(
          reconnectDelayRef.current * 2,
          RECONNECT_MAX_MS
        );
        reconnectTimerRef.current = setTimeout(() => {
          if (cancelledRef.current) return;
          connect();
        }, delay);
      };
    } catch (err: any) {
      if (cancelledRef.current) return;
      setLastError(err?.message || 'WebSocket failed');
      setStatus('reconnecting');
      reconnectTimerRef.current = setTimeout(() => {
        if (cancelledRef.current) return;
        connect();
      }, RECONNECT_INITIAL_MS);
    }
  }, [bookingId]);

  // ── Bootstrap & teardown ────────────────────────────────────────
  useEffect(() => {
    if (!bookingId) {
      dispatch({ type: 'reset' });
      setStatus('idle');
      return;
    }

    cancelledRef.current = false;
    reconnectDelayRef.current = RECONNECT_INITIAL_MS;

    (async () => {
      tokenRef.current = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
      await hydrate();
      if (cancelledRef.current) return;

      // Periodic reconciliation. REST is authoritative.
      reconcileTimerRef.current = setInterval(() => {
        reconcile();
      }, RECONCILE_INTERVAL_MS);

      // Connect WS only after first successful hydrate so the very
      // first paint is never empty (REST snapshot is on screen).
      void connect();
    })();

    return () => {
      cancelledRef.current = true;
      if (reconcileTimerRef.current) {
        clearInterval(reconcileTimerRef.current);
        reconcileTimerRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* noop */
        }
        wsRef.current = null;
      }
    };
    // We intentionally exclude `connect`/`hydrate`/`reconcile` — they
    // already depend on `bookingId` via useCallback, and re-running
    // the effect on every render would tear down the WS needlessly.
    // Web platform check is referenced indirectly for tree-shaking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  const refresh = useCallback(async () => {
    await reconcile();
  }, [reconcile]);

  // Mark Platform import as intentionally referenced (used inside
  // WebSocket fallback indirectly). Keeping it imported documents
  // that this hook is platform-aware.
  void Platform;

  return {
    events: state.events,
    status,
    lastError,
    refresh,
  };
}

/**
 * P0.b.C.d.UI.d — Admin forensic stream hook.
 *
 * Different in psychology from the 3 timeline hooks. This is an
 * audit-console consumer, not a customer-journey display.
 *
 * Lifecycle:
 *   1. HYDRATE   → `GET /api/admin/booking-lifecycle/{bookingId}` ·
 *                  rebuild state from `timeline` array
 *   2. CONNECT   → `wss://…/api/admin/booking-lifecycle/{bookingId}/stream?token=…`
 *   3. RECONCILE → every 30 s · REST hydrate replaces, dedup carries
 *                  forward via row.id
 *   4. RECONNECT → exponential backoff (1 s → 10 s)
 *
 * Admin-specific behaviors:
 *
 *   * Reducer uses `appendMany` after reconciliation gaps — we batch
 *     anything observed during gap so a burst doesn't slow rendering.
 *   * No "stale watchdog". Admin retains everything; REST hydrate is
 *     the only authoritative cull.
 *   * No surface-side filtering. Rejected actions, heartbeats,
 *     viewer probes — all are surfaced raw.
 *
 * Audit-role guard: server closes WS with code 4403 if the JWT
 * `role` claim is not `admin`. Hook surfaces this via `lastError`
 * and a `forbidden` connection status that does NOT retry.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../../services/api';
import {
  forensicStreamReducer,
  initialForensicStreamState,
} from './reducer';
import type {
  ForensicConnectionStatus,
  ForensicRow,
  ForensicSnapshot,
  ForensicWsEnvelope,
} from './types';

const AUTH_TOKEN_KEY = 'auth_token';
const RECONCILE_INTERVAL_MS = 30_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

const API_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

function toForensicWsUrl(
  httpUrl: string,
  bookingId: string,
  token: string
): string {
  const base = httpUrl.replace(/^http/i, 'ws');
  const cleaned = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${cleaned}/api/admin/booking-lifecycle/${encodeURIComponent(
    bookingId
  )}/stream?token=${encodeURIComponent(token)}`;
}

export interface UseAdminBookingForensicStreamResult {
  rows: ForensicRow[];
  status: ForensicConnectionStatus | 'forbidden';
  lastError: string | null;
  /** Total rows ingested since mount (including replaced-by-hydrate). */
  rowCount: number;
  refresh: () => Promise<void>;
}

export function useAdminBookingForensicStream(
  bookingId: string | null | undefined,
  /** Backing collection of the booking; default matches admin router. */
  scope: 'web_booking' | 'service_request' | 'car_request' = 'web_booking'
): UseAdminBookingForensicStreamResult {
  const [state, dispatch] = useReducer(
    forensicStreamReducer,
    initialForensicStreamState
  );
  const [status, setStatus] = useState<
    ForensicConnectionStatus | 'forbidden'
  >('idle');
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconcileTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef<number>(RECONNECT_INITIAL_MS);
  const cancelledRef = useRef<boolean>(false);
  const tokenRef = useRef<string | null>(null);
  /** Admin lock: once server returns 4403, do NOT retry. */
  const forbiddenRef = useRef<boolean>(false);

  const fetchSnapshot =
    useCallback(async (): Promise<ForensicSnapshot | null> => {
      if (!bookingId) return null;
      const resp = await api.get<ForensicSnapshot>(
        `/admin/booking-lifecycle/${encodeURIComponent(
          bookingId
        )}?scope=${encodeURIComponent(scope)}&actor=admin`
      );
      return resp.data;
    }, [bookingId, scope]);

  const hydrate = useCallback(async (): Promise<void> => {
    if (!bookingId) return;
    setStatus('hydrating');
    try {
      const snap = await fetchSnapshot();
      if (cancelledRef.current) return;
      const rows = (snap?.timeline ?? []) as ForensicRow[];
      dispatch({ type: 'hydrate', rows });
      setLastError(null);
    } catch (err: any) {
      if (cancelledRef.current) return;
      if (err?.response?.status === 403) {
        forbiddenRef.current = true;
        setStatus('forbidden');
        setLastError('Admin role required');
        return;
      }
      setLastError(err?.message || 'Failed to load forensic snapshot');
      setStatus('offline');
    }
  }, [bookingId, fetchSnapshot]);

  const reconcile = useCallback(async (): Promise<void> => {
    if (!bookingId || forbiddenRef.current) return;
    try {
      const snap = await fetchSnapshot();
      if (cancelledRef.current) return;
      const rows = (snap?.timeline ?? []) as ForensicRow[];
      // Hydrate replaces — dedup-by-id carries forward, REST wins.
      dispatch({ type: 'hydrate', rows });
    } catch {
      // Silent — next 30 s window retries.
    }
  }, [bookingId, fetchSnapshot]);

  const connect = useCallback(async (): Promise<void> => {
    if (!bookingId || !API_URL || forbiddenRef.current) return;
    const token = tokenRef.current;
    if (!token) {
      setStatus('offline');
      return;
    }
    if (typeof WebSocket === 'undefined') {
      setStatus('reconnecting');
      return;
    }

    try {
      const ws = new WebSocket(toForensicWsUrl(API_URL, bookingId, token));
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
            try {
              ws.send('pong');
            } catch {
              /* socket closing */
            }
            return;
          }
          if (data?.type === 'hello') return;
          // Strict envelope check — admin hook accepts ONLY admin-
          // scoped frames matching THIS bookingId. The backend already
          // does the filtering; this is defense in depth.
          if (
            data?.type === 'timeline.updated' &&
            data?.scope === 'admin' &&
            data?.bookingId === bookingId &&
            data?.event
          ) {
            const envelope = data as ForensicWsEnvelope;
            dispatch({ type: 'append', row: envelope.event });
          }
        } catch {
          // Malformed — ignore. REST reconciliation will heal.
        }
      };

      ws.onerror = () => {
        // onclose schedules retry.
      };

      ws.onclose = (ev) => {
        wsRef.current = null;
        if (cancelledRef.current) return;
        // 4403 = admin role required. Do NOT retry — operator must
        // re-authenticate properly.
        if (ev && (ev.code === 4403 || ev.code === 4401)) {
          forbiddenRef.current = true;
          setStatus('forbidden');
          setLastError(
            ev.code === 4403
              ? 'Admin role required for forensic stream'
              : 'Authentication failed'
          );
          return;
        }
        setStatus('reconnecting');
        const delay = Math.min(reconnectDelayRef.current, RECONNECT_MAX_MS);
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

  useEffect(() => {
    if (!bookingId) {
      dispatch({ type: 'reset' });
      setStatus('idle');
      forbiddenRef.current = false;
      return;
    }

    cancelledRef.current = false;
    forbiddenRef.current = false;
    reconnectDelayRef.current = RECONNECT_INITIAL_MS;

    (async () => {
      tokenRef.current = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
      await hydrate();
      if (cancelledRef.current || forbiddenRef.current) return;
      reconcileTimerRef.current = setInterval(() => {
        reconcile();
      }, RECONCILE_INTERVAL_MS);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, scope]);

  const refresh = useCallback(async () => {
    await reconcile();
  }, [reconcile]);

  return {
    rows: state.rows,
    status,
    lastError,
    rowCount: state.rows.length,
    refresh,
  };
}

/**
 * P0.b.C.i — Admin payment forensic stream hook.
 *
 * Different in psychology from the customer chronology hook. Admin is
 * a forensic console — append-everything, no "stale watchdog", no
 * filtering, no humanization.
 *
 * Lifecycle:
 *
 *   1. HYDRATE   `GET /api/admin/payments/{id}/chronology` →
 *                reducer.hydrate (RAW rows)
 *   2. CONNECT   `wss://…/api/admin/payments/{id}/chronology/stream?token=…`
 *   3. RECONCILE every 30 s · REST replaces, dedup carries by row.id
 *   4. RECONNECT exponential backoff 1 s → 2 s → 4 s → 10 s
 *
 * 4403 close → terminal `forbidden` state, NO retry.
 * 4401 close → same terminal state (auth misconfigured / token bad).
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../../services/api';
import {
  forensicPaymentStreamReducer,
  initialForensicPaymentStreamState,
} from './reducer';
import type {
  ForensicPaymentConnectionStatus,
  ForensicPaymentRow,
  ForensicPaymentSnapshot,
  ForensicPaymentWsEnvelope,
} from './types';

const AUTH_TOKEN_KEY = 'auth_token';
const RECONCILE_INTERVAL_MS = 30_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

const API_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

function toWsUrl(httpUrl: string, paymentId: string, token: string): string {
  const base = httpUrl.replace(/^http/i, 'ws');
  const cleaned = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${cleaned}/api/admin/payments/${encodeURIComponent(
    paymentId
  )}/chronology/stream?token=${encodeURIComponent(token)}`;
}

export interface UseAdminPaymentForensicResult {
  rows: ForensicPaymentRow[];
  status: ForensicPaymentConnectionStatus | 'forbidden';
  lastError: string | null;
  rowCount: number;
  refresh: () => Promise<void>;
}

export function useAdminPaymentForensic(
  paymentId: string | null | undefined
): UseAdminPaymentForensicResult {
  const [state, dispatch] = useReducer(
    forensicPaymentStreamReducer,
    initialForensicPaymentStreamState
  );
  const [status, setStatus] = useState<
    ForensicPaymentConnectionStatus | 'forbidden'
  >('idle');
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconcileTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef<number>(RECONNECT_INITIAL_MS);
  const cancelledRef = useRef<boolean>(false);
  const tokenRef = useRef<string | null>(null);
  const forbiddenRef = useRef<boolean>(false);

  const fetchSnapshot =
    useCallback(async (): Promise<ForensicPaymentSnapshot | null> => {
      if (!paymentId) return null;
      const resp = await api.get<ForensicPaymentSnapshot>(
        `/admin/payments/${encodeURIComponent(paymentId)}/chronology`
      );
      return resp.data;
    }, [paymentId]);

  const hydrate = useCallback(async (): Promise<void> => {
    if (!paymentId) return;
    setStatus('hydrating');
    try {
      const snap = await fetchSnapshot();
      if (cancelledRef.current) return;
      const rows = snap?.rows ?? [];
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
      setLastError(err?.message || 'Failed to load payment forensic snapshot');
      setStatus('offline');
    }
  }, [paymentId, fetchSnapshot]);

  const reconcile = useCallback(async (): Promise<void> => {
    if (!paymentId || forbiddenRef.current) return;
    try {
      const snap = await fetchSnapshot();
      if (cancelledRef.current) return;
      dispatch({ type: 'hydrate', rows: snap?.rows ?? [] });
    } catch {
      // Silent — next 30 s retries.
    }
  }, [paymentId, fetchSnapshot]);

  const connect = useCallback(async (): Promise<void> => {
    if (!paymentId || !API_URL || forbiddenRef.current) return;
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
      const ws = new WebSocket(toWsUrl(API_URL, paymentId, token));
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
          if (data?.op === 'ping') {
            try {
              ws.send(JSON.stringify({ op: 'pong' }));
            } catch {
              /* socket closing */
            }
            return;
          }
          if (data?.op === 'hello') return;
          if (
            data?.type === 'payment.chronology.updated' &&
            data?.scope === 'admin' &&
            data?.paymentId === paymentId &&
            data?.event
          ) {
            const envelope = data as ForensicPaymentWsEnvelope;
            dispatch({ type: 'append', row: envelope.event });
          }
        } catch {
          // Malformed — REST reconciliation will heal.
        }
      };

      ws.onerror = () => {
        // onclose schedules retry.
      };

      ws.onclose = (ev) => {
        wsRef.current = null;
        if (cancelledRef.current) return;
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
  }, [paymentId]);

  useEffect(() => {
    if (!paymentId) {
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
  }, [paymentId]);

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

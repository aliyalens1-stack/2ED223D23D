/**
 * P6.2 — Provider payout chronology hook.
 *
 * Surface: `payout-activity.provider`.
 *
 * Lifecycle (mirrors customer payment-chronology hook DOCTRINALLY, with
 * its own filenames and its own reducer):
 *
 *   1. HYDRATE
 *      `GET /api/provider/payouts/{id}/chronology` → reducer.hydrate
 *
 *   2. CONNECT
 *      `wss://.../api/provider/payouts/{id}/chronology/stream?token=…`
 *      On each `payment.chronology.updated` frame with
 *      `scope === 'provider'` and matching `paymentId` → reducer.append
 *
 *   3. RECONCILE every 30 s
 *      Refetch REST → reducer.reconcile. REST always wins.
 *
 *   4. RECONNECT
 *      Exponential backoff 1 s → 2 s → 4 s → 10 s cap.
 *      No global manager — backoff state lives in this hook instance.
 *
 * Deliberate non-goals:
 *   ❌ optimistic updates
 *   ❌ subscription registry
 *   ❌ offline mutation queue
 *   ❌ shared chronology kit with customer/admin
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../../services/api';
import {
  providerPayoutChronologyReducer,
  initialProviderPayoutChronologyState,
} from './reducer';
import type {
  ConnectionStatus,
  ProviderPayoutChronologySnapshot,
  ProviderPayoutChronologyWsEnvelope,
  ProviderPayoutEvent,
} from './types';

const AUTH_TOKEN_KEY = 'auth_token';
const RECONCILE_INTERVAL_MS = 30_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

const API_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

function toWsUrl(httpUrl: string, paymentId: string, token: string): string {
  const base = httpUrl.replace(/^http/i, 'ws');
  const cleaned = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${cleaned}/api/provider/payouts/${encodeURIComponent(
    paymentId
  )}/chronology/stream?token=${encodeURIComponent(token)}`;
}

export interface UseProviderPayoutChronologyResult {
  events: ProviderPayoutEvent[];
  status: ConnectionStatus;
  lastError: string | null;
  refresh: () => Promise<void>;
}

export function useProviderPayoutChronology(
  paymentId: string | null | undefined
): UseProviderPayoutChronologyResult {
  const [state, dispatch] = useReducer(
    providerPayoutChronologyReducer,
    initialProviderPayoutChronologyState
  );
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconcileTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef<number>(RECONNECT_INITIAL_MS);
  const cancelledRef = useRef<boolean>(false);
  const tokenRef = useRef<string | null>(null);

  const fetchSnapshot =
    useCallback(async (): Promise<ProviderPayoutChronologySnapshot | null> => {
      if (!paymentId) return null;
      const resp = await api.get<ProviderPayoutChronologySnapshot>(
        `/provider/payouts/${encodeURIComponent(paymentId)}/chronology`
      );
      return resp.data;
    }, [paymentId]);

  const hydrate = useCallback(async (): Promise<void> => {
    if (!paymentId) return;
    setStatus('hydrating');
    try {
      const snap = await fetchSnapshot();
      if (cancelledRef.current) return;
      dispatch({ type: 'hydrate', events: snap?.rows ?? [] });
      setLastError(null);
    } catch (err: any) {
      if (cancelledRef.current) return;
      setLastError(err?.message || 'Failed to load payout chronology');
      setStatus('offline');
    }
  }, [paymentId, fetchSnapshot]);

  const reconcile = useCallback(async (): Promise<void> => {
    if (!paymentId) return;
    try {
      const snap = await fetchSnapshot();
      if (cancelledRef.current) return;
      dispatch({ type: 'reconcile', events: snap?.rows ?? [] });
    } catch {
      // Silent — REST will retry on the next interval. The status pill
      // flips to 'reconnecting' only if WS also drops.
    }
  }, [paymentId, fetchSnapshot]);

  const connect = useCallback(async (): Promise<void> => {
    if (!paymentId || !API_URL) return;
    const token = tokenRef.current;
    if (!token) {
      setStatus('offline');
      return;
    }
    if (typeof WebSocket === 'undefined') {
      // Web fallback: REST reconciliation alone keeps state correct.
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
          // Server keepalive — answer any inbound frame as pong.
          if (data?.op === 'ping') {
            try {
              ws.send(JSON.stringify({ op: 'pong' }));
            } catch {
              /* socket already closing */
            }
            return;
          }
          if (data?.op === 'hello') {
            // Subscription ack — nothing to append.
            return;
          }
          if (
            data?.type === 'payment.chronology.updated' &&
            data?.scope === 'provider' &&
            data?.paymentId === paymentId &&
            data?.event
          ) {
            const envelope = data as ProviderPayoutChronologyWsEnvelope;
            dispatch({ type: 'append', event: envelope.event });
          }
        } catch {
          // Malformed frame — ignore. REST reconciliation heals state.
        }
      };

      ws.onerror = () => {
        // onclose runs immediately after, that's where backoff schedules.
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (cancelledRef.current) return;
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
      return;
    }

    cancelledRef.current = false;
    reconnectDelayRef.current = RECONNECT_INITIAL_MS;

    (async () => {
      tokenRef.current = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
      await hydrate();
      if (cancelledRef.current) return;
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
    events: state.events,
    status,
    lastError,
    refresh,
  };
}

/**
 * P0.b.C.d.UI.b — Provider booking timeline hook.
 *
 * Mirror of customer hook, but lives in provider folder, imports
 * provider reducer/types, and operates on the provider endpoints.
 * No shared code, no abstraction. Repetition is intentional pressure
 * testing of the pattern.
 *
 * Lifecycle:
 *   1. HYDRATE   → `GET /api/provider/bookings/{id}/timeline`
 *   2. CONNECT   → `wss://…/api/provider/bookings/{id}/timeline/stream?token=…`
 *   3. RECONCILE → every 30s, REST replaces state
 *   4. RECONNECT → exponential backoff (1s → 10s cap), hook-local
 *
 * Important provider-specific guardrail (per architectural review):
 *
 *   Timeline INFORMS, it does NOT AUTHORIZE.
 *
 * Action buttons (accept / depart / arrive / start / complete) MUST
 * be governed by the booking REST snapshot, NEVER by realtime frame
 * arrival. This hook deliberately returns ONLY the timeline events
 * — no `canConfirm`, `canDepart`, `nextAction` derivation. Consumers
 * that need action legality must query the booking REST endpoint
 * separately.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../../services/api';
import {
  initialProviderTimelineState,
  providerTimelineReducer,
} from './reducer';
import type {
  ProviderConnectionStatus,
  ProviderTimelineEvent,
  ProviderTimelineSnapshot,
  ProviderTimelineWsEnvelope,
} from './types';

const AUTH_TOKEN_KEY = 'auth_token';
const RECONCILE_INTERVAL_MS = 30_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

const API_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

function toProviderWsUrl(
  httpUrl: string,
  bookingId: string,
  token: string
): string {
  const base = httpUrl.replace(/^http/i, 'ws');
  const cleaned = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${cleaned}/api/provider/bookings/${encodeURIComponent(
    bookingId
  )}/timeline/stream?token=${encodeURIComponent(token)}`;
}

export interface UseProviderBookingTimelineResult {
  events: ProviderTimelineEvent[];
  status: ProviderConnectionStatus;
  lastError: string | null;
  refresh: () => Promise<void>;
}

export function useProviderBookingTimeline(
  bookingId: string | null | undefined
): UseProviderBookingTimelineResult {
  const [state, dispatch] = useReducer(
    providerTimelineReducer,
    initialProviderTimelineState
  );
  const [status, setStatus] = useState<ProviderConnectionStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconcileTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef<number>(RECONNECT_INITIAL_MS);
  const cancelledRef = useRef<boolean>(false);
  const tokenRef = useRef<string | null>(null);

  const fetchSnapshot =
    useCallback(async (): Promise<ProviderTimelineSnapshot | null> => {
      if (!bookingId) return null;
      const resp = await api.get<ProviderTimelineSnapshot>(
        `/provider/bookings/${encodeURIComponent(bookingId)}/timeline`
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
      // Silent — next 30s window will retry. WS status drives the
      // visible indicator; transient REST blips do not alarm provider.
    }
  }, [bookingId, fetchSnapshot]);

  const connect = useCallback(async (): Promise<void> => {
    if (!bookingId || !API_URL) return;
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
      const ws = new WebSocket(toProviderWsUrl(API_URL, bookingId, token));
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
              /* socket already closing */
            }
            return;
          }
          if (data?.type === 'hello') {
            return;
          }
          // Strict envelope check — provider hook NEVER processes
          // frames addressed to a different scope. This client-side
          // guard backs up the server's filter without becoming a
          // permission layer.
          if (
            data?.type === 'timeline.updated' &&
            data?.scope === 'provider' &&
            data?.bookingId === bookingId &&
            data?.event
          ) {
            const envelope = data as ProviderTimelineWsEnvelope;
            dispatch({ type: 'append', event: envelope.event });
          }
        } catch {
          // Malformed frame — drop. REST reconciliation will heal.
        }
      };

      ws.onerror = () => {
        // onclose follows and owns retry scheduling.
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
  }, [bookingId]);

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
  }, [bookingId]);

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

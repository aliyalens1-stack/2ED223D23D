/**
 * P0.b.C.d.UI.c — Inspector job timeline hook.
 *
 * Same recipe as customer + provider hooks, in its own module, with
 * one inspector-specific addition: a per-event STALE-WS WATCHDOG.
 *
 * Why inspector specifically:
 *   * Highest semantic density (documentation flow on the field).
 *   * Longest workflows — drift windows are more visible to operator.
 *   * Most likely surface to hit partial-state bugs first.
 *
 * Stale-WS watchdog (LOCAL to this hook, not a framework):
 *   When a WS frame arrives that wasn't in any prior REST snapshot,
 *   we start a per-event watchdog timer (STALE_WS_TIMEOUT_MS). If
 *   reconciliation does NOT include the same dedup key within that
 *   window, we explicitly DROP the local event and log a one-line
 *   warning. This catches bugs where WS fanned out a row that the
 *   server later considered invalid (e.g. an idempotent rollback,
 *   a stale projection update from a competitor connection, etc.)
 *   without waiting up to 30 s for the next reconcile to evict.
 *
 *   This guard is NOT shared with customer / provider hooks. Each
 *   surface gets to decide whether the operational density warrants
 *   the extra timer bookkeeping. Inspector does.
 *
 * Lifecycle:
 *   1. HYDRATE   → `GET /api/inspector/jobs/{jobId}/timeline`
 *   2. CONNECT   → `wss://…/api/inspector/jobs/{jobId}/timeline/stream?token=…`
 *   3. RECONCILE → every 20 s (faster than customer/provider's 30 s)
 *   4. RECONNECT → exponential backoff (1 s → 10 s cap)
 *
 * Wire identity:
 *   Inspector surface is **jobId-only**. The hook NEVER asks for or
 *   tracks `bookingId` / `requestId`. Frames carrying anything other
 *   than `scope:"inspector" + jobId:<self>` are silently dropped.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../../services/api';
import {
  initialInspectorTimelineState,
  inspectorDedupKey,
  inspectorTimelineReducer,
} from './reducer';
import type {
  InspectorConnectionStatus,
  InspectorTimelineEvent,
  InspectorTimelineSnapshot,
  InspectorTimelineWsEnvelope,
} from './types';

const AUTH_TOKEN_KEY = 'auth_token';
const RECONCILE_INTERVAL_MS = 20_000; // tighter than customer/provider
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
/**
 * Stale-WS watchdog window. If a WS-appended event is not confirmed
 * by REST reconciliation within this window, it is evicted.
 * 45 s = at least two reconcile cycles at the 20 s interval, so a
 * single dropped reconcile (cellular blip) cannot trigger eviction.
 */
const STALE_WS_TIMEOUT_MS = 45_000;

const API_URL = process.env.EXPO_PUBLIC_BACKEND_URL || '';

function toInspectorWsUrl(
  httpUrl: string,
  jobId: string,
  token: string
): string {
  const base = httpUrl.replace(/^http/i, 'ws');
  const cleaned = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${cleaned}/api/inspector/jobs/${encodeURIComponent(
    jobId
  )}/timeline/stream?token=${encodeURIComponent(token)}`;
}

export interface UseInspectorJobTimelineResult {
  events: InspectorTimelineEvent[];
  status: InspectorConnectionStatus;
  lastError: string | null;
  refresh: () => Promise<void>;
  /** Count of WS events dropped by the stale watchdog since mount. */
  staleDropCount: number;
}

export function useInspectorJobTimeline(
  jobId: string | null | undefined
): UseInspectorJobTimelineResult {
  const [state, dispatch] = useReducer(
    inspectorTimelineReducer,
    initialInspectorTimelineState
  );
  const [status, setStatus] = useState<InspectorConnectionStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  const [staleDropCount, setStaleDropCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconcileTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef<number>(RECONNECT_INITIAL_MS);
  const cancelledRef = useRef<boolean>(false);
  const tokenRef = useRef<string | null>(null);

  // Set of dedup keys that have appeared in at least one REST snapshot.
  // WS frames matching a key in this set need no watchdog — REST has
  // already confirmed them as legitimate.
  const restConfirmedKeysRef = useRef<Set<string>>(new Set());

  // Per-event watchdog timers. Keyed by dedupKey. Cleared on REST
  // confirmation; fired evicts the locally-appended event.
  const watchdogTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map()
  );

  const fetchSnapshot =
    useCallback(async (): Promise<InspectorTimelineSnapshot | null> => {
      if (!jobId) return null;
      const resp = await api.get<InspectorTimelineSnapshot>(
        `/inspector/jobs/${encodeURIComponent(jobId)}/timeline`
      );
      return resp.data;
    }, [jobId]);

  /** Mark REST-confirmed keys and cancel watchdogs for them. */
  const absorbRestConfirmation = useCallback(
    (events: InspectorTimelineEvent[]): void => {
      const nowKeys = new Set(events.map((e) => inspectorDedupKey(e)));
      restConfirmedKeysRef.current = nowKeys;
      // Clear watchdogs for any keys now confirmed by REST.
      for (const [k, t] of watchdogTimersRef.current.entries()) {
        if (nowKeys.has(k)) {
          clearTimeout(t);
          watchdogTimersRef.current.delete(k);
        }
      }
    },
    []
  );

  const hydrate = useCallback(async (): Promise<void> => {
    if (!jobId) return;
    setStatus('hydrating');
    try {
      const snap = await fetchSnapshot();
      if (cancelledRef.current) return;
      const events = snap?.events ?? [];
      dispatch({ type: 'hydrate', events });
      absorbRestConfirmation(events);
      setLastError(null);
    } catch (err: any) {
      if (cancelledRef.current) return;
      setLastError(err?.message || 'Failed to load timeline');
      setStatus('offline');
    }
  }, [jobId, fetchSnapshot, absorbRestConfirmation]);

  const reconcile = useCallback(async (): Promise<void> => {
    if (!jobId) return;
    try {
      const snap = await fetchSnapshot();
      if (cancelledRef.current) return;
      const events = snap?.events ?? [];
      dispatch({ type: 'reconcile', events });
      absorbRestConfirmation(events);
    } catch {
      // Silent. Watchdog timers run independently; next reconcile retries.
    }
  }, [jobId, fetchSnapshot, absorbRestConfirmation]);

  const armWatchdog = useCallback(
    (key: string): void => {
      if (watchdogTimersRef.current.has(key)) return;
      const t = setTimeout(() => {
        watchdogTimersRef.current.delete(key);
        if (cancelledRef.current) return;
        if (restConfirmedKeysRef.current.has(key)) return; // confirmed late
        // eslint-disable-next-line no-console
        console.warn(
          `[inspector-timeline] stale WS event evicted (no REST confirmation in ${STALE_WS_TIMEOUT_MS}ms): ${key}`
        );
        dispatch({ type: 'drop', key });
        setStaleDropCount((n) => n + 1);
      }, STALE_WS_TIMEOUT_MS);
      watchdogTimersRef.current.set(key, t);
    },
    []
  );

  const connect = useCallback(async (): Promise<void> => {
    if (!jobId || !API_URL) return;
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
      const ws = new WebSocket(toInspectorWsUrl(API_URL, jobId, token));
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
          // Strict envelope check — inspector hook accepts ONLY
          // inspector-scoped frames matching THIS jobId. Any frame
          // carrying `bookingId` / `requestId` (or a foreign jobId)
          // is silently dropped. Server is supposed to filter these,
          // this is defense in depth.
          if (
            data?.type === 'timeline.updated' &&
            data?.scope === 'inspector' &&
            data?.jobId === jobId &&
            data?.event
          ) {
            const envelope = data as InspectorTimelineWsEnvelope;
            const key = inspectorDedupKey(envelope.event);
            dispatch({ type: 'append', event: envelope.event });
            // Arm the watchdog ONLY if REST has not yet confirmed it.
            if (!restConfirmedKeysRef.current.has(key)) {
              armWatchdog(key);
            }
          }
        } catch {
          // Malformed frame — drop. Reconciliation will heal.
        }
      };

      ws.onerror = () => {
        // onclose runs after; that's where retry scheduling lives.
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
  }, [jobId, armWatchdog]);

  useEffect(() => {
    if (!jobId) {
      dispatch({ type: 'reset' });
      setStatus('idle');
      return;
    }

    cancelledRef.current = false;
    reconnectDelayRef.current = RECONNECT_INITIAL_MS;
    restConfirmedKeysRef.current = new Set();

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
      // Clear all watchdog timers on unmount.
      for (const t of watchdogTimersRef.current.values()) {
        clearTimeout(t);
      }
      watchdogTimersRef.current.clear();
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
  }, [jobId]);

  const refresh = useCallback(async () => {
    await reconcile();
  }, [reconcile]);

  return {
    events: state.events,
    status,
    lastError,
    refresh,
    staleDropCount,
  };
}

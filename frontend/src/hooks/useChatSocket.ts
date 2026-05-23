/**
 * Sprint B5 — Mobile chat WebSocket hook.
 *
 * Doctrine (mirrors backend `app/chat/realtime.py`):
 *   - WS is ACCELERATION over polling, never replacement.
 *     Polling in `useChatMessages` and `useChatThreads` keeps running.
 *     This hook just calls the same `onRefresh` faster than polling would.
 *   - WS does NOT mutate local state. Every event triggers a canonical
 *     REST refetch (`onRefresh`) so the projection on screen is
 *     ALWAYS what REST returns. No optimistic merge, no socket-only
 *     state model — that was the architectural risk B5 explicitly
 *     forbids.
 *   - On disconnect, polling carries state. Reconnect is exponential
 *     with a cap; on app foreground we always retry immediately.
 *
 * Event types the hook reacts to:
 *   `new_message`, `reaction_update`, `thread_update`, `unread_update`
 *   (plus `hello` / `ping` / `pong` housekeeping which is ignored).
 *
 * Usage:
 *   useChatSocket({ enabled, onRefresh });
 * Pass a stable `onRefresh` (wrap in `useCallback`).
 */
import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const API_URL =
  process.env.EXPO_PUBLIC_BACKEND_URL ||
  ((Constants?.expoConfig?.extra as any)?.EXPO_PUBLIC_BACKEND_URL as string) ||
  '';

function wsBase(): string {
  // Map http(s):// → ws(s):// at the same origin/path so the kubernetes
  // ingress routing for `/api/*` is preserved verbatim.
  return API_URL.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
}

interface UseChatSocketArgs {
  enabled: boolean;
  // Called for any semantic event. Implementations should debounce
  // their own refresh logic if necessary — this hook fires per-event.
  onRefresh: (event: { type: string; payload?: any }) => void;
}

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

export function useChatSocket({ enabled, onRefresh }: UseChatSocketArgs) {
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef<number>(INITIAL_BACKOFF_MS);
  const aliveRef = useRef<boolean>(true);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pin the latest callback in a ref so we don't tear down the
  // connection when the caller passes a fresh inline handler.
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    aliveRef.current = true;

    async function connect() {
      if (!aliveRef.current || !enabled) return;
      try {
        const token = (await AsyncStorage.getItem('auth_token')) || '';
        if (!token) {
          // No token yet — polling substrate covers us; retry after
          // a short delay in case the auth context is mid-warmup.
          scheduleReconnect(backoffRef.current);
          return;
        }
        const url = `${wsBase()}/api/chat/v1/ws?token=${encodeURIComponent(token)}`;
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          // Successful connect → reset backoff. Subsequent failures
          // start from the floor again.
          backoffRef.current = INITIAL_BACKOFF_MS;
        };
        ws.onmessage = (e) => {
          try {
            const ev = JSON.parse(e.data);
            if (!ev || typeof ev !== 'object') return;
            const t = ev.type;
            // The four semantic events trigger a canonical refetch.
            // We do NOT mutate state from the WS payload itself —
            // see doctrine note at the top of this file.
            if (
              t === 'new_message' ||
              t === 'reaction_update' ||
              t === 'thread_update' ||
              t === 'unread_update'
            ) {
              onRefreshRef.current(ev);
            }
            // hello / ping / pong are housekeeping and intentionally ignored.
          } catch {
            // Malformed frame — drop silently; polling will recover state.
          }
        };
        ws.onerror = () => {
          // Don't log spam — onclose is the durable signal.
        };
        ws.onclose = () => {
          wsRef.current = null;
          if (!aliveRef.current || !enabled) return;
          scheduleReconnect(backoffRef.current);
          // Exponential backoff up to ceiling; reset on successful onopen.
          backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
        };
      } catch {
        scheduleReconnect(backoffRef.current);
      }
    }

    function scheduleReconnect(delayMs: number) {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delayMs);
    }

    // Foreground recovery: when the app comes back from suspend, the
    // OS may have killed the socket. Retry immediately instead of
    // waiting on the backoff. Polling already covers the gap.
    const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active' && !wsRef.current && enabled) {
        backoffRef.current = INITIAL_BACKOFF_MS;
        scheduleReconnect(0);
      }
    });

    if (enabled) connect();

    return () => {
      aliveRef.current = false;
      appStateSub.remove();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* nothing actionable */
        }
      }
    };
  }, [enabled]);
}

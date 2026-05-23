/**
 * useNotifications — canonical polling transport (Sprint A2).
 *
 * Pure transport layer. Owns:
 *   - 25s polling cadence
 *   - AsyncStorage cache (last items, unread count, cursor)
 *   - Focus invalidation via useFocusEffect()
 *   - mark-read / mark-all-read RPCs
 *
 * Does NOT own:
 *   - formatting / grouping / rendering
 *   - mobile/web/admin surface logic
 *   - provider/customer/cluster role logic
 *   - chat unread (lives in a separate hook in A3a)
 *   - optimistic updates beyond local mark-read mutation
 *   - websocket / SSE / realtime subscription
 *   - global event bus / Redux / Zustand / React Query
 *
 * Boundary contract — surfaces depend ONLY on the return shape declared here,
 * never on internal cache keys or polling internals.
 *
 * Wire contract: `shared/domain/contracts/notification.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import api from '../services/api';
import type {
  Notification,
  UnreadCountResponse,
  NotificationSinceResponse,
} from '@platform/domain/contracts/notification';

// ─────────────────────────────────────────────────────────────────────
// Constants — frozen by sprint scope
// ─────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 25_000;

const CACHE_KEY_LAST = 'notifications:last';
const CACHE_KEY_UNREAD = 'notifications:unread';
const CACHE_KEY_CURSOR = 'notifications:cursor';

/**
 * Keep cache small — bell drawer shows recent slice, full list page does
 * its own paginated fetch.
 */
const CACHE_MAX_ITEMS = 50;

// ─────────────────────────────────────────────────────────────────────
// Return shape — frozen contract
// ─────────────────────────────────────────────────────────────────────

export interface UseNotificationsResult {
  readonly unreadCount: number;
  readonly notifications: Notification[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly markRead: (id: string) => Promise<void>;
  readonly markAllRead: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────

export function useNotifications(enabled: boolean = true): UseNotificationsResult {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // Cursor for /since polling. ISO string. Empty on first run → full slice.
  const cursorRef = useRef<string>('');
  // Tracks mount state — avoid setState after unmount on slow polls.
  const mountedRef = useRef<boolean>(true);
  // Tracks in-flight poll to coalesce focus-burst + interval.
  const inflightRef = useRef<boolean>(false);

  // ── Cache hydration on mount ────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [lastRaw, unreadRaw, cursorRaw] = await Promise.all([
          AsyncStorage.getItem(CACHE_KEY_LAST),
          AsyncStorage.getItem(CACHE_KEY_UNREAD),
          AsyncStorage.getItem(CACHE_KEY_CURSOR),
        ]);
        if (cancelled) return;
        if (lastRaw) {
          try {
            const parsed = JSON.parse(lastRaw) as Notification[];
            if (Array.isArray(parsed)) setNotifications(parsed);
          } catch {
            // Corrupt cache — ignore.
          }
        }
        if (unreadRaw) {
          const n = parseInt(unreadRaw, 10);
          if (Number.isFinite(n) && n >= 0) setUnreadCount(n);
        }
        if (cursorRaw) cursorRef.current = cursorRaw;
      } catch {
        // Storage errors are not fatal — polling will recover.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Persist on change (debounced via microtask batching) ───────
  useEffect(() => {
    AsyncStorage.setItem(CACHE_KEY_UNREAD, String(unreadCount)).catch(() => {});
  }, [unreadCount]);

  useEffect(() => {
    AsyncStorage.setItem(
      CACHE_KEY_LAST,
      JSON.stringify(notifications.slice(0, CACHE_MAX_ITEMS)),
    ).catch(() => {});
  }, [notifications]);

  // ── Core poll fn ────────────────────────────────────────────────
  const poll = useCallback(async (): Promise<void> => {
    if (!enabled) {
      // Sprint Guest-2: short-circuit for unauthenticated viewers — they
      // see a curated info feed at the screen level, no API calls.
      setLoading(false);
      return;
    }
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const params: Record<string, string | number> = { limit: CACHE_MAX_ITEMS };
      if (cursorRef.current) params.after = cursorRef.current;
      const res = await api.get<NotificationSinceResponse>('/notifications/since', {
        params,
      });
      const data = res.data;
      if (!mountedRef.current) return;
      // Server returns `serverTime` — use it as the cursor for the next call.
      // It is server-side ISO and avoids client clock skew.
      const nextCursor = data.serverTime || '';
      cursorRef.current = nextCursor;
      AsyncStorage.setItem(CACHE_KEY_CURSOR, nextCursor).catch(() => {});

      // Merge delta into existing list (newest first). The /since endpoint
      // returns items strictly after `after`; for first call (empty after)
      // it returns the recent slice. We dedupe by id.
      setNotifications((prev) => {
        if (!data.items || data.items.length === 0) return prev;
        const seen = new Set<string>();
        const merged: Notification[] = [];
        for (const n of data.items) {
          if (!seen.has(n.id)) {
            seen.add(n.id);
            merged.push(n);
          }
        }
        for (const n of prev) {
          if (!seen.has(n.id)) {
            seen.add(n.id);
            merged.push(n);
          }
        }
        return merged.slice(0, CACHE_MAX_ITEMS);
      });
      setUnreadCount(typeof data.unread === 'number' ? data.unread : 0);
      setError(null);
    } catch (e: any) {
      if (!mountedRef.current) return;
      // Network blips are common on mobile — don't blank the cache.
      setError(e?.message || 'network');
    } finally {
      if (mountedRef.current) setLoading(false);
      inflightRef.current = false;
    }
  }, [enabled]);
  useEffect(() => {
    mountedRef.current = true;
    void poll();
    const handle = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(handle);
    };
  }, [poll]);

  // ── Focus invalidation — useFocusEffect (NOT AppState) ─────────
  useFocusEffect(
    useCallback(() => {
      void poll();
      return () => {
        // Nothing to tear down on blur — the global interval keeps polling.
      };
    }, [poll]),
  );

  // ── Mutations ──────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    // Force a full slice on next poll.
    cursorRef.current = '';
    await AsyncStorage.removeItem(CACHE_KEY_CURSOR).catch(() => {});
    await poll();
  }, [poll]);

  const markRead = useCallback(
    async (id: string) => {
      // Optimistic local update — mirrors server semantics (atomic
      // mark-read in chat/router.py: idempotent + decrements unread iff
      // previously unread).
      let wasUnread = false;
      setNotifications((prev) =>
        prev.map((n) => {
          if (n.id !== id) return n;
          if (!n.isRead) wasUnread = true;
          return { ...n, isRead: true, readAt: new Date().toISOString() };
        }),
      );
      if (wasUnread) setUnreadCount((c) => Math.max(0, c - 1));
      try {
        await api.post(`/notifications/${encodeURIComponent(id)}/read`);
      } catch (e) {
        // Server rejected — roll back to truth via next poll. We do not
        // attempt fine-grained revert here; the next /since will reconcile.
      }
    },
    [],
  );

  const markAllRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    try {
      await api.post('/notifications/read-all');
    } catch {
      // Same reconciliation strategy as markRead.
    }
  }, []);

  return {
    unreadCount,
    notifications,
    loading,
    error,
    refresh,
    markRead,
    markAllRead,
  };
}

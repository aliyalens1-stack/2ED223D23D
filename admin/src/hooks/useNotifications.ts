/**
 * useNotifications — admin polling transport (Sprint A3c).
 *
 * Identical transport contract as `web-app/src/hooks/useNotifications.ts`
 * and `frontend/src/hooks/useNotifications.ts` — same 25 s cadence, same
 * cursor semantics, same wire shape (`shared/domain/contracts/notification.ts`),
 * same return shape. Browser bindings (localStorage + visibilitychange/focus).
 *
 * The admin surface reads the SAME `/api/notifications/since` endpoint as
 * every other surface; admin-targeted broadcasts arrive because the user's
 * role is `admin|superadmin|operator` and the projector fanned them out.
 * No admin-specific filtering happens client-side — that's a server concern.
 *
 * Pure transport — no formatting, no grouping, no surface logic.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../services/api';
import type {
  Notification,
  NotificationSinceResponse,
} from '@platform/domain/contracts/notification';

// Frozen by sprint scope.
const POLL_INTERVAL_MS = 25_000;
const CACHE_KEY_LAST = 'admin:notifications:last';
const CACHE_KEY_UNREAD = 'admin:notifications:unread';
const CACHE_KEY_CURSOR = 'admin:notifications:cursor';
const CACHE_MAX_ITEMS = 50;

export interface UseNotificationsResult {
  readonly unreadCount: number;
  readonly notifications: Notification[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly markRead: (id: string) => Promise<void>;
  readonly markAllRead: () => Promise<void>;
}

export function useNotifications(enabled: boolean = true): UseNotificationsResult {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string | null>(null);

  const cursorRef = useRef<string>('');
  const mountedRef = useRef<boolean>(true);
  const inflightRef = useRef<boolean>(false);

  // Hydrate from localStorage.
  useEffect(() => {
    try {
      const lastRaw = localStorage.getItem(CACHE_KEY_LAST);
      if (lastRaw) {
        const parsed = JSON.parse(lastRaw) as Notification[];
        if (Array.isArray(parsed)) setNotifications(parsed);
      }
      const unreadRaw = localStorage.getItem(CACHE_KEY_UNREAD);
      if (unreadRaw) {
        const n = parseInt(unreadRaw, 10);
        if (Number.isFinite(n) && n >= 0) setUnreadCount(n);
      }
      const cursorRaw = localStorage.getItem(CACHE_KEY_CURSOR);
      if (cursorRaw) cursorRef.current = cursorRaw;
    } catch {
      /* Safari private mode or quota exceeded — not fatal */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CACHE_KEY_UNREAD, String(unreadCount));
    } catch { /* ignore */ }
  }, [unreadCount]);

  useEffect(() => {
    try {
      localStorage.setItem(
        CACHE_KEY_LAST,
        JSON.stringify(notifications.slice(0, CACHE_MAX_ITEMS)),
      );
    } catch { /* ignore */ }
  }, [notifications]);

  const poll = useCallback(async () => {
    if (!enabled) return;
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
      const nextCursor = data.serverTime || '';
      cursorRef.current = nextCursor;
      try {
        localStorage.setItem(CACHE_KEY_CURSOR, nextCursor);
      } catch { /* ignore */ }
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
      // 401 means user is logged out — silently treat as no notifications.
      if (e?.status === 401 || e?.original?.response?.status === 401) {
        setUnreadCount(0);
        setNotifications([]);
        setError(null);
      } else {
        setError(e?.message || 'network');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
      inflightRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }
    void poll();
    const handle = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(handle);
    };
  }, [poll, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const handler = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    window.addEventListener('visibilitychange', handler);
    window.addEventListener('focus', handler);
    return () => {
      window.removeEventListener('visibilitychange', handler);
      window.removeEventListener('focus', handler);
    };
  }, [poll, enabled]);

  const refresh = useCallback(async () => {
    cursorRef.current = '';
    try {
      localStorage.removeItem(CACHE_KEY_CURSOR);
    } catch { /* ignore */ }
    await poll();
  }, [poll]);

  const markRead = useCallback(async (id: string) => {
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
    } catch { /* server reconciles on next poll */ }
  }, []);

  const markAllRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    try {
      await api.post('/notifications/read-all');
    } catch { /* ignore */ }
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

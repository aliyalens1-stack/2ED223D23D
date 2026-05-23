/**
 * useChatUnread — canonical chat unread (web, Sprint B2).
 *
 * Reads `GET /api/chat/v1/unread-summary`. Replaces the Sprint A3b
 * `sum(thread.unreadCount)` placeholder. Backend is the single source
 * of truth — surfaces never recompute.
 *
 * Polling cadence aligned with the bell hook (25 s).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../services/api';

const POLL_INTERVAL_MS = 25_000;

interface UnreadSummaryWire {
  totalUnread?: number;
  perThread?: { threadId: string; unread: number }[];
  serverTime?: string;
}

export interface UseChatUnreadResult {
  readonly unreadCount: number;
  readonly loading: boolean;
}

export function useChatUnread(enabled: boolean = true): UseChatUnreadResult {
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(enabled);
  const mountedRef = useRef(true);
  const inflightRef = useRef(false);

  const poll = useCallback(async () => {
    if (!enabled || inflightRef.current) return;
    inflightRef.current = true;
    try {
      const res = await api.get<UnreadSummaryWire>('/chat/v1/unread-summary');
      if (!mountedRef.current) return;
      const total = typeof res.data?.totalUnread === 'number' ? res.data.totalUnread : 0;
      setUnreadCount(Math.max(0, total));
    } catch {
      /* keep last value */
    } finally {
      if (mountedRef.current) setLoading(false);
      inflightRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) { setLoading(false); return () => { mountedRef.current = false; }; }
    void poll();
    const h = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => { mountedRef.current = false; window.clearInterval(h); };
  }, [poll, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => { if (document.visibilityState === 'visible') void poll(); };
    window.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [poll, enabled]);

  return { unreadCount, loading };
}

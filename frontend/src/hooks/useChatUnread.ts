/**
 * useChatUnread — canonical total-unread polling (Sprint B2).
 *
 * Migrated to `/api/chat/v1/unread-summary` from the temporary
 * `sum(thread.unreadCount)` heuristic (Sprint A3a placeholder).
 * Server is the single source of truth — surfaces never recompute.
 *
 * Polling cadence stays at 25 s (aligned with the bell hook); the
 * active-thread hook polls separately at 8-10 s when focused.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
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

export function useChatUnread(): UseChatUnreadResult {
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const mountedRef = useRef<boolean>(true);
  const inflightRef = useRef<boolean>(false);

  const poll = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const res = await api.get<UnreadSummaryWire>('/chat/v1/unread-summary');
      if (!mountedRef.current) return;
      const total = typeof res.data?.totalUnread === 'number' ? res.data.totalUnread : 0;
      setUnreadCount(Math.max(0, total));
    } catch {
      /* preserve last known good value; the header should never go blank */
    } finally {
      if (mountedRef.current) setLoading(false);
      inflightRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void poll();
    const handle = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => { mountedRef.current = false; clearInterval(handle); };
  }, [poll]);

  useFocusEffect(useCallback(() => { void poll(); return undefined; }, [poll]));

  return { unreadCount, loading };
}

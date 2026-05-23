/**
 * useChatThreads — canonical thread list polling (Sprint B2).
 *
 * Reads `GET /api/chat/v1/threads`. Returns `ChatThread[]` straight from
 * the wire — no client-side mapping, no recomputed unread. Pagination is
 * cursor-based; the first page is loaded on mount, more pages on demand.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import api from '../services/api';
import type {
  ChatThread,
  ChatThreadsResponse,
} from '@platform/domain/contracts/chat';

const POLL_INTERVAL_MS = 15_000;
const PAGE_SIZE = 30;

export interface UseChatThreadsResult {
  readonly threads: ChatThread[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly refresh: () => Promise<void>;
  readonly loadMore: () => Promise<void>;
}

export function useChatThreads(enabled: boolean = true): UseChatThreadsResult {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const inflightRef = useRef(false);

  const fetchPage = useCallback(async (cursor: string | null, append: boolean) => {
    if (!enabled || inflightRef.current) return;
    inflightRef.current = true;
    try {
      const params: Record<string, string | number> = { limit: PAGE_SIZE };
      if (cursor) params.after = cursor;
      const res = await api.get<ChatThreadsResponse>('/chat/v1/threads', { params });
      if (!mountedRef.current) return;
      const incoming = res.data.threads || [];
      setThreads((prev) => {
        if (!append) return incoming.slice();
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...incoming.filter((t) => !seen.has(t.id))];
      });
      setNextCursor(res.data.nextCursor ?? null);
      setError(null);
    } catch (e: any) {
      if (!mountedRef.current) return;
      if (e?.response?.status === 401) {
        setThreads([]);
        setError(null);
      } else {
        setError(e?.message || 'network');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
      inflightRef.current = false;
    }
  }, [enabled]);

  const refresh = useCallback(async () => {
    setNextCursor(null);
    await fetchPage(null, false);
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    await fetchPage(nextCursor, true);
  }, [nextCursor, fetchPage]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchPage(null, false);
    const handle = setInterval(() => void fetchPage(null, false), POLL_INTERVAL_MS);
    return () => { mountedRef.current = false; clearInterval(handle); };
  }, [fetchPage]);

  useFocusEffect(useCallback(() => { void fetchPage(null, false); return undefined; }, [fetchPage]));

  return { threads, loading, error, hasMore: nextCursor !== null, refresh, loadMore };
}

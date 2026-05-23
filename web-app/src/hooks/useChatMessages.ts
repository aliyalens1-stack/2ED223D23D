/**
 * useChatMessages — canonical messages polling (web, Sprint B2).
 *
 * Same contract as the mobile hook; browser bindings (focus +
 * visibilitychange instead of useFocusEffect).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../services/api';
import type {
  ChatMessage,
  ChatThread,
  ChatMessagesResponse,
  ChatSendMessageResponse,
  ChatMarkReadResponse,
} from '@platform/domain/contracts/chat';

const POLL_INTERVAL_MS = 8_000;
const PAGE_SIZE = 50;

export interface UseChatMessagesResult {
  readonly thread: ChatThread | null;
  readonly messages: ChatMessage[];
  readonly loading: boolean;
  readonly sending: boolean;
  readonly error: string | null;
  readonly send: (body: string) => Promise<boolean>;
  readonly markRead: () => Promise<boolean>;
  readonly refresh: () => Promise<void>;
}

export function useChatMessages(threadId: string | null | undefined, enabled: boolean = true): UseChatMessagesResult {
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState<boolean>(!!enabled && !!threadId);
  const [sending, setSending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const inflightRef = useRef(false);

  const poll = useCallback(async (reset: boolean) => {
    if (!enabled || !threadId || inflightRef.current) return;
    inflightRef.current = true;
    try {
      const params: Record<string, string | number> = { limit: PAGE_SIZE };
      if (!reset && cursorRef.current) params.after = cursorRef.current;
      const res = await api.get<ChatMessagesResponse>(
        `/chat/v1/threads/${encodeURIComponent(threadId)}/messages`,
        { params },
      );
      if (!mountedRef.current) return;
      const incoming = res.data.messages || [];
      setThread(res.data.thread);
      setMessages((prev) => {
        if (reset) {
          cursorRef.current = incoming.length ? incoming[incoming.length - 1].createdAt : null;
          return incoming.slice();
        }
        if (incoming.length === 0) return prev;
        const seen = new Set(prev.map((m) => m.id));
        const merged = prev.concat(incoming.filter((m) => !seen.has(m.id)));
        cursorRef.current = merged.length ? merged[merged.length - 1].createdAt : cursorRef.current;
        return merged;
      });
      setError(null);
    } catch (e: any) {
      if (!mountedRef.current) return;
      if (e?.response?.status === 403) setError('forbidden');
      else if (e?.response?.status === 404) setError('not_found');
      else setError(e?.message || 'network');
    } finally {
      if (mountedRef.current) setLoading(false);
      inflightRef.current = false;
    }
  }, [enabled, threadId]);

  const refresh = useCallback(async () => { cursorRef.current = null; await poll(true); }, [poll]);

  const send = useCallback(async (body: string): Promise<boolean> => {
    const text = body.trim();
    if (!text || !threadId) return false;
    setSending(true);
    try {
      const res = await api.post<ChatSendMessageResponse>(
        `/chat/v1/threads/${encodeURIComponent(threadId)}/messages`,
        { body: text },
      );
      if (!mountedRef.current) return false;
      setMessages((prev) => prev.some((m) => m.id === res.data.message.id) ? prev : prev.concat([res.data.message]));
      setThread(res.data.thread);
      cursorRef.current = res.data.message.createdAt;
      return true;
    } catch {
      return false;
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }, [threadId]);

  const markRead = useCallback(async (): Promise<boolean> => {
    if (!threadId) return false;
    try {
      const res = await api.post<ChatMarkReadResponse>(`/chat/v1/threads/${encodeURIComponent(threadId)}/read`);
      if (!mountedRef.current) return false;
      if (res.data.mutated) {
        setMessages((prev) => prev.map((m) => (m.isMine ? m : { ...m, readAt: m.readAt || new Date().toISOString() })));
        setThread((t) => (t ? { ...t, unreadByMe: 0 } : t));
      }
      return res.data.mutated;
    } catch {
      return false;
    }
  }, [threadId]);

  useEffect(() => {
    mountedRef.current = true;
    if (!threadId || !enabled) { setLoading(false); return () => { mountedRef.current = false; }; }
    setLoading(true);
    void poll(true);
    const h = window.setInterval(() => void poll(false), POLL_INTERVAL_MS);
    return () => { mountedRef.current = false; window.clearInterval(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, enabled]);

  useEffect(() => {
    if (!threadId || !enabled) return;
    const onFocus = () => { if (document.visibilityState === 'visible') void poll(false); };
    window.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [poll, threadId, enabled]);

  return { thread, messages, loading, sending, error, send, markRead, refresh };
}

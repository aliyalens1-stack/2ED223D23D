/**
 * useServiceChats — Sprint 4.5 inbox polling hook.
 *
 * Polls /api/service-chats/me every 30s while screen is mounted.
 * Returns the canonical Sprint 4 chats enriched with request metadata
 * (title, category, city, status) so inbox cards can show «Repair —
 * Berlin · BMW X5».
 *
 * Deliberately separate from the legacy `useChatThreads` hook (which is
 * support-only). The inbox screen merges both into a sectioned list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

export type ServiceChatStatus = 'active' | 'closed' | 'frozen';

export type ServiceRequestStatus =
  | 'open'
  | 'matching'
  | 'bidding'
  | 'paid'
  | 'in_progress'
  | 'completed'
  | 'released'
  | 'cancelled';

export interface ServiceChatItem {
  id: string;
  requestId: string;
  customerId: string;
  providerId: string;
  status: ServiceChatStatus;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadForMe: number;
  flagsCount: number;
  createdAt: string;
  updatedAt: string;
  frozenAt: string | null;
  request: {
    title: string | null;
    category: string | null;
    city: string | null;
    status: ServiceRequestStatus | null;
  } | null;
}

interface State {
  chats: ServiceChatItem[];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;
}

const DEFAULT_POLL_MS = 30_000;

export function useServiceChats(options: { pollMs?: number; enabled?: boolean } = {}) {
  const { pollMs = DEFAULT_POLL_MS, enabled = true } = options;
  const { user } = useAuth();
  const [state, setState] = useState<State>({
    chats: [],
    loading: true,
    error: null,
    lastFetchedAt: null,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const fetchChats = useCallback(async () => {
    if (!user) {
      setState((s) => ({ ...s, loading: false, chats: [] }));
      return;
    }
    try {
      const res = await api.get<{ chats: ServiceChatItem[]; total: number }>(
        '/api/service-chats/me',
      );
      if (!mountedRef.current) return;
      setState({
        chats: res.data.chats ?? [],
        loading: false,
        error: null,
        lastFetchedAt: Date.now(),
      });
    } catch (e: any) {
      if (!mountedRef.current) return;
      setState((s) => ({
        ...s,
        loading: false,
        error: e?.response?.data?.detail || e?.message || 'Failed to load chats',
      }));
    }
  }, [user]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !user) return;
    fetchChats();
    intervalRef.current = setInterval(fetchChats, pollMs);
    return () => {
      mountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled, user, fetchChats, pollMs]);

  return {
    chats: state.chats,
    loading: state.loading,
    error: state.error,
    refetch: fetchChats,
    totalUnread: state.chats.reduce((sum, c) => sum + (c.unreadForMe ?? 0), 0),
  };
}

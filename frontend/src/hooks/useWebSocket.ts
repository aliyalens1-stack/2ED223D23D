import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useAuth } from '../context/AuthContext';

// Get the backend URL for WebSocket
const getWsUrl = () => {
  const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL || '';
  // NestJS WebSocket runs on 3001 but proxied — use /realtime namespace
  // For web preview, connect directly to the backend URL
  return backendUrl.replace(/\/api$/, '').replace(/\/$/, '');
};

// ═══════════════════════════════════════════════
// WebSocket Events (matching backend RealtimeGateway)
// ═══════════════════════════════════════════════
export const WS_EVENTS = {
  // Provider events
  PROVIDER_NEW_REQUEST: 'provider:new_request',
  PROVIDER_REQUEST_TAKEN: 'provider:request_taken',
  PROVIDER_JOB_UPDATED: 'provider:job_updated',
  PROVIDER_PRE_ENGAGE: 'provider:pre_engage',   // Sprint 18
  // Customer events
  BOOKING_PROVIDER_LOCATION: 'booking:provider_location',
  BOOKING_STATUS_CHANGED: 'booking:status_changed',
  // Global events
  MARKET_SURGE_UPDATED: 'market:surge_updated',
  // Generic
  NOTIFICATION: 'notification',
  CONNECTED: 'connected',
} as const;

interface WebSocketMessage {
  event: string;
  data: any;
  timestamp: string;
}

type EventHandler = (data: any) => void;

interface UseRealtimeOptions {
  autoConnect?: boolean;
  events?: Record<string, EventHandler>;
}

// ═══════════════════════════════════════════════
// REALTIME HOOK — Replaces polling with events
// Uses SSE/polling fallback since socket.io may not work in web preview
// ═══════════════════════════════════════════════
export function useRealtime(options: UseRealtimeOptions = {}) {
  const { user, token } = useAuth();
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WebSocketMessage | null>(null);
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastEventTimeRef = useRef<string>(new Date().toISOString());

  // Register event handlers
  const on = useCallback((event: string, handler: EventHandler) => {
    if (!handlersRef.current.has(event)) {
      handlersRef.current.set(event, new Set());
    }
    handlersRef.current.get(event)!.add(handler);
    return () => {
      handlersRef.current.get(event)?.delete(handler);
    };
  }, []);

  // Emit via API (for location updates etc.)
  const emit = useCallback(async (event: string, data: any) => {
    try {
      const baseUrl = process.env.EXPO_PUBLIC_BACKEND_URL || '';
      await fetch(`${baseUrl}/api/realtime/emit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ event, data }),
      });
    } catch (e) {
      console.log('[Realtime] Emit error:', e);
    }
  }, [token]);

  // Dispatch event to registered handlers
  const dispatch = useCallback((event: string, data: any) => {
    const handlers = handlersRef.current.get(event);
    if (handlers) {
      handlers.forEach(handler => handler(data));
    }
    // Also dispatch to wildcard handlers
    const wildcardHandlers = handlersRef.current.get('*');
    if (wildcardHandlers) {
      wildcardHandlers.forEach(handler => handler({ event, data }));
    }
  }, []);

  // Poll for events (fast polling as realtime fallback)
  const pollEvents = useCallback(async () => {
    if (!token) return;
    try {
      const baseUrl = process.env.EXPO_PUBLIC_BACKEND_URL || '';
      const res = await fetch(
        `${baseUrl}/api/realtime/events?since=${encodeURIComponent(lastEventTimeRef.current)}&limit=20`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      if (res.ok) {
        const payload = await res.json();
        // Backend (NestJS realtime controller) returns { events: [...], total, timestamp }.
        // Some older mocks returned a flat array — поддерживаем обе формы.
        const events: any[] = Array.isArray(payload)
          ? payload
          : (Array.isArray(payload?.events) ? payload.events : []);
        if (events.length > 0) {
          events.forEach((evt: any) => {
            setLastEvent(evt);
            dispatch(evt.type || evt.event, evt.data || evt);
            if (evt.createdAt || evt.timestamp) {
              lastEventTimeRef.current = evt.createdAt || evt.timestamp;
            }
          });
        }
        setIsConnected(true);
      }
    } catch (e) {
      // Silent fail - polling will retry
    }
  }, [token, dispatch]);

  // Start fast polling (1.5s for realtime feel)
  const startPolling = useCallback(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(pollEvents, 1500);
    pollEvents(); // Immediate first poll
  }, [pollEvents]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  // Register initial event handlers from options
  useEffect(() => {
    if (options.events) {
      const cleanups: (() => void)[] = [];
      Object.entries(options.events).forEach(([event, handler]) => {
        cleanups.push(on(event, handler));
      });
      return () => cleanups.forEach(c => c());
    }
  }, []);

  // Connect/disconnect based on auth
  useEffect(() => {
    if (user && token && options.autoConnect !== false) {
      startPolling();
      setIsConnected(true);
    } else {
      stopPolling();
      setIsConnected(false);
    }
    return () => stopPolling();
  }, [user, token]);

  // Handle app state changes (pause polling in background)
  useEffect(() => {
    const handleAppState = (state: AppStateStatus) => {
      if (state === 'active' && user && token) {
        startPolling();
      } else if (state === 'background') {
        stopPolling();
      }
    };
    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, [user, token, startPolling, stopPolling]);

  return {
    isConnected,
    lastEvent,
    on,
    emit,
    dispatch,
  };
}

// ═══════════════════════════════════════════════
// PROVIDER REALTIME — events for provider inbox
// ═══════════════════════════════════════════════
export function useProviderRealtime(callbacks?: {
  onNewRequest?: (data: any) => void;
  onRequestTaken?: (data: any) => void;
  onJobUpdated?: (data: any) => void;
  onPreEngage?: (data: any) => void;   // Sprint 18
}) {
  const [newRequestCount, setNewRequestCount] = useState(0);

  const { isConnected, on } = useRealtime({
    autoConnect: true,
    events: {
      [WS_EVENTS.PROVIDER_NEW_REQUEST]: (data) => {
        setNewRequestCount(c => c + 1);
        callbacks?.onNewRequest?.(data);
      },
      [WS_EVENTS.PROVIDER_REQUEST_TAKEN]: (data) => {
        callbacks?.onRequestTaken?.(data);
      },
      [WS_EVENTS.PROVIDER_JOB_UPDATED]: (data) => {
        callbacks?.onJobUpdated?.(data);
      },
      [WS_EVENTS.PROVIDER_PRE_ENGAGE]: (data) => {
        callbacks?.onPreEngage?.(data);
      },
    },
  });

  const resetCount = useCallback(() => setNewRequestCount(0), []);

  return { isConnected, newRequestCount, resetCount, on };
}

// ═══════════════════════════════════════════════
// CUSTOMER REALTIME — live tracking events
// ═══════════════════════════════════════════════
export function useCustomerRealtime(bookingId?: string, callbacks?: {
  onProviderLocation?: (data: any) => void;
  onStatusChanged?: (data: any) => void;
  onSurgeUpdated?: (data: any) => void;
}) {
  const { isConnected, on } = useRealtime({
    autoConnect: true,
    events: {
      [WS_EVENTS.BOOKING_PROVIDER_LOCATION]: (data) => {
        if (!bookingId || data.bookingId === bookingId) {
          callbacks?.onProviderLocation?.(data);
        }
      },
      [WS_EVENTS.BOOKING_STATUS_CHANGED]: (data) => {
        if (!bookingId || data.bookingId === bookingId) {
          callbacks?.onStatusChanged?.(data);
        }
      },
      [WS_EVENTS.MARKET_SURGE_UPDATED]: (data) => {
        callbacks?.onSurgeUpdated?.(data);
      },
    },
  });

  return { isConnected, on };
}

// ═══════════════════════════════════════════════
// BOOKING REFRESH — simple hook for any screen
// ═══════════════════════════════════════════════
export function useBookingRefresh(bookingId?: string) {
  const [refreshKey, setRefreshKey] = useState(0);

  useCustomerRealtime(bookingId, {
    onStatusChanged: () => setRefreshKey(k => k + 1),
    onProviderLocation: () => setRefreshKey(k => k + 1),
  });

  return refreshKey;
}

// ═══════════════════════════════════════════════
// NOTIFICATION COUNT — realtime badge
// ═══════════════════════════════════════════════
export function useNotificationCount() {
  const [unreadCount, setUnreadCount] = useState(0);

  useRealtime({
    autoConnect: true,
    events: {
      [WS_EVENTS.NOTIFICATION]: () => setUnreadCount(c => c + 1),
    },
  });

  const resetCount = useCallback(() => setUnreadCount(0), []);
  return { unreadCount, resetCount };
}

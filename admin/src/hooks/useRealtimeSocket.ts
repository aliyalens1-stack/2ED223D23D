/**
 * useRealtimeSocket — React hook for socket.io events (Sprint 4).
 *
 * Uses the socket.io client from src/lib/socket.ts.
 * Coexists with existing polling-based src/hooks/useRealtime.ts (fallback layer).
 */

import { useEffect, useState } from 'react';
import { realtime, RealtimeStatus } from '../lib/socket';

export function useRealtimeStatus(): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>(realtime.getStatus());
  useEffect(() => {
    realtime.connect();
    const unsub = realtime.onStatusChange(setStatus);
    return () => { unsub(); };
  }, []);
  return status;
}

export function useRealtimeEvent<T = any>(
  event: string,
  handler: (payload: T) => void,
  deps: any[] = [],
) {
  const status = useRealtimeStatus();
  useEffect(() => {
    const unsub = realtime.on(event, handler);
    return () => { unsub?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, ...deps]);
  return { status };
}

export function useRealtimeEvents(
  handlers: Record<string, (payload: any) => void>,
  deps: any[] = [],
) {
  const status = useRealtimeStatus();
  useEffect(() => {
    const unsubs = Object.entries(handlers).map(([ev, h]) => realtime.on(ev, h));
    return () => { unsubs.forEach((u) => u?.()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { status };
}

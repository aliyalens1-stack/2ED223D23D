import { useEffect, useState, useCallback, useRef } from 'react';
import { realtimeService } from '../services/realtime';

// Hook for WebSocket connection status
export function useRealtimeConnection() {
  const [connected, setConnected] = useState(realtimeService.isConnected());

  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    if (token && !realtimeService.isConnected()) {
      realtimeService.connect(token);
    }

    const unsubscribe = realtimeService.on('connection_status', (data) => {
      setConnected(data.connected);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const reconnect = useCallback(() => {
    const token = localStorage.getItem('admin_token');
    realtimeService.disconnect();
    realtimeService.connect(token || undefined);
  }, []);

  return { connected, reconnect };
}

// Hook for subscribing to specific events
export function useRealtimeEvent<T = any>(
  eventType: string,
  callback: (data: T) => void,
  deps: any[] = []
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const handler = (data: T) => {
      callbackRef.current(data);
    };

    const unsubscribe = realtimeService.on(eventType, handler);
    return unsubscribe;
  }, [eventType, ...deps]);
}

// Hook for subscribing to multiple events
export function useRealtimeEvents<T = any>(
  eventTypes: string[],
  callback: (eventType: string, data: T) => void,
  deps: any[] = []
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const unsubscribes = eventTypes.map((eventType) => {
      const handler = (data: T) => {
        callbackRef.current(eventType, data);
      };
      return realtimeService.on(eventType, handler);
    });

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [eventTypes.join(','), ...deps]);
}

// Hook for live feed of all events
export function useLiveFeed(maxEvents = 50) {
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    const unsubscribe = realtimeService.on('all', (data) => {
      setEvents((prev) => {
        const newEvents = [data, ...prev].slice(0, maxEvents);
        return newEvents;
      });
    });

    return unsubscribe;
  }, [maxEvents]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  return { events, clearEvents };
}

// Hook for provider locations (for live map)
export function useProviderLocations() {
  const [locations, setLocations] = useState<Map<string, { lat: number; lng: number; name: string; isOnline: boolean }>>(new Map());

  useEffect(() => {
    const handleLocationUpdate = (data: any) => {
      if (data.data?.id && data.data?.location) {
        setLocations((prev) => {
          const newMap = new Map(prev);
          newMap.set(data.data.id, {
            lat: data.data.location.lat,
            lng: data.data.location.lng,
            name: data.data.name,
            isOnline: data.data.isOnline !== false,
          });
          return newMap;
        });
      }
    };

    const handleOnline = (data: any) => {
      if (data.data?.id) {
        setLocations((prev) => {
          const newMap = new Map(prev);
          const existing = newMap.get(data.data.id);
          if (existing) {
            newMap.set(data.data.id, { ...existing, isOnline: true });
          } else if (data.data.location) {
            newMap.set(data.data.id, {
              lat: data.data.location.lat || data.data.location.coordinates?.[1],
              lng: data.data.location.lng || data.data.location.coordinates?.[0],
              name: data.data.name,
              isOnline: true,
            });
          }
          return newMap;
        });
      }
    };

    const handleOffline = (data: any) => {
      if (data.data?.id) {
        setLocations((prev) => {
          const newMap = new Map(prev);
          const existing = newMap.get(data.data.id);
          if (existing) {
            newMap.set(data.data.id, { ...existing, isOnline: false });
          }
          return newMap;
        });
      }
    };

    const unsub1 = realtimeService.on('provider.location.updated', handleLocationUpdate);
    const unsub2 = realtimeService.on('provider.online', handleOnline);
    const unsub3 = realtimeService.on('provider.offline', handleOffline);

    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
  }, []);

  return locations;
}

// Hook for live request updates
export function useRequestUpdates(onNewRequest?: (data: any) => void, onUpdate?: (data: any) => void) {
  useEffect(() => {
    const unsubscribes: (() => void)[] = [];

    if (onNewRequest) {
      unsubscribes.push(realtimeService.on('request.created', onNewRequest));
    }

    if (onUpdate) {
      unsubscribes.push(realtimeService.on('request.updated', onUpdate));
      unsubscribes.push(realtimeService.on('provider.responded', onUpdate));
      unsubscribes.push(realtimeService.on('request.expired', onUpdate));
      unsubscribes.push(realtimeService.on('request.escalated', onUpdate));
    }

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [onNewRequest, onUpdate]);
}

// Hook for live booking updates
export function useBookingUpdates(onUpdate: (eventType: string, data: any) => void) {
  useEffect(() => {
    const events = [
      'booking.created',
      'booking.confirmed',
      'booking.started',
      'booking.completed',
      'booking.cancelled',
    ];

    const unsubscribes = events.map((event) =>
      realtimeService.on(event, (data) => onUpdate(event, data))
    );

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [onUpdate]);
}

// Hook for alerts
export function useAlerts() {
  const [alerts, setAlerts] = useState<any[]>([]);

  useEffect(() => {
    const handleAlert = (data: any) => {
      setAlerts((prev) => [data, ...prev].slice(0, 20));
    };

    const handleSlaWarning = (data: any) => {
      setAlerts((prev) => [
        {
          type: data.data?.timeLeftMinutes < 5 ? 'critical' : 'warning',
          title: `SLA Warning: ${data.data?.entity}`,
          description: `${data.data?.timeLeftMinutes} минут до просрочки`,
          data: data.data,
          timestamp: data.timestamp,
        },
        ...prev,
      ].slice(0, 20));
    };

    const unsub1 = realtimeService.on('alert.created', handleAlert);
    const unsub2 = realtimeService.on('sla.warning', handleSlaWarning);
    const unsub3 = realtimeService.on('sla.breach', handleSlaWarning);

    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
  }, []);

  const dismissAlert = useCallback((index: number) => {
    setAlerts((prev) => prev.filter((_, i) => i !== index));
  }, []);

  return { alerts, dismissAlert };
}

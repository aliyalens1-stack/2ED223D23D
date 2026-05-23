/**
 * Sprint 8 — App Foreground Refresh hook.
 *
 * Calls the provided callback when the app moves from background → foreground.
 * Used to refresh money-sensitive data (messages, requests, disputes, payouts)
 * so the user never sees stale state after switching apps.
 *
 * Usage:
 *   useForegroundRefresh(() => {
 *     refetchRequests();
 *     refetchNotifications();
 *   });
 *
 * Web is a no-op (web tab visibility events handled by react-query stale time).
 */
import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';

export function useForegroundRefresh(callback: () => void | Promise<void>) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const handler = (state: AppStateStatus) => {
      if (state === 'active') {
        try {
          void cbRef.current();
        } catch {
          // never throw
        }
      }
    };
    const sub = AppState.addEventListener('change', handler);
    return () => sub.remove();
  }, []);
}

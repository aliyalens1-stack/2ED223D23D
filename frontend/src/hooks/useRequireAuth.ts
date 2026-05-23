import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';

// Sprint Auth-2: useRequireAuth — guard для protected actions.
// Если юзер гость / без токена:
//   1. Сохраняет действие в pendingAction (in-memory ref)
//   2. Сохраняет intent-tag в AuthContext (persist в AsyncStorage)
//   3. Открывает AuthRequiredModal
// После успешного login (`onSuccessAuth()`):
//   - Перезапускает pendingAction (если процесс жив)
//   - Чистит intent
// Login-screen после login сам читает pendingIntent и редиректит на нужный экран.
//
// Usage:
//   const { requireAuth, authModalVisible, closeAuthModal } = useRequireAuth();
//   <Pressable onPress={() => requireAuth(
//     () => confirmBooking(),
//     { intent: 'booking_confirm', params: { bookingId } }
//   )} />
//   <AuthRequiredModal visible={authModalVisible} onClose={closeAuthModal} />
type RequireAuthOpts = {
  intent?: string;
  params?: Record<string, string>;
  reason?: string;
};

export function useRequireAuth() {
  const auth = useAuth();
  const [authModalVisible, setAuthModalVisible] = useState(false);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const pendingActionRef = useRef<null | (() => void)>(null);

  const requireAuth = useCallback(
    (action: () => void, opts: RequireAuthOpts = {}) => {
      if (auth.isAuthenticated && auth.token) {
        action();
        return true;
      }
      // Гость → сохраняем action + intent-tag, открываем модалку
      pendingActionRef.current = action;
      setReason(opts.reason);
      setAuthModalVisible(true);
      if (opts.intent) {
        // fire-and-forget — persist intent для login screen
        void auth.setPendingIntent(opts.intent, opts.params || null);
      }
      return false;
    },
    [auth.isAuthenticated, auth.token, auth.setPendingIntent]
  );

  const closeAuthModal = useCallback(() => {
    setAuthModalVisible(false);
    setReason(undefined);
    pendingActionRef.current = null;
  }, []);

  // Если юзер залогинился пока модалка открыта (edge case) — replay action
  const onSuccessAuth = useCallback(() => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    setAuthModalVisible(false);
    setReason(undefined);
    if (action) action();
  }, []);

  return {
    requireAuth,
    authModalVisible,
    closeAuthModal,
    onSuccessAuth,
    authReason: reason,
    isAuthenticated: auth.isAuthenticated,
    isGuest: auth.isGuest,
    mode: auth.mode,
  };
}

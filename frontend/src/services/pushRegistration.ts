/**
 * Sprint 31 — Expo push token registration helper.
 *
 * Called on login/register. No-op on web (or in environments that don't
 * grant permissions). Registers the token against the backend so
 * `send_push()` can deliver real push notifications.
 */
import { Platform } from 'react-native';
import axios from 'axios';

const API = process.env.EXPO_PUBLIC_BACKEND_URL || '';

export async function registerExpoPushToken(opts: {
  userId?: string;
  providerSlug?: string;
  token?: string;
}): Promise<boolean> {
  // Skip web — Expo push requires native build
  if (Platform.OS === 'web') return false;

  try {
    // Lazy import to avoid web bundling cost
    const Notifications = await import('expo-notifications').catch(() => null);
    if (!Notifications) return false;

    const perm = await Notifications.getPermissionsAsync();
    let status = perm.status;
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') return false;

    const tokenObj = await Notifications.getExpoPushTokenAsync();
    const expoPushToken = tokenObj?.data;
    if (!expoPushToken) return false;

    await axios.post(`${API}/api/push/register`, {
      expoPushToken,
      userId: opts.userId,
      providerSlug: opts.providerSlug,
      platform: Platform.OS,
      device: '',
    }, { headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {} });
    return true;
  } catch {
    return false;
  }
}

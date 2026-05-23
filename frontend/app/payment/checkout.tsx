/**
 * Stage 4 — Checkout bridge screen.
 *
 * Opens Stripe Checkout URL. On native uses expo-web-browser; on web redirects window.location.
 * After browser session returns (or in parallel), UI moves to /booking/payment-success.
 */
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import Text from '../../src/components/ui/Text';
import { useThemeContext } from '../../src/context/ThemeContext';
import { Ionicons } from '@expo/vector-icons';

export default function CheckoutBridgeScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { checkoutUrl, sessionId, paymentId } = useLocalSearchParams<{
    checkoutUrl: string; sessionId: string; paymentId: string;
  }>();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!checkoutUrl) return;

    (async () => {
      const url = decodeURIComponent(String(checkoutUrl));
      if (Platform.OS === 'web') {
        // Web: redirect current tab to Stripe — Stripe will return to our success_url
        window.location.href = url;
        return;
      }
      // Native: open system browser; after user closes it, we move to polling screen
      try {
        await WebBrowser.openBrowserAsync(url);
      } catch {
        // fallthrough
      }
      router.replace({
        pathname: '/booking/payment-success',
        params: { session_id: String(sessionId || ''), paymentId: String(paymentId || '') },
      } as any);
    })();
  }, [checkoutUrl, sessionId, paymentId, router]);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} testID="checkout-bridge">
      <View style={styles.center}>
        <View style={[styles.icon, { backgroundColor: colors.brandSoft }]}>
          <Ionicons name="lock-closed" size={28} color={colors.brand} />
        </View>
        <ActivityIndicator size="large" color={colors.brand} style={{ marginTop: 24 }} />
        <Text variant="h3" style={{ marginTop: 18, textAlign: 'center' }}>
          Открываем защищённую оплату...
        </Text>
        <Text variant="caption" tone="muted" style={{ marginTop: 8, textAlign: 'center', maxWidth: 280 }}>
          Безопасная оплата через Stripe — без скрытых платежей
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  icon: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center',
  },
});

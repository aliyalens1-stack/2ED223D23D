/**
 * Stage 4 — Payment Cancel screen.
 * Arrives from Stripe Checkout when user cancels. Simple retry CTA.
 */
import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Text from '../../src/components/ui/Text';
import { useThemeContext } from '../../src/context/ThemeContext';

export default function PaymentCancelScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']} testID="payment-cancel-screen">
      <View style={styles.center}>
        <View style={[styles.icon, { backgroundColor: 'rgba(156,163,175,0.2)' }]}>
          <Ionicons name="close-circle" size={48} color={colors.textSecondary} />
        </View>
        <Text variant="h2" weight="900" style={{ marginTop: 18, textAlign: 'center' }}>
          Оплата отменена
        </Text>
        <Text variant="body" tone="muted" style={{ marginTop: 10, textAlign: 'center', maxWidth: 280 }}>
          Ваш заказ не подтверждён. Вы можете выбрать мастера снова.
        </Text>
      </View>

      <TouchableOpacity
        testID="payment-cancel-back-btn"
        style={[styles.cta, { backgroundColor: colors.brand }]}
        onPress={() => router.replace('/(tabs)' as any)}
        activeOpacity={0.88}
      >
        <Text variant="h3" weight="900" style={{ color: '#0A0A0A' }}>
          На главную
        </Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  icon: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
  },
  cta: {
    marginHorizontal: 20, marginBottom: 16,
    height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
});

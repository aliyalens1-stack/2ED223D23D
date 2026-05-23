// Phase 3.0b P0-1 — Payment cancelled landing.
// Reached when user closes Stripe Checkout. No charge has been made.
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../src/context/ThemeContext';

export default function PaymentCancelledScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']} testID="payment-cancelled-screen">
      <ScrollView contentContainerStyle={styles.body}>
        <View style={[styles.iconBox, { backgroundColor: 'rgba(245,158,11,0.15)' }]}>
          <Ionicons name="close-circle" size={56} color="#F59E0B" />
        </View>
        <Text style={[styles.title, { color: colors.text }]} testID="payment-cancelled-title">
          {t('payment.cancelled_title') || 'Payment cancelled'}
        </Text>
        <Text style={[styles.sub, { color: colors.textSecondary }]}>
          {t('payment.cancelled_hint') || 'No charge was made. You can try again any time.'}
        </Text>
        <TouchableOpacity
          testID="payment-cancelled-back"
          style={[styles.btn, { backgroundColor: colors.primary }]}
          onPress={() => router.replace('/auto-request/choose' as any)}
        >
          <Text style={styles.btnText}>{t('payment.try_again') || 'Try again'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="payment-cancelled-home"
          style={[styles.linkBtn]}
          onPress={() => router.replace('/' as any)}
        >
          <Text style={[styles.linkText, { color: colors.textSecondary }]}>
            {t('common.home', { defaultValue: 'Back to home' })}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 },
  iconBox: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  title: { fontSize: 22, fontWeight: '800', textAlign: 'center' },
  sub: { fontSize: 15, textAlign: 'center', lineHeight: 22, maxWidth: 360 },
  btn: { marginTop: 20, paddingVertical: 14, paddingHorizontal: 26, borderRadius: 14 },
  btnText: { color: '#FFF', fontSize: 16, fontWeight: '800' },
  linkBtn: { paddingVertical: 12 },
  linkText: { fontSize: 14, fontWeight: '600' },
});

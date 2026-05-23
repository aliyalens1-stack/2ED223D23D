/**
 * Stage 4 — Payment Success (polling).
 *
 * Arrives from Stripe Checkout with ?session_id={CHECKOUT_SESSION_ID}.
 * Polls GET /api/payments/status/{session_id} until status=='paid' or 'expired'.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Text from '../../src/components/ui/Text';
import { useThemeContext } from '../../src/context/ThemeContext';
import { paymentsAPI, PaymentStatusResponse } from '../../src/services/api';
import { tokens } from '../../src/theme/tokens';
import { useTranslation } from 'react-i18next';
import i18n from '../../src/i18n';

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 8;

export default function PaymentSuccessScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useThemeContext();
  const { session_id, paymentId } = useLocalSearchParams<{ session_id?: string; paymentId?: string }>();

  const [status, setStatus] = useState<PaymentStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attemptsRef = useRef(0);
  const timerRef = useRef<any>(null);
  const sessionIdStr = String(session_id || '');

  useEffect(() => {
    if (!sessionIdStr) {
      setError(t('booking.ne_peredan_session_id'));
      return;
    }
    const poll = async () => {
      try {
        const res = await paymentsAPI.getStatus(sessionIdStr);
        setStatus(res.data);
        if (res.data.status === 'paid' || res.data.status === 'expired' || res.data.status === 'failed') {
          return;
        }
        if (attemptsRef.current >= MAX_POLL_ATTEMPTS) {
          setError(i18n.t('booking.tajmaut_proverki_poprobujte_obnovit'));
          return;
        }
        attemptsRef.current += 1;
        timerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (e: any) {
        setError(e?.response?.data?.message || e?.message || i18n.t('booking.oshibka_proverki_statusa'));
      }
    };
    poll();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [sessionIdStr]);

  const isPaid = status?.status === 'paid';
  const isExpired = status?.status === 'expired' || status?.status === 'failed';
  const isLoading = !status && !error;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']} testID="payment-success-screen">
      <ScrollView contentContainerStyle={styles.scroll}>
        {isLoading && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.brand} />
            <Text variant="h3" style={{ marginTop: 20, textAlign: 'center' }}>
              Подтверждаем оплату...
            </Text>
            <Text variant="caption" tone="muted" style={{ marginTop: 8, textAlign: 'center', maxWidth: 280 }}>
              Это займёт пару секунд
            </Text>
          </View>
        )}

        {error && (
          <View style={styles.center}>
            <View style={[styles.icon, { backgroundColor: 'rgba(239,68,68,0.15)' }]}>
              <Ionicons name="alert-circle" size={40} color="#EF4444" />
            </View>
            <Text variant="h2" weight="900" style={{ marginTop: 18, textAlign: 'center' }}>
              Не удалось подтвердить
            </Text>
            <Text variant="body" tone="muted" style={{ marginTop: 8, textAlign: 'center' }}>
              {error}
            </Text>
          </View>
        )}

        {isExpired && !error && (
          <View style={styles.center}>
            <View style={[styles.icon, { backgroundColor: 'rgba(156,163,175,0.2)' }]}>
              <Ionicons name="time" size={40} color={colors.textSecondary} />
            </View>
            <Text variant="h2" weight="900" style={{ marginTop: 18, textAlign: 'center' }}>
              Сессия истекла
            </Text>
            <Text variant="body" tone="muted" style={{ marginTop: 8, textAlign: 'center' }}>
              Попробуйте выбрать мастера снова
            </Text>
          </View>
        )}

        {isPaid && (
          <View style={styles.center}>
            <View style={[styles.icon, { backgroundColor: colors.successBg || 'rgba(16,185,129,0.15)' }]}>
              <Ionicons name="checkmark-circle" size={64} color={colors.success} />
            </View>
            <Text variant="kicker" tone="brand" style={{ marginTop: 20, textAlign: 'center' }}>
              Оплата прошла
            </Text>
            <Text variant="h1" weight="900" style={{ marginTop: 6, textAlign: 'center' }}>
              Мастер подтверждён
            </Text>
            <Text variant="body" tone="muted" style={{ marginTop: 10, textAlign: 'center', maxWidth: 320 }}>
              Вы оплатили €{status?.amount} — мастер уже получил заявку и скоро свяжется с вами
            </Text>

            {/* Booking timeline — UX audit Stage 3 (next steps) */}
            <View style={[styles.timelineCard, { backgroundColor: colors.card, borderColor: colors.border }]} testID="payment-timeline">
              <View style={styles.timelineRow}>
                <Ionicons name="checkmark-circle" size={20} color={colors.success || colors.brand} />
                <Text variant="body" weight="700" style={{ flex: 1 }}>
                  Мастер уже едет
                </Text>
              </View>
              <View style={styles.timelineRow}>
                <Ionicons name="time-outline" size={20} color={colors.brand} />
                <Text variant="body" weight="700" style={{ flex: 1 }}>
                  ETA: 15 минут
                </Text>
              </View>
              <View style={styles.timelineRow}>
                <Ionicons name="chatbubble-ellipses" size={20} color={colors.success || colors.brand} />
                <Text variant="body" weight="700" style={{ flex: 1 }}>
                  Мы отправили вам SMS-уведомление
                </Text>
              </View>
              <View style={styles.timelineRow}>
                <Ionicons name="shield-checkmark" size={18} color={colors.success} />
                <Text variant="caption" weight="600" tone="muted" style={{ flex: 1 }}>
                  Безопасная оплата через Stripe
                </Text>
              </View>
            </View>

            <View style={[styles.infoCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.cardRow}>
                <Ionicons name="pricetag" size={18} color={colors.textSecondary} />
                <Text variant="body" weight="700">€{status?.amount} {status?.currency}</Text>
              </View>
              {status?.bookingId && (
                <View style={styles.cardRow}>
                  <Ionicons name="receipt" size={18} color={colors.textSecondary} />
                  <Text variant="caption" tone="muted" selectable>
                    ID: {status.bookingId.slice(0, 13)}...
                  </Text>
                </View>
              )}
            </View>
          </View>
        )}
      </ScrollView>

      {/* Dual-CTA when paid: View booking + Contact */}
      {isPaid && status?.bookingId ? (
        <View style={styles.ctaRow}>
          <TouchableOpacity
            testID="payment-view-booking-btn"
            style={[styles.ctaPrimary, { backgroundColor: colors.brand }]}
            activeOpacity={0.88}
            onPress={() => router.replace(`/booking/${status.bookingId}` as any)}
          >
            <Ionicons name="eye" size={18} color={tokens.colors.onBrand} />
            <Text variant="body" weight="900" style={{ color: tokens.colors.onBrand }}>
              Смотреть заказ
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="payment-contact-btn"
            style={[styles.ctaSecondary, { borderColor: colors.border, backgroundColor: colors.card }]}
            activeOpacity={0.88}
            onPress={() => router.replace(`/booking/${status.bookingId}` as any)}
          >
            <Ionicons name="chatbubble-ellipses" size={18} color={colors.text} />
            <Text variant="body" weight="800">
              Связаться
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          testID="payment-back-home-btn"
          style={[styles.cta, { backgroundColor: isPaid ? colors.brand : colors.card, borderColor: colors.border }]}
          activeOpacity={0.88}
          onPress={() => router.replace('/(tabs)' as any)}
        >
          <Text variant="h3" weight="900" style={{ color: isPaid ? tokens.colors.onBrand : colors.text }}>
            {isPaid ? t('inspector.na_glavnuyu') : t('booking.vernutsya')}
          </Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 20 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 400 },
  icon: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
  },
  infoCard: {
    width: '100%', maxWidth: 420,
    borderRadius: 16, borderWidth: StyleSheet.hairlineWidth,
    padding: 18, marginTop: 16, gap: 12,
  },
  timelineCard: {
    width: '100%', maxWidth: 420,
    borderRadius: 16, borderWidth: StyleSheet.hairlineWidth,
    padding: 18, marginTop: 24, gap: 12,
  },
  timelineRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  cardRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  cta: {
    marginHorizontal: 20, marginBottom: 16,
    height: 56, borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaRow: {
    flexDirection: 'row',
    marginHorizontal: 20, marginBottom: 16,
    gap: 10,
  },
  ctaPrimary: {
    flex: 1.4, height: 54, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  ctaSecondary: {
    flex: 1, height: 54, borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
});

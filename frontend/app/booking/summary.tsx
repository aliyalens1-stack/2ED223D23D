/**
 * Stage 4 — Booking Summary screen.
 *
 * Flow change (UX audit):  offers → SUMMARY → payment → confirm
 * Why: pre-payment trust building. Booking summary lifts conversion
 * by showing what user is paying for + reassuring with TÜV/Stripe trust.
 *
 * Receives quote payload via params (JSON-encoded). On CTA tap → calls
 * paymentsAPI.createCheckout and replaces with /payment/checkout.
 */
import React, { useMemo, useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Text from '../../src/components/ui/Text';
import { useThemeContext } from '../../src/context/ThemeContext';
import { paymentsAPI, Quote } from '../../src/services/api';
import { useTranslation } from 'react-i18next';
import i18n from '../../src/i18n';

// Server-side fee tiers (mirror of backend SERVICE_FEES_MAJOR for display)
const FEE_BY_SERVICE: Record<string, number> = {
  pre_purchase: 149,
  diagnostics: 49,
  oil_change: 29,
  brakes: 29,
  engine: 29,
  battery: 29,
  tires: 29,
  towing: 29,
};

export default function BookingSummaryScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useThemeContext();
  const { quote: quoteParam, requestId, serviceKey } =
    useLocalSearchParams<{ quote?: string; requestId?: string; serviceKey?: string }>();

  const [loading, setLoading] = useState(false);

  const quote: Quote | null = useMemo(() => {
    if (!quoteParam) return null;
    try {
      return JSON.parse(decodeURIComponent(String(quoteParam)));
    } catch {
      return null;
    }
  }, [quoteParam]);

  if (!quote) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} testID="booking-summary-empty">
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
          <Text variant="h3" weight="800" style={{ marginTop: 12 }}>
            Нет данных о заказе
          </Text>
          <TouchableOpacity
            style={[styles.cta, { backgroundColor: colors.brand, marginTop: 20 }]}
            onPress={() => router.replace('/(tabs)' as any)}
          >
            <Text variant="body" weight="900" style={{ color: '#000' }}>
              Вернуться
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const fee = FEE_BY_SERVICE[String(serviceKey || '')] ?? 29;
  const providerPrice = quote.priceFrom || 0;
  const totalUserPays = fee; // we charge platform fee at checkout; provider price is paid separately to provider on-site
  const provider = quote.provider || ({} as any);

  const handleConfirm = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const origin =
        typeof window !== 'undefined' && window.location?.origin
          ? window.location.origin
          : (process.env.EXPO_PUBLIC_BACKEND_URL || 'https://mobile-web-stack-6.preview.emergentagent.com');
      const res = await paymentsAPI.createCheckout(quote.id, origin);
      const { checkoutUrl, sessionId, paymentId } = res.data;
      router.replace({
        pathname: '/payment/checkout',
        params: {
          checkoutUrl: encodeURIComponent(checkoutUrl),
          sessionId,
          paymentId,
        },
      } as any);
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || i18n.t('booking.ne_udalos_nachat_oplatu');
      Alert.alert(i18n.t('chat.oshibka'), msg);
      setLoading(false);
    }
  };

  return (
    <SafeAreaView
      style={[styles.screen, { backgroundColor: colors.background }]}
      edges={['top', 'bottom']}
      testID="booking-summary-screen"
    >
      <View style={styles.topRow}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.card }]}
          testID="summary-back-btn"
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text variant="kicker" tone="brand">Step 2 of 3</Text>
          <Text variant="h2" weight="900">{t('inspector.podtverzhdenie')}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Provider summary card */}
        <View
          style={[styles.providerCard, { backgroundColor: colors.card, borderColor: colors.border }]}
          testID="summary-provider-card"
        >
          <View style={styles.providerHeader}>
            <View style={[styles.avatar, { backgroundColor: colors.brandSoft }]}>
              <Text variant="h3" weight="900" style={{ color: colors.brand }}>
                {(provider.name || '?').charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="h3" weight="900" numberOfLines={1}>
                {provider.name || 'Provider'}
              </Text>
              <View style={styles.starRow}>
                <Ionicons name="star" size={14} color={colors.brand} />
                <Text variant="body" weight="700">
                  {provider.rating ? provider.rating.toFixed(1) : '—'}
                </Text>
                {provider.reviews ? (
                  <Text variant="caption" tone="muted">({provider.reviews} reviews)</Text>
                ) : null}
                {provider.tuvVerified ? (
                  <View style={[styles.tuvPill, { backgroundColor: colors.brandSoft }]}>
                    <Ionicons name="ribbon" size={11} color={colors.brand} />
                    <Text variant="caption" weight="800" style={{ color: colors.brand }}>TÜV</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </View>

          <View style={styles.providerStats}>
            {provider.yearsExperience ? (
              <View style={styles.statItem}>
                <Ionicons name="briefcase" size={16} color={colors.textSecondary} />
                <Text variant="caption" weight="700">{provider.yearsExperience}+ years</Text>
              </View>
            ) : null}
            {quote.estimatedTimeMinutes ? (
              <View style={styles.statItem}>
                <Ionicons name="time" size={16} color={colors.textSecondary} />
                <Text variant="caption" weight="700">~{quote.estimatedTimeMinutes} min</Text>
              </View>
            ) : null}
            {provider.isVerified ?? provider.tuvVerified ? (
              <View style={styles.statItem}>
                <Ionicons name="shield-checkmark" size={16} color={colors.success} />
                <Text variant="caption" weight="700">Verified</Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* Price breakdown */}
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]} testID="summary-breakdown">
          <Text variant="caption" weight="800" tone="muted" style={{ marginBottom: 10 }}>
            СТОИМОСТЬ
          </Text>
          {providerPrice > 0 ? (
            <View style={styles.row}>
              <Text variant="body">{t('booking.usluga_mastera_ot')}</Text>
              <Text variant="body" weight="700">€{providerPrice.toFixed(0)}</Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <Text variant="body">{t('booking.platforma_bronirovanie')}</Text>
            <Text variant="body" weight="700">€{fee.toFixed(0)}</Text>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.row}>
            <Text variant="body" weight="900">{t('booking.k_oplate_sejchas')}</Text>
            <Text variant="h2" weight="900" style={{ color: colors.brand }}>€{totalUserPays.toFixed(0)}</Text>
          </View>
          {providerPrice > 0 ? (
            <Text variant="caption" tone="muted" style={{ marginTop: 6 }}>
              Стоимость работ мастера оплачивается ему напрямую после выполнения
            </Text>
          ) : null}
        </View>

        {/* Trust block */}
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]} testID="summary-trust">
          <View style={styles.trustRow}>
            <Ionicons name="shield-checkmark" size={20} color={colors.success || colors.brand} />
            <Text variant="body" weight="700" style={{ flex: 1 }}>
              {provider.tuvVerified ? 'TÜV verified mechanic' : 'Verified mechanic'}
            </Text>
          </View>
          <View style={styles.trustRow}>
            <Ionicons name="lock-closed" size={20} color={colors.success || colors.brand} />
            <Text variant="body" weight="700" style={{ flex: 1 }}>
              Оплата защищена Stripe
            </Text>
          </View>
          <View style={styles.trustRow}>
            <Ionicons name="card" size={20} color={colors.success || colors.brand} />
            <Text variant="body" weight="700" style={{ flex: 1 }}>
              Деньги списываются только после подтверждения
            </Text>
          </View>
          <View style={styles.trustRow}>
            <Ionicons name="refresh" size={20} color={colors.success || colors.brand} />
            <Text variant="body" weight="700" style={{ flex: 1 }}>
              Возврат средств в течение 24 часов
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* Sticky CTA */}
      <View style={[styles.ctaWrap, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
        <TouchableOpacity
          testID="summary-confirm-btn"
          style={[styles.cta, { backgroundColor: colors.brand }, loading && { opacity: 0.7 }]}
          onPress={handleConfirm}
          disabled={loading}
          activeOpacity={0.88}
        >
          {loading ? (
            <ActivityIndicator color="#000" />
          ) : (
            <>
              <Ionicons name="lock-closed" size={18} color="#000" />
              <Text variant="h3" weight="900" style={{ color: '#000' }}>
                Оплатить €{totalUserPays.toFixed(0)} и подтвердить
              </Text>
            </>
          )}
        </TouchableOpacity>
        <View style={styles.smallTrustRow}>
          <Ionicons name="information-circle-outline" size={12} color={colors.textMuted} />
          <Text variant="caption" tone="muted">
            Вы будете перенаправлены на безопасную страницу Stripe
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  topRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 18, paddingTop: 8, paddingBottom: 14, gap: 12,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  scroll: { paddingHorizontal: 20, paddingBottom: 20, gap: 14 },
  providerCard: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 14,
  },
  providerHeader: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
  },
  starRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tuvPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    marginLeft: 4,
  },
  providerStats: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 14,
  },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  section: {
    borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 10,
  },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
  trustRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  ctaWrap: {
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  cta: {
    height: 56, borderRadius: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  smallTrustRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4,
  },
});

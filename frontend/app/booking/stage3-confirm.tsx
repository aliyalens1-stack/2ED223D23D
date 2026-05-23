/**
 * Stage 3 — Booking Confirmation screen.
 *
 * UX v2 (confidence + retention layer):
 *   1. Emotional hero — "Great choice 👌 / Your inspector is already on it"
 *   2. Timeline — 4 steps (assigned ✓ → dispatch → inspect → report)
 *   3. Notifications info — "We'll notify you when..."
 *   4. Upsell — 3-pack save €147 (subtle, after primary CTA)
 *   5. Referral — invite friend → both get €20
 *   6. Primary CTA → "Track status" (forward, not back)
 */
import React, { useEffect, useState, useRef } from 'react';
import {
  View, StyleSheet, ActivityIndicator, TouchableOpacity, ScrollView,
  Animated, Easing, Platform, Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import Text from '../../src/components/ui/Text';
import { useThemeContext } from '../../src/context/ThemeContext';
import { tokens } from '../../src/theme/tokens';
import i18n from '../../src/i18n';

type TimelineStep = {
  key: string;
  icon: keyof typeof import('@expo/vector-icons/Ionicons').glyphMap;
  title: string;
  sub: string;
  done: boolean;
};

// ── Live activity feed pool (curated, multilingual via i18n templates) ──
type LiveItem =
  | { type: 'inspecting'; name: string; car: string; city: string; minutesAgo: number }
  | { type: 'report_done'; name: string; city: string; minutesAgo: number }
  | { type: 'stats'; count: number };

const LIVE_POOL: LiveItem[] = [
  { type: 'inspecting', name: 'Anna', car: 'BMW 320d', city: 'Berlin', minutesAgo: 0 },
  { type: 'report_done', name: 'Mark', city: 'München', minutesAgo: 2 },
  { type: 'stats', count: 3 },
  { type: 'inspecting', name: 'Lukas', car: 'Audi A4', city: 'Hamburg', minutesAgo: 1 },
  { type: 'report_done', name: 'Sofia', city: 'Frankfurt', minutesAgo: 4 },
  { type: 'inspecting', name: 'Tomas', car: 'Mercedes C200', city: 'Köln', minutesAgo: 0 },
  { type: 'report_done', name: 'Elena', city: 'Stuttgart', minutesAgo: 6 },
  { type: 'inspecting', name: 'Niko', car: 'VW Golf', city: 'Berlin', minutesAgo: 1 },
];

function LiveActivityRow({ item }: { item: LiveItem }) {
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(8)).current;
  useEffect(() => {
    fade.setValue(0); slide.setValue(8);
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 320, useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  }, [item, fade, slide]);

  let label = '';
  let icon: keyof typeof import('@expo/vector-icons/Ionicons').glyphMap = 'pulse';
  let iconColor = colors.brand;
  if (item.type === 'inspecting') {
    label = t('booking_confirm.live_inspecting', { name: item.name, car: item.car, city: item.city });
    icon = 'search-circle';
  } else if (item.type === 'report_done') {
    label = t('booking_confirm.live_report_done', { name: item.name, city: item.city });
    icon = 'document-text';
    iconColor = colors.success || '#10b981';
  } else {
    label = t('booking_confirm.live_stats', { count: item.count });
    icon = 'flash';
    iconColor = colors.success || '#10b981';
  }
  const timeLabel =
    item.type === 'stats'
      ? null
      : item.minutesAgo === 0
        ? i18n.t('booking_confirm.live_just_now')
        : i18n.t('booking_confirm.live_minutes_ago', { n: item.minutesAgo });

  return (
    <Animated.View
      style={[styles.liveRow, { opacity: fade, transform: [{ translateY: slide }] }]}
      testID={`live-row-${item.type}`}
    >
      <Ionicons name={icon} size={14} color={iconColor} />
      <Text variant="caption" weight="700" style={{ color: '#e5e7eb', flex: 1 }} numberOfLines={2}>
        {label}
      </Text>
      {timeLabel ? (
        <Text variant="caption" weight="600" style={{ color: '#9ca3af', fontSize: 10 }}>
          {timeLabel}
        </Text>
      ) : null}
    </Animated.View>
  );
}

export default function Stage3ConfirmScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();

  const [booking, setBooking] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [referralCopied, setReferralCopied] = useState(false);

  // Live activity feed — rotates 3 visible items every ~4s, simulating live data
  const [liveOffset, setLiveOffset] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setLiveOffset((o) => (o + 1) % LIVE_POOL.length);
    }, 4200);
    return () => clearInterval(id);
  }, []);
  const liveVisible: LiveItem[] = [
    LIVE_POOL[liveOffset % LIVE_POOL.length],
    LIVE_POOL[(liveOffset + 1) % LIVE_POOL.length],
    LIVE_POOL[(liveOffset + 2) % LIVE_POOL.length],
  ];

  // Hero entrance animation — small scale-bounce + fade
  const heroScale = useRef(new Animated.Value(0.85)).current;
  const heroFade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const cached = (globalThis as any).__lastBooking;
    if (cached && cached.id === bookingId) setBooking(cached);
    setLoading(false);
  }, [bookingId]);

  useEffect(() => {
    if (loading) return;
    Animated.parallel([
      Animated.timing(heroScale, { toValue: 1, duration: 460, easing: Easing.out(Easing.back(1.6)), useNativeDriver: true }),
      Animated.timing(heroFade, { toValue: 1, duration: 380, useNativeDriver: true }),
    ]).start();
  }, [loading, heroScale, heroFade]);

  const handleReferral = async () => {
    const link = `https://autoservice.app/r/${bookingId || 'invite'}`;
    try {
      if (Platform.OS === 'web') {
        await (navigator as any).clipboard?.writeText(link);
      } else {
        await Share.share({ message: link });
      }
      setReferralCopied(true);
      setTimeout(() => setReferralCopied(false), 2200);
    } catch (e) {
      // silent
    }
  };

  const handleTrack = () => {
    if (bookingId) {
      router.replace(`/booking/${bookingId}` as any);
    } else {
      router.replace('/(tabs)' as any);
    }
  };

  const steps: TimelineStep[] = [
    { key: 'assigned', icon: 'checkmark-circle', title: i18n.t('booking_confirm.timeline_step_assigned'), sub: i18n.t('booking_confirm.timeline_step_assigned_sub'), done: true },
    { key: 'dispatch', icon: 'car-sport', title: i18n.t('booking_confirm.timeline_step_dispatch'), sub: i18n.t('booking_confirm.timeline_step_dispatch_sub'), done: false },
    { key: 'inspect', icon: 'search-circle', title: i18n.t('booking_confirm.timeline_step_inspect'), sub: i18n.t('booking_confirm.timeline_step_inspect_sub'), done: false },
    { key: 'report', icon: 'document-text', title: i18n.t('booking_confirm.timeline_step_report'), sub: i18n.t('booking_confirm.timeline_step_report_sub'), done: false },
  ];

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']} testID="booking-confirm-screen">
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── 1. HERO ── */}
        <Animated.View
          style={[styles.hero, { opacity: heroFade, transform: [{ scale: heroScale }] }]}
          testID="confirm-hero"
        >
          <View style={[styles.heroIcon, { backgroundColor: colors.successBg || 'rgba(16,185,129,0.15)' }]}>
            <Ionicons name="checkmark-circle" size={56} color={colors.success || '#10b981'} />
          </View>
          <Text variant="kicker" tone="brand" style={styles.heroKicker}>
            {t('booking_confirm.hero_kicker')}
          </Text>
          <Text variant="h1" weight="900" style={styles.heroTitle} testID="confirm-hero-title">
            {t('booking_confirm.hero_title')}
          </Text>
          <Text variant="body" tone="muted" style={styles.heroSubtitle}>
            {t('booking_confirm.hero_subtitle')}
          </Text>
          {/* Aggregate trust — single line, social-proof in numbers */}
          <View style={styles.trustLineRow} testID="confirm-aggregate-trust">
            <Ionicons name="star" size={12} color={colors.brand} />
            <Text variant="caption" weight="700" tone="muted" style={styles.trustLineText}>
              {t('booking_confirm.aggregate_trust')}
            </Text>
          </View>
        </Animated.View>

        {/* ── Inspector card (if booking data available) ── */}
        {booking ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]} testID="confirm-inspector-card">
            <Text variant="caption" tone="muted" weight="800" style={styles.cardKicker}>
              {t('booking_confirm.card_inspector')}
            </Text>
            <View style={styles.cardRow}>
              <View style={[styles.avatar, { backgroundColor: colors.brandSoft }]}>
                <Text style={[styles.avatarInitial, { color: colors.text }]}>
                  {(booking.provider?.name || '?').charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="h3" weight="900">{booking.provider?.name || 'Provider'}</Text>
                {booking.provider?.rating ? (
                  <View style={styles.ratingRow}>
                    <Ionicons name="star" size={13} color={colors.brand} />
                    <Text variant="caption" weight="700">{Number(booking.provider.rating).toFixed(1)}</Text>
                  </View>
                ) : null}
              </View>
              {booking.finalPrice ? (
                <View style={{ alignItems: 'flex-end' }}>
                  <Text variant="caption" tone="muted" weight="700">{t('booking_confirm.card_price')}</Text>
                  <Text variant="h2" weight="900" style={{ color: colors.text }}>€{booking.finalPrice}</Text>
                </View>
              ) : null}
            </View>
          </View>
        ) : null}

        {/* ── 2. TIMELINE ── */}
        <View style={styles.section} testID="confirm-timeline">
          <Text variant="caption" tone="muted" weight="800" style={styles.sectionKicker}>
            {t('booking_confirm.timeline_title').toUpperCase()}
          </Text>
          <View style={[styles.timelineWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {steps.map((s, idx) => {
              const isLast = idx === steps.length - 1;
              return (
                <View key={s.key} style={styles.tlRow} testID={`tl-step-${s.key}`}>
                  <View style={styles.tlIconCol}>
                    <View
                      style={[
                        styles.tlIconBubble,
                        s.done
                          ? { backgroundColor: colors.success || '#10b981' }
                          : { backgroundColor: colors.brandSoft, borderWidth: 1.5, borderColor: colors.brand },
                      ]}
                    >
                      <Ionicons
                        name={s.done ? 'checkmark' : s.icon}
                        size={s.done ? 16 : 14}
                        color={s.done ? '#fff' : colors.brand}
                      />
                    </View>
                    {!isLast ? (
                      <View
                        style={[
                          styles.tlConnector,
                          { backgroundColor: s.done ? (colors.success || '#10b981') : colors.border },
                        ]}
                      />
                    ) : null}
                  </View>
                  <View style={styles.tlTextCol}>
                    {s.done ? (
                      <Text variant="caption" weight="800" style={{ color: colors.success || '#10b981' }}>
                        {t('booking_confirm.timeline_now').toUpperCase()}
                      </Text>
                    ) : null}
                    <Text variant="body" weight="900" style={{ color: colors.text }}>{s.title}</Text>
                    <Text variant="caption" tone="muted" weight="600" style={{ marginTop: 2 }}>{s.sub}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        </View>

        {/* ── 3. NOTIFY block ── */}
        <View style={[styles.notifyBox, { backgroundColor: colors.brandSoft, borderColor: colors.brand }]} testID="confirm-notify">
          <View style={styles.notifyHeader}>
            <Ionicons name="notifications" size={16} color={colors.brand} />
            <Text variant="caption" weight="900" style={{ color: colors.brand, letterSpacing: 0.5 }}>
              {t('booking_confirm.notify_title').toUpperCase()}
            </Text>
          </View>
          {[
            t('booking_confirm.notify_dispatch'),
            t('booking_confirm.notify_inspect'),
            t('booking_confirm.notify_report'),
          ].map((line) => (
            <View key={line} style={styles.notifyRow}>
              <Ionicons name="ellipse" size={6} color={colors.brand} />
              <Text variant="caption" weight="700" style={{ color: colors.text, flex: 1 }}>{line}</Text>
            </View>
          ))}
        </View>

        {/* ── BONUS: Live activity feed — Social Proof in Motion ── */}
        <View style={styles.liveBlock} testID="confirm-live-activity">
          <View style={styles.liveHeader}>
            <View style={styles.liveDot} />
            <Text variant="caption" weight="900" style={{ color: '#fca5a5', letterSpacing: 1 }}>
              {t('booking_confirm.live_kicker')}
            </Text>
          </View>
          {liveVisible.map((item, i) => (
            <LiveActivityRow key={`${liveOffset}-${i}-${item.type}`} item={item} />
          ))}
        </View>

        {/* ── ETA microcopy near CTA ── */}
        <View style={styles.etaRow} testID="confirm-eta">
          <Ionicons name="time" size={12} color={colors.brand} />
          <Text variant="caption" weight="800" style={{ color: colors.brand }}>
            {t('booking_confirm.eta_starts_in')}
          </Text>
        </View>

        {/* ── 6. PRIMARY CTA — forward, not back ── */}
        <TouchableOpacity
          testID="confirm-track-btn"
          style={[styles.primaryCta, { backgroundColor: colors.brand }]}
          activeOpacity={0.88}
          onPress={handleTrack}
        >
          <Ionicons name="pulse" size={20} color={tokens.colors.onBrand} />
          <Text variant="h3" weight="900" style={{ color: tokens.colors.onBrand }}>
            {t('booking_confirm.primary_cta')}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          testID="confirm-home-btn"
          onPress={() => router.replace('/(tabs)' as any)}
          style={styles.secondaryCta}
        >
          <Text variant="caption" tone="muted" weight="700">
            {t('booking_confirm.secondary_cta')}
          </Text>
        </TouchableOpacity>

        {/* ── divider ── */}
        <View style={[styles.divider, { backgroundColor: colors.border }]} />

        {/* ── 4. UPSELL — 3-pack ── */}
        <TouchableOpacity
          testID="confirm-upsell-card"
          activeOpacity={0.92}
          style={[styles.upsellCard, { backgroundColor: colors.card, borderColor: colors.brand }]}
          onPress={() => router.push('/packages' as any)}
        >
          <View style={styles.upsellLeft}>
            <Text variant="caption" tone="brand" weight="900" style={{ letterSpacing: 1 }}>
              {t('booking_confirm.upsell_kicker')}
            </Text>
            <Text variant="h3" weight="900" style={{ marginTop: 4 }}>
              {t('booking_confirm.upsell_title')}
            </Text>
            <Text variant="caption" tone="muted" weight="600" style={{ marginTop: 4 }}>
              {t('booking_confirm.upsell_sub')}
            </Text>
            <View style={[styles.upsellPill, { backgroundColor: colors.brand }]}>
              <Text variant="caption" weight="900" style={{ color: tokens.colors.onBrand, letterSpacing: 0.3 }}>
                {t('booking_confirm.upsell_cta')}
              </Text>
              <Ionicons name="arrow-forward" size={12} color={tokens.colors.onBrand} />
            </View>
          </View>
          <View style={[styles.upsellIcon, { backgroundColor: colors.brandSoft }]}>
            <Ionicons name="layers" size={28} color={colors.brand} />
          </View>
        </TouchableOpacity>

        {/* ── 5. REFERRAL ── */}
        <TouchableOpacity
          testID="confirm-referral-card"
          activeOpacity={0.92}
          style={[styles.referralCard, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={handleReferral}
        >
          <View style={[styles.referralIcon, { backgroundColor: colors.successBg || 'rgba(16,185,129,0.15)' }]}>
            <Ionicons name="gift" size={22} color={colors.success || '#10b981'} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="caption" weight="900" style={{ color: colors.success || '#10b981', letterSpacing: 1 }}>
              {t('booking_confirm.referral_kicker')}
            </Text>
            <Text variant="body" weight="900" style={{ marginTop: 2 }}>
              {t('booking_confirm.referral_title')}
            </Text>
            <Text variant="caption" tone="muted" weight="600" style={{ marginTop: 2 }}>
              {t('booking_confirm.referral_sub')}
            </Text>
          </View>
          <View style={styles.referralCtaCol}>
            <Ionicons name={referralCopied ? 'checkmark-circle' : 'copy'} size={20} color={referralCopied ? (colors.success || '#10b981') : colors.brand} />
            <Text variant="caption" weight="800" style={{ color: referralCopied ? (colors.success || '#10b981') : colors.brand, marginTop: 2, fontSize: 10 }}>
              {referralCopied ? t('booking_confirm.referral_copied') : t('booking_confirm.referral_cta')}
            </Text>
          </View>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 32 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Hero
  hero: { alignItems: 'center', paddingTop: 18, paddingBottom: 6 },
  heroIcon: {
    width: 84, height: 84, borderRadius: 42,
    alignItems: 'center', justifyContent: 'center',
  },
  heroKicker: { marginTop: 18, letterSpacing: 1.4 },
  heroTitle: { textAlign: 'center', marginTop: 8, fontSize: 28, lineHeight: 34 },
  heroSubtitle: { textAlign: 'center', marginTop: 8, maxWidth: 320, lineHeight: 20 },

  // Inspector card
  card: {
    marginTop: 22, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
  },
  cardKicker: { letterSpacing: 1, marginBottom: 10 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarInitial: { fontSize: 18, fontWeight: '900' },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },

  // Section wrappers
  section: { marginTop: 24 },
  sectionKicker: { letterSpacing: 1, marginBottom: 10, marginLeft: 2 },

  // Timeline
  timelineWrap: {
    borderRadius: 16, borderWidth: StyleSheet.hairlineWidth,
    padding: 14, gap: 14,
  },
  tlRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  tlIconCol: { alignItems: 'center', width: 28 },
  tlIconBubble: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  tlConnector: { width: 2, flex: 1, marginTop: 2, minHeight: 22 },
  tlTextCol: { flex: 1, paddingTop: 1, paddingBottom: 4 },

  // Notify
  notifyBox: {
    marginTop: 18, borderRadius: 14, borderWidth: 1,
    padding: 14, gap: 6,
  },
  notifyHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  notifyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  // CTAs
  primaryCta: {
    marginTop: 8, height: 56, borderRadius: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  secondaryCta: { paddingVertical: 14, alignItems: 'center' },

  // Aggregate trust line (under hero)
  trustLineRow: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginTop: 12, paddingHorizontal: 8,
  },
  trustLineText: { textAlign: 'center', flexShrink: 1, fontSize: 11, letterSpacing: 0.2 },

  // ETA row (just above primary CTA)
  etaRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    marginTop: 22, marginBottom: -4,
  },

  // Live activity block — dark theme, distinct from rest
  liveBlock: {
    marginTop: 18, borderRadius: 14,
    backgroundColor: '#111827',
    padding: 14, gap: 10,
    borderWidth: 1, borderColor: '#1f2937',
  },
  liveHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginBottom: 2,
  },
  liveDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#ef4444',
    shadowColor: '#ef4444',
    shadowOpacity: 0.8, shadowRadius: 4, shadowOffset: { width: 0, height: 0 },
  },
  liveRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 4,
  },

  divider: { height: StyleSheet.hairlineWidth, marginVertical: 8 },

  // Upsell
  upsellCard: {
    marginTop: 16, borderRadius: 16, borderWidth: 1.5,
    padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  upsellLeft: { flex: 1 },
  upsellIcon: {
    width: 60, height: 60, borderRadius: 30,
    alignItems: 'center', justifyContent: 'center',
  },
  upsellPill: {
    alignSelf: 'flex-start',
    marginTop: 10,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    flexDirection: 'row', alignItems: 'center', gap: 4,
  },

  // Referral
  referralCard: {
    marginTop: 12, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth,
    padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  referralIcon: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  referralCtaCol: { alignItems: 'center', minWidth: 60 },
});

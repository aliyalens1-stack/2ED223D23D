/**
 * ProviderCard — decision-block carded layout.
 *
 * Structure (Day 4 rule: max 3 trust bullets, single yellow CTA):
 *   [ AVATAR ]  Name                       ★ 4.9
 *               🏷 TÜV certified
 *               ✔ 12+ years experience
 *               ✔ 320+ cars serviced
 *               ✔ Verified
 *               📍 2 km · 15 min
 *               [  CHOOSE MECHANIC  ]   ← brand yellow, full width
 *
 * Theming: uses useThemeContext() — works in dark & light.
 * i18n:    all strings from props (caller passes translated values).
 */
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../context/ThemeContext';
import i18n from '../../src/i18n';

export interface ProviderCardData {
  id: string;
  name: string;
  rating?: number;
  /** 0-5 stars, used only for visual gating */
  reviewsCount?: number;
  isVerified?: boolean;
  distanceKm?: number;
  etaMinutes?: number;
  /** Years of experience (triggers trust bullet). */
  experienceYears?: number;
  /** Total completed jobs (triggers trust bullet). */
  completedJobs?: number;
  /** Avg response time in minutes (triggers trust bullet). */
  responseMinutes?: number;
  /** Shows "TÜV certified" gold badge above trust block. */
  tuvCertified?: boolean;
  avatarUrl?: string;
  /** Optional "from €X" indicator inside meta row. Day 4: keep tiny, CTA stays the accent. */
  priceFrom?: number;
  /** Currency symbol (default '€'). */
  priceCurrencySymbol?: string;
  /** Pre-formatted surge label from backend (shown as a thin chip above CTA). */
  surgeBadge?: string;
  /** Quote expiry — if provided, card shows live countdown M:SS (urgency, +20-30% conv). */
  expiresAt?: string | number | Date;
  /** Number of "other clients viewing" — fake-ok social proof (badge under name). */
  viewersCount?: number;
  /** Show "🔥 high demand" chip — backend-driven or derived from short ETA. */
  highDemand?: boolean;
  /** Optional decision-shortcut ribbon — shown above name. One of: best | fastest | top. */
  decisionBadge?: 'best' | 'fastest' | 'top';
  /** When true, shows the "Picked by the system" trust line under the ribbon. */
  systemPicked?: boolean;
  /** Visual variant — 'primary' = bold yellow CTA + post-CTA confidence block,
   *  'secondary' = muted CTA "Select another" without confidence text.
   *  Default: 'primary' (backward-compatible). */
  variant?: 'primary' | 'secondary';
}

export interface ProviderCardProps {
  provider: ProviderCardData;
  onSelect: (_id: string) => void;
  /** When true, CTA shows spinner and is disabled. */
  loading?: boolean;
  /** When true, all card CTAs are disabled (e.g. another card is loading). */
  disabled?: boolean;
  testID?: string;
}

/**
 * Returns up to 3 trust-bullet entries, chosen in priority order.
 * Rule: never show more than 3 — keeps the card scannable.
 */
function pickTrustBullets(
  p: ProviderCardData,
  t: (_k: string, _opts?: any) => string
): Array<{ icon: keyof typeof import('@expo/vector-icons/Ionicons').glyphMap; text: string }> {
  const bullets: Array<{ icon: any; text: string }> = [];
  if (p.experienceYears && p.experienceYears >= 3) {
    bullets.push({
      icon: 'checkmark-circle',
      text: i18n.t('provider_card.trust_experience_years', { n: p.experienceYears }),
    });
  }
  if (p.completedJobs && p.completedJobs >= 10) {
    bullets.push({
      icon: 'checkmark-circle',
      text: i18n.t('provider_card.trust_jobs_done', { n: p.completedJobs }),
    });
  }
  if (p.responseMinutes && p.responseMinutes <= 15 && bullets.length < 3) {
    bullets.push({
      icon: 'flash',
      text: i18n.t('provider_card.trust_fast_response', { n: p.responseMinutes }),
    });
  }
  if (p.isVerified && bullets.length < 3) {
    bullets.push({
      icon: 'shield-checkmark',
      text: i18n.t('provider_card.trust_verified'),
    });
  }
  if ((p.rating || 0) >= 4.8 && bullets.length < 3) {
    bullets.push({
      icon: 'trophy',
      text: i18n.t('provider_card.trust_top_rated'),
    });
  }
  return bullets.slice(0, 3);
}

function formatDistance(km: number, t: (_k: string, _opts?: any) => string): string {
  if (km < 1) {
    return i18n.t('provider_card.meta_distance_m', { n: Math.round(km * 1000) });
  }
  return i18n.t('provider_card.meta_distance_km', { n: km.toFixed(1) });
}

export function ProviderCard({ provider, onSelect, loading, disabled, testID }: ProviderCardProps) {
  const { colors, isDark } = useThemeContext();
  const { t } = useTranslation();
  const bullets = pickTrustBullets(provider, t);
  const hasMeta =
    provider.distanceKm != null ||
    provider.etaMinutes != null ||
    provider.priceFrom != null;
  const ratingText =
    provider.rating && provider.rating > 0
      ? provider.rating.toFixed(1)
      : i18n.t('provider_card.rating_none');
  const currency = provider.priceCurrencySymbol || '€';
  const isDisabled = !!loading || !!disabled;
  const isPrimary = (provider.variant ?? 'primary') === 'primary';
  const isHighlighted = !!provider.decisionBadge;

  // Entrance animation — only for highlighted (primary BEST) cards
  const scaleAnim = React.useRef(new Animated.Value(isHighlighted ? 0.97 : 1)).current;
  const fadeAnim = React.useRef(new Animated.Value(isHighlighted ? 0 : 1)).current;
  React.useEffect(() => {
    if (!isHighlighted) return;
    Animated.parallel([
      Animated.timing(scaleAnim, { toValue: 1, duration: 380, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 320, useNativeDriver: true }),
    ]).start();
  }, [isHighlighted, scaleAnim, fadeAnim]);

  // Live countdown — UX audit Stage 4
  const expiryMs = React.useMemo(() => {
    if (!provider.expiresAt) return null;
    const v = provider.expiresAt;
    const ms = typeof v === 'number' ? v : new Date(v).getTime();
    return isNaN(ms) ? null : ms;
  }, [provider.expiresAt]);
  const [secondsLeft, setSecondsLeft] = React.useState<number | null>(
    expiryMs ? Math.max(0, Math.floor((expiryMs - Date.now()) / 1000)) : null
  );
  React.useEffect(() => {
    if (!expiryMs) return;
    const tick = () => setSecondsLeft(Math.max(0, Math.floor((expiryMs - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiryMs]);
  const timerLabel =
    secondsLeft == null
      ? null
      : `${Math.floor(secondsLeft / 60)}:${(secondsLeft % 60).toString().padStart(2, '0')}`;
  const expired = secondsLeft != null && secondsLeft <= 0;

  return (
    <Animated.View
      testID={testID || `provider-card-${provider.id}`}
      style={[
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: provider.decisionBadge ? colors.brand : (isDark ? colors.border : colors.borderLight),
          shadowColor: colors.shadowColor,
          borderWidth: provider.decisionBadge ? 2 : StyleSheet.hairlineWidth,
          opacity: fadeAnim,
          transform: [{ scale: scaleAnim }],
        },
      ]}
    >
      {/* DECISION BADGE — single ribbon, top of card */}
      {provider.decisionBadge ? (
        <View
          style={[styles.decisionRibbon, { backgroundColor: colors.brand }]}
          testID={`provider-decision-${provider.id}`}
        >
          <Ionicons
            name={provider.decisionBadge === 'fastest' ? 'flash' : provider.decisionBadge === 'top' ? 'trophy' : 'sparkles'}
            size={12}
            color={colors.brandText}
          />
          <Text style={[styles.decisionRibbonText, { color: colors.brandText }]}>
            {t(`provider_card.decision_${provider.decisionBadge}`)}
          </Text>
        </View>
      ) : null}

      {/* SYSTEM-PICKED hint — psychological "decision lifted" line */}
      {provider.systemPicked ? (
        <View style={styles.systemPickedRow} testID={`provider-system-picked-${provider.id}`}>
          <Ionicons name="bulb" size={12} color={colors.textMuted} />
          <Text style={[styles.systemPickedText, { color: colors.textMuted }]} numberOfLines={2}>
            {t('provider_card.system_picked')}
          </Text>
        </View>
      ) : null}

      {/* HEADER: avatar + name + star rating */}
      <View style={styles.header}>
        <View
          style={[
            styles.avatar,
            { backgroundColor: provider.isVerified ? colors.successBg : colors.brandSoft },
          ]}
        >
          <Text style={[styles.avatarInitial, { color: colors.text }]}>
            {provider.name ? provider.name.charAt(0).toUpperCase() : '?'}
          </Text>
        </View>
        <View style={styles.headerText}>
          <Text
            style={[styles.name, { color: colors.text }]}
            numberOfLines={1}
            testID={`provider-name-${provider.id}`}
          >
            {provider.name}
          </Text>
          <View style={styles.ratingRow}>
            <Ionicons name="star" size={13} color={colors.brand} />
            <Text style={[styles.ratingText, { color: colors.text }]}>{ratingText}</Text>
            {provider.reviewsCount ? (
              <Text style={[styles.ratingCount, { color: colors.textMuted }]}>
                ({provider.reviewsCount})
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      {/* BADGE: TÜV (single gold pill, high trust signal) */}
      {provider.tuvCertified ? (
        <View style={[styles.badgeRow, { backgroundColor: colors.brandSoft }]}>
          <Ionicons name="ribbon" size={13} color={colors.brand} />
          <Text style={[styles.badgeText, { color: colors.brand }]}>
            {t('provider_card.badge_tuv')}
          </Text>
        </View>
      ) : null}

      {/* Urgency strip — countdown + high-demand + viewers */}
      {(timerLabel || provider.highDemand || (provider.viewersCount && provider.viewersCount > 0)) ? (
        <View style={styles.urgencyStrip} testID={`provider-urgency-${provider.id}`}>
          {timerLabel ? (
            <View
              style={[
                styles.urgencyChip,
                { backgroundColor: expired ? colors.errorBg || 'rgba(239,68,68,0.15)' : colors.brandSoft, borderColor: expired ? colors.error || '#ef4444' : colors.brand },
              ]}
            >
              <Ionicons name="time" size={12} color={expired ? (colors.error || '#ef4444') : colors.brand} />
              <Text style={[styles.urgencyText, { color: expired ? (colors.error || '#ef4444') : colors.brand }]}>
                {expired ? '0:00' : timerLabel}
              </Text>
            </View>
          ) : null}
          {provider.highDemand ? (
            <View style={[styles.urgencyChip, { backgroundColor: colors.successBg || 'rgba(16,185,129,0.15)', borderColor: colors.success || '#10b981' }]}>
              <Ionicons name="flame" size={12} color={colors.success || '#10b981'} />
              <Text style={[styles.urgencyText, { color: colors.success || '#10b981' }]}>high demand</Text>
            </View>
          ) : null}
          {provider.viewersCount && provider.viewersCount > 0 ? (
            <View style={[styles.urgencyChip, { backgroundColor: 'transparent', borderColor: colors.border }]}>
              <Ionicons name="eye" size={12} color={colors.textMuted} />
              <Text style={[styles.urgencyText, { color: colors.textMuted }]}>
                {provider.viewersCount} viewing
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* TRUST bullets — max 3 */}
      {bullets.length > 0 ? (
        <View style={styles.trustBlock}>
          {bullets.map((b, idx) => (
            <View key={idx} style={styles.trustLine}>
              <Ionicons name={b.icon} size={14} color={colors.success} />
              <Text style={[styles.trustText, { color: colors.textSecondary }]} numberOfLines={1}>
                {b.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* META: distance · ETA · price */}
      {hasMeta ? (
        <View style={styles.metaRow}>
          {provider.distanceKm != null ? (
            <View style={styles.metaItem}>
              <Ionicons name="location" size={13} color={colors.textMuted} />
              <Text style={[styles.metaText, { color: colors.textMuted }]}>
                {formatDistance(provider.distanceKm, t)}
              </Text>
            </View>
          ) : null}
          {provider.distanceKm != null && provider.etaMinutes != null ? (
            <Text style={[styles.metaText, { color: colors.textMuted }]}>
              {t('provider_card.meta_separator')}
            </Text>
          ) : null}
          {provider.etaMinutes != null ? (
            <View style={styles.metaItem}>
              <Ionicons name="time" size={13} color={colors.textMuted} />
              <Text style={[styles.metaText, { color: colors.textMuted }]}>
                {t('provider_card.meta_eta', { n: provider.etaMinutes })}
              </Text>
            </View>
          ) : null}
          {provider.priceFrom != null && provider.priceFrom > 0 ? (
            <View style={[styles.metaItem, styles.metaPriceItem]}>
              <Text
                style={[styles.metaPriceText, { color: colors.text }]}
                testID={`provider-price-${provider.id}`}
              >
                {t('provider_card.meta_price', { n: provider.priceFrom, sym: currency })}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* SURGE chip — pre-formatted from backend, optional */}
      {provider.surgeBadge ? (
        <View style={[styles.surgeChip, { backgroundColor: colors.brandSoft }]}>
          <Ionicons name="trending-up" size={13} color={colors.brand} />
          <Text
            style={[styles.surgeText, { color: colors.brand }]}
            numberOfLines={1}
            testID={`provider-surge-${provider.id}`}
          >
            {provider.surgeBadge}
          </Text>
        </View>
      ) : null}

      {/* CTA: variant-aware (primary = bold yellow, secondary = muted outline) */}
      <TouchableOpacity
        testID={`provider-cta-${provider.id}`}
        style={[
          styles.cta,
          isPrimary
            ? { backgroundColor: colors.brand }
            : { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: colors.border },
          isDisabled && styles.ctaDisabled,
        ]}
        onPress={() => onSelect(provider.id)}
        disabled={isDisabled}
        activeOpacity={0.88}
      >
        {loading ? (
          <ActivityIndicator size="small" color={isPrimary ? colors.brandText : colors.text} />
        ) : (
          <Text
            style={[
              styles.ctaText,
              { color: isPrimary ? colors.brandText : colors.textSecondary },
            ]}
          >
            {isPrimary ? t('provider_card.cta_select_primary') : t('provider_card.cta_select_secondary')}
          </Text>
        )}
      </TouchableOpacity>

      {/* CONFIDENCE BLOCK (post-CTA) — only for primary card, kills "что дальше / а вдруг риск" anxiety */}
      {isPrimary && isHighlighted ? (
        <View style={styles.confidenceBlock} testID={`provider-confidence-${provider.id}`}>
          <View style={styles.confidenceLine}>
            <Ionicons name="rocket" size={12} color={colors.success || colors.brand} />
            <Text style={[styles.confidenceText, { color: colors.textSecondary }]}>
              {t('provider_card.post_cta_assigned')}
            </Text>
          </View>
          <View style={styles.confidenceLine}>
            <Ionicons name="shield-checkmark" size={12} color={colors.success || colors.brand} />
            <Text style={[styles.confidenceText, { color: colors.textSecondary }]}>
              {t('provider_card.post_cta_risk_free')}
            </Text>
          </View>
        </View>
      ) : null}
    </Animated.View>
  );
}

export default ProviderCard;

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    // borderWidth set inline (decisionBadge → 2, else hairline)
    // elevation for Android / box-shadow for iOS & web
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 3,
  },
  decisionRibbon: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    marginBottom: 10,
  },
  decisionRibbonText: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
  systemPickedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
  },
  systemPickedText: {
    fontSize: 11,
    fontWeight: '600',
    flex: 1,
    lineHeight: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 18,
    fontWeight: '800',
  },
  headerText: {
    flex: 1,
  },
  name: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 2,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ratingText: {
    fontSize: 13,
    fontWeight: '600',
  },
  ratingCount: {
    fontSize: 12,
  },
  badgeRow: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    marginTop: 10,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  trustBlock: {
    marginTop: 10,
    gap: 4,
  },
  trustLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  trustText: {
    fontSize: 13,
    flex: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 4,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    fontSize: 12,
    fontWeight: '500',
  },
  metaPriceItem: {
    marginLeft: 'auto',
  },
  metaPriceText: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  surgeChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    marginTop: 10,
  },
  surgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  urgencyStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  urgencyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  urgencyText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  cta: {
    marginTop: 14,
    height: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaDisabled: {
    opacity: 0.7,
  },
  ctaText: {
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  confidenceBlock: {
    marginTop: 10,
    gap: 4,
  },
  confidenceLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  confidenceText: {
    fontSize: 11,
    fontWeight: '600',
    flex: 1,
    lineHeight: 14,
  },
});

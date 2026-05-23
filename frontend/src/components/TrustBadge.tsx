/**
 * Sprint 6 Side-Rollout — Inline Trust Badge.
 *
 * Drop-in component to surface provider reputation everywhere a provider appears:
 *   - Marketplace bid cards
 *   - Provider listing rows
 *   - Accept-bid modal
 *   - Quote previews
 *   - Service request detail
 *
 * Behavior:
 *   - Loads trust card on mount via trustAPI.card(providerId)
 *   - Renders compact pill: ⭐ 4.8 (217) · PRO · ⚡ Fast reply
 *   - Tappable → navigates to /trust/provider/[id] for full profile
 *   - Cold-start (totalReviews=0) shows "New provider" pill
 *
 * Use with `compact` for inline placement; `prominent` for hero placement.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { trustAPI } from '../services/api';

type Props = {
  providerId: string;
  variant?: 'compact' | 'prominent';
  style?: ViewStyle;
  /** Navigate on tap. Default true. */
  navigable?: boolean;
};

const BADGE_META: Record<string, { emoji: string; label: string; color: string }> = {
  top_rated: { emoji: '🏆', label: 'Top', color: '#FFD23F' },
  fast_response: { emoji: '⚡', label: 'Fast', color: '#60A5FA' },
  reliable: { emoji: '🛡', label: 'Reliable', color: '#34D399' },
  rising_star: { emoji: '🌟', label: 'Rising', color: '#C778FF' },
  high_volume: { emoji: '📈', label: 'High vol', color: '#F87171' },
};

const TIER_META: Record<string, { label: string; color: string }> = {
  pro: { label: 'PRO', color: '#FFD23F' },
  premium: { label: 'PREMIUM', color: '#C778FF' },
  business: { label: 'BIZ', color: '#34D399' },
};

export default function TrustBadge({ providerId, variant = 'compact', style, navigable = true }: Props) {
  const router = useRouter();
  const [card, setCard] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await trustAPI.card(providerId);
        if (alive) setCard(data);
      } catch (e) {
        if (alive) setCard(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [providerId]);

  if (loading) {
    return (
      <View style={[styles.pill, styles.loadingPill, style]}>
        <ActivityIndicator size="small" color="#9CA3AF" />
      </View>
    );
  }
  if (!card) return null;

  const isNew = (card.totalReviews || 0) === 0;
  const tier = TIER_META[card.subscriptionTier];
  const topBadge = (card.badges || [])[0];
  const badgeMeta = topBadge ? BADGE_META[topBadge] : null;

  const content = (
    <View style={[styles.pill, variant === 'prominent' && styles.prominentPill, style]} testID={`trust-badge-${providerId}`}>
      {isNew ? (
        <View style={styles.section}>
          <Ionicons name="sparkles" size={12} color="#9CA3AF" />
          <Text style={styles.newText}>New</Text>
        </View>
      ) : (
        <>
          <View style={styles.section}>
            <Ionicons name="star" size={12} color="#FFD23F" />
            <Text style={styles.ratingText}>{card.avgRating?.toFixed(1)}</Text>
            <Text style={styles.subtleText}>({card.totalReviews})</Text>
          </View>
          {card.completedJobs > 0 && (
            <>
              <View style={styles.divider} />
              <View style={styles.section}>
                <Text style={styles.jobsText}>{card.completedJobs}</Text>
                <Text style={styles.subtleText}>jobs</Text>
              </View>
            </>
          )}
          {tier && (
            <>
              <View style={styles.divider} />
              <Text style={[styles.tierText, { color: tier.color }]}>{tier.label}</Text>
            </>
          )}
          {badgeMeta && variant === 'prominent' && (
            <>
              <View style={styles.divider} />
              <View style={styles.section}>
                <Text style={styles.badgeEmoji}>{badgeMeta.emoji}</Text>
                <Text style={[styles.badgeText, { color: badgeMeta.color }]}>{badgeMeta.label}</Text>
              </View>
            </>
          )}
        </>
      )}
    </View>
  );

  if (!navigable) return content;

  return (
    <TouchableOpacity
      onPress={() => router.push(`/trust/provider/${providerId}` as any)}
      activeOpacity={0.7}
      testID={`trust-badge-tap-${providerId}`}
    >
      {content}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1f2937',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#374151',
    alignSelf: 'flex-start',
  },
  prominentPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
  },
  loadingPill: { width: 80, height: 24, justifyContent: 'center', alignItems: 'center' },
  section: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  divider: { width: 1, height: 12, backgroundColor: '#374151', marginHorizontal: 6 },
  ratingText: { color: '#fff', fontSize: 12, fontWeight: '700', marginLeft: 2 },
  jobsText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  subtleText: { color: '#9CA3AF', fontSize: 11 },
  tierText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  badgeEmoji: { fontSize: 11 },
  badgeText: { fontSize: 10, fontWeight: '600' },
  newText: { color: '#9CA3AF', fontSize: 11, fontStyle: 'italic', marginLeft: 2 },
});

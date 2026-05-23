/**
 * Sprint 5 — Trust Card component.
 *
 * Compact (mobile-marketplace card) and detailed (provider profile) variants.
 * Pure presentational — receives trust data via props.
 *
 *   ⭐ 4.8  ·  217 jobs  ·  PRO  ·  ~6 min  ·  97% completion
 *
 * Hides metrics that are unavailable (cold-start providers show only what they have).
 */
import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export type TrustData = {
  avgRating: number | null;
  totalReviews: number;
  completedJobs: number;
  completionRate: number | null;
  avgResponseMinutes: number | null;
  subscriptionTier: string;
  badges: string[];
  tagCounts?: Record<string, number>;
};

type Props = {
  data: TrustData;
  variant?: 'compact' | 'detailed';
  style?: ViewStyle;
};

const TIER_LABEL: Record<string, { label: string; color: string }> = {
  pro: { label: 'PRO', color: '#FFD23F' },
  premium: { label: 'PREMIUM', color: '#C778FF' },
  business: { label: 'BIZ', color: '#34D399' },
  free: { label: '', color: 'transparent' },
};

const BADGE_LABEL: Record<string, { label: string; emoji: string }> = {
  top_rated: { label: 'Top rated', emoji: '🏆' },
  fast_response: { label: 'Fast reply', emoji: '⚡' },
  reliable: { label: 'Reliable', emoji: '🛡' },
  rising_star: { label: 'Rising star', emoji: '🌟' },
  high_volume: { label: 'High volume', emoji: '📈' },
};

function formatStar(rating: number | null): string {
  if (rating == null) return '—';
  return rating.toFixed(1);
}

export default function TrustCard({ data, variant = 'compact', style }: Props) {
  const tier = TIER_LABEL[data.subscriptionTier] || TIER_LABEL.free;
  const showRating = data.totalReviews > 0;
  const showCompletion = data.completionRate != null && data.completedJobs >= 5;
  const showResponse = data.avgResponseMinutes != null;

  return (
    <View
      style={[styles.container, variant === 'detailed' ? styles.detailed : styles.compact, style]}
      testID="trust-card"
    >
      <View style={styles.row}>
        {showRating ? (
          <View style={styles.metric} testID="trust-rating">
            <Ionicons name="star" size={14} color="#FFD23F" />
            <Text style={styles.metricValue}>{formatStar(data.avgRating)}</Text>
            <Text style={styles.metricLabel}>({data.totalReviews})</Text>
          </View>
        ) : (
          <View style={styles.metric}>
            <Ionicons name="star-outline" size={14} color="#9CA3AF" />
            <Text style={styles.metricMuted}>New</Text>
          </View>
        )}

        {data.completedJobs > 0 && (
          <View style={styles.metric} testID="trust-jobs">
            <Ionicons name="checkmark-done" size={14} color="#34D399" />
            <Text style={styles.metricValue}>{data.completedJobs}</Text>
            <Text style={styles.metricLabel}>jobs</Text>
          </View>
        )}

        {tier.label.length > 0 && (
          <View style={[styles.tierBadge, { backgroundColor: tier.color + '22', borderColor: tier.color }]} testID="trust-tier">
            <Text style={[styles.tierText, { color: tier.color }]}>{tier.label}</Text>
          </View>
        )}
      </View>

      {variant === 'detailed' && (
        <View style={[styles.row, { marginTop: 6 }]}>
          {showResponse && (
            <View style={styles.metric} testID="trust-response">
              <Ionicons name="time-outline" size={14} color="#60A5FA" />
              <Text style={styles.metricValue}>~{data.avgResponseMinutes} min</Text>
              <Text style={styles.metricLabel}>reply</Text>
            </View>
          )}
          {showCompletion && (
            <View style={styles.metric} testID="trust-completion">
              <Ionicons name="trending-up" size={14} color="#34D399" />
              <Text style={styles.metricValue}>{Math.round((data.completionRate || 0) * 100)}%</Text>
              <Text style={styles.metricLabel}>completion</Text>
            </View>
          )}
        </View>
      )}

      {variant === 'detailed' && data.badges.length > 0 && (
        <View style={[styles.row, { marginTop: 8, flexWrap: 'wrap' }]} testID="trust-badges">
          {data.badges.map((b) => {
            const meta = BADGE_LABEL[b] || { label: b, emoji: '✓' };
            return (
              <View key={b} style={styles.badge}>
                <Text style={styles.badgeText}>
                  {meta.emoji} {meta.label}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 6,
  },
  compact: {},
  detailed: {
    padding: 12,
    backgroundColor: '#1f2937',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#374151',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  metric: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metricValue: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  metricLabel: {
    color: '#9CA3AF',
    fontSize: 12,
  },
  metricMuted: {
    color: '#9CA3AF',
    fontSize: 13,
    fontStyle: 'italic',
  },
  tierBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  tierText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#374151',
    borderRadius: 6,
    marginRight: 6,
    marginBottom: 6,
  },
  badgeText: {
    color: '#E5E7EB',
    fontSize: 11,
    fontWeight: '500',
  },
});

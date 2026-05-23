/**
 * Sprint 5 — Public Provider Trust Profile.
 *
 * URL: /trust/provider/[id]
 *
 * Shows:
 *   - Full TrustCard (detailed variant)
 *   - Tag histogram (positive/negative columns)
 *   - List of revealed reviews (customer → provider)
 *   - Pagination
 *
 * Designed to be linked from:
 *   - Marketplace ProviderCard (tap → see full trust)
 *   - Pre-accept-bid Trust UI (boost conversion)
 *   - Provider's own dashboard (self-view)
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import TrustCard, { TrustData } from '../../../src/components/TrustCard';
import { trustAPI } from '../../../src/services/api';

const TAG_LABELS: Record<string, string> = {
  fast: '⚡ Быстро',
  professional: '🎓 Профи',
  quality_work: '✨ Качество',
  communicative: '💬 На связи',
  punctual: '⏰ Пунктуально',
  clean: '🧼 Чисто',
  late: '⏰ Опоздал',
  expensive: '💸 Дорого',
  rude: '😤 Грубо',
  incomplete: '⚠️ Не доделал',
};
const NEGATIVE_KEYS = new Set(['late', 'expensive', 'rude', 'incomplete']);

export default function ProviderTrustProfile() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [card, setCard] = useState<TrustData | null>(null);
  const [reviews, setReviews] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offset, setOffset] = useState(0);
  const PAGE = 10;

  const load = useCallback(
    async (isRefresh = false) => {
      if (!id) return;
      if (isRefresh) setRefreshing(true);
      try {
        const [cardRes, listRes] = await Promise.all([
          trustAPI.card(String(id)),
          trustAPI.list(String(id), PAGE, 0),
        ]);
        setCard(cardRes.data);
        setReviews(listRes.data.items || []);
        setTotal(listRes.data.total || 0);
        setOffset(PAGE);
      } catch (e) {
        // empty state for unknown provider — already handled by API neutral card
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [id]
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!id || reviews.length >= total) return;
    try {
      const { data } = await trustAPI.list(String(id), PAGE, offset);
      setReviews((prev) => [...prev, ...(data.items || [])]);
      setOffset(offset + PAGE);
    } catch (e) {
      // ignore
    }
  }

  if (loading || !card) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color="#FFD23F" size="large" style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  const tagEntries = Object.entries(card.tagCounts || {}).sort((a, b) => b[1] - a[1]);
  const positiveTags = tagEntries.filter(([k]) => !NEGATIVE_KEYS.has(k));
  const negativeTags = tagEntries.filter(([k]) => NEGATIVE_KEYS.has(k));

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8} testID="trust-back-btn">
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Trust Profile</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#FFD23F" />
        }
      >
        <TrustCard data={card} variant="detailed" style={{ marginBottom: 16 }} />

        {tagEntries.length > 0 && (
          <View style={styles.tagsBlock} testID="trust-tag-histogram">
            <Text style={styles.sectionTitle}>Что говорят клиенты</Text>
            {positiveTags.length > 0 && (
              <View style={styles.tagsCol}>
                {positiveTags.slice(0, 6).map(([k, n]) => (
                  <TagBar key={k} label={TAG_LABELS[k] || k} count={n} max={positiveTags[0][1]} positive />
                ))}
              </View>
            )}
            {negativeTags.length > 0 && (
              <View style={[styles.tagsCol, { marginTop: 16 }]}>
                <Text style={styles.subtle}>Иногда отмечают:</Text>
                {negativeTags.map(([k, n]) => (
                  <TagBar key={k} label={TAG_LABELS[k] || k} count={n} max={negativeTags[0][1]} />
                ))}
              </View>
            )}
          </View>
        )}

        <Text style={styles.sectionTitle}>Отзывы клиентов ({total})</Text>

        {reviews.length === 0 ? (
          <View style={styles.empty} testID="trust-no-reviews">
            <Ionicons name="chatbubbles-outline" size={40} color="#6B7280" />
            <Text style={styles.emptyText}>Ещё нет отзывов</Text>
            <Text style={styles.emptyMuted}>
              Отзывы появятся после первой завершённой сделки с открытием эскроу.
            </Text>
          </View>
        ) : (
          <>
            {reviews.map((r) => (
              <ReviewItem key={r.id} review={r} />
            ))}
            {reviews.length < total && (
              <TouchableOpacity onPress={loadMore} style={styles.loadMore} testID="trust-load-more">
                <Text style={styles.loadMoreText}>Показать ещё ({total - reviews.length})</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function TagBar({
  label,
  count,
  max,
  positive,
}: {
  label: string;
  count: number;
  max: number;
  positive?: boolean;
}) {
  const width = max > 0 ? Math.max(8, (count / max) * 100) : 8;
  return (
    <View style={styles.tagBarRow}>
      <Text style={styles.tagBarLabel}>{label}</Text>
      <View style={styles.tagBarTrack}>
        <View
          style={[
            styles.tagBarFill,
            { width: `${width}%`, backgroundColor: positive ? '#34D399' : '#F87171' },
          ]}
        />
      </View>
      <Text style={styles.tagBarCount}>{count}</Text>
    </View>
  );
}

function ReviewItem({ review }: { review: any }) {
  return (
    <View style={styles.review} testID={`review-${review.id}`}>
      <View style={styles.reviewHead}>
        <View style={styles.starsSmall}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Ionicons
              key={n}
              name={n <= review.rating ? 'star' : 'star-outline'}
              size={14}
              color="#FFD23F"
            />
          ))}
        </View>
        <Text style={styles.reviewDate}>
          {new Date(review.revealedAt || review.createdAt).toLocaleDateString('ru-RU')}
        </Text>
      </View>
      {Array.isArray(review.tags) && review.tags.length > 0 && (
        <View style={styles.reviewTags}>
          {review.tags.map((t: string) => (
            <View key={t} style={styles.reviewTag}>
              <Text style={styles.reviewTagText}>{TAG_LABELS[t] || t}</Text>
            </View>
          ))}
        </View>
      )}
      {!!review.comment && <Text style={styles.reviewComment}>{review.comment}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: '#1f2937',
    borderBottomWidth: 1,
  },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  scroll: { padding: 16, paddingBottom: 40 },
  sectionTitle: { color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 8, marginBottom: 12 },
  subtle: { color: '#9CA3AF', fontSize: 12, marginBottom: 6 },
  tagsBlock: { marginBottom: 16 },
  tagsCol: {},
  tagBarRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  tagBarLabel: { color: '#E5E7EB', fontSize: 13, width: 130 },
  tagBarTrack: { flex: 1, height: 8, backgroundColor: '#1f2937', borderRadius: 4, overflow: 'hidden' },
  tagBarFill: { height: '100%', borderRadius: 4 },
  tagBarCount: { color: '#9CA3AF', fontSize: 12, width: 30, textAlign: 'right' },
  review: {
    backgroundColor: '#1f2937',
    padding: 12,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#374151',
  },
  reviewHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  starsSmall: { flexDirection: 'row', gap: 2 },
  reviewDate: { color: '#9CA3AF', fontSize: 12 },
  reviewTags: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  reviewTag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#111827',
    borderRadius: 12,
    marginRight: 6,
    marginBottom: 4,
  },
  reviewTagText: { color: '#E5E7EB', fontSize: 11 },
  reviewComment: { color: '#E5E7EB', fontSize: 14, marginTop: 8, lineHeight: 20 },
  empty: { alignItems: 'center', paddingVertical: 32 },
  emptyText: { color: '#fff', fontSize: 15, fontWeight: '600', marginTop: 12 },
  emptyMuted: { color: '#9CA3AF', fontSize: 13, marginTop: 6, textAlign: 'center', paddingHorizontal: 24 },
  loadMore: { padding: 14, alignItems: 'center' },
  loadMoreText: { color: '#FFD23F', fontWeight: '600' },
});

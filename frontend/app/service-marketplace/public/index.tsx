/**
 * Service Marketplace — ПУБЛИЧНАЯ биржа (i18n: DE / EN / RU).
 *
 * Все тексты — через `t('service_marketplace.*')`. Названия категорий
 * приходят с backend (`categoryMeta.titleDe/En/Ru`) и подбираются
 * `pickCategoryListTitle()` по текущему языку i18n.
 *
 * Backend:
 *   GET /api/marketplace/feed
 *   GET /api/marketplace/feed/stats
 *   GET /api/marketplace/categories
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl,
  ActivityIndicator, TextInput, ScrollView,
} from 'react-native';
import i18n from '../../../src/i18n';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useThemeContext } from '../../../src/context/ThemeContext';
import { useCity } from '../../../src/context/CityContext';
import { useAuth } from '../../../src/context/AuthContext';
import { api } from '../../../src/services/api';
import { pickCategoryListTitle } from '../../../src/lib/marketplace/category';

type Category = {
  key: string;
  titleRu: string;
  titleEn: string;
  titleDe?: string;
  emoji: string;
  minBudget: number;
  currency: string;
};

type FeedItem = {
  id: string;
  category: string;
  title: string;
  description?: string;
  city: string;
  urgency: 'normal' | 'urgent' | 'emergency';
  status: 'open' | 'bidding';
  bidsCount: number;
  createdAt: string;
  expiresAt?: string;
  budget?: { min?: number; max?: number; currency: string };
  categoryMeta?: { titleRu?: string; titleEn?: string; titleDe?: string; emoji?: string };
};

type Stats = {
  openRequests: number;
  totalBids: number;
  cities: number;
  byCategory: Record<string, number>;
};

type Sort = 'smart' | 'newest' | 'budget';

const URGENCY_COLOR: Record<string, string> = {
  normal: '#888',
  urgent: '#f59e0b',
  emergency: '#ef4444',
};

const SORT_OPTIONS: { key: Sort; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'smart',  icon: 'sparkles-outline' },
  { key: 'newest', icon: 'time-outline' },
  { key: 'budget', icon: 'cash-outline' },
];

function formatBudget(b: FeedItem['budget'] | undefined, t: (k: string, p?: any) => string): string | null {
  if (!b) return null;
  const cur = b.currency === 'EUR' ? '€' : (b.currency || '€');
  if (b.min != null && b.max != null && b.min !== b.max) {
    return i18n.t('service_marketplace.budget_range', { from: `${cur}${b.min}`, to: `${cur}${b.max}` });
  }
  if (b.max != null) return i18n.t('service_marketplace.budget_up_to', { amount: `${cur}${b.max}` });
  if (b.min != null) return i18n.t('service_marketplace.budget_from', { amount: `${cur}${b.min}` });
  return null;
}

function useTimeAgo() {
  const { t } = useTranslation();
  return useCallback((iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return t('service_marketplace.time_now');
    if (m < 60) return t('service_marketplace.time_min_ago', { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('service_marketplace.time_hr_ago', { n: h });
    const d = Math.floor(h / 24);
    return t('service_marketplace.time_day_ago', { n: d });
  }, [t]);
}

export default function PublicMarketplaceFeed() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const { selectedCity } = useCity();
  const { mode } = useAuth();
  const timeAgo = useTimeAgo();

  const [items, setItems] = useState<FeedItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [q, setQ] = useState('');
  const [qDebounced, setQDebounced] = useState('');
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [selectedUrgency, setSelectedUrgency] = useState<'normal' | 'urgent' | 'emergency' | null>(null);
  const [cityFilterOn, setCityFilterOn] = useState(false);
  const [sort, setSort] = useState<Sort>('smart');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    const tid = setTimeout(() => setQDebounced(q.trim()), 350);
    return () => clearTimeout(tid);
  }, [q]);

  useEffect(() => {
    api.get('/marketplace/categories')
      .then((r) => setCategories(r.data?.categories || []))
      .catch(() => {});
  }, []);

  const buildParams = useCallback((nextPage: number) => {
    const p: Record<string, any> = { sort, page: nextPage, limit: 20 };
    if (cityFilterOn && selectedCity?.code) p.city = selectedCity.code;
    if (selectedCat) p.category = selectedCat;
    if (selectedUrgency) p.urgency = selectedUrgency;
    if (qDebounced) p.q = qDebounced;
    return p;
  }, [sort, cityFilterOn, selectedCity?.code, selectedCat, selectedUrgency, qDebounced]);

  const load = useCallback(async (reset = true) => {
    try {
      const nextPage = reset ? 1 : page + 1;
      if (reset) setLoading(true); else setLoadingMore(true);
      const r = await api.get('/marketplace/feed', { params: buildParams(nextPage) });
      const list: FeedItem[] = r.data?.items || [];
      setItems(reset ? list : [...items, ...list]);
      setHasMore(!!r.data?.hasMore);
      setPage(nextPage);
    } catch {
      if (reset) setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [buildParams, items, page]);

  const loadStats = useCallback(async () => {
    try {
      const r = await api.get('/marketplace/feed/stats');
      setStats(r.data || null);
    } catch { /* tolerate */ }
  }, []);

  useFocusEffect(useCallback(() => { loadStats(); }, [loadStats]));

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, cityFilterOn, selectedCity?.code, selectedCat, selectedUrgency, qDebounced]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    Promise.all([load(true), loadStats()]);
  }, [load, loadStats]);

  const onEndReached = useCallback(() => {
    if (hasMore && !loadingMore && !loading) load(false);
  }, [hasMore, loadingMore, loading, load]);

  const activeCount = useMemo(
    () => (cityFilterOn ? 1 : 0) + (selectedCat ? 1 : 0) + (selectedUrgency ? 1 : 0),
    [cityFilterOn, selectedCat, selectedUrgency],
  );

  const resetFilters = () => {
    setSelectedCat(null);
    setSelectedUrgency(null);
    setCityFilterOn(false);
    setQ('');
  };

  const renderItem = ({ item }: { item: FeedItem }) => {
    const ucol = URGENCY_COLOR[item.urgency] || '#888';
    const budget = formatBudget(item.budget, t);
    const catTitle = pickCategoryListTitle(item.categoryMeta || {}, item.category);
    return (
      <TouchableOpacity
        testID={`public-req-${item.id}`}
        onPress={() => router.push(`/service-marketplace/public/${item.id}` as any)}
        activeOpacity={0.85}
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.cardHeader}>
          <Text style={styles.emoji}>{item.categoryMeta?.emoji || '📋'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
              {item.title || catTitle}
            </Text>
            <View style={styles.metaRow}>
              <Ionicons name="location-outline" size={11} color={colors.textSecondary} />
              <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>
                {item.city} · {timeAgo(item.createdAt)}
              </Text>
            </View>
          </View>
          {item.urgency !== 'normal' && (
            <View style={[styles.urgencyBadge, { backgroundColor: ucol + '22', borderColor: ucol }]}>
              <Text style={[styles.urgencyText, { color: ucol }]}>
                {t(`service_marketplace.urgency_${item.urgency}`)}
              </Text>
            </View>
          )}
        </View>

        {!!item.description && (
          <Text style={[styles.desc, { color: colors.textSecondary }]} numberOfLines={2}>
            {item.description}
          </Text>
        )}

        <View style={[styles.cardFooter, { borderTopColor: colors.border }]}>
          {budget && (
            <View style={styles.footerChip}>
              <Ionicons name="cash-outline" size={13} color={colors.primary} />
              <Text style={[styles.footerChipText, { color: colors.text }]}>{budget}</Text>
            </View>
          )}
          <View style={styles.footerChip}>
            <Ionicons name="chatbubble-ellipses-outline" size={13} color={colors.textSecondary} />
            <Text style={[styles.footerChipText, { color: colors.textSecondary }]}>
              {t(item.bidsCount === 1 ? 'service_marketplace.responses_count_one' : 'service_marketplace.responses_count_other', { count: item.bidsCount })}
            </Text>
          </View>
          <View style={{ flex: 1 }} />
          <View style={[styles.statusPill, {
            backgroundColor: (item.status === 'bidding' ? '#f59e0b' : '#3b82f6') + '22',
          }]}>
            <Text style={[styles.statusPillText, {
              color: item.status === 'bidding' ? '#f59e0b' : '#3b82f6',
            }]}>
              {t(`service_marketplace.status_${item.status}`)}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="public-back"
          onPress={() => router.back()}
          style={[styles.iconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            {t('service_marketplace.feed_title')}
          </Text>
          <Text style={[styles.headerSub, { color: colors.textSecondary }]}>
            {t('service_marketplace.feed_sub')}
          </Text>
        </View>
        {mode === 'customer' && (
          <TouchableOpacity
            testID="public-create"
            onPress={() => router.push('/service-marketplace/create' as any)}
            style={[styles.iconBtn, { backgroundColor: colors.primary }]}
            activeOpacity={0.7}
          >
            <Ionicons name="add" size={22} color="#000" />
          </TouchableOpacity>
        )}
      </View>

      {stats && (
        <View style={styles.heroRow}>
          <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.heroNum, { color: colors.primary }]}>{stats.openRequests}</Text>
            <Text style={[styles.heroLabel, { color: colors.textSecondary }]}>
              {t('service_marketplace.feed_stats_requests')}
            </Text>
          </View>
          <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.heroNum, { color: colors.text }]}>{stats.totalBids}</Text>
            <Text style={[styles.heroLabel, { color: colors.textSecondary }]}>
              {t('service_marketplace.feed_stats_bids')}
            </Text>
          </View>
          <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.heroNum, { color: colors.text }]}>{stats.cities}</Text>
            <Text style={[styles.heroLabel, { color: colors.textSecondary }]}>
              {t('service_marketplace.feed_stats_cities')}
            </Text>
          </View>
        </View>
      )}

      <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Ionicons name="search" size={18} color={colors.textSecondary} />
        <TextInput
          testID="public-search"
          style={[styles.searchInput, { color: colors.text }]}
          placeholder={t('service_marketplace.feed_search_placeholder')}
          placeholderTextColor={colors.textMuted}
          value={q}
          onChangeText={setQ}
          returnKeyType="search"
        />
        {q.length > 0 && (
          <TouchableOpacity onPress={() => setQ('')} testID="public-search-clear">
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {SORT_OPTIONS.map((s) => {
          const active = sort === s.key;
          return (
            <TouchableOpacity
              key={s.key}
              testID={`public-sort-${s.key}`}
              onPress={() => setSort(s.key)}
              activeOpacity={0.8}
              style={[
                styles.chip,
                { backgroundColor: active ? colors.primary : colors.card, borderColor: active ? colors.primary : colors.border },
              ]}
            >
              <Ionicons name={s.icon} size={13} color={active ? '#000' : colors.text} />
              <Text style={[styles.chipText, { color: active ? '#000' : colors.text }]}>
                {t(`service_marketplace.sort_${s.key}`)}
              </Text>
            </TouchableOpacity>
          );
        })}

        <View style={[styles.chipDivider, { backgroundColor: colors.border }]} />

        {selectedCity?.code && (
          <TouchableOpacity
            testID="public-filter-city"
            onPress={() => setCityFilterOn((v) => !v)}
            activeOpacity={0.8}
            style={[
              styles.chip,
              { backgroundColor: cityFilterOn ? colors.primary : colors.card, borderColor: cityFilterOn ? colors.primary : colors.border },
            ]}
          >
            <Ionicons name="location" size={13} color={cityFilterOn ? '#000' : colors.text} />
            <Text style={[styles.chipText, { color: cityFilterOn ? '#000' : colors.text }]}>
              {selectedCity.name || selectedCity.code}
            </Text>
          </TouchableOpacity>
        )}

        {(['urgent', 'emergency'] as const).map((u) => {
          const active = selectedUrgency === u;
          const c = URGENCY_COLOR[u];
          return (
            <TouchableOpacity
              key={u}
              testID={`public-urgency-${u}`}
              onPress={() => setSelectedUrgency(active ? null : u)}
              activeOpacity={0.8}
              style={[styles.chip, { backgroundColor: active ? c : colors.card, borderColor: active ? c : colors.border }]}
            >
              <Ionicons name="flash" size={13} color={active ? '#fff' : c} />
              <Text style={[styles.chipText, { color: active ? '#fff' : colors.text }]}>
                {t(`service_marketplace.urgency_${u}`)}
              </Text>
            </TouchableOpacity>
          );
        })}

        {activeCount > 0 && (
          <TouchableOpacity
            testID="public-reset-filters"
            onPress={resetFilters}
            activeOpacity={0.8}
            style={[styles.chip, { backgroundColor: 'transparent', borderColor: '#ef4444' }]}
          >
            <Ionicons name="close" size={13} color="#ef4444" />
            <Text style={[styles.chipText, { color: '#ef4444' }]}>
              {t('service_marketplace.reset_filters')}
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {categories.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.catRow}>
          {categories.map((cat) => {
            const active = selectedCat === cat.key;
            const count = stats?.byCategory?.[cat.key];
            const label = pickCategoryListTitle(cat, cat.key);
            return (
              <TouchableOpacity
                key={cat.key}
                testID={`public-cat-${cat.key}`}
                onPress={() => setSelectedCat(active ? null : cat.key)}
                activeOpacity={0.8}
                style={[
                  styles.catChip,
                  { backgroundColor: active ? colors.primary + '22' : colors.card, borderColor: active ? colors.primary : colors.border },
                ]}
              >
                <Text style={styles.catEmoji}>{cat.emoji}</Text>
                <Text style={[styles.catText, { color: colors.text }]}>{label}</Text>
                {!!count && (
                  <View style={[styles.catCount, { backgroundColor: colors.primary }]}>
                    <Text style={styles.catCountText}>{count}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="search-outline" size={48} color={colors.textMuted} />
          <Text style={[styles.empty, { color: colors.textSecondary }]}>
            {activeCount > 0 || qDebounced
              ? t('service_marketplace.feed_empty_filtered')
              : t('service_marketplace.feed_empty_zero')}
          </Text>
          {mode === 'customer' && (
            <TouchableOpacity
              testID="public-empty-create"
              onPress={() => router.push('/service-marketplace/create' as any)}
              style={[styles.cta, { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.ctaText, { color: '#000' }]}>
                {t('service_marketplace.feed_create_first')}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          ListFooterComponent={loadingMore ? (
            <View style={{ paddingVertical: 16 }}><ActivityIndicator color={colors.primary} /></View>
          ) : null}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
  iconBtn: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  headerSub: { fontSize: 11, marginTop: 1 },
  heroRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, marginBottom: 10 },
  heroCard: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 12, borderWidth: 1 },
  heroNum: { fontSize: 20, fontWeight: '800' },
  heroLabel: { fontSize: 11, marginTop: 2 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, marginHorizontal: 16, borderRadius: 12, borderWidth: 1 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  chipRow: { paddingHorizontal: 16, paddingVertical: 10, gap: 8, alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1 },
  chipText: { fontSize: 12, fontWeight: '600' },
  chipDivider: { width: 1, height: 18, marginHorizontal: 4 },
  catRow: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  catChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 12, borderWidth: 1 },
  catEmoji: { fontSize: 14 },
  catText: { fontSize: 12, fontWeight: '600' },
  catCount: { minWidth: 18, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 10, marginLeft: 2 },
  catCountText: { fontSize: 10, fontWeight: '700', color: '#000', textAlign: 'center' },
  card: { padding: 14, borderRadius: 14, borderWidth: 1, marginBottom: 10 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  emoji: { fontSize: 28 },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  meta: { fontSize: 12 },
  urgencyBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1 },
  urgencyText: { fontSize: 11, fontWeight: '700' },
  desc: { fontSize: 13, marginTop: 10, lineHeight: 18 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, paddingTop: 10, borderTopWidth: 1 },
  footerChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  footerChipText: { fontSize: 12, fontWeight: '600' },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  statusPillText: { fontSize: 11, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  empty: { fontSize: 14, textAlign: 'center' },
  cta: { marginTop: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  ctaText: { fontSize: 14, fontWeight: '700' },
});

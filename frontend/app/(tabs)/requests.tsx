// Platform Cutover: Requests tab — list of car-requests with status filters.
// Core marketplace screen for customers.
import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import CarSelectionInboxBell from '../../src/components/CarSelectionInboxBell';
import i18n from '../../src/i18n';

type CarRequest = {
  id: string;
  type?: string;
  brand?: string;
  model?: string;
  country?: string;
  city?: string;
  status: string;
  createdAt?: string;
  priceEstimate?: number;
};

const FILTER_KEYS = ['all', 'active', 'report_ready', 'completed'] as const;

const STATUS_COLOR: Record<string, string> = {
  open: '#F59E0B',
  matching: '#F59E0B',
  in_progress: '#3B82F6',
  report_ready: '#10B981',
  completed: '#6B7280',
  cancelled: '#9CA3AF',
};

export default function RequestsTab() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t, i18n } = useTranslation();

  const [requests, setRequests] = useState<CarRequest[]>([]);
  const [filter, setFilter] = useState<string>('active');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/customer/requests/my');
      setRequests(res.data ?? []);
    } catch (e) {
      // keep empty
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const filtered = useMemo(() => {
    if (filter === 'all') return requests;
    if (filter === 'active') {
      return requests.filter((r) => !['completed', 'cancelled'].includes(r.status));
    }
    return requests.filter((r) => r.status === filter);
  }, [requests, filter]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]} testID="requests-title">
            {t('requests_tab.title')}
          </Text>
          <CarSelectionInboxBell testID="requests-cs-inbox-bell" />
          <TouchableOpacity
            testID="requests-create-btn"
            onPress={() => router.push('/auto-request/create')}
            style={[styles.headerBtn, { backgroundColor: colors.primary }]}
          >
            <Ionicons name="add" size={20} color="#FFF" />
          </TouchableOpacity>
        </View>

        {/* Filter chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filters}
        >
          {FILTER_KEYS.map((key) => {
            const active = key === filter;
            return (
              <TouchableOpacity
                key={key}
                testID={`requests-filter-${key}`}
                onPress={() => setFilter(key)}
                style={[
                  styles.filterChip,
                  {
                    backgroundColor: active ? colors.primary : colors.card,
                    borderColor: active ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.filterText,
                    { color: active ? '#FFF' : colors.text },
                  ]}
                >
                  {t(`requests_tab.filter_${key}`)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <ScrollView
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        >
          {loading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : filtered.length === 0 ? (
            <View
              style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}
              testID="requests-empty"
            >
              <Ionicons name="document-outline" size={40} color={colors.textSecondary} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('requests_tab.empty_title')}</Text>
              <Text style={[styles.emptySub, { color: colors.textSecondary }]}>
                {t('requests_tab.empty_sub')}
              </Text>
              <TouchableOpacity
                testID="requests-empty-cta"
                style={[styles.emptyBtn, { backgroundColor: colors.primary }]}
                onPress={() => router.push('/auto-request/create')}
              >
                <Text style={styles.emptyBtnText}>{t('requests_tab.empty_cta')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            filtered.map((r) => {
              const statusColor = STATUS_COLOR[r.status] ?? colors.textSecondary;
              const statusLabel = i18n.t(`requests_tab.status_${r.status}`, { defaultValue: r.status });
              const title = [r.brand, r.model].filter(Boolean).join(' ') || i18n.t('requests_tab.fallback_title');
              const typeLabel = r.type === 'inspection'
                ? i18n.t('requests_tab.type_inspection')
                : i18n.t('requests_tab.type_selection');
              return (
                <TouchableOpacity
                  key={r.id}
                  testID={`requests-item-${r.id}`}
                  activeOpacity={0.85}
                  style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={() => router.push({ pathname: '/auto-request/[id]', params: { id: r.id } } as any)}
                >
                  <View style={styles.cardTop}>
                    <Text style={[styles.cardType, { color: colors.textSecondary }]}>{typeLabel}</Text>
                    <View style={[styles.statusPill, { backgroundColor: `${statusColor}20` }]}>
                      <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                      <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
                    </View>
                  </View>
                  <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
                    {title}
                  </Text>
                  <View style={styles.cardMetaRow}>
                    <Ionicons name="location-outline" size={13} color={colors.textSecondary} />
                    <Text style={[styles.cardMeta, { color: colors.textSecondary }]}>
                      {[r.country, r.city].filter(Boolean).join(' · ') || '—'}
                    </Text>
                  </View>
                  {r.createdAt && (
                    <Text style={[styles.cardDate, { color: colors.textSecondary }]}>
                      {new Date(r.createdAt).toLocaleDateString(i18n.language, {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.3 },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filters: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    marginRight: 8,
  },
  filterText: { fontSize: 13, fontWeight: '600' },
  listContent: { paddingHorizontal: 16, paddingBottom: 96, paddingTop: 8 },
  empty: {
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
    borderWidth: 1,
    marginTop: 24,
  },
  emptyTitle: { fontSize: 16, fontWeight: '700', marginTop: 12 },
  emptySub: { fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  emptyBtn: {
    marginTop: 18,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
  },
  emptyBtnText: { color: '#FFF', fontSize: 14, fontWeight: '700' },
  card: {
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    marginBottom: 10,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cardType: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardTitle: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  cardMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardMeta: { fontSize: 13 },
  cardDate: { fontSize: 11, marginTop: 6 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    gap: 6,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 11, fontWeight: '600' },
});

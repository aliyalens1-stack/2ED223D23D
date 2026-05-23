/**
 * Service Marketplace — мои заявки (клиент).
 * GET /api/service-requests/me
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import i18n from '../../src/i18n';

type Req = {
  id: string;
  category: string;
  title: string;
  city: string;
  status: string;
  urgency: string;
  bidsCount: number;
  createdAt: string;
  budget?: { min?: number; max?: number; currency: string };
};

const STATUS_COLOR: Record<string, string> = {
  open: '#3b82f6',
  bidding: '#f59e0b',
  assigned: '#22c55e',
  in_progress: '#0ea5e9',
  completed: '#10b981',
  cancelled: '#6b7280',
  expired: '#9ca3af',
  disputed: '#ef4444',
};

const CAT_EMOJI: Record<string, string> = {
  repair: '🔧', tow: '🚛', wash: '🚿', detailing: '✨', battery: '🔋',
  parts: '🔩', delivery: '🚚', inspection: '🛡', car_selection: '🎯',
};

export default function MyServiceRequests() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const [items, setItems] = useState<Req[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/service-requests/me');
      setItems(r.data?.requests || []);
      setError(null);
    } catch (e: any) {
      const msg = e?.response?.status === 401 ? i18n.t('service_marketplace.my_login_required') : e?.message;
      setError(String(msg));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const renderItem = ({ item }: { item: Req }) => {
    const color = STATUS_COLOR[item.status] || '#888';
    return (
      <TouchableOpacity
        testID={`my-req-${item.id}`}
        onPress={() => router.push(`/service-marketplace/${item.id}` as any)}
        activeOpacity={0.85}
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={styles.cardRow}>
          <Text style={styles.emoji}>{CAT_EMOJI[item.category] || '📋'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{item.title}</Text>
            <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>
              {item.city} · {new Date(item.createdAt).toLocaleDateString()}
              {item.budget?.min ? ` · €${item.budget.min}${item.budget.max ? `–${item.budget.max}` : '+'}` : ''}
            </Text>
          </View>
          <View style={[styles.badge, { backgroundColor: color + '22', borderColor: color }]}>
            <Text style={[styles.badgeText, { color }]}>{t(`service_marketplace.status_${item.status}`)}</Text>
          </View>
        </View>
        <View style={[styles.cardFooter, { borderTopColor: colors.border }]}>
          <Ionicons name="chatbubble-ellipses-outline" size={14} color={colors.textSecondary} />
          <Text style={[styles.footerText, { color: colors.textSecondary }]}>
            {t(item.bidsCount === 1 ? 'service_marketplace.responses_count_one' : 'service_marketplace.responses_count_other', { count: item.bidsCount })}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity testID="my-req-back" onPress={() => router.back()} style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('service_marketplace.my_title')}</Text>
        <TouchableOpacity testID="my-req-new" onPress={() => router.push('/service-marketplace/create' as any)} style={[styles.backBtn, { backgroundColor: colors.primary }]} activeOpacity={0.7}>
          <Ionicons name="add" size={22} color="#000" />
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        testID="my-req-public-cta"
        onPress={() => router.push('/service-marketplace/public' as any)}
        activeOpacity={0.85}
        style={[styles.publicCta, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <View style={[styles.publicCtaIcon, { backgroundColor: colors.primary + '22' }]}>
          <Ionicons name="globe-outline" size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.publicCtaTitle, { color: colors.text }]}>{t('service_marketplace.open_marketplace')}</Text>
          <Text style={[styles.publicCtaSub, { color: colors.textSecondary }]}>
            {t('service_marketplace.open_marketplace_sub')}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
      </TouchableOpacity>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: colors.textSecondary }]}>{error}</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="document-text-outline" size={48} color={colors.textMuted} />
          <Text style={[styles.empty, { color: colors.textSecondary, marginTop: 12 }]}>{t('service_marketplace.my_empty')}</Text>
          <TouchableOpacity
            testID="my-req-create-cta"
            onPress={() => router.push('/service-marketplace/create' as any)}
            style={[styles.cta, { backgroundColor: colors.primary }]}
          >
            <Text style={[styles.ctaText, { color: '#000' }]}>{t('service_marketplace.my_create_cta')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12,
  },
  backBtn: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  card: { padding: 14, borderRadius: 14, borderWidth: 1, marginBottom: 10 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  emoji: { fontSize: 28 },
  title: { fontSize: 15, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingTop: 10, borderTopWidth: 1 },
  footerText: { fontSize: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  empty: { fontSize: 14, textAlign: 'center' },
  cta: { marginTop: 16, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  ctaText: { fontSize: 14, fontWeight: '700' },
  publicCta: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 16, marginBottom: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 14, borderWidth: 1,
  },
  publicCtaIcon: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  publicCtaTitle: { fontSize: 14, fontWeight: '700' },
  publicCtaSub: { fontSize: 11, marginTop: 2 },
});

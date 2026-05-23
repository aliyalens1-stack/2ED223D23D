/**
 * UX-2B — Customer-only dashboard (`/additional`).
 *
 * Previously this route mixed ProviderHome + CustomerHome in one 1200-line
 * file, so customers saw "выполнить задание", workbench counters, earnings
 * widgets, etc. Now:
 *
 *   • provider role → hard redirect to /provider/workbench
 *   • admin role    → redirect to /admin/dashboard (or login if not seeded)
 *   • customer role → clean dashboard with real data:
 *       /api/requests/my, /api/customer/reports, /api/customer/credits,
 *       /api/chat/v1/unread-summary, /api/notifications/since
 *
 * Deep-link support: `?cluster=<id>` highlights one cluster, mostly used by
 * Home page "Additional services" rail. resolveServiceRoute() (from
 * src/data/clusters.ts, UX-2A) is the single source of routing truth.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../src/context/AuthContext';
import { useThemeContext } from '../src/context/ThemeContext';
import { useCity } from '../src/context/CityContext';
import { api } from '../src/services/api';
import i18n from '../src/i18n';
import {
  CLUSTERS, CLUSTER_ORDER, resolveServiceRoute, type ClusterId,
} from '../src/data/clusters';

type CustomerRequest = {
  id: string;
  serviceKey?: string;
  service?: string;
  city?: string;
  description?: string;
  status?: string;
  createdAt?: string;
};

type CustomerReport = {
  jobId: string;
  requestId?: string;
  brand?: string;
  model?: string;
  score?: number;
  verdict?: string;
  riskLevel?: string;
  finishedAt?: string;
};

export default function CustomerDashboard() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t, i18n } = useTranslation();
  const { user, loading: authLoading } = useAuth();
  const { selectedCity } = useCity();
  const params = useLocalSearchParams<{ cluster?: string }>();

  // ---- Role guard: providers go to their workbench, admins to admin panel.
  useEffect(() => {
    if (authLoading) return;
    if (!user) return;
    const role = user.role || '';
    if (role === 'provider' || role.startsWith('provider')) {
      router.replace('/provider/workbench' as any);
    } else if (role === 'admin') {
      router.replace('/(tabs)' as any); // admin uses tabs home for now
    }
  }, [user, authLoading, router]);

  // Highlight one cluster when arriving from Home rail
  const focusedCluster: ClusterId | null = (() => {
    const raw = typeof params?.cluster === 'string' ? params.cluster : null;
    return raw && (CLUSTER_ORDER as string[]).includes(raw) ? (raw as ClusterId) : null;
  })();

  // ---- Data
  const [requests, setRequests] = useState<CustomerRequest[]>([]);
  const [reports, setReports] = useState<CustomerReport[]>([]);
  const [credits, setCredits] = useState<{ balance: number; available: number } | null>(null);
  const [unreadChat, setUnreadChat] = useState<number>(0);
  const [unreadNotif, setUnreadNotif] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadAll = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    try {
      const settled = await Promise.allSettled([
        api.get('/requests/my'),
        api.get('/customer/reports'),
        api.get('/customer/credits'),
        api.get('/chat/v1/unread-summary'),
        api.get('/notifications/since?limit=20'),
      ]);
      const [reqRes, repRes, credRes, chatRes, notifRes] = settled;
      if (reqRes.status === 'fulfilled') {
        const items = reqRes.value?.data?.items || reqRes.value?.data?.requests || [];
        setRequests(Array.isArray(items) ? items.slice(0, 3) : []);
      }
      if (repRes.status === 'fulfilled') {
        const items = repRes.value?.data?.reports || [];
        setReports(items.slice(0, 3));
      }
      if (credRes.status === 'fulfilled') {
        const d = credRes.value?.data;
        if (d) setCredits({ balance: d.balance ?? 0, available: d.available ?? 0 });
      }
      if (chatRes.status === 'fulfilled') {
        setUnreadChat(chatRes.value?.data?.unreadCount ?? chatRes.value?.data?.unread ?? 0);
      }
      if (notifRes.status === 'fulfilled') {
        const ns = notifRes.value?.data?.notifications || notifRes.value?.data?.items || [];
        setUnreadNotif(ns.filter((n: any) => !n.readAt).length);
      }
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  // ---- Render helpers
  const greeting = (() => {
    if (!user) return i18n.t('customer_dash.guest_greeting', { defaultValue: 'Добро пожаловать' });
    const name = (user as any).name || (user as any).fullName || (user as any).email?.split('@')[0] || '';
    return i18n.t('customer_dash.greeting', { defaultValue: 'Здравствуйте, {{name}}', name });
  })();

  const localizedStatus = (st?: string) => {
    if (!st) return '';
    const map: Record<string, string> = {
      offers: i18n.t('customer_dash.status.offers', { defaultValue: 'Предложения' }),
      pending: i18n.t('customer_dash.status.pending', { defaultValue: 'В ожидании' }),
      confirmed: i18n.t('customer_dash.status.confirmed', { defaultValue: 'Подтверждено' }),
      completed: i18n.t('customer_dash.status.completed', { defaultValue: 'Завершено' }),
      cancelled: i18n.t('customer_dash.status.cancelled', { defaultValue: 'Отменено' }),
    };
    return map[st] || st;
  };

  const statusTone = (st?: string) => {
    if (st === 'completed' || st === 'confirmed') return colors.success;
    if (st === 'cancelled') return colors.danger || colors.warning;
    return colors.primary;
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      {/* HEADER */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.greeting, { color: colors.text }]} numberOfLines={1}>{greeting}</Text>
          {selectedCity?.name ? (
            <View style={styles.cityRow}>
              <Ionicons name="location" size={12} color={colors.primary} />
              <Text style={[styles.citySub, { color: colors.textSecondary }]}>{selectedCity.name}</Text>
            </View>
          ) : null}
        </View>
        <TouchableOpacity
          testID="dash-notifications"
          style={[styles.iconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => router.push('/notifications' as any)}
          activeOpacity={0.7}
        >
          <Ionicons name="notifications" size={18} color={colors.text} />
          {unreadNotif > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.danger || '#e3342f' }]}>
              <Text style={styles.badgeText}>{unreadNotif > 9 ? '9+' : String(unreadNotif)}</Text>
            </View>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          testID="dash-chat"
          style={[styles.iconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => router.push('/(tabs)/requests' as any)}
          activeOpacity={0.7}
        >
          <Ionicons name="chatbubbles" size={18} color={colors.text} />
          {unreadChat > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.danger || '#e3342f' }]}>
              <Text style={styles.badgeText}>{unreadChat > 9 ? '9+' : String(unreadChat)}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* ===== Primary CTA: 4 cluster tiles ===== */}
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          {t('customer_dash.what_to_do', { defaultValue: 'Что нужно сделать?' })}
        </Text>
        <View style={styles.clusterGrid}>
          {CLUSTER_ORDER.map((id) => {
            const c = CLUSTERS[id];
            const focused = focusedCluster === id;
            const tone = c.tone === 'success' ? colors.success
              : c.tone === 'warning' ? colors.warning
              : colors.brand;
            return (
              <TouchableOpacity
                key={id}
                testID={`cluster-tile-${id}`}
                onPress={() => {
                  // Route directly into the cluster's primary request flow.
                  // Each cluster owns its own screen — no more shared /auto-request/choose.
                  if (id === 'inspection') router.push('/auto-request/create?type=inspection' as any);
                  else router.push(`/${id}/request` as any);
                }}
                style={[
                  styles.clusterCard,
                  {
                    backgroundColor: focused ? tone + '15' : colors.card,
                    borderColor: focused ? tone : colors.border,
                    borderWidth: focused ? 1.5 : 1,
                  },
                ]}
                activeOpacity={0.85}
              >
                <View style={[styles.clusterIconWrap, { backgroundColor: tone + '20' }]}>
                  <Ionicons name={c.icon} size={22} color={tone} />
                </View>
                <Text style={[styles.clusterTitle, { color: colors.text }]} numberOfLines={1}>
                  {t(c.titleKey, { defaultValue: id })}
                </Text>
                <Text style={[styles.clusterSub, { color: colors.textSecondary }]} numberOfLines={2}>
                  {t(c.subKey, { defaultValue: '' })}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ===== If a cluster was deep-linked, show its services beneath ===== */}
        {focusedCluster && (
          <View style={{ marginTop: 18 }}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {t(CLUSTERS[focusedCluster].titleKey)} — {t('customer_dash.services', { defaultValue: 'услуги' })}
            </Text>
            <View style={styles.svcGrid}>
              {CLUSTERS[focusedCluster].services.map((s) => {
                const tone = s.tone === 'success' ? colors.success
                  : s.tone === 'warning' ? colors.warning
                  : colors.brand;
                return (
                  <TouchableOpacity
                    key={s.key}
                    testID={`service-${s.key}`}
                    onPress={() => {
                      const r = resolveServiceRoute(focusedCluster, s);
                      router.push(r.params ? { pathname: r.pathname, params: r.params } as any : (r.pathname as any));
                    }}
                    style={[styles.svcItem, { backgroundColor: colors.card, borderColor: colors.border }]}
                    activeOpacity={0.85}
                  >
                    <View style={[styles.svcIconWrap, { backgroundColor: tone + '15' }]}>
                      <Ionicons name={s.icon} size={20} color={tone} />
                    </View>
                    <Text style={[styles.svcLabel, { color: colors.text }]} numberOfLines={2}>
                      {t(`home.svc.${s.key}`, { defaultValue: s.key })}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* ===== My Requests ===== */}
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0 }]}>
            {t('customer_dash.my_requests', { defaultValue: 'Мои заявки' })}
          </Text>
          <TouchableOpacity
            testID="dash-all-requests"
            onPress={() => router.push('/(tabs)/requests' as any)}
            activeOpacity={0.7}
          >
            <Text style={[styles.linkText, { color: colors.primary }]}>
              {t('customer_dash.see_all', { defaultValue: 'Все' })} →
            </Text>
          </TouchableOpacity>
        </View>
        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />
        ) : requests.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Ionicons name="document-text-outline" size={28} color={colors.textSecondary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {t('customer_dash.no_requests', { defaultValue: 'Заявок пока нет. Нажмите кластер сверху, чтобы начать.' })}
            </Text>
          </View>
        ) : (
          requests.map((r) => (
            <TouchableOpacity
              key={r.id}
              testID={`req-${r.id}`}
              onPress={() => router.push(`/auto-request/${r.id}` as any)}
              style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
              activeOpacity={0.8}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                  {r.service || r.serviceKey || '—'}
                </Text>
                <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
                  {r.description || r.city || ''}
                </Text>
              </View>
              <View style={[styles.statusPill, { backgroundColor: statusTone(r.status) + '20' }]}>
                <Text style={[styles.statusText, { color: statusTone(r.status) }]}>
                  {localizedStatus(r.status)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          ))
        )}

        {/* ===== My Reports ===== */}
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0 }]}>
            {t('customer_dash.my_reports', { defaultValue: 'Мои отчёты' })}
          </Text>
          <TouchableOpacity
            testID="dash-all-reports"
            onPress={() => router.push('/(tabs)/reports' as any)}
            activeOpacity={0.7}
          >
            <Text style={[styles.linkText, { color: colors.primary }]}>
              {t('customer_dash.see_all', { defaultValue: 'Все' })} →
            </Text>
          </TouchableOpacity>
        </View>
        {reports.length === 0 && !loading ? (
          <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Ionicons name="shield-checkmark-outline" size={28} color={colors.textSecondary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {t('customer_dash.no_reports', { defaultValue: 'Отчёты появятся после первой проверки.' })}
            </Text>
          </View>
        ) : (
          reports.map((rep) => {
            const verdictTone = rep.verdict === 'recommended' ? colors.success
              : rep.verdict === 'not_recommended' ? (colors.danger || colors.warning)
              : colors.warning;
            return (
              <TouchableOpacity
                key={rep.jobId}
                testID={`rep-${rep.jobId}`}
                onPress={() => router.push(`/inspection-report/${rep.jobId}` as any)}
                style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}
                activeOpacity={0.8}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                    {(rep.brand || '') + ' ' + (rep.model || '')}
                  </Text>
                  <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
                    {t('customer_dash.score', { defaultValue: 'Score' })} {rep.score ?? '—'}/10
                  </Text>
                </View>
                <View style={[styles.statusPill, { backgroundColor: verdictTone + '20' }]}>
                  <Text style={[styles.statusText, { color: verdictTone }]}>
                    {t(`customer_dash.verdict.${rep.verdict}`, { defaultValue: rep.verdict || '—' })}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            );
          })
        )}

        {/* ===== Credits ===== */}
        {credits && (
          <View style={[styles.creditsCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.creditsLabel, { color: colors.textSecondary }]}>
                {t('customer_dash.credits', { defaultValue: 'Кредиты' })}
              </Text>
              <Text style={[styles.creditsBalance, { color: colors.text }]}>
                {credits.available} <Text style={[styles.creditsHint, { color: colors.textSecondary }]}>/ {credits.balance}</Text>
              </Text>
            </View>
            <TouchableOpacity
              testID="dash-credits-history"
              onPress={() => router.push('/credits/history' as any)}
              style={[styles.creditsBtn, { borderColor: colors.border }]}
              activeOpacity={0.7}
            >
              <Text style={[styles.creditsBtnText, { color: colors.primary }]}>
                {t('customer_dash.history', { defaultValue: 'История' })}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ===== Quick Actions ===== */}
        <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 20 }]}>
          {t('customer_dash.quick_actions', { defaultValue: 'Быстрые действия' })}
        </Text>
        <View style={styles.quickGrid}>
          {[
            { id: 'garage',  icon: 'car-sport' as const,    label: t('customer_dash.garage',  { defaultValue: 'Гараж' }),    onPress: () => router.push('/(tabs)/garage' as any) },
            { id: 'support', icon: 'help-buoy' as const,    label: t('customer_dash.support', { defaultValue: 'Поддержка' }), onPress: () => router.push('/support' as any) },
            { id: 'help',    icon: 'help-circle' as const,  label: t('customer_dash.help',    { defaultValue: 'Помощь' }),   onPress: () => router.push('/help' as any) },
            { id: 'profile', icon: 'person-circle' as const,label: t('customer_dash.profile', { defaultValue: 'Профиль' }),  onPress: () => router.push('/(tabs)/profile' as any) },
          ].map((qa) => (
            <TouchableOpacity
              key={qa.id}
              testID={`quick-${qa.id}`}
              onPress={qa.onPress}
              style={[styles.quickItem, { backgroundColor: colors.card, borderColor: colors.border }]}
              activeOpacity={0.85}
            >
              <Ionicons name={qa.icon} size={22} color={colors.primary} />
              <Text style={[styles.quickLabel, { color: colors.text }]} numberOfLines={1}>{qa.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10,
  },
  greeting: { fontSize: 18, fontWeight: '700' },
  cityRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  citySub: { fontSize: 12, fontWeight: '500' },
  iconBtn: {
    width: 38, height: 38, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },
  badge: {
    position: 'absolute', top: -3, right: -3,
    minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },

  body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 },

  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 12, marginTop: 18 },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 22, marginBottom: 12,
  },
  linkText: { fontSize: 13, fontWeight: '600' },

  clusterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  clusterCard: {
    width: '48%', borderRadius: 14, padding: 12, gap: 6, minHeight: 108,
  },
  clusterIconWrap: {
    width: 38, height: 38, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  clusterTitle: { fontSize: 14, fontWeight: '700' },
  clusterSub: { fontSize: 11, lineHeight: 14 },

  svcGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  svcItem: {
    width: '48%', borderRadius: 12, padding: 10, gap: 6,
    minHeight: 78, borderWidth: 1,
  },
  svcIconWrap: {
    width: 32, height: 32, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
  },
  svcLabel: { fontSize: 12, fontWeight: '600', lineHeight: 15 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12, borderRadius: 12, borderWidth: 1, marginBottom: 8,
  },
  rowTitle: { fontSize: 14, fontWeight: '600' },
  rowSub: { fontSize: 12, marginTop: 2 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusText: { fontSize: 11, fontWeight: '700' },

  emptyCard: {
    borderRadius: 12, padding: 18, borderWidth: 1, alignItems: 'center', gap: 8,
  },
  emptyText: { fontSize: 13, textAlign: 'center', lineHeight: 18 },

  creditsCard: {
    flexDirection: 'row', alignItems: 'center',
    padding: 14, borderRadius: 14, borderWidth: 1, marginTop: 18,
  },
  creditsLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  creditsBalance: { fontSize: 24, fontWeight: '800', marginTop: 4 },
  creditsHint: { fontSize: 14, fontWeight: '600' },
  creditsBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  creditsBtnText: { fontSize: 13, fontWeight: '600' },

  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  quickItem: {
    width: '48%', borderRadius: 12, padding: 14,
    flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1,
  },
  quickLabel: { fontSize: 13, fontWeight: '600' },
});

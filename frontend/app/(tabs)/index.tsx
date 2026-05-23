// Auto-Selection Home — STRICT role-split (Customer vs Inspector)
// Customer: "Don't buy a car blind" + Проверить/Подобрать авто + active requests
// Inspector: Earnings dashboard + jobs feed → NO buyer CTAs, NO mixed UI.
import React, { useCallback, useEffect, useState } from 'react';
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
import { LinearGradient } from 'expo-linear-gradient';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';
import { useAuth } from '../../src/context/AuthContext';
import { api } from '../../src/services/api';
import i18n from '../../src/i18n';
// CarSelectionInboxBell removed (Phase 8.1 awareness was a 2nd notification
// surface). All notifications — including car-selection events — flow through
// the canonical bell → /notifications screen (uses /api/notifications/since).

type CarRequest = {
  id: string;
  type?: string;
  brand?: string;
  model?: string;
  country?: string;
  city?: string;
  status: string;
  createdAt?: string;
};

type CreditBalance = { balance?: number; available?: number; reserved?: number };

const STATUS_META: Record<string, { labelKey: string; color: string }> = {
  open: { labelKey: 'home.status_open', color: '#F59E0B' },
  matching: { labelKey: 'home.status_open', color: '#F59E0B' },
  in_progress: { labelKey: 'home.status_in_progress', color: '#3B82F6' },
  report_ready: { labelKey: 'home.status_report_ready', color: '#10B981' },
  completed: { labelKey: 'home.status_completed', color: '#6B7280' },
  cancelled: { labelKey: 'home.status_cancelled', color: '#9CA3AF' },
};

export default function AutoSelectionHome() {
  const { user } = useAuth();
  const isInspector = !!user && (user.role === 'provider' || (user.role || '').startsWith('provider'));

  // Strict role-split — never render mixed UI.
  if (isInspector) return <InspectorHome />;
  return <CustomerHome />;
}

/* ─────────────────────────────────────────────────────────
 * CUSTOMER HOME
 * ───────────────────────────────────────────────────────── */
function CustomerHome() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { user } = useAuth();
  const { t } = useTranslation();

  const [requests, setRequests] = useState<CarRequest[]>([]);
  const [reportsCount, setReportsCount] = useState(0);
  const [credits, setCredits] = useState<CreditBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [reqRes, reportsRes, creditsRes] = await Promise.allSettled([
        api.get('/customer/requests/my'),
        api.get('/customer/reports'),
        api.get('/customer/credits'),
      ]);
      if (reqRes.status === 'fulfilled') setRequests(reqRes.value.data ?? []);
      if (reportsRes.status === 'fulfilled') {
        const list = reportsRes.value.data?.items ?? reportsRes.value.data ?? [];
        setReportsCount(Array.isArray(list) ? list.length : 0);
      }
      if (creditsRes.status === 'fulfilled') setCredits(creditsRes.value.data ?? null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return i18n.t('home.greeting_morning');
    if (h < 18) return i18n.t('home.greeting_afternoon');
    return i18n.t('home.greeting_evening');
  })();

  const activeRequests = requests.filter((r) => !['completed', 'cancelled'].includes(r.status));
  const creditBalance = credits?.available ?? credits?.balance ?? 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.greeting, { color: colors.textSecondary }]}>{greeting}</Text>
              <Text style={[styles.userName, { color: colors.text }]} testID="home-user-name">
                {user?.firstName || t('home.guest')}
              </Text>
            </View>
            <TouchableOpacity testID="home-notifications-btn" style={[styles.headerIconBtn, { backgroundColor: colors.card }]} onPress={() => router.push('/notifications')}>
              <Ionicons name="notifications-outline" size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity testID="home-messages-btn" style={[styles.headerIconBtn, { backgroundColor: colors.card }]} onPress={() => router.push('/messages')}>
              <Ionicons name="chatbubble-outline" size={20} color={colors.text} />
            </TouchableOpacity>
          </View>

          <Text style={[styles.heroTitle, { color: colors.text }]}>{t('home.hero_title')}</Text>
          <Text style={[styles.heroSub, { color: colors.textSecondary }]}>{t('home.hero_sub')}</Text>

          <View style={styles.trustStrip} testID="home-trust-strip">
            <View style={[styles.trustItem, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.trustValue, { color: colors.text }]}>500+</Text>
              <Text style={[styles.trustLabel, { color: colors.textSecondary }]}>{t('trust.metric_inspections')}</Text>
            </View>
            <View style={[styles.trustItem, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.trustValue, { color: colors.text }]}>50+</Text>
              <Text style={[styles.trustLabel, { color: colors.textSecondary }]}>{t('trust.metric_inspectors')}</Text>
            </View>
            <View style={[styles.trustItem, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.trustValue, { color: colors.text }]}>24h</Text>
              <Text style={[styles.trustLabel, { color: colors.textSecondary }]}>{t('trust.metric_avg_time')}</Text>
            </View>
          </View>

          {/* Customer has ONE primary action: request an inspection. "Подобрать авто" is provider-only — see InspectorHome. */}
          <TouchableOpacity testID="home-cta-inspect" activeOpacity={0.9} onPress={() => router.push({ pathname: '/auto-request/create', params: { type: 'inspection' } } as any)}>
            <LinearGradient
              colors={[colors.brand ?? colors.primary, colors.brandDark ?? colors.primary]}
              style={styles.primaryCTA}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            >
              <View style={styles.ctaIconBox}>
                <Ionicons name="shield-checkmark" size={26} color="#FFF" />
              </View>
              <View style={styles.ctaText}>
                <Text style={styles.ctaTitle}>{t('home.cta_inspect_title')}</Text>
                <Text style={styles.ctaSub}>{t('home.cta_inspect_sub')}</Text>
              </View>
              <Ionicons name="arrow-forward-circle" size={28} color="#FFF" />
            </LinearGradient>
          </TouchableOpacity>

          {/* ── Service Marketplace v1 — биржа заявок + карта ───────────── */}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <TouchableOpacity
              testID="home-svc-marketplace"
              activeOpacity={0.85}
              onPress={() => router.push('/service-marketplace/create' as any)}
              style={{ flex: 1, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, padding: 14, borderRadius: 14, alignItems: 'flex-start', gap: 6 }}
            >
              <Ionicons name="construct-outline" size={22} color={colors.primary} />
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}>{t('home.svc_marketplace_title')}</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 11 }}>{t('home.svc_marketplace_sub')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="home-map-cta"
              activeOpacity={0.85}
              onPress={() => router.push('/map' as any)}
              style={{ flex: 1, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, padding: 14, borderRadius: 14, alignItems: 'flex-start', gap: 6 }}
            >
              <Ionicons name="map-outline" size={22} color={colors.primary} />
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}>{t('home.map_title')}</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 11 }}>{t('home.map_sub')}</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            testID="home-my-requests-cta"
            activeOpacity={0.85}
            onPress={() => router.push('/service-marketplace' as any)}
            style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, padding: 14, borderRadius: 14 }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Ionicons name="list-outline" size={20} color={colors.primary} />
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>{t('home.my_marketplace_requests')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </TouchableOpacity>

          {/* Customer metrics */}
          <View style={styles.metricsRow}>
            <TouchableOpacity testID="home-metric-requests" style={[styles.metricCard, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => router.push('/(tabs)/requests')}>
              <Text style={[styles.metricValue, { color: colors.text }]}>{activeRequests.length}</Text>
              <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{t('home.metric_active')}</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="home-metric-reports" style={[styles.metricCard, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => router.push('/(tabs)/reports')}>
              <Text style={[styles.metricValue, { color: colors.text }]}>{reportsCount}</Text>
              <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{t('home.metric_reports')}</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="home-metric-credits" style={[styles.metricCard, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => router.push('/packages')}>
              <Text style={[styles.metricValue, { color: colors.text }]}>{creditBalance}</Text>
              <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{t('home.metric_credits')}</Text>
            </TouchableOpacity>
          </View>

          {/* Additional services (Layer B = After-purchase ecosystem).
              Strict secondary: small horizontal rail, NOT primary CTAs.
              Layer A (Buy: inspection + selection) lives above this section as the main act.
              Each card deep-links into /additional?cluster=<id> so users land in the right context. */}
          <View style={styles.sectionHeader}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('home.additional_section')}</Text>
              <Text style={[styles.sectionSub, { color: colors.textSecondary }]}>{t('home.additional_section_sub')}</Text>
            </View>
            <TouchableOpacity onPress={() => router.push('/additional')} testID="home-additional-all">
              <Text style={[styles.linkText, { color: colors.primary }]}>{t('home.additional_open')}</Text>
            </TouchableOpacity>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.additionalRow} testID="home-additional-services">
            <TouchableOpacity testID="home-add-repair" activeOpacity={0.85}
              style={[styles.additionalCard, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: 'column', alignItems: 'flex-start' }]}
              onPress={() => router.push({ pathname: '/additional', params: { cluster: 'repair' } } as any)}
            >
              <View style={[styles.additionalIconBox, { backgroundColor: 'rgba(245,184,0,0.15)' }]}>
                <Ionicons name="construct" size={20} color={colors.primary} />
              </View>
              <Text style={[styles.additionalTitle, { color: colors.text }]} numberOfLines={1}>{t('home.clusters.repair_title')}</Text>
              <Text style={[styles.additionalSub, { color: colors.textSecondary }]} numberOfLines={2}>{t('home.clusters.repair_sub')}</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="home-add-delivery" activeOpacity={0.85}
              style={[styles.additionalCard, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: 'column', alignItems: 'flex-start' }]}
              onPress={() => router.push({ pathname: '/additional', params: { cluster: 'delivery' } } as any)}
            >
              <View style={[styles.additionalIconBox, { backgroundColor: 'rgba(251,146,60,0.15)' }]}>
                <Ionicons name="rocket" size={20} color="#FB923C" />
              </View>
              <Text style={[styles.additionalTitle, { color: colors.text }]} numberOfLines={1}>{t('home.clusters.delivery_title')}</Text>
              <Text style={[styles.additionalSub, { color: colors.textSecondary }]} numberOfLines={2}>{t('home.clusters.delivery_sub')}</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="home-add-more" activeOpacity={0.85}
              style={[styles.additionalCard, { backgroundColor: colors.card, borderColor: colors.border, flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }]}
              onPress={() => router.push('/additional')}
            >
              <View style={[styles.additionalIconBox, { backgroundColor: 'rgba(148,163,184,0.18)' }]}>
                <Ionicons name="apps" size={20} color={colors.textSecondary} />
              </View>
              <Text style={[styles.additionalTitle, { color: colors.primary, textAlign: 'center' }]} numberOfLines={1}>{t('home.additional_open')}</Text>
            </TouchableOpacity>
          </ScrollView>

          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('home.section_active')}</Text>
            {activeRequests.length > 0 && (
              <TouchableOpacity onPress={() => router.push('/(tabs)/requests')} testID="home-requests-all">
                <Text style={[styles.linkText, { color: colors.primary }]}>{t('home.section_all')}</Text>
              </TouchableOpacity>
            )}
          </View>

          {loading ? (
            <ActivityIndicator style={{ marginVertical: 20 }} color={colors.primary} />
          ) : activeRequests.length === 0 ? (
            <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]} testID="home-empty-requests">
              <Ionicons name="car-outline" size={36} color={colors.textSecondary} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('home.empty_title')}</Text>
              <Text style={[styles.emptySub, { color: colors.textSecondary }]}>{t('home.empty_sub')}</Text>
            </View>
          ) : (
            activeRequests.slice(0, 3).map((r) => {
              const m = STATUS_META[r.status] ?? { labelKey: '', color: colors.textSecondary };
              const label = m.labelKey ? i18n.t(m.labelKey) : r.status;
              const title = [r.brand, r.model].filter(Boolean).join(' ') || i18n.t('home.cta_select_title');
              return (
                <TouchableOpacity key={r.id} testID={`home-request-${r.id}`} activeOpacity={0.85}
                  style={[styles.requestCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={() => router.push({ pathname: '/auto-request/[id]', params: { id: r.id } } as any)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.requestTitle, { color: colors.text }]} numberOfLines={1}>{title}</Text>
                    <Text style={[styles.requestMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                      {[r.country, r.city].filter(Boolean).join(' · ') || '—'}
                    </Text>
                  </View>
                  <View style={[styles.statusPill, { backgroundColor: `${m.color}20` }]}>
                    <View style={[styles.statusDot, { backgroundColor: m.color }]} />
                    <Text style={[styles.statusText, { color: m.color }]}>{label}</Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}

          <View style={{ height: 32 }} />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

/* ─────────────────────────────────────────────────────────
 * INSPECTOR HOME — Earnings + Jobs (NO buyer CTAs)
 * ───────────────────────────────────────────────────────── */
type InspectorStats = {
  earningsMonth: number;
  activeJobs: number;
  completed: number;
  rating: number;
  availableJobs: number;
};

function InspectorHome() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { user, activeAccount } = useAuth();
  const { t } = useTranslation();

  const [stats, setStats] = useState<InspectorStats>({ earningsMonth: 0, activeJobs: 0, completed: 0, rating: 0, availableJobs: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [feedRes, statsRes, myJobsRes] = await Promise.allSettled([
        api.get('/inspector/exposures'),
        api.get('/inspector/stats'),
        api.get('/inspector/jobs'),
      ]);
      const next: InspectorStats = { earningsMonth: 0, activeJobs: 0, completed: 0, rating: 0, availableJobs: 0 };
      if (feedRes.status === 'fulfilled') {
        const data = feedRes.value.data ?? {};
        next.availableJobs = data.count ?? (data.exposures?.length ?? 0);
        next.activeJobs = data.activeJobsCount ?? next.activeJobs;
      }
      if (statsRes.status === 'fulfilled') {
        const s = statsRes.value.data ?? {};
        next.earningsMonth = s.earningsMonth ?? s.earnings_month ?? 0;
        next.completed = s.completed ?? s.completedJobs ?? 0;
        next.rating = s.rating ?? s.ratingAvg ?? 0;
        if (typeof s.activeJobs === 'number') next.activeJobs = s.activeJobs;
      }
      if (myJobsRes.status === 'fulfilled') {
        const list = myJobsRes.value.data?.items ?? myJobsRes.value.data ?? [];
        if (Array.isArray(list)) {
          const activeFromList = list.filter((j: any) => ['claimed', 'in_progress', 'inspecting'].includes(j.status)).length;
          if (!next.activeJobs) next.activeJobs = activeFromList;
        }
      }
      setStats(next);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return i18n.t('home.greeting_morning');
    if (h < 18) return i18n.t('home.greeting_afternoon');
    return i18n.t('home.greeting_evening');
  })();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.greeting, { color: colors.textSecondary }]}>{greeting}</Text>
              <Text style={[styles.userName, { color: colors.text }]} testID="inspector-home-name">
                {user?.firstName || t('home.guest')}
              </Text>
            </View>
            <TouchableOpacity testID="inspector-home-notifications" style={[styles.headerIconBtn, { backgroundColor: colors.card }]} onPress={() => router.push('/notifications')}>
              <Ionicons name="notifications-outline" size={20} color={colors.text} />
            </TouchableOpacity>
          </View>

          <Text style={[styles.heroTitle, { color: colors.text }]}>
            {t('inspector_home.hero_title')}
          </Text>
          <Text style={[styles.heroSub, { color: colors.textSecondary }]}>
            {t('inspector_home.hero_sub')}
          </Text>

          {/* B.2 — Persona narrative chip. Read-only. Surfaces the operational role
              that's currently active so provider stops being a silent subject of
              the screens below. Uses already-loaded `activeAccount` — no fetch. */}
          {activeAccount && (
            <View
              testID="inspector-home-persona-chip"
              style={[styles.personaChip, { backgroundColor: colors.card, borderColor: colors.primary }]}
            >
              <Ionicons name="person-circle-outline" size={14} color={colors.primary} />
              <Text style={[styles.personaChipText, { color: colors.text }]} numberOfLines={1}>
                {t('inspector_home.persona_role')}{' '}
                <Text style={{ fontWeight: '700' }}>
                  {activeAccount.kind === 'inspector' ? t('inspector_home.persona.inspector')
                    : activeAccount.kind === 'service_provider' ? t('inspector_home.persona.service_provider')
                    : activeAccount.kind === 'dealer' ? t('inspector_home.persona.dealer')
                    : activeAccount.kind === 'transport' || activeAccount.kind === 'transport_provider' ? t('inspector_home.persona.transport')
                    : activeAccount.kind}
                </Text>
              </Text>
            </View>
          )}

          {/* Earnings hero — tap → /provider/earnings-clarity (Phase 3.1 mobile parity) */}
          <TouchableOpacity
            testID="inspector-earnings-card"
            activeOpacity={0.85}
            onPress={() => router.push('/provider/earnings-clarity')}
            style={[styles.earningsCard, { backgroundColor: colors.card, borderColor: colors.primary }]}
          >
            <View>
              <Text style={[styles.earningsLabel, { color: colors.textSecondary }]}>{t('inspector_home.earnings_month')}</Text>
              {loading ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: 8 }} />
              ) : (
                <Text style={[styles.earningsValue, { color: colors.text }]}>€{stats.earningsMonth}</Text>
              )}
              <Text style={[styles.earningsLabel, { color: colors.textSecondary, marginTop: 4, fontSize: 11 }]}>
                {t('inspector_home.earnings_where')}
              </Text>
            </View>
            <View style={[styles.earningsBadge, { backgroundColor: colors.primary }]}>
              <Ionicons name="trending-up" size={16} color="#000" />
            </View>
          </TouchableOpacity>

          {/* Stats grid */}
          <View style={styles.inspectorGrid}>
            <View style={[styles.inspectorCell, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('inspector_home.active_jobs')}</Text>
              <Text style={[styles.statValue, { color: colors.primary }]}>{stats.activeJobs}</Text>
            </View>
            <View style={[styles.inspectorCell, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('inspector_home.completed')}</Text>
              <Text style={[styles.statValue, { color: colors.text }]}>{stats.completed}</Text>
            </View>
            <View style={[styles.inspectorCell, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('inspector_home.rating')}</Text>
              <Text style={[styles.statValue, { color: colors.text }]}>★ {stats.rating ? stats.rating.toFixed(1) : '—'}</Text>
            </View>
          </View>

          {/* Workbench CTA — Phase 3.1 mobile parity. Provider-facing operational projection. */}
          <TouchableOpacity testID="inspector-cta-workbench" activeOpacity={0.9}
            style={[styles.secondaryCTA, { backgroundColor: colors.card, borderColor: colors.primary, marginBottom: 12 }]}
            onPress={() => router.push('/provider/workbench')}
          >
            <View style={[styles.ctaIconBox, { backgroundColor: colors.infoBg ?? '#EEF2FF' }]}>
              <Ionicons name="construct-outline" size={22} color={colors.primary} />
            </View>
            <View style={styles.ctaText}>
              <Text style={[styles.ctaTitle, { color: colors.text }]}>{t('inspector_home.workbench_title')}</Text>
              <Text style={[styles.ctaSub, { color: colors.textSecondary }]}>{t('inspector_home.workbench_sub')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </TouchableOpacity>

          {/* Primary CTA — available jobs */}
          <TouchableOpacity testID="inspector-cta-available" activeOpacity={0.9} onPress={() => router.push('/inspector/exposures')}>
            <LinearGradient colors={[colors.brand ?? colors.primary, colors.brandDark ?? colors.primary]} style={styles.primaryCTA} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
              <View style={styles.ctaIconBox}>
                <Ionicons name="briefcase" size={24} color="#FFF" />
              </View>
              <View style={styles.ctaText}>
                <Text style={styles.ctaTitle}>{t('inspector_home.cta_available_title')}</Text>
                <Text style={styles.ctaSub}>{t('inspector_home.cta_available_sub', { count: stats.availableJobs })}</Text>
              </View>
              <Ionicons name="arrow-forward-circle" size={28} color="#FFF" />
            </LinearGradient>
          </TouchableOpacity>

          {/* Secondary CTA — my jobs */}
          <TouchableOpacity testID="inspector-cta-mine" activeOpacity={0.9}
            style={[styles.secondaryCTA, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => router.push('/inspector/jobs')}
          >
            <View style={[styles.ctaIconBox, { backgroundColor: colors.infoBg ?? '#EEF2FF' }]}>
              <Ionicons name="list" size={22} color={colors.primary} />
            </View>
            <View style={styles.ctaText}>
              <Text style={[styles.ctaTitle, { color: colors.text }]}>{t('inspector_home.cta_mine_title')}</Text>
              <Text style={[styles.ctaSub, { color: colors.textSecondary }]}>{t('inspector_home.cta_mine_sub')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </TouchableOpacity>

          {/* Public profile link */}
          <TouchableOpacity testID="inspector-public-profile" activeOpacity={0.7}
            style={[styles.inspectorRowCard, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 12 }]}
            onPress={() => router.push('/inspector/public-profile' as any)}
          >
            <Ionicons name="person-circle-outline" size={22} color={colors.textSecondary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={[styles.inspectorRowTitle, { color: colors.text }]}>{t('inspector_home.public_profile_title')}</Text>
              <Text style={[styles.inspectorRowSub, { color: colors.textSecondary }]}>{t('inspector_home.public_profile_sub')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </TouchableOpacity>

          {/* Service Marketplace Exchange — биржа заявок клиентов */}
          <TouchableOpacity testID="inspector-svc-exchange" activeOpacity={0.85}
            style={[styles.inspectorRowCard, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 12 }]}
            onPress={() => router.push('/service-marketplace/exchange' as any)}
          >
            <Ionicons name="briefcase-outline" size={22} color={colors.primary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={[styles.inspectorRowTitle, { color: colors.text }]}>{t('inspector_home.svc_exchange_title')}</Text>
              <Text style={[styles.inspectorRowSub, { color: colors.textSecondary }]}>{t('inspector_home.svc_exchange_sub')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </TouchableOpacity>

          <View style={{ height: 32 }} />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 96 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 20 },
  greeting: { fontSize: 13 },
  userName: { fontSize: 20, fontWeight: '700', marginTop: 2 },
  headerIconBtn: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  heroTitle: { fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  heroSub: { fontSize: 14, marginTop: 6, marginBottom: 20, lineHeight: 20 },
  // B.2 — Persona narrative chip
  personaChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, alignSelf: 'flex-start', marginBottom: 16 },
  personaChipText: { fontSize: 12 },
  primaryCTA: { borderRadius: 20, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 12 },
  ctaIconBox: { width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  ctaText: { flex: 1 },
  ctaTitle: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  ctaSub: { color: 'rgba(255,255,255,0.85)', fontSize: 13, marginTop: 2 },
  secondaryCTA: { borderRadius: 20, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14, borderWidth: 1, marginBottom: 24 },
  metricsRow: { flexDirection: 'row', gap: 10, marginBottom: 24 },
  metricCard: { flex: 1, borderRadius: 16, padding: 14, borderWidth: 1 },
  metricValue: { fontSize: 22, fontWeight: '800' },
  metricLabel: { fontSize: 11, marginTop: 4 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, marginTop: 8 },
  sectionTitle: { fontSize: 17, fontWeight: '700' },
  sectionSub: { fontSize: 11, fontWeight: '500', marginTop: 2, opacity: 0.7 },
  additionalRow: { flexDirection: 'row', gap: 10, marginBottom: 22, paddingRight: 12 },
  // Customer "additional services" cards — vertical stack: icon → title → subtitle.
  // Kept narrow (160) so 2 cards + a peek of the 3rd are visible on a typical
  // phone, encouraging horizontal exploration. minHeight ensures alignment when
  // subtitles wrap to 2 lines.
  additionalCard: { width: 160, borderRadius: 14, borderWidth: 1, padding: 14, gap: 10, minHeight: 124 },
  additionalIconBox: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  additionalTitle: { fontSize: 14, fontWeight: '800', letterSpacing: -0.1 },
  additionalSub: { fontSize: 11, fontWeight: '500', lineHeight: 14 },
  linkText: { fontSize: 14, fontWeight: '600' },
  emptyCard: { borderRadius: 16, padding: 20, alignItems: 'center', borderWidth: 1, gap: 6 },
  emptyTitle: { fontSize: 15, fontWeight: '600', marginTop: 6 },
  emptySub: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  requestCard: { borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, marginBottom: 10 },
  requestTitle: { fontSize: 15, fontWeight: '600' },
  requestMeta: { fontSize: 12, marginTop: 2 },
  statusPill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, gap: 6 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 11, fontWeight: '600' },
  // Inspector "public profile" row card — full-width horizontal layout
  // (icon → title/sub → chevron). Distinct from `additionalCard` so the two
  // styles never accidentally collide via duplicate keys (which previously
  // caused customer additional cards to lay out horizontally and clip text).
  inspectorRowCard: { borderRadius: 14, padding: 14, flexDirection: 'row', alignItems: 'center', borderWidth: 1 },
  inspectorRowTitle: { fontSize: 14, fontWeight: '600' },
  inspectorRowSub: { fontSize: 12, marginTop: 2 },
  trustStrip: { flexDirection: 'row', gap: 8, marginTop: 14, marginBottom: 4 },
  trustItem: { flex: 1, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 12, borderWidth: 1, alignItems: 'center' },
  trustValue: { fontSize: 18, fontWeight: '800', letterSpacing: 0.2 },
  trustLabel: { fontSize: 10, marginTop: 4, textAlign: 'center', lineHeight: 13 },
  // Inspector
  earningsCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderRadius: 16, padding: 18, marginBottom: 12 },
  earningsLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  earningsValue: { fontSize: 32, fontWeight: '800', marginTop: 4 },
  earningsBadge: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  inspectorGrid: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  inspectorCell: { flex: 1, borderWidth: 1, borderRadius: 14, padding: 14 },
  statLabel: { fontSize: 11, fontWeight: '600' },
  statValue: { fontSize: 20, fontWeight: '800', marginTop: 4 },
});

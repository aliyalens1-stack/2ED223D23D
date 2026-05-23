/**
 * Sprint 4 — Inspector Jobs Board (mobile).
 * Tabs: Available · My (active) · Done
 * GET  /api/inspector/jobs       (open)
 * GET  /api/inspector/jobs/my    (mine, full lifecycle)
 * POST /api/inspector/jobs/:id/claim
 *
 * i18n: all user-facing strings come from the `inspector_jobs.*` namespace.
 *       Locale-aware date formatting uses the current i18n language.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import i18n from '../../src/i18n';

const API = (Constants.expoConfig as any)?.extra?.apiUrl
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || 'http://localhost:8001';

interface Job {
  id: string; requestId: string; city: string; status: string;
  brand: string; model: string; budget: number; createdAt: string;
  inspectorId?: string | null;
  reportId?: string | null;
  onRouteAt?: string | null;
  arrivedAt?: string | null;
  inspectionStartedAt?: string | null;
  completedAt?: string | null;
}

type Tab = 'available' | 'my' | 'done';

const STATUS_COLORS: Record<string, string> = {
  open: '#A1A1AA',
  claimed: '#3B82F6',
  on_route: '#FFB020',
  arrived: '#FFB020',
  inspecting: '#FFB020',
  report_ready: '#22C55E',
  done: '#22C55E',
};

export default function InspectorJobsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('my');
  const [available, setAvailable] = useState<Job[]>([]);
  const [mine, setMine] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (currentToken: string | null) => {
    setError(null);
    try {
      const promises: Promise<any>[] = [
        fetch(`${API}/api/inspector/jobs`).then((r) => r.json()),
      ];
      if (currentToken) {
        promises.push(
          fetch(`${API}/api/inspector/jobs/my`, {
            headers: { Authorization: `Bearer ${currentToken}` },
          }).then((r) => r.json()),
        );
      }
      const [openData, myData] = await Promise.all(promises);
      setAvailable(openData?.jobs || []);
      setMine(myData?.jobs || []);
    } catch (e: any) {
      setError(e?.message || i18n.t('inspector_jobs.alert_error_generic'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    (async () => {
      const tk = await AsyncStorage.getItem('auth_token');
      setToken(tk);
      await load(tk);
    })();
  }, [load]);

  const onRefresh = () => { setRefreshing(true); load(token); };

  const claim = async (job: Job) => {
    if (!token) {
      Alert.alert(
        i18n.t('inspector_jobs.alert_signin_title'),
        i18n.t('inspector_jobs.alert_signin_body'),
        [
          { text: i18n.t('inspector_jobs.alert_signin_cancel') },
          { text: i18n.t('inspector_jobs.alert_signin_action'), onPress: () => router.push('/login?role=provider') },
        ],
      );
      return;
    }
    try {
      const res = await fetch(`${API}/api/inspector/jobs/${job.id}/claim`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 409) {
        Alert.alert(i18n.t('inspector_jobs.alert_already_claimed_title'), i18n.t('inspector_jobs.alert_already_claimed_body'));
        load(token);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.push({ pathname: '/inspector/job/[id]', params: { id: job.id } });
    } catch (e: any) {
      Alert.alert(i18n.t('inspector_jobs.alert_error_title'), e?.message || i18n.t('inspector_jobs.alert_error_generic'));
    }
  };

  const myActive = mine.filter((j) => j.status !== 'done' && j.status !== 'open');
  const myDone = mine.filter((j) => j.status === 'done');
  const visible = tab === 'available' ? available : tab === 'my' ? myActive : myDone;

  const tabLabel = (key: Tab) => {
    if (key === 'available') return i18n.t('inspector_jobs.tab_available');
    if (key === 'my') return i18n.t('inspector_jobs.tab_my', { count: myActive.length });
    return i18n.t('inspector_jobs.tab_history', { count: myDone.length });
  };

  const emptyLabel = () => {
    if (tab === 'available') return i18n.t('inspector_jobs.empty_available');
    if (tab === 'my') return i18n.t('inspector_jobs.empty_my');
    return i18n.t('inspector_jobs.empty_done');
  };

  return (
    <SafeAreaView style={styles.safe} testID="inspector-jobs-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="jobs-back-btn">
          <Ionicons name="chevron-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('inspector_jobs.header_title')}</Text>
        <TouchableOpacity onPress={onRefresh} testID="jobs-refresh-btn">
          <Ionicons name="refresh" size={22} color="#FFF" />
        </TouchableOpacity>
      </View>

      <View style={styles.tabsRow}>
        {(['available', 'my', 'done'] as Tab[]).map((key) => (
          <TouchableOpacity
            key={key}
            onPress={() => {
              if (key === 'available') {
                // Phase 3 — Step 3: "Available" → exposures feed (curated by platform).
                // Old fan-out open-jobs remain readable via API for backwards-compat
                // but the entry point for inspectors is the exposure stream.
                router.push('/inspector/exposures' as any);
                return;
              }
              setTab(key);
            }}
            style={[styles.tabPill, tab === key && styles.tabPillActive]}
            testID={`jobs-tab-${key}`}
          >
            <Text style={[styles.tabText, tab === key && styles.tabTextActive]} numberOfLines={1}>
              {tabLabel(key)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading && <ActivityIndicator style={{ marginTop: 40 }} color="#FFB020" />}
      {error && <Text style={styles.errorText}>{error}</Text>}

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FFB020" />}
      >
        {!loading && visible.length === 0 && (
          <View style={styles.emptyBox} testID="inspector-jobs-empty">
            <Ionicons name="search" size={28} color="#A1A1AA" />
            <Text style={styles.emptyTitle}>
              {emptyLabel()}
            </Text>
            <Text style={styles.emptySub}>{t('inspector_jobs.pull_to_refresh')}</Text>
          </View>
        )}

        {visible.map((j) => {
          const isReady = j.status === 'report_ready' || j.status === 'done';
          const onPress = () => {
            if (tab === 'available') {
              claim(j);
              return;
            }
            // Smart routing — when the report is submitted (or accepted),
            // route straight to the readable inspection report (same surface
            // the customer sees + PDF share). Otherwise the inspector lands
            // on the action/status detail screen.
            if (isReady && j.reportId) {
              router.push({ pathname: '/inspection-report/[jobId]', params: { jobId: j.id } } as any);
              return;
            }
            router.push({ pathname: '/inspector/job/[id]', params: { id: j.id } });
          };
          const statusColor = STATUS_COLORS[j.status] || '#A1A1AA';
          const statusLabel = i18n.t(`inspector_jobs.status.${j.status}`, { defaultValue: j.status });
          const actionLabel =
            tab === 'available'
              ? i18n.t('inspector_jobs.action_claim')
              : isReady && j.reportId
              ? i18n.t('inspector_jobs.action_open_report')
              : i18n.t('inspector_jobs.action_open');
          return (
            <TouchableOpacity
              key={j.id}
              style={styles.card}
              testID={`inspector-job-${j.id}`}
              onPress={onPress}
              activeOpacity={0.7}
            >
              {/* Row 1: icon + title block (flex:1 + numberOfLines truncation)
                  + status pill (flexShrink:0). Prevents the 3-wrap visual
                  bug where "Mercedes" or "Skoda Octavia" was forced to wrap
                  one letter per line when the long status label squeezed
                  the title column to 60-80px. */}
              <View style={styles.cardHead}>
                <View style={styles.cardIcon}>
                  <Ionicons name="car-sport" size={18} color="#FFB020" />
                </View>
                <View style={styles.cardTitleBlock}>
                  <Text style={styles.cardTitle} numberOfLines={1} ellipsizeMode="tail">
                    {j.brand} {j.model}
                  </Text>
                  <View style={styles.cardSubRow}>
                    <Ionicons name="location-outline" size={12} color="#A1A1AA" />
                    <Text style={styles.cardSub} numberOfLines={1} ellipsizeMode="tail">
                      {' '}{j.city} · {t('inspector_jobs.card_budget_prefix')} {Number(j.budget).toLocaleString('de-DE')} €
                    </Text>
                  </View>
                </View>
                <View style={[styles.statusPill, { borderColor: statusColor }]} testID={`inspector-job-${j.id}-status`}>
                  <Text style={[styles.statusText, { color: statusColor }]} numberOfLines={1}>
                    {statusLabel}
                  </Text>
                </View>
              </View>
              <View style={styles.cardActionRow}>
                <Text style={styles.cardActionText} testID={`inspector-job-${j.id}-cta`}>
                  {actionLabel}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderBottomWidth: 1, borderBottomColor: '#2E2E2E' },
  headerTitle: { fontSize: 17, fontWeight: '800', color: '#FFF', letterSpacing: 1, textTransform: 'uppercase' },
  // Tabs row — equal-width pills so the third tab (t('inspector.istoriya_n')) cannot
  // overflow the viewport on narrow screens. Previously the pills used
  // content-width sizing with paddingHorizontal:14 + gap:8, which made
  // the combined width exceed the viewport on smaller phones and the
  // active t('inspector.istoriya') pill was clipped at the right edge.
  tabsRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#2E2E2E' },
  tabPill: { flex: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: '#2E2E2E', alignItems: 'center', justifyContent: 'center' },
  tabPillActive: { backgroundColor: '#FFB020', borderColor: '#FFB020' },
  tabText: { fontSize: 12, fontWeight: '700', color: '#FFF', letterSpacing: 0.5, textAlign: 'center' },
  tabTextActive: { color: '#000' },
  body: { padding: 18, paddingBottom: 60 },
  emptyBox: { alignItems: 'center', padding: 40, borderWidth: 1, borderColor: '#2E2E2E', borderRadius: 12, borderStyle: 'dashed' },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: '#FFF', marginTop: 10 },
  emptySub: { fontSize: 13, color: '#A1A1AA', marginTop: 3, textAlign: 'center' },
  card: { borderWidth: 1, borderColor: '#2E2E2E', borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 14, marginBottom: 10, backgroundColor: '#0d0d0d' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  cardIcon: { height: 38, width: 38, borderRadius: 10, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#2E2E2E', flexShrink: 0 },
  // Title column grows to fill remaining space; flexShrink:1 lets it
  // collapse so the right-side status pill never gets squeezed off
  // the row. Combined with `numberOfLines={1}` + `ellipsizeMode:'tail'`
  // on title + subtitle this kills the 3-wrap visual bug ("Merce/des/C200",
  // t('inspector.berlin_do_180')) that appeared on cards with long status labels.
  cardTitleBlock: { flex: 1, flexShrink: 1, minWidth: 0 },
  cardTitle: { fontSize: 15, fontWeight: '800', color: '#FFF' },
  cardSubRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  cardSub: { fontSize: 12, color: '#A1A1AA', flex: 1 },
  // Status pill never shrinks; max width keeps single-line labels readable
  // and prevents the pill itself from forcing a wrap.
  statusPill: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, flexShrink: 0, maxWidth: 120 },
  statusText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  cardActionRow: { paddingTop: 8, borderTopWidth: 1, borderTopColor: '#2E2E2E', alignItems: 'flex-end' },
  cardActionText: { fontSize: 11, fontWeight: '700', color: '#FFB020', letterSpacing: 0.5, textTransform: 'uppercase' },
  errorText: { marginTop: 40, textAlign: 'center', color: '#EF4444', fontWeight: '700' },
});

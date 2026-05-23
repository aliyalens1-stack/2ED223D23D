/**
 * Sprint 3 Step 4 — Inspector live assignments screen.
 *
 * Card per assignment:
 *   vehicle/city · earnings · distance · priority · countdown
 *   reputation match reason (ranking breakdown) · Accept / Decline
 *
 * Expired offers disappear from the live list (server-side lazy expire)
 * and the screen also locally hides any row whose expiresAt is past.
 *
 * Polling: 15s (faster than notifications since the countdown is visible).
 *
 * i18n: all user-facing strings come from `inspector_assignments_live.*`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  RefreshControl, TouchableOpacity, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import i18n from '../../src/i18n';

const API = (Constants.expoConfig?.extra as any)?.EXPO_BACKEND_URL
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || '';

interface Assignment {
  id: string;
  jobId: string;
  status: string;
  priority: 'normal' | 'urgent' | 'premium';
  expiresAt: string;
  ttlSeconds: number;
  distanceKm: number | null;
  estimatedEarnings: number | null;
  currency: string;
  score: number;
  ranking: {
    reputationScore: number;
    distanceScore: number;
    availabilityScore: number;
    verificationScore: number;
  };
  createdAt: string;
  metadata?: Record<string, any>;
}

const PRIORITY_COLOR: Record<string, string> = {
  normal:  '#3b82f6',
  urgent:  '#ef4444',
  premium: '#a855f7',
};

function formatCountdown(expiresAt: string): { label: string; expired: boolean } {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return { label: '0:00', expired: true };
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60); const s = sec % 60;
  return { label: `${m}:${s.toString().padStart(2, '0')}`, expired: false };
}

function useRankingReason() {
  const { t } = useTranslation();
  return useCallback((r: Assignment['ranking']): string => {
    const parts: string[] = [];
    if (r.reputationScore   >= 80) parts.push(t('inspector_assignments_live.reason_reputation', { value: r.reputationScore }));
    if (r.distanceScore     >= 60) parts.push(t('inspector_assignments_live.reason_close', { value: r.distanceScore }));
    if (r.availabilityScore === 100) parts.push(t('inspector_assignments_live.reason_online'));
    if (r.verificationScore === 100) parts.push(t('inspector_assignments_live.reason_verified'));
    return parts.length ? parts.join(' · ') : t('inspector_assignments_live.reason_general');
  }, [t]);
}

export default function InspectorAssignmentsLive() {
  const router = useRouter();
  const { t } = useTranslation();
  const rankingReason = useRankingReason();
  const [items, setItems] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, forceTick] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const tk = await AsyncStorage.getItem('auth_token');
    if (!tk) return;
    try {
      const r = await fetch(`${API}/api/inspector/assignments/live`, {
        headers: { Authorization: `Bearer ${tk}` },
      });
      if (r.ok) {
        const data = await r.json();
        setItems((data.items || []) as Assignment[]);
      }
    } catch { /* keep state */ }
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(); setLoading(false); })();
    pollRef.current = setInterval(load, 15000);
    const tick = setInterval(() => forceTick((x) => x + 1), 1000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      clearInterval(tick);
    };
  }, [load]);

  const transition = async (id: string, action: 'accept' | 'decline') => {
    setBusyId(id);
    try {
      const tk = await AsyncStorage.getItem('auth_token');
      const r = await fetch(`${API}/api/inspector/assignments/${id}/${action}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tk}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      const data = await r.json().catch(() => ({}));
      const status = (data && data.status) || (r.ok ? action : 'error');
      if (status === 'accepted' || status === 'idempotent') {
        Alert.alert(i18n.t('inspector_assignments_live.alert_accepted_title'), i18n.t('inspector_assignments_live.alert_accepted_body'));
        router.push('/inspector/jobs');
      } else if (status === 'declined') {
        // silently drop from list
      } else if (status === 'expired') {
        Alert.alert(i18n.t('inspector_assignments_live.alert_expired_title'), i18n.t('inspector_assignments_live.alert_expired_body'));
      } else if (status === 'conflict') {
        Alert.alert(i18n.t('inspector_assignments_live.alert_conflict_title'), i18n.t('inspector_assignments_live.alert_conflict_body'));
      } else if (status === 'forbidden' || r.status === 403) {
        Alert.alert(i18n.t('inspector_assignments_live.alert_forbidden_title'), i18n.t('inspector_assignments_live.alert_forbidden_body'));
      }
      await load();
    } finally { setBusyId(null); }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}><View style={styles.center}><ActivityIndicator color="#FFB020" /></View></SafeAreaView>
    );
  }
  const visible = items.filter((a) => new Date(a.expiresAt).getTime() > Date.now());

  return (
    <SafeAreaView style={styles.safe} edges={['top']} testID="inspector-assignments-live">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="assignments-back">
          <Ionicons name="chevron-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('inspector_assignments_live.header_title')}</Text>
        <Text style={styles.counter}>{visible.length}</Text>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor="#FFB020" />}
      >
        {visible.length === 0 && (
          <View style={styles.emptyBox}>
            <Ionicons name="time-outline" size={32} color="#52525B" />
            <Text style={styles.emptyText}>{t('inspector_assignments_live.empty_text')}</Text>
          </View>
        )}
        {visible.map((a) => {
          const cd = formatCountdown(a.expiresAt);
          return (
            <View key={a.id} style={styles.card} testID={`assignment-${a.id}`}>
              <View style={styles.cardHeader}>
                <View style={[styles.pill, { backgroundColor: `${PRIORITY_COLOR[a.priority] || '#3b82f6'}22`, borderColor: PRIORITY_COLOR[a.priority] || '#3b82f6' }]}>
                  <Text style={[styles.pillText, { color: PRIORITY_COLOR[a.priority] || '#3b82f6' }]}>{a.priority.toUpperCase()}</Text>
                </View>
                <View style={[styles.pill, styles.countdownPill]}>
                  <Ionicons name="time" size={11} color={cd.expired ? '#ef4444' : '#FFB020'} />
                  <Text style={[styles.pillText, { color: cd.expired ? '#ef4444' : '#FFB020' }]}>{cd.label}</Text>
                </View>
              </View>

              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{t('inspector_assignments_live.job_title', { id: a.jobId.slice(-8) })}</Text>
                  <Text style={styles.cardSub}>{a.distanceKm != null ? t('inspector_assignments_live.distance_value', { km: a.distanceKm }) : t('inspector_assignments_live.distance_missing')}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.earnings}>{a.estimatedEarnings ?? '—'} {a.currency}</Text>
                  <Text style={styles.score}>{t('inspector_assignments_live.score_label', { value: a.score })}</Text>
                </View>
              </View>

              <View style={styles.reasonBox}>
                <Ionicons name="sparkles" size={12} color="#FFB020" />
                <Text style={styles.reasonText}>{rankingReason(a.ranking)}</Text>
              </View>

              <View style={styles.actions}>
                <TouchableOpacity
                  style={[styles.btn, styles.btnDecline]}
                  onPress={() => transition(a.id, 'decline')}
                  disabled={busyId === a.id}
                  testID={`decline-${a.id}`}
                >
                  <Text style={styles.btnDeclineText}>{busyId === a.id ? '…' : t('inspector_assignments_live.btn_decline')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.btnAccept]}
                  onPress={() => transition(a.id, 'accept')}
                  disabled={busyId === a.id}
                  testID={`accept-${a.id}`}
                >
                  <Text style={styles.btnAcceptText}>{busyId === a.id ? '…' : t('inspector_assignments_live.btn_accept')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#1f1f22',
  },
  headerTitle: { color: '#FFF', fontSize: 13, fontWeight: '900', letterSpacing: 1.5 },
  counter: { color: '#FFB020', fontWeight: '900' },

  emptyBox: { alignItems: 'center', padding: 32, gap: 12 },
  emptyText: { color: '#71717A', fontSize: 13, textAlign: 'center', lineHeight: 19 },

  card: {
    backgroundColor: '#101012', borderRadius: 14, padding: 14, marginBottom: 12,
    borderWidth: 1, borderColor: '#1f1f22', gap: 12,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  row: { flexDirection: 'row', alignItems: 'center' },
  cardTitle: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  cardSub: { color: '#A1A1AA', fontSize: 12, marginTop: 2 },
  earnings: { color: '#22c55e', fontSize: 17, fontWeight: '900' },
  score: { color: '#71717A', fontSize: 11, marginTop: 2 },

  pill: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    borderWidth: 1,
  },
  pillText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  countdownPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,176,32,0.12)', borderColor: 'rgba(255,176,32,0.4)',
  },

  reasonBox: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#0F0F10', padding: 8, borderRadius: 8,
  },
  reasonText: { color: '#A1A1AA', fontSize: 11, flex: 1 },

  actions: { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, padding: 12, borderRadius: 10, alignItems: 'center' },
  btnAccept: { backgroundColor: '#22c55e' },
  btnAcceptText: { color: '#FFF', fontWeight: '900', fontSize: 14 },
  btnDecline: { borderWidth: 1, borderColor: '#3f3f46' },
  btnDeclineText: { color: '#E4E4E7', fontWeight: '700', fontSize: 14 },
});

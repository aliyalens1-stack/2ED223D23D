/**
 * Sprint 3 Step 3 — Inspector reputation screen.
 *
 * Operational coaching, not gamification. Shows the breakdown the
 * inspector can act on:
 *   - overall score + tier
 *   - 7 sub-metrics with explanations
 *   - "what hurts" / "what helps"
 *   - hard-floor banner when active
 *   - tier-change history (last N snapshots)
 *
 * Pull-to-refresh re-fetches both endpoints; the backend recomputes on
 * trigger events but never during a GET (idempotent read).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  RefreshControl, TouchableOpacity,
} from 'react-native';
import i18n from '../../src/i18n';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const API = (Constants.expoConfig?.extra as any)?.EXPO_BACKEND_URL
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || '';

interface Reputation {
  score: number;
  tier: 'bronze' | 'silver' | 'gold' | 'platinum';
  rawTier?: string;
  hardFloor?: boolean;
  hardFloorReason?: string | null;
  inspectionQuality: number;
  evidenceCompleteness: number;
  customerAcceptance: number;
  disputeRate: number;
  aiAlignment: number;
  responseDiscipline: number;
  verificationScore: number;
  updatedAt?: string;
}
interface Coaching {
  hurts: { metric: string; value: number; message: string }[];
  helps: { metric: string; value: number; message: string }[];
}
interface HistoryRow {
  score: number;
  tier: string;
  computedAt: string;
  tierChange?: { from: string; to: string } | null;
  hardFloor?: boolean;
}

const TIER_TONE: Record<string, { fg: string; bg: string; label: string }> = {
  bronze:   { fg: '#FFB880', bg: '#2a1a0c', label: 'BRONZE' },
  silver:   { fg: '#E2E8F0', bg: '#1c2331', label: 'SILVER' },
  gold:     { fg: '#FFC857', bg: '#2a2110', label: 'GOLD' },
  platinum: { fg: '#7DD3FC', bg: '#102233', label: 'PLATINUM' },
};

const METRIC_LABELS: Record<string, string> = {
  inspectionQuality:    i18n.t('inspector.kachestvo_otchetov'),
  evidenceCompleteness: i18n.t('inspector.polnota_dokazatelstv'),
  customerAcceptance:   i18n.t('inspector.priemka_klientom'),
  disputeRate:          i18n.t('inspector.nizkaya_osparivaemost'),
  aiAlignment:          i18n.t('inspector.soglasovannost_s_ai'),
  responseDiscipline:   i18n.t('inspector.disciplina_vypolneniya'),
  verificationScore:    i18n.t('inspector.podtverzhdennost_profilya'),
};

export default function InspectorReputationScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [rep, setRep] = useState<Reputation | null>(null);
  const [coaching, setCoaching] = useState<Coaching>({ hurts: [], helps: [] });
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const t = await AsyncStorage.getItem('auth_token');
    if (!t) return;
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${API}/api/inspector/reputation`, { headers: { Authorization: `Bearer ${t}` } }),
        fetch(`${API}/api/inspector/reputation/history?limit=10`, { headers: { Authorization: `Bearer ${t}` } }),
      ]);
      if (r1.ok) {
        const data = await r1.json();
        setRep(data.reputation || null);
        setCoaching(data.coaching || { hurts: [], helps: [] });
      }
      if (r2.ok) {
        const data = await r2.json();
        setHistory(data.items || []);
      }
    } catch { /* keep current state */ }
  }, []);

  useEffect(() => { (async () => { setLoading(true); await load(); setLoading(false); })(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true); await load(); setRefreshing(false);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}><View style={styles.center}><ActivityIndicator color="#FFB020" /></View></SafeAreaView>
    );
  }
  const tone = TIER_TONE[rep?.tier || 'bronze'];

  return (
    <SafeAreaView style={styles.safe} edges={['top']} testID="inspector-reputation">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="reputation-back">
          <Ionicons name="chevron-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('inspector.rejting_2')}</Text>
        <View style={{ width: 24 }} />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FFB020" />}
      >
        {/* Score + tier */}
        <View style={[styles.heroCard, { backgroundColor: tone.bg }]}>
          <Text style={styles.score} testID="reputation-score">{rep?.score ?? 0}</Text>
          <Text style={[styles.tier, { color: tone.fg }]} testID="reputation-tier">{tone.label}</Text>
          {rep?.hardFloor && (
            <View style={styles.floorPill}>
              <Ionicons name="lock-closed" size={12} color="#fecaca" />
              <Text style={styles.floorText}>Hard floor: {rep.hardFloorReason || 'open dispute'}</Text>
            </View>
          )}
          {rep?.updatedAt && (
            <Text style={styles.updated}>обновлён {new Date(rep.updatedAt).toLocaleString('ru-RU')}</Text>
          )}
        </View>

        {/* Sub-metrics breakdown */}
        <Text style={styles.section}>{t('inspector.razbor')}</Text>
        <View style={styles.metricsList}>
          {Object.entries(METRIC_LABELS).map(([key, label]) => {
            const v = (rep as any)?.[key] ?? 0;
            return (
              <View key={key} style={styles.metricRow} testID={`metric-${key}`}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.metricLabel}>{label}</Text>
                  <View style={styles.bar}>
                    <View style={[styles.barFill, { width: `${Math.max(0, Math.min(100, v))}%`, backgroundColor: v >= 85 ? '#22c55e' : v >= 70 ? '#FFB020' : '#ef4444' }]} />
                  </View>
                </View>
                <Text style={[styles.metricValue, { color: v >= 85 ? '#22c55e' : v >= 70 ? '#FFB020' : '#ef4444' }]}>{v}</Text>
              </View>
            );
          })}
        </View>

        {/* Coaching */}
        {coaching.hurts.length > 0 && (
          <>
            <Text style={[styles.section, { color: '#fecaca' }]}>{t('inspector.chto_uhudshaet')}</Text>
            <View style={styles.coachList}>
              {coaching.hurts.map((c) => (
                <View key={`hurt-${c.metric}`} style={[styles.coachRow, { borderColor: '#7f1d1d' }]} testID={`coach-hurt-${c.metric}`}>
                  <Ionicons name="alert-circle" size={16} color="#ef4444" />
                  <Text style={styles.coachText}>{c.message}</Text>
                </View>
              ))}
            </View>
          </>
        )}
        {coaching.helps.length > 0 && (
          <>
            <Text style={[styles.section, { color: '#bbf7d0' }]}>{t('inspector.chto_pomogaet')}</Text>
            <View style={styles.coachList}>
              {coaching.helps.map((c) => (
                <View key={`help-${c.metric}`} style={[styles.coachRow, { borderColor: '#14532d' }]} testID={`coach-help-${c.metric}`}>
                  <Ionicons name="checkmark-circle" size={16} color="#22c55e" />
                  <Text style={styles.coachText}>{c.message}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {/* History */}
        {history.length > 0 && (
          <>
            <Text style={styles.section}>{t('inspector.istoriya_2')}</Text>
            <View style={styles.metricsList}>
              {history.map((h, idx) => (
                <View key={`h-${idx}`} style={styles.histRow}>
                  <Text style={styles.histDate}>{new Date(h.computedAt).toLocaleString('ru-RU')}</Text>
                  <Text style={styles.histScore}>{h.score}</Text>
                  <Text style={[styles.histTier, { color: TIER_TONE[h.tier]?.fg || '#FFF' }]}>{h.tier}</Text>
                  {h.tierChange && (
                    <Text style={styles.histDelta}>{h.tierChange.from} → {h.tierChange.to}</Text>
                  )}
                </View>
              ))}
            </View>
          </>
        )}
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

  heroCard: {
    marginHorizontal: 16, marginTop: 16, padding: 24,
    borderRadius: 16, alignItems: 'center',
  },
  score: { color: '#FFF', fontSize: 72, fontWeight: '900', letterSpacing: -2 },
  tier: { fontSize: 16, fontWeight: '900', letterSpacing: 2, marginTop: 4 },
  updated: { color: '#71717A', fontSize: 11, marginTop: 12 },
  floorPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#7f1d1d', paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, marginTop: 12,
  },
  floorText: { color: '#fecaca', fontSize: 11, fontWeight: '700' },

  section: {
    color: '#71717A', fontSize: 11, fontWeight: '900', letterSpacing: 1.5,
    marginTop: 24, marginHorizontal: 16, marginBottom: 8,
  },

  metricsList: { marginHorizontal: 16, gap: 12 },
  metricRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  metricLabel: { color: '#A1A1AA', fontSize: 13, marginBottom: 6 },
  bar: { height: 6, backgroundColor: '#1f1f22', borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
  metricValue: { fontSize: 16, fontWeight: '900', width: 40, textAlign: 'right' },

  coachList: { marginHorizontal: 16, gap: 8 },
  coachRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    padding: 12, borderWidth: 1, borderRadius: 10, backgroundColor: '#0F0F10',
  },
  coachText: { color: '#E4E4E7', fontSize: 13, flex: 1, lineHeight: 18 },

  histRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#161616',
  },
  histDate: { color: '#71717A', fontSize: 11, flex: 1 },
  histScore: { color: '#FFF', fontWeight: '900', fontSize: 14, width: 32, textAlign: 'right' },
  histTier: { fontSize: 11, fontWeight: '900', width: 60, textAlign: 'right' },
  histDelta: { color: '#FFB020', fontSize: 10, fontWeight: '700' },
});

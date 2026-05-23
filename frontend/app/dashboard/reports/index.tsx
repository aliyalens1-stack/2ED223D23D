/**
 * Sprint 4 — Customer reports list (mobile).
 * GET /api/customer/reports
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const API = (Constants.expoConfig as any)?.extra?.apiUrl
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || 'http://localhost:8001';

interface Report {
  id: string; jobId: string; requestId: string;
  city: string; brand: string; model: string;
  score: number; verdict: string; status: string;
  createdAt: string;
}

const VERDICT_COLORS: Record<string, string> = {
  recommended: '#22C55E',
  risky: '#FFB020',
  not_recommended: '#EF4444',
};

const VERDICT_LABELS: Record<string, string> = {
  recommended: 'Recommended',
  risky: 'Risky',
  not_recommended: 'Don\'t buy',
};

export default function CustomerReportsScreen() {
  const router = useRouter();
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const t = await AsyncStorage.getItem('auth_token');
      if (!t) {
        router.replace('/login');
        return;
      }
      const res = await fetch(`${API}/api/customer/reports`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      setReports(data.reports || []);
    } catch (e: any) {
      setError(e?.message || 'failed');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={styles.safe} testID="customer-reports-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="reports-back">
          <Ionicons name="chevron-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My reports</Text>
        <TouchableOpacity onPress={() => { setRefreshing(true); load(); }} testID="reports-refresh">
          <Ionicons name="refresh" size={22} color="#FFF" />
        </TouchableOpacity>
      </View>

      {loading && <ActivityIndicator style={{ marginTop: 40 }} color="#FFB020" />}
      {error && <Text style={styles.errorText}>{error}</Text>}

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#FFB020" />}
      >
        <Text style={styles.kicker}>/ INSPECTION REPORTS · {reports.length} /</Text>
        <Text style={styles.title}>Inspector decisions</Text>
        <Text style={styles.subtitle}>Tap a card for the full checklist + summary.</Text>

        {!loading && reports.length === 0 && (
          <View style={styles.emptyBox}>
            <Ionicons name="document-text-outline" size={28} color="#A1A1AA" />
            <Text style={styles.emptyTitle}>No reports yet</Text>
            <Text style={styles.emptySub}>Reports appear after the inspector submits.</Text>
          </View>
        )}

        {reports.map((r) => {
          const color = VERDICT_COLORS[r.verdict] || '#A1A1AA';
          return (
            <TouchableOpacity
              key={r.id}
              style={styles.card}
              activeOpacity={0.7}
              onPress={() => router.push({ pathname: '/dashboard/reports/[id]', params: { id: r.id } })}
              testID={`customer-report-${r.id}`}
            >
              <View style={styles.cardHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{r.brand} {r.model}</Text>
                  <Text style={styles.cardSub}>
                    <Ionicons name="location-outline" size={12} color="#A1A1AA" /> {r.city}  ·  {new Date(r.createdAt).toLocaleDateString('de-DE')}
                  </Text>
                </View>
                <View style={styles.scoreBubble}>
                  <Text style={styles.scoreNum}>{r.score.toFixed(1)}</Text>
                  <Text style={styles.scoreOf}>/10</Text>
                </View>
              </View>
              <View style={[styles.verdictRow, { borderColor: color }]}>
                <View style={[styles.verdictDot, { backgroundColor: color }]} />
                <Text style={[styles.verdictText, { color }]}>{VERDICT_LABELS[r.verdict] || r.verdict}</Text>
                <Text style={styles.viewArrow}>view →</Text>
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
  body: { padding: 18, paddingBottom: 60 },
  kicker: { fontSize: 11, fontWeight: '800', color: '#FFB020', letterSpacing: 2 },
  title: { fontSize: 28, fontWeight: '900', color: '#FFF', marginTop: 6 },
  subtitle: { fontSize: 13, color: '#A1A1AA', marginTop: 6, marginBottom: 24 },
  emptyBox: { alignItems: 'center', padding: 40, borderWidth: 1, borderColor: '#2E2E2E', borderRadius: 12, borderStyle: 'dashed' },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: '#FFF', marginTop: 10 },
  emptySub: { fontSize: 13, color: '#A1A1AA', marginTop: 3, textAlign: 'center' },
  card: { borderWidth: 1, borderColor: '#2E2E2E', borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 16, marginBottom: 10, backgroundColor: '#0d0d0d' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: '#FFF' },
  cardSub: { fontSize: 12, color: '#A1A1AA', marginTop: 4 },
  scoreBubble: { borderWidth: 1, borderColor: '#FFB020', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, flexDirection: 'row', alignItems: 'baseline', gap: 2 },
  scoreNum: { fontSize: 18, fontWeight: '900', color: '#FFB020' },
  scoreOf: { fontSize: 10, color: '#A1A1AA', fontWeight: '700' },
  verdictRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#2E2E2E' },
  verdictDot: { width: 8, height: 8, borderRadius: 4 },
  verdictText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', flex: 1 },
  viewArrow: { fontSize: 11, fontWeight: '700', color: '#FFB020', textTransform: 'uppercase', letterSpacing: 0.5 },
  errorText: { marginTop: 40, textAlign: 'center', color: '#EF4444', fontWeight: '700' },
});

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  RefreshControl, ActivityIndicator, Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { zonesAPI } from '../../src/services/api';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

const { width } = Dimensions.get('window');

const STATUS_CONFIG: Record<string, { color: string; bg: string; icon: string; label: string }> = {
  BALANCED: { color: colors.success, bg: 'rgba(34,197,94,0.15)', icon: 'checkmark-circle', label: 'Сбалансировано' },
  BUSY: { color: colors.warning, bg: 'rgba(245,158,11,0.15)', icon: 'time', label: 'Загружено' },
  SURGE: { color: colors.warning, bg: 'rgba(249,115,22,0.15)', icon: 'flame', label: 'Surge' },
  CRITICAL: { color: colors.brand, bg: 'rgba(239,68,68,0.15)', icon: 'warning', label: 'Критично' },
};

export default function ZoneDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, isDark } = useThemeContext();
  const [zone, setZone] = useState<any>(null);
  const [analytics, setAnalytics] = useState<any>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    if (!id) return;
    try {
      const [analyticsResp, providersResp] = await Promise.all([
        zonesAPI.getAnalytics(id, 24),
        zonesAPI.getZoneProviderLocations(id),
      ]);
      setZone(analyticsResp.data.zone);
      setAnalytics(analyticsResp.data);
      setProviders(providersResp.data.providers || []);
    } catch (e) {
      console.error('Zone detail fetch error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!zone) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.textSecondary }}>Зона не найдена</Text>
      </View>
    );
  }

  const cfg = STATUS_CONFIG[zone.status] || STATUS_CONFIG.BALANCED;
  const stats = analytics?.stats || {};
  const timeline = analytics?.timeline || [];

  // Simple timeline visualization
  const maxDemand = Math.max(...timeline.map((t: any) => t.demand || 0), 1);
  const maxSupply = Math.max(...timeline.map((t: any) => t.supply || 0), 1);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <TouchableOpacity testID="zone-detail-back" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{zone.name}</Text>
        <View style={[styles.statusBadge, { backgroundColor: cfg.bg }]}>
          <Ionicons name={cfg.icon as any} size={14} color={cfg.color} />
          <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
        </View>
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchData(); }} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Main Stats */}
        <View style={[styles.mainCard, { backgroundColor: colors.card }]}>
          <View style={styles.mainStats}>
            <StatBlock label="Спрос" value={zone.demandScore} icon="flash" color={colors.warning} colors={colors} />
            <View style={[styles.divider, { backgroundColor: colors.divider }]} />
            <StatBlock label="Мастера" value={zone.supplyScore} icon="people" color={colors.success} colors={colors} />
            <View style={[styles.divider, { backgroundColor: colors.divider }]} />
            <StatBlock label="Ratio" value={zone.ratio} icon="analytics" color={zone.ratio > 2 ? colors.brand : colors.brand} colors={colors} />
          </View>

          {zone.surgeMultiplier > 1 && (
            <View style={[styles.surgeBar, { backgroundColor: 'rgba(249,115,22,0.12)' }]}>
              <Ionicons name="flame" size={18} color={colors.warning} />
              <Text style={styles.surgeBarText}>Surge x{zone.surgeMultiplier}</Text>
              <Text style={styles.surgeBarDesc}>Повышенный спрос — цены выше</Text>
            </View>
          )}
        </View>

        {/* Performance Metrics */}
        <View style={[styles.metricsCard, { backgroundColor: colors.card }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Метрики</Text>
          <View style={styles.metricsGrid}>
            <MetricRow icon="time-outline" label="Средний ETA" value={`${zone.avgEta} мин`} colors={colors} />
            <MetricRow icon="checkmark-done-outline" label="Match Rate" value={`${zone.matchRate}%`} colors={colors} />
            <MetricRow icon="radio-button-on" label="Онлайн мастеров" value={String(providers.length)} colors={colors} />
            <MetricRow icon="trending-up-outline" label="Средний Ratio (24ч)" value={String(stats.avgRatio || '—')} colors={colors} />
            <MetricRow icon="flame-outline" label="Макс Surge (24ч)" value={`x${stats.maxSurge || '—'}`} colors={colors} />
            <MetricRow icon="flash-outline" label="Demand Events (24ч)" value={String(stats.totalDemandEvents || 0)} colors={colors} />
          </View>
        </View>

        {/* Timeline Chart (simplified) */}
        {timeline.length > 0 && (
          <View style={[styles.chartCard, { backgroundColor: colors.card }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Timeline (24ч)</Text>
            <View style={styles.chartContainer}>
              <View style={styles.chartLegend}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: colors.warning }]} />
                  <Text style={[styles.legendText, { color: colors.textSecondary }]}>Спрос</Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: colors.success }]} />
                  <Text style={[styles.legendText, { color: colors.textSecondary }]}>Мастера</Text>
                </View>
              </View>
              <View style={styles.barChart}>
                {timeline.slice(-24).map((point: any, i: number) => (
                  <View key={i} style={styles.barGroup}>
                    <View style={[styles.bar, { height: Math.max(4, (point.demand / maxDemand) * 60), backgroundColor: colors.warning }]} />
                    <View style={[styles.bar, { height: Math.max(4, (point.supply / maxSupply) * 60), backgroundColor: colors.success }]} />
                  </View>
                ))}
              </View>
            </View>
          </View>
        )}

        {/* Online Providers */}
        <View style={[styles.providersCard, { backgroundColor: colors.card }]}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Мастера в зоне ({providers.length})</Text>
          {providers.length === 0 ? (
            <Text style={[styles.emptyText, { color: colors.textMuted }]}>Нет мастеров в зоне</Text>
          ) : (
            providers.slice(0, 10).map((p: any, i: number) => (
              <View key={i} style={[styles.providerRow, { borderBottomColor: colors.divider }]}>
                <View style={[styles.onlineDot, { backgroundColor: p.isOnline ? colors.success : colors.brand }]} />
                <Text style={[styles.providerName, { color: colors.text }]}>{p.providerId}</Text>
                <Text style={[styles.providerZone, { color: colors.textSecondary }]}>{p.isOnline ? 'Онлайн' : 'Оффлайн'}</Text>
              </View>
            ))
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function StatBlock({ label, value, icon, color, colors }: any) {
  return (
    <View style={styles.statBlock}>
      <Ionicons name={icon} size={22} color={color} />
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

function MetricRow({ icon, label, value, colors }: any) {
  return (
    <View style={styles.metricRow}>
      <Ionicons name={icon} size={18} color={colors.textMuted} />
      <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: colors.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  backBtn: { padding: 4 },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '700' },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  statusText: { fontSize: 12, fontWeight: '600' },
  scrollContent: { paddingHorizontal: 16 },
  mainCard: { borderRadius: 16, padding: 16, marginBottom: 12 },
  mainStats: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
  divider: { width: 1, height: 50 },
  statBlock: { alignItems: 'center', gap: 4 },
  statValue: { fontSize: 22, fontWeight: '700' },
  statLabel: { fontSize: 11 },
  surgeBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 10, borderRadius: 10 },
  surgeBarText: { fontSize: 15, fontWeight: '700', color: colors.warning },
  surgeBarDesc: { flex: 1, fontSize: 12, color: colors.warning, textAlign: 'right' },
  metricsCard: { borderRadius: 16, padding: 16, marginBottom: 12 },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  metricsGrid: { gap: 8 },
  metricRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  metricLabel: { flex: 1, fontSize: 13 },
  metricValue: { fontSize: 14, fontWeight: '600' },
  chartCard: { borderRadius: 16, padding: 16, marginBottom: 12 },
  chartContainer: {},
  chartLegend: { flexDirection: 'row', gap: 16, marginBottom: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11 },
  barChart: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', height: 70, gap: 2 },
  barGroup: { flexDirection: 'row', gap: 1, alignItems: 'flex-end' },
  bar: { width: Math.max(3, (width - 80) / 48 - 2), borderRadius: 2 },
  providersCard: { borderRadius: 16, padding: 16, marginBottom: 12 },
  emptyText: { fontSize: 13, textAlign: 'center', paddingVertical: 16 },
  providerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1 },
  onlineDot: { width: 8, height: 8, borderRadius: 4 },
  providerName: { flex: 1, fontSize: 13, fontWeight: '500' },
  providerZone: { fontSize: 12 },
});

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  RefreshControl, ActivityIndicator, Dimensions, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../src/context/ThemeContext';
import { zonesAPI } from '../src/services/api';
import { theme } from '../src/context/ThemeContext';
const colors = theme.colors;

const { width } = Dimensions.get('window');

const STATUS_CONFIG: Record<string, { color: string; bg: string; icon: string; label: string }> = {
  BALANCED: { color: colors.success, bg: 'rgba(34,197,94,0.15)', icon: 'checkmark-circle', label: 'Сбалансировано' },
  BUSY: { color: colors.warning, bg: 'rgba(245,158,11,0.15)', icon: 'time', label: 'Загружено' },
  SURGE: { color: colors.warning, bg: 'rgba(249,115,22,0.15)', icon: 'flame', label: 'Surge' },
  CRITICAL: { color: colors.brand, bg: 'rgba(239,68,68,0.15)', icon: 'warning', label: 'Критично' },
};

interface Zone {
  id: string;
  name: string;
  status: string;
  demandScore: number;
  supplyScore: number;
  ratio: number;
  surgeMultiplier: number;
  avgEta: number;
  matchRate: number;
  color: string;
  onlineProviders?: number;
  totalProviders?: number;
}

interface ZoneLiveState {
  zones: Zone[];
  summary: {
    totalZones: number;
    totalDemand: number;
    totalSupply: number;
    avgRatio: number;
    byStatus: Record<string, number>;
  };
  alerts: Array<{ zoneId: string; name: string; status: string; message: string }>;
}

export default function ZonesScreen() {
  const router = useRouter();
  const { colors, isDark } = useThemeContext();
  const [data, setData] = useState<ZoneLiveState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const resp = await zonesAPI.getLiveState();
      setData(resp.data);
    } catch (e) {
      console.error('Failed to fetch zones:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh every 10s
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Загрузка зон...</Text>
      </View>
    );
  }

  const summary = data?.summary;
  const zones = data?.zones || [];
  const alerts = data?.alerts || [];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity testID="zones-back-btn" onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Зоны города</Text>
          <View style={[styles.liveBadge, { backgroundColor: autoRefresh ? colors.successBg : colors.errorBg }]}>
            <View style={[styles.liveDot, { backgroundColor: autoRefresh ? colors.success : colors.error }]} />
            <Text style={[styles.liveText, { color: autoRefresh ? colors.success : colors.error }]}>
              {autoRefresh ? 'LIVE' : 'PAUSED'}
            </Text>
          </View>
        </View>
        <TouchableOpacity testID="zones-toggle-refresh" onPress={() => setAutoRefresh(!autoRefresh)} style={styles.toggleBtn}>
          <Ionicons name={autoRefresh ? 'pause' : 'play'} size={20} color={colors.primary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Summary Cards */}
        {summary && (
          <View style={styles.summaryRow}>
            <SummaryCard icon="flash" label="Спрос" value={String(summary.totalDemand)} color={colors.warning} colors={colors} />
            <SummaryCard icon="people" label="Мастера" value={String(summary.totalSupply)} color={colors.success} colors={colors} />
            <SummaryCard icon="analytics" label="Ratio" value={String(summary.avgRatio)} color={summary.avgRatio > 2 ? colors.brand : colors.brand} colors={colors} />
          </View>
        )}

        {/* Status Distribution */}
        {summary && (
          <View style={[styles.statusBar, { backgroundColor: colors.card }]}>
            {Object.entries(summary.byStatus).map(([status, count]) => {
              const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.BALANCED;
              const pct = Math.round((count / Math.max(summary.totalZones, 1)) * 100);
              return (
                <View key={status} style={[styles.statusSegment, { width: `${Math.max(pct, 15)}%` as any, backgroundColor: cfg.bg }]}>
                  <Ionicons name={cfg.icon as any} size={14} color={cfg.color} />
                  <Text style={[styles.statusCount, { color: cfg.color }]}>{count}</Text>
                </View>
              );
            })}
          </View>
        )}

        {/* Alerts */}
        {alerts.length > 0 && (
          <View style={styles.alertsSection}>
            {alerts.map((alert, i) => (
              <TouchableOpacity
                key={i}
                testID={`zone-alert-${alert.zoneId}`}
                style={[styles.alertCard, { backgroundColor: colors.errorBg, borderColor: colors.error }]}
                onPress={() => router.push(`/zones/${alert.zoneId}` as any)}
              >
                <Ionicons name="warning" size={18} color={colors.error} />
                <Text style={[styles.alertText, { color: colors.error }]} numberOfLines={1}>{alert.message}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.error} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Zone Cards */}
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Все зоны ({zones.length})</Text>
        {zones.map((zone) => (
          <ZoneCard key={zone.id} zone={zone} colors={colors} isDark={isDark} onPress={() => router.push(`/zones/${zone.id}` as any)} />
        ))}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryCard({ icon, label, value, color, colors }: any) {
  return (
    <View style={[styles.summaryCard, { backgroundColor: colors.card }]}>
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[styles.summaryValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

function ZoneCard({ zone, colors, isDark, onPress }: { zone: Zone; colors: any; isDark: boolean; onPress: () => void }) {
  const cfg = STATUS_CONFIG[zone.status] || STATUS_CONFIG.BALANCED;
  
  return (
    <TouchableOpacity
      testID={`zone-card-${zone.id}`}
      style={[styles.zoneCard, { backgroundColor: colors.card, borderLeftColor: cfg.color }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.zoneHeader}>
        <View style={styles.zoneNameRow}>
          <Text style={[styles.zoneName, { color: colors.text }]}>{zone.name}</Text>
          <View style={[styles.statusBadge, { backgroundColor: cfg.bg }]}>
            <Ionicons name={cfg.icon as any} size={12} color={cfg.color} />
            <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
        </View>
        {zone.surgeMultiplier > 1 && (
          <View style={[styles.surgeBadge, { backgroundColor: 'rgba(249,115,22,0.15)' }]}>
            <Ionicons name="flame" size={12} color={colors.warning} />
            <Text style={styles.surgeText}>x{zone.surgeMultiplier}</Text>
          </View>
        )}
      </View>

      <View style={styles.zoneMetrics}>
        <MetricItem icon="flash-outline" label="Спрос" value={String(zone.demandScore)} color={colors} />
        <MetricItem icon="people-outline" label="Мастера" value={String(zone.supplyScore)} color={colors} />
        <MetricItem icon="analytics-outline" label="Ratio" value={String(zone.ratio)} color={colors} highlight={zone.ratio > 2} />
        <MetricItem icon="time-outline" label="ETA" value={`${zone.avgEta}м`} color={colors} />
      </View>

      {zone.onlineProviders !== undefined && (
        <View style={[styles.onlineBar, { backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)' }]}>
          <Ionicons name="radio-button-on" size={10} color={colors.success} />
          <Text style={[styles.onlineText, { color: colors.textSecondary }]}>
            {zone.onlineProviders} онлайн из {zone.totalProviders}
          </Text>
          <View style={styles.onlineBarTrack}>
            <View style={[styles.onlineBarFill, { width: `${Math.min(100, (zone.onlineProviders / Math.max(zone.totalProviders || 1, 1)) * 100)}%`, backgroundColor: colors.success }]} />
          </View>
        </View>
      )}
    </TouchableOpacity>
  );
}

function MetricItem({ icon, label, value, color, highlight }: any) {
  return (
    <View style={styles.metricItem}>
      <Ionicons name={icon} size={16} color={highlight ? colors.brand : color.textMuted} />
      <Text style={[styles.metricValue, { color: highlight ? colors.brand : color.text }]}>{value}</Text>
      <Text style={[styles.metricLabel, { color: color.textMuted }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { fontSize: 14 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  backBtn: { padding: 4 },
  headerCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerTitle: { fontSize: 20, fontWeight: '700' },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  liveText: { fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  toggleBtn: { padding: 8 },
  scrollContent: { paddingHorizontal: 16 },
  summaryRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  summaryCard: { flex: 1, borderRadius: 12, padding: 12, alignItems: 'center', gap: 4 },
  summaryValue: { fontSize: 20, fontWeight: '700' },
  summaryLabel: { fontSize: 11, fontWeight: '500' },
  statusBar: { flexDirection: 'row', borderRadius: 10, overflow: 'hidden', marginBottom: 12, height: 36 },
  statusSegment: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  statusCount: { fontSize: 13, fontWeight: '700' },
  alertsSection: { gap: 8, marginBottom: 12 },
  alertCard: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 10, borderLeftWidth: 3 },
  alertText: { flex: 1, fontSize: 13, fontWeight: '500' },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  zoneCard: { borderRadius: 14, padding: 14, marginBottom: 10, borderLeftWidth: 4 },
  zoneHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  zoneNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  zoneName: { fontSize: 16, fontWeight: '600' },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  statusText: { fontSize: 11, fontWeight: '600' },
  surgeBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  surgeText: { fontSize: 12, fontWeight: '700', color: colors.warning },
  zoneMetrics: { flexDirection: 'row', justifyContent: 'space-between' },
  metricItem: { alignItems: 'center', gap: 2 },
  metricValue: { fontSize: 15, fontWeight: '600' },
  metricLabel: { fontSize: 10 },
  onlineBar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, padding: 8, borderRadius: 8 },
  onlineText: { fontSize: 11 },
  onlineBarTrack: { flex: 1, height: 4, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 2 },
  onlineBarFill: { height: 4, borderRadius: 2 },
});

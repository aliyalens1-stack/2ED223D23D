/**
 * Sprint 26 — Provider Performance screen.
 * 4 ключевые метрики + score + tips. Тёмная тема, жёлтый акцент.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import { theme } from '../../src/context/ThemeContext';
import i18n from '../../src/i18n';
const colors = theme.colors;

type Perf = {
  score: number;
  multiplier: number;
  metrics: {
    received: number;
    accepted: number;
    cancelled: number;
    completed: number;
    acceptanceRate: number;
    completionRate: number;
    cancelRate: number;
    avgResponseTime: number;
    responseScore: number;
  };
  penalties: string[];
  tips: string[];
  headline: string;
  providerSlug: string;
};

export default function PerformanceScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const [data, setData] = useState<Perf | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/provider/performance/me');
      setData(r.data);
    } catch (e) {
      console.log('perf load err', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  const m = data.metrics;
  const acceptPct = Math.round(m.acceptanceRate * 100);
  const completePct = Math.round(m.completionRate * 100);
  const cancelPct = Math.round(m.cancelRate * 100);
  const respText = m.avgResponseTime > 0 ? i18n.t('provider.m_avgresponsetime_s') : '—';
  const multStr = `×${data.multiplier.toFixed(2)}`;
  const tier = data.multiplier >= 1.15 ? 'TOP' : data.multiplier >= 1.0 ? 'GOOD' : data.multiplier >= 0.8 ? 'AVERAGE' : 'LOW';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="perf-back-btn"
          onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); }}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('provider.proizvoditelnost')}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        {/* Headline */}
        <View style={styles.headlineCard} testID="perf-headline">
          <View style={styles.headlineIcon}>
            <Ionicons name="speedometer" size={22} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.headlineLabel}>{tier} · multiplier {multStr}</Text>
            <Text style={styles.headlineText}>{data.headline}</Text>
          </View>
        </View>

        {/* 4 metrics */}
        <View style={styles.grid}>
          <Metric colors={colors} label={t('provider.prinyatie')} value={`${acceptPct}%`} icon="checkmark-circle" testID="perf-acceptance" />
          <Metric colors={colors} label={t('provider.zavershenie')} value={`${completePct}%`} icon="trophy" testID="perf-completion" />
          <Metric colors={colors} label={t('provider.otkazy')} value={`${cancelPct}%`} icon="close-circle" testID="perf-cancel" tone={cancelPct > 30 ? 'bad' : 'normal'} />
          <Metric colors={colors} label={t('provider.otvet')} value={respText} icon="flash" testID="perf-response" tone={m.avgResponseTime > 20 ? 'bad' : 'normal'} />
        </View>

        {/* Counters */}
        <View style={styles.counters}>
          <Counter colors={colors} label={t('provider.polucheno')} value={m.received} />
          <Counter colors={colors} label={t('inspector.prinyato')} value={m.accepted} />
          <Counter colors={colors} label={t('inspector.zaversheno')} value={m.completed} />
          <Counter colors={colors} label={t('inspector.otmeneno')} value={m.cancelled} />
        </View>

        {/* Penalties */}
        {data.penalties.length > 0 && (
          <View style={styles.warningCard} testID="perf-penalties">
            <Ionicons name="warning" size={18} color={colors.error} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.warningTitle}>{t('provider.snizhayut_rejting')}</Text>
              {data.penalties.map((p, i) => (
                <Text key={i} style={styles.warningItem}>• {penaltyLabel(p)}</Text>
              ))}
            </View>
          </View>
        )}

        {/* Tips */}
        <Text style={styles.section}>{t('provider.kak_uluchshit')}</Text>
        {data.tips.map((t, i) => (
          <View key={i} style={styles.tipCard} testID={`perf-tip-${i}`}>
            <Text style={styles.tipText}>{t}</Text>
          </View>
        ))}

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Metric({ colors, label, value, icon, testID, tone }: any) {
  const styles = makeStyles(colors);
  const valColor = tone === 'bad' ? colors.error : colors.text;
  return (
    <View style={styles.metricCard} testID={testID}>
      <View style={styles.metricIconWrap}>
        <Ionicons name={icon} size={18} color={colors.primary} />
      </View>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { color: valColor }]}>{value}</Text>
    </View>
  );
}

function Counter({ colors, label, value }: any) {
  const styles = makeStyles(colors);
  return (
    <View style={styles.counter}>
      <Text style={styles.counterValue}>{value}</Text>
      <Text style={styles.counterLabel}>{label}</Text>
    </View>
  );
}

function penaltyLabel(code: string) {
  switch (code) {
    case 'low_acceptance': return t('provider.slishkom_mnogo_ignoriruete_zayavok');
    case 'high_cancellation': return t('provider.chasto_otmenyaete_prinyatye_zakazy');
    case 'slow_response': return t('provider.dolgo_otvechaete_na_zayavki');
    default: return code;
  }
}

const makeStyles = (c: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backButton: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: c.card, alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 18, fontWeight: '700', color: c.text },
  content: { padding: 16 },

  // Headline
  headlineCard: {
    flexDirection: 'row', alignItems: 'center',
    padding: 14, borderRadius: 14,
    backgroundColor: c.card, borderWidth: 1, borderColor: c.border,
  },
  headlineIcon: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: c.brandSoft,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  headlineLabel: { fontSize: 11, color: c.primary, fontWeight: '800', letterSpacing: 1 },
  headlineText: { fontSize: 14, color: c.text, marginTop: 2, fontWeight: '600' },

  // Grid
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 16, gap: 8 },
  metricCard: {
    width: '48%',
    padding: 14,
    borderRadius: 14,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
  },
  metricIconWrap: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: c.brandSoft,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 8,
  },
  metricLabel: { fontSize: 12, color: c.textMuted, fontWeight: '600' },
  metricValue: { fontSize: 22, fontWeight: '800', marginTop: 4 },

  // Counters
  counters: {
    flexDirection: 'row',
    marginTop: 16,
    backgroundColor: c.card,
    borderRadius: 14,
    borderWidth: 1, borderColor: c.border,
    paddingVertical: 14,
  },
  counter: { flex: 1, alignItems: 'center' },
  counterValue: { fontSize: 18, fontWeight: '800', color: c.text },
  counterLabel: { fontSize: 11, color: c.textMuted, marginTop: 2 },

  // Warning
  warningCard: {
    flexDirection: 'row',
    backgroundColor: c.card,
    borderWidth: 1, borderColor: c.error + '40',
    padding: 14, borderRadius: 14,
    marginTop: 16,
  },
  warningTitle: { fontSize: 13, fontWeight: '700', color: c.text, marginBottom: 4 },
  warningItem: { fontSize: 13, color: c.textMuted, marginTop: 2 },

  // Section + tips
  section: {
    fontSize: 13, fontWeight: '700', color: c.textSecondary,
    marginTop: 20, marginBottom: 10, letterSpacing: 0.4, textTransform: 'uppercase',
  },
  tipCard: {
    backgroundColor: c.card,
    borderWidth: 1, borderColor: c.border,
    borderRadius: 12,
    padding: 14, marginBottom: 8,
  },
  tipText: { fontSize: 14, color: c.text, lineHeight: 20 },
});

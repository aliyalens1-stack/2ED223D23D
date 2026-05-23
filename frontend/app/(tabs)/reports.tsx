// Platform Cutover: Reports tab — list of inspection reports.
// Reports = the deliverable customers pay for.
import React, { useCallback, useState } from 'react';
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
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import i18n from '../../src/i18n';

type Report = {
  id: string;
  requestId?: string;
  carTitle?: string;
  brand?: string;
  model?: string;
  year?: number;
  score?: number;
  riskLevel?: 'low' | 'medium' | 'high' | string;
  verdict?: string;
  status?: string;
  createdAt?: string;
};

const RISK_COLOR: Record<string, string> = {
  low: '#10B981',
  medium: '#F59E0B',
  high: '#EF4444',
};

export default function ReportsTab() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t, i18n } = useTranslation();

  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/customer/reports');
      const list = res.data?.items ?? res.data ?? [];
      setReports(Array.isArray(list) ? list : []);
    } catch {
      setReports([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const scoreColor = (score?: number) => {
    if (score === undefined) return colors.textSecondary;
    if (score >= 8) return '#10B981';
    if (score >= 6) return '#F59E0B';
    return '#EF4444';
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]} testID="reports-title">
            {t('reports_tab.title')}
          </Text>
          <Text style={[styles.headerSub, { color: colors.textSecondary }]} testID="reports-count">
            {reports.length}
          </Text>
        </View>

        <ScrollView
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        >
          {loading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : reports.length === 0 ? (
            <View
              style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]}
              testID="reports-empty"
            >
              <Ionicons name="clipboard-outline" size={40} color={colors.textSecondary} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('reports_tab.empty_title')}</Text>
              <Text style={[styles.emptySub, { color: colors.textSecondary }]}>
                {t('reports_tab.empty_sub')}
              </Text>
              <TouchableOpacity
                testID="reports-empty-cta"
                style={[styles.emptyBtn, { backgroundColor: colors.primary }]}
                onPress={() => router.push('/auto-request/create')}
              >
                <Text style={styles.emptyBtnText}>{t('reports_tab.empty_cta')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            reports.map((rep) => {
              const riskKey = rep.riskLevel ?? '';
              const riskColor = RISK_COLOR[riskKey];
              const riskLabel = riskColor ? i18n.t(`reports_tab.risk_${riskKey}`) : null;
              const carTitle =
                rep.carTitle ||
                [rep.brand, rep.model, rep.year].filter(Boolean).join(' ') ||
                i18n.t('reports_tab.fallback_title');
              const verdict = rep.verdict
                ? i18n.t(`reports_tab.verdict_${rep.verdict}`, { defaultValue: rep.verdict })
                : null;
              return (
                <TouchableOpacity
                  key={rep.id}
                  testID={`reports-item-${rep.id}`}
                  activeOpacity={0.85}
                  style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={() =>
                    router.push({ pathname: '/dashboard/reports/[id]', params: { id: rep.id } } as any)
                  }
                >
                  <View style={styles.cardTop}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
                        {carTitle}
                      </Text>
                      {verdict && (
                        <Text style={[styles.verdict, { color: colors.textSecondary }]}>{verdict}</Text>
                      )}
                    </View>
                    {rep.score !== undefined && (
                      <View style={[styles.scoreBox, { borderColor: scoreColor(rep.score) }]}>
                        <Text style={[styles.scoreValue, { color: scoreColor(rep.score) }]}>
                          {rep.score.toFixed(1)}
                        </Text>
                        <Text style={[styles.scoreLabel, { color: colors.textSecondary }]}>/ 10</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.cardFooter}>
                    {riskLabel && (
                      <View style={[styles.riskPill, { backgroundColor: `${riskColor}20` }]}>
                        <View style={[styles.riskDot, { backgroundColor: riskColor }]} />
                        <Text style={[styles.riskText, { color: riskColor }]}>{riskLabel}</Text>
                      </View>
                    )}
                    {rep.createdAt && (
                      <Text style={[styles.date, { color: colors.textSecondary }]}>
                        {new Date(rep.createdAt).toLocaleDateString(i18n.language, {
                          day: '2-digit',
                          month: 'short',
                        })}
                      </Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.3 },
  headerSub: { fontSize: 14 },
  listContent: { paddingHorizontal: 16, paddingBottom: 96, paddingTop: 8 },
  empty: {
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
    borderWidth: 1,
    marginTop: 24,
  },
  emptyTitle: { fontSize: 16, fontWeight: '700', marginTop: 12 },
  emptySub: { fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  emptyBtn: {
    marginTop: 18,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
  },
  emptyBtnText: { color: '#FFF', fontSize: 14, fontWeight: '700' },
  card: {
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    marginBottom: 10,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 10,
  },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  verdict: { fontSize: 12, marginTop: 3 },
  scoreBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 2,
    minWidth: 56,
  },
  scoreValue: { fontSize: 16, fontWeight: '800' },
  scoreLabel: { fontSize: 9, marginTop: -2 },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
  },
  riskPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
    gap: 6,
  },
  riskDot: { width: 6, height: 6, borderRadius: 3 },
  riskText: { fontSize: 11, fontWeight: '600' },
  date: { fontSize: 11 },
});

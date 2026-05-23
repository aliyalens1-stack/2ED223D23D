import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, Dimensions, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import { theme } from '../../src/context/ThemeContext';
import { useTranslation } from 'react-i18next';
const colors = theme.colors;

const { width } = Dimensions.get('window');

const TIER_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  Bronze: { bg: '#CD7F3220', text: colors.warning, icon: 'shield' },
  Silver: { bg: '#C0C0C020', text: colors.textMuted, icon: 'shield-half' },
  Gold: { bg: '#FFD70020', text: colors.brand, icon: 'shield-checkmark' },
  Platinum: { bg: '#E5E4E220', text: colors.textSecondary, icon: 'diamond' },
};

export default function ProviderPressureScreen() {
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get('/provider/pressure-summary');
      const d = res.data;
      // Normalize data from both NestJS and fallback formats
      setData({
        score: d.behavioralScore || d.score || 50,
        tier: d.tier || 'Bronze',
        today: {
          accepted: d.acceptedToday || d.today?.accepted || 0,
          missed: d.missedToday || d.today?.missed || 0,
          avgResponseSeconds: d.avgResponseTime ? d.avgResponseTime * 60 : d.today?.avgResponseSeconds || 0,
          earnings: d.today?.earnings || 0,
        },
        week: d.week || { accepted: 0, missed: 0, totalEarnings: 0, surgeEarnings: 0 },
        lostRevenue: d.lostRevenueToday || d.lostRevenue || 0,
        tips: d.tips || [],
        missedRequests: d.missedRequests || [],
      });
    } catch (e) {
      console.log('Pressure fetch error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, []);

  const onRefresh = () => { setRefreshing(true); fetchData(); };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const tier = TIER_COLORS[data?.tier] || TIER_COLORS.Bronze;
  const score = data?.score || 0;
  const scoreColor = score >= 80 ? colors.success : score >= 60 ? colors.warning : colors.error;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity testID="back-btn" onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Performance</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {/* Score + Tier */}
          <View style={[styles.scoreCard, { backgroundColor: colors.card }]}>
            <View style={styles.scoreRow}>
              <View style={styles.scoreCircle}>
                <Text style={[styles.scoreValue, { color: scoreColor }]}>{score}</Text>
                <Text style={[styles.scoreLabel, { color: colors.textSecondary }]}>Score</Text>
              </View>
              <View style={[styles.tierBadge, { backgroundColor: tier.bg }]}>
                <Ionicons name={tier.icon as any} size={24} color={tier.text} />
                <Text style={[styles.tierText, { color: tier.text }]}>{data?.tier || 'Bronze'}</Text>
              </View>
            </View>
          </View>

          {/* Today Stats */}
          <View style={[styles.statsCard, { backgroundColor: colors.card }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('inspector.segodnya')}</Text>
            <View style={styles.statsGrid}>
              <View style={styles.statItem}>
                <Ionicons name="checkmark-circle" size={28} color={colors.success} />
                <Text style={[styles.statValue, { color: colors.text }]}>{data?.today?.accepted || 0}</Text>
                <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('inspector.prinyato')}</Text>
              </View>
              <View style={styles.statItem}>
                <Ionicons name="close-circle" size={28} color={colors.error} />
                <Text style={[styles.statValue, { color: colors.text }]}>{data?.today?.missed || 0}</Text>
                <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('provider.propuscheno')}</Text>
              </View>
              <View style={styles.statItem}>
                <Ionicons name="cash" size={28} color={colors.warning} />
                <Text style={[styles.statValue, { color: colors.text }]}>{data?.today?.earnings || 0}</Text>
                <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('provider.zarabotok')}</Text>
              </View>
            </View>
          </View>

          {/* Lost Revenue Alert */}
          {data?.lostRevenue > 0 && (
            <View testID="lost-revenue-alert" style={[styles.alertCard, { backgroundColor: '#EF444415', borderColor: '#EF444440' }]}>
              <Ionicons name="warning" size={24} color={colors.brand} />
              <View style={styles.alertContent}>
                <Text style={[styles.alertTitle, { color: colors.brand }]}>
                  Вы потеряли ~{data.lostRevenue} грн
                </Text>
                <Text style={[styles.alertSub, { color: colors.textSecondary }]}>
                  Пропущенные заявки = потерянные деньги
                </Text>
              </View>
            </View>
          )}

          {/* Missed Requests */}
          {data?.missedRequests?.length > 0 && (
            <View style={[styles.missedCard, { backgroundColor: colors.card }]}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('provider.propuschennye_zayavki')}</Text>
              {data.missedRequests.map((req: any, i: number) => (
                <View key={i} style={[styles.missedItem, i < data.missedRequests.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.border }]}>
                  <View style={styles.missedInfo}>
                    <Text style={[styles.missedService, { color: colors.text }]}>{req.service}</Text>
                    <Text style={[styles.missedTime, { color: colors.textMuted }]}>{req.timeAgo}</Text>
                  </View>
                  <Text style={[styles.missedPrice, { color: colors.error }]}>-{req.price} грн</Text>
                </View>
              ))}
            </View>
          )}

          {/* Tips */}
          {data?.tips?.length > 0 && (
            <View style={[styles.tipsCard, { backgroundColor: colors.card }]}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('provider.sovety')}</Text>
              {data.tips.map((tip: string, i: number) => (
                <View key={i} style={styles.tipItem}>
                  <Ionicons name="bulb" size={16} color={colors.warning} />
                  <Text style={[styles.tipText, { color: colors.textSecondary }]}>{tip}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Week Stats */}
          <View style={[styles.statsCard, { backgroundColor: colors.card }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('provider.za_nedelyu')}</Text>
            <View style={styles.weekRow}>
              <View style={styles.weekItem}>
                <Text style={[styles.weekValue, { color: colors.text }]}>{data?.week?.accepted || 0}</Text>
                <Text style={[styles.weekLabel, { color: colors.textSecondary }]}>{t('provider.zakazov')}</Text>
              </View>
              <View style={[styles.weekDivider, { backgroundColor: colors.border }]} />
              <View style={styles.weekItem}>
                <Text style={[styles.weekValue, { color: colors.text }]}>{data?.week?.totalEarnings || 0} грн</Text>
                <Text style={[styles.weekLabel, { color: colors.textSecondary }]}>{t('provider.dohod')}</Text>
              </View>
              <View style={[styles.weekDivider, { backgroundColor: colors.border }]} />
              <View style={styles.weekItem}>
                <Text style={[styles.weekValue, { color: colors.success }]}>{data?.week?.surgeEarnings || 0} грн</Text>
                <Text style={[styles.weekLabel, { color: colors.textSecondary }]}>{t('provider.surge_bonus')}</Text>
              </View>
            </View>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safe: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  backBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  scrollContent: { paddingHorizontal: 16, paddingTop: 8 },

  scoreCard: { borderRadius: 16, padding: 20, marginBottom: 16 },
  scoreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scoreCircle: { alignItems: 'center' },
  scoreValue: { fontSize: 48, fontWeight: '800' },
  scoreLabel: { fontSize: 14, marginTop: 2 },
  tierBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, gap: 8 },
  tierText: { fontSize: 18, fontWeight: '700' },

  statsCard: { borderRadius: 16, padding: 16, marginBottom: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginBottom: 14 },
  statsGrid: { flexDirection: 'row', justifyContent: 'space-around' },
  statItem: { alignItems: 'center', gap: 6 },
  statValue: { fontSize: 22, fontWeight: '700' },
  statLabel: { fontSize: 12 },

  alertCard: { flexDirection: 'row', alignItems: 'center', borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, gap: 12 },
  alertContent: { flex: 1 },
  alertTitle: { fontSize: 15, fontWeight: '700' },
  alertSub: { fontSize: 12, marginTop: 2 },

  missedCard: { borderRadius: 16, padding: 16, marginBottom: 16 },
  missedItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  missedInfo: { flex: 1 },
  missedService: { fontSize: 14, fontWeight: '600' },
  missedTime: { fontSize: 12, marginTop: 2 },
  missedPrice: { fontSize: 15, fontWeight: '700' },

  tipsCard: { borderRadius: 16, padding: 16, marginBottom: 16 },
  tipItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  tipText: { flex: 1, fontSize: 13, lineHeight: 18 },

  weekRow: { flexDirection: 'row', alignItems: 'center' },
  weekItem: { flex: 1, alignItems: 'center' },
  weekDivider: { width: 1, height: 40 },
  weekValue: { fontSize: 16, fontWeight: '700' },
  weekLabel: { fontSize: 11, marginTop: 4 },
});

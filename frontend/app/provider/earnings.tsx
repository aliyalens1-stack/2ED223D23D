import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import { theme } from '../../src/context/ThemeContext';
import { useTranslation } from 'react-i18next';
import i18n from '../../src/i18n';
const colors = theme.colors;

const { width } = Dimensions.get('window');

export default function ProviderEarningsScreen() {
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today');

  const fetchData = useCallback(async () => {
    try {
      const res = await api.get('/provider/earnings');
      setData(res.data);
    } catch (e) {
      console.log('Earnings fetch error:', e);
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

  const periodData = data?.[period] || { total: 0, orders: 0, surge: 0 };
  const periodLabels = { today: i18n.t('inspector.segodnya'), week: i18n.t('provider.za_nedelyu'), month: i18n.t('provider.za_mesyac') };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity testID="back-btn" onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('provider.dohod')}</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {/* Period Tabs */}
          <View style={[styles.tabs, { backgroundColor: colors.card }]}>
            {(['today', 'week', 'month'] as const).map((p) => (
              <TouchableOpacity
                key={p}
                testID={`period-${p}`}
                style={[styles.tab, period === p && { backgroundColor: colors.primary }]}
                onPress={() => setPeriod(p)}
              >
                <Text style={[styles.tabText, { color: period === p ? '#fff' : colors.textSecondary }]}>
                  {periodLabels[p]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Total Earnings */}
          <View style={[styles.totalCard, { backgroundColor: colors.card }]}>
            <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>{periodLabels[period]}</Text>
            <Text style={[styles.totalValue, { color: colors.success }]}>{periodData.total.toLocaleString()} грн</Text>
            <View style={styles.totalMeta}>
              <View style={styles.metaItem}>
                <Ionicons name="document-text" size={16} color={colors.primary} />
                <Text style={[styles.metaText, { color: colors.textSecondary }]}>{periodData.orders} заказов</Text>
              </View>
              <View style={styles.metaItem}>
                <Ionicons name="flame" size={16} color={colors.brand} />
                <Text style={[styles.metaText, { color: colors.textSecondary }]}>+{periodData.surge} грн surge</Text>
              </View>
            </View>
          </View>

          {/* Bonuses */}
          {data?.bonuses?.length > 0 && (
            <View style={[styles.bonusCard, { backgroundColor: colors.card }]}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('provider.bonusy')}</Text>
              {data.bonuses.map((bonus: any, i: number) => (
                <View key={i} style={[styles.bonusItem, i < data.bonuses.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.border }]}>
                  <View style={styles.bonusInfo}>
                    <Ionicons
                      name={bonus.earned ? 'checkmark-circle' : 'ellipse-outline'}
                      size={20}
                      color={bonus.earned ? colors.success : colors.textMuted}
                    />
                    <Text style={[styles.bonusName, { color: bonus.earned ? colors.text : colors.textMuted }]}>{bonus.name}</Text>
                  </View>
                  <Text style={[styles.bonusAmount, { color: bonus.earned ? colors.success : colors.textMuted }]}>
                    {bonus.earned ? '+' : ''}{bonus.amount} грн
                  </Text>
                </View>
              ))}
            </View>
          )}

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

  tabs: { flexDirection: 'row', borderRadius: 12, padding: 4, marginBottom: 16 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10 },
  tabText: { fontSize: 14, fontWeight: '600' },

  totalCard: { borderRadius: 16, padding: 24, marginBottom: 16, alignItems: 'center' },
  totalLabel: { fontSize: 14, marginBottom: 4 },
  totalValue: { fontSize: 42, fontWeight: '800' },
  totalMeta: { flexDirection: 'row', gap: 24, marginTop: 12 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { fontSize: 13 },

  bonusCard: { borderRadius: 16, padding: 16, marginBottom: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginBottom: 14 },
  bonusItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12 },
  bonusInfo: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bonusName: { fontSize: 14, fontWeight: '500' },
  bonusAmount: { fontSize: 15, fontWeight: '700' },
});

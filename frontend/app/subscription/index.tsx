/**
 * Sprint 3A — Provider Subscription & Billing screen.
 * Показывает тарифы Starter / Pro / Fleet, текущую подписку, фичи плана.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';

type Plan = {
  key: string;
  titleEn: string;
  titleRu: string;
  priceMonthly: number;
  currency: string;
  rankBoost: number;
  extraRadiusKm: number;
  features: string[];
};

const PLAN_ACCENT: Record<string, string> = {
  starter: '#3b82f6',
  pro: '#f59e0b',
  fleet: '#a855f7',
};

export default function SubscriptionScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [current, setCurrent] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [plansR, meR] = await Promise.all([
        api.get('/provider/subscriptions/plans'),
        api.get('/provider/subscriptions/me'),
      ]);
      setPlans(plansR.data?.plans || []);
      setCurrent(meR.data?.subscription || null);
    } catch (e: any) {
      Alert.alert('Ошибка', e?.response?.data?.message || e?.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSubscribe = async (planKey: string) => {
    setSubscribing(planKey);
    try {
      const r = await api.post('/provider/subscriptions/subscribe', { plan: planKey });
      const subId = r.data?.subscription?.id;
      if (!subId) throw new Error('No subscription id returned');
      // В mock-режиме сразу активируем через _mock-activate.
      // В prod пользователь пойдёт на checkoutUrl и Stripe webhook сделает активацию.
      Alert.alert(
        'Подписка создана',
        `Тариф ${planKey.toUpperCase()} ждёт оплаты. Эмулировать оплату сейчас?`,
        [
          { text: 'Позже', style: 'cancel', onPress: load },
          {
            text: 'Эмулировать оплату',
            onPress: async () => {
              try {
                await api.post(`/provider/subscriptions/${subId}/_mock-activate`, {});
                await load();
                Alert.alert('Готово', `Подписка ${planKey.toUpperCase()} активирована.`);
              } catch (e: any) {
                Alert.alert('Ошибка', e?.response?.data?.message || e?.message);
              }
            },
          },
        ],
      );
    } catch (e: any) {
      Alert.alert('Ошибка', e?.response?.data?.message || e?.message);
    } finally {
      setSubscribing(null);
    }
  };

  const handleCancel = () => {
    Alert.alert('Отменить подписку?', 'Доступ к фичам сохранится до конца оплаченного периода.', [
      { text: 'Назад', style: 'cancel' },
      {
        text: 'Отменить',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.post('/provider/subscriptions/cancel', {});
            await load();
          } catch (e: any) {
            Alert.alert('Ошибка', e?.response?.data?.message || e?.message);
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background, justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity testID="sub-back" onPress={() => router.back()} style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>Подписка</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
        {current?.status === 'active' && (
          <View style={[styles.activeBanner, { backgroundColor: '#22c55e22', borderColor: '#22c55e' }]}>
            <Ionicons name="checkmark-circle" size={18} color="#22c55e" />
            <View style={{ flex: 1 }}>
              <Text style={[styles.activeTitle, { color: colors.text }]}>
                Активен: {current.plan?.toUpperCase()}
              </Text>
              {current.currentPeriodEnd && (
                <Text style={[styles.activeDesc, { color: colors.textSecondary }]}>
                  До {new Date(current.currentPeriodEnd).toLocaleDateString()}
                </Text>
              )}
            </View>
            <TouchableOpacity onPress={handleCancel} testID="sub-cancel">
              <Text style={{ color: '#ef4444', fontWeight: '700', fontSize: 13 }}>Отменить</Text>
            </TouchableOpacity>
          </View>
        )}

        {current?.status === 'pending_payment' && (
          <View style={[styles.pendingBanner, { backgroundColor: '#f59e0b22', borderColor: '#f59e0b' }]}>
            <Ionicons name="time-outline" size={18} color="#f59e0b" />
            <Text style={[styles.activeTitle, { color: '#f59e0b', flex: 1 }]}>
              Ждём оплаты: {current.plan?.toUpperCase()}
            </Text>
          </View>
        )}

        <Text style={[styles.h1, { color: colors.text }]}>Выбери свой план</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Больше радиус, выше позиция в bids, доступ к analytics.
        </Text>

        {plans.map((p) => {
          const isCurrent = current?.plan === p.key && current?.status === 'active';
          const accent = PLAN_ACCENT[p.key] || colors.primary;
          return (
            <View
              key={p.key}
              testID={`plan-${p.key}`}
              style={[styles.planCard, { backgroundColor: colors.card, borderColor: isCurrent ? accent : colors.border, borderWidth: isCurrent ? 2 : 1 }]}
            >
              <View style={styles.planHeader}>
                <View>
                  <Text style={[styles.planTitle, { color: colors.text }]}>{p.titleEn}</Text>
                  <Text style={[styles.planTitleRu, { color: colors.textSecondary }]}>{p.titleRu}</Text>
                </View>
                <View style={[styles.priceBox, { backgroundColor: accent + '22' }]}>
                  <Text style={[styles.price, { color: accent }]}>€{p.priceMonthly}</Text>
                  <Text style={[styles.priceUnit, { color: accent }]}>/мес</Text>
                </View>
              </View>
              <View style={styles.boostRow}>
                <View style={[styles.boostBadge, { backgroundColor: accent }]}>
                  <Text style={styles.boostText}>boost ×{p.rankBoost}</Text>
                </View>
                <View style={[styles.boostBadge, { backgroundColor: accent }]}>
                  <Text style={styles.boostText}>+{p.extraRadiusKm} km</Text>
                </View>
              </View>
              <View style={{ marginTop: 12 }}>
                {p.features.map((f, i) => (
                  <View key={i} style={styles.featureRow}>
                    <Ionicons name="checkmark" size={14} color={accent} />
                    <Text style={[styles.featureText, { color: colors.text }]}>{f}</Text>
                  </View>
                ))}
              </View>
              {!isCurrent && (
                <TouchableOpacity
                  testID={`subscribe-${p.key}`}
                  onPress={() => handleSubscribe(p.key)}
                  disabled={!!subscribing}
                  activeOpacity={0.85}
                  style={[styles.subBtn, { backgroundColor: accent, opacity: subscribing === p.key ? 0.5 : 1 }]}
                >
                  {subscribing === p.key ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <Text style={styles.subBtnText}>
                      {current ? `Перейти на ${p.titleEn}` : `Подписаться · €${p.priceMonthly}/мес`}
                    </Text>
                  )}
                </TouchableOpacity>
              )}
              {isCurrent && (
                <View style={[styles.currentBadge, { backgroundColor: accent + '22' }]}>
                  <Text style={[styles.currentText, { color: accent }]}>Ваш текущий план</Text>
                </View>
              )}
            </View>
          );
        })}

        <Text style={[styles.disclaimer, { color: colors.textSecondary }]}>
          Mock checkout · реальный Stripe подключим без переделки UI.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 8 },
  backBtn: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  title: { fontSize: 17, fontWeight: '700' },
  activeBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 16 },
  activeTitle: { fontSize: 14, fontWeight: '700' },
  activeDesc: { fontSize: 12, marginTop: 2 },
  pendingBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 16 },
  h1: { fontSize: 24, fontWeight: '900', marginBottom: 6 },
  subtitle: { fontSize: 13, marginBottom: 20 },
  planCard: { padding: 16, borderRadius: 16, marginBottom: 14 },
  planHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
  planTitle: { fontSize: 22, fontWeight: '800' },
  planTitleRu: { fontSize: 12, marginTop: 2 },
  priceBox: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10 },
  price: { fontSize: 22, fontWeight: '900' },
  priceUnit: { fontSize: 12, fontWeight: '700', marginLeft: 2 },
  boostRow: { flexDirection: 'row', gap: 8 },
  boostBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  boostText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  featureText: { fontSize: 13 },
  subBtn: { marginTop: 14, paddingVertical: 13, borderRadius: 10, alignItems: 'center' },
  subBtnText: { fontSize: 14, fontWeight: '800', color: '#fff' },
  currentBadge: { marginTop: 14, paddingVertical: 11, borderRadius: 10, alignItems: 'center' },
  currentText: { fontSize: 13, fontWeight: '700' },
  disclaimer: { textAlign: 'center', marginTop: 20, fontSize: 11, fontStyle: 'italic' },
});

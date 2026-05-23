/**
 * Sprint 7 — Provider Stripe Connect Onboarding screen.
 *
 * URL: /provider/stripe-connect
 *
 * Flow:
 *   1. Loads current onboarding status (charges/payouts capabilities)
 *   2. If not onboarded → "Connect Stripe" button → /connect/onboarding/start
 *      → opens onboarding URL in browser (Stripe-hosted)
 *   3. On return → re-fetches status to surface live capabilities
 *
 * Test mode badge surfaces sandbox state explicitly per ops spec.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  RefreshControl,
  Linking,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { stripeConnectAPI } from '../../src/services/api';
import TestModeBadge from '../../src/components/TestModeBadge';
import { useRequireAuth } from '../../src/hooks/useRequireAuth';
import { AuthRequiredModal } from '../../src/components/AuthRequiredModal';

export default function StripeConnectScreen() {
  const router = useRouter();
  const { requireAuth, authModalVisible, closeAuthModal, authReason } = useRequireAuth();
  const [status, setStatus] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await stripeConnectAPI.status();
      setStatus(data);
    } catch (e: any) {
      if (e?.response?.status === 401) {
        requireAuth(() => load(), {
          intent: 'stripe_connect',
          reason: 'Войдите как провайдер, чтобы подключить выплаты.',
        });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [requireAuth]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleStart() {
    setSubmitting(true);
    try {
      const { data } = await stripeConnectAPI.startOnboarding({ country: 'DE' });
      const url = data.onboardingUrl;
      if (!url) {
        Alert.alert('Ошибка', 'Не удалось получить ссылку');
        return;
      }
      if (data.sandbox) {
        Alert.alert(
          'TEST MODE',
          'В sandbox-режиме онбординг симулируется автоматически. Все возможности уже включены.',
          [{ text: 'OK', onPress: () => load() }],
        );
        return;
      }
      // Real onboarding — open Stripe-hosted URL in browser.
      if (Platform.OS === 'web') {
        await Linking.openURL(url);
      } else {
        await WebBrowser.openBrowserAsync(url);
      }
      // After return, refresh status.
      setTimeout(() => load(), 1500);
    } catch (e: any) {
      Alert.alert('Ошибка', e?.response?.data?.detail || 'Не удалось начать онбординг');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color="#FFD23F" size="large" style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  const onboarded = status?.onboarded;
  const fullyEnabled = onboarded && status.chargesEnabled && status.payoutsEnabled;
  const sandbox = status?.sandbox;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8} testID="connect-back-btn">
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Выплаты · Stripe</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
            tintColor="#FFD23F"
          />
        }
      >
        {sandbox && <TestModeBadge variant="banner" style={{ marginBottom: 20 }} />}

        <View style={styles.heroBox}>
          <Ionicons
            name={fullyEnabled ? 'checkmark-circle' : 'flash-outline'}
            size={56}
            color={fullyEnabled ? '#34D399' : '#FFD23F'}
          />
          <Text style={styles.heroTitle}>
            {fullyEnabled ? 'Готово принимать выплаты' : 'Подключите Stripe для выплат'}
          </Text>
          <Text style={styles.heroSubtitle}>
            {fullyEnabled
              ? 'Все возможности включены. Эскроу-выплаты будут поступать на ваш счёт в Stripe.'
              : 'Stripe Connect Express — стандартный, безопасный способ получать выплаты из эскроу. Занимает 3-5 минут.'}
          </Text>
        </View>

        {onboarded && (
          <View style={styles.statusCard}>
            <Text style={styles.cardTitle}>Статус</Text>
            <Row
              label="Аккаунт"
              value={status.stripeAccountId?.substring(0, 18) + '...'}
              ok
            />
            <Row label="Платежи" value={status.chargesEnabled ? 'Активны' : 'Ожидают'} ok={status.chargesEnabled} />
            <Row label="Выплаты" value={status.payoutsEnabled ? 'Активны' : 'Ожидают'} ok={status.payoutsEnabled} />
            <Row
              label="Документы"
              value={status.detailsSubmitted ? 'Поданы' : 'Не поданы'}
              ok={status.detailsSubmitted}
            />
            {status.frozen && (
              <View style={styles.frozenWarn}>
                <Ionicons name="snow" size={16} color="#60A5FA" />
                <Text style={styles.frozenText}>Выплаты временно заморожены администратором</Text>
              </View>
            )}
          </View>
        )}

        <View style={styles.feeCard}>
          <Text style={styles.cardTitle}>Комиссия платформы</Text>
          <Text style={styles.feeText}>10% от каждой сделки</Text>
          <Text style={styles.feeSubtle}>Прозрачно. Без скрытых платежей.</Text>
        </View>

        <View style={styles.policyCard}>
          <View style={styles.policyRow}>
            <Ionicons name="time-outline" size={18} color="#9CA3AF" />
            <Text style={styles.policyText}>
              Буфер выплат: 12ч после завершения работ (для возможных споров)
            </Text>
          </View>
          <View style={styles.policyRow}>
            <Ionicons name="shield-checkmark-outline" size={18} color="#9CA3AF" />
            <Text style={styles.policyText}>
              Эскроу: деньги клиента блокируются до завершения работ
            </Text>
          </View>
          <View style={styles.policyRow}>
            <Ionicons name="lock-closed-outline" size={18} color="#9CA3AF" />
            <Text style={styles.policyText}>
              Stripe верифицирует личность по 3DS + AML
            </Text>
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <TouchableOpacity
          onPress={handleStart}
          disabled={submitting}
          style={[styles.cta, submitting && styles.ctaDisabled]}
          testID="connect-stripe-btn"
        >
          {submitting ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text style={styles.ctaText}>
              {fullyEnabled ? 'Обновить данные Stripe' : 'Подключить Stripe'}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      <AuthRequiredModal
        visible={authModalVisible}
        onClose={closeAuthModal}
        reason={authReason}
      />
    </SafeAreaView>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Text style={[styles.rowValue, { color: ok ? '#34D399' : '#FBBF24' }]}>{value}</Text>
        <Ionicons
          name={ok ? 'checkmark-circle' : 'time'}
          size={14}
          color={ok ? '#34D399' : '#FBBF24'}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: '#1f2937',
    borderBottomWidth: 1,
  },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  scroll: { padding: 16, paddingBottom: 32 },
  heroBox: { alignItems: 'center', paddingVertical: 24 },
  heroTitle: { color: '#fff', fontSize: 22, fontWeight: '700', marginTop: 16, textAlign: 'center' },
  heroSubtitle: { color: '#9CA3AF', fontSize: 14, marginTop: 12, textAlign: 'center', lineHeight: 20, paddingHorizontal: 8 },
  statusCard: {
    backgroundColor: '#1f2937',
    padding: 14,
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#374151',
  },
  cardTitle: { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  rowLabel: { color: '#9CA3AF', fontSize: 13 },
  rowValue: { fontSize: 13, fontWeight: '600' },
  frozenWarn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#60A5FA22',
    padding: 10,
    borderRadius: 8,
    marginTop: 10,
  },
  frozenText: { color: '#60A5FA', fontSize: 12, flex: 1 },
  feeCard: {
    backgroundColor: '#1f2937',
    padding: 14,
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#374151',
  },
  feeText: { color: '#FFD23F', fontSize: 24, fontWeight: '700' },
  feeSubtle: { color: '#9CA3AF', fontSize: 12, marginTop: 4 },
  policyCard: {
    backgroundColor: '#1f2937',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#374151',
  },
  policyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  policyText: { color: '#E5E7EB', fontSize: 13, flex: 1 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: '#1f2937' },
  cta: {
    backgroundColor: '#FFD23F',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  ctaDisabled: { opacity: 0.5 },
  ctaText: { color: '#000', fontSize: 16, fontWeight: '700' },
});

/**
 * Sprint 3A — Mock Checkout Screen.
 * Имитирует страницу Stripe Checkout. После «оплаты» зовёт _mock-pay
 * на backend, который проходит через webhook путь и переводит платёж
 * в `paid`. В prod-режиме этот экран будет редиректить на реальный
 * Stripe Checkout (через WebBrowser/Linking).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../../src/context/ThemeContext';
import { api } from '../../../src/services/api';

export default function CheckoutScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const params = useLocalSearchParams<{ paymentId: string }>();
  const [payment, setPayment] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);

  const load = useCallback(async () => {
    if (!params.paymentId) return;
    try {
      const r = await api.get(`/service-payments/${params.paymentId}`);
      setPayment(r.data?.payment);
    } catch (e: any) {
      Alert.alert('Ошибка', e?.response?.data?.message || e?.message);
    } finally {
      setLoading(false);
    }
  }, [params.paymentId]);

  useEffect(() => { load(); }, [load]);

  const handlePay = async () => {
    setPaying(true);
    try {
      await api.post(`/service-payments/${params.paymentId}/_mock-pay`, {});
      router.replace(`/payments/success/${params.paymentId}` as any);
    } catch (e: any) {
      Alert.alert('Ошибка оплаты', e?.response?.data?.message || e?.message);
      setPaying(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background, justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }
  if (!payment) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: colors.textSecondary }}>Платёж не найден</Text>
      </SafeAreaView>
    );
  }

  const isPaid = payment.status === 'paid' || payment.status === 'released';

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity testID="checkout-back" onPress={() => router.back()} style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>Оплата</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {/* Mock notice */}
        <View style={[styles.mockBanner, { backgroundColor: '#f59e0b22', borderColor: '#f59e0b' }]}>
          <Ionicons name="information-circle" size={16} color="#f59e0b" />
          <Text style={[styles.mockText, { color: '#f59e0b' }]}>Mock checkout · реальный Stripe подключим позже</Text>
        </View>

        <View style={[styles.amountCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.amountLabel, { color: colors.textSecondary }]}>К оплате</Text>
          <Text style={[styles.amount, { color: colors.primary }]}>
            €{payment.grossAmount}
          </Text>
          <Text style={[styles.currency, { color: colors.textSecondary }]}>{payment.currency}</Text>
        </View>

        <View style={[styles.breakdown, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.h2, { color: colors.text }]}>Детали платежа</Text>
          <Row label="Заявка" value={payment.requestId.slice(0, 8) + '…'} colors={colors} />
          <Row label="Категория" value={payment.category || '—'} colors={colors} />
          <Row label="Город" value={payment.city || '—'} colors={colors} />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <Row label="Сумма" value={`€${payment.grossAmount}`} colors={colors} bold />
          <Row label={`Комиссия (${payment.commissionPct}%)`} value={`€${payment.commissionAmount}`} colors={colors} muted />
          <Row label="Исполнителю" value={`€${payment.providerPayout}`} colors={colors} muted />
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <Row label="Статус" value={payment.status} colors={colors} bold accent={isPaid ? '#22c55e' : '#f59e0b'} />
        </View>

        <View style={[styles.escrowBox, { backgroundColor: '#3b82f622', borderColor: '#3b82f6' }]}>
          <Ionicons name="shield-checkmark" size={18} color="#3b82f6" />
          <View style={{ flex: 1 }}>
            <Text style={[styles.escrowTitle, { color: colors.text }]}>Защита escrow</Text>
            <Text style={[styles.escrowDesc, { color: colors.textSecondary }]}>
              Деньги хранятся на платформе. Исполнитель получит выплату только после завершения работы и вашего подтверждения.
            </Text>
          </View>
        </View>

        {!isPaid && (
          <TouchableOpacity
            testID="checkout-pay-btn"
            onPress={handlePay}
            disabled={paying}
            activeOpacity={0.85}
            style={[styles.payBtn, { backgroundColor: colors.primary, opacity: paying ? 0.6 : 1 }]}
          >
            {paying ? (
              <ActivityIndicator color="#000" size="small" />
            ) : (
              <>
                <Ionicons name="card" size={18} color="#000" />
                <Text style={styles.payText}>Оплатить €{payment.grossAmount}</Text>
              </>
            )}
          </TouchableOpacity>
        )}

        {isPaid && (
          <TouchableOpacity
            testID="checkout-already-paid"
            onPress={() => router.replace(`/payments/success/${params.paymentId}` as any)}
            style={[styles.payBtn, { backgroundColor: '#22c55e' }]}
          >
            <Ionicons name="checkmark-circle" size={18} color="#fff" />
            <Text style={[styles.payText, { color: '#fff' }]}>Уже оплачено · открыть</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value, colors, bold, muted, accent }: any) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: muted ? colors.textSecondary : colors.text, fontWeight: bold ? '700' : '500' }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: accent || (muted ? colors.textSecondary : colors.text), fontWeight: bold ? '800' : '600' }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 8 },
  backBtn: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  title: { fontSize: 17, fontWeight: '700' },
  mockBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10, borderWidth: 1, marginBottom: 16 },
  mockText: { fontSize: 12, fontWeight: '600' },
  amountCard: { padding: 24, borderRadius: 16, borderWidth: 1, alignItems: 'center', marginBottom: 14 },
  amountLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  amount: { fontSize: 48, fontWeight: '900' },
  currency: { fontSize: 12, marginTop: 4 },
  breakdown: { padding: 16, borderRadius: 14, borderWidth: 1, marginBottom: 14 },
  h2: { fontSize: 14, fontWeight: '700', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  rowLabel: { fontSize: 14 },
  rowValue: { fontSize: 14 },
  divider: { height: 1, marginVertical: 8 },
  escrowBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 20 },
  escrowTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  escrowDesc: { fontSize: 12, lineHeight: 18 },
  payBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16, borderRadius: 12 },
  payText: { fontSize: 16, fontWeight: '800', color: '#000' },
});

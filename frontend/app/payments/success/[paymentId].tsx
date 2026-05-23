/**
 * Sprint 3A — Payment Success Screen.
 * Показывает после успешной оплаты. Контакты провайдера теперь открыты.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../../src/context/ThemeContext';
import { api } from '../../../src/services/api';

export default function PaymentSuccessScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const params = useLocalSearchParams<{ paymentId: string }>();
  const [payment, setPayment] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/service-payments/${params.paymentId}`);
      setPayment(r.data?.payment);
    } finally {
      setLoading(false);
    }
  }, [params.paymentId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background, justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={{ padding: 16, alignItems: 'center' }}>
        <View style={styles.iconCircle}>
          <Ionicons name="checkmark-circle" size={80} color="#22c55e" />
        </View>
        <Text style={[styles.title, { color: colors.text }]}>Оплачено!</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          €{payment?.grossAmount} переведено на безопасный счёт платформы (escrow).
        </Text>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.step}>
            <View style={[styles.stepDot, { backgroundColor: '#22c55e' }]} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.stepTitle, { color: colors.text }]}>Деньги в escrow</Text>
              <Text style={[styles.stepDesc, { color: colors.textSecondary }]}>
                Защищены платформой до завершения работы
              </Text>
            </View>
          </View>
          <View style={[styles.stepDivider, { backgroundColor: colors.border }]} />
          <View style={styles.step}>
            <View style={[styles.stepDot, { backgroundColor: '#f59e0b' }]} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.stepTitle, { color: colors.text }]}>Исполнитель выполняет работу</Text>
              <Text style={[styles.stepDesc, { color: colors.textSecondary }]}>
                Свяжитесь с ним для согласования деталей
              </Text>
            </View>
          </View>
          <View style={[styles.stepDivider, { backgroundColor: colors.border }]} />
          <View style={styles.step}>
            <View style={[styles.stepDot, { backgroundColor: colors.border }]} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.stepTitle, { color: colors.text }]}>Подтвердите завершение</Text>
              <Text style={[styles.stepDesc, { color: colors.textSecondary }]}>
                Деньги перейдут исполнителю после вашего OK
              </Text>
            </View>
          </View>
        </View>

        <TouchableOpacity
          testID="success-open-request"
          onPress={() => router.replace(`/service-marketplace/${payment?.requestId}` as any)}
          activeOpacity={0.85}
          style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
        >
          <Text style={styles.primaryText}>Открыть заявку с контактами</Text>
          <Ionicons name="arrow-forward" size={18} color="#000" />
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => router.replace('/service-marketplace' as any)}
          activeOpacity={0.7}
          style={styles.secondaryBtn}
        >
          <Text style={[styles.secondaryText, { color: colors.textSecondary }]}>← Все мои заявки</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  iconCircle: { marginTop: 30, marginBottom: 16 },
  title: { fontSize: 30, fontWeight: '900', marginBottom: 8 },
  subtitle: { fontSize: 14, textAlign: 'center', marginBottom: 28, paddingHorizontal: 20 },
  card: { width: '100%', padding: 16, borderRadius: 14, borderWidth: 1, marginBottom: 24 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  stepDot: { width: 12, height: 12, borderRadius: 6 },
  stepTitle: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  stepDesc: { fontSize: 12, lineHeight: 16 },
  stepDivider: { height: 1, marginVertical: 4, marginLeft: 24 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16, paddingHorizontal: 24, borderRadius: 12, alignSelf: 'stretch' },
  primaryText: { fontSize: 15, fontWeight: '800', color: '#000' },
  secondaryBtn: { marginTop: 14, paddingVertical: 10 },
  secondaryText: { fontSize: 14, fontWeight: '600' },
});

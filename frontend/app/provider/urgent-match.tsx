/**
 * Sprint 8 — Provider Urgent Match screen.
 *
 * Deep-linked from push notification "new_matched_request".
 * URL: /provider/urgent-match?requestId=...
 *
 * UX: large job card + 15-sec accept countdown + Accept/Decline.
 * Highest revenue-impact UX in the platform — drives bid liquidity.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/services/api';

const ACCEPT_WINDOW_SECONDS = 15;

const CATEGORY_META: Record<string, { emoji: string; label: string }> = {
  tow:       { emoji: '🚛', label: 'Эвакуация' },
  repair:    { emoji: '🔧', label: 'Ремонт' },
  wash:      { emoji: '🚿', label: 'Мойка' },
  detailing: { emoji: '✨', label: 'Детейлинг' },
  battery:   { emoji: '🔋', label: 'АКБ' },
  parts:     { emoji: '🔩', label: 'Запчасти' },
  delivery:  { emoji: '🚚', label: 'Доставка' },
  inspection:{ emoji: '🛡', label: 'Осмотр' },
};

export default function UrgentMatchScreen() {
  const router = useRouter();
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  const [req, setReq] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [seconds, setSeconds] = useState(ACCEPT_WINDOW_SECONDS);
  const [expired, setExpired] = useState(false);

  const load = useCallback(async () => {
    if (!requestId) return;
    try {
      const { data } = await api.get(`/service-requests/${requestId}`);
      setReq(data);
    } catch (e) {
      setReq(null);
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Countdown timer
  useEffect(() => {
    if (loading || expired) return;
    const t = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) {
          clearInterval(t);
          setExpired(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [loading, expired]);

  async function accept() {
    if (!requestId || submitting) return;
    setSubmitting(true);
    try {
      await api.post(`/service-requests/${requestId}/bids`, {
        amount: req?.suggestedAmount || req?.amount,
        message: 'Принимаю срочную заявку',
      });
      Alert.alert('Принято', 'Клиент уведомлён. Ждите подтверждения.', [
        { text: 'OK', onPress: () => router.replace(`/service-marketplace/${requestId}` as any) },
      ]);
    } catch (e: any) {
      Alert.alert('Ошибка', e?.response?.data?.detail || 'Не удалось принять');
    } finally {
      setSubmitting(false);
    }
  }

  function decline() {
    router.back();
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color="#FFD23F" size="large" style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }
  if (!req) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.errorText}>Заявка не найдена</Text>
      </SafeAreaView>
    );
  }

  const cat = CATEGORY_META[req.category] || { emoji: '🛠', label: req.category };

  return (
    <SafeAreaView style={styles.container} testID="urgent-match-screen">
      {/* Countdown ribbon */}
      <View style={[styles.ribbon, expired && styles.ribbonExpired]}>
        <Ionicons name={expired ? 'time' : 'flash'} size={18} color={expired ? '#9CA3AF' : '#000'} />
        <Text style={[styles.ribbonText, expired && styles.ribbonTextExpired]}>
          {expired ? 'Время вышло — заявка ушла другому' : `Принять в ${seconds} сек`}
        </Text>
      </View>

      <View style={styles.hero}>
        <Text style={styles.emoji}>{cat.emoji}</Text>
        <Text style={styles.category}>{cat.label}</Text>
        <Text style={styles.title}>{req.title}</Text>
        <Text style={styles.amount}>€{req.amount}</Text>
      </View>

      <View style={styles.detailsCard}>
        {req.cityName && (
          <Row icon="location" label="Город" value={req.cityName} />
        )}
        {req.distanceKm != null && (
          <Row icon="navigate" label="Расстояние" value={`${req.distanceKm.toFixed(1)} км`} />
        )}
        {req.description && (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.descLabel}>Описание</Text>
            <Text style={styles.descText} numberOfLines={3}>
              {req.description}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.footer}>
        <TouchableOpacity
          onPress={decline}
          style={styles.declineBtn}
          testID="urgent-decline-btn"
        >
          <Text style={styles.declineText}>Пропустить</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={accept}
          disabled={submitting || expired}
          style={[
            styles.acceptBtn,
            (submitting || expired) && styles.acceptBtnDisabled,
          ]}
          testID="urgent-accept-btn"
        >
          {submitting ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text style={styles.acceptText}>{expired ? 'Время вышло' : 'Принять заявку'}</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function Row({ icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={16} color="#9CA3AF" />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', justifyContent: 'space-between' },
  errorText: { color: '#fff', textAlign: 'center', marginTop: 80 },
  ribbon: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FFD23F',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  ribbonExpired: { backgroundColor: '#374151' },
  ribbonText: { color: '#000', fontSize: 16, fontWeight: '800', letterSpacing: 0.5 },
  ribbonTextExpired: { color: '#9CA3AF' },
  hero: { alignItems: 'center', paddingHorizontal: 24, marginTop: 8 },
  emoji: { fontSize: 64 },
  category: { color: '#9CA3AF', fontSize: 13, marginTop: 8, textTransform: 'uppercase', letterSpacing: 1 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginTop: 8, textAlign: 'center' },
  amount: { color: '#FFD23F', fontSize: 48, fontWeight: '800', marginTop: 12 },
  detailsCard: {
    backgroundColor: '#1f2937',
    padding: 16,
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#374151',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  rowLabel: { color: '#9CA3AF', fontSize: 13, flex: 1 },
  rowValue: { color: '#fff', fontSize: 14, fontWeight: '600' },
  descLabel: { color: '#9CA3AF', fontSize: 12, marginBottom: 4 },
  descText: { color: '#E5E7EB', fontSize: 13, lineHeight: 18 },
  footer: { flexDirection: 'row', padding: 16, gap: 12 },
  declineBtn: {
    flex: 1,
    backgroundColor: '#1f2937',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#374151',
  },
  declineText: { color: '#9CA3AF', fontSize: 15, fontWeight: '600' },
  acceptBtn: {
    flex: 2,
    backgroundColor: '#FFD23F',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  acceptBtnDisabled: { opacity: 0.4 },
  acceptText: { color: '#000', fontSize: 16, fontWeight: '800' },
});

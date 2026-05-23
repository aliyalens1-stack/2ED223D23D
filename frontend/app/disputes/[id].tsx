/**
 * Sprint 6 — Dispute Detail screen.
 *
 * URL: /disputes/[id]
 *
 * Shows full dispute timeline + resolution outcome for user (customer or provider).
 * Read-only — no actions for user (admin resolves).
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { disputesAPI } from '../../src/services/api';

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  open: { label: 'Открыт', color: '#FBBF24', bg: '#FBBF2422' },
  in_review: { label: 'На рассмотрении', color: '#60A5FA', bg: '#60A5FA22' },
  resolved: { label: 'Решён', color: '#34D399', bg: '#34D39922' },
};

const REASON_LABELS: Record<string, string> = {
  not_completed: 'Услуга не выполнена',
  quality_issue: 'Плохое качество',
  no_show: 'Не приехал',
  overcharge: 'Переплата / скрытые расходы',
  damage: 'Повреждение',
  wrong_service: 'Не то, о чём договаривались',
  communication: 'Не отвечает',
  other: 'Другое',
};

const RESOLUTION_LABELS: Record<string, { label: string; icon: string; color: string }> = {
  release_to_provider: { label: 'Выплата исполнителю', icon: 'arrow-up-circle', color: '#34D399' },
  partial_refund: { label: 'Частичное разделение', icon: 'git-branch', color: '#FBBF24' },
  full_refund: { label: 'Полный возврат клиенту', icon: 'arrow-back-circle', color: '#60A5FA' },
};

export default function DisputeDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [dispute, setDispute] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const { data } = await disputesAPI.getById(String(id));
      setDispute(data);
    } catch (e) {
      setDispute(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color="#FFD23F" size="large" style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }
  if (!dispute) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.errorText}>Спор не найден</Text>
      </SafeAreaView>
    );
  }

  const meta = STATUS_META[dispute.status] || STATUS_META.open;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8} testID="dispute-detail-back">
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Спор</Text>
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
        <View style={[styles.statusBadge, { backgroundColor: meta.bg, borderColor: meta.color }]}>
          <Text style={[styles.statusText, { color: meta.color }]}>{meta.label}</Text>
        </View>

        <View style={styles.card}>
          <Row label="Причина" value={REASON_LABELS[dispute.reason] || dispute.reason} />
          <Row label="Сумма" value={`€${dispute.amount} ${dispute.currency || 'EUR'}`} />
          <Row label="Открыл" value={dispute.openedByRole === 'customer' ? 'Клиент' : 'Исполнитель'} />
          <Row label="Дата" value={new Date(dispute.openedAt).toLocaleString('ru-RU')} />
        </View>

        {!!dispute.description && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Описание</Text>
            <Text style={styles.descText}>{dispute.description}</Text>
          </View>
        )}

        {dispute.status === 'resolved' && dispute.resolution && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Решение</Text>
            <View style={styles.resolutionRow}>
              <Ionicons
                name={(RESOLUTION_LABELS[dispute.resolution]?.icon as any) || 'checkmark'}
                size={22}
                color={RESOLUTION_LABELS[dispute.resolution]?.color || '#34D399'}
              />
              <Text style={styles.resolutionText}>
                {RESOLUTION_LABELS[dispute.resolution]?.label || dispute.resolution}
              </Text>
            </View>
            {dispute.partialRefundPercent && (
              <Text style={styles.muted}>Возврат {dispute.partialRefundPercent}%</Text>
            )}
            {dispute.payoutAmount != null && (
              <Row label="Выплата провайдеру" value={`€${dispute.payoutAmount}`} />
            )}
            {dispute.refundAmount != null && (
              <Row label="Возврат клиенту" value={`€${dispute.refundAmount}`} />
            )}
            {!!dispute.adminNote && (
              <View style={{ marginTop: 8 }}>
                <Text style={styles.muted}>Комментарий администратора:</Text>
                <Text style={styles.descText}>{dispute.adminNote}</Text>
              </View>
            )}
            {!!dispute.resolvedAt && (
              <Text style={styles.muted}>
                Решено: {new Date(dispute.resolvedAt).toLocaleString('ru-RU')}
              </Text>
            )}
          </View>
        )}

        {dispute.status !== 'resolved' && (
          <View style={[styles.card, { borderColor: '#FFD23F44' }]}>
            <Ionicons name="time" size={32} color="#FFD23F" />
            <Text style={styles.waitTitle}>Ожидаем решения администратора</Text>
            <Text style={styles.muted}>
              Эскроу заморожен. Мы изучим обращение, переписку и доказательства, и примем решение в течение 3 рабочих дней.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
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
  errorText: { color: '#fff', textAlign: 'center', marginTop: 80 },
  statusBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 16,
  },
  statusText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  card: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#374151',
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  rowLabel: { color: '#9CA3AF', fontSize: 13 },
  rowValue: { color: '#fff', fontSize: 14, fontWeight: '500' },
  sectionTitle: { color: '#fff', fontSize: 14, fontWeight: '700', marginBottom: 8 },
  descText: { color: '#E5E7EB', fontSize: 14, lineHeight: 20 },
  resolutionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  resolutionText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  muted: { color: '#9CA3AF', fontSize: 12, marginTop: 6 },
  waitTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginTop: 8, marginBottom: 6 },
});

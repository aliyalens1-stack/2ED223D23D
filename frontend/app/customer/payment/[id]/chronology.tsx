/**
 * P0.b.C.i — Customer payment chronology screen.
 *
 * Surface: `payment-activity.customer`.
 *
 * Route: `/customer/payment/[id]/chronology`
 *
 * This screen is intentionally calm and humanized — the customer is
 * looking at THEIR money moving through the platform, not at an
 * operational evidence log. Tone is the customer surface's concern;
 * the backend projector strips out everything inappropriate before
 * the data ever reaches here.
 *
 * Mirror-screen: `app/admin/payment/[id]/forensic.tsx` — same backend
 * data shape underneath, but a deliberately DIFFERENT screen for the
 * admin surface. The two screens are separate ontology species.
 */
import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  useCustomerPaymentChronology,
  type CustomerPaymentEvent,
  type CustomerPaymentKind,
  type CustomerPaymentTone,
  dedupKey,
} from '../../../../src/customer/payment-chronology';

// ── Kind → (label, description, tone, isSelfAction)
//
// Closed table. The 11 customer-visible kinds from the F.3 projector,
// each humanized at THIS surface only. No "shared chronology kit" —
// admin forensic deliberately does NOT humanize kinds. This is the
// boundary between `payment-activity.customer` and
// `payment-forensic.admin`.
const KIND_LABEL: Record<
  CustomerPaymentKind,
  { label: string; description: string; tone: CustomerPaymentTone; isSelfAction: boolean }
> = {
  'payment.initiated': {
    label: 'Платёж инициирован',
    description: 'Ожидаем подтверждение платёжной системы',
    tone: 'neutral',
    isSelfAction: false,
  },
  'payment.failed': {
    label: 'Платёж не прошёл',
    description: 'Платёж не был списан — проверьте карту',
    tone: 'alert',
    isSelfAction: false,
  },
  'escrow.held': {
    label: 'Средства заблокированы на счету платформы',
    description: 'Деньги в безопасности до выполнения работ',
    tone: 'positive',
    isSelfAction: false,
  },
  'escrow.release_requested': {
    label: 'Вы запросили выплату исполнителю',
    description: 'Когда платформа подтвердит — деньги переведут',
    tone: 'neutral',
    isSelfAction: true,
  },
  'escrow.release_rejected': {
    label: 'Выплата отклонена',
    description: 'Средства остаются на счету платформы',
    tone: 'alert',
    isSelfAction: false,
  },
  'escrow.released': {
    label: 'Средства переведены исполнителю',
    description: 'Сделка завершена успешно',
    tone: 'celebratory',
    isSelfAction: false,
  },
  'refund.requested': {
    label: 'Вы запросили возврат',
    description: 'Обработка обычно занимает до 3 рабочих дней',
    tone: 'neutral',
    isSelfAction: true,
  },
  'refund.succeeded': {
    label: 'Возврат выполнен',
    description: 'Средства вернулись на вашу карту',
    tone: 'celebratory',
    isSelfAction: false,
  },
  'refund.failed': {
    label: 'Возврат не прошёл',
    description: 'Свяжитесь с поддержкой',
    tone: 'alert',
    isSelfAction: false,
  },
  'dispute.linked': {
    label: 'Открыт спор по сделке',
    description: 'Средства заморожены до решения',
    tone: 'alert',
    isSelfAction: false,
  },
  'dispute.resolved': {
    label: 'Спор разрешён',
    description: 'Решение опубликовано платформой',
    tone: 'positive',
    isSelfAction: false,
  },
};

const TONE_TO_COLOR: Record<CustomerPaymentTone, string> = {
  neutral: '#9CA3AF',
  positive: '#FACC15',
  celebratory: '#22C55E',
  alert: '#EF4444',
};

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  idle: { text: '—', color: '#6B7280' },
  hydrating: { text: 'Загрузка…', color: '#9CA3AF' },
  live: { text: 'Live', color: '#22C55E' },
  reconnecting: { text: 'Восстановление…', color: '#FACC15' },
  offline: { text: 'Офлайн', color: '#EF4444' },
};

function formatAmount(amount?: number, currency?: string): string | null {
  if (typeof amount !== 'number') return null;
  // Backend stores amounts in cents (per Stripe). Render as major units.
  const major = amount / 100;
  const cur = currency || 'EUR';
  try {
    return major.toLocaleString(undefined, {
      style: 'currency',
      currency: cur,
      maximumFractionDigits: 2,
    });
  } catch {
    return `${major.toFixed(2)} ${cur}`;
  }
}

function formatTimestamp(at: string | null): string {
  if (!at) return '';
  try {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return at;
    return d.toLocaleString();
  } catch {
    return at;
  }
}

function ChronologyRow({ event }: { event: CustomerPaymentEvent }) {
  // If a kind ever arrives that isn't in our table (forward-compat),
  // fall back to a neutral rendering rather than crashing the screen.
  const fallback = {
    label: event.kind,
    description: '',
    tone: 'neutral' as CustomerPaymentTone,
    isSelfAction: false,
  };
  const entry =
    (KIND_LABEL as Record<string, typeof fallback>)[event.kind] || fallback;
  const color = TONE_TO_COLOR[entry.tone];
  const amountStr = formatAmount(event.meta?.amount, event.meta?.currency);

  return (
    <View style={styles.row} testID={`customer-payment-row-${event.id}`}>
      <View style={styles.timelineRail}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={styles.railLine} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowHeader}>
          <Text style={styles.label} numberOfLines={2}>
            {entry.label}
          </Text>
          {entry.isSelfAction ? (
            <View
              style={styles.selfBadge}
              testID={`customer-payment-self-${event.id}`}
            >
              <Text style={styles.selfBadgeText}>вы</Text>
            </View>
          ) : null}
        </View>
        {entry.description ? (
          <Text style={styles.description}>{entry.description}</Text>
        ) : null}
        {amountStr ? (
          <Text style={styles.metaLineStrong}>{amountStr}</Text>
        ) : null}
        {event.meta?.releaseEta ? (
          <Text style={styles.metaLine}>
            Срок · {String(event.meta.releaseEta)}
          </Text>
        ) : null}
        {event.meta?.reason ? (
          <Text style={styles.metaLine}>
            Причина · {String(event.meta.reason)}
          </Text>
        ) : null}
        {event.meta?.resolution ? (
          <Text style={styles.metaLine}>
            Решение · {String(event.meta.resolution)}
          </Text>
        ) : null}
        {event.meta?.disputeId ? (
          <Text style={styles.metaLineMuted}>
            #{String(event.meta.disputeId).slice(0, 12)}
          </Text>
        ) : null}
        <Text style={styles.timestamp}>{formatTimestamp(event.at)}</Text>
      </View>
    </View>
  );
}

export default function CustomerPaymentChronologyScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const paymentId = typeof params.id === 'string' ? params.id : null;
  const { events, status, lastError, refresh } =
    useCustomerPaymentChronology(paymentId);

  const statusInfo = STATUS_LABEL[status] ?? STATUS_LABEL.idle;
  const isInitialLoad = status === 'hydrating' && events.length === 0;

  // Show running total as side-info — the most recent amount/currency
  // we saw is enough; the customer cares about "what was last moved".
  const lastAmountInfo = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (typeof e.meta?.amount === 'number') {
        return formatAmount(e.meta.amount, e.meta.currency) ?? null;
      }
    }
    return null;
  }, [events]);

  return (
    <SafeAreaView
      style={styles.container}
      testID="customer-payment-chronology-screen"
    >
      <Stack.Screen
        options={{
          title: 'Движение платежа',
          headerStyle: { backgroundColor: '#0c0c0c' },
          headerTintColor: '#fff',
        }}
      />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          testID="customer-payment-chronology-back-button"
          accessibilityLabel="Назад"
        >
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Движение платежа</Text>
          {paymentId ? (
            <Text style={styles.headerSub} numberOfLines={1}>
              #{paymentId.slice(0, 12)}
              {lastAmountInfo ? `  ·  ${lastAmountInfo}` : ''}
            </Text>
          ) : null}
        </View>
        <View
          style={styles.statusPill}
          testID="customer-payment-chronology-status-pill"
        >
          <View
            style={[styles.statusDot, { backgroundColor: statusInfo.color }]}
            testID={`customer-payment-chronology-status-${status}`}
          />
          <Text style={[styles.statusText, { color: statusInfo.color }]}>
            {statusInfo.text}
          </Text>
        </View>
      </View>

      {isInitialLoad ? (
        <View
          style={styles.empty}
          testID="customer-payment-chronology-loading"
        >
          <ActivityIndicator color="#FACC15" />
        </View>
      ) : events.length === 0 ? (
        <View style={styles.empty} testID="customer-payment-chronology-empty">
          <Ionicons name="wallet-outline" size={48} color="#3F3F46" />
          <Text style={styles.emptyTitle}>Пока нет движений</Text>
          <Text style={styles.emptyBody}>
            Здесь появятся этапы: блокировка средств, выплата, возврат,
            споры.
          </Text>
          {lastError ? (
            <Text
              style={styles.errorText}
              testID="customer-payment-chronology-error"
            >
              {lastError}
            </Text>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => dedupKey(item)}
          renderItem={({ item }) => <ChronologyRow event={item} />}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={refresh}
              tintColor="#FACC15"
            />
          }
          testID="customer-payment-chronology-list"
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c0c0c' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: '#1F1F23',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: { flex: 1, paddingHorizontal: 8 },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  headerSub: { color: '#6B7280', fontSize: 12, marginTop: 2 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#18181B',
    borderRadius: 12,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: { fontSize: 12, fontWeight: '600' },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
  },
  row: { flexDirection: 'row', minHeight: 80 },
  timelineRail: { width: 24, alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 6 },
  railLine: {
    flex: 1,
    width: 2,
    backgroundColor: '#1F1F23',
    marginTop: 4,
  },
  rowBody: { flex: 1, paddingLeft: 12, paddingBottom: 18 },
  rowHeader: { flexDirection: 'row', alignItems: 'center' },
  label: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  selfBadge: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: '#FACC15',
    borderRadius: 8,
  },
  selfBadgeText: {
    color: '#0c0c0c',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  description: {
    color: '#D4D4D8',
    fontSize: 13,
    marginTop: 4,
    lineHeight: 18,
  },
  metaLine: { color: '#A1A1AA', fontSize: 12, marginTop: 4 },
  metaLineStrong: {
    color: '#FACC15',
    fontSize: 14,
    marginTop: 6,
    fontWeight: '700',
  },
  metaLineMuted: {
    color: '#52525B',
    fontSize: 11,
    marginTop: 4,
    fontFamily: 'System',
  },
  timestamp: { color: '#6B7280', fontSize: 11, marginTop: 6 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: '#E4E4E7',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
  },
  emptyBody: {
    color: '#71717A',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 12,
    marginTop: 16,
    textAlign: 'center',
  },
});

/**
 * P6.2 — Provider payout chronology screen.
 *
 * Surface: `payout-activity.provider`.
 *
 * Route: `/provider/payouts/[id]/chronology`
 *
 * This screen is the provider mirror of the customer payment chronology
 * (`/customer/payment/[id]/chronology`) and the admin payment forensic
 * (`/admin/payment/[id]/forensic`). All three speak DIFFERENT ontologies
 * over the SAME underlying `payment_events` collection — the projector
 * decides what each surface is allowed to see.
 *
 * Tone: governance-grade evidence trail. Provider wants to know:
 * "When were funds held? When were they transferred to my Stripe? Did a
 * dispute or refund touch this payout?" Each event is an evidence row,
 * not a marketing message.
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
  useProviderPayoutChronology,
  type ProviderPayoutEvent,
  type ProviderPayoutKind,
  type ProviderPayoutTone,
  dedupKey,
} from '../../../../src/provider/payout-chronology';

// ── Kind → (label, description, tone, isSelfAction)
//
// Closed table. The 8 provider-visible kinds from the F.3 projector,
// each humanized at THIS surface only. No "shared chronology kit" —
// customer/admin deliberately do NOT humanize kinds the same way. This
// is the boundary between `payout-activity.provider` and other surfaces.
const KIND_LABEL: Record<
  ProviderPayoutKind,
  { label: string; description: string; tone: ProviderPayoutTone; isSelfAction: boolean }
> = {
  'escrow.held': {
    label: 'Средства заблокированы платформой',
    description: 'Клиент оплатил — деньги в безопасности до завершения работ',
    tone: 'neutral',
    isSelfAction: false,
  },
  'escrow.released': {
    label: 'Платформа разблокировала средства',
    description: 'Сейчас будет инициирован перевод на ваш счёт',
    tone: 'positive',
    isSelfAction: false,
  },
  'transfer.initiated': {
    label: 'Перевод инициирован',
    description: 'Stripe начал перевод средств на ваш банковский счёт',
    tone: 'neutral',
    isSelfAction: false,
  },
  'transfer.succeeded': {
    label: 'Средства поступили на ваш счёт',
    description: 'Перевод завершён успешно',
    tone: 'celebratory',
    isSelfAction: false,
  },
  'transfer.failed': {
    label: 'Перевод не прошёл',
    description: 'Свяжитесь с поддержкой — может потребоваться обновление KYC',
    tone: 'alert',
    isSelfAction: false,
  },
  'refund.succeeded': {
    label: 'Возврат клиенту выполнен',
    description: 'Часть или вся сумма возвращена клиенту',
    tone: 'alert',
    isSelfAction: false,
  },
  'dispute.linked': {
    label: 'Открыт спор по сделке',
    description: 'Средства заморожены до решения. Загрузите доказательства',
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

const TONE_TO_COLOR: Record<ProviderPayoutTone, string> = {
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

function ChronologyRow({ event }: { event: ProviderPayoutEvent }) {
  // If a kind ever arrives that isn't in our table (forward-compat),
  // fall back to a neutral rendering rather than crashing the screen.
  const fallback = {
    label: event.kind,
    description: '',
    tone: 'neutral' as ProviderPayoutTone,
    isSelfAction: false,
  };
  const entry =
    (KIND_LABEL as Record<string, typeof fallback>)[event.kind] || fallback;
  const color = TONE_TO_COLOR[entry.tone];
  // Provider prefers payoutAmount (their actual receivable) over amount
  // when both are present — amount is the gross customer charge,
  // payoutAmount is what landed in their Stripe.
  const payoutAmountStr = formatAmount(event.meta?.payoutAmount, event.meta?.currency);
  const grossAmountStr = formatAmount(event.meta?.amount, event.meta?.currency);

  return (
    <View style={styles.row} testID={`provider-payout-row-${event.id}`}>
      <View style={styles.timelineRail}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={styles.railLine} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowHeader}>
          <Text style={styles.label} numberOfLines={2}>
            {entry.label}
          </Text>
        </View>
        {entry.description ? (
          <Text style={styles.description}>{entry.description}</Text>
        ) : null}
        {payoutAmountStr ? (
          <Text style={styles.metaLineStrong}>
            На счёт · {payoutAmountStr}
          </Text>
        ) : grossAmountStr ? (
          <Text style={styles.metaLineStrong}>{grossAmountStr}</Text>
        ) : null}
        {event.meta?.transferRef ? (
          <Text style={styles.metaLine}>
            Stripe · {String(event.meta.transferRef)}
          </Text>
        ) : null}
        {event.meta?.arrivalEta ? (
          <Text style={styles.metaLine}>
            Поступление · {String(event.meta.arrivalEta)}
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

export default function ProviderPayoutChronologyScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const paymentId = typeof params.id === 'string' ? params.id : null;
  const { events, status, lastError, refresh } =
    useProviderPayoutChronology(paymentId);

  const statusInfo = STATUS_LABEL[status] ?? STATUS_LABEL.idle;
  const isInitialLoad = status === 'hydrating' && events.length === 0;

  // Show last payoutAmount as side-info — what most recently landed.
  const lastPayoutInfo = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (typeof e.meta?.payoutAmount === 'number') {
        return formatAmount(e.meta.payoutAmount, e.meta.currency) ?? null;
      }
      if (typeof e.meta?.amount === 'number') {
        return formatAmount(e.meta.amount, e.meta.currency) ?? null;
      }
    }
    return null;
  }, [events]);

  return (
    <SafeAreaView
      style={styles.container}
      testID="provider-payout-chronology-screen"
    >
      <Stack.Screen
        options={{
          title: 'Движение выплаты',
          headerStyle: { backgroundColor: '#0c0c0c' },
          headerTintColor: '#fff',
        }}
      />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          testID="provider-payout-chronology-back-button"
          accessibilityLabel="Назад"
        >
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Движение выплаты</Text>
          {paymentId ? (
            <Text style={styles.headerSub} numberOfLines={1}>
              #{paymentId.slice(0, 12)}
              {lastPayoutInfo ? `  ·  ${lastPayoutInfo}` : ''}
            </Text>
          ) : null}
        </View>
        <View
          style={styles.statusPill}
          testID="provider-payout-chronology-status-pill"
        >
          <View
            style={[styles.statusDot, { backgroundColor: statusInfo.color }]}
            testID={`provider-payout-chronology-status-${status}`}
          />
          <Text style={[styles.statusText, { color: statusInfo.color }]}>
            {statusInfo.text}
          </Text>
        </View>
      </View>

      {isInitialLoad ? (
        <View
          style={styles.empty}
          testID="provider-payout-chronology-loading"
        >
          <ActivityIndicator color="#FACC15" />
        </View>
      ) : events.length === 0 ? (
        <View style={styles.empty} testID="provider-payout-chronology-empty">
          <Ionicons name="cash-outline" size={48} color="#3F3F46" />
          <Text style={styles.emptyTitle}>Пока нет движений</Text>
          <Text style={styles.emptyBody}>
            Здесь появятся этапы: блокировка средств, перевод на ваш счёт,
            возвраты и споры.
          </Text>
          {lastError ? (
            <Text
              style={styles.errorText}
              testID="provider-payout-chronology-error"
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
          testID="provider-payout-chronology-list"
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

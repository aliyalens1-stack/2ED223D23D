/**
 * P0.b.C.d.UI.b — Provider booking timeline screen.
 *
 * Route: `/provider/booking/[id]/timeline`
 *
 * Operational view (execution-oriented), distinct from the customer
 * screen even where the events overlap.
 *
 * ──────────────────────────────────────────────────────────────────
 * IMPORTANT GUARDRAIL — Realtime informs, does NOT authorize.
 * ──────────────────────────────────────────────────────────────────
 * This screen renders the booking_timeline projection. It MUST NOT
 * be the source of truth for action legality. If/when an
 * "accept / depart / arrive / start / complete" CTA gets added,
 * the legality check must come from a separate REST query against
 * the booking resource — never from the presence/absence of a WS
 * frame here. Otherwise the timeline accidentally becomes a state
 * machine authority and a dropped frame becomes a denied action.
 *
 * For UI.b we deliberately render NO action buttons. The screen is
 * read-only situational awareness.
 */
import React from 'react';
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
  useProviderBookingTimeline,
  type ProviderTimelineEvent,
  type ProviderTimelineTone,
  providerDedupKey,
} from '../../../../src/provider/booking-timeline';

// Provider tone palette — DIFFERENT from customer. Action-required is
// yellow (urgent), settled is green (closed), alert is red.
const PROVIDER_TONE_TO_COLOR: Record<ProviderTimelineTone, string> = {
  action_required: '#F59E0B',
  in_flight: '#38BDF8',
  settled: '#22C55E',
  alert: '#EF4444',
  neutral: '#9CA3AF',
};

const PROVIDER_STATUS_LABEL: Record<string, { text: string; color: string }> = {
  idle: { text: '—', color: '#6B7280' },
  hydrating: { text: 'Загрузка…', color: '#9CA3AF' },
  live: { text: 'Live', color: '#22C55E' },
  reconnecting: { text: 'Восстановление…', color: '#F59E0B' },
  offline: { text: 'Офлайн', color: '#EF4444' },
};

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

function formatPayoutAmount(value: number | string | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) return String(value);
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ProviderRow({ event }: { event: ProviderTimelineEvent }) {
  const color = PROVIDER_TONE_TO_COLOR[event.tone] ?? PROVIDER_TONE_TO_COLOR.neutral;
  const payout = formatPayoutAmount(event.meta?.payoutAmount);
  return (
    <View style={styles.row} testID={`provider-timeline-row-${event.key}`}>
      <View style={styles.timelineRail}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={styles.railLine} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowHeader}>
          <Text style={styles.label} numberOfLines={2}>
            {event.label}
          </Text>
          {event.isSelfAction ? (
            <View
              style={styles.selfBadge}
              testID={`provider-timeline-self-${event.key}`}
            >
              <Text style={styles.selfBadgeText}>вы</Text>
            </View>
          ) : null}
        </View>
        {event.description ? (
          <Text style={styles.description}>{event.description}</Text>
        ) : null}
        {event.meta?.eta ? (
          <Text style={styles.metaLine}>ETA · {String(event.meta.eta)}</Text>
        ) : null}
        {event.meta?.customerNote ? (
          <View style={styles.noteBox}>
            <Text style={styles.noteHeader}>От клиента</Text>
            <Text style={styles.noteBody}>{String(event.meta.customerNote)}</Text>
          </View>
        ) : null}
        {event.meta?.note ? (
          <View style={styles.noteBox}>
            <Text style={styles.noteHeader}>Заметка</Text>
            <Text style={styles.noteBody}>{String(event.meta.note)}</Text>
          </View>
        ) : null}
        {event.meta?.reason ? (
          <Text style={styles.metaLine}>Причина · {String(event.meta.reason)}</Text>
        ) : null}
        {payout ? (
          <Text style={styles.payoutLine} testID={`provider-timeline-payout-${event.key}`}>
            Выплата · €{payout}
          </Text>
        ) : null}
        <Text style={styles.timestamp}>{formatTimestamp(event.at)}</Text>
      </View>
    </View>
  );
}

export default function ProviderBookingTimelineScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const bookingId = typeof params.id === 'string' ? params.id : null;
  const { events, status, lastError, refresh } =
    useProviderBookingTimeline(bookingId);

  const statusInfo = PROVIDER_STATUS_LABEL[status] ?? PROVIDER_STATUS_LABEL.idle;
  const isInitialLoad = status === 'hydrating' && events.length === 0;

  return (
    <SafeAreaView style={styles.container} testID="provider-timeline-screen">
      <Stack.Screen
        options={{
          title: 'Хронология задачи',
          headerStyle: { backgroundColor: '#0c0c0c' },
          headerTintColor: '#fff',
        }}
      />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          testID="provider-timeline-back-button"
          accessibilityLabel="Назад"
        >
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Хронология задачи</Text>
          {bookingId ? (
            <Text style={styles.headerSub} numberOfLines={1}>
              #{bookingId.slice(0, 8)}
            </Text>
          ) : null}
        </View>
        <View
          style={styles.statusPill}
          testID="provider-timeline-status-pill"
        >
          <View
            style={[styles.statusDot, { backgroundColor: statusInfo.color }]}
            testID={`provider-timeline-status-${status}`}
          />
          <Text style={[styles.statusText, { color: statusInfo.color }]}>
            {statusInfo.text}
          </Text>
        </View>
      </View>

      {isInitialLoad ? (
        <View style={styles.empty} testID="provider-timeline-loading">
          <ActivityIndicator color="#F59E0B" />
        </View>
      ) : events.length === 0 ? (
        <View style={styles.empty} testID="provider-timeline-empty">
          <Ionicons name="construct-outline" size={48} color="#3F3F46" />
          <Text style={styles.emptyTitle}>Задача ещё не открыта</Text>
          <Text style={styles.emptyBody}>
            Здесь появятся ключевые шаги исполнения по этой задаче.
          </Text>
          {lastError ? (
            <Text style={styles.errorText} testID="provider-timeline-error">
              {lastError}
            </Text>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => providerDedupKey(item)}
          renderItem={({ item }) => <ProviderRow event={item} />}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={refresh}
              tintColor="#F59E0B"
            />
          }
          testID="provider-timeline-list"
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0c0c0c',
  },
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
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
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
  label: { color: '#fff', fontSize: 15, fontWeight: '600', flex: 1 },
  selfBadge: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: '#F59E0B',
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
  payoutLine: {
    color: '#22C55E',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
  },
  noteBox: {
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#18181B',
    borderLeftWidth: 3,
    borderLeftColor: '#38BDF8',
  },
  noteHeader: {
    color: '#71717A',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  noteBody: { color: '#E4E4E7', fontSize: 13, lineHeight: 18 },
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

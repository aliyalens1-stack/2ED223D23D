/**
 * P0.b.C.d.UI.a — Customer booking timeline screen.
 *
 * This screen is the FIRST consumer of the realtime fanout. It is
 * deliberately the smallest reasonable surface: hydrate + WS append +
 * 30s reconciliation, with a calm visual affordance for connection
 * status. No actions, no editing, no fanout to other domains.
 *
 * Route:  /customer/booking/[id]/timeline
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
  useCustomerBookingTimeline,
  type CustomerTimelineEvent,
  type CustomerTimelineTone,
  dedupKey,
} from '../../../../src/customer/booking-timeline';

const TONE_TO_COLOR: Record<CustomerTimelineTone, string> = {
  neutral: '#9CA3AF',
  positive: '#FACC15', // brand yellow (matches app)
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

function TimelineRow({ event }: { event: CustomerTimelineEvent }) {
  const color = TONE_TO_COLOR[event.tone] ?? TONE_TO_COLOR.neutral;
  return (
    <View
      style={styles.row}
      testID={`customer-timeline-row-${event.key}`}
    >
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
            <View style={styles.selfBadge} testID={`customer-timeline-self-${event.key}`}>
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
        {event.meta?.reason ? (
          <Text style={styles.metaLine}>Причина · {String(event.meta.reason)}</Text>
        ) : null}
        <Text style={styles.timestamp}>{formatTimestamp(event.at)}</Text>
      </View>
    </View>
  );
}

export default function CustomerBookingTimelineScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const bookingId = typeof params.id === 'string' ? params.id : null;
  const { events, status, lastError, refresh } =
    useCustomerBookingTimeline(bookingId);

  const statusInfo = STATUS_LABEL[status] ?? STATUS_LABEL.idle;
  const isInitialLoad = status === 'hydrating' && events.length === 0;

  return (
    <SafeAreaView style={styles.container} testID="customer-timeline-screen">
      <Stack.Screen
        options={{
          title: 'Хронология заказа',
          headerStyle: { backgroundColor: '#0c0c0c' },
          headerTintColor: '#fff',
        }}
      />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          testID="customer-timeline-back-button"
          accessibilityLabel="Назад"
        >
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Хронология</Text>
          {bookingId ? (
            <Text style={styles.headerSub} numberOfLines={1}>
              #{bookingId.slice(0, 8)}
            </Text>
          ) : null}
        </View>
        <View
          style={styles.statusPill}
          testID="customer-timeline-status-pill"
        >
          <View
            style={[styles.statusDot, { backgroundColor: statusInfo.color }]}
            testID={`customer-timeline-status-${status}`}
          />
          <Text style={[styles.statusText, { color: statusInfo.color }]}>
            {statusInfo.text}
          </Text>
        </View>
      </View>

      {/* Body */}
      {isInitialLoad ? (
        <View style={styles.empty} testID="customer-timeline-loading">
          <ActivityIndicator color="#FACC15" />
        </View>
      ) : events.length === 0 ? (
        <View style={styles.empty} testID="customer-timeline-empty">
          <Ionicons name="time-outline" size={48} color="#3F3F46" />
          <Text style={styles.emptyTitle}>Событий пока нет</Text>
          <Text style={styles.emptyBody}>
            Здесь появятся ключевые шаги исполнителя по вашему заказу.
          </Text>
          {lastError ? (
            <Text style={styles.errorText} testID="customer-timeline-error">
              {lastError}
            </Text>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => dedupKey(item)}
          renderItem={({ item }) => <TimelineRow event={item} />}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={refresh}
              tintColor="#FACC15"
            />
          }
          testID="customer-timeline-list"
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
  headerCenter: {
    flex: 1,
    paddingHorizontal: 8,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  headerSub: {
    color: '#6B7280',
    fontSize: 12,
    marginTop: 2,
  },
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
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
  },
  row: {
    flexDirection: 'row',
    minHeight: 80,
  },
  timelineRail: {
    width: 24,
    alignItems: 'center',
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginTop: 6,
  },
  railLine: {
    flex: 1,
    width: 2,
    backgroundColor: '#1F1F23',
    marginTop: 4,
  },
  rowBody: {
    flex: 1,
    paddingLeft: 12,
    paddingBottom: 18,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
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
  metaLine: {
    color: '#A1A1AA',
    fontSize: 12,
    marginTop: 4,
  },
  timestamp: {
    color: '#6B7280',
    fontSize: 11,
    marginTop: 6,
  },
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

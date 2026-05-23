/**
 * P0.b.C.d.UI.c — Inspector job timeline screen.
 *
 * Route: `/inspector/jobs/[jobId]/timeline`
 *
 * Field workflow surface — inspection-centric, NOT booking-centric.
 *
 * Wire identity discipline:
 *   * Route param is `jobId`, not `bookingId` / `requestId`.
 *   * The hook never asks for the underlying request id.
 *   * The screen displays the job id chip in the header. No
 *     booking aggregate identifier is shown.
 *
 * Visual vocabulary tuned to documentation workflow:
 *   * ready        — assignment received, claim & depart
 *   * travel       — en route
 *   * on_site      — at the object
 *   * documenting  — actively inspecting / running checklist
 *   * submitted    — report dispatched, job closing out
 *   * closed       — final cancel / dispute resolution
 *   * attention    — exception requiring inspector awareness
 *
 * Same legality guardrail as provider: timeline INFORMS, never
 * AUTHORIZES. No action CTAs. Future "depart / arrive / start /
 * submit" buttons must read action legality from the job REST
 * resource, not from this realtime stream.
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
  useInspectorJobTimeline,
  type InspectorTimelineEvent,
  type InspectorTimelineTone,
  inspectorDedupKey,
} from '../../../../src/inspector/booking-timeline';

// Inspector tone palette — DIFFERENT from customer and provider.
// Cooler / more clinical / documentation-flow oriented.
const INSPECTOR_TONE_TO_COLOR: Record<InspectorTimelineTone, string> = {
  ready: '#A78BFA',       // anticipation, claim-time
  travel: '#38BDF8',      // motion
  on_site: '#2DD4BF',     // arrival / presence
  documenting: '#FACC15', // active work
  submitted: '#22C55E',   // delivered
  closed: '#9CA3AF',      // resolved/final
  attention: '#EF4444',   // exception
};

const INSPECTOR_STATUS_LABEL: Record<string, { text: string; color: string }> = {
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

function formatPayout(value: number | string | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) return String(value);
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function InspectorRow({ event }: { event: InspectorTimelineEvent }) {
  const color =
    INSPECTOR_TONE_TO_COLOR[event.tone] ?? INSPECTOR_TONE_TO_COLOR.closed;
  const payout = formatPayout(event.meta?.inspectorPayoutAmount);
  return (
    <View
      style={styles.row}
      testID={`inspector-timeline-row-${event.key}`}
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
            <View
              style={styles.selfBadge}
              testID={`inspector-timeline-self-${event.key}`}
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
        {event.meta?.reportId ? (
          <Text
            style={styles.reportLine}
            testID={`inspector-timeline-report-${event.key}`}
          >
            Отчёт #{String(event.meta.reportId)}
          </Text>
        ) : null}
        {event.meta?.note ? (
          <View style={styles.noteBox}>
            <Text style={styles.noteHeader}>Заметка</Text>
            <Text style={styles.noteBody}>{String(event.meta.note)}</Text>
          </View>
        ) : null}
        {event.meta?.reason ? (
          <Text style={styles.metaLine}>
            Причина · {String(event.meta.reason)}
          </Text>
        ) : null}
        {payout ? (
          <Text
            style={styles.payoutLine}
            testID={`inspector-timeline-payout-${event.key}`}
          >
            Ваша выплата · €{payout}
          </Text>
        ) : null}
        <Text style={styles.timestamp}>{formatTimestamp(event.at)}</Text>
      </View>
    </View>
  );
}

export default function InspectorJobTimelineScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ jobId: string }>();
  const jobId = typeof params.jobId === 'string' ? params.jobId : null;
  const { events, status, lastError, refresh, staleDropCount } =
    useInspectorJobTimeline(jobId);

  const statusInfo =
    INSPECTOR_STATUS_LABEL[status] ?? INSPECTOR_STATUS_LABEL.idle;
  const isInitialLoad = status === 'hydrating' && events.length === 0;

  return (
    <SafeAreaView style={styles.container} testID="inspector-timeline-screen">
      <Stack.Screen
        options={{
          title: 'Хронология осмотра',
          headerStyle: { backgroundColor: '#0c0c0c' },
          headerTintColor: '#fff',
        }}
      />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          testID="inspector-timeline-back-button"
          accessibilityLabel="Назад"
        >
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Хронология осмотра</Text>
          {jobId ? (
            <Text
              style={styles.headerSub}
              numberOfLines={1}
              testID="inspector-timeline-jobid"
            >
              Job #{jobId.slice(0, 8)}
            </Text>
          ) : null}
        </View>
        <View
          style={styles.statusPill}
          testID="inspector-timeline-status-pill"
        >
          <View
            style={[styles.statusDot, { backgroundColor: statusInfo.color }]}
            testID={`inspector-timeline-status-${status}`}
          />
          <Text style={[styles.statusText, { color: statusInfo.color }]}>
            {statusInfo.text}
          </Text>
        </View>
      </View>

      {staleDropCount > 0 ? (
        <View
          style={styles.staleBanner}
          testID="inspector-timeline-stale-banner"
        >
          <Ionicons name="warning-outline" size={14} color="#FACC15" />
          <Text style={styles.staleText}>
            Сброшено локальных событий без подтверждения сервером: {staleDropCount}
          </Text>
        </View>
      ) : null}

      {isInitialLoad ? (
        <View style={styles.empty} testID="inspector-timeline-loading">
          <ActivityIndicator color="#A78BFA" />
        </View>
      ) : events.length === 0 ? (
        <View style={styles.empty} testID="inspector-timeline-empty">
          <Ionicons name="clipboard-outline" size={48} color="#3F3F46" />
          <Text style={styles.emptyTitle}>Задача ожидает старта</Text>
          <Text style={styles.emptyBody}>
            Здесь появятся шаги вашего осмотра: назначение, выезд,
            работа на месте, отправка отчёта.
          </Text>
          {lastError ? (
            <Text
              style={styles.errorText}
              testID="inspector-timeline-error"
            >
              {lastError}
            </Text>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => inspectorDedupKey(item)}
          renderItem={({ item }) => <InspectorRow event={item} />}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={refresh}
              tintColor="#A78BFA"
            />
          }
          testID="inspector-timeline-list"
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
  headerSub: { color: '#A78BFA', fontSize: 12, marginTop: 2 },
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
  staleBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#1F1B0B',
    borderBottomColor: '#3F2D08',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  staleText: {
    color: '#FACC15',
    fontSize: 11,
    marginLeft: 6,
    flex: 1,
  },
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
    backgroundColor: '#A78BFA',
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
  reportLine: {
    color: '#2DD4BF',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
  },
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
    borderLeftColor: '#FACC15',
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

/**
 * P0.b.C.d.UI.d — Admin booking forensic stream screen.
 *
 * Route: `/admin/booking/[id]/forensic`
 *
 * INTENTIONALLY does not look like the 3 timeline screens.
 *
 *   * Monospace typography — terminal/log aesthetic
 *   * Dense rows (single line of raw header + collapsible meta)
 *   * Raw `action` shown verbatim (`mark_in_progress`, `:rejected`)
 *   * Status pill is small, no celebratory greens for completed work
 *   * Yellow-on-black colour family (audit console)
 *   * No "ВЫ" badge — admin is observing other actors
 *
 * Audit-role guard: if hook returns `status === 'forbidden'`, render
 * a minimal forbidden state. Do NOT retry, do NOT show data.
 */
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
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
  useAdminBookingForensicStream,
  type ForensicRow,
} from '../../../../src/admin/booking-forensic';

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  idle: { label: '—', color: '#6B7280' },
  hydrating: { label: 'HYDRATE', color: '#A1A1AA' },
  live: { label: 'LIVE', color: '#22C55E' },
  reconnecting: { label: 'RECONNECT', color: '#FACC15' },
  offline: { label: 'OFFLINE', color: '#EF4444' },
  forbidden: { label: 'DENIED', color: '#EF4444' },
};

function shortIso(iso: string | null): string {
  if (!iso) return '             —';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 19);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso.slice(0, 19);
  }
}

function isRejected(action: string): boolean {
  return action.endsWith(':rejected');
}

const SCROLL_DOWN_FROM = 6; // show "scroll latest" hint after this many rows

function ForensicLine({ row }: { row: ForensicRow }) {
  const [expanded, setExpanded] = useState(false);
  const rejected = isRejected(row.action || '');

  const actor = `${row.actorRole || '?'}/${(row.actorId || '?').slice(0, 8)}`;
  const transition =
    row.fromStatus || row.toStatus
      ? `${row.fromStatus ?? '?'}→${row.toStatus ?? '?'}`
      : '';

  return (
    <Pressable
      onPress={() => setExpanded((v) => !v)}
      style={[styles.line, rejected && styles.lineRejected]}
      testID={`forensic-row-${row.id}`}
    >
      <View style={styles.lineHeader}>
        <Text style={styles.timestamp}>{shortIso(row.timestamp)}</Text>
        <Text
          style={[
            styles.actionCell,
            rejected ? styles.actionRejected : styles.actionNormal,
          ]}
          numberOfLines={1}
        >
          {row.action || '?'}
        </Text>
        <Text style={styles.actorCell} numberOfLines={1}>
          {actor}
        </Text>
      </View>
      {transition ? (
        <Text style={styles.transition}>  {transition}</Text>
      ) : null}
      {expanded ? (
        <View style={styles.metaBlock} testID={`forensic-meta-${row.id}`}>
          <Text style={styles.metaJson} selectable>
            {JSON.stringify(
              { id: row.id, bookingId: row.bookingId, meta: row.meta ?? {} },
              null,
              2
            )}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export default function AdminForensicStreamScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; scope?: string }>();
  const bookingId = typeof params.id === 'string' ? params.id : null;
  const scopeParam =
    params.scope === 'service_request' || params.scope === 'car_request'
      ? params.scope
      : 'web_booking';

  const { rows, status, lastError, rowCount, refresh } =
    useAdminBookingForensicStream(bookingId, scopeParam);

  const statusStyle = STATUS_STYLE[status] ?? STATUS_STYLE.idle;
  const isInitialLoad = status === 'hydrating' && rows.length === 0;
  const rejectedCount = useMemo(
    () => rows.filter((r) => isRejected(r.action || '')).length,
    [rows]
  );

  return (
    <SafeAreaView style={styles.container} testID="admin-forensic-screen">
      <Stack.Screen
        options={{
          title: 'Forensic',
          headerStyle: { backgroundColor: '#0a0a0a' },
          headerTintColor: '#fff',
        }}
      />

      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          testID="admin-forensic-back-button"
          accessibilityLabel="Назад"
        >
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>FORENSIC · booking_timeline</Text>
          {bookingId ? (
            <Text style={styles.headerSub} numberOfLines={1}>
              {scopeParam} / {bookingId}
            </Text>
          ) : null}
        </View>
        <View
          style={styles.statusPill}
          testID="admin-forensic-status-pill"
        >
          <View
            style={[styles.statusDot, { backgroundColor: statusStyle.color }]}
            testID={`admin-forensic-status-${status}`}
          />
          <Text style={[styles.statusText, { color: statusStyle.color }]}>
            {statusStyle.label}
          </Text>
        </View>
      </View>

      <View style={styles.countsBar} testID="admin-forensic-counts-bar">
        <Text style={styles.countItem}>
          rows: <Text style={styles.countValue}>{rowCount}</Text>
        </Text>
        <Text style={styles.countItem}>
          rejected:{' '}
          <Text
            style={[
              styles.countValue,
              rejectedCount > 0 && styles.countValueWarn,
            ]}
            testID="admin-forensic-rejected-count"
          >
            {rejectedCount}
          </Text>
        </Text>
        {rowCount >= SCROLL_DOWN_FROM ? (
          <Text style={styles.scrollHint}>↓ tap row to expand meta</Text>
        ) : null}
      </View>

      {status === 'forbidden' ? (
        <View style={styles.forbidden} testID="admin-forensic-forbidden">
          <Ionicons name="lock-closed" size={40} color="#EF4444" />
          <Text style={styles.forbiddenTitle}>Доступ запрещён</Text>
          <Text style={styles.forbiddenBody}>
            {lastError || 'Admin role required for forensic stream'}
          </Text>
        </View>
      ) : isInitialLoad ? (
        <View style={styles.empty} testID="admin-forensic-loading">
          <ActivityIndicator color="#FACC15" />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.empty} testID="admin-forensic-empty">
          <Ionicons name="document-text-outline" size={40} color="#3F3F46" />
          <Text style={styles.emptyTitle}>booking_timeline: 0 rows</Text>
          <Text style={styles.emptyBody}>
            Никаких операций по этой брони не зафиксировано.
          </Text>
          {lastError ? (
            <Text style={styles.errorText} testID="admin-forensic-error">
              {lastError}
            </Text>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ForensicLine row={item} />}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={refresh}
              tintColor="#FACC15"
            />
          }
          testID="admin-forensic-list"
        />
      )}
    </SafeAreaView>
  );
}

// Monospace family — terminal/log feel. We don't rely on a custom
// font; the platform's default monospace is fine.
const MONO =
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (require('react-native').Platform.OS === 'ios'
    ? 'Menlo'
    : 'monospace') as string;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomColor: '#1F1F23',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: { flex: 1, paddingHorizontal: 8 },
  headerTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO,
    letterSpacing: 0.5,
  },
  headerSub: {
    color: '#FACC15',
    fontSize: 11,
    marginTop: 2,
    fontFamily: MONO,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#18181B',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#27272A',
  },
  statusDot: { width: 7, height: 7, borderRadius: 4, marginRight: 5 },
  statusText: { fontSize: 10, fontWeight: '700', fontFamily: MONO },
  countsBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#0c0c0c',
    borderBottomColor: '#1F1F23',
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  countItem: {
    color: '#71717A',
    fontSize: 11,
    fontFamily: MONO,
    marginRight: 16,
  },
  countValue: { color: '#E4E4E7', fontWeight: '700' },
  countValueWarn: { color: '#FACC15' },
  scrollHint: {
    color: '#52525B',
    fontSize: 10,
    fontFamily: MONO,
    marginLeft: 'auto',
  },
  listContent: {
    paddingHorizontal: 0,
    paddingTop: 4,
    paddingBottom: 32,
  },
  line: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: '#0a0a0a',
  },
  lineRejected: {
    backgroundColor: '#1A0A0A',
  },
  lineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  timestamp: {
    color: '#71717A',
    fontFamily: MONO,
    fontSize: 11,
    width: 110,
  },
  actionCell: {
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
    marginHorizontal: 8,
  },
  actionNormal: { color: '#E4E4E7' },
  actionRejected: { color: '#F87171' },
  actorCell: {
    color: '#A1A1AA',
    fontFamily: MONO,
    fontSize: 11,
    maxWidth: 130,
  },
  transition: {
    color: '#52525B',
    fontFamily: MONO,
    fontSize: 10,
    marginTop: 2,
  },
  metaBlock: {
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: '#000',
    borderRadius: 4,
    borderLeftColor: '#FACC15',
    borderLeftWidth: 2,
  },
  metaJson: {
    color: '#D4D4D8',
    fontFamily: MONO,
    fontSize: 10,
    lineHeight: 14,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#18181B',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: '#E4E4E7',
    fontSize: 14,
    fontFamily: MONO,
    fontWeight: '700',
    marginTop: 16,
  },
  emptyBody: {
    color: '#71717A',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 18,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 11,
    fontFamily: MONO,
    marginTop: 16,
    textAlign: 'center',
  },
  forbidden: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  forbiddenTitle: {
    color: '#EF4444',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: MONO,
    marginTop: 16,
  },
  forbiddenBody: {
    color: '#A1A1AA',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    fontFamily: MONO,
  },
});

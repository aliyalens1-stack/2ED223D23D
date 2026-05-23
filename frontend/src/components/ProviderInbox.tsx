// ═══════════════════════════════════════════════════════════
// 🔥 ProviderInbox — Inbox PRO operational center
// 3 buckets: Новые / В работе / Завершённые
// Source: GET /api/provider/inbox?providerSlug=...
// Actions: start (confirmed → in_progress) / complete (in_progress → completed)
// Realtime: refetch on provider:job_updated + provider:request_taken
// ═══════════════════════════════════════════════════════════
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useThemeContext } from '../context/ThemeContext';
import { providerInboxProAPI } from '../services/api';
import { useProviderRealtime } from '../hooks/useWebSocket';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

type Booking = {
  id: string;
  bookingNumber?: string;
  status: string;
  problemLabel?: string;
  problemText?: string;
  priceEstimate?: number | null;
  finalPrice?: number | null;
  etaMinutes?: number | null;
  distanceKm?: number | null;
  surge?: number | null;
  surgeLabel?: string | null;
  acceptedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

type InboxResponse = {
  counts: { new: number; active: number; completed: number };
  earnedFromCompleted: number;
  new: Booking[];
  active: Booking[];
  completed: Booking[];
};

type TabKey = 'new' | 'active' | 'done';

export default function ProviderInbox({ providerSlug }: { providerSlug: string }) {
  const { colors } = useThemeContext();
  const [tab, setTab] = useState<TabKey>('new');
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchInbox = useCallback(async () => {
    try {
      const r = await providerInboxProAPI.getInbox(providerSlug);
      setData(r.data);
    } catch (e) {
      console.log('inbox fetch error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [providerSlug]);

  useEffect(() => { fetchInbox(); }, [fetchInbox]);

  // Realtime: refetch whenever a job's status changed OR a new request was accepted
  useProviderRealtime({
    onRequestTaken: () => fetchInbox(),
    onJobUpdated:   () => fetchInbox(),
    onNewRequest:   () => fetchInbox(),
  });

  const onRefresh = () => { setRefreshing(true); fetchInbox(); };

  const list: Booking[] = useMemo(() => {
    if (!data) return [];
    if (tab === 'new')    return data.new;
    if (tab === 'active') return data.active;
    return data.completed;
  }, [tab, data]);

  const handleAction = async (booking: Booking, action: 'start' | 'complete') => {
    if (busyId) return;
    setBusyId(booking.id);
    try {
      const r = await providerInboxProAPI.bookingAction(booking.id, action);
      if (r?.data?.to === 'completed') {
        try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}); } catch {}
      } else {
        try { Haptics.selectionAsync().catch(() => {}); } catch {}
      }
      await fetchInbox();
      if (action === 'start')    setTab('active');
      if (action === 'complete') setTab('done');
    } catch (e) {
      console.log('booking action error:', e);
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Tabs */}
      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        <TabBtn label="Новые"        count={data?.counts.new ?? 0}       active={tab === 'new'}    onPress={() => setTab('new')}    testID="inbox-tab-new" />
        <TabBtn label="В работе"     count={data?.counts.active ?? 0}    active={tab === 'active'} onPress={() => setTab('active')} testID="inbox-tab-active" />
        <TabBtn label="Завершённые"  count={data?.counts.completed ?? 0} active={tab === 'done'}   onPress={() => setTab('done')}   testID="inbox-tab-done" />
      </View>

      {/* Earnings strip (только в Завершённые) */}
      {tab === 'done' && (data?.earnedFromCompleted ?? 0) > 0 && (
        <View style={[styles.earningsStrip, { backgroundColor: colors.brandSoft }]}>
          <Ionicons name="cash" size={18} color={colors.brand} />
          <Text style={[styles.earningsText, { color: colors.text }]}>
            Заработано: <Text style={{ color: colors.brand, fontWeight: '800' }}>₴{data?.earnedFromCompleted}</Text>
          </Text>
        </View>
      )}

      <ScrollView
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
      >
        {list.length === 0 ? (
          <EmptyState tab={tab} colors={colors} />
        ) : (
          list.map((b) => (
            <BookingCard
              key={b.id}
              booking={b}
              tab={tab}
              busy={busyId === b.id}
              onStart={() => handleAction(b, 'start')}
              onComplete={() => handleAction(b, 'complete')}
            />
          ))
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

// ─── Tab button ─────────────────────────────────
function TabBtn({ label, count, active, onPress, testID }: any) {
  const { colors } = useThemeContext();
  return (
    <TouchableOpacity testID={testID} style={styles.tabBtn} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.tabRow}>
        <Text style={[styles.tabLabel, { color: active ? colors.text : colors.textSecondary, fontWeight: active ? '800' : '500' }]}>
          {label}
        </Text>
        {count > 0 && (
          <View style={[styles.tabCount, { backgroundColor: active ? colors.brand : colors.card }]}>
            <Text style={[styles.tabCountText, { color: active ? (colors.onPrimary || colors.brandText) : colors.textSecondary }]}>{count}</Text>
          </View>
        )}
      </View>
      {active && <View style={[styles.tabUnderline, { backgroundColor: colors.brand }]} />}
    </TouchableOpacity>
  );
}

// ─── Booking card ────────────────────────────────
function BookingCard({
  booking, tab, busy, onStart, onComplete,
}: {
  booking: Booking;
  tab: TabKey;
  busy: boolean;
  onStart: () => void;
  onComplete: () => void;
}) {
  const { colors } = useThemeContext();
  const price = booking.finalPrice ?? booking.priceEstimate;

  return (
    <View
      testID={`booking-card-${booking.id}`}
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={styles.cardTop}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.problemLabel, { color: colors.text }]} numberOfLines={1}>
            {booking.problemLabel || 'Заявка'}
          </Text>
          {!!booking.problemText && (
            <Text style={[styles.problemEcho, { color: colors.textSecondary }]} numberOfLines={2}>
              «{booking.problemText}»
            </Text>
          )}
        </View>
        {!!booking.bookingNumber && (
          <Text style={[styles.bookingNum, { color: colors.textMuted || colors.textSecondary }]}>
            {booking.bookingNumber}
          </Text>
        )}
      </View>

      <View style={styles.metaRow}>
        {booking.distanceKm != null && (
          <Meta icon="navigate-outline" text={`${booking.distanceKm} км`} />
        )}
        {booking.etaMinutes != null && (
          <Meta icon="walk-outline" text={`${booking.etaMinutes} мин`} />
        )}
        {price != null && (
          <View style={styles.metaItem}>
            <Ionicons name="cash-outline" size={13} color={colors.success || colors.brand} />
            <Text style={[styles.metaPrice, { color: colors.success || colors.brand }]}>₴{price}</Text>
          </View>
        )}
        {!!booking.surgeLabel && (booking.surge || 0) > 1 && (
          <View style={[styles.surgePill, { backgroundColor: colors.errorBg || 'rgba(239,68,68,0.12)' }]}>
            <Ionicons name="flame" size={11} color={colors.error} />
            <Text style={[styles.surgeText, { color: colors.error }]}>{booking.surgeLabel}</Text>
          </View>
        )}
        <StatusPill status={booking.status} colors={colors} />
      </View>

      {tab === 'new' && (
        <TouchableOpacity
          testID={`start-${booking.id}`}
          style={[styles.cta, { backgroundColor: colors.brand }]}
          onPress={onStart}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.onPrimary || colors.brandText} />
          ) : (
            <>
              <Ionicons name="play" size={16} color={colors.onPrimary || colors.brandText} />
              <Text style={[styles.ctaText, { color: colors.onPrimary || colors.brandText }]}>Начать</Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {tab === 'active' && (
        <TouchableOpacity
          testID={`complete-${booking.id}`}
          style={[styles.cta, { backgroundColor: colors.success || colors.success }]}
          onPress={onComplete}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={16} color="#fff" />
              <Text style={[styles.ctaText, { color: '#fff' }]}>Завершить</Text>
            </>
          )}
        </TouchableOpacity>
      )}

      {tab === 'done' && (
        <View style={styles.doneRow}>
          <Ionicons name="checkmark-done-circle" size={16} color={colors.success || colors.success} />
          <Text style={[styles.doneText, { color: colors.success || colors.success }]}>
            Выполнено • +₴{price ?? 0}
          </Text>
        </View>
      )}
    </View>
  );
}

function Meta({ icon, text }: { icon: any; text: string }) {
  const { colors } = useThemeContext();
  return (
    <View style={styles.metaItem}>
      <Ionicons name={icon} size={13} color={colors.textSecondary} />
      <Text style={[styles.metaText, { color: colors.textSecondary }]}>{text}</Text>
    </View>
  );
}

function StatusPill({ status, colors }: { status: string; colors: any }) {
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    confirmed:   { label: 'Принят',     bg: colors.brandSoft, fg: colors.brand },
    on_route:    { label: 'В пути',     bg: 'rgba(59,130,246,0.15)', fg: colors.brand },
    arrived:     { label: 'На месте',   bg: 'rgba(59,130,246,0.15)', fg: colors.brand },
    in_progress: { label: 'В работе',   bg: 'rgba(245,158,11,0.15)', fg: colors.warning },
    completed:   { label: 'Завершено',  bg: 'rgba(16,185,129,0.15)', fg: colors.success },
  };
  const m = map[status] || { label: status, bg: colors.card, fg: colors.textSecondary };
  return (
    <View style={[styles.statusPill, { backgroundColor: m.bg }]}>
      <Text style={[styles.statusPillText, { color: m.fg }]}>{m.label}</Text>
    </View>
  );
}

function EmptyState({ tab, colors }: { tab: TabKey; colors: any }) {
  const messages: Record<TabKey, { icon: any; title: string; subtitle: string }> = {
    new:    { icon: 'mail-open-outline', title: 'Нет новых',     subtitle: 'Принимайте заявки в кабинете — они появятся здесь.' },
    active: { icon: 'time-outline',      title: 'Нет в работе',  subtitle: 'Когда нажмёте «Начать» — заказ переедет сюда.' },
    done:   { icon: 'trophy-outline',    title: 'Пока пусто',    subtitle: 'Завершённые заказы и заработок появятся тут.' },
  };
  const m = messages[tab];
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.card }]}>
        <Ionicons name={m.icon as any} size={32} color={colors.textSecondary} />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{m.title}</Text>
      <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>{m.subtitle}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1 },
  center:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabBar:      { flexDirection: 'row', borderBottomWidth: 1, paddingHorizontal: 12 },
  tabBtn:      { flex: 1, paddingVertical: 14, alignItems: 'center' },
  tabRow:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tabLabel:    { fontSize: 14 },
  tabCount:    { minWidth: 22, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  tabCountText:{ fontSize: 11, fontWeight: '700' },
  tabUnderline:{ position: 'absolute', bottom: -1, height: 2, left: 16, right: 16, borderRadius: 1 },
  earningsStrip:{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  earningsText:{ fontSize: 14 },
  listContent: { padding: 16 },
  card:        { borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1 },
  cardTop:     { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 10 },
  problemLabel:{ fontSize: 16, fontWeight: '700', marginBottom: 2 },
  problemEcho: { fontSize: 12, fontStyle: 'italic' },
  bookingNum:  { fontSize: 11, fontWeight: '500' },
  metaRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12, alignItems: 'center' },
  metaItem:    { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText:    { fontSize: 12, fontWeight: '500' },
  metaPrice:   { fontSize: 13, fontWeight: '700' },
  surgePill:   { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  surgeText:   { fontSize: 10, fontWeight: '700' },
  statusPill:  { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusPillText: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  cta:         { height: 44, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  ctaText:     { fontSize: 14, fontWeight: '800' },
  doneRow:     { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  doneText:    { fontSize: 13, fontWeight: '700' },
  empty:       { alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  emptyIcon:   { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  emptyTitle:  { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  emptySubtitle: { fontSize: 13, textAlign: 'center', paddingHorizontal: 32 },
});

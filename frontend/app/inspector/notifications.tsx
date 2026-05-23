/**
 * Sprint 3 Step 2 — Inspector notifications screen.
 *
 * DB-first, polling-only (25s). No websockets. No push.
 *
 * Contract:
 *   - reads `/api/notifications/since?after=<isoLastSeen>&limit=50`
 *   - merges new rows into local list, dedupes by `id`
 *   - tap unread row → POST /api/notifications/{id}/read → optimistic update
 *   - t('inspector.prochitat_vse') → POST /api/notifications/read-all
 *   - polling interval = 25 000 ms; pauses when screen unfocused
 *
 * Local state is purely projection — refresh / app restart re-fetches
 * from server. No async storage caching: timeline is the truth.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const API = (Constants.expoConfig?.extra as any)?.EXPO_BACKEND_URL
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || process.env.EXPO_BACKEND_URL
  || '';

const POLL_INTERVAL_MS = 25_000;

interface Notification {
  id: string;
  kind: string;
  type?: string;
  title: string;
  body: string;
  text?: string;
  severity: 'info' | 'success' | 'warning' | 'critical';
  metadata?: Record<string, any>;
  isRead: boolean;
  readAt?: string | null;
  createdAt: string;
  actionUrl?: string | null;
  actorLabel?: string | null;
  sourceTimelineId?: string;
}

const TONE: Record<string, { fg: string; bg: string; dot: string }> = {
  info:     { fg: '#cbd5e1', bg: '#1e293b', dot: '#64748b' },
  success:  { fg: '#bbf7d0', bg: '#0a1a0c', dot: '#22c55e' },
  warning:  { fg: '#fde68a', bg: '#1f1908', dot: '#FFB020' },
  critical: { fg: '#fecaca', bg: '#2a1010', dot: '#ef4444' },
};

export default function InspectorNotificationsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unread, setUnread] = useState(0);
  const token = useRef<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useRef(true);

  const fetchPage = useCallback(async (opts?: { after?: string; reset?: boolean }) => {
    const t = token.current || (await AsyncStorage.getItem('auth_token'));
    if (!t) return;
    token.current = t;
    try {
      const url = new URL(`${API}/api/notifications/since`);
      if (opts?.after) url.searchParams.set('after', opts.after);
      url.searchParams.set('limit', '50');
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!isMounted.current) return;
      setUnread(data.unread || 0);
      const fresh: Notification[] = data.items || [];
      if (opts?.reset || items.length === 0) {
        setItems(fresh);
      } else {
        // Merge: dedupe by id, newest first.
        setItems((cur) => {
          const seen = new Set(cur.map((x) => x.id));
          const additions = fresh.filter((x) => !seen.has(x.id));
          if (additions.length === 0) return cur;
          return [...additions, ...cur];
        });
      }
    } catch {
      /* polling is best-effort */
    }
  }, [items.length]);

  const initialLoad = useCallback(async () => {
    setLoading(true);
    await fetchPage({ reset: true });
    if (isMounted.current) setLoading(false);
  }, [fetchPage]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchPage({ reset: true });
    if (isMounted.current) setRefreshing(false);
  };

  // Poll loop — runs while screen focused.
  useFocusEffect(useCallback(() => {
    isMounted.current = true;
    initialLoad();
    const tick = () => {
      const newestIso = items[0]?.createdAt;
      fetchPage({ after: newestIso });
      pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      isMounted.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []));

  const markRead = async (n: Notification) => {
    // Optimistic.
    setItems((cur) => cur.map((x) => x.id === n.id ? { ...x, isRead: true } : x));
    setUnread((u) => Math.max(0, u - (n.isRead ? 0 : 1)));
    try {
      await fetch(`${API}/api/notifications/${n.id}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.current}` },
      });
    } catch { /* will reconcile on next poll */ }
  };

  const markAllRead = async () => {
    setItems((cur) => cur.map((x) => ({ ...x, isRead: true })));
    setUnread(0);
    try {
      await fetch(`${API}/api/notifications/read-all`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.current}` },
      });
    } catch { /* */ }
  };

  const handleTap = async (n: Notification) => {
    if (!n.isRead) await markRead(n);
    if (n.actionUrl) router.push(n.actionUrl as any);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']} testID="inspector-notifications">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="notifications-back">
          <Ionicons name="chevron-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          УВЕДОМЛЕНИЯ {unread > 0 ? `· ${unread}` : ''}
        </Text>
        {unread > 0 ? (
          <TouchableOpacity onPress={markAllRead} testID="notifications-mark-all">
            <Text style={styles.markAll}>{t('inspector.vse_prochitano')}</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 84 }} />
        )}
      </View>

      {loading && items.length === 0 ? (
        <View style={styles.center}><ActivityIndicator color="#FFB020" /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(x) => x.id}
          renderItem={({ item }) => (
            <NotifRow item={item} onTap={() => handleTap(item)} />
          )}
          ListEmptyComponent={() => (
            <View style={styles.center}>
              <Text style={styles.empty}>{t('inspector.poka_pusto_uvedomleniya_poyavyatsya_kak_tolko_sist')}</Text>
            </View>
          )}
          contentContainerStyle={items.length === 0 ? { flexGrow: 1 } : { paddingVertical: 8 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FFB020" />
          }
        />
      )}
    </SafeAreaView>
  );
}

function NotifRow({ item, onTap }: { item: Notification; onTap: () => void }) {
  const tone = TONE[item.severity] || TONE.info;
  return (
    <TouchableOpacity
      style={[styles.row, !item.isRead && styles.rowUnread]}
      onPress={onTap}
      testID={`notif-${item.id}`}
      activeOpacity={0.8}
    >
      <View style={[styles.dot, { backgroundColor: tone.dot }]} />
      <View style={{ flex: 1 }}>
        <View style={styles.rowTop}>
          <Text style={[styles.title, !item.isRead && { fontWeight: '900' }]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.timestamp}>{formatRelative(item.createdAt)}</Text>
        </View>
        <Text style={styles.body} numberOfLines={2}>{item.body || item.text || ''}</Text>
        {item.actorLabel ? (
          <Text style={styles.meta}>от: {item.actorLabel}</Text>
        ) : null}
      </View>
      {!item.isRead && <View style={styles.unreadPill} />}
    </TouchableOpacity>
  );
}

function formatRelative(iso?: string) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('inspector.tolko_chto');
  if (min < 60) return t('inspector.min_min');
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('inspector.hr_ch');
  const days = Math.floor(hr / 24);
  if (days < 7) return t('inspector.days_d');
  return new Date(iso).toLocaleDateString('ru-RU');
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#1f1f22',
  },
  headerTitle: { color: '#FFF', fontSize: 13, fontWeight: '900', letterSpacing: 1.5 },
  markAll: { color: '#FFB020', fontSize: 12, fontWeight: '800' },

  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#161616',
  },
  rowUnread: { backgroundColor: '#0F0F10' },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
  rowTop: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'baseline', gap: 8,
  },
  title: { color: '#FFF', fontSize: 14, fontWeight: '700', flex: 1 },
  timestamp: { color: '#71717A', fontSize: 11 },
  body: { color: '#A1A1AA', fontSize: 13, marginTop: 3, lineHeight: 18 },
  meta: { color: '#52525B', fontSize: 11, marginTop: 4 },
  unreadPill: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#FFB020', marginLeft: 8, marginTop: 6,
  },
  empty: { color: '#71717A', fontSize: 13, textAlign: 'center', lineHeight: 20 },
});

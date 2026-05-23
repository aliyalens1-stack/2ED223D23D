/**
 * Car-Selection Inbox — Phase 8 awareness surface.
 *
 * Reads GET /api/car-selection/notifications/me. Each row is a
 * projection of a domain event:
 *
 *   eventType = car_selection.<status>   (lifecycle)
 *             | offer_package.delivered | offer_package.accepted
 *             | offer_package.declined  | offer_package.revoked
 *             | car_selection_thread.message   (chat — separate intent)
 *
 * For `offer_package.*` rows we render a "commercial event" card:
 *   • title = i18n event label
 *   • body  = preview (package title or short id)
 *   • click → route to request detail with `?focusPackageId=<pid>`
 *
 * For other event types we render a minimal generic row that just
 * routes to the request detail (no focus). This screen exists ONLY
 * to render rows and route — it never writes content, never opens
 * the thread anchor (messageId is intentionally ignored for
 * commercial events).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList,
  TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useThemeContext } from '../src/context/ThemeContext';
import { useAuth } from '../src/context/AuthContext';
import { api } from '../src/services/api';
import { tokens } from '../src/theme/tokens';
import i18n from '../src/i18n';

type Notif = {
  id: string;
  recipientId: string;
  recipientRole: 'customer' | 'provider' | 'admin' | string;
  requestId: string;
  eventType: string;
  messageId: string | null;
  offerPackageId?: string | null;
  actorRole?: string;
  preview?: string;
  createdAt: string;
  readAt: string | null;
};

const C = tokens.colors;
const S = tokens.spacing;
const R = tokens.radius;

// Recognised event types this screen renders specially. Anything else
// falls back to a generic row.
const OFFER_PACKAGE_EVENTS = new Set([
  'offer_package.delivered',
  'offer_package.accepted',
  'offer_package.declined',
  'offer_package.revoked',
]);

function iconForEvent(eventType: string): { name: any; tone: string } {
  if (eventType === 'offer_package.delivered') return { name: 'paper-plane', tone: C.brand };
  if (eventType === 'offer_package.accepted')  return { name: 'checkmark-circle', tone: C.success };
  if (eventType === 'offer_package.declined')  return { name: 'close-circle', tone: C.error };
  if (eventType === 'offer_package.revoked')   return { name: 'remove-circle', tone: C.subtextDark };
  if (eventType.startsWith('car_selection_thread.')) return { name: 'chatbubble', tone: C.subtextDark };
  return { name: 'notifications', tone: C.subtextDark };
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
}

export default function CarSelectionInboxScreen() {
  const { t } = useTranslation();
  const { isDark } = useThemeContext();
  const { activeAccount, user } = useAuth() as any;
  const router = useRouter();

  const [items, setItems] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const styles = useMemo(() => makeStyles(isDark), [isDark]);

  // The recipient role determines which request-detail screen we
  // route to. We trust the active account.kind because the inbox
  // endpoint already resolves by ctx.account.kind, but we still
  // fall back to the row's recipientRole for safety.
  const myKind: string | null = activeAccount?.kind || user?.role || null;

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<{ items: Notif[]; unread: number; total: number }>(
        '/car-selection/notifications/me?limit=100'
      );
      setItems(data.items || []);
      setUnread(data.unread || 0);
      setErr(null);
    } catch (e: any) {
      setErr(i18n.t('car_selection.inbox.load_failed', { defaultValue: 'Failed to load inbox' }));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const markAllRead = useCallback(async () => {
    try {
      await api.post('/car-selection/notifications/me/read', { all: true });
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })));
      setUnread(0);
    } catch {/* swallow — best-effort */}
  }, []);

  const routeForRow = useCallback((n: Notif): string => {
    // Recipient-side routing. Admin always lands on the admin detail
    // surface (governance), provider on their workspace detail,
    // customer on the consumer detail.
    const kind = (myKind || n.recipientRole || '').toLowerCase();
    const focus = n.offerPackageId ? `?focusPackageId=${n.offerPackageId}` : '';
    if (kind === 'admin') return `/admin/car-selection/${n.requestId}${focus}`;
    if (kind.startsWith('provider') || kind === 'service_provider' || kind === 'dealer' || kind === 'inspector' || kind === 'transport_provider') {
      return `/provider/car-selection/${n.requestId}${focus}`;
    }
    return `/car-selection/${n.requestId}${focus}`;
  }, [myKind]);

  const onPressRow = useCallback(async (n: Notif) => {
    // Best-effort mark-as-read on tap; navigation must not be blocked
    // by a slow read-receipt.
    if (!n.readAt) {
      api.post('/car-selection/notifications/me/read', { ids: [n.id] }).catch(() => {});
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      setUnread((u) => Math.max(0, u - 1));
    }
    router.push(routeForRow(n) as any);
  }, [router, routeForRow]);

  const renderRow = useCallback(({ item }: { item: Notif }) => {
    const isOP = OFFER_PACKAGE_EVENTS.has(item.eventType);
    const isUnread = !item.readAt;
    const { name, tone } = iconForEvent(item.eventType);

    let title = item.eventType;
    if (isOP) {
      // Backend EVENT_TYPE = "offer_package.<transition>". The
      // i18n key is car_selection.offer_package.event.<transition>.
      const key = item.eventType.split('.')[1];
      title = i18n.t(`car_selection.offer_package.event.${key}`, { defaultValue: item.eventType });
    } else if (item.eventType.startsWith('car_selection_thread.')) {
      title = i18n.t('car_selection.inbox.thread_message', { defaultValue: 'New message in conversation' });
    } else if (item.eventType.startsWith('car_selection.')) {
      const status = item.eventType.split('.')[1];
      title = i18n.t(`car_selection.status.${status}`, { defaultValue: item.eventType });
    }

    return (
      <TouchableOpacity
        onPress={() => onPressRow(item)}
        activeOpacity={0.7}
        style={[styles.row, isUnread ? styles.rowUnread : null]}
        testID={`cs-inbox-row-${item.id}`}
      >
        <View style={[styles.iconBubble, { backgroundColor: tone + '22', borderColor: tone + '66' }]}>
          <Ionicons name={name} size={14} color={tone} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle} numberOfLines={2}>{title}</Text>
          {item.preview ? (
            <Text style={styles.rowPreview} numberOfLines={2}>{item.preview}</Text>
          ) : null}
          <Text style={styles.rowMeta}>
            {fmtDate(item.createdAt)}
            {item.actorRole ? ` · ${item.actorRole}` : ''}
          </Text>
        </View>
        {isUnread ? <View style={styles.dot} /> : null}
      </TouchableOpacity>
    );
  }, [onPressRow, styles, t]);

  return (
    <SafeAreaView style={styles.screen} testID="cs-inbox-screen">
      <Stack.Screen options={{ title: t('car_selection.inbox.title', { defaultValue: 'Inbox' }) }} />

      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>
          {t('car_selection.inbox.title', { defaultValue: 'Inbox' })}
        </Text>
        {unread > 0 ? (
          <TouchableOpacity onPress={markAllRead} activeOpacity={0.7} testID="cs-inbox-mark-all">
            <Text style={styles.markAll}>
              {t('car_selection.inbox.mark_all_read', { defaultValue: 'Mark all read' })} · {unread}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={C.brand} /></View>
      ) : err ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{err}</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          renderItem={renderRow}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          contentContainerStyle={{ paddingVertical: S.sm }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.brand} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="mail-open-outline" size={28} color={C.subtextDark} />
              <Text style={styles.emptyText}>
                {t('car_selection.inbox.empty', { defaultValue: 'No notifications yet.' })}
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function makeStyles(isDark: boolean) {
  const bg = isDark ? C.bgDark : C.bgLight;
  const card = isDark ? C.cardDark : C.cardLight;
  const text = isDark ? C.textDark : C.textLight;
  const subtext = isDark ? C.subtextDark : C.subtextLight;
  const border = isDark ? C.borderDark : C.borderLight;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: bg },
    center: { padding: S.lg, alignItems: 'center', justifyContent: 'center', gap: S.sm },
    errorText: { color: C.error, fontSize: tokens.typography.caption },
    emptyText: { color: subtext, fontSize: tokens.typography.caption, fontStyle: 'italic' },

    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.md, paddingVertical: S.sm, borderBottomWidth: 1, borderBottomColor: border },
    headerTitle: { fontSize: tokens.typography.h3, color: text, fontWeight: '800' },
    markAll: { fontSize: tokens.typography.micro, color: C.brand, fontWeight: '700' },

    row: { flexDirection: 'row', gap: 10, paddingHorizontal: S.md, paddingVertical: S.sm, alignItems: 'flex-start', backgroundColor: bg },
    rowUnread: { backgroundColor: card },
    iconBubble: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
    rowTitle: { fontSize: tokens.typography.caption + 1, color: text, fontWeight: '700' },
    rowPreview: { fontSize: tokens.typography.caption, color: text, marginTop: 2 },
    rowMeta: { fontSize: tokens.typography.micro, color: subtext, marginTop: 2 },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.brand, alignSelf: 'center', marginLeft: 4 },
    sep: { height: 1, backgroundColor: border, marginLeft: S.md + 32 + 10 },
  });
}

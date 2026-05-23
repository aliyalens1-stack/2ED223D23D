/**
 * Provider Chats list — Sprint 34 D9
 *
 * Lists active conversations between this provider (mechanic) and customers.
 * Backend: GET /api/provider/chat/threads (provider role only).
 *
 * i18n: all user-facing strings come from the `provider_chats.*` namespace.
 *       Locale-aware date formatting uses the current i18n language.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';
import { getCurrentLanguage } from '../../src/i18n';
import api from '../../src/services/api';
import i18n from '../../src/i18n';

interface ProviderThread {
  id: string;
  title: string;
  lastMessage: string;
  lastMessageAt: string;
  unreadByOther: boolean;
  participantUserId: string;
  user?: { email: string; firstName?: string; lastName?: string };
  bookingId?: string | null;
}

function useFormatTime() {
  const { t } = useTranslation();
  return useCallback((ts: string): string => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const lang = getCurrentLanguage();
    const localeMap: Record<string, string> = { de: 'de-DE', en: 'en-GB', ru: 'ru-RU' };
    const loc = localeMap[lang] || 'de-DE';
    if (diff < 86_400_000) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    if (diff < 172_800_000) return t('provider_chats.time_yesterday');
    return d.toLocaleDateString(loc, { day: 'numeric', month: 'short' });
  }, [t]);
}

export default function ProviderChatsScreen() {
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const fmtTime = useFormatTime();
  const [threads, setThreads] = useState<ProviderThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await api.get<{ threads: ProviderThread[] }>('/api/provider/chat/threads');
      setThreads(res.data.threads || []);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 401) setError(i18n.t('provider_chats.error_unauthorized'));
      else if (status === 403) setError(i18n.t('provider_chats.error_forbidden'));
      else setError(e?.message || i18n.t('provider_chats.error_generic'));
      setThreads([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => { fetchData(); }, [fetchData]);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchData(); }, [fetchData]);

  const totalUnread = threads.filter((th) => th.unreadByOther).length;

  const renderThread = ({ item }: { item: ProviderThread }) => {
    const customerName =
      [item.user?.firstName, item.user?.lastName].filter(Boolean).join(' ') ||
      item.user?.email ||
      i18n.t('provider_chats.customer_fallback', { id: item.participantUserId.slice(0, 6) });
    const initial = customerName.charAt(0).toUpperCase();
    return (
      <TouchableOpacity
        testID={`provider-thread-${item.id}`}
        style={[styles.card, { backgroundColor: colors.card }]}
        onPress={() => router.push(`/provider/chat/${item.id}` as any)}
        activeOpacity={0.7}
      >
        <View style={[styles.avatar, { backgroundColor: colors.primary + '22' }]}>
          <Text style={[styles.avatarText, { color: colors.primary }]}>{initial}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{customerName}</Text>
            <Text style={[styles.time, { color: colors.textMuted }]}>{fmtTime(item.lastMessageAt)}</Text>
          </View>
          <View style={styles.bodyRow}>
            <Text style={[styles.lastMsg, { color: colors.textSecondary }]} numberOfLines={1}>
              {item.lastMessage || t('provider_chats.last_msg_empty')}
            </Text>
            {item.unreadByOther && <View style={[styles.unreadDot, { backgroundColor: colors.primary }]} />}
          </View>
          {item.bookingId ? (
            <View style={styles.bookingChip}>
              <Ionicons name="receipt-outline" size={11} color={colors.textMuted} />
              <Text style={[styles.bookingChipText, { color: colors.textMuted }]}>
                {t('provider_chats.booking_chip', { id: item.bookingId.slice(0, 8) })}
              </Text>
            </View>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]} testID="provider-chats-screen">
      <SafeAreaView edges={['top']} style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="provider-chats-back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.titleCenter}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('provider_chats.header_title')}</Text>
          {totalUnread > 0 && (
            <View style={[styles.unreadBadge, { backgroundColor: colors.primary }]}>
              <Text style={styles.unreadText}>{totalUnread}</Text>
            </View>
          )}
        </View>
        <View style={styles.iconBtn} />
      </SafeAreaView>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
          <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>{error}</Text>
          <TouchableOpacity onPress={fetchData} style={[styles.retryBtn, { backgroundColor: colors.card }]}>
            <Text style={{ color: colors.primary, fontWeight: '700' }}>{t('provider_chats.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={threads}
          renderItem={renderThread}
          keyExtractor={(it) => it.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="chatbubbles-outline" size={48} color={colors.textMuted} />
              <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>{t('provider_chats.empty_title')}</Text>
              <Text style={[styles.emptySub, { color: colors.textMuted }]}>
                {t('provider_chats.empty_sub')}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { padding: 4, minWidth: 32, alignItems: 'center', justifyContent: 'center' },
  titleCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  unreadBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  unreadText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  list: { padding: 16, gap: 8 },
  card: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 14, gap: 12 },
  avatar: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 20, fontWeight: '800' },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  name: { fontSize: 16, fontWeight: '600', flex: 1, marginRight: 8 },
  time: { fontSize: 12 },
  bodyRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 8 },
  lastMsg: { flex: 1, fontSize: 14 },
  unreadDot: { width: 10, height: 10, borderRadius: 5 },
  bookingChip: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  bookingChipText: { fontSize: 11 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  emptySub: { fontSize: 13, textAlign: 'center', maxWidth: 300 },
  retryBtn: { paddingHorizontal: 24, paddingVertical: 10, borderRadius: 12, marginTop: 8 },
});

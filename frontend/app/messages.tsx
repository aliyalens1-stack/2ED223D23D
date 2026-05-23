/**
 * Messages screen — Sprint B2 (canonical contract).
 *
 * Migrated to `useChatThreads()` over `/api/chat/v1/threads`. The thread
 * list is rendered straight from the canonical `ChatThread[]` — no
 * client-side recomputation of unread or last-message anywhere.
 *
 * Support thread creation remains a legacy `POST /api/chat/threads`
 * call: thread creation isn't part of B1, and B2 is scoped to client
 * migration. The legacy support-creation path is the documented contract
 * until thread-creation lands on a canonical endpoint in a later sprint.
 *
 * i18n: all user-facing strings come from the `messages.*` namespace.
 *       Date formatting is locale-aware via `getCurrentLanguage()`.
 */
import React, { useCallback, useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl,
  TextInput, ActivityIndicator, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../src/context/ThemeContext';
import { useChatThreads } from '../src/hooks/useChatThreads';
import { useServiceChats, type ServiceChatItem } from '../src/hooks/useServiceChats';
import { useAuth } from '../src/context/AuthContext';
import { getCurrentLanguage } from '../src/i18n';
import api from '../src/services/api';
import type { ChatThread } from '@platform/domain/contracts/chat';
import i18n from '../src/i18n';

function useFormatTime() {
  const { t } = useTranslation();
  return useCallback((iso: string | null): string => {
    if (!iso) return '';
    const date = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const lang = getCurrentLanguage();
    const localeMap: Record<string, string> = { de: 'de-DE', en: 'en-GB', ru: 'ru-RU' };
    const loc = localeMap[lang] || 'de-DE';
    if (diff < 86_400_000) {
      return date.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
    }
    if (diff < 172_800_000) return t('messages.time_yesterday');
    return date.toLocaleDateString(loc, { day: 'numeric', month: 'short' });
  }, [t]);
}

function threadDisplayTitle(thread: ChatThread): string {
  if (thread.kind === 'support') return 'AutoSearch Support';
  if (thread.title) return thread.title;
  const prov = thread.participants.find((p) => p.kind === 'provider');
  if (prov?.displayName) return prov.displayName;
  return thread.id;
}

const CATEGORY_LABELS: Record<string, string> = {
  repair: 'service_chat.cat.repair',
  tow: 'service_chat.cat.tow',
  battery: 'service_chat.cat.battery',
  diagnostic: 'service_chat.cat.diagnostic',
  paint: 'service_chat.cat.paint',
  wash: 'service_chat.cat.wash',
  tires: 'service_chat.cat.tires',
};

const STATUS_TONE: Record<string, { bg: string; fg: string; key: string }> = {
  paid:           { bg: '#152045', fg: '#7aa2ff', key: 'service_chat.status.paid' },
  in_progress:    { bg: '#1F1908', fg: '#fde68a', key: 'service_chat.status.in_progress' },
  completed:      { bg: '#0d2a1f', fg: '#5fd3a3', key: 'service_chat.status.completed' },
  released:       { bg: '#0d2a1f', fg: '#5fd3a3', key: 'service_chat.status.released' },
  cancelled:      { bg: '#2a0f12', fg: '#ff8a8a', key: 'service_chat.status.cancelled' },
};

interface ServiceChatsSectionProps {
  chats: ServiceChatItem[];
  colors: any;
  t: (k: string, o?: any) => string;
  formatTime: (iso: string | null) => string;
}

function ServiceChatsSection({ chats, colors, t, formatTime }: ServiceChatsSectionProps) {
  if (chats.length === 0) return null;
  return (
    <View testID="service-chats-section">
      <View style={[styles.sectionHead, { paddingTop: 4 }]}>
        <Text style={[styles.sectionLabelInline, { color: colors.textMuted }]}>
          {t('messages.section_active_jobs', { defaultValue: 'ACTIVE JOBS' })}
        </Text>
        <View style={[styles.sectionCount, { backgroundColor: colors.brand + '22' }]}>
          <Text style={[styles.sectionCountText, { color: colors.brand }]}>{chats.length}</Text>
        </View>
      </View>
      {chats.map((c) => {
        const catKey = c.request?.category ? CATEGORY_LABELS[c.request.category] : null;
        const catLabel = catKey
          ? t(catKey, { defaultValue: c.request?.category ?? '' })
          : c.request?.category ?? '';
        const title = c.request?.title || catLabel || t('messages.service_chat_fallback_title', { defaultValue: 'Service request' });
        const city = c.request?.city ? c.request.city.charAt(0).toUpperCase() + c.request.city.slice(1) : '';
        const status = c.request?.status ?? null;
        const tone = status ? STATUS_TONE[status] : null;
        const unread = c.unreadForMe ?? 0;
        return (
          <TouchableOpacity
            key={c.id}
            testID={`service-chat-row-${c.id}`}
            activeOpacity={0.7}
            onPress={() => router.push(`/chat/service/${c.id}` as any)}
            style={[styles.threadRow, { backgroundColor: colors.card }]}
          >
            <View style={[styles.avatar, { backgroundColor: colors.brand + '22' }]}>
              <Ionicons name="construct-outline" size={22} color={colors.brand} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={styles.rowHead}>
                <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{title}</Text>
                <Text style={[styles.time, { color: colors.textMuted }]}>{formatTime(c.lastMessageAt)}</Text>
              </View>
              <View style={styles.rowFoot}>
                <Text style={[styles.preview, { color: colors.textSecondary }]} numberOfLines={1}>
                  {city ? `${city} · ` : ''}{c.lastMessagePreview || t('messages.service_chat_no_messages', { defaultValue: 'No messages yet' })}
                </Text>
                {unread > 0 && (
                  <View style={[styles.badge, { backgroundColor: colors.brand }]} testID={`service-chat-unread-${c.id}`}>
                    <Text style={styles.badgeText}>{unread}</Text>
                  </View>
                )}
              </View>
              {tone && (
                <View style={[styles.statusChip, { backgroundColor: tone.bg }]} testID={`service-chat-status-${c.id}`}>
                  <Text style={[styles.statusChipText, { color: tone.fg }]}>
                    {t(tone.key, { defaultValue: status?.toUpperCase() ?? '' })}
                  </Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        );
      })}
      <Text style={[styles.sectionLabelInline, { color: colors.textMuted, marginTop: 18 }]}>
        {t('messages.section_support', { defaultValue: 'SUPPORT' })}
      </Text>
    </View>
  );
}

export default function MessagesScreen() {
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const { isAuthenticated } = useAuth();
  const formatTime = useFormatTime();
  // Sprint Guest-3: guest views the info feed (mirrors notifications).
  // The hook hard-gates network when disabled so no 401 / no flash.
  const { threads, loading, error, refresh } = useChatThreads(isAuthenticated);
  const { chats: serviceChats, refetch: refetchServiceChats } = useServiceChats({ enabled: isAuthenticated });
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [creatingSupport, setCreatingSupport] = useState(false);
  const [supportError, setSupportError] = useState<string | null>(null);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([refresh(), refetchServiceChats()]); } finally { setRefreshing(false); }
  }, [refresh, refetchServiceChats]);

  const handleContactSupport = useCallback(async () => {
    if (creatingSupport) return;
    setCreatingSupport(true);
    setSupportError(null);
    try {
      // Legacy thread-creation endpoint — see top-of-file note.
      const res = await api.post<{ thread: { id: string } }>('/chat/threads', { type: 'support' });
      router.push(`/chat/${res.data.thread.id}` as any);
    } catch {
      setSupportError(i18n.t('messages.support_error'));
    } finally {
      setCreatingSupport(false);
    }
  }, [creatingSupport, t]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((thread) =>
      threadDisplayTitle(thread).toLowerCase().includes(q) ||
      (thread.lastMessagePreview || '').toLowerCase().includes(q),
    );
  }, [threads, searchQuery]);

  const renderItem = useCallback(({ item }: { item: ChatThread }) => {
    const isUnread = item.unreadByMe > 0;
    return (
      <TouchableOpacity
        testID={`message-thread-${item.id}`}
        style={[
          styles.threadRow,
          { backgroundColor: isUnread ? (colors.brandSoft || colors.card) : colors.card },
        ]}
        onPress={() => router.push(`/chat/${item.id}` as any)}
        activeOpacity={0.7}
      >
        <View style={[styles.avatar, { backgroundColor: colors.brand + '24' }]}>
          <Ionicons
            name={item.kind === 'support' ? 'help-buoy' : item.kind === 'provider' ? 'construct' : 'chatbubble'}
            size={22}
            color={colors.brand}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.rowHead}>
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
              {threadDisplayTitle(item)}
            </Text>
            <Text style={[styles.time, { color: colors.textMuted }]}>
              {formatTime(item.lastMessageAt)}
            </Text>
          </View>
          <View style={styles.rowFoot}>
            <Text
              style={[
                styles.preview,
                { color: isUnread ? colors.text : colors.textSecondary, fontWeight: isUnread ? '600' : '400' },
              ]}
              numberOfLines={1}
            >
              {item.lastMessagePreview || t('messages.no_messages')}
            </Text>
            {isUnread && (
              <View style={[styles.badge, { backgroundColor: colors.brand }]} testID={`thread-unread-${item.id}`}>
                <Text style={[styles.badgeText, { color: colors.onPrimary || '#000' }]}>{item.unreadByMe >= 100 ? '99+' : item.unreadByMe}</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  }, [colors, formatTime, t]);

  // Sprint Guest-3: guest info-feed for messages — explains the support/provider
  // chat flow, drives sign-in, mirrors the notifications guest pattern.
  // i18n: each entry uses a `messages.guest.<id>.*` key trio.
  const GUEST_FEED: Array<{
    id: string;
    icon: any;
    tone: 'brand' | 'success' | 'warning' | 'muted';
    titleKey: string;
    bodyKey: string;
    ctaKey: string;
    href: string;
  }> = [
    { id: 'support',   icon: 'help-buoy', tone: 'brand',
      titleKey: 'messages.guest.support.title',
      bodyKey:  'messages.guest.support.body',
      ctaKey:   'messages.guest.support.cta',
      href: '/login' },
    { id: 'inspector', icon: 'construct', tone: 'success',
      titleKey: 'messages.guest.inspector.title',
      bodyKey:  'messages.guest.inspector.body',
      ctaKey:   'messages.guest.inspector.cta',
      href: '/(tabs)' },
    { id: 'history',   icon: 'time', tone: 'warning',
      titleKey: 'messages.guest.history.title',
      bodyKey:  'messages.guest.history.body',
      ctaKey:   'messages.guest.history.cta',
      href: '/login' },
    { id: 'signup',    icon: 'person-add', tone: 'brand',
      titleKey: 'messages.guest.signup.title',
      bodyKey:  'messages.guest.signup.body',
      ctaKey:   'messages.guest.signup.cta',
      href: '/register' },
  ];

  if (!isAuthenticated) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]} testID="messages-screen-guest">
        <SafeAreaView edges={['top']} style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="messages-back">
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('messages.title')}</Text>
          <View style={styles.iconBtn} />
        </SafeAreaView>

        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          <View style={[styles.guestHero, { backgroundColor: colors.brandSoft || colors.card, borderColor: colors.brand }]}>
            <Ionicons name="chatbubbles-outline" size={32} color={colors.brand} />
            <Text style={[styles.guestHeroTitle, { color: colors.text }]}>{t('messages.guest_hero_title')}</Text>
            <Text style={[styles.guestHeroSub, { color: colors.textSecondary }]}>
              {t('messages.guest_hero_sub')}
            </Text>
            <TouchableOpacity
              style={[styles.guestHeroCta, { backgroundColor: colors.brand }]}
              onPress={() => router.push('/login')}
              testID="guest-messages-login"
            >
              <Text style={[styles.guestHeroCtaText, { color: colors.onPrimary || '#000' }]}>{t('messages.guest_login')}</Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{t('messages.guest_section')}</Text>

          {GUEST_FEED.map((f) => {
            const tone =
              f.tone === 'success' ? colors.success :
              f.tone === 'warning' ? colors.warning :
              f.tone === 'brand'   ? colors.brand   : colors.textSecondary;
            return (
              <TouchableOpacity
                key={f.id}
                style={[styles.guestCard, { backgroundColor: colors.card }]}
                onPress={() => router.push(f.href as any)}
                activeOpacity={0.7}
                testID={`guest-msg-${f.id}`}
              >
                <View style={[styles.guestIconWrap, { backgroundColor: tone + '24' }]}>
                  <Ionicons name={f.icon} size={22} color={tone} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.guestTitle, { color: colors.text }]} numberOfLines={2}>{t(f.titleKey)}</Text>
                  <Text style={[styles.guestBody, { color: colors.textSecondary }]} numberOfLines={3}>{t(f.bodyKey)}</Text>
                  <Text style={[styles.guestCtaText, { color: colors.brand }]}>{t(f.ctaKey)} →</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]} testID="messages-screen">
      <SafeAreaView edges={['top']} style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="messages-back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('messages.title')}</Text>
        <View style={styles.iconBtn} />
      </SafeAreaView>

      <View style={[styles.searchWrap, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Ionicons name="search" size={16} color={colors.textMuted} />
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder={t('messages.search')}
          placeholderTextColor={colors.textMuted}
          style={[styles.searchInput, { color: colors.text }]}
          testID="messages-search-input"
        />
      </View>

      <TouchableOpacity
        style={[styles.supportBtn, { backgroundColor: colors.brand }]}
        onPress={handleContactSupport}
        disabled={creatingSupport}
        testID="messages-contact-support"
      >
        {creatingSupport ? (
          <ActivityIndicator color={colors.onPrimary || '#000'} />
        ) : (
          <>
            <Ionicons name="help-buoy" size={18} color={colors.onPrimary || '#000'} />
            <Text style={[styles.supportBtnText, { color: colors.onPrimary || '#000' }]}>{t('messages.contact_support')}</Text>
          </>
        )}
      </TouchableOpacity>

      {supportError && (
        <View style={styles.errBar}>
          <Text style={styles.errBarText}>{supportError}</Text>
        </View>
      )}

      {loading && threads.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.brand} />
        </View>
      ) : error && threads.length === 0 ? (
        <View style={styles.center} testID="messages-error">
          <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
          <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>
            {error === 'network' ? t('messages.error_network') : t('messages.error_generic')}
          </Text>
          <TouchableOpacity onPress={onRefresh} style={[styles.retryBtn, { backgroundColor: colors.card }]}>
            <Text style={{ color: colors.brand, fontWeight: '700' }}>{t('messages.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filtered}
          renderItem={renderItem}
          keyExtractor={(it) => it.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
          ListHeaderComponent={
            <ServiceChatsSection
              chats={serviceChats}
              colors={colors}
              t={t}
              formatTime={formatTime}
            />
          }
          ListEmptyComponent={
            serviceChats.length === 0 ? (
              <View style={styles.center} testID="messages-empty">
                <Ionicons name="chatbubbles-outline" size={48} color={colors.textMuted} />
                <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>
                  {searchQuery ? t('messages.empty_search') : t('messages.empty_title')}
                </Text>
                <Text style={[styles.emptySub, { color: colors.textMuted }]}>
                  {t('messages.empty_sub')}
                </Text>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchInput: { flex: 1, fontSize: 14 },
  supportBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginHorizontal: 16, marginTop: 12, marginBottom: 4,
    paddingVertical: 12, borderRadius: 12,
  },
  supportBtnText: { color: '#000', fontSize: 15, fontWeight: '700' },
  errBar: { paddingHorizontal: 16, paddingTop: 8 },
  errBarText: { color: '#ef4444', fontSize: 12 },
  list: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  threadRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, borderRadius: 14,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 },
  title: { flex: 1, fontSize: 15, fontWeight: '600' },
  time: { fontSize: 11 },
  preview: { flex: 1, fontSize: 13 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, minWidth: 20, alignItems: 'center' },
  badgeText: { color: '#000', fontSize: 11, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  emptySub: { fontSize: 13, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 24, paddingVertical: 10, borderRadius: 12, marginTop: 8 },
  guestHero: {
    padding: 18, borderRadius: 16, borderWidth: 1,
    alignItems: 'flex-start', gap: 8, marginBottom: 18,
  },
  guestHeroTitle: { fontSize: 18, fontWeight: '800' },
  guestHeroSub: { fontSize: 13, lineHeight: 18 },
  guestHeroCta: { paddingHorizontal: 22, paddingVertical: 10, borderRadius: 999, marginTop: 8 },
  guestHeroCtaText: { fontSize: 14, fontWeight: '700' },
  sectionLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginBottom: 10 },
  guestCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderRadius: 14, marginBottom: 10,
  },
  guestIconWrap: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  guestTitle: { fontSize: 15, fontWeight: '700' },
  guestBody: { fontSize: 13, marginTop: 4, lineHeight: 18 },
  guestCtaText: { fontSize: 13, fontWeight: '700', marginTop: 8 },
  sectionHead: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginBottom: 8,
  },
  sectionLabelInline: {
    fontSize: 11, fontWeight: '800', letterSpacing: 1.2,
  },
  sectionCount: {
    minWidth: 18, paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 9, alignItems: 'center',
  },
  sectionCountText: { fontSize: 10, fontWeight: '800' },
  statusChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: 4, marginTop: 6,
  },
  statusChipText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
});

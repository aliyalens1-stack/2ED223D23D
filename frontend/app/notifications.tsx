/**
 * Notifications screen — Sprint A4 (canonical contract).
 *
 * Rewritten to consume the canonical polling transport via
 * `useNotifications()` (Sprint A2). Wire shape comes from
 * `shared/domain/contracts/notification.ts` — same on every surface.
 *
 * What changed vs the previous Sprint 34 D8 implementation:
 *   - Reads /api/notifications/since via the shared hook instead of the
 *     legacy /api/notifications endpoint (which is now strictly the
 *     compatibility fallback in the projector).
 *   - State (items, unread count) is owned by the hook; this screen is
 *     pure presentation.
 *   - Mark-read / mark-all-read mutate through the hook so the bell badge
 *     in the header updates instantly (same cache).
 *   - Pull-to-refresh calls `refresh()`, which resets the cursor.
 *
 * i18n: all user-facing strings come from `notifications.*` namespace.
 *       Locale-aware date formatting uses the current i18n language.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../src/context/ThemeContext';
import { useNotifications } from '../src/hooks/useNotifications';
import { useAuth } from '../src/context/AuthContext';
import { getCurrentLanguage } from '../src/i18n';
import type { Notification, NotificationSeverity } from '@platform/domain/contracts/notification';
import i18n from '../src/i18n';

const ICON_MAP: Record<string, { name: any; tone: 'brand' | 'muted' | 'success' | 'warning' | 'danger' }> = {
  admin_broadcast:    { name: 'megaphone',        tone: 'brand'   },
  support_reply:      { name: 'chatbubble',       tone: 'brand'   },
  support_message:    { name: 'chatbubble',       tone: 'brand'   },
  provider_reply:     { name: 'chatbubbles',      tone: 'success' },
  booking_confirmed:  { name: 'checkmark-circle', tone: 'success' },
  payment_paid:       { name: 'card',             tone: 'success' },
  promo:              { name: 'gift',             tone: 'warning' },
  alert:              { name: 'flash',            tone: 'brand'   },
};

function getIcon(type: string, severity?: NotificationSeverity) {
  // Severity wins over kind-specific defaults.
  if (severity === 'critical') return { name: 'warning' as any, tone: 'danger' as const };
  if (severity === 'warning') return { name: 'alert-circle' as any, tone: 'warning' as const };
  return ICON_MAP[type] || { name: 'notifications' as any, tone: 'muted' as const };
}

// Locale-aware ago-formatter. Returns translated string for "just now",
// "5 min ago", "2 hr ago", "Yesterday", or absolute date with the current
// language's locale.
function useFormatTime() {
  const { t } = useTranslation();
  return useCallback((timestamp: string): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    if (diff < 60_000) return i18n.t('notifications.time_just_now');
    if (diff < 3_600_000) return i18n.t('notifications.time_min_ago', { n: Math.floor(diff / 60_000) });
    if (diff < 86_400_000) return i18n.t('notifications.time_hr_ago', { n: Math.floor(diff / 3_600_000) });
    if (diff < 172_800_000) return i18n.t('notifications.time_yesterday');
    const lang = getCurrentLanguage();
    const localeMap: Record<string, string> = { de: 'de-DE', en: 'en-GB', ru: 'ru-RU' };
    return date.toLocaleDateString(localeMap[lang] || 'de-DE', { day: 'numeric', month: 'short' });
  }, [t]);
}

export default function NotificationsScreen() {
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const { isAuthenticated } = useAuth();
  const formatTime = useFormatTime();
  // Sprint Guest-2: guest views the info/promo feed, no API poll, no 401.
  // We still mount the hook for authed users (its internal effect skips
  // network when token is absent, but here we hard-gate to avoid any flash).
  const { notifications, unreadCount, loading, error, refresh, markRead, markAllRead } =
    useNotifications(isAuthenticated);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const handlePress = useCallback(async (item: Notification) => {
    if (!item.isRead) {
      void markRead(item.id);
    }
    if (item.actionUrl) {
      // Defensive route mapping for legacy / mock URLs.
      const url = item.actionUrl
        .replace(/^\/bookings$/, '/(tabs)/quotes')
        .replace(/^\/fullmap$/, '/(tabs)');
      router.push(url as any);
    }
  }, [markRead]);

  const renderItem = useCallback(({ item }: { item: Notification }) => {
    const icon = getIcon(item.kind || '', item.severity);
    const tone =
      icon.tone === 'success' ? colors.success :
      icon.tone === 'warning' ? colors.warning :
      icon.tone === 'danger' ? (colors.danger || '#ef4444') :
      icon.tone === 'brand' ? colors.brand :
      colors.textSecondary;
    return (
      <TouchableOpacity
        testID={`notification-${item.id}`}
        style={[styles.card, { backgroundColor: item.isRead ? colors.card : (colors.brandSoft || colors.card) }]}
        onPress={() => handlePress(item)}
        activeOpacity={0.7}
      >
        <View style={[styles.iconWrap, { backgroundColor: tone + '24' }]}>
          <Ionicons name={icon.name} size={22} color={tone} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
              {item.title || t('notifications.no_title')}
            </Text>
            {!item.isRead && <View style={[styles.dot, { backgroundColor: colors.brand }]} />}
          </View>
          {item.body ? (
            <Text style={[styles.body, { color: colors.textSecondary }]} numberOfLines={2}>
              {item.body}
            </Text>
          ) : null}
          <Text style={[styles.time, { color: colors.textMuted }]}>{formatTime(item.createdAt)}</Text>
        </View>
        {item.actionUrl ? (
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        ) : null}
      </TouchableOpacity>
    );
  }, [colors, handlePress, t, formatTime]);

  // Sprint Guest-2: guest info-feed — promo / platform updates / value props.
  // No 401, no error; static curated content with explicit CTAs that drive
  // upsell (book inspection) or sign-up (sync notifications).
  // i18n: each entry references a `notifications.guest.<id>.*` key trio.
  const GUEST_FEED: Array<{
    id: string;
    icon: any;
    tone: 'brand' | 'success' | 'warning' | 'muted';
    titleKey: string;
    bodyKey: string;
    ctaKey: string;
    href: string;
  }> = [
    { id: 'welcome',    icon: 'megaphone', tone: 'brand',
      titleKey: 'notifications.guest.welcome.title',
      bodyKey:  'notifications.guest.welcome.body',
      ctaKey:   'notifications.guest.welcome.cta',
      href: '/' },
    { id: 'first',      icon: 'gift', tone: 'warning',
      titleKey: 'notifications.guest.first.title',
      bodyKey:  'notifications.guest.first.body',
      ctaKey:   'notifications.guest.first.cta',
      href: '/(tabs)' },
    { id: 'selection',  icon: 'car-sport', tone: 'brand',
      titleKey: 'notifications.guest.selection.title',
      bodyKey:  'notifications.guest.selection.body',
      ctaKey:   'notifications.guest.selection.cta',
      href: '/(tabs)' },
    { id: 'cities',     icon: 'location', tone: 'success',
      titleKey: 'notifications.guest.cities.title',
      bodyKey:  'notifications.guest.cities.body',
      ctaKey:   'notifications.guest.cities.cta',
      href: '/city-select' },
    { id: 'inspector',  icon: 'wallet', tone: 'warning',
      titleKey: 'notifications.guest.inspector.title',
      bodyKey:  'notifications.guest.inspector.body',
      ctaKey:   'notifications.guest.inspector.cta',
      href: '/register?role=provider' },
    { id: 'signin',     icon: 'log-in', tone: 'brand',
      titleKey: 'notifications.guest.signin.title',
      bodyKey:  'notifications.guest.signin.body',
      ctaKey:   'notifications.guest.signin.cta',
      href: '/login' },
  ];

  if (!isAuthenticated) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]} testID="notifications-screen-guest">
        <SafeAreaView edges={['top']} style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="notifications-back">
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.titleCenter}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>{t('notifications.title')}</Text>
          </View>
          <View style={styles.iconBtn} />
        </SafeAreaView>

        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          <View style={[styles.guestHero, { backgroundColor: colors.brandSoft || colors.card, borderColor: colors.brand }]}>
            <Ionicons name="notifications-outline" size={32} color={colors.brand} />
            <Text style={[styles.guestHeroTitle, { color: colors.text }]}>{t('notifications.guest_hero_title')}</Text>
            <Text style={[styles.guestHeroSub, { color: colors.textSecondary }]}>
              {t('notifications.guest_hero_sub')}
            </Text>
            <TouchableOpacity
              style={[styles.guestHeroCta, { backgroundColor: colors.brand }]}
              onPress={() => router.push('/login')}
              testID="guest-notifications-login"
            >
              <Text style={[styles.guestHeroCtaText, { color: colors.onPrimary || '#000' }]}>{t('notifications.guest_login')}</Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{t('notifications.guest_section')}</Text>

          {GUEST_FEED.map((f) => {
            const tone =
              f.tone === 'success' ? colors.success :
              f.tone === 'warning' ? colors.warning :
              f.tone === 'brand'   ? colors.brand   : colors.textSecondary;
            return (
              <TouchableOpacity
                key={f.id}
                style={[styles.card, { backgroundColor: colors.card }]}
                onPress={() => router.push(f.href as any)}
                activeOpacity={0.7}
                testID={`guest-notif-${f.id}`}
              >
                <View style={[styles.iconWrap, { backgroundColor: tone + '24' }]}>
                  <Ionicons name={f.icon} size={22} color={tone} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>{t(f.titleKey)}</Text>
                  <Text style={[styles.body, { color: colors.textSecondary }]} numberOfLines={3}>{t(f.bodyKey)}</Text>
                  <Text style={[styles.guestCta, { color: colors.brand }]}>{t(f.ctaKey)} →</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]} testID="notifications-screen">
      <SafeAreaView edges={['top']} style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="notifications-back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.titleCenter}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('notifications.title')}</Text>
          {unreadCount > 0 && (
            <View style={[styles.unreadBadge, { backgroundColor: colors.brand }]} testID="notifications-unread-badge">
              <Text style={[styles.unreadText, { color: colors.onPrimary || '#000' }]}>{unreadCount >= 100 ? '99+' : unreadCount}</Text>
            </View>
          )}
        </View>
        <TouchableOpacity
          onPress={() => { void markAllRead(); }}
          style={styles.iconBtn}
          testID="notifications-mark-all"
          disabled={unreadCount === 0}
        >
          <Ionicons name="checkmark-done" size={22} color={unreadCount === 0 ? colors.textMuted : colors.brand} />
        </TouchableOpacity>
      </SafeAreaView>

      {loading && notifications.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.brand} />
        </View>
      ) : error && notifications.length === 0 ? (
        <View style={styles.center} testID="notifications-error">
          <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
          <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>
            {error === 'network' ? t('notifications.error_network') : error}
          </Text>
          <TouchableOpacity onPress={onRefresh} style={[styles.retryBtn, { backgroundColor: colors.card }]}>
            <Text style={{ color: colors.brand, fontWeight: '700' }}>{t('notifications.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={notifications}
          renderItem={renderItem}
          keyExtractor={(it) => it.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
          ListEmptyComponent={
            <View style={styles.center} testID="notifications-empty">
              <Ionicons name="notifications-off-outline" size={48} color={colors.textMuted} />
              <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>{t('notifications.empty_title')}</Text>
              <Text style={[styles.emptySub, { color: colors.textMuted }]}>
                {t('notifications.empty_sub')}
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
  iconBtn: { padding: 4 },
  titleCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  unreadBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  unreadText: { color: '#000', fontSize: 12, fontWeight: '700' },
  list: { padding: 16, gap: 10 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderRadius: 14,
  },
  iconWrap: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 15, fontWeight: '600', flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  body: { fontSize: 13, marginTop: 4, lineHeight: 18 },
  time: { fontSize: 11, marginTop: 6 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  emptySub: { fontSize: 13, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 24, paddingVertical: 10, borderRadius: 12, marginTop: 8 },
  guestHero: {
    padding: 18, borderRadius: 16, borderWidth: 1,
    alignItems: 'flex-start', gap: 8, marginBottom: 18,
  },
  guestHeroTitle: { fontSize: 18, fontWeight: '800' },
  guestHeroSub:   { fontSize: 13, lineHeight: 18 },
  guestHeroCta:   { paddingHorizontal: 22, paddingVertical: 10, borderRadius: 999, marginTop: 8 },
  guestHeroCtaText: { fontSize: 14, fontWeight: '700' },
  sectionLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginBottom: 10 },
  guestCta:    { fontSize: 13, fontWeight: '700', marginTop: 8 },
});

/**
 * UX-2C — Customer identity center (Profile tab).
 *
 * Previously this file was a 1440-line hub mixing inspector stats, earnings
 * widgets, verification progress, "available jobs", "become inspector" CTA
 * and customer settings — depending on role. Customers regularly saw
 * provider artifacts leak through.
 *
 * Now: strict customer-only profile.
 *   • Provider role → redirected to /provider/workbench (their own surface).
 *   • Admin role    → redirected to /(tabs) home (admin uses tab home).
 *   • Customer sees: identity card, settings, my cars (garage), my orders,
 *     support shortcut, logout. Nothing else.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch,
  Modal, Pressable, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useThemeContext } from '../../src/context/ThemeContext';
import { useAuth } from '../../src/context/AuthContext';
import { useCity } from '../../src/context/CityContext';
import { api } from '../../src/services/api';
import i18n from '../../src/i18n';

const LANGUAGES: { code: 'de' | 'en' | 'ru'; name: string; flag: string }[] = [
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'ru', name: 'Русский', flag: '🇷🇺' },
];

export default function ProfileScreen() {
  const router = useRouter();
  const { colors, isDark, setTheme } = useThemeContext();
  const { t, i18n } = useTranslation();
  const { user, logout, isLoading: loading } = useAuth();
  const { selectedCity } = useCity();

  // ─── Role context (no redirect — profile is for every role) ────────
  // Profile = settings/account surface. Workbench = work surface. They
  // are independent. We just expose a quick link to the role's primary
  // workspace at the top, but the user can always *see* and edit their
  // profile from this tab regardless of role.
  const role = (user?.role || '').toString();
  const isProvider = role === 'provider' || role.startsWith('provider');
  const isAdmin = role === 'admin';
  const roleLabel = isProvider
    ? i18n.t('profile.role.provider', { defaultValue: 'Провайдер / Инспектор' })
    : isAdmin
    ? i18n.t('profile.role.admin', { defaultValue: 'Администратор' })
    : i18n.t('profile.role.customer', { defaultValue: 'Клиент' });
  const workspaceLink = isProvider
    ? { path: '/provider/workbench', label: i18n.t('profile.open_workbench', { defaultValue: 'Открыть рабочую область' }) }
    : isAdmin
    ? { path: '/(tabs)', label: i18n.t('profile.open_dashboard', { defaultValue: 'Открыть панель' }) }
    : null;

  const language = i18n.language as 'de' | 'en' | 'ru';
  const setLanguage = (lng: 'de' | 'en' | 'ru') => i18n.changeLanguage(lng);
  const currentLang = LANGUAGES.find((l) => l.code === language) || LANGUAGES[0];

  const [showLanguageModal, setShowLanguageModal] = useState(false);
  const [showLogoutModal, setShowLogoutModal] = useState(false);

  const [notifEmail, setNotifEmail] = useState(true);
  const [notifPush, setNotifPush] = useState(true);

  // ─── Counts (real endpoints, no fake metrics) ───────────────────────────
  const [garageCount, setGarageCount] = useState<number | null>(null);
  const [reqCount, setReqCount] = useState<number | null>(null);
  const [reportCount, setReportCount] = useState<number | null>(null);

  const loadCounts = useCallback(async () => {
    if (!user) return;
    // For providers: workbench items, completed jobs (no customer endpoints).
    // For customers: garage, requests, reports.
    if (isProvider) {
      const settled = await Promise.allSettled([
        api.get('/provider/work-items'),
        api.get('/inspector/jobs'),
      ]);
      const [wi, jobs] = settled;
      if (wi.status === 'fulfilled') {
        const items = wi.value?.data?.items || [];
        setReqCount(Array.isArray(items) ? items.length : 0);
      } else { setReqCount(0); }
      if (jobs.status === 'fulfilled') {
        const items = jobs.value?.data?.items || jobs.value?.data?.jobs || [];
        const completed = Array.isArray(items)
          ? items.filter((j: any) => j.state === 'completed' || j.status === 'completed').length
          : 0;
        setReportCount(completed);
      } else { setReportCount(0); }
      setGarageCount(0); // not applicable for providers
      return;
    }
    const settled = await Promise.allSettled([
      api.get('/customer/vehicles'),
      api.get('/requests/my'),
      api.get('/customer/reports'),
    ]);
    const [g, r, rep] = settled;
    if (g.status === 'fulfilled') {
      const items = Array.isArray(g.value?.data) ? g.value.data
        : (g.value?.data?.items || g.value?.data?.vehicles || []);
      setGarageCount(Array.isArray(items) ? items.length : 0);
    } else { setGarageCount(0); }
    if (r.status === 'fulfilled') {
      const items = r.value?.data?.items || r.value?.data?.requests || [];
      setReqCount(Array.isArray(items) ? items.length : 0);
    } else { setReqCount(0); }
    if (rep.status === 'fulfilled') {
      const items = rep.value?.data?.reports || [];
      setReportCount(Array.isArray(items) ? items.length : 0);
    } else { setReportCount(0); }
  }, [user, isProvider]);

  useFocusEffect(useCallback(() => { loadCounts(); }, [loadCounts]));

  const fullName =
    (user as any)?.firstName && (user as any)?.lastName
      ? `${(user as any).firstName} ${(user as any).lastName}`
      : (user as any)?.fullName || (user as any)?.name || user?.email?.split('@')[0] || '';

  const initials = fullName
    ? fullName.split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase()
    : (user?.email?.[0] || '?').toUpperCase();

  const onLogout = async () => {
    setShowLogoutModal(false);
    try { await logout(); } catch {}
    router.replace('/' as any);
  };

  // ─── Guest profile ──────────────────────────────────────────────────
  // Guest already entered the app via "Continue as guest" — they own a
  // valid session of the app surface (city, language, theme, support,
  // help). We do NOT push them back to /login. Auth-required actions
  // (заявки, отчёты, гараж) link to /login on demand only.
  if (!user) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
        <ScrollView contentContainerStyle={styles.body} testID="profile-screen-guest">
          {/* Guest identity card */}
          <View style={[styles.identityCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.avatar, { backgroundColor: (colors.brand || colors.primary) + '33' }]}>
              <Ionicons name="person-outline" size={26} color={colors.brand || colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                {t('profile.guest', { defaultValue: 'Гость' })}
              </Text>
              <Text style={[styles.emailLine, { color: colors.textSecondary }]} numberOfLines={2}>
                {t('profile.guest_sub', { defaultValue: 'Войдите, чтобы открыть заявки, отчёты и гараж' })}
              </Text>
              <View style={[styles.rolePill, { backgroundColor: (colors.brand || colors.primary) + '20' }]}>
                <Text style={[styles.rolePillText, { color: colors.brand || colors.primary }]}>
                  {t('profile.role.guest', { defaultValue: 'Гостевой режим' })}
                </Text>
              </View>
            </View>
          </View>

          {/* Guest auth CTAs */}
          <View style={styles.guestCtaRow}>
            <TouchableOpacity
              testID="guest-profile-login"
              style={[styles.guestCtaPrimary, { backgroundColor: colors.primary }]}
              onPress={() => router.push('/login' as any)}
              activeOpacity={0.85}
            >
              <Ionicons name="log-in-outline" size={18} color={colors.onPrimary || '#000'} />
              <Text style={[styles.guestCtaPrimaryText, { color: colors.onPrimary || '#000' }]}>
                {t('profile.login', { defaultValue: 'Войти' })}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="guest-profile-register"
              style={[styles.guestCtaSecondary, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => router.push('/register' as any)}
              activeOpacity={0.85}
            >
              <Ionicons name="person-add-outline" size={18} color={colors.text} />
              <Text style={[styles.guestCtaSecondaryText, { color: colors.text }]}>
                {t('profile.register', { defaultValue: 'Регистрация' })}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Locked counters — tap → login */}
          <View style={styles.countersRow}>
            {[
              { id: 'requests', icon: 'document-text' as const, label: t('profile.counters.requests', { defaultValue: 'Заявки' }) },
              { id: 'reports',  icon: 'shield-checkmark' as const, label: t('profile.counters.reports',  { defaultValue: 'Отчёты' }) },
              { id: 'garage',   icon: 'car-sport' as const,        label: t('profile.counters.garage',   { defaultValue: 'Гараж' }) },
            ].map((c) => (
              <TouchableOpacity
                key={c.id}
                testID={`guest-counter-${c.id}`}
                onPress={() => router.push('/login' as any)}
                style={[styles.counterCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                activeOpacity={0.85}
              >
                <Ionicons name={c.icon} size={18} color={colors.textSecondary} />
                <Ionicons name="lock-closed" size={12} color={colors.textMuted || colors.textSecondary} style={{ position: 'absolute', top: 8, right: 8 }} />
                <Text style={[styles.counterN, { color: colors.textSecondary }]}>—</Text>
                <Text style={[styles.counterLabel, { color: colors.textSecondary }]} numberOfLines={1}>{c.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* App preferences (fully available to guest) */}
          <SectionTitle colors={colors} title={t('profile.section.app', { defaultValue: 'Приложение' })} />

          <SettingsRow
            icon="location-outline"
            label={t('profile.city', { defaultValue: 'Город' })}
            value={selectedCity?.name || '—'}
            colors={colors}
            onPress={() => router.push('/city-select?redirect=/(tabs)/profile' as any)}
            testID="settings-city"
          />
          <SettingsRow
            icon="language-outline"
            label={t('profile.language', { defaultValue: 'Язык' })}
            value={`${currentLang.flag} ${currentLang.name}`}
            colors={colors}
            onPress={() => setShowLanguageModal(true)}
            testID="settings-language"
          />
          <SettingsRow
            icon={isDark ? 'moon-outline' : 'sunny-outline'}
            label={t('profile.theme', { defaultValue: 'Тема' })}
            value={isDark ? t('profile.theme_dark', { defaultValue: 'Тёмная' }) : t('profile.theme_light', { defaultValue: 'Светлая' })}
            colors={colors}
            onPress={() => setTheme(isDark ? 'light' : 'dark')}
            testID="settings-theme"
          />

          <SectionTitle colors={colors} title={t('profile.section.help', { defaultValue: 'Помощь' })} />

          <SettingsRow
            icon="help-circle-outline"
            label={t('profile.help_faq', { defaultValue: 'Помощь и FAQ' })}
            colors={colors}
            onPress={() => router.push('/help' as any)}
            testID="settings-help"
          />
          <SettingsRow
            icon="document-text-outline"
            label={t('profile.terms', { defaultValue: 'Условия использования' })}
            colors={colors}
            onPress={() => router.push('/help' as any)}
            testID="settings-terms"
          />

          <Text style={[styles.versionText, { color: colors.textMuted || colors.textSecondary }]}>
            Auto Search · v1.0
          </Text>
        </ScrollView>

        {/* Language modal (reused for guest) */}
        <Modal visible={showLanguageModal} transparent animationType="fade" onRequestClose={() => setShowLanguageModal(false)}>
          <Pressable style={styles.modalBackdrop} onPress={() => setShowLanguageModal(false)}>
            <Pressable style={[styles.modalSheet, { backgroundColor: colors.card }]} onPress={(e) => e.stopPropagation()}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                {t('profile.language_modal_title', { defaultValue: 'Выберите язык' })}
              </Text>
              {LANGUAGES.map((l) => (
                <TouchableOpacity
                  key={l.code}
                  testID={`lang-opt-${l.code}`}
                  style={[styles.modalRow, { borderBottomColor: colors.border }]}
                  onPress={() => { setLanguage(l.code); setShowLanguageModal(false); }}
                  activeOpacity={0.7}
                >
                  <Text style={{ fontSize: 22 }}>{l.flag}</Text>
                  <Text style={[styles.modalRowText, { color: colors.text, flex: 1 }]}>{l.name}</Text>
                  {language === l.code && <Ionicons name="checkmark" size={20} color={colors.primary} />}
                </TouchableOpacity>
              ))}
            </Pressable>
          </Pressable>
        </Modal>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body}>
        {/* ─── Identity card ─────────────────────────────────────────── */}
        <View style={[styles.identityCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>{fullName || t('profile.you', { defaultValue: 'Вы' })}</Text>
            <Text style={[styles.emailLine, { color: colors.textSecondary }]} numberOfLines={1}>{user.email}</Text>
            <View style={[styles.rolePill, { backgroundColor: (colors.brand || colors.primary) + '20' }]}>
              <Text style={[styles.rolePillText, { color: colors.brand || colors.primary }]}>
                {roleLabel}
              </Text>
            </View>
          </View>
        </View>

        {/* ─── Workspace CTA (provider/admin only) ───────────────────── */}
        {workspaceLink && (
          <TouchableOpacity
            testID="profile-workspace-cta"
            onPress={() => router.push(workspaceLink.path as any)}
            activeOpacity={0.85}
            style={[styles.workspaceCta, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <View style={[styles.workspaceIcon, { backgroundColor: colors.primary + '20' }]}>
              <Ionicons name={isProvider ? 'briefcase-outline' : 'speedometer-outline'} size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.workspaceTitle, { color: colors.text }]}>{workspaceLink.label}</Text>
              <Text style={[styles.workspaceSub, { color: colors.textSecondary }]}>
                {isProvider
                  ? t('profile.workspace_sub_provider', { defaultValue: 'Заявки, расписание, задачи и оплата' })
                  : t('profile.workspace_sub_admin', { defaultValue: 'Управление платформой' })}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        )}

        {/* ─── Counters (live data) ──────────────────────────────────── */}
        <View style={styles.countersRow}>
          {(isProvider
            ? [
                { id: 'jobs',     icon: 'list-circle' as const,    n: reqCount,    label: t('profile.counters.jobs',      { defaultValue: 'Активные' }), onPress: () => router.push('/provider/workbench' as any) },
                { id: 'done',     icon: 'checkmark-done' as const, n: reportCount, label: t('profile.counters.completed', { defaultValue: 'Завершено' }), onPress: () => router.push('/inspector/jobs' as any) },
                { id: 'reviews',  icon: 'star' as const,           n: 0,           label: t('profile.counters.reviews',   { defaultValue: 'Отзывы' }),   onPress: () => router.push('/inspector/public-profile' as any) },
              ]
            : [
                { id: 'requests', icon: 'document-text' as const,    n: reqCount,    label: t('profile.counters.requests', { defaultValue: 'Заявки' }),  onPress: () => router.push('/(tabs)/requests' as any) },
                { id: 'reports',  icon: 'shield-checkmark' as const, n: reportCount, label: t('profile.counters.reports',  { defaultValue: 'Отчёты' }), onPress: () => router.push('/(tabs)/reports' as any) },
                { id: 'garage',   icon: 'car-sport' as const,        n: garageCount, label: t('profile.counters.garage',   { defaultValue: 'Гараж' }),   onPress: () => router.push('/(tabs)/garage' as any) },
              ]
          ).map((c) => (
            <TouchableOpacity
              key={c.id}
              testID={`counter-${c.id}`}
              onPress={c.onPress}
              style={[styles.counterCard, { backgroundColor: colors.card, borderColor: colors.border }]}
              activeOpacity={0.85}
            >
              <Ionicons name={c.icon} size={18} color={colors.primary} />
              <Text style={[styles.counterN, { color: colors.text }]}>{c.n ?? '–'}</Text>
              <Text style={[styles.counterLabel, { color: colors.textSecondary }]} numberOfLines={1}>{c.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ─── Settings sections ─────────────────────────────────────── */}
        <SectionTitle colors={colors} title={t('profile.section.account', { defaultValue: 'Аккаунт' })} />

        <SettingsRow
          icon="person-outline"
          label={t('profile.edit', { defaultValue: 'Редактировать профиль' })}
          value={fullName}
          colors={colors}
          onPress={() => router.push('/profile/edit' as any)}
          testID="settings-edit"
        />
        {isProvider && (
          <SettingsRow
            icon="shield-checkmark-outline"
            label={t('profile.verification', { defaultValue: 'Верификация документов' })}
            value={t('profile.verification_sub', { defaultValue: 'Паспорт · TÜV · страховка' })}
            colors={colors}
            onPress={() => router.push('/inspector/verification' as any)}
            testID="settings-verification"
          />
        )}
        {isAdmin && (
          <>
            <SettingsRow
              icon="globe-outline"
              label={t('profile.coverage', { defaultValue: 'Operational Coverage' })}
              value={t('profile.coverage_sub', { defaultValue: 'Geo-3 · marketplace topology' })}
              colors={colors}
              onPress={() => router.push('/admin/coverage' as any)}
              testID="settings-coverage"
            />
            <SettingsRow
              icon="business-outline"
              label={t('profile.partner_verifications', { defaultValue: 'Партнёрские заявки' })}
              value={t('profile.partner_verifications_sub', { defaultValue: 'Approve / reject регистраций' })}
              colors={colors}
              onPress={() => router.push('/admin/partner-verifications' as any)}
              testID="settings-partner-verifications"
            />
          </>
        )}
        <SettingsRow
          icon="location-outline"
          label={t('profile.city', { defaultValue: 'Город' })}
          value={selectedCity?.name || '—'}
          colors={colors}
          onPress={() => router.push('/city-select?redirect=/(tabs)/profile' as any)}
          testID="settings-city"
        />
        <SettingsRow
          icon="language-outline"
          label={t('profile.language', { defaultValue: 'Язык' })}
          value={`${currentLang.flag} ${currentLang.name}`}
          colors={colors}
          onPress={() => setShowLanguageModal(true)}
          testID="settings-language"
        />
        <SettingsRow
          icon={isDark ? 'moon-outline' : 'sunny-outline'}
          label={t('profile.theme', { defaultValue: 'Тема' })}
          value={isDark ? t('profile.theme_dark', { defaultValue: 'Тёмная' }) : t('profile.theme_light', { defaultValue: 'Светлая' })}
          colors={colors}
          onPress={() => setTheme(isDark ? 'light' : 'dark')}
          testID="settings-theme"
        />

        <SectionTitle colors={colors} title={t('profile.section.notifications', { defaultValue: 'Уведомления' })} />

        <SettingsToggle
          icon="mail-outline"
          label={t('profile.notif_email', { defaultValue: 'Email-уведомления' })}
          value={notifEmail}
          onChange={setNotifEmail}
          colors={colors}
          testID="notif-email"
        />
        <SettingsToggle
          icon="notifications-outline"
          label={t('profile.notif_push', { defaultValue: 'Push-уведомления' })}
          value={notifPush}
          onChange={setNotifPush}
          colors={colors}
          testID="notif-push"
        />

        {/* Sprint 2FA — security section, available to ALL authenticated roles */}
        <SectionTitle colors={colors} title={t('profile.section.security', { defaultValue: 'Безопасность' })} />

        <SettingsRow
          icon="shield-checkmark-outline"
          label={t('profile.two_factor', { defaultValue: 'Двухфакторная аутентификация (2FA)' })}
          colors={colors}
          onPress={() => router.push('/security-2fa' as any)}
          testID="settings-2fa"
        />

        <SectionTitle colors={colors} title={t('profile.section.help', { defaultValue: 'Помощь' })} />

        <SettingsRow
          icon="help-buoy-outline"
          label={t('profile.support', { defaultValue: 'Связаться с поддержкой' })}
          colors={colors}
          onPress={() => router.push('/support' as any)}
          testID="settings-support"
        />
        <SettingsRow
          icon="help-circle-outline"
          label={t('profile.help_faq', { defaultValue: 'Помощь и FAQ' })}
          colors={colors}
          onPress={() => router.push('/help' as any)}
          testID="settings-help"
        />

        {/* ─── Logout ─────────────────────────────────────────────────── */}
        <TouchableOpacity
          testID="profile-logout"
          style={[styles.logoutBtn, { backgroundColor: colors.card, borderColor: colors.danger || '#dc2626' }]}
          onPress={() => setShowLogoutModal(true)}
          activeOpacity={0.85}
        >
          <Ionicons name="log-out-outline" size={18} color={colors.danger || '#dc2626'} />
          <Text style={[styles.logoutText, { color: colors.danger || '#dc2626' }]}>
            {t('profile.logout', { defaultValue: 'Выйти' })}
          </Text>
        </TouchableOpacity>

        <Text style={[styles.versionText, { color: colors.textMuted || colors.textSecondary }]}>
          Auto Search · v1.0
        </Text>
      </ScrollView>

      {/* Language modal */}
      <Modal visible={showLanguageModal} transparent animationType="fade" onRequestClose={() => setShowLanguageModal(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowLanguageModal(false)}>
          <Pressable style={[styles.modalSheet, { backgroundColor: colors.card }]} onPress={(e) => e.stopPropagation()}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {t('profile.language_modal_title', { defaultValue: 'Выберите язык' })}
            </Text>
            {LANGUAGES.map((l) => (
              <TouchableOpacity
                key={l.code}
                testID={`lang-opt-${l.code}`}
                style={[styles.modalRow, { borderBottomColor: colors.border }]}
                onPress={() => { setLanguage(l.code); setShowLanguageModal(false); }}
                activeOpacity={0.7}
              >
                <Text style={{ fontSize: 22 }}>{l.flag}</Text>
                <Text style={[styles.modalRowText, { color: colors.text, flex: 1 }]}>{l.name}</Text>
                {language === l.code && <Ionicons name="checkmark" size={20} color={colors.primary} />}
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Logout modal */}
      <Modal visible={showLogoutModal} transparent animationType="fade" onRequestClose={() => setShowLogoutModal(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowLogoutModal(false)}>
          <Pressable style={[styles.modalSheet, { backgroundColor: colors.card }]} onPress={(e) => e.stopPropagation()}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {t('profile.logout_confirm', { defaultValue: 'Выйти из аккаунта?' })}
            </Text>
            <View style={styles.modalBtnRow}>
              <TouchableOpacity
                testID="logout-cancel"
                style={[styles.modalBtn, { backgroundColor: colors.background, borderColor: colors.border }]}
                onPress={() => setShowLogoutModal(false)}
                activeOpacity={0.7}
              >
                <Text style={[styles.modalBtnText, { color: colors.text }]}>{t('common.cancel', { defaultValue: 'Отмена' })}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="logout-confirm"
                style={[styles.modalBtn, { backgroundColor: colors.danger || '#dc2626' }]}
                onPress={onLogout}
                activeOpacity={0.85}
              >
                <Text style={[styles.modalBtnText, { color: '#fff' }]}>{t('profile.logout', { defaultValue: 'Выйти' })}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────

function SectionTitle({ title, colors }: { title: string; colors: any }) {
  return <Text style={[styles.sectionTitle, { color: colors.textMuted || colors.textSecondary }]}>{title}</Text>;
}

function SettingsRow({
  icon, label, value, onPress, colors, testID,
}: { icon: any; label: string; value?: string; onPress: () => void; colors: any; testID: string }) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      activeOpacity={0.7}
      style={[styles.settingsRow, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <Ionicons name={icon} size={20} color={colors.text} />
      <Text style={[styles.settingsLabel, { color: colors.text }]}>{label}</Text>
      {value ? <Text style={[styles.settingsValue, { color: colors.textSecondary }]} numberOfLines={1}>{value}</Text> : null}
      <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
    </TouchableOpacity>
  );
}

function SettingsToggle({
  icon, label, value, onChange, colors, testID,
}: { icon: any; label: string; value: boolean; onChange: (v: boolean) => void; colors: any; testID: string }) {
  return (
    <View style={[styles.settingsRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Ionicons name={icon} size={20} color={colors.text} />
      <Text style={[styles.settingsLabel, { color: colors.text, flex: 1 }]}>{label}</Text>
      <Switch
        testID={testID}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.border, true: colors.primary }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32 },

  identityCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: 16, borderRadius: 16, borderWidth: 1, marginBottom: 14,
  },
  workspaceCta: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 14,
    borderRadius: 14, borderWidth: 1, marginBottom: 14,
  },
  workspaceIcon: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  workspaceTitle: { fontSize: 14, fontWeight: '800' },
  workspaceSub:   { fontSize: 12, marginTop: 2 },
  avatar: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#000', fontSize: 20, fontWeight: '800' },
  name: { fontSize: 17, fontWeight: '800' },
  emailLine: { fontSize: 13, marginTop: 2 },
  rolePill: { alignSelf: 'flex-start', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, marginTop: 6 },
  rolePillText: { fontSize: 11, fontWeight: '700' },

  countersRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  counterCard: {
    flex: 1, alignItems: 'center', padding: 12, borderRadius: 12, borderWidth: 1, gap: 4,
  },
  counterN: { fontSize: 20, fontWeight: '800' },
  counterLabel: { fontSize: 12 },

  sectionTitle: {
    fontSize: 11, fontWeight: '700', textTransform: 'uppercase',
    letterSpacing: 0.5, marginTop: 16, marginBottom: 8, paddingHorizontal: 4,
  },

  settingsRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 13, borderRadius: 12,
    borderWidth: 1, marginBottom: 6,
  },
  settingsLabel: { fontSize: 14, fontWeight: '600', flex: 1 },
  settingsValue: { fontSize: 13, fontWeight: '500', maxWidth: 140 },

  logoutBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 13, borderRadius: 12, borderWidth: 1, marginTop: 24,
  },
  logoutText: { fontSize: 14, fontWeight: '700' },
  versionText: { fontSize: 11, marginTop: 16, textAlign: 'center' },

  signedOutWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  signedOutTitle: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  signedOutSub: { fontSize: 14, textAlign: 'center', marginBottom: 12 },
  cta: { paddingHorizontal: 32, paddingVertical: 14, borderRadius: 12, marginTop: 8 },
  ctaText: { fontSize: 15, fontWeight: '700' },

  guestCtaRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  guestCtaPrimary: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 13, borderRadius: 12,
  },
  guestCtaPrimaryText: { fontSize: 14, fontWeight: '800' },
  guestCtaSecondary: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 13, borderRadius: 12, borderWidth: 1,
  },
  guestCtaSecondaryText: { fontSize: 14, fontWeight: '700' },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: { padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20, gap: 8 },
  modalTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8 },
  modalRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalRowText: { fontSize: 15, fontWeight: '500' },
  modalBtnRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  modalBtn: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 10, borderWidth: 1 },
  modalBtnText: { fontSize: 14, fontWeight: '700' },
});

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../src/context/AuthContext';
import { useThemeContext } from '../src/context/ThemeContext';
import { theme } from '../src/context/ThemeContext';
import i18n from '../src/i18n';
const colors = theme.colors;

export default function SettingsScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const { colors, theme, setTheme, isDark } = useThemeContext();
  const { t, i18n } = useTranslation();
  const lang = (i18n.language as 'en' | 'de') || 'de';
  const langLabel = lang === 'de' ? 'Deutsch' : 'English';
  const [pushEnabled, setPushEnabled] = useState(true);
  const [emailNotifs, setEmailNotifs] = useState(true);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const push = await AsyncStorage.getItem('settings_push');
      const email = await AsyncStorage.getItem('settings_email');
      if (push !== null) setPushEnabled(push === 'true');
      if (email !== null) setEmailNotifs(email === 'true');
    } catch {}
  };

  const handlePushToggle = async (value: boolean) => {
    setPushEnabled(value);
    await AsyncStorage.setItem('settings_push', value.toString());
  };

  const handleEmailToggle = async (value: boolean) => {
    setEmailNotifs(value);
    await AsyncStorage.setItem('settings_email', value.toString());
  };

  const handleLogout = () => {
    Alert.alert(i18n.t('settings.logout_confirm_title'), i18n.t('settings.logout_confirm_body'), [
      { text: i18n.t('common.cancel'), style: 'cancel' },
      {
        text: i18n.t('settings.logout_action_btn'),
        style: 'destructive',
        onPress: async () => {
          await logout();
          router.replace('/');
        },
      },
    ]);
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      i18n.t('settings.delete_account_title'),
      i18n.t('settings.delete_account_body'),
      [
        { text: i18n.t('common.cancel'), style: 'cancel' },
        {
          text: i18n.t('settings.delete_account'),
          style: 'destructive',
          onPress: () => {
            Alert.alert(i18n.t('settings.delete_account_in_dev_title'), i18n.t('settings.delete_account_in_dev_body'));
          },
        },
      ]
    );
  };

  // ─── ThemePicker (Dark / Light) ─────────────────────────────────
  const ThemePicker = () => (
    <View style={styles.themePickerWrap}>
      {(['light', 'dark'] as const).map((mode) => {
        const active = theme === mode;
        const isLight = mode === 'light';
        return (
          <TouchableOpacity
            key={mode}
            testID={`theme-option-${mode}`}
            activeOpacity={0.85}
            onPress={() => setTheme(mode)}
            style={[
              styles.themeOption,
              {
                backgroundColor: active ? colors.accentSoft : colors.backgroundTertiary,
                borderColor: active ? colors.accent : colors.border,
              },
            ]}
          >
            <View style={[styles.themePreview, { backgroundColor: isLight ? colors.text : colors.bg }]}>
              <View style={[styles.previewBar, { backgroundColor: isLight ? colors.text : colors.card }]}>
                <View
                  style={[
                    styles.previewDot,
                    { backgroundColor: isLight ? colors.brand : colors.brand },
                  ]}
                />
              </View>
              <View style={[styles.previewBlock, { backgroundColor: isLight ? colors.text : colors.card }]} />
              <View
                style={[
                  styles.previewCta,
                  { backgroundColor: isLight ? colors.brandText : colors.brand },
                ]}
              />
            </View>
            <View style={styles.themeRow}>
              <Text style={[styles.themeLabel, { color: colors.text }]}>
                {mode === 'light' ? t('settings.theme_light') : t('settings.theme_dark')}
              </Text>
              {active && (
                <View style={[styles.themeCheck, { backgroundColor: colors.accent }]}>
                  <Ionicons name="checkmark" size={14} color={colors.brandText ?? colors.brandText} />
                </View>
              )}
            </View>
            <Text style={[styles.themeHint, { color: colors.textMuted }]}>
              {mode === 'light' ? t('settings.theme_light_hint') : t('settings.theme_dark_hint')}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.divider }]}>
        <TouchableOpacity
          testID="settings-back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.backgroundTertiary }]}
        >
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>{t('settings.title')}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Appearance */}
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.appearance')}</Text>
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.appearanceHead}>
            <View style={styles.settingInfo}>
              <Ionicons name={isDark ? 'moon' : 'sunny'} size={22} color={colors.accent} />
              <View style={styles.settingText}>
                <Text style={[styles.settingLabel, { color: colors.text }]}>{t('settings.theme_label')}</Text>
                <Text style={[styles.settingDesc, { color: colors.textMuted }]}>
                  {t('settings.theme_desc')}
                </Text>
              </View>
            </View>
          </View>
          <View style={[styles.themePickerContainer]}>
            <ThemePicker />
          </View>
        </View>

        {/* Notifications */}
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.notifications')}</Text>
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.settingItem}>
            <View style={styles.settingInfo}>
              <Ionicons name="notifications" size={22} color={colors.accent} />
              <View style={styles.settingText}>
                <Text style={[styles.settingLabel, { color: colors.text }]}>{t('settings.push_label')}</Text>
                <Text style={[styles.settingDesc, { color: colors.textMuted }]}>
                  {t('settings.push_desc')}
                </Text>
              </View>
            </View>
            <Switch
              testID="settings-push-toggle"
              value={pushEnabled}
              onValueChange={handlePushToggle}
              trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
              thumbColor={colors.switchThumb}
            />
          </View>
          <View style={[styles.divider, { backgroundColor: colors.divider }]} />
          <View style={styles.settingItem}>
            <View style={styles.settingInfo}>
              <Ionicons name="mail" size={22} color={colors.info} />
              <View style={styles.settingText}>
                <Text style={[styles.settingLabel, { color: colors.text }]}>{t('settings.email_label')}</Text>
                <Text style={[styles.settingDesc, { color: colors.textMuted }]}>
                  {t('settings.email_desc')}
                </Text>
              </View>
            </View>
            <Switch
              testID="settings-email-toggle"
              value={emailNotifs}
              onValueChange={handleEmailToggle}
              trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
              thumbColor={colors.switchThumb}
            />
          </View>
        </View>

        {/* Language */}
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.language_section')}</Text>
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TouchableOpacity
            testID="settings-language"
            style={styles.settingItem}
            onPress={() => router.push('/(tabs)/profile')}
            activeOpacity={0.7}
          >
            <View style={styles.settingInfo}>
              <Ionicons name="language" size={22} color={colors.success} />
              <View style={styles.settingText}>
                <Text style={[styles.settingLabel, { color: colors.text }]}>{t('settings.language_label')}</Text>
                <Text style={[styles.settingDesc, { color: colors.textMuted }]}>{langLabel}</Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Support */}
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.support_section')}</Text>
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TouchableOpacity
            testID="settings-faq"
            style={styles.settingItem}
            onPress={() => router.push('/help')}
            activeOpacity={0.7}
          >
            <View style={styles.settingInfo}>
              <Ionicons name="help-circle" size={22} color={colors.warning} />
              <View style={styles.settingText}>
                <Text style={[styles.settingLabel, { color: colors.text }]}>{t('settings.faq')}</Text>
                <Text style={[styles.settingDesc, { color: colors.textMuted }]}>
                  {t('settings.faq_desc')}
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
          <View style={[styles.divider, { backgroundColor: colors.divider }]} />
          <TouchableOpacity
            testID="settings-support"
            style={styles.settingItem}
            onPress={() => router.push('/support')}
            activeOpacity={0.7}
          >
            <View style={styles.settingInfo}>
              <Ionicons name="chatbubble-ellipses" size={22} color={colors.info} />
              <View style={styles.settingText}>
                <Text style={[styles.settingLabel, { color: colors.text }]}>{t('settings.contact_support')}</Text>
                <Text style={[styles.settingDesc, { color: colors.textMuted }]}>
                  {t('settings.contact_support_desc')}
                </Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Legal */}
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.legal_section')}</Text>
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TouchableOpacity
            testID="settings-terms"
            style={styles.settingItem}
            onPress={() => router.push('/terms')}
            activeOpacity={0.7}
          >
            <View style={styles.settingInfo}>
              <Ionicons name="document-text" size={22} color={colors.textMuted} />
              <Text style={[styles.settingLabel, { color: colors.text }]}>{t('settings.terms')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
          <View style={[styles.divider, { backgroundColor: colors.divider }]} />
          <TouchableOpacity
            testID="settings-privacy"
            style={styles.settingItem}
            onPress={() => router.push('/privacy')}
            activeOpacity={0.7}
          >
            <View style={styles.settingInfo}>
              <Ionicons name="shield-checkmark" size={22} color={colors.textMuted} />
              <Text style={[styles.settingLabel, { color: colors.text }]}>
                {t('settings.privacy')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Account */}
        {user && (
          <>
            <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.account_section')}</Text>
            <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <TouchableOpacity style={styles.settingItem} onPress={handleLogout} testID="settings-logout">
                <View style={styles.settingInfo}>
                  <Ionicons name="log-out" size={22} color={colors.error} />
                  <Text style={[styles.settingLabel, { color: colors.error }]}>{t('settings.logout_action')}</Text>
                </View>
              </TouchableOpacity>
              <View style={[styles.divider, { backgroundColor: colors.divider }]} />
              <TouchableOpacity style={styles.settingItem} onPress={handleDeleteAccount}>
                <View style={styles.settingInfo}>
                  <Ionicons name="trash" size={22} color={colors.error} />
                  <Text style={[styles.settingLabel, { color: colors.error }]}>{t('settings.delete_account')}</Text>
                </View>
              </TouchableOpacity>
            </View>
          </>
        )}

        <Text style={[styles.version, { color: colors.textMuted }]}>{t('settings.version')}</Text>
        <Text style={[styles.copyright, { color: colors.textMuted }]}>{t('settings.copyright')}</Text>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 18, fontWeight: '700' },
  content: { flex: 1, paddingHorizontal: 16 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 24,
    marginBottom: 8,
    marginLeft: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  section: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  appearanceHead: {
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  settingInfo: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 12 },
  settingText: { flex: 1 },
  settingLabel: { fontSize: 16, fontWeight: '500' },
  settingDesc: { fontSize: 13, marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 50 },
  version: { textAlign: 'center', fontSize: 14, marginTop: 32 },
  copyright: { textAlign: 'center', fontSize: 12, marginTop: 4 },
  themePickerContainer: { paddingHorizontal: 16, paddingBottom: 16 },
  themePickerWrap: { flexDirection: 'row', gap: 12 },
  themeOption: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1.5,
    padding: 12,
  },
  themePreview: {
    height: 76,
    borderRadius: 10,
    padding: 8,
    justifyContent: 'space-between',
  },
  previewBar: {
    height: 12,
    borderRadius: 4,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  previewDot: { width: 6, height: 6, borderRadius: 3 },
  previewBlock: { height: 18, borderRadius: 4, marginVertical: 4 },
  previewCta: { height: 16, borderRadius: 5, alignSelf: 'flex-end', width: '50%' },
  themeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  themeLabel: { fontSize: 15, fontWeight: '600' },
  themeCheck: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeHint: { fontSize: 11, marginTop: 2 },
});

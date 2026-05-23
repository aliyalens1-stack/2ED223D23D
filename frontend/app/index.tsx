// ═════════════════════════════════════════════════════════
// 🏠 Welcome — compact, premium, sales-driven layout
// Sprint 11C-UI redo: kicker as a pill (no overflow), tightened
// hero (h1 28/32 lh, subtitle 2 lines), action cards with single-line
// titles + 1 line hints. Trust block stays 4 rows but with tighter
// rhythm. The whole screen now fits in a single thumb scroll.
// ═════════════════════════════════════════════════════════
import React, { useEffect } from 'react';
import { View, StyleSheet, TouchableOpacity, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../src/context/ThemeContext';
import { useAuth } from '../src/context/AuthContext';
import Text from '../src/components/ui/Text';
import Brand from '../src/components/Brand';
import LanguageSwitcher from '../src/components/LanguageSwitcher';
import { tokens } from '../src/theme/tokens';

export default function WelcomeScreen() {
  const { colors, isDark } = useThemeContext();
  const router = useRouter();
  const auth = useAuth();
  const { t } = useTranslation();
  const styles = makeStyles(colors, isDark);

  useEffect(() => {
    if (!auth.isLoading && auth.isAuthenticated && auth.user) {
      router.replace('/(tabs)');
    }
  }, [auth.isLoading, auth.isAuthenticated, auth.user, router]);

  const goLogin = () => router.push('/login');
  const goGuest = async () => { await auth.continueAsGuest(); router.replace('/(tabs)'); };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="welcome-screen">
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {/* HEADER — brand left, language right */}
        <View style={styles.topRow}>
          <Brand height={22} testID="welcome-logo" />
          <LanguageSwitcher />
        </View>

        {/* HERO — compact: kicker pill, tight h1, short subtitle */}
        <View style={styles.heroBlock}>
          <View style={styles.kickerPill} testID="welcome-kicker-pill">
            <View style={styles.kickerDot} />
            <Text
              testID="welcome-kicker"
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
              style={styles.kickerText}
            >
              {t('welcome.kicker')}
            </Text>
          </View>

          <Text variant="h1" testID="welcome-title" style={styles.title}>
            {t('welcome.title_v2')}
          </Text>

          <Text
            variant="body"
            tone="muted"
            testID="welcome-subtitle"
            numberOfLines={2}
            style={styles.subtitle}
          >
            {t('welcome.subtitle_v2')}
          </Text>
        </View>

        {/* ACTIONS — single primary CTA + ghost secondary */}
        <View style={styles.actions}>
          <ActionCard
            primary
            icon="car-sport"
            title={t('welcome.primary_cta')}
            hint={t('welcome.subtitle_fear')}
            onPress={() => router.push('/auto-request/choose')}
            testID="welcome-find-car"
            colors={colors}
            isDark={isDark}
          />
          <ActionCard
            icon="briefcase-outline"
            title={t('welcome.secondary_cta')}
            hint={t('welcome.start_earning_hint')}
            onPress={() => router.push('/register?role=provider')}
            testID="welcome-become-inspector"
            colors={colors}
            isDark={isDark}
          />
        </View>

        {/* TRUST SIGNALS — compact 4-row stack, tighter rhythm */}
        <View style={styles.trustBlock} testID="welcome-trust-block">
          <TrustItem icon="shield-checkmark" title={t('trust.tuv_inspection')}    sub={t('trust.tuv_inspection_sub')}    colors={colors} isDark={isDark} testID="trust-tuv" />
          <TrustItem icon="people"           title={t('trust.local_inspectors')}  sub={t('trust.local_inspectors_sub')}  colors={colors} isDark={isDark} testID="trust-local" />
          <TrustItem icon="time"             title={t('trust.reports_24h')}       sub={t('trust.reports_24h_sub')}       colors={colors} isDark={isDark} testID="trust-24h" />
          <TrustItem icon="camera"           title={t('trust.photo_video_proof')} sub={t('trust.photo_video_proof_sub')} colors={colors} isDark={isDark} testID="trust-proof" />
        </View>

        {/* SECONDARY (additional + auth + guest) */}
        <View style={styles.secondary}>
          <TouchableOpacity
            style={styles.repairLink}
            onPress={async () => { await auth.continueAsGuest(); router.push('/additional'); }}
            testID="welcome-additional-link"
          >
            <Ionicons name="ellipsis-horizontal-circle-outline" size={14} color={colors.textSecondary} />
            <Text variant="caption" tone="muted" weight="700">
              {t('welcome.tertiary_text')}
            </Text>
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity style={styles.loginButton} onPress={goLogin} testID="welcome-login-link">
            <Text variant="body" weight="800" align="center">
              {t('welcome.have_account_login')}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.skipButton} onPress={goGuest} testID="welcome-skip">
            <Text variant="caption" tone="muted" weight="700" align="center">
              {t('welcome.continue_as_guest')}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Trust Item ─────────────────────────────────────────────────────
function TrustItem({
  icon, title, sub, colors, isDark, testID,
}: {
  icon: any; title: string; sub: string;
  colors: any; isDark: boolean; testID: string;
}) {
  return (
    <View style={trustStyles(colors, isDark).row} testID={testID}>
      <View style={trustStyles(colors, isDark).iconBox}>
        <Ionicons name={icon} size={14} color={colors.brand} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text variant="caption" weight="800" numberOfLines={1} style={{ color: colors.text }}>
          {title}
        </Text>
        <Text variant="micro" tone="muted" numberOfLines={1} style={trustStyles(colors, isDark).sub}>
          {sub}
        </Text>
      </View>
    </View>
  );
}

function trustStyles(colors: any, _isDark: boolean) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 6,
    },
    iconBox: {
      width: 24,
      height: 24,
      borderRadius: 7,
      backgroundColor: colors.brandSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sub: { letterSpacing: 0.2 },
  });
}

// ─── Action Card — compact ─────────────────────────────────────────
function ActionCard({
  icon, title, hint, onPress, testID, primary = false, colors, isDark,
}: {
  icon: any; title: string; hint: string;
  onPress: () => void; testID: string; primary?: boolean;
  colors: any; isDark: boolean;
}) {
  const styles = makeStyles(colors, isDark);
  return (
    <TouchableOpacity
      style={primary ? styles.primaryCard : styles.secondaryCard}
      activeOpacity={0.85}
      onPress={onPress}
      testID={testID}
    >
      <View style={primary ? styles.primaryIcon : styles.secondaryIcon}>
        <Ionicons
          name={icon}
          size={18}
          color={primary ? tokens.colors.onBrand : colors.brand}
        />
      </View>
      <View style={styles.cardTextBlock}>
        <Text
          variant="body"
          weight={primary ? '900' : '800'}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.8}
          style={[styles.cardTitle, primary && styles.primaryTitle]}
        >
          {title}
        </Text>
        <Text
          variant="micro"
          weight="600"
          tone={primary ? undefined : 'muted'}
          numberOfLines={1}
          style={[styles.cardHint, primary && styles.primaryHint]}
        >
          {hint}
        </Text>
      </View>
      <Ionicons
        name="chevron-forward"
        size={18}
        color={primary ? tokens.colors.onBrand : colors.textSecondary}
      />
    </TouchableOpacity>
  );
}

function makeStyles(colors: any, isDark: boolean) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    scrollContent: {
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 24,
      maxWidth: 460,
      width: '100%',
      alignSelf: 'center',
    },
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 20,
    },

    // HERO
    heroBlock: { marginBottom: 20 },
    kickerPill: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: tokens.radius.pill,
      backgroundColor: colors.brandSoft,
      marginBottom: 14,
    },
    kickerDot: {
      width: 5, height: 5, borderRadius: 3,
      backgroundColor: colors.brand,
    },
    kickerText: {
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 0.6,
      color: colors.brand,
      textTransform: 'uppercase',
    },
    title: {
      fontSize: 28,
      lineHeight: 32,
      marginBottom: 10,
      letterSpacing: -0.6,
    },
    subtitle: { fontSize: 14, lineHeight: 19, maxWidth: 380 },

    // ACTIONS
    actions: { gap: 10, marginBottom: 18 },

    // TRUST BLOCK
    trustBlock: {
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: tokens.radius.md,
      paddingVertical: 10,
      paddingHorizontal: 14,
      marginBottom: 4,
      gap: 2,
    },

    primaryCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.brand,
      borderRadius: tokens.radius.md,
      paddingVertical: 13,
      paddingHorizontal: 14,
      ...Platform.select({
        ios: {
          shadowColor: colors.brand,
          shadowOpacity: isDark ? 0.28 : 0.18,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 6 },
        },
        android: { elevation: 5 },
        default: {},
      }),
    },
    primaryIcon: {
      width: 36, height: 36, borderRadius: 11,
      backgroundColor: 'rgba(0,0,0,0.14)',
      alignItems: 'center', justifyContent: 'center',
    },
    primaryTitle: { color: tokens.colors.onBrand },
    primaryHint: { color: tokens.colors.onBrand, opacity: 0.82 },

    secondaryCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: tokens.radius.md,
      paddingVertical: 12,
      paddingHorizontal: 14,
    },
    secondaryIcon: {
      width: 36, height: 36, borderRadius: 11,
      backgroundColor: colors.brandSoft,
      alignItems: 'center', justifyContent: 'center',
    },
    cardTextBlock: { flex: 1, gap: 2 },
    cardTitle: { fontSize: 15, lineHeight: 19, letterSpacing: -0.2 },
    cardHint: { fontSize: 11, lineHeight: 14 },

    // SECONDARY
    secondary: { marginTop: 4 },
    repairLink: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 12,
    },
    divider: {
      height: 1,
      backgroundColor: colors.border,
      marginVertical: 8,
    },
    loginButton: { paddingVertical: 12 },
    skipButton: { paddingVertical: 6, marginTop: 2 },
  });
}

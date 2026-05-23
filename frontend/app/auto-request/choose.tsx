// Phase 3.0a — Welcome funnel split: customer chooses inspection vs selection.
//
// Sprint 11C-UI redo v2 (compact / premium / "продающий"):
//   - Header pill replaced with short eyebrow pill INSIDE hero (kicker
//     guaranteed fit at fontSize=10, locale-short copy "ПРЕДПОКУПКА · 24 Ч")
//   - H1 now hand-styled (22/26) bypassing global Text variant=h1 (32/38)
//     which was massive on a 360pt screen
//   - ChoiceCard rebuilt: stacked icon+title row, price chip floats top-right
//     (absolute), hint single-line muted, sub becomes a footer pill (filled
//     for primary action, ghost for secondary). Total card height ~110pt.
//   - Primary card (inspection) gets brand-soft accent border to draw eye
//   - Trust strip: short locale labels, equal-width chips, no overflow at
//     any reasonable RN font scale
import React from 'react';
import { View, StyleSheet, TouchableOpacity, ScrollView, Platform, Text as RNText } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';
import { tokens } from '../../src/theme/tokens';

export default function ChooseRequestType() {
  const router = useRouter();
  const { colors, isDark } = useThemeContext();
  const { t } = useTranslation();

  return (
    <SafeAreaView
      style={[styles.screen, { backgroundColor: colors.background }]}
      edges={['top', 'bottom']}
      testID="choose-request-screen"
    >
      {/* HEADER — back button only, kicker moves into hero below */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          testID="choose-back"
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {/* HERO — short kicker pill + tight H1 */}
        <View style={[styles.kickerPill, { backgroundColor: colors.brandSoft }]} testID="choose-kicker-pill">
          <View style={[styles.kickerDot, { backgroundColor: colors.brand }]} />
          <RNText
            testID="choose-kicker"
            numberOfLines={1}
            style={[styles.kickerText, { color: colors.brand }]}
          >
            {t('choose.kicker')}
          </RNText>
        </View>

        <RNText style={[styles.title, { color: colors.text }]} testID="choose-title">
          {t('choose.title')}
        </RNText>

        {/* CARDS */}
        <ChoiceCard
          icon="shield-checkmark"
          title={t('choose.inspection_title')}
          hint={t('choose.inspection_hint')}
          sub={t('choose.inspection_sub')}
          priceText="€149"
          primary
          onPress={() => router.push('/auto-request/create?type=inspection')}
          testID="choose-inspection"
          colors={colors}
          isDark={isDark}
        />

        <ChoiceCard
          icon="search"
          title={t('choose.selection_title')}
          hint={t('choose.selection_hint')}
          sub={t('choose.selection_sub')}
          onPress={() => router.push('/auto-request/create?type=selection')}
          testID="choose-selection"
          colors={colors}
          isDark={isDark}
        />

        {/* TRUST STRIP — compact, short labels guaranteed to fit */}
        <View style={[styles.trustBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TrustChip icon="shield-checkmark" label={t('choose.trust_tuv')}   colors={colors} testID="trust-tuv" />
          <View style={[styles.trustDivider, { backgroundColor: colors.border }]} />
          <TrustChip icon="time-outline"     label={t('choose.trust_24h')}   colors={colors} testID="trust-24h" />
          <View style={[styles.trustDivider, { backgroundColor: colors.border }]} />
          <TrustChip icon="camera-outline"   label={t('choose.trust_proof')} colors={colors} testID="trust-proof" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// Plain RN Text is used directly so we don't accidentally pick up the
// global `<Text variant=body>` defaults (which add letterSpacing /
// fontWeight that fight the compact design). Local typography here
// is deliberate.

function TrustChip({ icon, label, colors, testID }: { icon: any; label: string; colors: any; testID?: string }) {
  return (
    <View style={trustChipStyles.chip} testID={testID}>
      <Ionicons name={icon} size={14} color={colors.brand} />
      <RNText
        numberOfLines={1}
        style={[trustChipStyles.label, { color: colors.textSecondary }]}
      >
        {label}
      </RNText>
    </View>
  );
}

const trustChipStyles = StyleSheet.create({
  chip: { flex: 1, alignItems: 'center', gap: 5, paddingVertical: 4 },
  label: { fontSize: 10, fontWeight: '700', letterSpacing: 0.2, textAlign: 'center' },
});

function ChoiceCard({
  icon, title, hint, sub, priceText, primary, onPress, testID, colors, isDark,
}: {
  icon: any; title: string; hint: string; sub?: string;
  priceText?: string; primary?: boolean;
  onPress: () => void; testID: string;
  colors: any; isDark: boolean;
}) {
  // Primary card carries a brand-tinted hairline border + slightly
  // stronger shadow so the €149 inspection always wins eye priority.
  const borderColor = primary ? colors.brand : colors.border;
  const borderWidth = primary ? 1.2 : 1;
  return (
    <TouchableOpacity
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor, borderWidth },
        primary && styles.cardPrimaryGlow,
      ]}
      activeOpacity={0.85}
      onPress={onPress}
      testID={testID}
    >
      {/* TOP ROW — icon + title + chevron. Price chip is absolute. */}
      <View style={styles.cardTopRow}>
        <View style={[styles.iconBox, { backgroundColor: colors.brandSoft }]}>
          <Ionicons name={icon} size={18} color={colors.brand} />
        </View>

        <View style={styles.cardTextBlock}>
          <RNText
            numberOfLines={1}
            style={[styles.cardTitle, { color: colors.text }]}
            testID={`${testID}-title`}
          >
            {title}
          </RNText>
          <RNText
            numberOfLines={1}
            style={[styles.cardHint, { color: colors.textSecondary }]}
            testID={`${testID}-hint`}
          >
            {hint}
          </RNText>
        </View>

        <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} style={{ marginLeft: 4 }} />
      </View>

      {/* FOOTER — sub pill (filled for primary, ghost for secondary) + price */}
      <View style={styles.cardFooter}>
        {sub ? (
          <View
            style={[
              styles.subPill,
              primary
                ? { backgroundColor: colors.brand }
                : { backgroundColor: isDark ? 'rgba(245,184,0,0.14)' : 'rgba(245,184,0,0.12)' },
            ]}
            testID={`${testID}-sub`}
          >
            <RNText
              numberOfLines={1}
              style={[
                styles.subPillText,
                { color: primary ? tokens.colors.onBrand : colors.brand },
              ]}
            >
              {sub}
            </RNText>
          </View>
        ) : <View />}

        {priceText ? (
          <View style={styles.pricePill} testID={`${testID}-price`}>
            <RNText style={[styles.pricePillText, { color: colors.brand }]}>
              {priceText}
            </RNText>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },

  body: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 28,
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },

  // HERO
  kickerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: tokens.radius.pill,
    marginBottom: 12,
  },
  kickerDot: { width: 5, height: 5, borderRadius: 3 },
  kickerText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },

  title: {
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '800',
    letterSpacing: -0.4,
    marginBottom: 16,
  },

  // CARD
  card: {
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 10,
    gap: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 2 },
      },
      android: { elevation: 1 },
      default: {},
    }),
  },
  cardPrimaryGlow: Platform.select({
    ios: {
      shadowColor: '#F5B800',
      shadowOpacity: 0.18,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
    },
    android: { elevation: 2 },
    default: {},
  }) as any,

  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBox: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  cardTextBlock: { flex: 1, gap: 2 },
  cardTitle: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  cardHint: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '500',
  },

  // FOOTER row inside card
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },

  // SUB pill (filled / ghost)
  subPill: {
    flexShrink: 1,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: tokens.radius.pill,
  },
  subPillText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.1,
  },

  // PRICE chip (text-only, no fill — brand color)
  pricePill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pricePillText: {
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: -0.2,
  },

  // TRUST BAR
  trustBar: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  trustDivider: { width: 1, marginVertical: 6 },
});

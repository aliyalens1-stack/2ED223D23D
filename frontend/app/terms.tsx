/**
 * Terms of Use — Auto Search Platform.
 *
 * Auto Search is a marketplace for pre-purchase car inspection + car selection
 * (we never buy/sell cars ourselves). Terms reflect this exact scope. Copy
 * lives in i18n `terms.sections.*` (DE / EN / RU stay in sync).
 */
import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../src/context/ThemeContext';
import { useTranslation } from 'react-i18next';

const TERMS_SECTIONS = [
  'acceptance',
  'service_description',
  'accounts',
  'user_obligations',
  'inspector_role',
  'reports',
  'payments',
  'cancellation',
  'disputes',
  'liability',
  'data_privacy',
  'changes',
  'governing_law',
  'contact',
];

export default function TermsScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: (colors as any).divider || colors.border }]}>
        <TouchableOpacity
          testID="terms-back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {t('terms.title')}
        </Text>
        <View style={{ width: 38 }} />
      </View>

      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Text style={[styles.lastUpdated, { color: (colors as any).textMuted || colors.textSecondary }]}>
          {t('terms.last_updated')}: 16.05.2026
        </Text>
        <Text style={[styles.intro, { color: colors.textSecondary }]}>
          {t('terms.intro')}
        </Text>

        {TERMS_SECTIONS.map((sec, i) => (
          <View key={sec} style={styles.section}>
            <Text style={[styles.sectionNum, { color: colors.primary }]}>{i + 1}.</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>
                {t(`terms.sections.${sec}.title`)}
              </Text>
              <Text style={[styles.sectionBody, { color: colors.textSecondary }]}>
                {t(`terms.sections.${sec}.body`)}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  lastUpdated: { fontSize: 12, marginBottom: 12 },
  intro: { fontSize: 14, lineHeight: 20, marginBottom: 20 },
  section: { flexDirection: 'row', gap: 10, marginBottom: 18 },
  sectionNum: { fontSize: 18, fontWeight: '700', minWidth: 24 },
  sectionTitle: { fontSize: 15, fontWeight: '700', marginBottom: 6 },
  sectionBody: { fontSize: 14, lineHeight: 20 },
});

import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../src/context/ThemeContext';
import { useTranslation } from 'react-i18next';
import Brand from '../src/components/Brand';

const APP_VERSION = '1.0.0';

export default function AboutScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();

  const openLink = async (url: string) => {
    try { await Linking.openURL(url); } catch {}
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.divider }]}>
        <TouchableOpacity
          testID="about-back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.backgroundTertiary }]}
        >
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>{t('about.title')}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.brandWrap}>
          <Brand height={48} />
          <Text style={[styles.appName, { color: colors.text }]}>AutoService Platform</Text>
          <Text style={[styles.version, { color: colors.textMuted }]}>v{APP_VERSION}</Text>
        </View>

        <Text style={[styles.body, { color: colors.textSecondary }]}>{t('about.tagline')}</Text>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>{t('about.what_we_do')}</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{t('about.what_we_do_body')}</Text>
        </View>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>{t('about.cities')}</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{t('about.cities_body')}</Text>
        </View>

        <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>{t('about.legal_links')}</Text>
        <View style={[styles.linksCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TouchableOpacity
            testID="about-terms"
            style={styles.linkRow}
            onPress={() => router.push('/terms')}
            activeOpacity={0.7}
          >
            <Ionicons name="document-text" size={20} color={colors.textMuted} />
            <Text style={[styles.linkLabel, { color: colors.text }]}>{t('settings.terms')}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
          <View style={[styles.divider, { backgroundColor: colors.divider }]} />
          <TouchableOpacity
            testID="about-privacy"
            style={styles.linkRow}
            onPress={() => router.push('/privacy')}
            activeOpacity={0.7}
          >
            <Ionicons name="shield-checkmark" size={20} color={colors.textMuted} />
            <Text style={[styles.linkLabel, { color: colors.text }]}>{t('settings.privacy')}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
          <View style={[styles.divider, { backgroundColor: colors.divider }]} />
          <TouchableOpacity
            testID="about-website"
            style={styles.linkRow}
            onPress={() => openLink('https://autoservice.com')}
            activeOpacity={0.7}
          >
            <Ionicons name="globe" size={20} color={colors.textMuted} />
            <Text style={[styles.linkLabel, { color: colors.text }]}>{t('about.website')}</Text>
            <Ionicons name="open-outline" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        <Text style={[styles.copyright, { color: colors.textMuted }]}>
          © 2026 AutoService Platform
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  brandWrap: { alignItems: 'center', marginBottom: 24, paddingTop: 16, gap: 8 },
  appName: { fontSize: 20, fontWeight: '700' },
  version: { fontSize: 13 },
  body: { fontSize: 14, lineHeight: 20 },
  card: {
    borderRadius: 14, borderWidth: StyleSheet.hairlineWidth,
    padding: 16, marginBottom: 12, gap: 8,
  },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  sectionLabel: {
    fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5,
    marginTop: 12, marginBottom: 8, marginLeft: 4,
  },
  linksCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  linkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, paddingHorizontal: 16,
  },
  linkLabel: { flex: 1, fontSize: 15, fontWeight: '500' },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 50 },
  copyright: { fontSize: 12, textAlign: 'center', marginTop: 24 },
});

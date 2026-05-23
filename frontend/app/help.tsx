/**
 * Help / FAQ — Auto Search Platform.
 *
 * Focused on the auto-selection + pre-purchase inspection business:
 *   • selection  — how we find the right car (mobile.de / autoscout24 / kleinanzeigen)
 *   • inspection — 60-point TÜV-style check, what's in the report
 *   • pricing    — how the price is formed, escrow flow
 *   • safety     — disputes, refunds, guarantees
 *   • support    — contacting humans, response times
 *
 * Copy lives in i18n `help.cat.*` (DE / EN / RU stay in sync).
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useThemeContext } from '../src/context/ThemeContext';
import type { ComponentProps } from 'react';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

interface FaqCategory {
  id: string;
  icon: IoniconName;
  tone: 'success' | 'brand' | 'warning' | 'info';
  questions: string[];
}

// Each `q` key here is paired with i18n keys:
//   help.cat.<catId>.title
//   help.cat.<catId>.<q>.q   (question)
//   help.cat.<catId>.<q>.a   (answer)
const FAQ: FaqCategory[] = [
  {
    id: 'selection',
    icon: 'sparkles',
    tone: 'brand',
    questions: ['how_we_find', 'sources', 'pre_visit_checks', 'agreement_flow', 'duration_selection'],
  },
  {
    id: 'inspection',
    icon: 'shield-checkmark',
    tone: 'success',
    questions: ['how_it_works', 'duration', 'whats_in_report', 'what_we_photograph', 'inspectors'],
  },
  {
    id: 'pricing',
    icon: 'card',
    tone: 'info',
    questions: ['how_price_formed', 'payment_methods', 'when_charged', 'extra_fees'],
  },
  {
    id: 'safety',
    icon: 'lock-closed',
    tone: 'warning',
    questions: ['guarantee', 'dispute', 'refund', 'data_privacy'],
  },
  {
    id: 'support',
    icon: 'help-buoy',
    tone: 'brand',
    questions: ['where_chat', 'response_time', 'languages'],
  },
];

export default function HelpScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();

  // Track expanded items as `${catId}/${q}` so multiple categories can stay open.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const brand = (colors as any).brand || colors.primary;
  const info = (colors as any).info || colors.primary;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: (colors as any).divider || colors.border }]}>
        <TouchableOpacity
          testID="help-back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {t('help.title')}
        </Text>
        <View style={{ width: 38 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={[styles.intro, { color: colors.textSecondary }]}>
          {t('help.intro')}
        </Text>

        {FAQ.map((cat) => {
          const tone = cat.tone === 'success' ? colors.success
            : cat.tone === 'warning' ? colors.warning
            : cat.tone === 'info' ? info
            : brand;
          return (
            <View key={cat.id} style={{ marginTop: 22 }}>
              <View style={styles.catHeader}>
                <View style={[styles.catIcon, { backgroundColor: tone + '22' }]}>
                  <Ionicons name={cat.icon} size={18} color={tone} />
                </View>
                <Text style={[styles.catTitle, { color: colors.text }]}>
                  {t(`help.cat.${cat.id}.title`)}
                </Text>
              </View>

              {cat.questions.map((q) => {
                const key = `${cat.id}/${q}`;
                const isOpen = open.has(key);
                return (
                  <TouchableOpacity
                    key={key}
                    testID={`faq-${cat.id}-${q}`}
                    onPress={() => toggle(key)}
                    activeOpacity={0.85}
                    style={[styles.qaCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <View style={styles.qRow}>
                      <Text style={[styles.qText, { color: colors.text }]}>
                        {t(`help.cat.${cat.id}.${q}.q`)}
                      </Text>
                      <Ionicons
                        name={isOpen ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color={(colors as any).textMuted || colors.textSecondary}
                      />
                    </View>
                    {isOpen ? (
                      <Text style={[styles.aText, { color: colors.textSecondary }]}>
                        {t(`help.cat.${cat.id}.${q}.a`)}
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          );
        })}

        {/* Contact CTA — fixed layout: icon in a circular badge, two-line text aligned left */}
        <TouchableOpacity
          testID="help-contact-support"
          style={[styles.cta, { backgroundColor: colors.primary }]}
          onPress={() => router.push('/support' as any)}
          activeOpacity={0.85}
        >
          <View style={[styles.ctaIconWrap, { backgroundColor: 'rgba(0,0,0,0.12)' }]}>
            <Ionicons name="chatbubble-ellipses" size={20} color={(colors as any).onPrimary || '#000'} />
          </View>
          <View style={styles.ctaTextCol}>
            <Text
              style={[styles.ctaTitle, { color: (colors as any).onPrimary || '#000' }]}
              numberOfLines={1}
            >
              {t('help.cta_title')}
            </Text>
            <Text
              style={[styles.ctaSub, { color: (colors as any).onPrimary || '#000' }]}
              numberOfLines={1}
            >
              {t('help.cta_sub')}
            </Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={18}
            color={(colors as any).onPrimary || '#000'}
            style={{ opacity: 0.6 }}
          />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },

  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  intro: { fontSize: 14, lineHeight: 20, marginBottom: 4 },

  catHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  catIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  catTitle: { fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },

  qaCard: { borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1 },
  qRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  qText: { flex: 1, fontSize: 14, fontWeight: '600', lineHeight: 19 },
  aText: { fontSize: 13.5, lineHeight: 20, marginTop: 10 },

  // CTA — icon badge on left, two-line text column, chevron on right.
  cta: {
    flexDirection: 'row', alignItems: 'center',
    gap: 14, marginTop: 28, paddingVertical: 14, paddingHorizontal: 16,
    borderRadius: 16,
  },
  ctaIconWrap: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  ctaTextCol: { flex: 1 },
  ctaTitle: { fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },
  ctaSub: { fontSize: 12.5, fontWeight: '500', opacity: 0.75, marginTop: 2 },
});

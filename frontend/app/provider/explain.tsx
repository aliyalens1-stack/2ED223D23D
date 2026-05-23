/**
 * Sprint 27 — Provider Explainability screen.
 * Отвечает на вопрос: t('provider.pochemu_ya_ne_v_tope') + что сделать + куда нажать.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { useAuth } from '../../src/context/AuthContext';
import { api } from '../../src/services/api';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

type Factor = {
  key: string;
  label: string;
  impact: number;
  tone: 'good' | 'neutral' | 'bad';
  value: number;
  subtitle?: string;
};
type Tip = {
  type: 'money' | 'critical' | 'danger' | 'warning' | 'good';
  text: string;
  cta?: string;
  ctaRoute?: string;
};
type Explain = {
  finalScore: number;
  headline: string;
  subline: string;
  factors: Factor[];
  tips: Tip[];
  boost: { level: string | null; multiplier: number };
  performance: { multiplier: number; score: number };
};

export default function ExplainScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useThemeContext();
  const { user, isLoading: authLoading } = useAuth();
  const styles = makeStyles(colors);
  const [data, setData] = useState<Explain | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/provider/performance/explain');
      setData(r.data);
    } catch (e) {
      console.log('explain err', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    load();
  }, [load, authLoading, user, router]);

  if (loading || !data) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="explain-back-btn"
          onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); }}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('provider.pochemu_vy_zdes')}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        {/* Score headline */}
        <View style={styles.scoreCard} testID="explain-headline">
          <Text style={styles.headlineLabel}>{t('provider.vash_score')}</Text>
          <Text style={styles.scoreValue}>{data.finalScore.toFixed(2)}</Text>
          <Text style={styles.headlineText}>{data.headline}</Text>
          <Text style={styles.sublineText}>{data.subline}</Text>
        </View>

        {/* Factors */}
        <Text style={styles.section}>{t('provider.chto_vliyaet')}</Text>
        {data.factors.map((f, i) => (
          <FactorRow key={f.key} colors={colors} f={f} testID={`factor-${f.key}`} />
        ))}

        {/* Tips */}
        <Text style={styles.section}>{t('provider.kak_podnyatsya_vyshe')}</Text>
        {data.tips.map((tip, i) => (
          <TipCard key={i} colors={colors} tip={tip} testID={`tip-${i}`} onCta={(route) => router.push(route as any)} />
        ))}

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function FactorRow({ colors, f, testID }: { colors: any; f: Factor; testID: string }) {
  const styles = makeStyles(colors);
  const toneColor = f.tone === 'good' ? colors.success : f.tone === 'bad' ? colors.error : colors.text;
  return (
    <View style={styles.factorRow} testID={testID}>
      <View style={{ flex: 1 }}>
        <Text style={styles.factorLabel}>{f.label}</Text>
        {!!f.subtitle && <Text style={styles.factorSub}>{f.subtitle}</Text>}
      </View>
      <Text style={[styles.factorImpact, { color: toneColor }]}>×{f.impact.toFixed(2)}</Text>
    </View>
  );
}

function TipCard({ colors, tip, testID, onCta }: { colors: any; tip: Tip; testID: string; onCta: (r: string) => void }) {
  const styles = makeStyles(colors);
  const toneBorder =
    tip.type === 'money' ? colors.primary :
    tip.type === 'danger' ? colors.error :
    tip.type === 'critical' ? colors.error :
    tip.type === 'warning' ? colors.warning :
    colors.border;
  return (
    <View style={[styles.tipCard, { borderColor: toneBorder }]} testID={testID}>
      <Text style={styles.tipText}>{tip.text}</Text>
      {!!tip.cta && !!tip.ctaRoute && (
        <TouchableOpacity
          testID={`${testID}-cta`}
          onPress={() => onCta(tip.ctaRoute!)}
          style={[styles.tipBtn, tip.type === 'money' && { backgroundColor: colors.primary }]}
          activeOpacity={0.85}
        >
          <Text style={[styles.tipBtnText, tip.type === 'money' && { color: colors.onPrimary }]}>{tip.cta} →</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (c: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backButton: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: c.card, alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 18, fontWeight: '700', color: c.text },
  content: { padding: 16 },

  scoreCard: {
    padding: 20, borderRadius: 16,
    backgroundColor: c.card, borderWidth: 1, borderColor: c.border,
    alignItems: 'flex-start',
  },
  headlineLabel: { fontSize: 11, color: c.primary, fontWeight: '800', letterSpacing: 1.4 },
  scoreValue: { fontSize: 38, fontWeight: '900', color: c.text, marginTop: 6, letterSpacing: -1 },
  headlineText: { fontSize: 18, fontWeight: '800', color: c.text, marginTop: 8 },
  sublineText: { fontSize: 13, color: c.textMuted, marginTop: 4, lineHeight: 18 },

  section: {
    fontSize: 13, fontWeight: '700', color: c.textSecondary,
    marginTop: 24, marginBottom: 10, letterSpacing: 0.4, textTransform: 'uppercase',
  },

  factorRow: {
    flexDirection: 'row', alignItems: 'center',
    padding: 14, borderRadius: 12,
    backgroundColor: c.card, borderWidth: 1, borderColor: c.border,
    marginBottom: 8,
  },
  factorLabel: { fontSize: 14, fontWeight: '700', color: c.text },
  factorSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  factorImpact: { fontSize: 18, fontWeight: '900' },

  tipCard: {
    padding: 14, borderRadius: 12,
    backgroundColor: c.card, borderWidth: 1,
    marginBottom: 8,
  },
  tipText: { fontSize: 14, color: c.text, lineHeight: 20, fontWeight: '600' },
  tipBtn: {
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: c.brandSoft,
    alignSelf: 'flex-start',
  },
  tipBtnText: { color: c.primary, fontSize: 13, fontWeight: '800' },
});

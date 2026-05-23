// ═════════════════════════════════════════════════════════
// 📊 Phase C.3 — Customer Comparison View
// Customer reads candidate cars attached by provider/concierge.
// Sorted: recommended first, then by score desc.
// ═════════════════════════════════════════════════════════
import React, { useEffect, useState } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as WebBrowser from 'expo-web-browser';
import { useThemeContext } from '../../../../src/context/ThemeContext';
import Text from '../../../../src/components/ui/Text';
import { api } from '../../../../src/services/api';
import i18n from '../../../../src/i18n';

type Risk = 'low' | 'medium' | 'high';

const RISK_TINT: Record<Risk, { color: string; bg: string; label: string }> = {
  low:    { color: '#22C55E', bg: 'rgba(34,197,94,0.15)',  label: 'Low' },
  medium: { color: '#FFB020', bg: 'rgba(255,176,32,0.18)', label: 'Medium' },
  high:   { color: '#EF4444', bg: 'rgba(239,68,68,0.15)',  label: 'High' },
};

const fmtEur = (v: number | null | undefined) =>
  v == null ? '—' : `€${Math.round(v).toLocaleString('de-DE')}`;
const fmtNum = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('de-DE');

export default function CandidatesComparison() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors, isDark } = useThemeContext();
  const params = useLocalSearchParams<{ id?: string }>();
  const requestId = (params.id || '').toString();

  const [items, setItems] = useState<any[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const styles = makeStyles(colors, isDark);

  useEffect(() => {
    if (!requestId) {
      setLoading(false);
      return;
    }
    let alive = true;
    api.get(`/customer/requests/${requestId}/candidates`)
      .then((r) => {
        if (!alive) return;
        setItems(r.data?.candidates || []);
        setCount(r.data?.count || 0);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e?.response?.data?.message || 'Failed to load');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [requestId]);

  const verdictText = (rec: boolean, risk: Risk | null | undefined) => {
    if (rec) return i18n.t('candidates.verdict_recommended') || 'Recommended';
    if (risk === 'high') return i18n.t('candidates.verdict_avoid') || 'Avoid';
    if (risk === 'medium') return i18n.t('candidates.verdict_risky') || 'Risky';
    return i18n.t('candidates.verdict_neutral') || 'Acceptable';
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']} testID="candidates-comparison">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} testID="cmp-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text variant="h3" weight="800" style={styles.headerTitle}>
          {t('candidates.header') || 'Compare cars'}
        </Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.emptyBox}>
          <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
          <Text variant="h3" weight="800" style={{ marginTop: 16 }}>{error}</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.emptyBox} testID="cmp-empty">
          <Ionicons name="hourglass-outline" size={48} color={colors.primary} />
          <Text variant="h3" weight="800" style={{ marginTop: 16, textAlign: 'center' }}>
            {t('candidates.empty_title') || 'Concierge is searching'}
          </Text>
          <Text variant="body" tone="muted" weight="500" style={{ marginTop: 8, textAlign: 'center', lineHeight: 22 }}>
            {t('candidates.empty_sub') || 'A real expert is hand-picking 3–5 cars for you. You will get a push when the shortlist is ready.'}
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text variant="caption" weight="800" tone="brand" style={{ letterSpacing: 1.2, marginBottom: 12 }}>
            {((t('candidates.shortlist') || 'Concierge shortlist') + ` · ${count}`).toUpperCase()}
          </Text>

          {items.map((c, idx) => {
            const tint = c.risk ? RISK_TINT[c.risk as Risk] : { color: colors.textSecondary, bg: 'rgba(127,127,127,0.10)', label: '—' };
            const hasImage = typeof c.preview?.image === 'string' && /^https?:\/\//i.test(c.preview.image);
            const title = c.preview?.title || [c.preview?.make, c.preview?.model].filter(Boolean).join(' ') || 'Vehicle';

            return (
              <View
                key={c.id}
                style={[
                  styles.card,
                  { backgroundColor: colors.card, borderColor: c.recommended ? '#22C55E' : colors.border },
                ]}
                testID={`cmp-card-${idx}`}
              >
                {/* Rank badge + recommended ribbon */}
                <View style={styles.cardTop}>
                  <View style={[styles.rankBadge, { backgroundColor: c.recommended ? '#22C55E' : colors.border }]}>
                    <Text variant="caption" weight="900" style={{ color: c.recommended ? '#000' : colors.text, fontSize: 13 }}>
                      #{idx + 1}
                    </Text>
                  </View>
                  {c.recommended ? (
                    <View style={styles.recRibbon}>
                      <Ionicons name="star" size={11} color="#000" />
                      <Text variant="caption" weight="900" style={{ marginLeft: 4, color: '#000', letterSpacing: 0.6, fontSize: 10 }}>
                        {(t('candidates.recommended') || 'Recommended').toUpperCase()}
                      </Text>
                    </View>
                  ) : null}
                </View>

                {/* Image + meta */}
                <View style={styles.imageRow}>
                  {hasImage ? (
                    <Image source={{ uri: c.preview.image }} style={styles.image} contentFit="cover" />
                  ) : (
                    <View style={[styles.imagePlaceholder, { backgroundColor: 'rgba(245,184,0,0.10)' }]}>
                      <Ionicons name="car-sport" size={36} color={colors.primary} />
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text variant="h3" weight="800" numberOfLines={2}>{title}</Text>
                    <View style={styles.metaRow}>
                      {c.preview?.year ? <Text variant="caption" tone="muted" weight="700">{c.preview.year}</Text> : null}
                      {c.preview?.year && c.preview?.mileage ? <Text variant="caption" tone="muted"> · </Text> : null}
                      {c.preview?.mileage ? <Text variant="caption" tone="muted" weight="700">{fmtNum(c.preview.mileage)} km</Text> : null}
                      {c.preview?.fuel ? <><Text variant="caption" tone="muted"> · </Text><Text variant="caption" tone="muted" weight="700">{String(c.preview.fuel).toUpperCase()}</Text></> : null}
                    </View>
                    <Text variant="h2" weight="900" style={{ marginTop: 6 }}>{fmtEur(c.preview?.price)}</Text>
                  </View>
                </View>

                {/* Score + Risk + Verdict row */}
                <View style={[styles.verdictRow, { backgroundColor: tint.bg, borderColor: tint.color }]}>
                  <View style={styles.vCell}>
                    <Text variant="caption" tone="muted" weight="700">
                      {(t('candidates.score') || 'Score').toUpperCase()}
                    </Text>
                    <Text variant="h2" weight="900" style={{ color: tint.color, marginTop: 2 }} testID={`cmp-card-${idx}-score`}>
                      {c.score != null ? Number(c.score).toFixed(1) : '—'}
                    </Text>
                  </View>
                  <View style={styles.vDivider} />
                  <View style={styles.vCell}>
                    <Text variant="caption" tone="muted" weight="700">
                      {(t('candidates.risk') || 'Risk').toUpperCase()}
                    </Text>
                    <View style={[styles.riskPill, { backgroundColor: tint.color, marginTop: 2 }]}>
                      <Text variant="caption" weight="900" style={{ color: '#000', letterSpacing: 0.5, fontSize: 11 }}>
                        {(c.risk || '—').toUpperCase()}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.vDivider} />
                  <View style={styles.vCell}>
                    <Text variant="caption" tone="muted" weight="700">
                      {(t('candidates.verdict') || 'Verdict').toUpperCase()}
                    </Text>
                    <Text variant="caption" weight="900" style={{ color: tint.color, marginTop: 2, lineHeight: 16 }} numberOfLines={2}>
                      {verdictText(c.recommended, c.risk)}
                    </Text>
                  </View>
                </View>

                {/* Provider note */}
                {c.providerComment ? (
                  <View style={styles.commentBox}>
                    <Ionicons name="chatbubble-ellipses-outline" size={14} color={colors.textSecondary} />
                    <Text variant="caption" weight="500" tone="muted" style={{ marginLeft: 6, flex: 1, lineHeight: 18 }}>
                      {c.providerComment}
                    </Text>
                  </View>
                ) : null}

                {/* Action: open original listing */}
                <TouchableOpacity
                  onPress={() => WebBrowser.openBrowserAsync(c.listingUrl)}
                  style={[styles.openBtn, { borderColor: colors.border }]}
                  activeOpacity={0.85}
                  testID={`cmp-card-${idx}-open`}
                >
                  <Ionicons name="open-outline" size={14} color={colors.text} />
                  <Text variant="caption" weight="700" style={{ marginLeft: 6 }}>
                    {t('candidates.open_listing') || 'Open original listing'}
                    {c.source ? ` · ${c.source}` : ''}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          })}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function makeStyles(colors: any, _isDark: boolean) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 16, paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    headerTitle: { flex: 1, textAlign: 'center' },
    loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    scroll: { padding: 16 },

    card: { borderRadius: 18, borderWidth: 1.5, padding: 14, marginBottom: 14 },
    cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    rankBadge: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    recRibbon: {
      flexDirection: 'row', alignItems: 'center',
      backgroundColor: '#22C55E', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
    },

    imageRow: { flexDirection: 'row', gap: 12 },
    image: { width: 110, height: 88, borderRadius: 12 },
    imagePlaceholder: { width: 110, height: 88, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 4 },

    verdictRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 8, marginTop: 12,
    },
    vCell: { flex: 1, alignItems: 'center' },
    vDivider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', backgroundColor: 'rgba(127,127,127,0.3)' },
    riskPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },

    commentBox: {
      flexDirection: 'row', alignItems: 'flex-start',
      marginTop: 10, padding: 10,
      borderRadius: 10, backgroundColor: 'rgba(127,127,127,0.08)',
    },
    openBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      paddingVertical: 10, borderRadius: 10, borderWidth: 1, marginTop: 10,
    },
  });
}

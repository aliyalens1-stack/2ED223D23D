/**
 * Customer Report Cognition — Step 2 / Pass B mobile parity.
 *
 * Path: /customer/inspection/[jobId]/report-cognition
 *
 * Doctrine — identical to web ReportCognitionPage.tsx:
 *   • Mobile is literally a RENDERER. NOT an interpreter, NOT an
 *     enhancer. Sections come VERBATIM from the backend mapper. NO
 *     fallback wording generation, NO section combining, NO severity
 *     branching, NO runtime reordering.
 *   • Forming state: single body line + manual refresh. The 4-section
 *     document is STRUCTURALLY ABSENT from the tree (not visually
 *     hidden) — `cognition-document` count == 0.
 *   • Pull-to-refresh only. No polling, no websocket, no auto-refetch.
 *   • Forbidden lexicon: AI / confidence / probability / score / rating /
 *     accuracy / expert / guaranteed / percent / risk score /
 *     safe-investment / recommended-purchase / vehicle-passed /
 *     safe-to-buy / expert-approved / green-light / red-flag /
 *     yellow-flag / digit-with-%.
 *
 * Endpoint: GET /api/customer/inspection/{jobId}/report-cognition
 */
import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { api } from '../../../../src/services/api';
import { tokens } from '../../../../src/theme/tokens';
import { useThemeContext } from '../../../../src/context/ThemeContext';
import { getCopy, fillDate } from '../../../../src/customer-grammar/narrative';

const C = tokens.colors;
const S = tokens.spacing;
const T = tokens.typography;

// Fixed section order — locked at wire by mapper. The surface only
// renders, never substitutes its own labels.
const SECTION_ORDER = [
  'structurally_matters',
  'remains_uncertain',
  'supports_interpretation',
  'may_require_review',
] as const;

type CognitionKey = (typeof SECTION_ORDER)[number];

type CognitionOk = {
  ok: true;
  sections: Record<CognitionKey, { title: string; body: string }>;
  lastInterpretedAt?: string | null;
};

type CognitionForming = {
  ok: false;
  reason: 'forming' | string;
  interpretation: string;
};

type CognitionResponse = CognitionOk | CognitionForming;

export default function CustomerReportCognitionScreen() {
  // Theme-aware styling — see makeStyles(isDark) below.
  const { isDark } = useThemeContext();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);
  const router = useRouter();
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const { i18n } = useTranslation();
  const copy = getCopy(i18n.language).ui;

  const [data, setData] = useState<CognitionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<CognitionResponse>(
        `/customer/inspection/${jobId}/report-cognition`,
      );
      setData(res.data);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) setError(copy['cognition.error.notAvailable']);
      else if (status === 401 || status === 403) setError(copy['cognition.error.auth']);
      else setError(copy['cognition.error.load']);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [jobId, copy]);

  useEffect(() => {
    load();
  }, [load]);

  const successData =
    data && (data as any).ok === true
      ? (data as CognitionOk)
      : null;

  const formingLine =
    data && (data as any).ok === false
      ? (data as CognitionForming).interpretation
      : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={C.brand} />
        }
        testID="report-cognition-page"
      >
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => router.back()}
            hitSlop={12}
            activeOpacity={0.7}
            style={styles.backBtn}
            testID="cognition-back-link"
          >
            <Ionicons name="chevron-back" size={22} color={(isDark ? C.textDark : C.textLight)} />
            <Text style={styles.backText}>{copy['common.back']}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.title} testID="cognition-title">
          {copy['cognition.title']}
        </Text>

        {!data && loading && (
          <Text style={styles.loadingLine} testID="cognition-loading">{copy['cognition.loading']}</Text>
        )}

        {!loading && error && (
          <View testID="cognition-error-state">
            <Text style={styles.honestLine} testID="cognition-error-state-line">{error}</Text>
            <TouchableOpacity
              onPress={load}
              activeOpacity={0.7}
              style={styles.refreshBtn}
              testID="cognition-forming-refresh-btn"
            >
              <Ionicons name="refresh" size={14} color={(isDark ? C.textDark : C.textLight)} />
              <Text style={styles.refreshBtnText}>{copy['cognition.refresh']}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Forming state — single line, single manual refresh. The
            cognition document is structurally ABSENT from the tree. */}
        {!loading && !error && formingLine && (
          <View testID="cognition-forming-state">
            <Text style={styles.honestLine} testID="cognition-forming-state-line">
              {formingLine}
            </Text>
            <TouchableOpacity
              onPress={load}
              activeOpacity={0.7}
              style={styles.refreshBtn}
              testID="cognition-forming-refresh-btn"
            >
              <Ionicons name="refresh" size={14} color={(isDark ? C.textDark : C.textLight)} />
              <Text style={styles.refreshBtnText}>{copy['cognition.refresh']}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Delivered cognition — 4 sections, verbatim from mapper. */}
        {!loading && !error && successData && (
          <View testID="cognition-document">
            {SECTION_ORDER.map((key, i) => {
              const section = successData.sections?.[key];
              if (!section) return null;
              const dashKey = key.replace(/_/g, '-');
              return (
                <View key={key}>
                  {i > 0 && <View style={styles.separator} />}
                  <View style={styles.section} testID={`cognition-${dashKey}`}>
                    <Text style={styles.eyebrow}>{section.title}</Text>
                    <Text
                      style={styles.sectionBody}
                      testID={`cognition-${dashKey}-body`}
                      selectable
                    >
                      {section.body}
                    </Text>
                  </View>
                </View>
              );
            })}

            {successData.lastInterpretedAt ? (
              <>
                <View style={styles.separator} />
                <View testID="cognition-meta">
                  <Text style={styles.metaLine} testID="cognition-last-interpreted-at">
                    {fillDate(
                      copy['cognition.lastInterpreted'],
                      formatAbsolute(successData.lastInterpretedAt),
                    )}
                  </Text>
                </View>
              </>
            ) : null}

            <TouchableOpacity
              onPress={load}
              activeOpacity={0.7}
              style={styles.refreshBtn}
              testID="cognition-refresh-btn"
            >
              <Ionicons name="refresh" size={14} color={(isDark ? C.textDark : C.textLight)} />
              <Text style={styles.refreshBtnText}>{copy['cognition.refresh']}</Text>
            </TouchableOpacity>

            {/* Navigation glue → chronological process history (timeline rail).
                Uses the customer's exact mental model: "how we got here".
                Same restraint as Refresh: ghost border, small text, no
                urgency. Customer chooses when to look at history. */}
            <TouchableOpacity
              testID="cognition-view-history-btn"
              onPress={() => router.push(`/customer/inspection/${jobId}/timeline` as any)}
              activeOpacity={0.7}
              style={styles.linkBtn}
            >
              <Ionicons name="time-outline" size={14} color={(isDark ? C.textDark : C.textLight)} />
              <Text style={styles.linkBtnText}>{copy['cognition.navToHistory']}</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function formatAbsolute(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function makeStyles(isDark: boolean) {
  // ── Theme-aware token swap (Day 5 audit, 2026-05-15).
  //   *Light → *Dark when isDark; semantic colours (brand/success/
  //   warning/error) are intentionally theme-invariant.
  const bg        = isDark ? C.bgDark        : C.bgLight;
  const card      = isDark ? C.cardDark      : C.cardLight;
  const text      = isDark ? C.textDark      : C.textLight;
  const subtext   = isDark ? C.subtextDark   : C.subtextLight;
  const border    = isDark ? C.borderDark    : C.borderLight;
  const brandSoft = isDark ? C.brandSoftDark : C.brandSoftLight;
  return StyleSheet.create({
  safe: { flex: 1, backgroundColor: bg },
  scroll: { padding: S.md + 4, paddingBottom: S.xxl + 16 },

  headerRow: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: S.xs,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 4,
    marginLeft: -4,
    gap: 2,
  },
  backText: { fontSize: 15, fontWeight: '500', color: text },

  title: {
    fontSize: T.h1 - 4,
    fontWeight: '800',
    letterSpacing: -0.3,
    color: text,
    marginTop: S.sm,
    marginBottom: S.lg,
  },

  loadingLine: { fontSize: T.body, color: subtext },
  honestLine: {
    fontSize: T.body,
    lineHeight: 22,
    color: text,
    marginBottom: S.md,
  },

  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: border,
    marginVertical: S.lg,
  },

  section: { gap: S.xs },
  eyebrow: {
    fontSize: T.micro - 1,
    fontWeight: '800',
    letterSpacing: 2,
    color: subtext,
    textTransform: 'uppercase',
    marginBottom: S.xs,
  },
  sectionBody: {
    fontSize: T.h3 - 1,
    lineHeight: 24,
    color: text,
  },

  metaLine: {
    fontSize: T.caption,
    color: subtext,
  },

  refreshBtn: {
    marginTop: S.md,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: S.sm + 2,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: border,
  },
  refreshBtnText: { fontSize: T.caption, fontWeight: '700', color: text },

  // Navigation glue → timeline rail. Same visual rhythm as refreshBtn:
  // ghost border, small text, no urgency colour.
  linkBtn: {
    marginTop: S.sm,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: S.sm + 2,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: border,
  },
  linkBtnText: { fontSize: T.caption, fontWeight: '700', color: text },
});
}
// ── Module-level fallback styles for sub-components (light-mode only).
// Main component uses the themed `useMemo(() => makeStyles(isDark), ...)`
// override which shadows this fallback. Theme parity for the
// module-level sub-components (Section / Field / etc.) is a follow-up
// task — see /app/memory/theme_audit_2026_05_15.md.
const styles = makeStyles(false);


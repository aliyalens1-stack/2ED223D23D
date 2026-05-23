/**
 * Customer Inspection TimelineRail — temporal narrative (V1).
 *
 * Path: /customer/inspection/[jobId]/timeline
 *
 * Premise (per UX firewall doctrine):
 *   • Same `/api/inspections/{jobId}/timeline` source the inspector and
 *     admin consume. Backend already strips suspicion + provenance for
 *     customer role.
 *   • This screen adds the CUSTOMER LENS — a third projection of the same
 *     event stream:
 *       inspector lens → workflow progress
 *       admin lens     → forensic continuity
 *       customer lens  → process history  ← this file
 *   • Inspector workflow language (override, hard/soft, OCR, gaps) is
 *     deliberately ABSENT here. So is admin forensic language (suspicion,
 *     hash, geo distance, correlation). Even though the wire carries (or
 *     could carry) all of them, the projection never reads them.
 *
 * Hard lexicon rules (parity with `continuity.tsx`):
 *   • Never: AI, score, confidence, system, algorithm, draft, queue,
 *     flagged, suspicion, override, OCR, hash, raw.
 *   • Never: counts of evidence ("3 photos taken"). One row per event.
 *   • Never: relative time ("5m ago"). Absolute timestamps only.
 *   • Allowlist over `eventType`. Anything else is silently dropped.
 *   • Copy table is the ONLY source of customer-visible text. Operational
 *     payload fields are read for allowlist gating only — never echoed.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { useAuth } from '../../../../src/context/AuthContext';
import { tokens } from '../../../../src/theme/tokens';
import { useThemeContext } from '../../../../src/context/ThemeContext';
import {
  getCopy,
  projectTimeline,
  fillDate,
} from '../../../../src/customer-grammar/narrative';

const C = tokens.colors;
const S = tokens.spacing;
const R = tokens.radius;
const T = tokens.typography;

type TimelineEvent = {
  id?: string;
  eventType: string;
  at: string;
  payload?: Record<string, any>;
};
type TimelineResponse = {
  jobId: string;
  totalEvents: number;
  events: TimelineEvent[];
};

// ----- Allowlist + customer copy table ---------------------------------
//
// Adding a new operational event type does NOT make it customer-visible.
// It only becomes visible when its eventType also exists in the
// customer-grammar copy tables (per locale).
//
// Each entry produces a *single* deterministic line. No counts, no IDs,
// no operational labels. The customer learns WHAT category of work
// happened, not the inner identifiers.
//
// Localization: copy tables for EN/DE/RU live in
// `src/customer-grammar/copy/*.json`. The lexicon firewall test
// (`scripts/check-customer-lexicon.mjs`) proves that no forbidden
// token leaks across any locale.
//
// Drop-list (explicit, for documentation — anything NOT in the copy
// tables is dropped anyway, but this makes intent surveyable):
//   evidence.gaps_overridden — operational. Customer reads outcome, not process.
//   ocr.*                    — operational. Internal capture-assist.
//   correlation.*            — admin forensics. Already 403 for customer.
//   item.flagged_ok          — non-event from the customer's perspective.

type CustomerEvent = { title: string; icon: keyof typeof Ionicons.glyphMap };

function formatAbsolute(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

export default function CustomerInspectionTimelineScreen() {
  // Theme-aware styling — see makeStyles(isDark) below.
  const { isDark } = useThemeContext();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);
  const router = useRouter();
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const { user, isLoading: authLoading, isAuthenticated } = useAuth();
  const { i18n } = useTranslation();
  const copy = getCopy(i18n.language).ui;

  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/profile');
  }, [router]);

  const fetchOnce = useCallback(async () => {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<TimelineResponse>(`/inspections/${jobId}/timeline`);
      setData(res.data);
      setLastReadAt(new Date().toISOString());
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) setError(copy['timeline.error.notAvailable']);
      else if (status === 401 || status === 403) setError(copy['timeline.error.auth']);
      else setError(copy['timeline.error.load']);
    } finally { setLoading(false); }
  }, [jobId, copy]);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    fetchOnce();
    // intentional: NO interval, NO focus-refresh, NO websocket — parity
    // with continuity.tsx. The customer pulls when they want to see.
  }, [authLoading, isAuthenticated, fetchOnce]);

  // Customer projection — drop anything we can't safely render.
  // Projection is the *shared* customer-grammar function; surfaces
  // (mobile, web, …) NEVER reimplement it locally. The parity test
  // (`tests/projection-parity.test.mjs`) asserts the allowlist + drop
  // set is invariant across locales and across surfaces.
  const rows = useMemo(() => {
    if (!data?.events) return [];
    const { rendered } = projectTimeline(data.events, i18n.language);
    return rendered.map((r) => ({
      id: r.id,
      at: r.at,
      copy: {
        title: r.title,
        icon: r.icon as keyof typeof Ionicons.glyphMap,
      },
    }));
  }, [data, i18n.language]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={fetchOnce} tintColor={C.brand} />
        }
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={handleBack}
            hitSlop={12}
            activeOpacity={0.7}
            style={styles.backBtn}
            testID="customer-tl-back"
          >
            <Ionicons name="chevron-back" size={22} color={(isDark ? C.textDark : C.textLight)} />
            <Text style={styles.backText}>{copy['common.back']}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.kicker}>{copy['timeline.kicker']}</Text>
        <Text style={styles.title}>{copy['timeline.title']}</Text>

        {/* Meta strip: last read + manual refresh */}
        <View style={styles.metaRow}>
          <Text style={styles.metaText} testID="customer-tl-meta">
            {lastReadAt
              ? fillDate(copy['common.lastRead'], formatAbsolute(lastReadAt))
              : loading
              ? copy['common.reading']
              : copy['common.dash']}
          </Text>
          <TouchableOpacity
            testID="customer-tl-refresh"
            onPress={fetchOnce}
            disabled={loading || !user}
            activeOpacity={0.7}
            style={[styles.refreshBtn, (loading || !user) && { opacity: 0.4 }]}
          >
            <Ionicons name="refresh" size={14} color={(isDark ? C.textDark : C.textLight)} />
            <Text style={styles.refreshBtnText}>{copy['common.refresh']}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.separator} />

        {/* Reverse navigation glue — close the customer cognition triangle.
            From timeline the customer can return to: the current snapshot
            (continuity) or the final interpretation (report cognition).
            Same restraint — ghost border, calm copy, no badges. */}
        <View style={styles.crossRow}>
          <TouchableOpacity
            testID="customer-tl-to-continuity"
            onPress={() => router.replace(`/customer/inspection/${jobId}/continuity` as any)}
            activeOpacity={0.7}
            style={styles.crossBtn}
          >
            <Ionicons name="pulse-outline" size={14} color={(isDark ? C.textDark : C.textLight)} />
            <Text style={styles.crossBtnText}>{copy['timeline.crossToContinuity']}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="customer-tl-to-report"
            onPress={() => router.replace(`/customer/inspection/${jobId}/report-cognition` as any)}
            activeOpacity={0.7}
            style={styles.crossBtn}
          >
            <Ionicons name="document-text-outline" size={14} color={(isDark ? C.textDark : C.textLight)} />
            <Text style={styles.crossBtnText}>{copy['timeline.crossToReport']}</Text>
          </TouchableOpacity>
        </View>

        {/* Error */}
        {error && (
          <View testID="customer-tl-error" style={styles.section}>
            <Text style={styles.honestLine}>{error}</Text>
          </View>
        )}

        {/* Empty — honest line, never a fake skeleton. */}
        {!error && !loading && rows.length === 0 && (
          <View testID="customer-tl-empty" style={styles.section}>
            <Text style={styles.honestLine}>
              {copy['timeline.empty']}
            </Text>
          </View>
        )}

        {/* Rail — chronological, axis dot + connecting line + customer copy.
            One row per event. Absolute timestamps only. */}
        {rows.length > 0 && (
          <View testID="customer-tl-rail">
            {rows.map((r, i) => (
              <View
                key={r.id}
                testID={`customer-tl-row-${i}`}
                style={styles.row}
              >
                <View style={styles.axis}>
                  <View style={styles.dot} />
                  {i < rows.length - 1 && <View style={styles.line} />}
                </View>
                <View style={styles.rowBody}>
                  <View style={styles.rowHead}>
                    <Ionicons name={r.copy.icon} size={14} color={(isDark ? C.textDark : C.textLight)} />
                    <Text style={styles.rowTitle} numberOfLines={2}>{r.copy.title}</Text>
                  </View>
                  <Text style={styles.rowTime}>{formatAbsolute(r.at)}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
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
  scroll: { paddingHorizontal: S.lg, paddingTop: S.md, paddingBottom: S.xl },

  headerRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: S.xs,
  },
  backBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 4, paddingHorizontal: 4, marginLeft: -4, gap: 2,
  },
  backText: { fontSize: 15, fontWeight: '500', color: text },

  kicker: {
    fontSize: T.micro - 1, fontWeight: '800', letterSpacing: 2.5,
    color: subtext, marginTop: S.xs, marginBottom: 2,
  },
  title: {
    fontSize: T.h1 - 2, fontWeight: '800', letterSpacing: -0.3, color: text,
  },

  metaRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: S.md, paddingVertical: 4, gap: S.sm,
  },
  metaText: {
    fontSize: T.micro, fontWeight: '600', letterSpacing: 0.4, color: subtext,
  },
  refreshBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: S.sm + 2, paddingVertical: 7,
    borderRadius: R.sm, borderWidth: 1, borderColor: border,
  },
  refreshBtnText: { fontSize: T.caption, fontWeight: '700', color: text },

  separator: { height: StyleSheet.hairlineWidth, backgroundColor: border, marginVertical: S.md },

  // Reverse navigation glue — two ghost buttons in a row, evenly split.
  // Lets the customer step laterally between the three surfaces.
  crossRow: {
    flexDirection: 'row',
    gap: S.sm,
    marginBottom: S.md,
  },
  crossBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: S.sm,
    borderRadius: R.sm,
    borderWidth: 1,
    borderColor: border,
  },
  crossBtnText: { fontSize: T.caption, fontWeight: '700', color: text },

  section: { gap: S.xs + 2 },
  honestLine: { fontSize: T.body, lineHeight: 22, color: text, fontWeight: '500' },

  row: { flexDirection: 'row', alignItems: 'stretch' },
  axis: { width: 22, alignItems: 'center', paddingTop: 6 },
  dot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: text, opacity: 0.85,
  },
  line: {
    width: StyleSheet.hairlineWidth, flex: 1,
    backgroundColor: border, marginTop: 4,
  },
  rowBody: { flex: 1, paddingVertical: 4, paddingBottom: S.md },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { fontSize: T.body, fontWeight: '700', color: text, flex: 1, lineHeight: 22 },
  rowTime: {
    fontSize: T.micro, fontWeight: '700', letterSpacing: 0.4,
    color: subtext, textTransform: 'uppercase', marginTop: 2,
  },
});
}
// ── Module-level fallback styles for sub-components (light-mode only).
// Main component uses the themed `useMemo(() => makeStyles(isDark), ...)`
// override which shadows this fallback. Theme parity for the
// module-level sub-components (Section / Field / etc.) is a follow-up
// task — see /app/memory/theme_audit_2026_05_15.md.
const styles = makeStyles(false);


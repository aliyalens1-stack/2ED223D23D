/**
 * Customer Inspection Continuity — restrained cognition surface (V1).
 *
 * Path: /customer/inspection/[jobId]/continuity
 *
 * Hard rules (enforced):
 *   • No charts, no progress bars, no timeline dots stream, no live map.
 *   • No auto-refresh / polling / websocket. Pull-to-refresh + button only.
 *   • Empty substrate → single honest line. No skeletons, no fake events.
 *   • Customer never sees: AI, confidence, score, system, algorithm,
 *     draft, queue, flag, phone semantics. Backend already scrubs these
 *     — this screen never shows operational text from raw events.
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
import { useAuth } from '../../../../src/context/AuthContext';
import { tokens } from '../../../../src/theme/tokens';
import { useThemeContext } from '../../../../src/context/ThemeContext';
import { getCopy, fillDate } from '../../../../src/customer-grammar/narrative';

type ContinuityEvent = {
  kind: 'inspection_continuity';
  title: string;
  text: string;
  timestamp: string;
};

type Maturity = 'forming' | 'accumulating' | 'established' | 'delivered';

type ContinuityResponse =
  | { ok: true; maturity: Maturity; interpretation: string; events: ContinuityEvent[] }
  | { ok: false; reason: string };

const C = tokens.colors;
const S = tokens.spacing;
const R = tokens.radius;
const T = tokens.typography;

// Maturity → copy key mapping. Resolved through the customer-grammar
// table at render time so the label localizes with the active language.
const MATURITY_KEY: Record<
  Maturity,
  'continuity.maturity.forming'
  | 'continuity.maturity.accumulating'
  | 'continuity.maturity.established'
  | 'continuity.maturity.delivered'
> = {
  forming: 'continuity.maturity.forming',
  accumulating: 'continuity.maturity.accumulating',
  established: 'continuity.maturity.established',
  delivered: 'continuity.maturity.delivered',
};

// Absolute, language-neutral time presentation. No relative phrases
// ("2 minutes ago") — those imply pacing the customer is not meant to
// track. Parity with web `formatRestrainedDate` and mobile
// `report-cognition.tsx`. Single source of time-vocabulary across the
// continuity surface.
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

export default function CustomerInspectionContinuityScreen() {
  // Theme-aware styling — see makeStyles(isDark) below.
  const { isDark } = useThemeContext();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);
  const router = useRouter();
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const { user, isLoading: authLoading, isAuthenticated } = useAuth();
  const { i18n } = useTranslation();
  const copy = getCopy(i18n.language).ui;

  const [data, setData] = useState<ContinuityResponse | null>(null);
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
      const res = await api.get<ContinuityResponse>(
        `/customer/inspection/${jobId}/continuity`,
      );
      setData(res.data);
      setLastReadAt(new Date().toISOString());
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) setError(copy['continuity.error.notAvailable']);
      else if (status === 401 || status === 403) setError(copy['continuity.error.auth']);
      else setError(copy['continuity.error.load']);
    } finally {
      setLoading(false);
    }
  }, [jobId, copy]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) return;
    fetchOnce();
    // intentional: NO interval, NO focus-refresh, NO websocket
  }, [authLoading, isAuthenticated, fetchOnce]);

  const successData =
    data && (data as any).ok === true
      ? (data as Extract<ContinuityResponse, { ok: true }>)
      : null;

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
            testID="continuity-back"
          >
            <Ionicons name="chevron-back" size={22} color={(isDark ? C.textDark : C.textLight)} />
            <Text style={styles.backText}>{copy['common.back']}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.kicker}>{copy['continuity.kicker']}</Text>
        <Text style={styles.title}>{copy['continuity.title']}</Text>

        {/* Meta strip: last read + manual refresh */}
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>
            {lastReadAt
              ? fillDate(copy['common.lastRead'], formatAbsolute(lastReadAt))
              : loading
              ? copy['common.reading']
              : copy['common.dash']}
          </Text>
          <TouchableOpacity
            testID="continuity-refresh"
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

        {/* Error band */}
        {error && (
          <View testID="continuity-error" style={styles.section}>
            <Text style={styles.honestLine}>{error}</Text>
          </View>
        )}

        {/* Honest empty: ok=false reason="insufficient_continuity" */}
        {data && (data as any).ok === false && (
          <View testID="continuity-insufficient" style={styles.section}>
            <Text style={styles.honestLine}>{copy['continuity.insufficient']}</Text>
          </View>
        )}

        {/* Successful continuity narrative */}
        {successData && (
          <View testID="continuity-body">
            {/* Section 1 — Current continuity state */}
            <Section title={copy['continuity.section.state']}>
              {/*
                Maturity is rendered as a textual label only. No timeline
                dot, no chroma intensity per stage — these are continuity
                STAGES, not pass/fail or approval tiers. Web invariant
                doctrine: "No timeline dots." Stage distinction lives in
                the label itself + sectional position.
              */}
              <Text style={styles.maturityLabel}>
                {copy[MATURITY_KEY[successData.maturity]]}
              </Text>
            </Section>

            <View style={styles.separator} />

            {/* Section 2 — Restrained interpretation */}
            <Section title={copy['continuity.section.interpretation']}>
              <Text style={styles.paragraph} selectable>
                {successData.interpretation}
              </Text>
            </Section>

            <View style={styles.separator} />

            {/* Section 3 — Continuity events (textual, no dots/lines) */}
            <Section title={copy['continuity.section.events']}>
              {successData.events.length === 0 ? (
                <Text style={styles.paragraph}>
                  {copy['continuity.events.empty']}
                </Text>
              ) : (
                successData.events.map((ev, i) => (
                  <View
                    key={`${ev.timestamp}-${i}`}
                    style={styles.eventRow}
                    testID={`continuity-event-${i}`}
                  >
                    <Text style={styles.eventTime}>{formatAbsolute(ev.timestamp)}</Text>
                    <Text style={styles.eventTitle}>{ev.title}</Text>
                    <Text style={styles.eventText} selectable>
                      {ev.text}
                    </Text>
                  </View>
                ))
              )}
            </Section>

            {/* Navigation glue → chronological process history (timeline rail).
                Calm affordance — no count badge, no "new", no urgency.
                The customer chooses when to look. */}
            <TouchableOpacity
              testID="continuity-view-history-btn"
              onPress={() => router.push(`/customer/inspection/${jobId}/timeline` as any)}
              activeOpacity={0.7}
              style={styles.linkBtn}
            >
              <Text style={styles.linkBtnText}>{copy['continuity.navToHistory']}</Text>
              <Ionicons name="chevron-forward" size={14} color={(isDark ? C.textDark : C.textLight)} />
            </TouchableOpacity>

            <View style={styles.separator} />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      <View style={styles.sectionBody}>{props.children}</View>
    </View>
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

  kicker: {
    fontSize: T.micro - 1,
    fontWeight: '800',
    letterSpacing: 2.5,
    color: subtext,
    marginTop: S.xs,
    marginBottom: 2,
  },
  title: {
    fontSize: T.h1 - 2,
    fontWeight: '800',
    letterSpacing: -0.3,
    color: text,
  },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: S.md,
    paddingVertical: 4,
    gap: S.sm,
  },
  metaText: {
    fontSize: T.micro,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: subtext,
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: S.sm + 2,
    paddingVertical: 7,
    borderRadius: R.sm,
    borderWidth: 1,
    borderColor: border,
  },
  refreshBtnText: { fontSize: T.caption, fontWeight: '700', color: text },

  separator: { height: StyleSheet.hairlineWidth, backgroundColor: border, marginVertical: S.md },

  section: { gap: S.xs + 2 },
  sectionTitle: {
    fontSize: T.micro - 1,
    fontWeight: '800',
    letterSpacing: 2,
    color: subtext,
    textTransform: 'uppercase',
  },
  sectionBody: { gap: 6 },

  maturityLabel: { fontSize: T.h3, fontWeight: '700', color: text, paddingTop: 4 },

  paragraph: { fontSize: T.body, lineHeight: 22, color: text },
  honestLine: { fontSize: T.body, lineHeight: 22, color: text, fontWeight: '500' },

  eventRow: { paddingVertical: S.xs + 2, gap: 2 },
  eventTime: {
    fontSize: T.micro,
    fontWeight: '700',
    letterSpacing: 0.4,
    color: subtext,
    textTransform: 'uppercase',
  },
  eventTitle: { fontSize: T.caption + 1, fontWeight: '700', color: text },
  eventText: { fontSize: T.caption, color: text, lineHeight: 18 },

  // Navigation glue — calm forward affordance to timeline rail.
  // Same restraint as `refreshBtn`: ghost border, small text, no shadow,
  // no urgency colour. The customer chooses when to look at history.
  linkBtn: {
    marginTop: S.md,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: S.sm + 2,
    paddingVertical: 7,
    borderRadius: R.sm,
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


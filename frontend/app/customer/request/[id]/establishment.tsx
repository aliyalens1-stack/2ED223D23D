/**
 * Customer Request Establishment — Pass C continuity bridge (mobile parity).
 *
 * Path: /customer/request/[id]/establishment
 *
 * Doctrine — identical to web RequestEstablishmentPage.tsx:
 *   • Renderer of restrained read model. NO local inference, NO
 *     optimistic orchestration, NO state machine duplication.
 *   • Eyebrow + body sections only. Pull-to-refresh only — no auto
 *     refresh, no websocket, no focus-refresh.
 *   • Uncertainty text is NOT mirrored back into the surface (form-
 *     thinking trap). Only an acknowledgement line.
 *   • Continuity-link is structurally absent until an inspector engages
 *     (no disabled state, no "coming soon").
 *   • Forbidden lexicon: AI / algorithm / confidence / score / urgent /
 *     submit / submitted / ticket / error / failed / risk / analysis /
 *     progress / success / thank you.
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
import { useLocalSearchParams, useRouter, Stack, Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../../src/services/api';
import { tokens } from '../../../../src/theme/tokens';
import { useThemeContext } from '../../../../src/context/ThemeContext';

const C = tokens.colors;
const S = tokens.spacing;
const R = tokens.radius;
const T = tokens.typography;

type RequestDoc = {
  id: string;
  type: 'inspection' | 'selection';
  brand: string;
  model: string;
  links: string[];
  cities: string[];
  uncertainty?: string | null;
  schedulingWindow?: 'soon' | 'this_week' | 'flexible' | null;
};

type Job = {
  id?: string;
  _id?: string;
  inspectorId?: string | null;
  status?: string;
};

const SCHEDULING_LABEL: Record<NonNullable<RequestDoc['schedulingWindow']>, string> = {
  soon: 'Soon — within the next couple of days.',
  this_week: 'This week — within the working week.',
  flexible: 'Flexible — no fixed window.',
};

export default function CustomerRequestEstablishmentScreen() {
  // Theme-aware styling — see makeStyles(isDark) below.
  const { isDark } = useThemeContext();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [req, setReq] = useState<RequestDoc | null>(null);
  const [firstJob, setFirstJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [r1, r2] = await Promise.all([
        api.get<RequestDoc>(`/customer/requests/${id}`),
        api.get<{ jobs: Job[] }>(`/customer/requests/${id}/jobs`),
      ]);
      setReq(r1.data);
      const engaged = (r2.data?.jobs || []).find((j) => j.inspectorId);
      setFirstJob(engaged || null);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) setError('Inspection context not found.');
      else setError('Inspection context not yet readable.');
      setReq(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const schedulingBody = req?.schedulingWindow ? SCHEDULING_LABEL[req.schedulingWindow] : null;
  const hasUncertainty = !!(req?.uncertainty && req.uncertainty.trim().length > 0);
  const engagedJobId = firstJob?.id || firstJob?._id;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={C.brand} />
        }
        testID="request-establishment-page"
      >
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => router.back()}
            hitSlop={12}
            activeOpacity={0.7}
            style={styles.backBtn}
            testID="establishment-back-link"
          >
            <Ionicons name="chevron-back" size={22} color={(isDark ? C.textDark : C.textLight)} />
            <Text style={styles.backText}>Back to requests</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.title} testID="establishment-title">
          Inspection context established
        </Text>

        {!req && loading && (
          <Text style={styles.loadingLine} testID="establishment-loading">Loading…</Text>
        )}

        {!loading && error && (
          <Text style={styles.honestLine} testID="establishment-error-state">{error}</Text>
        )}

        {req && !error && (
          <View testID="establishment-readout">
            <Section
              eyebrow="Current state"
              body="Context recorded. Inspector engagement is forming."
              testID="establishment-state"
            />
            <View style={styles.separator} />
            <Section
              eyebrow="Vehicle reference"
              body={describeVehicle(req)}
              testID="establishment-vehicle"
            />
            <View style={styles.separator} />
            <Section
              eyebrow="Location"
              body={req.cities[0] || '—'}
              testID="establishment-location"
            />
            {schedulingBody && (
              <>
                <View style={styles.separator} />
                <Section
                  eyebrow="Scheduling window"
                  body={schedulingBody}
                  testID="establishment-scheduling"
                />
              </>
            )}
            {hasUncertainty && (
              <>
                <View style={styles.separator} />
                <Section
                  eyebrow="Context recorded"
                  body="Your notes have been recorded and will reach the inspector."
                  testID="establishment-uncertainty-ack"
                />
              </>
            )}

            <View style={styles.separator} />

            <Text style={styles.incompletenessNote} testID="establishment-incompleteness-note">
              Information may still be added later. The inspection context will continue to form as an inspector engages.
            </Text>

            <View style={styles.separator} />

            {/* References — pure link plumbing. */}
            <View testID="establishment-references">
              <Text style={styles.eyebrow}>References</Text>

              <Link
                href={`/dashboard/requests/${req.id}` as any}
                asChild
              >
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={styles.refRow}
                  testID="establishment-request-detail-link"
                >
                  <Text style={styles.refLink}>View this request</Text>
                </TouchableOpacity>
              </Link>

              {engagedJobId && (
                <View testID="establishment-continuity-bridge">
                  <Link
                    href={`/customer/inspection/${engagedJobId}/continuity` as any}
                    asChild
                  >
                    <TouchableOpacity
                      activeOpacity={0.7}
                      style={styles.refRow}
                      testID="establishment-continuity-link"
                    >
                      <Text style={styles.refLink}>View inspection continuity</Text>
                    </TouchableOpacity>
                  </Link>
                </View>
              )}

              <Link href={'/dashboard/requests' as any} asChild>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={styles.refRow}
                  testID="establishment-requests-list-link"
                >
                  <Text style={styles.refLink}>All inspection contexts</Text>
                </TouchableOpacity>
              </Link>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function describeVehicle(req: RequestDoc): string {
  if (req.type === 'inspection' && req.links && req.links.length > 0) {
    return req.links[0];
  }
  const parts: string[] = [];
  if (req.brand) parts.push(req.brand);
  if (req.model && req.model !== '—') parts.push(req.model);
  return parts.length === 0 ? '—' : parts.join(' ');
}

function Section(props: { eyebrow: string; body: string; testID: string }) {
  return (
    <View style={styles.section} testID={props.testID}>
      <Text style={styles.eyebrow}>{props.eyebrow}</Text>
      <Text style={styles.sectionBody} testID={`${props.testID}-body`} selectable>
        {props.body}
      </Text>
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

  title: {
    fontSize: T.h1 - 4,
    fontWeight: '800',
    letterSpacing: -0.3,
    color: text,
    marginTop: S.sm,
    marginBottom: S.lg,
  },
  loadingLine: { fontSize: T.body, color: subtext },
  honestLine: { fontSize: T.body, lineHeight: 22, color: text },

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

  incompletenessNote: {
    fontSize: T.caption,
    color: subtext,
    lineHeight: 19,
  },

  refRow: { paddingVertical: 6 },
  refLink: {
    fontSize: T.body,
    color: subtext,
    textDecorationLine: 'underline',
    textDecorationColor: border,
  },
});
}
// ── Module-level fallback styles for sub-components (light-mode only).
// Main component uses the themed `useMemo(() => makeStyles(isDark), ...)`
// override which shadows this fallback. Theme parity for the
// module-level sub-components (Section / Field / etc.) is a follow-up
// task — see /app/memory/theme_audit_2026_05_15.md.
const styles = makeStyles(false);


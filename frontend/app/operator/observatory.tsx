/**
 * Operator Cognition Observatory — interpretive cognitive surface.
 *
 * Hard rules (enforced):
 *   • NO charts, NO heatmaps, NO gauges, NO PnL/colored deltas
 *   • NO websocket, NO polling, NO auto-refresh, NO animated counters
 *   • Manual refresh only: pull-to-refresh + explicit "Refresh interpretation" button
 *   • Admin-gated. Non-admin → quiet redirect home.
 *   • Empty substrate → single honest line. No skeletons. No fake placeholders.
 *
 * Path: /operator/observatory   (primary entry via Profile menu)
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { useAuth } from '../../src/context/AuthContext';
import { api } from '../../src/services/api';

type AlignmentSymbol = {
  symbol: string;
  coherence: string;
  interpretation: string;
};

type RegimeSymbol = {
  symbol: string;
  phase: string;
  persistence: string;
};

type ObservatoryResponse =
  | {
      ok: true;
      generatedAt: string;
      deploymentClimate: {
        dominantPosture: string;
        blockedBy: string;
        interpretation: string;
      };
      alignmentDrift: AlignmentSymbol[];
      cognitiveMemory: {
        continuity: string;
        accumulation: string;
        interpretation: string;
      };
      shadowStructures: {
        blocked: number;
        waiting: number;
        unresolved: number;
        interpretation: string;
      };
      regimeContinuity: RegimeSymbol[];
      continuity?: {
        snapshotId: string | null;
        takenAt: string | null;
        persisted: boolean;
        summary: string | null;
        events: StructuralEvent[];
      };
    }
  | { ok: false; reason: string };

type StructuralEvent = {
  kind: string;
  symbol?: string;
  event: string;
  note: string;
};

type SnapshotListEntry = {
  id: string;
  takenAt: string;
  summary: string;
  substrateHash: string;
};

function relativeMinutes(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffMs = Date.now() - t;
  const m = Math.max(0, Math.floor(diffMs / 60000));
  if (m === 0) return 'just now';
  if (m === 1) return '1m ago';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h === 1) return '1h ago';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1d ago' : `${d}d ago`;
}

export default function OperatorObservatoryScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { user } = useAuth();

  const [data, setData] = useState<ObservatoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastInterpretedAt, setLastInterpretedAt] = useState<string | null>(null);
  const [history, setHistory] = useState<SnapshotListEntry[]>([]);

  // Admin gate — non-admins are quietly returned to the profile hub.
  useEffect(() => {
    if (user && user.role !== 'admin') {
      router.replace('/(tabs)/profile');
    }
  }, [user, router]);

  const fetchOnce = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [resA, resB] = await Promise.all([
        api.get<ObservatoryResponse>('/operator/observatory'),
        api.get<{ ok: boolean; snapshots: SnapshotListEntry[] }>(
          '/operator/observatory/history'
        ),
      ]);
      setData(resA.data);
      if ((resA.data as any)?.ok && (resA.data as any)?.generatedAt) {
        setLastInterpretedAt((resA.data as any).generatedAt);
      }
      setHistory(Array.isArray(resB.data?.snapshots) ? resB.data.snapshots : []);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 401 || status === 403) {
        setError('Operator access required.');
      } else {
        setError('Interpretation could not be retrieved.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Single initial read on mount. NO interval, NO focus-refresh, NO socket.
  useEffect(() => {
    if (user && user.role === 'admin') {
      fetchOnce();
    }
  }, [user, fetchOnce]);

  const onPullToRefresh = useCallback(() => {
    fetchOnce();
  }, [fetchOnce]);

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <SafeAreaView style={styles.safeArea} edges={['top']}>
          <Header onBack={() => router.back()} colors={colors} />
          <View style={styles.bodyPad}>
            <Text testID="observatory-empty" style={[styles.honestLine, { color: colors.text }]}>
              Insufficient continuity for interpretive surface.
            </Text>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={loading}
              onRefresh={onPullToRefresh}
              tintColor={colors.primary}
            />
          }
        >
          <Header onBack={() => router.back()} colors={colors} />

          {/* Meta strip: last interpreted + manual refresh button */}
          <View style={styles.metaRow} testID="observatory-meta">
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>
              {data && (data as any).ok
                ? `Last interpreted ${relativeMinutes(lastInterpretedAt)}`
                : data && (data as any).ok === false
                  ? '—'
                  : loading
                    ? 'Interpreting…'
                    : '—'}
            </Text>
            <TouchableOpacity
              testID="observatory-refresh-btn"
              onPress={fetchOnce}
              disabled={loading}
              activeOpacity={0.7}
              style={[
                styles.refreshBtn,
                {
                  borderColor: colors.border,
                  opacity: loading ? 0.4 : 1,
                },
              ]}
            >
              <Ionicons name="refresh" size={14} color={colors.text} />
              <Text style={[styles.refreshBtnText, { color: colors.text }]}>
                Refresh Interpretation
              </Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.separator, { backgroundColor: colors.border }]} />

          {/* Error band — quiet, no toast, no flash */}
          {error && (
            <View testID="observatory-error" style={styles.section}>
              <Text style={[styles.honestLine, { color: colors.text }]}>{error}</Text>
            </View>
          )}

          {/* Honest empty: insufficient_decision_context */}
          {data && (data as any).ok === false && (
            <View testID="observatory-insufficient" style={styles.section}>
              <Text style={[styles.honestLine, { color: colors.text }]}>
                Insufficient continuity for interpretive surface.
              </Text>
            </View>
          )}

          {/* Successful interpretation — pure textual sections */}
          {data && (data as any).ok === true && (() => {
            const d = data as Extract<ObservatoryResponse, { ok: true }>;
            return (
              <View testID="observatory-body">
                <Section title="Deployment Climate" colors={colors}>
                  <Line
                    label="Dominant posture"
                    value={d.deploymentClimate.dominantPosture}
                    colors={colors}
                  />
                  <Line
                    label="Blocked by"
                    value={d.deploymentClimate.blockedBy}
                    colors={colors}
                  />
                  <Paragraph text={d.deploymentClimate.interpretation} colors={colors} />
                </Section>

                <View style={[styles.separator, { backgroundColor: colors.border }]} />

                <Section title="Alignment Drift" colors={colors}>
                  {d.alignmentDrift.length === 0 ? (
                    <Paragraph
                      text="No active alignment signal in the current window."
                      colors={colors}
                    />
                  ) : (
                    d.alignmentDrift.map((row, i) => (
                      <SymbolRow
                        key={`${row.symbol}-${i}`}
                        symbol={row.symbol}
                        primary={row.coherence}
                        secondary={row.interpretation}
                        colors={colors}
                      />
                    ))
                  )}
                </Section>

                <View style={[styles.separator, { backgroundColor: colors.border }]} />

                <Section title="Cognitive Memory" colors={colors}>
                  <Line label="Continuity" value={d.cognitiveMemory.continuity} colors={colors} />
                  <Line
                    label="Accumulation"
                    value={d.cognitiveMemory.accumulation}
                    colors={colors}
                  />
                  <Paragraph text={d.cognitiveMemory.interpretation} colors={colors} />
                </Section>

                <View style={[styles.separator, { backgroundColor: colors.border }]} />

                <Section title="Shadow Structures" colors={colors}>
                  <Line
                    label="Blocked"
                    value={String(d.shadowStructures.blocked)}
                    colors={colors}
                  />
                  <Line
                    label="Waiting"
                    value={String(d.shadowStructures.waiting)}
                    colors={colors}
                  />
                  <Line
                    label="Unresolved"
                    value={String(d.shadowStructures.unresolved)}
                    colors={colors}
                  />
                  <Paragraph text={d.shadowStructures.interpretation} colors={colors} />
                </Section>

                <View style={[styles.separator, { backgroundColor: colors.border }]} />

                <Section title="Regime Continuity" colors={colors}>
                  {d.regimeContinuity.length === 0 ? (
                    <Paragraph
                      text="No regime continuity recorded in this read."
                      colors={colors}
                    />
                  ) : (
                    d.regimeContinuity.map((row, i) => (
                      <SymbolRow
                        key={`${row.symbol}-${i}`}
                        symbol={row.symbol}
                        primary={row.phase}
                        secondary={row.persistence}
                        colors={colors}
                      />
                    ))
                  )}
                </Section>

                <View style={[styles.separator, { backgroundColor: colors.border }]} />

                {/* ── Continuity Memory: WHAT STRUCTURALLY CHANGED ── */}
                <Section title="What structurally changed" colors={colors}>
                  {d.continuity && d.continuity.events && d.continuity.events.length > 0 ? (
                    <>
                      {d.continuity.summary && (
                        <Paragraph text={d.continuity.summary} colors={colors} />
                      )}
                      {d.continuity.events.map((ev, i) => (
                        <EventRow
                          key={`${ev.kind}-${i}`}
                          kind={ev.kind}
                          event={ev.event}
                          note={ev.note}
                          symbol={ev.symbol}
                          colors={colors}
                        />
                      ))}
                    </>
                  ) : (
                    <Paragraph
                      text="No structural change since last interpretation."
                      colors={colors}
                    />
                  )}
                </Section>

                <View style={[styles.separator, { backgroundColor: colors.border }]} />

                {/* ── Earlier interpretations (textual list, no graphs) ── */}
                <Section title="Earlier interpretations" colors={colors}>
                  {history.length === 0 ? (
                    <Paragraph
                      text="No prior interpretations recorded."
                      colors={colors}
                    />
                  ) : (
                    history.slice(0, 20).map((s) => (
                      <TouchableOpacity
                        key={s.id}
                        testID={`history-row-${s.id}`}
                        onPress={() => router.push(`/operator/history/${s.id}`)}
                        activeOpacity={0.7}
                        style={styles.historyRow}
                      >
                        <Text
                          style={[styles.historyTime, { color: colors.textSecondary }]}
                        >
                          {relativeMinutes(s.takenAt)}
                        </Text>
                        <Text
                          style={[styles.historySummary, { color: colors.text }]}
                          numberOfLines={2}
                        >
                          {s.summary}
                        </Text>
                      </TouchableOpacity>
                    ))
                  )}
                </Section>

                <View style={[styles.separator, { backgroundColor: colors.border }]} />

                <Text style={[styles.footnote, { color: colors.textSecondary }]}>
                  Operator Observatory · interpretive surface · manual read only.
                </Text>
              </View>
            );
          })()}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

// ── Restrained typography building blocks ─────────────────────────────────
function Header(props: { onBack: () => void; colors: any }) {
  return (
    <View style={styles.headerRow}>
      <TouchableOpacity
        testID="observatory-back"
        onPress={props.onBack}
        hitSlop={10}
        activeOpacity={0.7}
        style={styles.backBtn}
      >
        <Ionicons name="chevron-back" size={22} color={props.colors.text} />
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <Text style={[styles.kicker, { color: props.colors.textSecondary }]}>OPERATOR</Text>
        <Text style={[styles.title, { color: props.colors.text }]}>Cognition Observatory</Text>
      </View>
    </View>
  );
}

function Section(props: { title: string; colors: any; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: props.colors.textSecondary }]}>
        {props.title}
      </Text>
      <View style={styles.sectionBody}>{props.children}</View>
    </View>
  );
}

function Line(props: { label: string; value: string; colors: any }) {
  return (
    <View style={styles.lineRow}>
      <Text style={[styles.lineLabel, { color: props.colors.textSecondary }]}>{props.label}</Text>
      <Text style={[styles.lineValue, { color: props.colors.text }]} selectable>
        {props.value}
      </Text>
    </View>
  );
}

function Paragraph(props: { text: string; colors: any }) {
  return (
    <Text style={[styles.paragraph, { color: props.colors.text }]} selectable>
      {props.text}
    </Text>
  );
}

function SymbolRow(props: {
  symbol: string;
  primary: string;
  secondary: string;
  colors: any;
}) {
  return (
    <View style={styles.symbolRow}>
      <Text style={[styles.symbolName, { color: props.colors.text }]}>{props.symbol}</Text>
      <Text style={[styles.symbolPrimary, { color: props.colors.textSecondary }]}>
        {props.primary}
      </Text>
      <Text style={[styles.symbolSecondary, { color: props.colors.textSecondary }]}>
        {props.secondary}
      </Text>
    </View>
  );
}

function EventRow(props: {
  kind: string;
  event: string;
  note: string;
  symbol?: string;
  colors: any;
}) {
  return (
    <View style={styles.eventRow} testID={`event-${props.kind}-${props.event}`}>
      <Text style={[styles.eventVerb, { color: props.colors.textSecondary }]}>
        {props.event}
      </Text>
      <Text style={[styles.eventNote, { color: props.colors.text }]} selectable>
        {props.note}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 60 },
  bodyPad: { padding: 20 },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    marginBottom: 14,
  },
  backBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  kicker: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 2,
    ...Platform.select({ web: { fontVariantLigatures: 'none' } }),
  },
  title: { fontSize: 22, fontWeight: '800', letterSpacing: -0.3 },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
    gap: 12,
  },
  metaText: { fontSize: 11, fontWeight: '600', letterSpacing: 0.4 },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
  },
  refreshBtnText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.2 },

  separator: { height: StyleSheet.hairlineWidth, marginVertical: 18 },

  section: { gap: 10 },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  sectionBody: { gap: 6 },

  lineRow: { flexDirection: 'row', gap: 10, paddingVertical: 2 },
  lineLabel: {
    width: 110,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  lineValue: { flex: 1, fontSize: 14, fontWeight: '500' },

  paragraph: { fontSize: 14, lineHeight: 20, marginTop: 4 },

  symbolRow: { paddingVertical: 6, gap: 2 },
  symbolName: { fontSize: 14, fontWeight: '700' },
  symbolPrimary: { fontSize: 12, fontWeight: '600', letterSpacing: 0.2 },
  symbolSecondary: { fontSize: 12, fontWeight: '500', letterSpacing: 0.1 },

  eventRow: { paddingVertical: 6, flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  eventVerb: {
    width: 96,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'lowercase',
    paddingTop: 2,
  },
  eventNote: { flex: 1, fontSize: 13, fontWeight: '500', lineHeight: 18 },

  historyRow: { paddingVertical: 10, gap: 2 },
  historyTime: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  historySummary: { fontSize: 13, fontWeight: '500', lineHeight: 18 },

  honestLine: { fontSize: 15, fontWeight: '500', lineHeight: 22 },
  footnote: {
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.3,
    textAlign: 'center',
    marginTop: 8,
  },
});

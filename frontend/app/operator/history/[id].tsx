/**
 * Operator Observatory · Snapshot detail page.
 *
 * Shows the topology diff between this snapshot and its immediate predecessor.
 * No charts. No timeline graph. Manual read only.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../../src/context/ThemeContext';
import { useAuth } from '../../../src/context/AuthContext';
import { api } from '../../../src/services/api';

type StructuralEvent = {
  kind: string;
  symbol?: string;
  event: string;
  note: string;
};

type DiffResponse = {
  ok: boolean;
  snapshotId: string;
  takenAt: string;
  predecessorId: string | null;
  predecessorTakenAt: string | null;
  summary: string;
  events: StructuralEvent[];
};

function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function ObservatorySnapshotDetail() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const { colors } = useThemeContext();
  const { user } = useAuth();

  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user && user.role !== 'admin') {
      router.replace('/(tabs)/profile');
    }
  }, [user, router]);

  const load = useCallback(async () => {
    if (!params.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<DiffResponse>(
        `/operator/observatory/history/${params.id}/diff`
      );
      setDiff(res.data);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) setError('Snapshot not found.');
      else if (status === 401 || status === 403) setError('Operator access required.');
      else setError('Diff could not be retrieved.');
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    if (user && user.role === 'admin') load();
  }, [user, load]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />
          }
        >
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={() => router.back()}
              hitSlop={10}
              activeOpacity={0.7}
              style={styles.backBtn}
              testID="snapshot-back"
            >
              <Ionicons name="chevron-back" size={22} color={colors.text} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={[styles.kicker, { color: colors.textSecondary }]}>
                OPERATOR · SNAPSHOT
              </Text>
              <Text style={[styles.title, { color: colors.text }]}>Structural Diff</Text>
            </View>
          </View>

          {error && (
            <Text style={[styles.honestLine, { color: colors.text, marginTop: 12 }]}>
              {error}
            </Text>
          )}

          {diff && (
            <>
              <View style={[styles.separator, { backgroundColor: colors.border }]} />

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                  Taken at
                </Text>
                <Text style={[styles.body, { color: colors.text }]} selectable>
                  {formatAbsolute(diff.takenAt)}
                </Text>
              </View>

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                  Compared against
                </Text>
                <Text style={[styles.body, { color: colors.text }]} selectable>
                  {diff.predecessorTakenAt
                    ? formatAbsolute(diff.predecessorTakenAt)
                    : 'no predecessor — this is the first interpretation in continuity'}
                </Text>
              </View>

              <View style={[styles.separator, { backgroundColor: colors.border }]} />

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                  Summary
                </Text>
                <Text style={[styles.paragraph, { color: colors.text }]} selectable>
                  {diff.summary}
                </Text>
              </View>

              <View style={[styles.separator, { backgroundColor: colors.border }]} />

              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                  Structural events
                </Text>
                {diff.events.length === 0 ? (
                  <Text style={[styles.paragraph, { color: colors.text }]}>
                    No structural change recorded against the predecessor.
                  </Text>
                ) : (
                  diff.events.map((ev, i) => (
                    <View key={`${ev.kind}-${i}`} style={styles.eventRow}>
                      <Text style={[styles.eventVerb, { color: colors.textSecondary }]}>
                        {ev.event}
                      </Text>
                      <Text
                        style={[styles.eventNote, { color: colors.text }]}
                        selectable
                      >
                        {ev.note}
                      </Text>
                    </View>
                  ))
                )}
              </View>

              <View style={[styles.separator, { backgroundColor: colors.border }]} />

              <Text style={[styles.footnote, { color: colors.textSecondary }]}>
                Topology diff only · no metrics drift surfaced.
              </Text>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 60 },

  headerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginBottom: 14 },
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
  },
  title: { fontSize: 22, fontWeight: '800', letterSpacing: -0.3 },

  separator: { height: StyleSheet.hairlineWidth, marginVertical: 18 },

  section: { marginBottom: 16, gap: 6 },
  sectionTitle: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  body: { fontSize: 14, fontWeight: '500' },
  paragraph: { fontSize: 14, lineHeight: 20 },
  honestLine: { fontSize: 15, fontWeight: '500', lineHeight: 22 },

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

  footnote: {
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.3,
    textAlign: 'center',
    marginTop: 8,
  },
});

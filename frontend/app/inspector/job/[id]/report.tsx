/**
 * Inspector workspace — Step 9A (Pass A: topology + vocabulary cleanup).
 *
 * Doctrine (frozen — these constraints define the calm aesthetic):
 *
 *   • 5 canonical sections in fixed order, derived from the
 *     `EvidenceSegment` enum that drives the runtime continuity ledger
 *     and customer cognition mapping:
 *
 *         exterior  →  cabin  →  mechanical  →  roadtest  →  documentation
 *
 *     Backend's 15 operational groups are collapsed client-side via
 *     `GROUP_TO_SEGMENT`. The inspector now sees a single inspection
 *     ontology that matches what the customer sees and what the ledger
 *     records — same vocabulary, all surfaces.
 *
 *   • No completion psychology. Removed entirely:
 *         – "% complete", "X/Y", "/10", "/min N"
 *         – progress bars, fill-up affordances, score ladders
 *         – "Need at least N more …" alerts
 *         – green/red completion states on item statuses
 *         – orange section-label brackets `[ … ]`
 *         – "Submitting consumes 1 credit. Make sure all key checks
 *           are filled." anxiety disclaimer
 *         – "Submit report" → "Submit"
 *
 *   • Vocabulary shift from form-thinking to continuity:
 *         – "Fill report" → "Inspection workspace"
 *         – "CHECKLIST" → "Findings"
 *         – "VERDICT" → "Assessment"
 *         – "ISSUES (one per line)" → "Issues observed"
 *         – "SUMMARY · ≥ 10 chars" → "Closing note"
 *         – status options OK/!/X → "Pass / Watch / Concern"
 *
 *   • Visual restraint. Removed aggressive orange section accents.
 *     Borders softened to background separation. Submit affordance
 *     keeps a single accent — the only place attention is earned.
 *
 * Operational substrate is UNCHANGED:
 *   • Submit gate logic (canSubmit) identical — validation stays
 *     internal; the UI no longer advertises its constraints.
 *   • Photo system unchanged (Step 9B will calmify upload ergonomics).
 *   • Backend contracts unchanged (/api/inspector/checklist, submit,
 *     photo upload — same endpoints, same payloads).
 *   • Credit consumption, report schema, PDF generation, ledger
 *     wiring, customer cognition — all untouched.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert, TextInput, KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';

const API = (Constants.expoConfig as any)?.extra?.apiUrl
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || 'http://localhost:8001';

type ItemStatus = 'ok' | 'warning' | 'problem' | 'not_checked';
type Verdict = 'recommended' | 'risky' | 'not_recommended';

interface ChecklistItem { key: string; group: string; }

// ── Canonical inspection ontology ──────────────────────────────────
// Mirrors `EvidenceSegment` enum in the backend runtime ledger. The
// 15 operational backend groups collapse into these 5 segments. Order
// here defines the order on screen — fixed, never sorted alphabetically.
type Segment = 'exterior' | 'cabin' | 'mechanical' | 'roadtest' | 'documentation';

const SEGMENT_ORDER: Segment[] = ['exterior', 'cabin', 'mechanical', 'roadtest', 'documentation'];

const SEGMENT_LABEL: Record<Segment, string> = {
  exterior:      'Exterior',
  cabin:         'Cabin',
  mechanical:    'Mechanical',
  roadtest:      'Road test',
  documentation: 'Documentation',
};

const GROUP_TO_SEGMENT: Record<string, Segment> = {
  // Exterior
  body:          'exterior',
  paint:         'exterior',
  glass_lights:  'exterior',
  wheels:        'exterior',
  // Cabin
  interior:      'cabin',
  comfort:       'cabin',
  electronics:   'cabin',
  safety:        'cabin',
  // Mechanical
  engine:        'mechanical',
  fluids:        'mechanical',
  drivetrain:    'mechanical',
  brakes:        'mechanical',
  chassis:       'mechanical',
  // Roadtest
  drive:         'roadtest',
  // Documentation
  documents:     'documentation',
};

// Status options — neutral language, no green/red completion theatre.
// The semantic value sent to the backend is unchanged (ok|warning|problem),
// but the UI surface uses restrained labels.
const STATUS_OPTIONS: { value: ItemStatus; label: string }[] = [
  { value: 'ok',      label: 'Pass' },
  { value: 'warning', label: 'Watch' },
  { value: 'problem', label: 'Concern' },
];

const VERDICT_OPTIONS: { value: Verdict; label: string }[] = [
  { value: 'recommended',     label: 'Recommend' },
  { value: 'risky',           label: 'Consider with caution' },
  { value: 'not_recommended', label: 'Advise against' },
];

const SCORE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const PHOTO_MIN = 5;  // Internal gate — not advertised in the UI.

interface LocalPhoto { uri: string; base64: string; mimeType: string; segment: Segment; }

// Soft per-segment cap. Not advertised in the UI — when reached, the
// add affordance for that segment silently hides. No "limit reached"
// alert, no counter. The total budget is implicit and generous.
const MAX_PHOTOS_PER_SEGMENT = 6;

const EMPTY_PHOTOS_BY_SEGMENT: Record<Segment, LocalPhoto[]> = {
  exterior: [], cabin: [], mechanical: [], roadtest: [], documentation: [],
};

export default function InspectorReportForm() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const [token, setToken] = useState<string | null>(null);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ItemStatus>>({});
  const [comments] = useState<Record<string, string>>({});
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [score, setScore] = useState<number>(7);
  const [summary, setSummary] = useState<string>('');
  const [issuesText, setIssuesText] = useState<string>('');
  const [repairMin, setRepairMin] = useState<string>('');
  const [repairMax, setRepairMax] = useState<string>('');
  const [photosBySegment, setPhotosBySegment] = useState<Record<Segment, LocalPhoto[]>>(EMPTY_PHOTOS_BY_SEGMENT);
  const [uploadingProgress, setUploadingProgress] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);

  const init = useCallback(async () => {
    try {
      const t = await AsyncStorage.getItem('auth_token');
      setToken(t);
      const res = await fetch(`${API}/api/inspector/checklist`, {
        headers: t ? { Authorization: `Bearer ${t}` } : undefined,
      });
      const data = await res.json();
      setItems(data.items || []);
      const initial: Record<string, ItemStatus> = {};
      (data.items || []).forEach((it: ChecklistItem) => { initial[it.key] = 'not_checked'; });
      setStatuses(initial);
    } catch (e: any) {
      Alert.alert('Could not load', e?.message || 'workspace unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { init(); }, [init]);

  // Group items by canonical segment. Items whose backend group is not
  // in GROUP_TO_SEGMENT fall back to `mechanical` (the largest bucket;
  // a safer default than dropping the item silently). In practice the
  // map covers every group the backend currently emits — this fallback
  // exists only to keep the UI deterministic if backend adds a new
  // group ahead of a frontend update.
  const itemsBySegment = useMemo(() => {
    const m: Record<Segment, ChecklistItem[]> = {
      exterior: [], cabin: [], mechanical: [], roadtest: [], documentation: [],
    };
    for (const it of items) {
      const seg = GROUP_TO_SEGMENT[it.group] ?? 'mechanical';
      m[seg].push(it);
    }
    return m;
  }, [items]);

  // Submit gate — IDENTICAL semantics to the previous workspace.
  // The numbers stay internal; the UI no longer advertises them.
  const checkedCount = useMemo(
    () => Object.values(statuses).filter((s) => s !== 'not_checked').length,
    [statuses],
  );
  const totalPhotos = useMemo(
    () => SEGMENT_ORDER.reduce((n, s) => n + photosBySegment[s].length, 0),
    [photosBySegment],
  );
  const canSubmit =
    !submitting &&
    verdict !== null &&
    summary.trim().length >= 10 &&
    checkedCount >= 5 &&
    totalPhotos >= PHOTO_MIN;

  // Pass 9B — photo intake is segmented at the workspace layer.
  // Each canonical segment owns its own quiet add affordance; the
  // backend upload payload remains unchanged (segment metadata is
  // workspace ergonomics, not on-wire schema — backend `_upload`
  // schema is `{type, mimeType, dataBase64}` only). The grouping
  // exists to let the inspector think in continuity segments rather
  // than a flat dumping ground.
  const pickPhotosForSegment = async (segment: Segment) => {
    const existing = photosBySegment[segment].length;
    const remaining = MAX_PHOTOS_PER_SEGMENT - existing;
    // Silently no-op if the segment is full — no "limit reached" alert.
    if (remaining <= 0) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Photo access is required to attach evidence.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      base64: true,
      quality: 0.7,
      selectionLimit: remaining,
    });
    if (result.canceled || !result.assets) return;
    const accepted: LocalPhoto[] = [];
    for (const a of result.assets) {
      if (!a.base64) continue;
      const mime = (a.mimeType || (a.uri.endsWith('.png') ? 'image/png' : 'image/jpeg')).toLowerCase();
      accepted.push({ uri: a.uri, base64: a.base64, mimeType: mime, segment });
    }
    setPhotosBySegment((prev) => ({
      ...prev,
      [segment]: [...prev[segment], ...accepted].slice(0, MAX_PHOTOS_PER_SEGMENT),
    }));
  };

  const removePhotoFromSegment = (segment: Segment, idx: number) => {
    setPhotosBySegment((prev) => ({
      ...prev,
      [segment]: prev[segment].filter((_, i) => i !== idx),
    }));
  };

  const submit = async () => {
    if (!canSubmit || !token || !id) return;
    setSubmitting(true);
    try {
      const checklist = items
        .filter((it) => statuses[it.key] !== 'not_checked')
        .map((it) => ({
          key: it.key,
          status: statuses[it.key],
          comment: (comments[it.key] || '').trim() || null,
        }));
      const issues = issuesText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((title) => ({ severity: 'medium' as const, title, description: null }));

      const body: any = {
        score,
        verdict,
        checklist,
        issues,
        summary: summary.trim(),
      };
      const minNum = parseInt(repairMin, 10);
      const maxNum = parseInt(repairMax, 10);
      if (!isNaN(minNum)) body.repairEstimateMin = minNum;
      if (!isNaN(maxNum)) body.repairEstimateMax = maxNum;

      const res = await fetch(`${API}/api/inspector/jobs/${id}/report`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      const reportId = data?.report?.id;
      if (!reportId) throw new Error('Report submitted but server did not return id');

      // Flatten segmented photos in canonical order for the upload loop.
      // The backend upload endpoint accepts {type, mimeType, dataBase64}
      // only — segment is workspace-side metadata, not on-wire. Photos
      // are sent in canonical-segment order so the report's media list
      // reads in the same continuity sequence the inspector worked in.
      const allPhotos: LocalPhoto[] = SEGMENT_ORDER.flatMap((s) => photosBySegment[s]);
      let uploaded = 0;
      for (const p of allPhotos) {
        setUploadingProgress(`Sending photo ${uploaded + 1}…`);
        const upRes = await fetch(`${API}/api/inspector/reports/${reportId}/upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'photo', mimeType: p.mimeType, dataBase64: p.base64 }),
        });
        if (upRes.ok) uploaded++;
      }
      setUploadingProgress(null);

      // Restrained confirmation — no celebration copy, no completion theatre.
      Alert.alert('Submitted', 'The customer has been notified.', [
        { text: 'Done', onPress: () => router.replace('/inspector/jobs') },
      ]);
    } catch (e: any) {
      setUploadingProgress(null);
      Alert.alert('Submit failed', e?.message || 'unknown');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={{ marginTop: 100 }} color="#5A5A5A" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} testID="inspector-report-form">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} testID="report-back">
            <Ionicons name="chevron-back" size={24} color="#FFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Workspace</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Inspection workspace</Text>

          {/* Score — restrained selector, no fill-up affordance */}
          <Text style={styles.sectionLabel}>Score</Text>
          <View style={styles.scoreRow}>
            {SCORE_STEPS.map((s) => (
              <TouchableOpacity
                key={s}
                onPress={() => setScore(s)}
                style={[styles.scoreCell, score === s && styles.scoreCellActive]}
                testID={`score-${s}`}
              >
                <Text style={[styles.scoreCellText, score === s && styles.scoreCellTextActive]}>{s}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Assessment (was: VERDICT). Neutral tone, no traffic-light coloring. */}
          <Text style={styles.sectionLabel}>Assessment</Text>
          <View style={styles.verdictColumn}>
            {VERDICT_OPTIONS.map((v) => (
              <TouchableOpacity
                key={v.value}
                onPress={() => setVerdict(v.value)}
                style={[styles.verdictBtn, verdict === v.value && styles.verdictBtnActive]}
                testID={`verdict-${v.value}`}
              >
                <Text style={[styles.verdictText, verdict === v.value && styles.verdictTextActive]}>{v.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Findings — 5 canonical sections in canonical order.
              Each section carries its own quiet photo strip — evidence
              widening happens within the segment the inspector is
              currently thinking about, not in a separate "Photos"
              dump-zone at the bottom of the form. */}
          <Text style={styles.sectionLabel}>Findings</Text>
          {SEGMENT_ORDER.map((seg) => {
            const list = itemsBySegment[seg];
            const segPhotos = photosBySegment[seg];
            const canAddMore = segPhotos.length < MAX_PHOTOS_PER_SEGMENT;
            return (
              <View key={seg} style={styles.segmentBlock} testID={`segment-${seg}`}>
                <Text style={styles.segmentTitle}>{SEGMENT_LABEL[seg]}</Text>

                {/* Structural absence: when the segment has no checklist
                    items, render NOTHING under the title. The title is
                    the topology anchor — it does not need decoration.
                    No "—", no placeholder, no "nothing here yet". The
                    inline photo strip below still lets the inspector
                    accumulate evidence even in checklist-less segments. */}
                {list.map((it) => (
                    <View key={it.key} style={styles.checkRow}>
                      <Text style={styles.checkKey}>
                        {t(`inspector_checklist.items.${it.key}`, { defaultValue: it.key.replace(/_/g, ' ') })}
                      </Text>
                      <View style={styles.statusGroup}>
                        {STATUS_OPTIONS.map((opt) => {
                          const active = statuses[it.key] === opt.value;
                          return (
                            <TouchableOpacity
                              key={opt.value}
                              onPress={() => setStatuses({ ...statuses, [it.key]: active ? 'not_checked' : opt.value })}
                              style={[styles.statusChip, active && styles.statusChipActive]}
                              testID={`check-${it.key}-${opt.value}`}
                            >
                              <Text style={[styles.statusChipText, active && styles.statusChipTextActive]}>{opt.label}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                ))}

                {/* Quiet inline photo strip — appears regardless of
                    whether the segment has checklist items. Each
                    canonical segment can carry evidence even if the
                    backend hasn't shipped checklist items for it yet.
                    No counter, no progress ring, no "minimum reached". */}
                {(segPhotos.length > 0 || canAddMore) && (
                  <View style={styles.segmentPhotos} testID={`segment-${seg}-photos`}>
                    {segPhotos.map((p, idx) => (
                      <View key={`${seg}-${idx}`} style={styles.photoCell}>
                        <Image source={{ uri: p.uri }} style={styles.photoImg} />
                        <TouchableOpacity
                          onPress={() => removePhotoFromSegment(seg, idx)}
                          style={styles.photoRemove}
                          testID={`photo-remove-${seg}-${idx}`}
                        >
                          <Ionicons name="close" size={14} color="#000" />
                        </TouchableOpacity>
                      </View>
                    ))}
                    {canAddMore && (
                      <TouchableOpacity
                        style={styles.photoAddBtn}
                        onPress={() => pickPhotosForSegment(seg)}
                        testID={`photo-add-${seg}`}
                      >
                        <Ionicons name="add" size={22} color="#5A5A5A" />
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            );
          })}

          {/* Issues — drop the "one per line" compliance phrasing */}
          <Text style={styles.sectionLabel}>Issues observed</Text>
          <TextInput
            style={[styles.input, { minHeight: 80 }]}
            multiline
            placeholder="Paint mismatch on rear left door"
            placeholderTextColor="#5A5A5A"
            value={issuesText}
            onChangeText={setIssuesText}
            testID="issues-input"
          />

          {/* Repair estimate — drop the "optional" / "€" enterprise label */}
          <Text style={styles.sectionLabel}>Repair estimate</Text>
          <View style={styles.repairRow}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              keyboardType="number-pad"
              placeholder="from"
              placeholderTextColor="#5A5A5A"
              value={repairMin}
              onChangeText={setRepairMin}
              testID="repair-min"
            />
            <Text style={styles.dash}>—</Text>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              keyboardType="number-pad"
              placeholder="to"
              placeholderTextColor="#5A5A5A"
              value={repairMax}
              onChangeText={setRepairMax}
              testID="repair-max"
            />
          </View>

          {/* Closing note — drop the "≥ 10 chars" anxiety annotation */}
          <Text style={styles.sectionLabel}>Closing note</Text>
          <TextInput
            style={[styles.input, { minHeight: 100 }]}
            multiline
            placeholder="Overall condition. Final advice for the buyer."
            placeholderTextColor="#5A5A5A"
            value={summary}
            onChangeText={setSummary}
            testID="summary-input"
          />

          {/* Submit — the ONLY pure-white fill in the workspace.
              Disabled state drops to resting grey (#1F1F1F) with
              dimmed text (#5A5A5A). No opacity trick, no 25% fade
              telemetry — the button becomes part of the canvas rhythm
              when not ready, and re-emerges as the single visual
              focal point once submission is possible. */}
          <TouchableOpacity
            style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
            onPress={submit}
            disabled={!canSubmit}
            testID="report-submit"
          >
            {submitting ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <ActivityIndicator color="#000" />
                <Text style={styles.submitText}>{uploadingProgress || 'Submitting'}</Text>
              </View>
            ) : (
              <Text style={[styles.submitText, !canSubmit && styles.submitTextDisabled]}>Submit</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // ── Doctrine of restraint (Step 9C freeze) ────────────────────────
  //
  // Color discipline:
  //   • Background: #000 (canvas), #141414 (resting surface), #1F1F1F
  //     (active rest), #3A3A3A (selected — calm contrast, not accent)
  //   • Text:       #FFF (primary), #E5E5E5 (body), #A1A1AA (label),
  //                 #5A5A5A (placeholder, soft icon), #3A3A3A (decor)
  //   • The ONLY pure-white fill in the whole workspace is the submit
  //     button. Score-active, status-chip-active, verdict-active all
  //     resolve to greyscale step-ups, not the accent. The eye is
  //     drawn to one place — submission — and nowhere else.
  //
  // Vertical rhythm (8pt grid):
  //   • Top-level section gaps:  40
  //   • Segment-to-segment gap:  24
  //   • Title to first row:      16
  //   • Row to row:              12
  //   • Strip to strip (inline): 16
  //
  // Touch targets:
  //   • Score cell:        44 (was 32)
  //   • Status chip:       38 + 12 inner padding → 44 effective
  //   • Verdict button:    50
  //   • All thumb-reachable on phones, comfortable on tablets.
  //
  // Tablet/foldable parity:
  //   • Inner content capped at maxWidth: 680, centered on wider
  //     viewports. Phones get edge-to-edge with 20px gutter.

  safe: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#A1A1AA',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  body: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 96,
    maxWidth: 680,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#FFF',
    letterSpacing: 0.2,
    marginBottom: 4,
  },

  // Section label — subdued, no brackets, no accent color, no caps.
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#A1A1AA',
    marginTop: 40,
    marginBottom: 14,
    letterSpacing: 0.4,
  },

  // Score — flat row, only the selected step highlighted with a calm
  // grey, NOT the submit accent. No fill-up gradient, no progressive
  // shading.
  scoreRow: { flexDirection: 'row', gap: 4 },
  scoreCell: {
    flex: 1,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#141414',
  },
  scoreCellActive: { backgroundColor: '#3A3A3A' },
  scoreCellText: { fontSize: 13, fontWeight: '500', color: '#5A5A5A' },
  scoreCellTextActive: { color: '#FFF', fontWeight: '700' },

  // Verdict — stacked column, restrained tone. Active uses a calm
  // grey background and a soft 1px accent strip, NOT the submit white.
  verdictColumn: { gap: 8 },
  verdictBtn: {
    minHeight: 50,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#141414',
    justifyContent: 'center',
  },
  verdictBtnActive: {
    backgroundColor: '#1F1F1F',
    borderLeftWidth: 2,
    borderLeftColor: '#A1A1AA',
  },
  verdictText: { fontSize: 14, color: '#A1A1AA' },
  verdictTextActive: { color: '#FFF', fontWeight: '600' },

  // Segment block — true topology anchor. Title carries the segment.
  // No card, no border, no background fill. The spacing between
  // segments IS the structure. Empty segments render just the title;
  // the inline photo strip below remains accessible for evidence.
  segmentBlock: {
    marginBottom: 24,
  },
  segmentTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFF',
    marginBottom: 16,
  },

  // Check rows — generous vertical padding for thumb-reach; no
  // separators between items — the spacing carries the structure.
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    gap: 12,
  },
  checkKey: {
    fontSize: 13,
    color: '#E5E5E5',
    flex: 1,
    textTransform: 'capitalize',
  },

  // Status chips — neutral language, calm grey active state. Touch
  // target enlarged to comfortable thumb size without growing visual
  // weight.
  statusGroup: { flexDirection: 'row', gap: 4 },
  statusChip: {
    minHeight: 38,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#141414',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusChipActive: { backgroundColor: '#3A3A3A' },
  statusChipText: { fontSize: 12, fontWeight: '600', color: '#A1A1AA' },
  statusChipTextActive: { color: '#FFF' },

  input: {
    backgroundColor: '#141414',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 14,
    color: '#FFF',
    fontSize: 14,
    textAlignVertical: 'top',
  },
  repairRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dash: { color: '#5A5A5A', fontSize: 16 },

  // Submit — the ONLY pure-white fill on screen. Disabled state does
  // NOT use opacity (telemetry trick). Instead, when not ready, the
  // button quietly drops to a resting grey — same shape, same
  // position, no anxiety gradient. Tap behaviour is blocked by the
  // `disabled` prop; visually the button becomes part of the canvas
  // rhythm rather than a half-faded ghost.
  submitBtn: {
    marginTop: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    paddingVertical: 16,
    borderRadius: 10,
    minHeight: 50,
  },
  submitBtnDisabled: {
    backgroundColor: '#1F1F1F',
  },
  submitText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#000',
    letterSpacing: 0.3,
  },
  submitTextDisabled: {
    color: '#5A5A5A',
  },

  // Inline photo strip — sits directly under the segment's findings.
  // Small cells, calmer add affordance, no border, no dashed alert.
  segmentPhotos: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 16,
  },
  photoCell: { width: 64, height: 64, borderRadius: 8, overflow: 'hidden', position: 'relative' },
  photoImg: { width: '100%', height: '100%' },
  photoRemove: {
    position: 'absolute', top: 3, right: 3,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center',
  },
  photoAddBtn: {
    width: 64, height: 64, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#141414',
  },
});

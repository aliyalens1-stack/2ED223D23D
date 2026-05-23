/**
 * Inspector Runtime v2 — R1 entry.
 *
 * Replaces the legacy giant-form `report.tsx` for the body_paint proof-
 * of-concept slice. Renders:
 *   [F] Runtime Entry (sections overview, only body_paint enabled)
 *   [G] Section Runtime (item-by-item walkthrough — THE core screen)
 *
 * What's wired in R1:
 *   - Reducer-driven state with debounced AsyncStorage flush (~1s)
 *   - Resume on cold start via HYDRATE action
 *   - Item-bound photos via expo-image-picker (R3 will swap to inline camera)
 *   - Auto-severity from paint depth (300+ → warning, 500+ → critical)
 *   - Soft completion (warning, not block) on missing photos
 *   - Submit goes through existing POST /api/inspector/jobs/:id/report
 *
 * Out of R1 (per Surface Map):
 *   - Inline camera (R3)
 *   - Sync queue with background retry (R7)
 *   - Other 14 sections (R4)
 *   - Draft preview screen (R5)
 *   - GPS arrival workspace (R6)
 *
 * Design discipline (per directive):
 *   dense / fast / legible / thumb-operable / sunlight-safe
 *   No glassmorphism. No animations beyond instant feedback.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../../../src/i18n';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator,
  TextInput, Alert, KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';

import { BODY_PAINT_SECTION, ItemSeverity, BodyPaintItem } from '../../../../src/inspector/runtime/bodyPaintTemplate';
import {
  runtimeReducer, initialState, RuntimeState,
  checkedCount, progressPct, sectionConfidence, itemsMissingPhoto,
} from '../../../../src/inspector/runtime/reducer';
import { SyncStatusBar, useQueueController } from '../../../../src/inspector/runtime/SyncStatusBar';
import { enqueue } from '../../../../src/inspector/runtime/queue';

const API = (Constants.expoConfig as any)?.extra?.apiUrl
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || 'http://localhost:8001';

const STORAGE_KEY = (jobId: string) => `runtime_v2_${jobId}`;
const FLUSH_DEBOUNCE_MS = 1000;

const SEVERITY_COLOR: Record<ItemSeverity, string> = {
  ok:          '#22C55E',
  warning:     '#FFB020',
  critical:    '#EF4444',
  not_checked: '#5A5A5A',
};
const SEVERITY_LABEL: Record<ItemSeverity, string> = {
  ok:          'OK',
  warning:     'WARN',
  critical:    'CRIT',
  not_checked: '—',
};

// ─────────────────────────────────────────────────────────────────────
// Root component
// ─────────────────────────────────────────────────────────────────────

export default function InspectorRuntimeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = id || '';

  const [state, dispatch] = useReducer(runtimeReducer, jobId, initialState);
  const [view, setView] = useState<'entry' | 'section'>('entry');
  const [token, setToken] = useState<string | null>(null);
  const [jobMeta, setJobMeta] = useState<{ brand: string; model: string; city: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Step 5 — Offline queue controller. Reads/writes the durable queue,
  // listens to NetInfo + AppState, drives replay on reconnect/foreground.
  const queueCtl = useQueueController({
    apiBase: API,
    getToken: async () => AsyncStorage.getItem('auth_token'),
  });

  // ── Hydrate from AsyncStorage + fetch job metadata ─────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await AsyncStorage.getItem('auth_token');
        if (!t) { router.replace('/login' as any); return; }
        if (!cancelled) setToken(t);

        // 1. Read persisted runtime (resume).
        const raw = await AsyncStorage.getItem(STORAGE_KEY(jobId));
        if (raw && !cancelled) {
          try {
            const persisted = JSON.parse(raw) as Partial<RuntimeState>;
            dispatch({ type: 'HYDRATE', payload: persisted });
          } catch { /* swallow corrupt */ }
        } else if (!cancelled) {
          dispatch({ type: 'HYDRATE', payload: {} });
        }

        // 2. Fetch job for header. Cheap, doesn't block runtime.
        try {
          const res = await fetch(`${API}/api/inspector/jobs/${jobId}`, {
            headers: { Authorization: `Bearer ${t}` },
          });
          const data = await res.json();
          const j = data?.job || data;
          if (j && !cancelled) {
            const meta = { brand: j.brand || '', model: j.model || '', city: j.city || '' };
            setJobMeta(meta);
            dispatch({ type: 'INIT', jobId, vehicle: meta });
          }
        } catch { /* meta is non-critical */ }
      } catch (e) {
        console.warn('runtime hydrate failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, router]);

  // ── Autosave (debounced) ──────────────────────────────────────────
  useEffect(() => {
    if (!state.hydrated) return;
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      AsyncStorage.setItem(STORAGE_KEY(jobId), JSON.stringify(state)).catch(() => {});
    }, FLUSH_DEBOUNCE_MS);
    return () => { if (flushTimer.current) clearTimeout(flushTimer.current); };
  }, [state, jobId]);

  // ── Header (always visible) ────────────────────────────────────────
  const header = (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={() => {
          if (view === 'section') setView('entry');
          else router.back();
        }}
        testID="runtime-header-back"
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      >
        <Ionicons name="chevron-back" size={26} color="#FFF" />
      </TouchableOpacity>
      <View style={{ flex: 1, paddingHorizontal: 12 }}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {jobMeta ? `${jobMeta.brand} ${jobMeta.model}` : 'Inspection'}
        </Text>
        {jobMeta?.city && (
          <Text style={styles.headerSub} numberOfLines={1}>{jobMeta.city}</Text>
        )}
      </View>
      <Text style={styles.headerProgress}>{progressPct(state)}%</Text>
    </View>
  );

  if (!state.hydrated) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        {header}
        <View style={styles.loaderWrap}><ActivityIndicator color="#FFB020" /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {header}
      <SyncStatusBar controller={queueCtl} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {view === 'entry' ? (
          <RuntimeEntry
            state={state}
            onOpenSection={() => setView('section')}
            onSubmit={async () => {
              setSubmitting(true);
              try {
                const enqueued = await submitRuntime(jobId, state, token);
                if (enqueued) {
                  dispatch({ type: 'MARK_SUBMITTED' });
                  await AsyncStorage.removeItem(STORAGE_KEY(jobId));
                  // Replay worker will deliver the report (immediately if
                  // online, or whenever connectivity returns). The
                  // SyncStatusBar surfaces queue progress.
                  queueCtl.triggerReplay();
                  Alert.alert(
                    queueCtl.online ? t('inspector.otpravleno_v_ochered') : t('inspector.sohraneno_oflajn'),
                    queueCtl.online
                      ? t('inspector.otchet_uhodit_na_server_progress_v_bare_sinhroniza')
                      : t('inspector.otchet_ujdet_avtomaticheski_kak_tolko_poyavitsya_s'),
                  );
                  router.replace('/inspector/jobs' as any);
                }
              } finally {
                setSubmitting(false);
              }
            }}
            submitting={submitting}
          />
        ) : (
          <SectionRuntime state={state} dispatch={dispatch} />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────
// [F] Runtime Entry
// ─────────────────────────────────────────────────────────────────────

function RuntimeEntry({
  state, onOpenSection, onSubmit, submitting,
}: {
  state: RuntimeState;
  onOpenSection: () => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const { t } = useTranslation();
  const conf = sectionConfidence(state);
  const checked = checkedCount(state);
  const missingPhotos = itemsMissingPhoto(state);

  const confDot = {
    empty: SEVERITY_COLOR.not_checked,
    partial: SEVERITY_COLOR.warning,
    complete: SEVERITY_COLOR.ok,
    complete_with_warnings: SEVERITY_COLOR.warning,
  }[conf.level];

  return (
    <ScrollView contentContainerStyle={styles.entryBody}>
      <Text style={styles.entryKicker}>RUNTIME · R1 · BODY_PAINT</Text>
      <Text style={styles.entryTitle}>{t('inspector.razdely_osmotra')}</Text>
      <Text style={styles.entryHint}>
        В R1 запущен один раздел — кузов и покрас. Остальные 14 разделов появятся последовательно.
      </Text>

      {/* ── Body & paint section card ─────────────────────────────── */}
      <TouchableOpacity
        style={styles.sectionCard}
        onPress={onOpenSection}
        testID="runtime-section-body-paint"
        activeOpacity={0.85}
      >
        <View style={[styles.sectionDot, { backgroundColor: confDot }]} />
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text style={styles.sectionCardTitle}>{BODY_PAINT_SECTION.title}</Text>
          <Text style={styles.sectionCardMeta}>
            {checked}/{BODY_PAINT_SECTION.items.length} пунктов · {progressPct(state)}%
          </Text>
          {conf.reasons.map((r, i) => (
            <Text key={i} style={styles.sectionCardWarn}>· {r}</Text>
          ))}
        </View>
        <Ionicons name="chevron-forward" size={22} color="#A1A1AA" />
      </TouchableOpacity>

      {/* ── Locked sections (preview only) ────────────────────────── */}
      {LOCKED_SECTIONS.map((s) => (
        <View key={s.key} style={styles.sectionCardLocked}>
          <View style={styles.sectionDotLocked} />
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={styles.sectionCardLockedTitle}>{s.title}</Text>
            <Text style={styles.sectionCardLockedMeta}>{t('inspector.poyavitsya_v_r4')}</Text>
          </View>
          <Ionicons name="lock-closed" size={16} color="#5A5A5A" />
        </View>
      ))}

      {/* ── Soft submit gate ──────────────────────────────────────── */}
      <View style={{ marginTop: 28 }}>
        {missingPhotos.length > 0 && (
          <Text style={styles.softWarn}>
            ⚠ {missingPhotos.length} обязательное фото не приложено к проблемным пунктам. Можно отправить, но будет понижено доверие к отчёту.
          </Text>
        )}
        <TouchableOpacity
          style={[styles.submitBtn, (submitting || checked === 0) && { opacity: 0.5 }]}
          disabled={submitting || checked === 0}
          onPress={onSubmit}
          testID="runtime-submit"
          activeOpacity={0.85}
        >
          {submitting ? <ActivityIndicator color="#000" /> : (
            <>
              <Ionicons name="paper-plane" size={18} color="#000" />
              <Text style={styles.submitBtnText}>{t('inspector.otpravit_chernovik')}</Text>
            </>
          )}
        </TouchableOpacity>
        <Text style={styles.submitHint}>
          R1: отчёт уходит через legacy /api/inspector/jobs/:id/report. Score и verdict в этой версии — placeholder, реальный verdict draft появится в R5.
        </Text>
      </View>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────
// [G] Section Runtime — THE CORE SCREEN
// ─────────────────────────────────────────────────────────────────────

function SectionRuntime({
  state, dispatch,
}: {
  state: RuntimeState;
  dispatch: React.Dispatch<any>;
}) {
  const { t } = useTranslation();
  const items = BODY_PAINT_SECTION.items;
  const item = items[state.currentItemIdx] as BodyPaintItem;
  const result = state.items[item.key];

  // ── Photo picking — R1 uses image-picker; R3 swaps to inline camera ─
  const handlePickPhoto = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(i18n.t('chat.net_dostupa'), i18n.t('inspector.dajte_prilozheniyu_dostup_k_kamere_galeree_v_nastr'));
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      base64: false,
    });
    if (res.canceled) return;
    const uri = res.assets?.[0]?.uri;
    if (uri) dispatch({ type: 'ADD_PHOTO', itemKey: item.key, uri });
  }, [dispatch, item.key]);

  const handleTakePhoto = useCallback(async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(i18n.t('inspector.net_dostupa_k_kamere'), i18n.t('inspector.dajte_prilozheniyu_dostup_k_kamere_v_nastrojkah'));
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      base64: false,
    });
    if (res.canceled) return;
    const uri = res.assets?.[0]?.uri;
    if (uri) dispatch({ type: 'ADD_PHOTO', itemKey: item.key, uri });
  }, [dispatch, item.key]);

  return (
    <ScrollView contentContainerStyle={styles.sectionBody} keyboardShouldPersistTaps="handled">
      {/* Section header bar */}
      <View style={styles.sectionBar}>
        <Text style={styles.sectionBarTitle}>
          {BODY_PAINT_SECTION.title} · {state.currentItemIdx + 1}/{items.length}
        </Text>
        <View style={styles.sectionBarProgress}>
          <View
            style={[
              styles.sectionBarFill,
              { width: `${((state.currentItemIdx + 1) / items.length) * 100}%` },
            ]}
          />
        </View>
      </View>

      {/* Item card */}
      <View style={styles.itemCard}>
        <Text style={styles.itemLabel}>{item.label}</Text>
        {item.help && (
          <Text style={styles.itemHelp}>{item.help}</Text>
        )}

        {/* Camera buttons — instant access, big targets */}
        <View style={styles.cameraRow}>
          <TouchableOpacity
            style={styles.cameraBtn}
            onPress={handleTakePhoto}
            testID="item-take-photo"
            activeOpacity={0.85}
          >
            <Ionicons name="camera" size={22} color="#000" />
            <Text style={styles.cameraBtnText}>{t('inspector.snyat')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.cameraBtnSecondary}
            onPress={handlePickPhoto}
            testID="item-pick-photo"
            activeOpacity={0.85}
          >
            <Ionicons name="images" size={20} color="#FFF" />
            <Text style={styles.cameraBtnSecondaryText}>{t('inspector.iz_galerei')}</Text>
          </TouchableOpacity>
        </View>

        {/* Attached photos thumb strip */}
        {result?.photoUris?.length > 0 && (
          <View style={styles.photoStrip}>
            {result.photoUris.map((uri) => (
              <View key={uri} style={styles.photoThumbWrap}>
                <Image source={{ uri }} style={styles.photoThumb} />
                <TouchableOpacity
                  style={styles.photoRemove}
                  onPress={() => dispatch({ type: 'REMOVE_PHOTO', itemKey: item.key, uri })}
                  testID="item-remove-photo"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="close-circle" size={20} color="#FFF" />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Numeric input for paint_depth items */}
        {item.type === 'paint_depth' && (
          <View style={styles.numericRow}>
            <Text style={styles.numericLabel}>{t('inspector.tolschina_lkp')}</Text>
            <TextInput
              style={styles.numericInput}
              value={result?.numericValue != null ? String(result.numericValue) : ''}
              onChangeText={(t) => {
                const n = t.replace(/[^\d]/g, '');
                dispatch({
                  type: 'SET_NUMERIC',
                  itemKey: item.key,
                  value: n ? parseInt(n, 10) : undefined,
                });
              }}
              keyboardType="number-pad"
              placeholder="—"
              placeholderTextColor="#5A5A5A"
              maxLength={4}
              testID="item-numeric"
            />
            <Text style={styles.numericUnit}>µm</Text>
          </View>
        )}

        {/* Severity picker — 3 huge thumb-sized buttons */}
        <Text style={styles.severityLabel}>{t('inspector.sostoyanie')}</Text>
        <View style={styles.severityRow}>
          {(['ok', 'warning', 'critical'] as ItemSeverity[]).map((sev) => {
            const active = result?.severity === sev;
            const color = SEVERITY_COLOR[sev];
            return (
              <TouchableOpacity
                key={sev}
                style={[
                  styles.severityChip,
                  active ? { backgroundColor: color, borderColor: color } : { borderColor: color },
                ]}
                onPress={() => dispatch({ type: 'SET_SEVERITY', itemKey: item.key, severity: sev })}
                testID={`item-severity-${sev}`}
                activeOpacity={0.85}
              >
                <Text
                  style={[
                    styles.severityChipText,
                    { color: active ? '#000' : color },
                  ]}
                >
                  {SEVERITY_LABEL[sev]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        {result?.severityAuto && (
          <Text style={styles.autoNote}>{t('inspector.auto_iz_tolschiny')}</Text>
        )}

        {/* Note */}
        <Text style={styles.noteLabel}>{t('inspector.zametka_opcionalno')}</Text>
        <TextInput
          style={styles.noteInput}
          value={result?.note ?? ''}
          onChangeText={(t) => dispatch({ type: 'SET_NOTE', itemKey: item.key, note: t })}
          placeholder={t('inspector.chto_to_vazhnoe_pro_etot_punkt')}

          placeholderTextColor="#5A5A5A"
          multiline
          maxLength={500}
          testID="item-note"
        />
      </View>

      {/* Item navigation */}
      <View style={styles.navRow}>
        <TouchableOpacity
          style={[styles.navBtn, state.currentItemIdx === 0 && { opacity: 0.3 }]}
          disabled={state.currentItemIdx === 0}
          onPress={() => dispatch({ type: 'PREV_ITEM' })}
          testID="item-prev"
          activeOpacity={0.85}
        >
          <Ionicons name="arrow-back" size={18} color="#FFF" />
          <Text style={styles.navBtnText}>{t('inspector.nazad_2')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.navBtn,
            styles.navBtnPrimary,
            state.currentItemIdx === items.length - 1 && { opacity: 0.5 },
          ]}
          disabled={state.currentItemIdx === items.length - 1}
          onPress={() => dispatch({ type: 'NEXT_ITEM' })}
          testID="item-next"
          activeOpacity={0.85}
        >
          <Text style={[styles.navBtnText, { color: '#000' }]}>{t('inspector.dalshe')}</Text>
          <Ionicons name="arrow-forward" size={18} color="#000" />
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Submit — enqueues report_submit into the durable offline queue.
// Returns true if successfully enqueued (UI moves on). Replay worker
// performs the actual POST /api/inspector/jobs/:id/report when online,
// with Idempotency-Key so a duplicate replay never creates two reports.
// ─────────────────────────────────────────────────────────────────────

async function submitRuntime(
  jobId: string, state: RuntimeState, token: string | null,
): Promise<boolean> {
  if (!token) { Alert.alert(t('inspector.net_tokena')); return false; }

  // Translate runtime state → legacy report payload.
  // R1 derives a placeholder verdict from severity counts. R5 will
  // replace this with server-canonical draft via GET /draft.
  let criticals = 0, warnings = 0, oks = 0;
  const checklist: Array<{ key: string; status: string; comment: string | null }> = [];

  for (const item of BODY_PAINT_SECTION.items) {
    const r = state.items[item.key];
    if (!r) continue;
    const sev = r.severity;
    if (sev === 'critical') criticals++;
    else if (sev === 'warning') warnings++;
    else if (sev === 'ok') oks++;
    // Backend statuses: ok | warning | problem | not_checked.
    // Map: critical → problem; warning → warning; ok → ok; else not_checked.
    const status = sev === 'critical' ? 'problem' : sev === 'not_checked' ? 'not_checked' : sev;
    checklist.push({ key: item.key, status, comment: r.note || null });
  }

  const score = Math.max(1, Math.min(10, 10 - criticals * 1.8 - warnings * 0.5));
  const verdict = criticals >= 2 || score < 5 ? 'not_recommended'
                : criticals >= 1 || warnings >= 3 || score < 7.5 ? 'risky'
                : 'recommended';

  // Build summary from the touched items — emergent rather than authored.
  const probItems = BODY_PAINT_SECTION.items.filter((i) => {
    const r = state.items[i.key];
    return r && (r.severity === 'warning' || r.severity === 'critical');
  });
  const summaryLines = [
    `Body & paint inspection — ${oks} ok, ${warnings} warnings, ${criticals} critical.`,
    ...probItems.slice(0, 3).map((i) => `• ${i.label}: ${state.items[i.key].severity}`),
  ];
  const summary = summaryLines.join(' ').slice(0, 4000);

  // Issues from criticals (severity high) — same shape as legacy form.
  const issues = probItems
    .filter((i) => state.items[i.key].severity === 'critical')
    .slice(0, 5)
    .map((i) => ({
      severity: 'high',
      title: i.label,
      description: state.items[i.key].note || null,
    }));

  try {
    // Stable Idempotency-Key per (jobId, runtime-payload-hash). We use
    // the body shape's identity — checklist length + verdict + score +
    // first-3-issues — as a low-collision fingerprint. Same submission
    // re-fired after a crash maps to the same key, so the server returns
    // the cached response instead of creating a duplicate report.
    const fingerprint =
      `${jobId}:${verdict}:${Math.round(score * 10)}:${checklist.length}:` +
      issues.slice(0, 3).map((i) => i.title).join('|');
    const idempotencyKey = `report_${jobId}_${hashString(fingerprint)}`;

    await enqueue({
      kind: 'report_submit',
      jobId,
      idempotencyKey,
      payload: {
        score: Math.round(score * 10) / 10,
        verdict,
        checklist,
        issues,
        summary,
      },
    });
    return true;
  } catch (e: any) {
    Alert.alert(i18n.t('inspector.ne_udalos_postavit_v_ochered'), e?.message || i18n.t('inspector.oshibka_enqueue'));
    return false;
  }
}

/** Stable, dependency-free string hash (DJB2). Sufficient for idempotency keys. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// ─────────────────────────────────────────────────────────────────────
// Locked sections (preview only in R1)
// ─────────────────────────────────────────────────────────────────────

const LOCKED_SECTIONS = [
  { key: 'documents',    title: i18n.t('inspector.dokumenty') },
  { key: 'engine',       title: i18n.t('inspector.dvigatel') },
  { key: 'transmission', title: i18n.t('inspector.korobka_peredach') },
  { key: 'brakes',       title: i18n.t('inspector.tormoza') },
  { key: 'suspension',   title: i18n.t('inspector.podveska') },
  { key: 'tyres',        title: i18n.t('inspector.shiny_i_diski') },
  { key: 'glass',        title: i18n.t('inspector.stekla') },
  { key: 'lights',       title: i18n.t('inspector.osveschenie') },
  { key: 'interior',     title: i18n.t('inspector.salon') },
  { key: 'electronics',  title: i18n.t('inspector.elektronika') },
  { key: 'ac',           title: i18n.t('inspector.klimat') },
  { key: 'test_drive',   title: i18n.t('inspector.test_drajv') },
  { key: 'environment',  title: i18n.t('inspector.istoriya_i_sreda') },
  { key: 'final_media',  title: i18n.t('inspector.finalnye_media') },
];

// ─────────────────────────────────────────────────────────────────────
// Styles — dense, fast, sunlight-safe (high contrast, big targets)
// ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#000' },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#1f1f1f',
  },
  headerTitle: { fontSize: 17, fontWeight: '900', color: '#FFF', letterSpacing: -0.2 },
  headerSub: { fontSize: 11, color: '#A1A1AA', fontWeight: '600', marginTop: 1 },
  headerProgress: { fontSize: 16, fontWeight: '900', color: '#FFB020', letterSpacing: 0.5 },

  loaderWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // ── Entry view ──────────────────────────────────────────────────
  entryBody: { padding: 18, paddingBottom: 64 },
  entryKicker: { fontSize: 10, fontWeight: '800', color: '#FFB020', letterSpacing: 2 },
  entryTitle: { fontSize: 26, fontWeight: '900', color: '#FFF', marginTop: 8, marginBottom: 4, letterSpacing: -0.5 },
  entryHint: { fontSize: 12, color: '#A1A1AA', lineHeight: 17, marginBottom: 22 },

  sectionCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#0d0d0d',
    borderWidth: 1, borderColor: '#2E2E2E',
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
  },
  sectionCardTitle: { fontSize: 16, fontWeight: '800', color: '#FFF' },
  sectionCardMeta: { fontSize: 12, color: '#A1A1AA', marginTop: 3 },
  sectionCardWarn: { fontSize: 11, color: '#FFB020', marginTop: 4, fontWeight: '600' },
  sectionDot: { width: 14, height: 14, borderRadius: 7 },

  sectionCardLocked: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#080808',
    borderWidth: 1, borderColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    marginBottom: 6,
    opacity: 0.55,
  },
  sectionCardLockedTitle: { fontSize: 14, fontWeight: '700', color: '#A1A1AA' },
  sectionCardLockedMeta: { fontSize: 10, color: '#5A5A5A', marginTop: 2, letterSpacing: 1 },
  sectionDotLocked: { width: 14, height: 14, borderRadius: 7, backgroundColor: '#2a2a2a' },

  softWarn: {
    fontSize: 12, color: '#FFB020', fontWeight: '600',
    marginBottom: 12, lineHeight: 17,
  },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#FFB020',
    paddingVertical: 16, borderRadius: 12,
  },
  submitBtnText: { fontSize: 15, fontWeight: '900', color: '#000', letterSpacing: 0.5 },
  submitHint: { fontSize: 10, color: '#5A5A5A', marginTop: 10, lineHeight: 14 },

  // ── Section view ────────────────────────────────────────────────
  sectionBody: { padding: 16, paddingBottom: 100 },
  sectionBar: { marginBottom: 14 },
  sectionBarTitle: { fontSize: 12, fontWeight: '800', color: '#FFB020', letterSpacing: 1.5, marginBottom: 6 },
  sectionBarProgress: { height: 4, backgroundColor: '#1f1f1f', borderRadius: 2, overflow: 'hidden' },
  sectionBarFill: { height: '100%', backgroundColor: '#FFB020' },

  itemCard: {
    backgroundColor: '#0d0d0d',
    borderWidth: 1, borderColor: '#2E2E2E',
    borderRadius: 14,
    padding: 16,
  },
  itemLabel: { fontSize: 18, fontWeight: '800', color: '#FFF', letterSpacing: -0.3 },
  itemHelp: { fontSize: 12, color: '#A1A1AA', marginTop: 6, lineHeight: 17 },

  cameraRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  cameraBtn: {
    flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#FFB020', paddingVertical: 14, borderRadius: 10,
  },
  cameraBtnText: { fontSize: 14, fontWeight: '900', color: '#000', letterSpacing: 0.5 },
  cameraBtnSecondary: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: '#3a3a3a', paddingVertical: 14, borderRadius: 10,
  },
  cameraBtnSecondaryText: { fontSize: 12, fontWeight: '700', color: '#FFF' },

  photoStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  photoThumbWrap: { width: 72, height: 72, position: 'relative' },
  photoThumb: { width: 72, height: 72, borderRadius: 8, backgroundColor: '#1a1a1a' },
  photoRemove: {
    position: 'absolute', top: -6, right: -6,
    backgroundColor: '#000', borderRadius: 10,
  },

  numericRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 10 },
  numericLabel: { fontSize: 13, color: '#A1A1AA', fontWeight: '600', flex: 1 },
  numericInput: {
    width: 90, height: 44,
    borderWidth: 1, borderColor: '#3a3a3a',
    borderRadius: 8,
    paddingHorizontal: 12,
    color: '#FFF', fontSize: 16, fontWeight: '700',
    textAlign: 'center',
  },
  numericUnit: { fontSize: 13, color: '#A1A1AA', fontWeight: '700', width: 32 },

  severityLabel: { fontSize: 11, color: '#A1A1AA', fontWeight: '700', letterSpacing: 1, marginTop: 18, marginBottom: 8 },
  severityRow: { flexDirection: 'row', gap: 8 },
  severityChip: {
    flex: 1, height: 46,
    borderRadius: 10, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#0d0d0d',
  },
  severityChipText: { fontSize: 13, fontWeight: '900', letterSpacing: 1 },
  autoNote: { fontSize: 10, color: '#5A5A5A', marginTop: 6, fontStyle: 'italic' },

  noteLabel: { fontSize: 11, color: '#A1A1AA', fontWeight: '700', letterSpacing: 1, marginTop: 18, marginBottom: 6 },
  noteInput: {
    minHeight: 60,
    borderWidth: 1, borderColor: '#3a3a3a',
    borderRadius: 10,
    padding: 12,
    color: '#FFF', fontSize: 14, lineHeight: 20,
    textAlignVertical: 'top',
    backgroundColor: '#0a0a0a',
  },

  // Navigation
  navRow: { flexDirection: 'row', gap: 10, marginTop: 18 },
  navBtn: {
    flex: 1, height: 52,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: '#3a3a3a', borderRadius: 12,
    backgroundColor: '#0d0d0d',
  },
  navBtnPrimary: { backgroundColor: '#FFB020', borderColor: '#FFB020' },
  navBtnText: { fontSize: 14, fontWeight: '800', color: '#FFF', letterSpacing: 0.5 },
});

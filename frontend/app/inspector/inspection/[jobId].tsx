/**
 * UX-3B — Inspector inspection workflow (section list + per-item editor).
 *
 * Flow:
 *   /inspector/inspection/[jobId]/
 *     ↓ section list with progress, tap a section
 *   /inspector/inspection/[jobId]?section=<id>
 *     ↓ same page with section detail (inline modal-ish)
 *
 * Why single screen: the section list and the section detail share the same
 * `report` state. Splitting into 2 routes meant 2 GET /report calls per
 * section nav. We render the detail inline as a section sheet instead.
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, RefreshControl, KeyboardAvoidingView, Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';

import { useThemeContext } from '../../../src/context/ThemeContext';
import { api } from '../../../src/services/api';
import InspectionMediaThumb from '../../../src/components/InspectionMediaThumb';

// _internal/ modules — types, constants, pure helpers, styles.
// See `_internal/types.ts` for the shared shape vocabulary.
import type {
  Status, Item, Section, Report, TLEvent, OcrPending, GapInfo, GapTotals,
} from './_internal/types';
import { STATUS_OPTS } from './_internal/constants';
import { toneOf as toneOfHelper, relTime as relTimeHelper, prettifyEvent as prettifyEventHelper } from './_internal/helpers';
import { styles } from './_internal/styles';
import i18n from '../../../src/i18n';

export default function InspectionWorkflowScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const { jobId, section: sectionParam, captureKey, captureSection, captureItem } = useLocalSearchParams<{
    jobId: string;
    section?: string;
    captureKey?: string;
    captureSection?: string;
    captureItem?: string;
  }>();

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingItem, setSavingItem] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  // UX-4C — proactive evidence-gap guidance.
  // Key = `${sectionId}/${itemId}` → severity from /evidence-gaps endpoint.
  // Hydrated whenever the report mutates (item patch / media upload).
  // Shape: `GapInfo` from `_internal/types.ts`.
  const [gapByItem, setGapByItem] = useState<Record<string, GapInfo>>({});
  const [gapTotals, setGapTotals] = useState<GapTotals>({ hardCount: 0, softCount: 0 });
  // UX-4D — Inspector TimelineRail. See `_internal/types.ts` for the
  // `TLEvent` projection contract. The inspector workflow lens reads the
  // same `/timeline` endpoint as admin forensics but deliberately drops
  // suspicion / provenance hash / geo distance from the projection.
  const [timeline, setTimeline] = useState<TLEvent[]>([]);
  const [timelineExpanded, setTimelineExpanded] = useState(false);

  // OCR-1 — pending OCR candidates waiting for inspector accept/correct.
  // Keyed by mediaId so we don't have to refetch media docs to know state.
  // Cleared when the inspector confirms (accept or correct).
  // Shape: `OcrPending` from `_internal/types.ts`.
  const [pendingOcr, setPendingOcr] = useState<Record<string, OcrPending>>({});
  const [ocrEditing, setOcrEditing] = useState<string | null>(null); // mediaId
  const [ocrDraft, setOcrDraft] = useState<string>('');
  const [ocrSaving, setOcrSaving] = useState<string | null>(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      const r = await api.post(`/inspections/${jobId}/start`, {});
      setReport(r.data.report);
    } catch (e: any) {
      const detail = e?.response?.data?.detail || e?.message;
      setError(String(detail || 'failed'));
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { start(); }, [start]);

  // UX-4C — refresh evidence-gaps whenever the report mutates. Cheap call
  // (Mongo aggregate over single-job media set), so it's safe to fire on
  // each item/media change. Failures are silent — guidance overlay just
  // becomes neutral until next mutation succeeds.
  useEffect(() => {
    if (!report) return;
    let alive = true;
    api.get(`/inspections/${jobId}/evidence-gaps`).then((r) => {
      if (!alive) return;
      const data = r.data || {};
      const map: Record<string, any> = {};
      for (const it of (data.items || [])) {
        map[`${it.sectionId}/${it.itemId}`] = {
          severity: it.severity,
          expected: it.expected,
          uploaded: it.uploaded || [],
          hardEnforced: !!it.hardEnforced,
        };
      }
      setGapByItem(map);
      setGapTotals({ hardCount: data.hardCount || 0, softCount: data.softCount || 0 });
    }).catch(() => {});
    return () => { alive = false; };
  }, [jobId, report]);

  // UX-4D — TimelineRail fetch. Same cadence as evidence-gaps. We project
  // events through a workflow lens (drop suspicion/provenance silently) so
  // the inspector sees their own momentum, not an audit trail.
  useEffect(() => {
    if (!report) return;
    let alive = true;
    api.get(`/inspections/${jobId}/timeline`).then((r) => {
      if (!alive) return;
      const list = (r.data?.events || []) as any[];
      setTimeline(list.map((ev) => ({
        id: ev.id || ev._id || `${ev.eventType}-${ev.at}`,
        eventType: ev.eventType,
        at: ev.at,
        payload: ev.payload || {},
      })));
    }).catch(() => {});
    return () => { alive = false; };
  }, [jobId, report]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api.get(`/inspections/${jobId}/report`);
      setReport(r.data.report);
    } catch {}
    setRefreshing(false);
  }, [jobId]);

  const stats = useMemo(() => {
    if (!report) return { total: 0, done: 0, pct: 0, criticals: 0, warnings: 0 };
    let total = 0, done = 0, criticals = 0, warnings = 0;
    report.sections.forEach((s) => s.items.forEach((it) => {
      total++;
      if (it.status !== 'pending') done++;
      if (it.status === 'critical') criticals++;
      if (it.status === 'warning') warnings++;
    }));
    return { total, done, pct: total ? Math.round((done * 100) / total) : 0, criticals, warnings };
  }, [report]);

  // UX-3B Summary — projected score & recommendation, mirrors backend _compute_summary.
  const projectedSummary = useMemo(() => {
    if (!report) return null;
    let score = 10.0;
    const criticals: { section: string; itemId: string; label: string; note: string }[] = [];
    const warnings: { section: string; itemId: string; label: string; note: string }[] = [];
    const goodPoints: string[] = [];
    const blockers: string[] = []; // items that block submit (no required photo)
    report.sections.forEach((s) => s.items.forEach((it) => {
      if (it.status === 'critical') {
        score -= 2.0;
        criticals.push({ section: s.id, itemId: it.id, label: it.label, note: it.note || '' });
        if (it.requiredMedia && it.media.length === 0) blockers.push(`${s.title} → ${it.label}`);
      } else if (it.status === 'warning') {
        score -= 0.4;
        warnings.push({ section: s.id, itemId: it.id, label: it.label, note: it.note || '' });
        if (it.requiredMedia && it.media.length === 0) blockers.push(`${s.title} → ${it.label}`);
      } else if (it.status === 'ok') {
        goodPoints.push(it.label);
      }
    }));
    score = Math.max(0, Math.min(10, Math.round(score * 10) / 10));
    let recommendation: 'buy' | 'buy_with_caution' | 'avoid';
    if (criticals.length > 0) recommendation = 'avoid';
    else if (score >= 8.0) recommendation = 'buy';
    else if (score >= 5.0) recommendation = 'buy_with_caution';
    else recommendation = 'avoid';
    return { score, recommendation, criticals, warnings, goodPoints, blockers };
  }, [report]);

  const sectionStats = (s: Section) => {
    let total = s.items.length, done = 0, criticals = 0, warnings = 0;
    s.items.forEach((it) => {
      if (it.status !== 'pending') done++;
      if (it.status === 'critical') criticals++;
      if (it.status === 'warning') warnings++;
    });
    return { total, done, pct: total ? Math.round((done * 100) / total) : 0, criticals, warnings };
  };

  // UX-4C step 2 — section-level evidence rollup, derived from `gapByItem`.
  // Sibling of the header chips: each section row gets the same severity
  // taxonomy aggregated so the inspector can navigate spatially without
  // scrolling the whole report. `hard` blocks submit, `soft` is overridable.
  const gapBySection = useMemo(() => {
    const map: Record<string, { hard: number; soft: number }> = {};
    Object.entries(gapByItem).forEach(([key, g]) => {
      const [sectionId] = key.split('/');
      if (!map[sectionId]) map[sectionId] = { hard: 0, soft: 0 };
      if (g.severity === 'hard_missing') map[sectionId].hard += 1;
      else if (g.severity === 'soft_missing' || g.severity === 'soft_mismatch') map[sectionId].soft += 1;
    });
    return map;
  }, [gapByItem]);

  // UX-4D — Event projection: workflow lens (NOT forensics). Translates raw
  // backend eventType into a single-line progress narrative suitable for
  // the inspector themselves. Anything the admin uses (suspicion, hash,
  // geo distance) is intentionally absent from this projection — those
  // signals belong to a different surface (admin forensics rail).
  // Inspector TimelineRail event projector — closes over current `colors`
  // + `t_` shim; the actual mapping logic lives in `_internal/helpers.ts`.
  const prettifyEvent = useCallback((ev: TLEvent) => prettifyEventHelper(ev, colors as any, t_),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colors.primary, colors.success, colors.textSecondary]);

  // Helper: relative time ("just now", "5m", "2h", "yesterday"). Stays
  // intentionally simple — no localized RTF library needed for a workflow
  // rail. Update via a single tick state every 60s.
  const [tlNow, setTlNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTlNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  // Relative time string ("just now", "5m", "2h", "yesterday", "3d") —
  // implementation in `_internal/helpers.ts`. Closes over `tlNow` so the
  // rail re-renders every 60s tick.
  const relTime = useCallback((iso: string): string => relTimeHelper(tlNow, iso, t_), [tlNow]);

  // i18n shim — `t()` with positional defaultValue.
  // (Defined inline so the projection helpers above can use it.)
  function t_(key: string, fallback: string) {
    return t(key, { defaultValue: fallback }) as string;
  }

  const patchItem = useCallback(async (sectionId: string, itemId: string, patch: Partial<Pick<Item, 'status' | 'note'>>) => {
    if (!report) return;
    const key = `${sectionId}/${itemId}`;
    setSavingItem(key);
    try {
      const r = await api.patch(
        `/inspections/${jobId}/sections/${sectionId}/items/${itemId}`,
        patch,
      );
      setReport(r.data.report);
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.detail || e?.message || 'patch failed');
    } finally {
      setSavingItem(null);
    }
  }, [jobId, report]);

  /**
   * UX-4A — Guided capture flow.
   * For items that declare a `captureContext` (vin / odometer / damage / ...),
   * we route the inspector through `/inspector/capture/[context]` which renders
   * a camera with overlay frame + deterministic quality heuristics. The captured
   * payload (base64 + capture metadata) comes back via a global stash referenced
   * by `captureKey`. We drain it in a focus effect below.
   *
   * Falls back to image library for items without a context (e.g. legacy items
   * or "general" snapshots).
   */
  const uploadPhoto = useCallback(async (sectionId: string, itemId: string, captureContext?: string | null) => {
    if (captureContext) {
      const item = report?.sections.find((s) => s.id === sectionId)?.items.find((i) => i.id === itemId);
      router.push({
        pathname: '/inspector/capture/[context]',
        params: {
          context: captureContext,
          jobId: String(jobId),
          sectionId,
          itemId,
          label: item?.label || '',
        },
      } as any);
      return;
    }
    // Library fallback
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission needed'); return; }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true, quality: 0.6,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    const b64 = asset.base64;
    if (!b64) return;
    setSavingItem(`${sectionId}/${itemId}`);
    try {
      const up = await api.post(`/inspections/${jobId}/media`, {
        sectionId, itemId, base64: b64,
        mime: asset.mimeType || 'image/jpeg',
      });
      const re = await api.get(`/inspections/${jobId}/report`);
      setReport(re.data.report);
      // OCR-1 — stash a freshly-detected OCR candidate for review.
      const ocr = up?.data?.media?.ocr;
      const mid = up?.data?.media?.id;
      if (ocr && mid && ocr.status === 'detected' && ocr.candidate) {
        setPendingOcr((prev) => ({
          ...prev,
          [mid]: {
            mediaId: mid, sectionId, itemId,
            kind: ocr.kind, candidate: ocr.candidate,
            confidence: ocr.confidence, unit: ocr.unit,
          },
        }));
      }
    } catch (e: any) {
      Alert.alert('Upload error', e?.response?.data?.detail || e?.message);
    } finally {
      setSavingItem(null);
    }
  }, [jobId, router, report]);

  /**
   * UX-4A — Drain captured photo on return from guided capture screen.
   * The capture screen stashes the payload under `globalThis.__guidedCaptureStash[captureKey]`
   * because URL params can't carry multi-MB base64. We pick it up here and POST as media.
   */
  useEffect(() => {
    const key = captureKey ? String(captureKey) : null;
    const sid = captureSection ? String(captureSection) : null;
    const iid = captureItem ? String(captureItem) : null;
    if (!key || !sid || !iid) return;
    const stash = (globalThis as any).__guidedCaptureStash || {};
    const payload = stash[key];
    if (!payload) return;
    delete stash[key];
    // Strip the params from the URL so we don't re-trigger on next render
    router.setParams({ captureKey: '', captureSection: '', captureItem: '' } as any);
    (async () => {
      setSavingItem(`${sid}/${iid}`);
      try {
        const up = await api.post(`/inspections/${jobId}/media`, {
          sectionId: sid, itemId: iid,
          base64: payload.base64,
          mime: 'image/jpeg',
          capture: payload.capture,
        });
        const re = await api.get(`/inspections/${jobId}/report`);
        setReport(re.data.report);
        // OCR-1 — stash detected candidate for inspector review.
        const ocr = up?.data?.media?.ocr;
        const mid = up?.data?.media?.id;
        if (ocr && mid && ocr.status === 'detected' && ocr.candidate) {
          setPendingOcr((prev) => ({
            ...prev,
            [mid]: {
              mediaId: mid, sectionId: sid, itemId: iid,
              kind: ocr.kind, candidate: ocr.candidate,
              confidence: ocr.confidence, unit: ocr.unit,
            },
          }));
        }
      } catch (e: any) {
        Alert.alert('Upload error', e?.response?.data?.detail || e?.message);
      } finally {
        setSavingItem(null);
      }
    })();
  }, [captureKey, captureSection, captureItem, jobId, router]);

  // OCR-1 — accept or correct a pending OCR candidate.
  const confirmOcr = useCallback(async (mediaId: string, action: 'accept' | 'correct', value?: string) => {
    setOcrSaving(mediaId);
    try {
      await api.post(`/inspections/${jobId}/media/${mediaId}/ocr/confirm`, {
        action, value,
      });
      // Remove from pending — the inspector has now resolved this candidate.
      setPendingOcr((prev) => {
        const next = { ...prev };
        delete next[mediaId];
        return next;
      });
      setOcrEditing(null);
      setOcrDraft('');
      // Refresh timeline so the rail picks up ocr.corrected (and re-fetches
      // are otherwise harmless).
      try {
        const tl = await api.get(`/inspections/${jobId}/timeline`);
        const list = (tl.data?.events || []) as any[];
        setTimeline(list.map((ev) => ({
          id: ev.id || ev._id || `${ev.eventType}-${ev.at}`,
          eventType: ev.eventType, at: ev.at, payload: ev.payload || {},
        })));
      } catch {}
    } catch (e: any) {
      Alert.alert('OCR confirm error', e?.response?.data?.detail || e?.message || 'failed');
    } finally {
      setOcrSaving(null);
    }
  }, [jobId]);

  const submit = useCallback(async (override = false) => {
    if (!report) return;
    setSubmitting(true);
    try {
      const url = override
        ? `/inspections/${jobId}/submit?override=true`
        : `/inspections/${jobId}/submit`;
      const r = await api.post(url, {});
      Alert.alert(
        i18n.t('insp.submit_ok', { defaultValue: i18n.t('inspector.otchet_otpravlen') }),
        i18n.t('insp.submit_ok_body', {
          defaultValue: i18n.t('inspector.score_r_data_report_overallscore_10_rekomendaciya_'),
        }),
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } catch (e: any) {
      const resp = e?.response?.data || {};
      // UX-4C — Required-context enforcement envelope.
      // Backend returns { error, code, message, details: { kind, hardCount, softCount, items, hint } }.
      const code = resp?.code;
      const det = resp?.details;
      if (code === 'EVIDENCE_GAPS_HARD' && det?.items?.length) {
        const lines = det.items.slice(0, 5).map((it: any) =>
          `• ${it.label} — required: ${it.expected || '—'}${it.uploaded?.length ? ` (got: ${it.uploaded.join(', ')})` : ''}`,
        ).join('\n');
        Alert.alert(
          i18n.t('insp.evidence_hard_title', { defaultValue: 'Expected evidence missing (critical)' }),
          `${det.hardCount} identity-critical item(s) require photo of the expected context. These cannot be skipped.\n\n${lines}${det.items.length > 5 ? '\n…' : ''}`,
        );
      } else if (code === 'EVIDENCE_GAPS_SOFT' && det?.items?.length) {
        const lines = det.items.slice(0, 5).map((it: any) =>
          `• ${it.label} — required: ${it.expected || '—'}${it.uploaded?.length ? ` (got: ${it.uploaded.join(', ')})` : ''}`,
        ).join('\n');
        Alert.alert(
          i18n.t('insp.evidence_soft_title', { defaultValue: 'Expected evidence missing' }),
          `${det.softCount} item(s) are missing expected media. You can override if conditions made it impossible to capture (rain, night, old phone).\n\n${lines}${det.items.length > 5 ? '\n…' : ''}`,
          [
            { text: i18n.t('insp.cancel', { defaultValue: i18n.t('inspector.otmena') }), style: 'cancel' },
            {
              text: i18n.t('insp.submit_with_override', { defaultValue: 'Submit anyway' }),
              style: 'destructive',
              onPress: () => submit(true),
            },
          ],
        );
      } else if (typeof resp?.details === 'object' && resp?.details?.errors) {
        const errs: string[] = resp.details.errors;
        Alert.alert(
          i18n.t('insp.submit_incomplete', { defaultValue: i18n.t('inspector.otchet_ne_gotov') }),
          `${errs.length} unresolved:\n${errs.slice(0, 5).join('\n')}${errs.length > 5 ? '\n…' : ''}`,
        );
      } else {
        Alert.alert('Submit error', String(resp?.message || e?.message));
      }
    } finally {
      setSubmitting(false);
    }
  }, [jobId, report, router, t]);

  // Tone resolver — implementation in `_internal/helpers.ts`. Local
  // closure over `colors` so callers don't need to thread the theme.
  const toneOf = useCallback((tone: 'ok' | 'warning' | 'critical' | 'na'): string =>
    toneOfHelper(colors as any, tone),
    [colors],
  );

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background, justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }
  if (error || !report) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background, padding: 24 }]}>
        <Ionicons name="alert-circle-outline" size={48} color={colors.danger} style={{ alignSelf: 'center' }} />
        <Text style={[styles.errorText, { color: colors.text }]}>{error || 'Failed to load report'}</Text>
        <TouchableOpacity onPress={() => router.back()} style={[styles.cta, { backgroundColor: colors.primary, marginTop: 16 }]}>
          <Text style={{ color: colors.onPrimary || '#000', fontWeight: '700' }}>Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const activeSection: Section | null =
    sectionParam ? (report.sections.find((s) => s.id === sectionParam) || null) : null;

  // ─── SUMMARY VIEW (UX-3B step 6-7: pre-submit review) ──────────────
  if (showSummary && projectedSummary) {
    const recColors: Record<string, string> = {
      buy: colors.success || '#16a34a',
      buy_with_caution: colors.warning || '#f59e0b',
      avoid: colors.danger || '#dc2626',
    };
    const recIcons: Record<string, any> = {
      buy: 'checkmark-circle',
      buy_with_caution: 'warning',
      avoid: 'close-circle',
    };
    const recLabels: Record<string, string> = {
      buy: i18n.t('insp.rec.buy', { defaultValue: i18n.t('inspector.mozhno_pokupat') }),
      buy_with_caution: i18n.t('insp.rec.caution', { defaultValue: i18n.t('inspector.pokupat_s_ostorozhnostyu') }),
      avoid: i18n.t('insp.rec.avoid', { defaultValue: i18n.t('inspector.ne_rekomenduem') }),
    };
    const tone = recColors[projectedSummary.recommendation];
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity
            testID="insp-summary-back"
            onPress={() => setShowSummary(false)}
            style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Ionicons name="chevron-back" size={20} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            {t('insp.summary_title', { defaultValue: t('inspector.svodka_otcheta') })}
          </Text>
          <View style={{ width: 38 }} />
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {/* Recommendation banner */}
          <View
            testID="insp-summary-banner"
            style={[styles.summaryBanner, { backgroundColor: tone + '15', borderColor: tone }]}
          >
            <View style={[styles.summaryIcon, { backgroundColor: tone + '30' }]}>
              <Ionicons name={recIcons[projectedSummary.recommendation]} size={28} color={tone} />
            </View>
            <Text style={[styles.summaryRec, { color: tone }]}>
              {recLabels[projectedSummary.recommendation]}
            </Text>
            <Text style={[styles.summaryScore, { color: colors.text }]}>
              {projectedSummary.score.toFixed(1)}<Text style={[styles.summaryScoreHint, { color: colors.textSecondary }]}> / 10</Text>
            </Text>
            <Text style={[styles.summaryHint, { color: colors.textSecondary }]}>
              {t('insp.summary_hint', { defaultValue: t('inspector.eto_to_chto_uvidit_klient_proverte_pered_otpravkoj') })}
            </Text>
          </View>

          {/* Critical issues */}
          {projectedSummary.criticals.length > 0 && (
            <View testID="insp-summary-criticals" style={[styles.summaryBlock, { backgroundColor: recColors.avoid + '10', borderColor: recColors.avoid + '60' }]}>
              <View style={styles.summaryBlockHead}>
                <Ionicons name="alert-circle" size={18} color={recColors.avoid} />
                <Text style={[styles.summaryBlockTitle, { color: recColors.avoid }]}>
                  {t('insp.summary_critical', { defaultValue: t('inspector.kritichnye_problemy') })}
                </Text>
                <View style={[styles.summaryCountPill, { backgroundColor: recColors.avoid }]}>
                  <Text style={styles.summaryCountText}>{projectedSummary.criticals.length}</Text>
                </View>
              </View>
              {projectedSummary.criticals.map((c, i) => (
                <View key={i} style={styles.summaryRow}>
                  <View style={[styles.summaryBullet, { backgroundColor: recColors.avoid }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.summaryRowLabel, { color: colors.text }]}>{c.label}</Text>
                    {c.note ? <Text style={[styles.summaryRowNote, { color: colors.textSecondary }]}>{c.note}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Warnings */}
          {projectedSummary.warnings.length > 0 && (
            <View testID="insp-summary-warnings" style={[styles.summaryBlock, { backgroundColor: recColors.buy_with_caution + '10', borderColor: recColors.buy_with_caution + '60' }]}>
              <View style={styles.summaryBlockHead}>
                <Ionicons name="warning" size={18} color={recColors.buy_with_caution} />
                <Text style={[styles.summaryBlockTitle, { color: recColors.buy_with_caution }]}>
                  {t('insp.summary_warning', { defaultValue: t('inspector.preduprezhdeniya') })}
                </Text>
                <View style={[styles.summaryCountPill, { backgroundColor: recColors.buy_with_caution }]}>
                  <Text style={styles.summaryCountText}>{projectedSummary.warnings.length}</Text>
                </View>
              </View>
              {projectedSummary.warnings.map((w, i) => (
                <View key={i} style={styles.summaryRow}>
                  <View style={[styles.summaryBullet, { backgroundColor: recColors.buy_with_caution }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.summaryRowLabel, { color: colors.text }]}>{w.label}</Text>
                    {w.note ? <Text style={[styles.summaryRowNote, { color: colors.textSecondary }]}>{w.note}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Good points (collapsed list) */}
          {projectedSummary.goodPoints.length > 0 && (
            <View testID="insp-summary-good" style={[styles.summaryBlock, { backgroundColor: recColors.buy + '10', borderColor: recColors.buy + '60' }]}>
              <View style={styles.summaryBlockHead}>
                <Ionicons name="checkmark-circle" size={18} color={recColors.buy} />
                <Text style={[styles.summaryBlockTitle, { color: recColors.buy }]}>
                  {t('insp.summary_good', { defaultValue: t('inspector.chto_v_poryadke') })}
                </Text>
                <View style={[styles.summaryCountPill, { backgroundColor: recColors.buy }]}>
                  <Text style={styles.summaryCountText}>{projectedSummary.goodPoints.length}</Text>
                </View>
              </View>
              <Text style={[styles.summaryGoodList, { color: colors.textSecondary }]}>
                {projectedSummary.goodPoints.slice(0, 8).join(' · ')}
                {projectedSummary.goodPoints.length > 8 ? ` … +${projectedSummary.goodPoints.length - 8}` : ''}
              </Text>
            </View>
          )}

          {/* Blockers — required photo missing */}
          {projectedSummary.blockers.length > 0 && (
            <View testID="insp-summary-blockers" style={[styles.summaryBlock, { backgroundColor: recColors.avoid + '15', borderColor: recColors.avoid }]}>
              <View style={styles.summaryBlockHead}>
                <Ionicons name="camera-reverse" size={18} color={recColors.avoid} />
                <Text style={[styles.summaryBlockTitle, { color: recColors.avoid }]}>
                  {t('insp.summary_blockers', { defaultValue: t('inspector.nuzhny_foto_pered_otpravkoj') })}
                </Text>
              </View>
              {projectedSummary.blockers.map((b, i) => (
                <Text key={i} style={[styles.summaryRowLabel, { color: colors.text, marginLeft: 4, marginTop: 4 }]}>• {b}</Text>
              ))}
            </View>
          )}

          {/* Action row */}
          <View style={styles.summaryActions}>
            <TouchableOpacity
              testID="insp-summary-edit"
              onPress={() => setShowSummary(false)}
              activeOpacity={0.85}
              style={[styles.summaryEditBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Ionicons name="create-outline" size={18} color={colors.text} />
              <Text style={[styles.ctaText, { color: colors.text }]}>
                {t('insp.summary_edit', { defaultValue: t('inspector.nazad_redaktirovat') })}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="insp-summary-confirm"
              onPress={submit}
              disabled={submitting || projectedSummary.blockers.length > 0}
              activeOpacity={0.85}
              style={[
                styles.summaryConfirmBtn,
                { backgroundColor: projectedSummary.blockers.length === 0 ? tone : colors.border },
              ]}
            >
              {submitting ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Ionicons name="paper-plane" size={18} color="#fff" />
                  <Text style={[styles.ctaText, { color: '#fff' }]}>
                    {t('insp.summary_confirm', { defaultValue: t('inspector.podtverdit_i_otpravit') })}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ─── SECTION LIST ────────────────────────────────────────────────
  if (!activeSection) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Ionicons name="chevron-back" size={20} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('insp.title', { defaultValue: 'Inspection' })}</Text>
          <View style={{ width: 38 }} />
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {/* Progress card */}
          <View style={[styles.progressCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.progressTopRow}>
              <Text style={[styles.progressTitle, { color: colors.text }]}>
                {t('insp.progress', { defaultValue: t('inspector.progress') })}
              </Text>
              <Text style={[styles.progressN, { color: colors.text }]}>
                {stats.done} / {stats.total} · {stats.pct}%
              </Text>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <View style={[styles.progressFill, { backgroundColor: colors.primary, width: `${stats.pct}%` }]} />
            </View>
            {(stats.criticals > 0 || stats.warnings > 0 || gapTotals.hardCount > 0 || gapTotals.softCount > 0) && (
              <View style={styles.flagsRow}>
                {stats.criticals > 0 && (
                  <View style={[styles.flag, { backgroundColor: toneOf('critical') + '20' }]}>
                    <Text style={[styles.flagText, { color: toneOf('critical') }]}>{stats.criticals} critical</Text>
                  </View>
                )}
                {stats.warnings > 0 && (
                  <View style={[styles.flag, { backgroundColor: toneOf('warning') + '20' }]}>
                    <Text style={[styles.flagText, { color: toneOf('warning') }]}>{stats.warnings} warnings</Text>
                  </View>
                )}
                {/* UX-4C — proactive evidence summary chips (guidance, not blockers) */}
                {gapTotals.hardCount > 0 && (
                  <View testID="header-gap-hard" style={[styles.flag, { backgroundColor: '#ef444420' }]}>
                    <Text style={[styles.flagText, { color: '#ef4444' }]}>
                      {gapTotals.hardCount} required evidence
                    </Text>
                  </View>
                )}
                {gapTotals.softCount > 0 && (
                  <View testID="header-gap-soft" style={[styles.flag, { backgroundColor: '#f59e0b20' }]}>
                    <Text style={[styles.flagText, { color: '#f59e0b' }]}>
                      {gapTotals.softCount} evidence pending
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>

          {/* UX-4D — Inspector TimelineRail. Workflow lens. Collapsed by
              default; tap to expand. Never renders suspicion/provenance —
              that's a different surface (admin forensics). */}
          {timeline.length > 0 && (() => {
            const last = timeline[timeline.length - 1];
            const lastPretty = prettifyEvent(last);
            const visible = timelineExpanded
              ? timeline.slice(-12).reverse()
              : [];
            return (
              <View
                testID="insp-tl-rail"
                style={[styles.tlCard, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <TouchableOpacity
                  testID="insp-tl-toggle"
                  activeOpacity={0.85}
                  onPress={() => setTimelineExpanded((v) => !v)}
                  style={styles.tlHead}
                >
                  <View style={[styles.tlHeadDot, { backgroundColor: lastPretty.tone + '25' }]}>
                    <Ionicons name={lastPretty.icon} size={14} color={lastPretty.tone} />
                  </View>
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={[styles.tlHeadTitle, { color: colors.text }]} numberOfLines={1}>
                      {lastPretty.title}
                    </Text>
                    <Text style={[styles.tlHeadSub, { color: colors.textSecondary }]}>
                      {t_('insp.tl.activity', 'Activity')} · {timeline.length} · {relTime(last.at)}
                    </Text>
                  </View>
                  <Ionicons
                    name={timelineExpanded ? 'chevron-up' : 'chevron-down'}
                    size={18}
                    color={colors.textSecondary}
                  />
                </TouchableOpacity>

                {timelineExpanded && (
                  <View testID="insp-tl-body" style={[styles.tlBody, { borderTopColor: colors.border }]}>
                    {visible.map((ev, idx) => {
                      const p = prettifyEvent(ev);
                      return (
                        <View
                          key={ev.id}
                          testID={`insp-tl-event-${ev.eventType}`}
                          style={styles.tlRow}
                        >
                          <View style={styles.tlRowAxis}>
                            <View style={[styles.tlRowDot, { backgroundColor: p.tone }]} />
                            {idx < visible.length - 1 && (
                              <View style={[styles.tlRowLine, { backgroundColor: colors.border }]} />
                            )}
                          </View>
                          <View style={{ flex: 1, paddingBottom: 10 }}>
                            <View style={styles.tlRowHead}>
                              <Ionicons name={p.icon} size={13} color={p.tone} />
                              <Text style={[styles.tlRowTitle, { color: colors.text }]} numberOfLines={1}>
                                {p.title}
                              </Text>
                              <Text style={[styles.tlRowWhen, { color: colors.textSecondary }]}>
                                {relTime(ev.at)}
                              </Text>
                            </View>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            );
          })()}

          {report.sections.map((s) => {
            const st = sectionStats(s);
            const g = gapBySection[s.id] || { hard: 0, soft: 0 };
            // UX-4C step 2 — section navigator rollup. Chip order = severity:
            //   1) hard evidence (red)    — identity-critical, blocks submit
            //   2) soft evidence (amber)  — overridable evidence gaps
            //   3) critical item statuses (red, distinct from gaps)
            //   4) warning item statuses (amber, distinct from gaps)
            //   5) ✓ — section done AND zero gaps AND zero flagged items
            const isClean =
              st.done === st.total &&
              g.hard === 0 && g.soft === 0 &&
              st.criticals === 0 && st.warnings === 0;
            return (
              <TouchableOpacity
                key={s.id}
                testID={`insp-section-${s.id}`}
                onPress={() => router.setParams({ section: s.id } as any)}
                activeOpacity={0.85}
                style={[styles.sectionRow, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.sectionTitle, { color: colors.text }]}>{s.title}</Text>
                  <Text style={[styles.sectionMeta, { color: colors.textSecondary }]}>
                    {st.done}/{st.total} · {st.pct}%
                  </Text>
                </View>
                <View style={styles.sectionChips}>
                  {g.hard > 0 && (
                    <View
                      testID={`insp-section-${s.id}-chip-hard`}
                      style={[styles.sectionChip, { backgroundColor: '#ef444420', borderColor: '#ef444455' }]}
                    >
                      <Ionicons name="alert-circle" size={11} color="#ef4444" />
                      <Text style={[styles.sectionChipText, { color: '#ef4444' }]}>{g.hard}</Text>
                    </View>
                  )}
                  {g.soft > 0 && (
                    <View
                      testID={`insp-section-${s.id}-chip-soft`}
                      style={[styles.sectionChip, { backgroundColor: '#f59e0b20', borderColor: '#f59e0b55' }]}
                    >
                      <Ionicons name="information-circle" size={11} color="#f59e0b" />
                      <Text style={[styles.sectionChipText, { color: '#f59e0b' }]}>{g.soft}</Text>
                    </View>
                  )}
                  {st.criticals > 0 && (
                    <View
                      testID={`insp-section-${s.id}-chip-criticals`}
                      style={[styles.sectionChip, { backgroundColor: toneOf('critical') + '20', borderColor: toneOf('critical') + '55' }]}
                    >
                      <Ionicons name="close-circle" size={11} color={toneOf('critical')} />
                      <Text style={[styles.sectionChipText, { color: toneOf('critical') }]}>{st.criticals}</Text>
                    </View>
                  )}
                  {st.warnings > 0 && (
                    <View
                      testID={`insp-section-${s.id}-chip-warnings`}
                      style={[styles.sectionChip, { backgroundColor: toneOf('warning') + '20', borderColor: toneOf('warning') + '55' }]}
                    >
                      <Ionicons name="warning" size={11} color={toneOf('warning')} />
                      <Text style={[styles.sectionChipText, { color: toneOf('warning') }]}>{st.warnings}</Text>
                    </View>
                  )}
                  {isClean && (
                    <View
                      testID={`insp-section-${s.id}-chip-clean`}
                      style={[styles.sectionChip, { backgroundColor: (colors.success || '#16a34a') + '20', borderColor: (colors.success || '#16a34a') + '55' }]}
                    >
                      <Ionicons name="checkmark-circle" size={11} color={colors.success || '#16a34a'} />
                    </View>
                  )}
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
              </TouchableOpacity>
            );
          })}

          <TouchableOpacity
            testID="insp-review"
            onPress={() => setShowSummary(true)}
            disabled={submitting || stats.pct < 100}
            activeOpacity={0.85}
            style={[
              styles.cta,
              { backgroundColor: stats.pct === 100 ? colors.primary : colors.border, marginTop: 22 },
            ]}
          >
            {submitting ? <ActivityIndicator color={colors.onPrimary || '#000'} /> : (
              <>
                <Ionicons name="eye" size={18} color={colors.onPrimary || '#000'} />
                <Text style={[styles.ctaText, { color: colors.onPrimary || '#000' }]}>
                  {stats.pct === 100
                    ? t('insp.review', { defaultValue: t('inspector.proverit_i_otpravit') })
                    : t('insp.complete_first', { defaultValue: t('inspector.zapolnite_vse_stats_total_stats_done_punkt_ov')})}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ─── SECTION DETAIL ────────────────────────────────────────────
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.setParams({ section: undefined } as any)}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{activeSection.title}</Text>
        <View style={{ width: 38 }} />
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {activeSection.items.map((it) => {
            const isSaving = savingItem === `${activeSection.id}/${it.id}`;
            // UX-4C — inline evidence-gap indicator for this item.
            const gap = gapByItem[`${activeSection.id}/${it.id}`];
            const gapTone =
              !gap || gap.severity === 'ok' ? null :
              gap.severity === 'hard_missing' ? '#ef4444' :        // red — identity-critical
              gap.severity === 'soft_mismatch' ? '#f59e0b' :       // amber — wrong context
              '#f59e0b';                                            // amber — missing (soft)
            const gapMsg = gap ? (
              gap.severity === 'hard_missing' ? `Required: ${gap.expected || 'evidence'}${gap.uploaded?.length ? ` · got: ${gap.uploaded.join(', ')}` : ''}` :
              gap.severity === 'soft_mismatch' ? `Expected: ${gap.expected} · got: ${(gap.uploaded || []).join(', ') || '—'}` :
              gap.severity === 'soft_missing' ? `Expected evidence: ${gap.expected || 'photo'}` : ''
            ) : '';
            return (
              <View key={it.id} style={[
                styles.itemCard,
                { backgroundColor: colors.card, borderColor: gapTone || colors.border, borderLeftWidth: gapTone ? 3 : 1, borderLeftColor: gapTone || colors.border },
              ]}>
                <View style={styles.itemHeader}>
                  <Text style={[styles.itemLabel, { color: colors.text, flex: 1 }]}>{it.label}</Text>
                  {it.requiredMedia ? (
                    <View style={[styles.requiredPill, { backgroundColor: colors.primary + '20' }]}>
                      <Ionicons name="camera" size={11} color={colors.primary} />
                      <Text style={[styles.requiredText, { color: colors.primary }]}>req</Text>
                    </View>
                  ) : null}
                </View>

                {/* UX-4C — inspection guidance line (not validation panel). */}
                {gap && gap.severity !== 'ok' && (
                  <View
                    testID={`item-${it.id}-gap-${gap.severity}`}
                    style={[styles.gapLine, { backgroundColor: (gapTone || '#999') + '15', borderColor: (gapTone || '#999') + '55' }]}
                  >
                    <Ionicons
                      name={gap.severity === 'hard_missing' ? 'alert-circle' : 'information-circle'}
                      size={13}
                      color={gapTone || colors.textSecondary}
                    />
                    <Text style={[styles.gapText, { color: gapTone || colors.textSecondary }]}>
                      {gapMsg}
                    </Text>
                  </View>
                )}

                <View style={styles.statusRow}>
                  {STATUS_OPTS.map((opt) => {
                    const active = it.status === opt.id;
                    const tone = toneOf(opt.tone);
                    return (
                      <TouchableOpacity
                        key={opt.id}
                        testID={`item-${it.id}-${opt.id}`}
                        onPress={() => patchItem(activeSection.id, it.id, { status: opt.id })}
                        style={[
                          styles.statusBtn,
                          { borderColor: active ? tone : colors.border, backgroundColor: active ? tone + '20' : 'transparent' },
                        ]}
                        activeOpacity={0.7}
                      >
                        <Ionicons name={opt.icon} size={14} color={active ? tone : colors.textSecondary} />
                        <Text style={[styles.statusBtnText, { color: active ? tone : colors.textSecondary }]}>{opt.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <TextInput
                  testID={`item-${it.id}-note`}
                  defaultValue={it.note || ''}
                  onEndEditing={(e) => patchItem(activeSection.id, it.id, { note: e.nativeEvent.text })}
                  placeholder={t('insp.note_placeholder', { defaultValue: t('inspector.zametka_opcionalno') })}
                  placeholderTextColor={colors.textMuted}
                  multiline
                  style={[styles.noteInput, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
                />

                <View style={styles.mediaRow}>
                  {it.media.map((mid) => (
                    <InspectionMediaThumb
                      key={mid}
                      jobId={String(jobId)}
                      mediaId={mid}
                      size={50}
                      bgColor={colors.border}
                      testID={`item-${it.id}-thumb-${mid}`}
                    />
                  ))}
                  <TouchableOpacity
                    testID={`item-${it.id}-add-photo`}
                    onPress={() => uploadPhoto(activeSection.id, it.id, it.captureContext)}
                    style={[styles.mediaAdd, { borderColor: colors.primary }]}
                    disabled={isSaving}
                    activeOpacity={0.7}
                  >
                    {isSaving ? <ActivityIndicator color={colors.primary} /> : (
                      <>
                        <Ionicons name="camera" size={18} color={colors.primary} />
                        <Text style={[styles.mediaAddText, { color: colors.primary }]}>{it.media.length === 0 ? t('insp.add_photo', { defaultValue: t('inspector.foto') }) : '+'}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>

                {/* OCR-1 — pending OCR candidates for this item. Inspector
                    accepts or corrects each. Disappears on confirm. */}
                {(() => {
                  const itemPending = Object.values(pendingOcr).filter(
                    (p) => p.sectionId === activeSection.id && p.itemId === it.id,
                  );
                  if (!itemPending.length) return null;
                  return itemPending.map((p) => {
                    const isEditing = ocrEditing === p.mediaId;
                    const isSavingOcr = ocrSaving === p.mediaId;
                    const confPct = Math.round(p.confidence * 100);
                    const confTone = p.confidence >= 0.85 ? (colors.success || '#16a34a')
                      : p.confidence >= 0.5 ? '#f59e0b' : '#ef4444';
                    const labelHuman = p.kind === 'vin' ? 'VIN' : 'Odometer';
                    const displayValue = p.kind === 'odometer' && !isNaN(Number(p.candidate))
                      ? `${Number(p.candidate).toLocaleString('en-US')} ${p.unit || 'km'}`
                      : p.candidate;
                    return (
                      <View
                        key={p.mediaId}
                        testID={`ocr-card-${p.mediaId}`}
                        style={[styles.ocrCard, { backgroundColor: colors.background, borderColor: colors.border }]}
                      >
                        <View style={styles.ocrHead}>
                          <Ionicons name="scan" size={14} color={colors.primary || '#facc15'} />
                          <Text style={[styles.ocrHeadTitle, { color: colors.text }]}>
                            {labelHuman} {t_('insp.ocr.detected', 'detected')}
                          </Text>
                          <View style={[styles.ocrConf, { backgroundColor: confTone + '20', borderColor: confTone + '55' }]}>
                            <Text style={[styles.ocrConfText, { color: confTone }]}>{confPct}%</Text>
                          </View>
                        </View>

                        {!isEditing ? (
                          <Text
                            testID={`ocr-card-${p.mediaId}-value`}
                            style={[styles.ocrValue, { color: colors.text }]}
                            selectable
                          >
                            {displayValue}
                          </Text>
                        ) : (
                          <TextInput
                            testID={`ocr-card-${p.mediaId}-input`}
                            value={ocrDraft}
                            onChangeText={setOcrDraft}
                            autoCapitalize={p.kind === 'vin' ? 'characters' : 'none'}
                            autoCorrect={false}
                            keyboardType={p.kind === 'odometer' ? 'numeric' : 'default'}
                            maxLength={p.kind === 'vin' ? 17 : 7}
                            style={[styles.ocrInput, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
                          />
                        )}

                        <View style={styles.ocrActions}>
                          {!isEditing ? (
                            <>
                              <TouchableOpacity
                                testID={`ocr-card-${p.mediaId}-accept`}
                                onPress={() => confirmOcr(p.mediaId, 'accept')}
                                disabled={isSavingOcr}
                                style={[styles.ocrBtn, { backgroundColor: colors.primary || '#facc15' }]}
                                activeOpacity={0.85}
                              >
                                {isSavingOcr ? <ActivityIndicator color={colors.background} /> : (
                                  <>
                                    <Ionicons name="checkmark" size={14} color={colors.background} />
                                    <Text style={[styles.ocrBtnText, { color: colors.background }]}>
                                      {t_('insp.ocr.accept', 'Accept')}
                                    </Text>
                                  </>
                                )}
                              </TouchableOpacity>
                              <TouchableOpacity
                                testID={`ocr-card-${p.mediaId}-edit`}
                                onPress={() => { setOcrEditing(p.mediaId); setOcrDraft(p.candidate); }}
                                disabled={isSavingOcr}
                                style={[styles.ocrBtnGhost, { borderColor: colors.border }]}
                                activeOpacity={0.85}
                              >
                                <Ionicons name="create" size={14} color={colors.text} />
                                <Text style={[styles.ocrBtnGhostText, { color: colors.text }]}>
                                  {t_('insp.ocr.edit', 'Edit')}
                                </Text>
                              </TouchableOpacity>
                            </>
                          ) : (
                            <>
                              <TouchableOpacity
                                testID={`ocr-card-${p.mediaId}-save`}
                                onPress={() => confirmOcr(p.mediaId, 'correct', ocrDraft.trim())}
                                disabled={isSavingOcr || !ocrDraft.trim()}
                                style={[styles.ocrBtn, {
                                  backgroundColor: ocrDraft.trim() ? (colors.primary || '#facc15') : colors.border,
                                }]}
                                activeOpacity={0.85}
                              >
                                {isSavingOcr ? <ActivityIndicator color={colors.background} /> : (
                                  <>
                                    <Ionicons name="save" size={14} color={colors.background} />
                                    <Text style={[styles.ocrBtnText, { color: colors.background }]}>
                                      {t_('insp.ocr.save', 'Save')}
                                    </Text>
                                  </>
                                )}
                              </TouchableOpacity>
                              <TouchableOpacity
                                testID={`ocr-card-${p.mediaId}-cancel`}
                                onPress={() => { setOcrEditing(null); setOcrDraft(''); }}
                                disabled={isSavingOcr}
                                style={[styles.ocrBtnGhost, { borderColor: colors.border }]}
                                activeOpacity={0.85}
                              >
                                <Text style={[styles.ocrBtnGhostText, { color: colors.text }]}>
                                  {t_('insp.ocr.cancel', 'Cancel')}
                                </Text>
                              </TouchableOpacity>
                            </>
                          )}
                        </View>
                      </View>
                    );
                  });
                })()}
              </View>
            );
          })}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}


/**
 * UX-3C — Customer-readable inspection report.
 *
 * Reads `/api/inspections/{jobId}/customer-view` (which strips internal
 * fields and shapes sections without `pending` items). Shown to the
 * customer once status != draft.
 *
 * Layout (top-to-bottom):
 *   1. Recommendation banner (buy / buy_with_caution / avoid) — color-coded
 *   2. Score 0–10 circle + completed-at
 *   3. Critical issues block (red, if any) — what kills the deal
 *   4. Warnings block (amber, if any)   — what to negotiate
 *   5. Good points block (green)        — what is reassuring
 *   6. Section-by-section drill-down (expandable accordion)
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Modal, Image, Dimensions, Platform, Alert,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import InspectionMediaThumb from '../../src/components/InspectionMediaThumb';
import CustomerProcessTimeline from '../../src/components/CustomerProcessTimeline';
import i18n from '../../src/i18n';

type Item = { id: string; label: string; status: string; note?: string | null; mediaCount?: number; mediaIds?: string[] };
type Section = {
  id: string; title: string; items: Item[];
  criticalCount?: number; warningCount?: number; okCount?: number;
  mediaCount?: number; severity?: 'critical' | 'warning' | 'ok';
};
type Issue = { section: string; itemId: string; label: string; note?: string };
type InterpretationLine = { section: string; severity: 'critical' | 'warning'; title: string; count: number };
type CustomerReport = {
  id: string; jobId: string;
  overallScore: number; recommendation: 'buy' | 'buy_with_caution' | 'avoid';
  criticalIssues: Issue[]; warnings: Issue[]; goodPoints: string[];
  sections: Section[]; completedAt: string;
  interpretation?: { headline: string; lines: InterpretationLine[] };
};

const SECTION_META: Record<string, { icon: any; label: string }> = {
  exterior:    { icon: 'car-sport',          label: 'Кузов' },
  interior:    { icon: 'cube',                label: 'Салон' },
  engine:      { icon: 'cog',                 label: 'Двигатель' },
  suspension:  { icon: 'speedometer',         label: 'Подвеска и тормоза' },
  diagnostics: { icon: 'pulse',               label: 'Диагностика' },
  test_drive:  { icon: 'navigate',            label: 'Тест-драйв' },
  documents:   { icon: 'document-text',       label: 'Документы' },
};

export default function CustomerReportScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const { jobId } = useLocalSearchParams<{ jobId: string }>();
  const [report, setReport] = useState<CustomerReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<{ mediaId: string; uri?: string } | null>(null);
  const [sharingPdf, setSharingPdf] = useState(false);

  /**
   * UX-3D — Portable artifact.
   * Downloads the canonical inspection PDF (built backend-side from
   * `_shape_customer_payload`) and opens the native share sheet so the
   * customer can send it to seller / bank / WhatsApp / email.
   */
  const onSharePdf = useCallback(async () => {
    if (!jobId || sharingPdf) return;
    setSharingPdf(true);
    try {
      const base = (api.defaults?.baseURL || '').replace(/\/$/, '');
      const url = `${base}/inspections/${jobId}/report.pdf`;
      const auth = api.defaults?.headers?.common?.Authorization || api.defaults?.headers?.Authorization;
      const fileUri = `${FileSystem.cacheDirectory}inspection-${String(jobId).slice(0, 8)}.pdf`;
      const dl = await FileSystem.downloadAsync(url, fileUri, {
        headers: typeof auth === 'string' ? { Authorization: auth } : {},
      });
      if (dl.status !== 200) {
        throw new Error(`download failed: HTTP ${dl.status}`);
      }
      if (Platform.OS === 'web') {
        // Web fallback: open in new tab
        if (typeof window !== 'undefined') {
          window.open(dl.uri, '_blank');
        }
      } else if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dl.uri, {
          mimeType: 'application/pdf',
          dialogTitle: i18n.t('rep.share_dialog', { defaultValue: 'Поделиться отчётом' }) as string,
          UTI: 'com.adobe.pdf',
        });
      } else {
        Alert.alert(
          i18n.t('rep.share_unavailable_title', { defaultValue: 'Share недоступен' }) as string,
          i18n.t('rep.share_unavailable_msg', { defaultValue: 'PDF сохранён в кеше: ' }) as string + dl.uri,
        );
      }
    } catch (e: any) {
      Alert.alert(
        i18n.t('rep.share_failed_title', { defaultValue: 'Не удалось получить PDF' }) as string,
        String(e?.message || e),
      );
    } finally {
      setSharingPdf(false);
    }
  }, [jobId, sharingPdf, t]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.get(`/inspections/${jobId}/customer-view`);
      setReport(r.data.report);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'load failed');
    } finally {
      setLoading(false);
    }
  }, [jobId]);
  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => setExpanded((s) => {
    const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

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
        <Ionicons name="document-text-outline" size={48} color={colors.textSecondary} style={{ alignSelf: 'center' }} />
        <Text style={[styles.errorText, { color: colors.text }]}>{error || 'No report yet'}</Text>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backCta, { backgroundColor: colors.primary, marginTop: 16 }]}>
          <Text style={{ color: colors.onPrimary || '#000', fontWeight: '700' }}>Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const recColors = {
    buy: colors.success || '#16a34a',
    buy_with_caution: colors.warning || '#f59e0b',
    avoid: colors.danger || '#dc2626',
  } as const;
  const recIcons = {
    buy: 'checkmark-circle' as const,
    buy_with_caution: 'warning' as const,
    avoid: 'close-circle' as const,
  };
  const recLabels = {
    buy: i18n.t('rep.rec.buy', { defaultValue: 'Можно покупать' }),
    buy_with_caution: i18n.t('rep.rec.caution', { defaultValue: 'Покупать с осторожностью' }),
    avoid: i18n.t('rep.rec.avoid', { defaultValue: 'Не рекомендуем' }),
  };
  const recDesc = {
    buy: i18n.t('rep.rec.buy_desc', { defaultValue: 'Серьёзных проблем не выявлено.' }),
    buy_with_caution: i18n.t('rep.rec.caution_desc', { defaultValue: 'Есть моменты для торга или будущего ремонта.' }),
    avoid: i18n.t('rep.rec.avoid_desc', { defaultValue: 'Найдены критичные проблемы. Лучше искать другой авто.' }),
  };

  const itemTone = (status: string): string =>
    status === 'critical' ? recColors.avoid
    : status === 'warning' ? recColors.buy_with_caution
    : status === 'ok' ? recColors.buy
    : (colors.textMuted || '#9ca3af');

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('rep.title', { defaultValue: 'Отчёт проверки' })}
        </Text>
        <TouchableOpacity
          testID="rep-share-btn"
          onPress={onSharePdf}
          disabled={sharingPdf}
          style={[styles.shareBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          {sharingPdf ? <ActivityIndicator size="small" color={colors.text} />
            : <Ionicons name="share-outline" size={20} color={colors.text} />}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Recommendation banner */}
        <View style={[styles.recBanner, { backgroundColor: recColors[report.recommendation] + '15', borderColor: recColors[report.recommendation] }]}>
          <View style={[styles.recIcon, { backgroundColor: recColors[report.recommendation] + '30' }]}>
            <Ionicons name={recIcons[report.recommendation]} size={28} color={recColors[report.recommendation]} />
          </View>
          <Text style={[styles.recTitle, { color: recColors[report.recommendation] }]}>
            {recLabels[report.recommendation]}
          </Text>
          <Text style={[styles.recDesc, { color: colors.textSecondary }]}>
            {recDesc[report.recommendation]}
          </Text>
        </View>

        {/* Score */}
        <View style={[styles.scoreCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View>
            <Text style={[styles.scoreLabel, { color: colors.textSecondary }]}>
              {t('rep.score', { defaultValue: 'Балл' })}
            </Text>
            <Text style={[styles.scoreValue, { color: colors.text }]}>
              {report.overallScore}<Text style={[styles.scoreHint, { color: colors.textSecondary }]}> / 10</Text>
            </Text>
          </View>
          <View>
            <Text style={[styles.scoreLabel, { color: colors.textSecondary }]}>
              {t('rep.completed', { defaultValue: 'Завершено' })}
            </Text>
            <Text style={[styles.scoreDate, { color: colors.text }]}>
              {report.completedAt ? new Date(report.completedAt).toLocaleString() : '—'}
            </Text>
          </View>
        </View>

        {/* UX-3C: Human-readable interpretation layer */}
        {report.interpretation && (report.interpretation.headline || report.interpretation.lines.length > 0) ? (
          <View
            testID="rep-interpretation"
            style={[styles.interpretCard, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            {report.interpretation.headline ? (
              <Text style={[styles.interpretHead, { color: colors.text }]}>
                {report.interpretation.headline}
              </Text>
            ) : null}
            {report.interpretation.lines.length > 0 ? (
              <View style={{ gap: 8, marginTop: 10 }}>
                {report.interpretation.lines.map((ln, i) => (
                  <View key={i} style={styles.interpretRow}>
                    <View style={[styles.interpretDot, { backgroundColor: ln.severity === 'critical' ? recColors.avoid : recColors.buy_with_caution }]} />
                    <Text style={[styles.interpretText, { color: colors.text }]}>{ln.title}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Critical issues */}
        {report.criticalIssues.length > 0 && (
          <RiskBlock
            title={t('rep.critical_title', { defaultValue: 'Критичные проблемы' })}
            subtitle={t('rep.critical_sub', { defaultValue: 'Это останавливает покупку' })}
            tone={recColors.avoid}
            icon="alert-circle"
            items={report.criticalIssues.map((c) => ({ label: c.label, note: c.note }))}
            colors={colors}
          />
        )}

        {/* Warnings */}
        {report.warnings.length > 0 && (
          <RiskBlock
            title={t('rep.warning_title', { defaultValue: 'На что обратить внимание' })}
            subtitle={t('rep.warning_sub', { defaultValue: 'Поводы для торга или будущего ремонта' })}
            tone={recColors.buy_with_caution}
            icon="warning"
            items={report.warnings.map((w) => ({ label: w.label, note: w.note }))}
            colors={colors}
          />
        )}

        {/* Good points */}
        {report.goodPoints.length > 0 && (
          <RiskBlock
            title={t('rep.good_title', { defaultValue: 'Что в порядке' })}
            subtitle={t('rep.good_sub', { defaultValue: 'Эти пункты прошли проверку' })}
            tone={recColors.buy}
            icon="checkmark-circle"
            items={report.goodPoints.slice(0, 8).map((g) => ({ label: g }))}
            colors={colors}
          />
        )}

        {/* UX-4B — Customer Sanitized Process Timeline.
            Shows how the inspection unfolded; hides all fraud heuristics.
            Component handles its own loading + 403/empty cases (renders null). */}
        <CustomerProcessTimeline jobId={String(jobId)} colors={colors} testID="cust-timeline" />

        {/* Detail accordion — risk cards per section */}
        <Text style={[styles.detailTitle, { color: colors.text }]}>
          {t('rep.detail_title', { defaultValue: 'Подробный отчёт по секциям' })}
        </Text>
        {report.sections.map((s) => {
          const open = expanded.has(s.id);
          const meta = SECTION_META[s.id] || { icon: 'ellipse', label: s.title };
          const sev = s.severity || 'ok';
          const sevColor = sev === 'critical' ? recColors.avoid : sev === 'warning' ? recColors.buy_with_caution : recColors.buy;
          // Sort items inside section: critical first, then warning, then ok
          const sortedItems = [...s.items].sort((a, b) => {
            const order: Record<string, number> = { critical: 0, warning: 1, ok: 2, na: 3 };
            return (order[a.status] ?? 9) - (order[b.status] ?? 9);
          });
          return (
            <View
              key={s.id}
              testID={`rep-card-${s.id}`}
              style={[
                styles.riskCard,
                {
                  backgroundColor: colors.card,
                  borderColor: sev === 'critical' ? recColors.avoid + '70' : sev === 'warning' ? recColors.buy_with_caution + '70' : colors.border,
                  borderLeftWidth: sev === 'ok' ? 1 : 4,
                  borderLeftColor: sevColor,
                },
              ]}
            >
              <TouchableOpacity
                onPress={() => toggle(s.id)}
                testID={`rep-section-${s.id}`}
                activeOpacity={0.85}
                style={styles.riskCardHeader}
              >
                <View style={[styles.riskCardIcon, { backgroundColor: sevColor + '20' }]}>
                  <Ionicons name={meta.icon} size={20} color={sevColor} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.riskCardTitle, { color: colors.text }]}>{meta.label}</Text>
                  <View style={styles.riskCardSubRow}>
                    {(s.criticalCount || 0) > 0 ? (
                      <Text style={[styles.riskCardSubBad, { color: recColors.avoid }]}>
                        {s.criticalCount} критич.
                      </Text>
                    ) : null}
                    {(s.warningCount || 0) > 0 ? (
                      <Text style={[styles.riskCardSubWarn, { color: recColors.buy_with_caution }]}>
                        {s.warningCount} предупр.
                      </Text>
                    ) : null}
                    {(s.okCount || 0) > 0 && (s.criticalCount || 0) === 0 && (s.warningCount || 0) === 0 ? (
                      <Text style={[styles.riskCardSubOk, { color: recColors.buy }]}>
                        Всё в порядке · {s.okCount} пункт.
                      </Text>
                    ) : (s.okCount || 0) > 0 ? (
                      <Text style={[styles.riskCardSubMeta, { color: colors.textSecondary }]}>
                        · {s.okCount} OK
                      </Text>
                    ) : null}
                    {(s.mediaCount || 0) > 0 ? (
                      <View style={styles.riskCardMedia}>
                        <Ionicons name="image" size={11} color={colors.textSecondary} />
                        <Text style={[styles.riskCardMediaText, { color: colors.textSecondary }]}>{s.mediaCount}</Text>
                      </View>
                    ) : null}
                  </View>
                </View>
                <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textSecondary} />
              </TouchableOpacity>
              {open && (
                <View style={{ marginTop: 12, gap: 10 }}>
                  {sortedItems.map((it) => (
                    <View key={it.id} style={[styles.riskItemBlock, { borderColor: colors.border }]}>
                      <View style={styles.riskItemHead}>
                        <View style={[styles.itemDot, { backgroundColor: itemTone(it.status) }]} />
                        <Text style={[styles.riskItemLbl, { color: colors.text, flex: 1 }]}>{it.label}</Text>
                        <Text style={[styles.riskItemStatus, { color: itemTone(it.status) }]}>
                          {it.status === 'critical' ? 'Критично' : it.status === 'warning' ? 'Внимание' : it.status === 'ok' ? 'OK' : 'N/A'}
                        </Text>
                      </View>
                      {it.note ? (
                        <Text style={[styles.riskItemNote, { color: colors.textSecondary }]}>{it.note}</Text>
                      ) : null}
                      {it.mediaIds && it.mediaIds.length > 0 ? (
                        <View style={styles.itemThumbRow}>
                          {it.mediaIds.map((mid) => (
                            <InspectionMediaThumb
                              key={mid}
                              jobId={String(jobId)}
                              mediaId={mid}
                              size={56}
                              bgColor={colors.background}
                              onPress={() => setViewer({ mediaId: mid })}
                              testID={`rep-thumb-${it.id}-${mid}`}
                            />
                          ))}
                        </View>
                      ) : null}
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        })}

        {/* UX-3D — Download / Share PDF */}
        <TouchableOpacity
          testID="rep-share-cta"
          onPress={onSharePdf}
          disabled={sharingPdf}
          activeOpacity={0.85}
          style={[styles.sharePdfCta, { backgroundColor: recColors[report.recommendation] }]}
        >
          {sharingPdf ? <ActivityIndicator color="#fff" /> : (
            <>
              <Ionicons name="download-outline" size={20} color="#fff" />
              <View style={{ flex: 1 }}>
                <Text style={styles.sharePdfTitle}>
                  {t('rep.share_pdf', { defaultValue: 'Скачать и поделиться PDF' })}
                </Text>
                <Text style={styles.sharePdfHint}>
                  {t('rep.share_pdf_hint', { defaultValue: 'Отправьте продавцу, банку или сохраните перед покупкой' })}
                </Text>
              </View>
              <Ionicons name="share-outline" size={20} color="#fff" />
            </>
          )}
        </TouchableOpacity>

        <Text style={[styles.disclaimer, { color: colors.textSecondary }]}>
          {t('rep.disclaimer', {
            defaultValue: 'Отчёт отражает состояние авто на момент осмотра. Скрытые дефекты, проявляющиеся только при эксплуатации, могут не быть выявлены.',
          })}
        </Text>

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Full-screen media viewer */}
      <Modal
        visible={!!viewer}
        transparent
        animationType="fade"
        onRequestClose={() => setViewer(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={() => setViewer(null)}
          style={styles.viewerBackdrop}
          testID="rep-viewer-backdrop"
        >
          {viewer ? (
            <View style={styles.viewerInner} pointerEvents="box-none">
              <ViewerImage jobId={String(jobId)} mediaId={viewer.mediaId} />
              <TouchableOpacity
                onPress={() => setViewer(null)}
                style={styles.viewerClose}
                testID="rep-viewer-close"
              >
                <Ionicons name="close" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
          ) : null}
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

function ViewerImage({ jobId, mediaId }: { jobId: string; mediaId: string }) {
  const [uri, setUri] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    api.get(`/inspections/${jobId}/media/${mediaId}`)
      .then((r) => {
        const md = r.data?.media;
        if (md?.base64 && alive) setUri(`data:${md.mime || 'image/jpeg'};base64,${md.base64}`);
        else if (alive) setErr(true);
      })
      .catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [jobId, mediaId]);
  const w = Dimensions.get('window').width - 32;
  if (err) return <Ionicons name="alert-circle" size={48} color="#fff" />;
  if (!uri) return <ActivityIndicator color="#fff" />;
  return <Image source={{ uri }} style={{ width: w, height: w, borderRadius: 12 }} resizeMode="contain" />;
}

function RiskBlock({ title, subtitle, tone, icon, items, colors }: {
  title: string; subtitle: string; tone: string; icon: any;
  items: { label: string; note?: string }[]; colors: any;
}) {
  return (
    <View style={[styles.riskBlock, { backgroundColor: tone + '10', borderColor: tone + '60' }]}>
      <View style={styles.riskHeader}>
        <Ionicons name={icon} size={20} color={tone} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.riskTitle, { color: tone }]}>{title}</Text>
          <Text style={[styles.riskSub, { color: colors.textSecondary }]}>{subtitle}</Text>
        </View>
        <View style={[styles.riskCountPill, { backgroundColor: tone }]}>
          <Text style={styles.riskCountText}>{items.length}</Text>
        </View>
      </View>
      <View style={{ marginTop: 10, gap: 6 }}>
        {items.map((it, i) => (
          <View key={i} style={styles.riskItem}>
            <View style={[styles.riskBullet, { backgroundColor: tone }]} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.riskItemLabel, { color: colors.text }]}>{it.label}</Text>
              {it.note ? <Text style={[styles.riskItemNote, { color: colors.textSecondary }]}>{it.note}</Text> : null}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 },
  backBtn: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  shareBtn: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  sharePdfCta: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, paddingHorizontal: 16, borderRadius: 14, marginTop: 18,
  },
  sharePdfTitle: { color: '#fff', fontSize: 14, fontWeight: '800' },
  sharePdfHint: { color: 'rgba(255,255,255,0.85)', fontSize: 11, marginTop: 2, lineHeight: 14 },
  disclaimer: { fontSize: 11, lineHeight: 15, marginTop: 14, fontStyle: 'italic', textAlign: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  body: { paddingHorizontal: 16, paddingBottom: 32 },
  errorText: { fontSize: 14, textAlign: 'center', marginTop: 12 },
  backCta: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, alignSelf: 'center' },

  recBanner: { alignItems: 'center', padding: 18, borderRadius: 16, borderWidth: 1.5, gap: 8, marginBottom: 14 },
  recIcon: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  recTitle: { fontSize: 20, fontWeight: '800' },
  recDesc: { fontSize: 13, textAlign: 'center', lineHeight: 19 },

  scoreCard: {
    flexDirection: 'row', justifyContent: 'space-between',
    padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 16,
  },
  scoreLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  scoreValue: { fontSize: 30, fontWeight: '800', marginTop: 4 },
  scoreHint: { fontSize: 16, fontWeight: '500' },
  scoreDate: { fontSize: 13, fontWeight: '600', marginTop: 4 },

  riskBlock: { padding: 14, borderRadius: 14, borderWidth: 1, marginBottom: 12 },
  riskHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  riskTitle: { fontSize: 14, fontWeight: '800' },
  riskSub: { fontSize: 11, marginTop: 2 },
  riskCountPill: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  riskCountText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  riskItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  riskBullet: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  riskItemLabel: { fontSize: 13, fontWeight: '600' },
  riskItemNote: { fontSize: 12, marginTop: 2, lineHeight: 16 },

  detailTitle: { fontSize: 15, fontWeight: '800', marginTop: 18, marginBottom: 10 },

  // UX-3C Interpretation card
  interpretCard: { padding: 14, borderRadius: 14, borderWidth: 1, marginBottom: 14 },
  interpretHead: { fontSize: 15, fontWeight: '800', lineHeight: 21 },
  interpretRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  interpretDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  interpretText: { fontSize: 13, lineHeight: 18, flex: 1 },

  // Risk cards (per section)
  riskCard: { padding: 14, borderRadius: 14, borderWidth: 1, marginBottom: 10 },
  riskCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  riskCardIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  riskCardTitle: { fontSize: 15, fontWeight: '700' },
  riskCardSubRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 3 },
  riskCardSubBad: { fontSize: 12, fontWeight: '700' },
  riskCardSubWarn: { fontSize: 12, fontWeight: '700' },
  riskCardSubOk: { fontSize: 12, fontWeight: '600' },
  riskCardSubMeta: { fontSize: 12 },
  riskCardMedia: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  riskCardMediaText: { fontSize: 11, fontWeight: '600' },

  // Item block inside risk card
  riskItemBlock: { paddingTop: 8, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth },
  riskItemHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  riskItemLbl: { fontSize: 13, fontWeight: '600' },
  riskItemStatus: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },
  riskItemNote: { fontSize: 12, marginTop: 4, lineHeight: 16, marginLeft: 16 },

  sectionCard: { padding: 12, borderRadius: 12, borderWidth: 1, marginBottom: 6 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { fontSize: 14, fontWeight: '700' },
  sectionCount: { fontSize: 12 },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 4 },
  itemDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  itemLabel: { fontSize: 13, fontWeight: '600' },
  itemNote: { fontSize: 11, marginTop: 2, lineHeight: 15 },
  mediaBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  mediaBadgeText: { fontSize: 11, fontWeight: '600' },
  itemThumbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  viewerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  viewerInner: { alignItems: 'center', justifyContent: 'center' },
  viewerClose: {
    position: 'absolute', top: -12, right: -12,
    width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
});

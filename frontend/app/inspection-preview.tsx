// ═════════════════════════════════════════════════════════
// 🛡 P1.5 — Inspection Report HERO (free preview)
// User pastes link → tap preview card → this screen.
// Shows: car preview + Score/Risk/Verdict hero + Top problems
//        + Cost estimate + CTAs (full inspection / compare).
// Endpoint: POST /api/inspection/report/generate (deterministic).
//
// Sprint 11D-β — surface migration to canonical envelope.
//   Reads moved off `data.car.*` legacy mirror onto
//   `data.canonical.*` (priceEur / mileageKm / images[0] / etc.).
//   `marketAvg` intentionally STAYS on the legacy mirror — it is
//   NOT a parser substrate field (it is a downstream model-aware
//   baseline computed by build_report). Keeping it on `car.*` is
//   correct: the canonical contract must not absorb presentation
//   fields.
//   `hasPreviewSignal()` is the ONE gate for whether the car
//   preview card renders — no more ad-hoc `car.image / car.price`
//   conditionals. Pure read migration: no UI changes, no new
//   formatters, no semantics drift.
// ═════════════════════════════════════════════════════════
import React, { useEffect, useState } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../src/context/ThemeContext';
import Text from '../src/components/ui/Text';
import { api } from '../src/services/api';
import i18n from '../src/i18n';
import {
  hasPreviewSignal,
  type CanonicalParseEnvelope,
  type ParseCompleteness,
} from '@platform/domain/parsers/canonical';

type Severity = 'low' | 'medium' | 'high';
type Risk = 'low' | 'medium' | 'high';

interface Reason {
  code: string;
  severity: Severity;
  label: string;
  detail: string;
}
interface Report {
  score: number;
  risk: Risk;
  summary: string;
  reasons: Reason[];
  costEstimate: [number, number];
  decision: string;
  decisionLabel: string;
  confidence: 'low' | 'medium' | 'high';
  similarVehiclesCount: number;
  roiHint: string;
  marketSource: 'model' | 'year' | null;
  matchedModel?: string | null;
  inputs: {
    price?: number;
    mileage?: number;
    year?: number;
    fuel?: string;
    make?: string;
    model?: string;
    marketAvg?: number;
  };
}
interface CarLegacy {
  // 11D-β — most fields migrate to `canonical`. ONLY `marketAvg` stays
  // here because it is not a parser substrate field — it's a downstream
  // model-aware baseline (`build_report`) and intentionally outside
  // `ListingParseResult`. Step 11D-γ keeps this single legacy field;
  // the rest of `car.*` is deleted from the response.
  marketAvg?: number;
}

// Canonical envelope shape (mirrors `backend/app/parsers/contract.py`
// `ListingParseResult` Pydantic model). Augments the shared
// `CanonicalParseEnvelope` (which only declares the three classifier
// fields) with the full 18-key set actually shipped by 11D-α at
// `/api/inspection/report/generate`.
interface InspectionCanonical extends CanonicalParseEnvelope {
  source: string;
  sourceUrl: string;
  externalId: string | null;
  title: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  priceEur: number | null;
  mileageKm: number | null;
  location: string | null;
  vin: string | null;
  fuel: string | null;
  transmission: string | null;
  sellerType: string | null;
  images: string[];
  parseCompleteness: ParseCompleteness;
  degradedReason: string | null;
  ok: boolean;
}

interface ApiResp {
  report: Report;
  car: CarLegacy;
  // 11D-α published `canonical` on every response of
  // `/api/inspection/report/generate`. `null` only in manual mode
  // (no URL submitted) — this screen is always entered via a URL,
  // so canonical is effectively always present here. We still type
  // it nullable to match the wire contract.
  canonical: InspectionCanonical | null;
  parseMeta: { parsed: boolean; error?: string | null; source?: string };
  pricing: { inspectionFee: number; currency: string; deliveryHours: number };
}

const RISK_TINT: Record<Risk, { color: string; bg: string }> = {
  low:    { color: '#22C55E', bg: 'rgba(34,197,94,0.12)' },
  medium: { color: '#FFB020', bg: 'rgba(255,176,32,0.14)' },
  high:   { color: '#EF4444', bg: 'rgba(239,68,68,0.12)' },
};
const SEV_TINT: Record<Severity, string> = {
  low: '#A1A1AA',
  medium: '#FFB020',
  high: '#EF4444',
};

export default function InspectionPreviewScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors, isDark } = useThemeContext();
  const params = useLocalSearchParams<{ url?: string }>();
  const url = (params.url || '').toString();

  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const styles = makeStyles(colors, isDark);

  useEffect(() => {
    if (!url) {
      setError('NO_URL');
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .post('/inspection/report/generate', { url })
      .then((r) => { if (alive) setData(r.data); })
      .catch((e) => {
        if (!alive) return;
        const msg = e?.response?.data?.message || e?.message || 'Failed to analyze listing';
        setError(typeof msg === 'string' ? msg : 'Failed to analyze listing');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [url]);

  const goFullInspection = () => {
    router.push({ pathname: '/auto-request/create', params: { type: 'inspection' } });
  };
  const goCompare = () => {
    router.push({ pathname: '/auto-request/create', params: { type: 'selection' } });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']} testID="inspection-preview">
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          testID="inspection-preview-back"
        >
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text variant="h3" weight="800" style={styles.headerTitle}>
          {t('inspection_preview.header') || 'Risk preview'}
        </Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <View style={styles.loadingBox} testID="inspection-preview-loading">
          <ActivityIndicator size="large" color={colors.primary} />
          <Text variant="body" tone="muted" style={{ marginTop: 12 }}>
            {t('inspection_preview.loading') || 'Analyzing the listing…'}
          </Text>
        </View>
      ) : error || !data ? (
        <ErrorBlock
          colors={colors}
          message={
            error === 'NO_URL'
              ? t('inspection_preview.err_no_url') || 'No listing URL was provided'
              : error || (t('common.error') || 'Error')
          }
          onRetry={() => router.back()}
          retryLabel={t('common.go_back') || 'Go back'}
        />
      ) : (
        <>
          <ReportBody
            data={data}
            colors={colors}
            isDark={isDark}
            onFullInspection={goFullInspection}
            onCompare={goCompare}
          />
          <StickyCta
            colors={colors}
            isDark={isDark}
            fee={data.pricing?.inspectionFee ?? 149}
            onFullInspection={goFullInspection}
            onCompare={goCompare}
          />
        </>
      )}
    </SafeAreaView>
  );
}

// ───────── Body ─────────
function ReportBody({
  data, colors, isDark, onFullInspection, onCompare,
}: {
  data: ApiResp; colors: any; isDark: boolean;
  onFullInspection: () => void; onCompare: () => void;
}) {
  const { t } = useTranslation();
  const styles = makeStyles(colors, isDark);
  const { report, car, canonical, pricing } = data;
  const tint = RISK_TINT[report.risk];

  // Localized risk + verdict labels (override DE-only backend strings).
  const riskLabel =
    report.risk === 'low'    ? (i18n.t('inspection_preview.risk_low')    || 'Low risk') :
    report.risk === 'medium' ? (i18n.t('inspection_preview.risk_medium') || 'Medium risk') :
                               (i18n.t('inspection_preview.risk_high')   || 'High risk');
  const verdictLabel =
    report.risk === 'low'    ? (i18n.t('inspection_preview.verdict_buy')      || 'Looks solid · inspect to confirm') :
    report.risk === 'medium' ? (i18n.t('inspection_preview.verdict_negotiate')|| 'Buy with discount · negotiate') :
                               (i18n.t('inspection_preview.verdict_avoid')    || 'Risky · do NOT buy without inspection');

  const fmtEur = (v: number) => `€${Math.round(v).toLocaleString('de-DE')}`;
  const fmt = (v: number) => v.toLocaleString('de-DE');

  // ── 11D-β: canonical-first reads ─────────────────────────────────
  // Every parser-extracted vehicle attribute now reads from the
  // canonical envelope. `hasPreviewSignal()` is the single gate for
  // whether we render the car preview card with extracted details
  // vs a minimal "link accepted" placeholder. No more `if (car.image)`
  // or `if (car.price)` heuristics — the rule lives once, in shared.
  const previewSignal = canonical ? hasPreviewSignal(canonical) : false;
  const carTitle =
    canonical?.title ||
    [canonical?.make, canonical?.model].filter(Boolean).join(' ') ||
    'Vehicle';
  const carImage = canonical?.images?.[0] ?? null;
  const hasImage = previewSignal && typeof carImage === 'string' && /^https?:\/\//i.test(carImage);
  const carPrice = canonical?.priceEur ?? null;
  const carMileage = canonical?.mileageKm ?? null;
  const carYear = canonical?.year ?? null;
  const carFuel = canonical?.fuel ?? null;
  const carSource = canonical?.source && canonical.source !== 'unknown' ? canonical.source : null;
  // `marketAvg` is a downstream build_report output, NOT a parser
  // substrate field. It legitimately stays on the legacy `car.*`
  // mirror — see 11D-β preamble at top of file.
  const carMarketAvg = car?.marketAvg ?? null;

  // Top 3 problems by severity (high → medium → low)
  const sevRank = { high: 3, medium: 2, low: 1 };
  const topReasons = [...(report.reasons || [])]
    .sort((a, b) => (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0))
    .slice(0, 3);

  // Negotiation hint: if price is above market or decision is negotiate.
  let negotiationHint: string | null = null;
  if (carPrice && carMarketAvg && carMarketAvg > 0) {
    const delta = carPrice - carMarketAvg;
    if (delta > 500) {
      negotiationHint = `${t('inspection_preview.negotiate_save') || 'Negotiate down by'} ${fmtEur(delta)}`;
    } else if (report.risk === 'medium') {
      // Use cost estimate midpoint as bargaining anchor
      const mid = Math.round((report.costEstimate[0] + report.costEstimate[1]) / 2);
      negotiationHint = `${t('inspection_preview.negotiate_repair') || 'Bargain ~'} ${fmtEur(mid)} ${t('inspection_preview.negotiate_for_repairs') || 'for upcoming repairs'}`;
    }
  }

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
      testID="inspection-preview-body"
    >
      {/* ═══ HERO ═══ */}
      <View style={[styles.heroCard, { backgroundColor: tint.bg, borderColor: tint.color }]}>
        <View style={styles.heroTopRow}>
          <View style={[styles.riskPill, { backgroundColor: tint.color }]} testID="inspection-preview-risk">
            <Ionicons
              name={report.risk === 'low' ? 'shield-checkmark' : report.risk === 'high' ? 'warning' : 'alert-circle'}
              size={14}
              color="#000"
            />
            <Text variant="caption" weight="900" style={styles.riskPillText}>
              {riskLabel.toUpperCase()}
            </Text>
          </View>
          <View style={styles.confBadge}>
            <Ionicons name="analytics" size={12} color={colors.textSecondary} />
            <Text variant="caption" tone="muted" weight="700" style={{ marginLeft: 4 }}>
              {t('inspection_preview.based_on') || 'Based on'} {fmt(report.similarVehiclesCount)}+ {t('inspection_preview.vehicles') || 'vehicles'}
            </Text>
          </View>
        </View>

        <Text variant="caption" weight="700" style={[styles.heroQuestion, { color: colors.textSecondary }]}>
          {t('inspection_preview.question') || 'Should you buy this car?'}
        </Text>
        <Text variant="h1" weight="900" style={[styles.verdictText, { color: tint.color }]} testID="inspection-preview-verdict">
          {verdictLabel}
        </Text>

        <View style={styles.scoreRow}>
          <Text variant="h1" weight="900" style={{ color: tint.color, fontSize: 56, lineHeight: 60 }} testID="inspection-preview-score">
            {report.score.toFixed(1)}
          </Text>
          <View style={{ marginLeft: 8 }}>
            <Text variant="caption" tone="muted" weight="700">{t('inspection_preview.score_outof') || 'out of 10'}</Text>
            <View style={[styles.scoreBarBg, { backgroundColor: 'rgba(0,0,0,0.12)' }]}>
              <View style={[styles.scoreBarFill, { width: `${(report.score / 10) * 100}%`, backgroundColor: tint.color }]} />
            </View>
          </View>
        </View>

        <Text variant="body" weight="600" style={[styles.heroSummary, { color: colors.text }]}>
          {report.summary}
        </Text>

        {negotiationHint && (
          <View style={[styles.negotiationBox, { borderColor: tint.color }]} testID="inspection-preview-negotiation">
            <Ionicons name="cash-outline" size={16} color={tint.color} />
            <Text variant="caption" weight="800" style={{ marginLeft: 6, color: tint.color }}>
              {negotiationHint}
            </Text>
          </View>
        )}
      </View>

      {/* ═══ CAR PREVIEW ═══ */}
      <View style={[styles.carCard, { backgroundColor: colors.card, borderColor: colors.border }]} testID="inspection-preview-car">
        {hasImage ? (
          <Image source={{ uri: carImage! }} style={styles.carImage} contentFit="cover" />
        ) : (
          <View style={[styles.carImagePlaceholder, { backgroundColor: 'rgba(245,184,0,0.10)' }]}>
            <Ionicons name="car-sport" size={40} color={colors.primary} />
          </View>
        )}
        <View style={styles.carBody}>
          <Text variant="h3" weight="800" numberOfLines={2}>{carTitle}</Text>
          <View style={styles.carMetaRow}>
            {carYear && <CarMeta icon="calendar-outline" text={String(carYear)} colors={colors} />}
            {carMileage && <CarMeta icon="speedometer-outline" text={`${fmt(carMileage)} km`} colors={colors} />}
            {carFuel && <CarMeta icon="flash-outline" text={carFuel.toUpperCase()} colors={colors} />}
          </View>
          <View style={styles.carPriceRow}>
            <Text variant="h2" weight="900" style={{ color: colors.text }}>
              {carPrice ? fmtEur(carPrice) : '—'}
            </Text>
            {carMarketAvg ? (
              <Text variant="caption" tone="muted" weight="700">
                {t('inspection_preview.market_avg') || 'Market avg'}: {fmtEur(carMarketAvg)}
              </Text>
            ) : null}
          </View>
          {carSource && (
            <View style={styles.sourceRow}>
              <Ionicons name="link-outline" size={12} color={colors.textSecondary} />
              <Text variant="caption" tone="muted" weight="600" style={{ marginLeft: 4 }}>
                {t('inspection_preview.source') || 'Source'}: {carSource}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* ═══ TOP PROBLEMS ═══ */}
      {topReasons.length > 0 && (
        <View style={styles.section} testID="inspection-preview-top-problems">
          <Text variant="caption" weight="800" tone="brand" style={styles.sectionLabel}>
            {(t('inspection_preview.top_problems') || `Top ${topReasons.length} risk indicators`).toUpperCase()}
          </Text>
          <View style={[styles.problemsBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {topReasons.map((r, i) => (
              <View
                key={r.code + i}
                style={[styles.problemRow, i < topReasons.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}
                testID={`inspection-preview-problem-${i}`}
              >
                <View style={[styles.sevDot, { backgroundColor: SEV_TINT[r.severity] }]} />
                <View style={{ flex: 1 }}>
                  <Text variant="body" weight="700">{r.label}</Text>
                  <Text variant="caption" tone="muted" weight="500" style={{ marginTop: 3, lineHeight: 18 }}>
                    {r.detail}
                  </Text>
                </View>
                <View style={[styles.sevBadge, { backgroundColor: SEV_TINT[r.severity] }]}>
                  <Text variant="caption" weight="900" style={styles.sevBadgeText}>
                    {r.severity.toUpperCase()}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* ═══ COST ESTIMATE ═══ */}
      <View style={styles.section}>
        <Text variant="caption" weight="800" tone="brand" style={styles.sectionLabel}>
          {(t('inspection_preview.repair_estimate') || 'Possible 12-month repair exposure').toUpperCase()}
        </Text>
        <View style={[styles.estimateBox, { backgroundColor: colors.card, borderColor: colors.primary }]} testID="inspection-preview-estimate">
          <Text variant="h2" weight="900" style={{ color: colors.primary, letterSpacing: 0.4 }}>
            {fmtEur(report.costEstimate[0])} – {fmtEur(report.costEstimate[1])}
          </Text>
          <Text variant="caption" tone="muted" weight="600" style={{ marginTop: 6, lineHeight: 18 }}>
            {report.roiHint}
          </Text>
        </View>
      </View>

      <View style={{ height: 12 }} />
    </ScrollView>
  );
}

// ───────── CTA bar (sticky) ─────────
function StickyCta({
  colors, isDark, fee, onFullInspection, onCompare,
}: { colors: any; isDark: boolean; fee: number; onFullInspection: () => void; onCompare: () => void }) {
  const { t } = useTranslation();
  const styles = makeStyles(colors, isDark);
  return (
    <View style={[styles.ctaBar, { backgroundColor: colors.background, borderTopColor: colors.border }]}>
      <TouchableOpacity
        style={[styles.ctaPrimary, { backgroundColor: colors.primary }]}
        onPress={onFullInspection}
        activeOpacity={0.85}
        testID="inspection-preview-cta-full"
      >
        <Ionicons name="shield-checkmark" size={18} color="#000" />
        <Text variant="body" weight="900" style={{ color: '#000', marginLeft: 8 }}>
          {t('inspection_preview.cta_full') || 'Full inspection'} · €{fee}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.ctaSecondary, { borderColor: colors.border }]}
        onPress={onCompare}
        activeOpacity={0.85}
        testID="inspection-preview-cta-compare"
      >
        <Ionicons name="git-compare-outline" size={16} color={colors.text} />
        <Text variant="caption" weight="700" style={{ marginLeft: 6, color: colors.text }}>
          {t('inspection_preview.cta_compare') || 'Find better options'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function CarMeta({ icon, text, colors }: { icon: any; text: string; colors: any }) {
  return (
    <View style={cardMetaStyles.chip}>
      <Ionicons name={icon} size={12} color={colors.textSecondary} />
      <Text variant="caption" tone="muted" weight="700" style={{ marginLeft: 4 }}>{text}</Text>
    </View>
  );
}
const cardMetaStyles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(127,127,127,0.10)',
    marginRight: 6,
    marginTop: 6,
  },
});

function ErrorBlock({
  colors, message, onRetry, retryLabel,
}: { colors: any; message: string; onRetry: () => void; retryLabel: string }) {
  return (
    <View style={errorStyles.box}>
      <View style={[errorStyles.icon, { backgroundColor: colors.card }]}>
        <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
      </View>
      <Text variant="h3" weight="800" style={{ marginTop: 16 }}>{message}</Text>
      <TouchableOpacity
        style={[errorStyles.btn, { backgroundColor: colors.primary }]}
        onPress={onRetry}
        testID="inspection-preview-retry"
      >
        <Text variant="body" weight="800" style={{ color: '#000' }}>{retryLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}
const errorStyles = StyleSheet.create({
  box: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  icon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btn: { marginTop: 24, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 14 },
});

function makeStyles(colors: any, isDark: boolean) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerTitle: { flex: 1, textAlign: 'center' },

    loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },

    scroll: { padding: 16, paddingBottom: 32 },

    // HERO
    heroCard: {
      borderRadius: 20,
      borderWidth: 1.5,
      padding: 18,
      gap: 8,
      ...Platform.select({
        ios: { shadowColor: '#000', shadowOpacity: isDark ? 0.4 : 0.08, shadowRadius: 20, shadowOffset: { width: 0, height: 8 } },
        android: { elevation: 6 },
        default: {},
      }),
    },
    heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    riskPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
    },
    riskPillText: { color: '#000', letterSpacing: 0.7 },
    confBadge: { flexDirection: 'row', alignItems: 'center' },
    heroQuestion: { letterSpacing: 0.5, marginTop: 6 },
    verdictText: { fontSize: 26, lineHeight: 32, marginTop: 2 },
    scoreRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
    scoreBarBg: {
      width: 140,
      height: 8,
      borderRadius: 4,
      marginTop: 4,
      overflow: 'hidden',
    },
    scoreBarFill: { height: '100%', borderRadius: 4 },
    heroSummary: { marginTop: 10, lineHeight: 22 },
    negotiationBox: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 10,
      borderWidth: 1.5,
      marginTop: 10,
    },

    // CAR
    carCard: {
      marginTop: 14,
      borderRadius: 18,
      borderWidth: 1,
      overflow: 'hidden',
    },
    carImage: { width: '100%', height: 180 },
    carImagePlaceholder: {
      width: '100%',
      height: 130,
      alignItems: 'center',
      justifyContent: 'center',
    },
    carBody: { padding: 14, gap: 4 },
    carMetaRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
    carPriceRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      marginTop: 8,
      gap: 8,
    },
    sourceRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },

    // SECTIONS
    section: { marginTop: 16 },
    sectionLabel: { letterSpacing: 1.2, marginBottom: 8 },

    // PROBLEMS
    problemsBox: { borderRadius: 14, borderWidth: 1, padding: 4 },
    problemRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    sevDot: { width: 8, height: 8, borderRadius: 4, marginTop: 7 },
    sevBadge: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, marginLeft: 4 },
    sevBadgeText: { color: '#000', letterSpacing: 0.5, fontSize: 10 },

    // ESTIMATE
    estimateBox: {
      borderRadius: 14,
      borderWidth: 1.5,
      padding: 16,
    },

    // CTA
    ctaBar: {
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 12,
      borderTopWidth: 1,
    },
    ctaPrimary: {
      flex: 2,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 14,
      borderRadius: 14,
    },
    ctaSecondary: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 14,
      borderRadius: 14,
      borderWidth: 1,
    },
  });
}

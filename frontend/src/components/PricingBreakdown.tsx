/**
 * PricingBreakdown — line-item display of a frozen inspection quote.
 *
 * Pricing-v2C contract:
 *   • This component is DISPLAY-ONLY. It must NEVER recompute pricing.
 *   • It reads frozen fields from the backend projection verbatim:
 *       - projection.explanation[]    → line items
 *       - projection.customerTotal    → total to charge
 *       - projection.digest           → one-line summary
 *       - projection.densitySnapshot  → for the coverage chip (display-only)
 *       - projection.manualReview     → toggles the availability notice
 *   • Customer-facing copy is sanitised: no "scarce", no "surge",
 *     no "demand", no "low supply" framing. See DENSITY_LABEL below.
 *
 * Backward compatibility:
 *   • v1 quotes (no explanation/densitySnapshot) still render correctly
 *     via the legacy two-line path (base + distance surcharge). v1 quotes
 *     are frozen forever — we render whatever they froze.
 *
 * Props:
 *   projection             — raw response from /api/pricing/* endpoints
 *   loading                — show a 1-line skeleton while waiting
 *   showManualReviewBanner — gate the "inspector will confirm" notice
 *   inspectorView          — render the inspector-only travel-compensation row
 */
import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../context/ThemeContext';

// ─── Types ─────────────────────────────────────────────────────────────

export interface PricingExplanationLine {
  label: string;
  amount: number;
}

export interface DensitySnapshot {
  cityId?: string | null;
  countryCode?: string | null;
  providers: number;
  partners?: number;
  coverageRatio?: number;
  cityDensity?: 'high' | 'medium' | 'low' | 'scarce';
  countryDensity?: 'high' | 'medium' | 'low' | 'scarce';
  effectiveDensity: 'high' | 'medium' | 'low' | 'scarce';
  densityMultiplier?: number;
  manualReview?: boolean;
  reason?: string;
}

export interface PricingProjection {
  pricingVersion: string;
  basePrice: number;
  currency: string;
  includedKm: number;
  distanceKm: number;
  extraKm: number;
  remoteTier: 'included' | 'soft_remote' | 'standard_remote' | 'far_remote';
  distanceRate: number;
  distanceSurcharge: number;
  manualReview: boolean;
  customerTotal: number;
  inspectorDistancePayout?: number;
  platformDistanceFee?: number;
  status?: 'pending' | 'confirmed';
  confirmedAt?: string;
  confirmedBy?: string;

  // v2 additions — frozen at save time, byte-identical thereafter.
  explanation?: PricingExplanationLine[];
  densitySnapshot?: DensitySnapshot | null;
  digest?: string;
  densityMultiplier?: number;
}

interface Props {
  projection: PricingProjection | null;
  loading?: boolean;
  showManualReviewBanner?: boolean;
  inspectorView?: boolean;
}

// ─── Customer-safe density copy ────────────────────────────────────────
// Internal terms ("scarce", "demand", "surge") never reach the customer.
// We deliberately keep this table local to the component — the backend
// owns the data, the frontend owns the *display* phrasing.
const DENSITY_I18N_KEY: Record<DensitySnapshot['effectiveDensity'], string> = {
  high:   'pricing.density.high',
  medium: 'pricing.density.medium',
  low:    'pricing.density.low',
  scarce: 'pricing.density.scarce',
};

// Color token per coverage level. Calm, non-alarming hues — no red, no
// "urgency" framing. `scarce` uses a neutral amber, not a danger red.
const DENSITY_COLOR: Record<DensitySnapshot['effectiveDensity'], string> = {
  high:   '#10B981', // calm green
  medium: '#3B82F6', // neutral blue
  low:    '#F59E0B', // amber, advisory
  scarce: '#9CA3AF', // grey — "needs confirmation", not "scarce"
};

// ─── Helpers ───────────────────────────────────────────────────────────

function formatMoney(amount: number, currency: string): string {
  const symbol = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency;
  const rounded = Math.round(amount);
  return currency === 'EUR' || currency === 'USD'
    ? `${symbol}${rounded}`
    : `${rounded} ${symbol}`;
}

// ─── Component ─────────────────────────────────────────────────────────

export default function PricingBreakdown({
  projection,
  loading,
  showManualReviewBanner = true,
  inspectorView = false,
}: Props) {
  const { colors } = useThemeContext();
  const { t } = useTranslation();

  if (loading) {
    return (
      <View
        testID="pricing-breakdown-loading"
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  }
  if (!projection) return null;

  const isConfirmed = projection.status === 'confirmed';
  const hasExplanation = Array.isArray(projection.explanation) && projection.explanation.length > 0;
  const density = projection.densitySnapshot ?? null;
  const densityTier = density?.effectiveDensity;

  return (
    <View
      testID="pricing-breakdown"
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      {/* Density chip — customer-safe phrasing, display-only.
          Hidden when the backend didn't ship a snapshot (v1 quotes). */}
      {densityTier ? (
        <View
          testID={`pricing-density-chip-${densityTier}`}
          style={[
            styles.densityChip,
            { borderColor: DENSITY_COLOR[densityTier], backgroundColor: `${DENSITY_COLOR[densityTier]}1A` },
          ]}
        >
          <Ionicons
            name="people-outline"
            size={13}
            color={DENSITY_COLOR[densityTier]}
            testID="pricing-density-chip-icon"
          />
          <Text
            style={[styles.densityChipText, { color: DENSITY_COLOR[densityTier] }]}
            testID="pricing-density-chip-label"
            numberOfLines={1}
          >
            {t('pricing.density.label')}: {t(DENSITY_I18N_KEY[densityTier])}
          </Text>
        </View>
      ) : null}

      {/* Frozen explanation — render whatever the backend already
          decided. We never compute amounts here.
          Falls back to legacy v1 two-row layout when explanation
          array is missing (historical v1 quotes). */}
      {hasExplanation ? (
        <View testID="pricing-explanation">
          {projection.explanation!.map((line, idx) => (
            <React.Fragment key={`${line.label}-${idx}`}>
              {idx > 0 ? <View style={[styles.divider, { backgroundColor: colors.border }]} /> : null}
              <View style={styles.row}>
                <Text
                  style={[styles.label, { color: colors.text }]}
                  testID={`pricing-explanation-label-${idx}`}
                  numberOfLines={2}
                >
                  {line.label}
                </Text>
                <Text
                  style={[styles.value, { color: colors.text }]}
                  testID={`pricing-explanation-value-${idx}`}
                >
                  {formatMoney(line.amount, projection.currency)}
                </Text>
              </View>
            </React.Fragment>
          ))}
        </View>
      ) : (
        <LegacyV1Breakdown projection={projection} colors={colors} t={t} />
      )}

      {/* Total — read from `customerTotal` verbatim, never summed on
          the client (server is the source of truth for rounding). */}
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      <View style={styles.row}>
        <Text style={[styles.totalLabel, { color: colors.text }]} testID="pricing-total-label">
          {t('pricing.total_label')}
        </Text>
        <Text style={[styles.totalValue, { color: colors.primary }]} testID="pricing-total-value">
          {formatMoney(projection.customerTotal, projection.currency)}
        </Text>
      </View>

      {/* Inspector-only row — payout split. Customer view never has the
          field (backend strips it), so the row simply doesn't render
          on customer screens. */}
      {inspectorView && typeof projection.inspectorDistancePayout === 'number' && projection.inspectorDistancePayout > 0 ? (
        <View
          testID="pricing-inspector-payout"
          style={[styles.inspectorBox, { backgroundColor: (colors as any).successBg || '#0e2a1a', borderColor: colors.success }]}
        >
          <Ionicons name="wallet" size={18} color={colors.success} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.inspectorLabel, { color: colors.text }]} numberOfLines={1}>
              {t('pricing.inspector_payout_label')}
            </Text>
            <Text style={[styles.inspectorSub, { color: colors.textSecondary }]} numberOfLines={2}>
              {t('pricing.inspector_payout_sub', { km: Math.round(projection.distanceKm) })}
            </Text>
          </View>
          <Text style={[styles.inspectorValue, { color: colors.success }]} testID="pricing-inspector-payout-value">
            {formatMoney(projection.inspectorDistancePayout, projection.currency)}
          </Text>
        </View>
      ) : null}

      {/* Lock badge + freeze rationale — only on confirmed quotes.
          Pricing-v2C: the rationale line below the lock makes the freeze
          contract explicit to the customer in plain language. */}
      {isConfirmed ? (
        <View testID="pricing-status-confirmed" style={[styles.statusBox, { borderColor: colors.border }]}>
          <View style={styles.statusRow}>
            <Ionicons name="lock-closed" size={14} color={colors.textSecondary} />
            <Text style={[styles.statusText, { color: colors.textSecondary }]} numberOfLines={1}>
              {t('pricing.status_confirmed')}
            </Text>
          </View>
          <Text
            style={[styles.statusNotice, { color: colors.textSecondary }]}
            testID="pricing-confirm-notice"
          >
            {t('pricing.confirm_notice')}
          </Text>
        </View>
      ) : null}

      {/* Manual-review notice — Pricing-v2C copy.
          Triggered by `projection.manualReview` (not by tier), so that
          both far_remote v1 quotes AND scarce-density v2 quotes route
          through the same friendly message. */}
      {showManualReviewBanner && projection.manualReview ? (
        <View
          testID="pricing-manual-review-banner"
          style={[styles.banner, { backgroundColor: (colors as any).warningBg || '#3a2a08', borderColor: colors.warning }]}
        >
          <Ionicons name="information-circle" size={18} color={colors.warning} />
          <Text style={[styles.bannerText, { color: colors.text }]} testID="pricing-manual-review-text">
            {t('pricing.manual_review_v2')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ─── Legacy v1 fallback ────────────────────────────────────────────────
// For frozen v1 quotes that pre-date the explanation array. We render
// exactly two rows (base + remote) — no chip, no density math. v1 quotes
// are immutable and don't grow new fields.
function LegacyV1Breakdown({
  projection,
  colors,
  t,
}: {
  projection: PricingProjection;
  colors: any;
  t: (key: string, opts?: any) => string;
}) {
  const hasSurcharge = projection.distanceSurcharge > 0;
  return (
    <View testID="pricing-explanation-v1">
      <View style={styles.row}>
        <Text style={[styles.label, { color: colors.text }]} testID="pricing-base-label">
          {t('pricing.base_label')}
        </Text>
        <Text style={[styles.value, { color: colors.text }]} testID="pricing-base-value">
          {formatMoney(projection.basePrice, projection.currency)}
        </Text>
      </View>
      <Text style={[styles.subLabel, { color: colors.textSecondary }]}>
        {t('pricing.included_km', { km: projection.includedKm })}
      </Text>
      {hasSurcharge ? (
        <>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.row}>
            <Text style={[styles.label, { color: colors.text }]} testID="pricing-surcharge-label">
              {t('pricing.remote_label')}
            </Text>
            <Text style={[styles.value, { color: colors.text }]} testID="pricing-surcharge-value">
              {formatMoney(projection.distanceSurcharge, projection.currency)}
            </Text>
          </View>
          <Text style={[styles.subLabel, { color: colors.textSecondary }]}>
            {t('pricing.remote_sub', {
              total: Math.round(projection.distanceKm),
              extra: Math.round(projection.extraKm),
            })}
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  label: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  value: { fontSize: 14, fontWeight: '700' },
  subLabel: { fontSize: 12, marginTop: 2 },

  divider: { height: StyleSheet.hairlineWidth, marginVertical: 10 },

  totalLabel: { fontSize: 15, fontWeight: '700' },
  totalValue: { fontSize: 18, fontWeight: '800', letterSpacing: 0.2 },

  // Density chip — Pricing-v2C
  densityChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    marginBottom: 10,
  },
  densityChipText: { fontSize: 11.5, fontWeight: '700', letterSpacing: 0.2 },

  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 14,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  bannerText: { flex: 1, fontSize: 12.5, lineHeight: 18 },

  inspectorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginTop: 14, padding: 12,
    borderRadius: 10, borderWidth: 1,
  },
  inspectorLabel: { fontSize: 14, fontWeight: '700' },
  inspectorSub: { fontSize: 11.5, marginTop: 2 },
  inspectorValue: { fontSize: 17, fontWeight: '800' },

  statusBox: {
    marginTop: 12, paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  statusRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  statusText: { fontSize: 11.5, fontWeight: '700' },
  statusNotice: { fontSize: 11.5, lineHeight: 16, marginTop: 4 },
});

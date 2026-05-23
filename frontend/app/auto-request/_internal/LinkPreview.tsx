/**
 * auto-request — Link preview card (P1.2).
 *
 * Reads the canonical envelope from `/api/parse/car-link` and renders:
 *   - loading skeleton (debounced 700ms)
 *   - parsed card (image · title · meta · price · market delta · CTA)
 *   - soft/hard failure fallback (never blocks the form)
 *
 * Step 11B contract: canonical fields under `response.canonical`. Legacy
 * mirror (price/mileage/marketAvg at the top level) is read transitionally
 * until Step 11D drops it.
 */
import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { classifyParseFailure, hasPreviewSignal } from '@platform/domain/parsers/canonical';
import { lpStyles } from './lpStyles';
import { MetaChip } from './primitives';
import { PARSER_SOURCE_LABEL } from './constants';
import type { ColorsLike } from './types';
import i18n from '../../../src/i18n';

interface Props {
  colors: ColorsLike;
  loading: boolean;
  preview: any | null;
}

export function LinkPreview({ colors, loading, preview }: Props) {
  const { t } = useTranslation();
  const router = useRouter();

  if (loading) {
    return (
      <View testID="link-preview-loading" style={[lpStyles.box, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={[lpStyles.loadingText, { color: colors.textSecondary }]}>
          {t('create.link_analyzing') || 'Analyzing car…'}
        </Text>
      </View>
    );
  }

  if (!preview) return null;

  const canonical = (preview && typeof preview === 'object' ? preview.canonical : null) || {};
  const failure = classifyParseFailure(canonical.degradedReason ?? null, {
    sourceRecognised: !!canonical.source && canonical.source !== 'generic',
  });
  const previewable = hasPreviewSignal({
    ok: !!canonical.ok,
    parseCompleteness: canonical.parseCompleteness ?? null,
    degradedReason: canonical.degradedReason ?? null,
  });

  // Failure fallback — soft (most cases) keeps green tint and reassures the user
  // that the inspector will still open the link; hard tint signals user should
  // try one of the supported sites.
  if (!previewable) {
    const isSoft = failure !== 'hard';
    const title = isSoft
      ? (i18n.t('create.link_parse_unavailable') || 'Preview unavailable')
      : (i18n.t('create.link_parse_failed') || 'Unsupported website');
    const sub = isSoft
      ? (i18n.t('create.link_parse_unavailable_sub') || 'The site blocks auto-fetch — link accepted, the inspector will open it on-site')
      : (i18n.t('create.link_parse_failed_sub') || 'Try mobile.de, AutoScout24 or Kleinanzeigen');
    const tint = isSoft ? '#22C55E' : colors.primary;
    const bg = isSoft ? 'rgba(34,197,94,0.12)' : 'rgba(245,184,0,0.15)';
    return (
      <View testID="link-preview-failed" style={[lpStyles.failedBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[lpStyles.failedIconBox, { backgroundColor: bg }]}>
          <Ionicons name={isSoft ? 'shield-checkmark' : 'alert-circle-outline'} size={18} color={tint} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[lpStyles.failedTitle, { color: colors.text }]}>{title}</Text>
          <Text style={[lpStyles.failedSub, { color: colors.textSecondary }]}>{sub}</Text>
        </View>
      </View>
    );
  }

  // Display strings — canonical-only keys (priceEur / mileageKm / images / location).
  // marketAvg lives in the legacy mirror until Step 11D.
  const cTitle =
    canonical.title ||
    [canonical.make, canonical.model].filter(Boolean).join(' ') ||
    'Vehicle';
  const fmt = (n: number) => Number(n).toLocaleString('de-DE');
  const cPriceEur: number | null = typeof canonical.priceEur === 'number' ? canonical.priceEur : null;
  const cMileageKm: number | null = typeof canonical.mileageKm === 'number' ? canonical.mileageKm : null;
  const cImages: string[] = Array.isArray(canonical.images) ? canonical.images : [];
  const priceStr = cPriceEur ? `€${fmt(cPriceEur)}` : '—';
  const yearStr = canonical.year ? String(canonical.year) : null;
  const kmStr = cMileageKm ? `${fmt(cMileageKm)} km` : null;
  const fuelStr = canonical.fuel ? String(canonical.fuel).toUpperCase() : null;
  const cityStr = canonical.location || null;
  const sourceTxt = canonical.source ? (PARSER_SOURCE_LABEL[canonical.source] || canonical.source) : 'dealer';

  // Market delta — transitional legacy read.
  let deltaTxt: string | null = null;
  let deltaColor = colors.textSecondary;
  const legacyMarketAvg: number | null = typeof preview.marketAvg === 'number' ? preview.marketAvg : null;
  if (cPriceEur && legacyMarketAvg && legacyMarketAvg > 0) {
    const pct = Math.round((1 - cPriceEur / legacyMarketAvg) * 100);
    if (pct >= 5) {
      deltaTxt = `${pct}% ${t('create.preview_below_market') || 'below market'}`;
      deltaColor = pct >= 20 ? '#EF4444' : '#22C55E';
    } else if (pct <= -10) {
      deltaTxt = `${Math.abs(pct)}% ${t('create.preview_above_market') || 'above market'}`;
      deltaColor = '#FFB020';
    }
  }

  const heroImage = cImages[0];
  const hasImage = typeof heroImage === 'string' && /^https?:\/\//i.test(heroImage);

  const goPreview = () => {
    if (canonical.sourceUrl) {
      router.push({ pathname: '/inspection-preview' as any, params: { url: canonical.sourceUrl } });
    }
  };

  return (
    <TouchableOpacity
      testID="link-preview-card"
      activeOpacity={0.85}
      onPress={goPreview}
      style={[lpStyles.card, { backgroundColor: colors.card, borderColor: colors.primary }]}
    >
      {hasImage ? (
        <Image source={{ uri: heroImage }} style={lpStyles.image} contentFit="cover" transition={200} />
      ) : (
        <View style={[lpStyles.imagePlaceholder, { backgroundColor: 'rgba(245,184,0,0.10)' }]}>
          <Ionicons name="car-sport" size={36} color={colors.primary} />
        </View>
      )}

      <View style={lpStyles.body}>
        <View style={lpStyles.topRow}>
          <View style={[lpStyles.checkBadge, { backgroundColor: 'rgba(34,197,94,0.15)' }]}>
            <Ionicons name="checkmark-circle" size={14} color="#22C55E" />
            <Text style={[lpStyles.checkBadgeText, { color: '#22C55E' }]}>
              {t('create.link_detected') || '✓ Car recognized'}
            </Text>
          </View>
          <Text style={[lpStyles.sourceTxt, { color: colors.textSecondary }]} numberOfLines={1}>
            {sourceTxt}
          </Text>
        </View>

        <Text testID="link-preview-title" style={[lpStyles.title, { color: colors.text }]} numberOfLines={2}>
          {cTitle}
        </Text>

        <View style={lpStyles.metaRow}>
          {yearStr && <MetaChip icon="calendar-outline" text={yearStr} colors={colors} />}
          {kmStr && <MetaChip icon="speedometer-outline" text={kmStr} colors={colors} />}
          {fuelStr && <MetaChip icon="flash-outline" text={fuelStr} colors={colors} />}
          {cityStr && <MetaChip icon="location-outline" text={cityStr} colors={colors} />}
        </View>

        <View style={lpStyles.priceRow}>
          <Text testID="link-preview-price" style={[lpStyles.priceTxt, { color: colors.text }]}>{priceStr}</Text>
          {deltaTxt && (
            <View style={[lpStyles.deltaPill, { borderColor: deltaColor }]}>
              <Text style={[lpStyles.deltaTxt, { color: deltaColor }]}>{deltaTxt}</Text>
            </View>
          )}
        </View>

        <View style={[lpStyles.ctaRow, { borderTopColor: colors.border }]}>
          <Ionicons name="shield-checkmark" size={14} color={colors.primary} />
          <Text style={[lpStyles.ctaTxt, { color: colors.primary }]}>
            {t('create.link_preview_cta') || 'See free risk preview →'}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

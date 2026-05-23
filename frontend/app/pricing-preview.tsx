/**
 * /pricing-preview — interactive showcase for the distance-pricing engine.
 *
 * Lets ANY admin / marketing / curious user see live how the price changes
 * with distance. NOT a public booking entry — just an explainer screen.
 * Hooked up to GET /api/pricing/tiers (for the tier table) and
 * POST /api/pricing/project (for the live quote).
 *
 * The same page works as a sanity test of the deterministic calculator.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useThemeContext } from '../src/context/ThemeContext';
import PricingBreakdown from '../src/components/PricingBreakdown';
import {
  previewProjection,
  getTiers,
  type TiersResponse,
} from '../src/services/pricingProjection';
import type { PricingProjection } from '../src/components/PricingBreakdown';

const PRESETS = [80, 120, 180, 220, 300, 504];
const BASE_PRICE_DEFAULT = 199;

export default function PricingPreviewScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();

  const [basePriceInput, setBasePriceInput] = useState(String(BASE_PRICE_DEFAULT));
  const [distanceKm, setDistanceKm] = useState<number>(220);
  const [projection, setProjection] = useState<PricingProjection | null>(null);
  const [tiers, setTiers] = useState<TiersResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const basePrice = useMemo(() => {
    const v = parseInt(basePriceInput, 10);
    return isNaN(v) || v < 0 ? BASE_PRICE_DEFAULT : v;
  }, [basePriceInput]);

  // Load static tier table once.
  useEffect(() => {
    let cancelled = false;
    getTiers()
      .then((r) => { if (!cancelled) setTiers(r); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, []);

  // Recompute projection whenever inputs change (debounced via setTimeout).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      previewProjection({ basePrice, distanceKm })
        .then((p) => { if (!cancelled) setProjection(p); })
        .catch(() => { if (!cancelled) setProjection(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [basePrice, distanceKm]);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: (colors as any).divider || colors.border }]}>
        <TouchableOpacity
          testID="pp-back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {t('pricing_preview.title')}
        </Text>
        <View style={{ width: 38 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Text style={[styles.intro, { color: colors.textSecondary }]}>
          {t('pricing_preview.intro')}
        </Text>

        {/* Base price input */}
        <View style={styles.inputBlock}>
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>
            {t('pricing_preview.base_price_label')}
          </Text>
          <View style={[styles.inputRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.currencySign, { color: colors.text }]}>€</Text>
            <TextInput
              testID="pp-base-input"
              style={[styles.input, { color: colors.text }]}
              value={basePriceInput}
              onChangeText={setBasePriceInput}
              keyboardType="number-pad"
              maxLength={5}
            />
          </View>
        </View>

        {/* Distance input — text + preset chips */}
        <View style={styles.inputBlock}>
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>
            {t('pricing_preview.distance_label')}
          </Text>
          <View style={[styles.inputRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TextInput
              testID="pp-distance-input"
              style={[styles.input, { color: colors.text, flex: 1 }]}
              value={String(distanceKm)}
              onChangeText={(v) => {
                const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
                setDistanceKm(isNaN(n) ? 0 : Math.min(n, 9999));
              }}
              keyboardType="number-pad"
              maxLength={4}
            />
            <Text style={[styles.currencySign, { color: colors.textSecondary }]}>km</Text>
          </View>
          <View style={styles.chipsRow}>
            {PRESETS.map((p) => {
              const active = distanceKm === p;
              return (
                <TouchableOpacity
                  key={p}
                  testID={`pp-preset-${p}`}
                  onPress={() => setDistanceKm(p)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? colors.primary : colors.card,
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={{
                      color: active ? ((colors as any).onPrimary || '#000') : colors.text,
                      fontWeight: '700',
                      fontSize: 13,
                    }}
                  >
                    {p} km
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Live breakdown */}
        <View style={{ marginTop: 8 }}>
          <PricingBreakdown projection={projection} loading={loading && !projection} />
        </View>

        {/* Tier table */}
        {tiers ? (
          <View style={[styles.tiersCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.tiersTitle, { color: colors.text }]}>
              {t('pricing_preview.tiers_title')}
            </Text>
            <Text style={[styles.tiersSub, { color: colors.textSecondary }]}>
              {t('pricing_preview.included_line', { km: tiers.includedKm })}
            </Text>

            {tiers.tiers.map((tier) => {
              const range = tier.maxKm == null
                ? `${tier.minKm}+ km`
                : `${tier.minKm}–${tier.maxKm} km`;
              return (
                <View key={tier.tier} style={[styles.tierRow, { borderColor: colors.border }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.tierName, { color: colors.text }]}>
                      {t(`pricing.tier.${tier.tier}`)}
                    </Text>
                    <Text style={[styles.tierMeta, { color: colors.textSecondary }]}>
                      {range} · €{tier.ratePerKm.toFixed(2)}/km · min €{tier.minimumFee.toFixed(0)}
                    </Text>
                  </View>
                  {tier.manualReview ? (
                    <View style={[styles.manualBadge, { backgroundColor: (colors as any).warningBg || '#3a2a08' }]}>
                      <Text style={[styles.manualBadgeText, { color: colors.warning }]}>
                        {t('pricing_preview.manual_badge')}
                      </Text>
                    </View>
                  ) : null}
                </View>
              );
            })}

            <Text style={[styles.payoutNote, { color: colors.textSecondary }]}>
              {t('pricing_preview.payout_note', {
                inspector: Math.round(tiers.inspectorPayoutPct * 100),
                platform: Math.round(tiers.platformFeePct * 100),
              })}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },

  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  intro: { fontSize: 14, lineHeight: 20, marginBottom: 16 },

  inputBlock: { marginBottom: 16 },
  fieldLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 12, borderWidth: 1,
  },
  currencySign: { fontSize: 16, fontWeight: '700' },
  input: { fontSize: 18, fontWeight: '700', flex: 1, paddingVertical: 4 },

  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },

  tiersCard: {
    borderRadius: 14, borderWidth: 1, padding: 16, marginTop: 22,
  },
  tiersTitle: { fontSize: 15, fontWeight: '800', marginBottom: 4 },
  tiersSub: { fontSize: 13, marginBottom: 14 },
  tierRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth,
  },
  tierName: { fontSize: 14, fontWeight: '700' },
  tierMeta: { fontSize: 12, marginTop: 2 },
  manualBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  manualBadgeText: { fontSize: 11, fontWeight: '700' },
  payoutNote: { fontSize: 11.5, lineHeight: 17, marginTop: 14, fontStyle: 'italic' },
});

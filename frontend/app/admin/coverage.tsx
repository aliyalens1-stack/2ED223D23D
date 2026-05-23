/**
 * Operational Coverage — Geo-3 sprint.
 *
 * Read-only projection of marketplace topology. NOT an editable GIS.
 *
 * Invariant: frontend never computes counts. It renders
 * `/api/geo/coverage/countries` and `/api/geo/coverage/cities` as-is.
 *
 * Visual model:
 *   - Country tiles (active/inactive) with provider+partner counts
 *   - Tap a country → drill-down list of its cities, sorted by density
 *   - Density chip: empty / low / medium / high (server-computed bucket)
 *
 * No Google Maps, no clustering, no heatmaps, no polygon editing.
 * v1 is the projection surface — geographic positioning of country tiles
 * comes after we trust the projection numbers.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';

type CountryCoverage = {
  countryCode: string;
  countryName: string;
  flag: string;
  active: boolean;
  providers: number;
  partners: number;
  cities: number;
};

type CityCoverage = {
  cityId: string;
  cityName: string;
  countryCode: string;
  providers: number;
  partners: number;
  lat: number;
  lng: number;
  density: 'empty' | 'low' | 'medium' | 'high';
};

type TopologyCompleteness = {
  totalProviders: number;
  mappedProviders: number;
  percent: number;
  unmappedSamples: string[];
};

const DENSITY_COLOR: Record<CityCoverage['density'], string> = {
  empty: '#6B7280',
  low: '#F59E0B',
  medium: '#3B82F6',
  high: '#22C55E',
};

const DENSITY_LABEL: Record<CityCoverage['density'], string> = {
  empty: 'No presence',
  low: 'Low density',
  medium: 'Medium',
  high: 'High density',
};

export default function CoverageScreen() {
  const { colors } = useThemeContext();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [countries, setCountries] = useState<CountryCoverage[]>([]);
  const [cities, setCities] = useState<CityCoverage[]>([]);
  const [completeness, setCompleteness] = useState<TopologyCompleteness | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    const [coRes, ciRes, cmRes] = await Promise.all([
      api.get('/geo/coverage/countries'),
      api.get('/geo/coverage/cities?onlyWithPresence=true'),
      api.get('/geo/coverage/topology-completeness'),
    ]);
    setCountries(coRes.data || []);
    setCities(ciRes.data || []);
    setCompleteness(cmRes.data || null);
  };

  useEffect(() => {
    let alive = true;
    load().finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  };

  // Group cities by country for drill-down (no aggregation — just bucketing).
  const citiesByCountry = useMemo(() => {
    const m: Record<string, CityCoverage[]> = {};
    for (const c of cities) (m[c.countryCode] = m[c.countryCode] || []).push(c);
    return m;
  }, [cities]);

  // Headline numbers — server already computed these, here we just SUM the
  // per-country projection rows. NOT a per-record recomputation.
  const totals = useMemo(() => {
    let activeCountries = 0, providers = 0, partners = 0, citiesCount = 0;
    for (const c of countries) {
      if (c.active) activeCountries += 1;
      providers += c.providers;
      partners += c.partners;
      citiesCount += c.cities;
    }
    return { activeCountries, totalCountries: countries.length, providers, partners, citiesCount };
  }, [countries]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.brand || colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} testID="coverage-back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Coverage</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand || colors.primary} />}
      >
        {/* Headline KPIs — projection-derived, never recomputed from raw data */}
        <View style={styles.kpis}>
          <KPI label="Active markets" value={`${totals.activeCountries}/${totals.totalCountries}`} colors={colors} testID="kpi-markets" />
          <KPI label="Providers" value={String(totals.providers)} colors={colors} testID="kpi-providers" />
          <KPI label="Partners" value={String(totals.partners)} colors={colors} testID="kpi-partners" />
          <KPI label="Cities" value={String(totals.citiesCount)} colors={colors} testID="kpi-cities" />
        </View>

        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>COUNTRIES</Text>

        {completeness && (
          <View
            testID="topology-completeness-banner"
            style={[
              styles.completenessBanner,
              {
                backgroundColor: colors.card,
                borderColor: completeness.percent >= 80
                  ? (colors.brand || colors.primary) + '66'
                  : '#F59E0B66',
              },
            ]}
          >
            <Ionicons
              name={completeness.percent >= 80 ? 'shield-checkmark-outline' : 'alert-circle-outline'}
              size={16}
              color={completeness.percent >= 80 ? (colors.brand || colors.primary) : '#F59E0B'}
            />
            <Text style={[styles.completenessText, { color: colors.text }]} numberOfLines={2}>
              Topology coverage: {completeness.percent}% — {completeness.mappedProviders}/{completeness.totalProviders} providers mapped
              {completeness.percent < 100 && completeness.unmappedSamples.length > 0
                ? `. Missing: ${completeness.unmappedSamples.slice(0, 3).join(', ')}${completeness.unmappedSamples.length > 3 ? '…' : ''}`
                : ''}
            </Text>
          </View>
        )}

        {countries.map((c) => {
          const isOpen = expanded === c.countryCode;
          const list = citiesByCountry[c.countryCode] || [];
          return (
            <View key={c.countryCode}>
              <TouchableOpacity
                testID={`coverage-country-${c.countryCode}`}
                activeOpacity={0.85}
                onPress={() => setExpanded(isOpen ? null : c.countryCode)}
                style={[
                  styles.tile,
                  {
                    backgroundColor: colors.card,
                    borderColor: c.active ? (colors.brand || colors.primary) : colors.border,
                    opacity: c.active ? 1 : 0.55,
                  },
                ]}
              >
                <Text style={styles.flag}>{c.flag}</Text>
                <View style={{ flex: 1 }}>
                  <View style={styles.row}>
                    <Text style={[styles.countryName, { color: colors.text }]}>{c.countryName}</Text>
                    <View style={[
                      styles.statusPill,
                      { backgroundColor: c.active ? (colors.brand || colors.primary) + '22' : colors.border + '55' },
                    ]}>
                      <Text style={{
                        color: c.active ? (colors.brand || colors.primary) : colors.textSecondary,
                        fontSize: 11,
                        fontWeight: '700',
                      }}>
                        {c.active ? 'ACTIVE' : 'NO PRESENCE'}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.statsRow}>
                    <Text style={[styles.statText, { color: colors.textSecondary }]}>
                      {c.providers} {c.providers === 1 ? 'provider' : 'providers'}
                    </Text>
                    <Text style={[styles.dot, { color: colors.textSecondary }]}>•</Text>
                    <Text style={[styles.statText, { color: colors.textSecondary }]}>
                      {c.partners} {c.partners === 1 ? 'partner' : 'partners'}
                    </Text>
                    <Text style={[styles.dot, { color: colors.textSecondary }]}>•</Text>
                    <Text style={[styles.statText, { color: colors.textSecondary }]}>
                      {c.cities} {c.cities === 1 ? 'city' : 'cities'}
                    </Text>
                  </View>
                </View>
                <Ionicons
                  name={isOpen ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={colors.textSecondary}
                />
              </TouchableOpacity>

              {isOpen && (
                <View style={styles.citiesPanel}>
                  {list.length === 0 ? (
                    <Text style={[styles.emptyCity, { color: colors.textSecondary }]}>
                      No operational cities yet — expansion in progress.
                    </Text>
                  ) : (
                    list.map((city) => (
                      <View
                        key={city.cityId}
                        testID={`coverage-city-${city.cityId}`}
                        style={[styles.cityRow, { borderColor: colors.border }]}
                      >
                        <View style={[styles.densityDot, { backgroundColor: DENSITY_COLOR[city.density] }]} />
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.cityName, { color: colors.text }]}>{city.cityName}</Text>
                          <Text style={[styles.cityMeta, { color: colors.textSecondary }]}>
                            {city.providers} prov · {city.partners} part · {DENSITY_LABEL[city.density]}
                          </Text>
                        </View>
                        <Text style={[styles.coords, { color: colors.textSecondary }]}>
                          {city.lat.toFixed(2)}°, {city.lng.toFixed(2)}°
                        </Text>
                      </View>
                    ))
                  )}
                </View>
              )}
            </View>
          );
        })}

        <Text style={[styles.footer, { color: colors.textSecondary }]}>
          Server-side projection from `provider_topology` + `organizations`. Refresh to re-fetch.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function KPI({ label, value, colors, testID }: { label: string; value: string; colors: any; testID?: string }) {
  return (
    <View testID={testID} style={[styles.kpi, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.kpiValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.kpiLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  scroll: { padding: 16, paddingBottom: 60 },
  kpis: { flexDirection: 'row', gap: 8, marginBottom: 18 },
  kpi: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  kpiValue: { fontSize: 18, fontWeight: '800' },
  kpiLabel: { fontSize: 10, marginTop: 4, letterSpacing: 0.3, textAlign: 'center' },
  sectionTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 10, marginTop: 4 },
  completenessBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 12,
  },
  completenessText: { flex: 1, fontSize: 12, lineHeight: 16 },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 8,
  },
  flag: { fontSize: 30 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  countryName: { fontSize: 16, fontWeight: '700' },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  statText: { fontSize: 12 },
  dot: { fontSize: 12 },
  citiesPanel: { marginBottom: 12, marginTop: -2, marginLeft: 8 },
  emptyCity: { fontSize: 12, fontStyle: 'italic', padding: 12 },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderLeftWidth: 2,
    marginLeft: 4,
  },
  densityDot: { width: 10, height: 10, borderRadius: 5 },
  cityName: { fontSize: 14, fontWeight: '600' },
  cityMeta: { fontSize: 11, marginTop: 2 },
  coords: { fontSize: 10, fontVariant: ['tabular-nums'] },
  footer: { fontSize: 11, fontStyle: 'italic', textAlign: 'center', marginTop: 24, paddingHorizontal: 16, lineHeight: 16 },
});

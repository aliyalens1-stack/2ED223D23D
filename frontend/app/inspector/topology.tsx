/**
 * Inspector topology — Geo-2 sprint.
 *
 * Provider/Inspector binds their base location to a canonical country + city
 * + discrete travel radius. Single screen, single source of truth: backend
 * resolves coordinates from `/api/geo/cities/{cityId}`.
 *
 * Architectural invariant (enforced by both ends):
 *   frontend may select geography
 *   backend resolves coordinates
 *
 * The screen sends `{countryCode, cityId, travelRadiusKm}` only — never
 * lat/lng. The PUT response includes the resolved coordinates, which we
 * display as a confirmation, not as authority.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator,
  Modal, FlatList, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';

type Country = {
  code: string;
  name: string;
  flag: string;
  currency: string;
  locale: string;
  cityCount: number;
};

type CityRef = {
  id: string;
  country: string;
  name: string;
  lat: number;
  lng: number;
  timezone: string;
  currency: string;
  providersCount: number;
};

type Topology = {
  userId: string;
  baseCountry: string;
  baseCityId: string;
  baseLat: number;
  baseLng: number;
  travelRadiusKm: number;
  coverageMode: 'base_city_radius';
  updatedAt: string;
};

type Options = {
  travelRadiusKm: number[];
  defaultRadiusKm: number;
  coverageMode: string[];
};

export default function InspectorTopologyScreen() {
  const { colors } = useThemeContext();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [countries, setCountries] = useState<Country[]>([]);
  const [cities, setCities] = useState<CityRef[]>([]);
  const [options, setOptions] = useState<Options>({ travelRadiusKm: [50, 100, 150, 250], defaultRadiusKm: 100, coverageMode: ['base_city_radius'] });

  const [countryCode, setCountryCode] = useState<string>('');
  const [cityId, setCityId] = useState<string>('');
  const [radiusKm, setRadiusKm] = useState<number>(100);
  const [topo, setTopo] = useState<Topology | null>(null);

  const [countryOpen, setCountryOpen] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);

  // Bootstrap: parallel load countries, options, my topology.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [coRes, opRes, meRes] = await Promise.all([
          api.get('/geo/countries'),
          api.get('/geo/topology/options'),
          api.get('/provider/topology/me').catch(() => ({ data: null })),
        ]);
        if (!alive) return;
        const cs: Country[] = coRes.data || [];
        setCountries(cs);
        if (opRes.data) setOptions(opRes.data);
        const me: Topology | null = meRes.data || null;
        setTopo(me);
        if (me) {
          setCountryCode(me.baseCountry);
          setCityId(me.baseCityId);
          setRadiusKm(me.travelRadiusKm);
        } else if (cs.length > 0) {
          setCountryCode(cs[0].code);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // When country changes → fetch cities for that country.
  useEffect(() => {
    if (!countryCode) {
      setCities([]);
      return;
    }
    let alive = true;
    api.get(`/geo/countries/${countryCode}/cities`)
      .then((r) => { if (alive) setCities(r.data || []); })
      .catch(() => { if (alive) setCities([]); });
    return () => { alive = false; };
  }, [countryCode]);

  const currentCountry = useMemo(() => countries.find((c) => c.code === countryCode), [countries, countryCode]);
  const currentCity = useMemo(() => cities.find((c) => c.id === cityId), [cities, cityId]);

  const canSave = !!countryCode && !!cityId && !!radiusKm;

  const onSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const r = await api.put('/provider/topology/me', {
        countryCode,
        cityId,
        travelRadiusKm: radiusKm,
      });
      setTopo(r.data);
      Alert.alert('Saved', `Base set to ${currentCity?.name}, ${currentCountry?.name} · ${radiusKm} km radius`);
    } catch (e: any) {
      Alert.alert('Failed', e?.response?.data?.message || e?.message || 'Unknown error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.brand || colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} testID="topology-back">
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Service area</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={[styles.intro, { color: colors.textSecondary }]}>
            Your base location and how far you're willing to travel for inspections.
            Coordinates are resolved automatically from the city catalogue.
          </Text>

          <Text style={[styles.label, { color: colors.text }]}>Country</Text>
          <TouchableOpacity
            testID="topology-country-field"
            style={[styles.field, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => setCountryOpen(true)}
          >
            <Text style={{ fontSize: 20 }}>{currentCountry?.flag || '🌍'}</Text>
            <Text style={[styles.fieldText, { color: colors.text }]}>
              {currentCountry?.name || 'Select country'}
            </Text>
            <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
          </TouchableOpacity>

          <Text style={[styles.label, { color: colors.text, marginTop: 20 }]}>Base city</Text>
          <TouchableOpacity
            testID="topology-city-field"
            style={[styles.field, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => setCityOpen(true)}
            disabled={!countryCode}
          >
            <Ionicons name="location-outline" size={18} color={colors.textSecondary} />
            <Text style={[styles.fieldText, { color: currentCity ? colors.text : colors.textSecondary }]}>
              {currentCity?.name || (countryCode ? 'Select city' : 'Pick country first')}
            </Text>
            <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
          </TouchableOpacity>

          <Text style={[styles.label, { color: colors.text, marginTop: 20 }]}>Travel radius</Text>
          <View style={styles.radiusRow}>
            {options.travelRadiusKm.map((km) => {
              const active = radiusKm === km;
              return (
                <TouchableOpacity
                  key={km}
                  testID={`topology-radius-${km}`}
                  onPress={() => setRadiusKm(km)}
                  style={[
                    styles.radiusChip,
                    {
                      backgroundColor: active ? (colors.brand || colors.primary) : colors.card,
                      borderColor: active ? (colors.brand || colors.primary) : colors.border,
                    },
                  ]}
                >
                  <Text style={[styles.radiusChipText, { color: active ? '#0F0F10' : colors.text }]}>
                    {km} km
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {topo && (
            <View style={[styles.resolvedBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.resolvedLabel, { color: colors.textSecondary }]}>RESOLVED BY BACKEND</Text>
              <Text style={[styles.resolvedRow, { color: colors.text }]}>
                {topo.baseLat.toFixed(4)}°, {topo.baseLng.toFixed(4)}°
              </Text>
              <Text style={[styles.resolvedMeta, { color: colors.textSecondary }]}>
                {topo.coverageMode} · updated {new Date(topo.updatedAt).toLocaleString()}
              </Text>
            </View>
          )}

          <TouchableOpacity
            testID="topology-save"
            onPress={onSave}
            disabled={!canSave || saving}
            style={[
              styles.saveBtn,
              { backgroundColor: canSave && !saving ? (colors.brand || colors.primary) : colors.border },
            ]}
          >
            {saving ? (
              <ActivityIndicator color="#0F0F10" />
            ) : (
              <Text style={styles.saveBtnText}>Save service area</Text>
            )}
          </TouchableOpacity>
        </ScrollView>

        {/* Country picker */}
        <Modal visible={countryOpen} animationType="slide" transparent onRequestClose={() => setCountryOpen(false)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.modalSheet, { backgroundColor: colors.background }]}>
              <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
                <Text style={[styles.modalTitle, { color: colors.text }]}>Country</Text>
                <TouchableOpacity onPress={() => setCountryOpen(false)} testID="topology-country-close">
                  <Ionicons name="close" size={24} color={colors.text} />
                </TouchableOpacity>
              </View>
              <FlatList
                data={countries}
                keyExtractor={(c) => c.code}
                renderItem={({ item }) => {
                  const active = item.code === countryCode;
                  return (
                    <TouchableOpacity
                      testID={`topology-country-${item.code}`}
                      onPress={() => {
                        if (item.code !== countryCode) {
                          setCountryCode(item.code);
                          setCityId(''); // cascade: country change invalidates city
                        }
                        setCountryOpen(false);
                      }}
                      style={[
                        styles.row,
                        {
                          backgroundColor: active ? colors.brandSoft || colors.card : 'transparent',
                          borderColor: active ? (colors.brand || colors.primary) : colors.border,
                        },
                      ]}
                    >
                      <Text style={{ fontSize: 22, marginRight: 12 }}>{item.flag}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.rowTitle, { color: colors.text }]}>{item.name}</Text>
                        <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>
                          {item.cityCount} cities · {item.currency}
                        </Text>
                      </View>
                      {active && <Ionicons name="checkmark-circle" size={22} color={colors.brand || colors.primary} />}
                    </TouchableOpacity>
                  );
                }}
              />
            </View>
          </View>
        </Modal>

        {/* City picker (cascade — only countryCode's cities) */}
        <Modal visible={cityOpen} animationType="slide" transparent onRequestClose={() => setCityOpen(false)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.modalSheet, { backgroundColor: colors.background }]}>
              <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
                <Text style={[styles.modalTitle, { color: colors.text }]}>
                  Cities · {currentCountry?.name || countryCode}
                </Text>
                <TouchableOpacity onPress={() => setCityOpen(false)} testID="topology-city-close">
                  <Ionicons name="close" size={24} color={colors.text} />
                </TouchableOpacity>
              </View>
              <FlatList
                data={cities}
                keyExtractor={(c) => c.id}
                renderItem={({ item }) => {
                  const active = item.id === cityId;
                  return (
                    <TouchableOpacity
                      testID={`topology-city-${item.id}`}
                      onPress={() => { setCityId(item.id); setCityOpen(false); }}
                      style={[
                        styles.row,
                        {
                          backgroundColor: active ? colors.brandSoft || colors.card : 'transparent',
                          borderColor: active ? (colors.brand || colors.primary) : colors.border,
                        },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.rowTitle, { color: colors.text }]}>{item.name}</Text>
                        <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>
                          {item.providersCount > 0
                            ? `${item.providersCount} active providers`
                            : 'No active providers yet'}
                        </Text>
                      </View>
                      {active && <Ionicons name="checkmark-circle" size={22} color={colors.brand || colors.primary} />}
                    </TouchableOpacity>
                  );
                }}
              />
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </KeyboardAvoidingView>
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
  scroll: { padding: 18, paddingBottom: 60 },
  intro: { fontSize: 13, lineHeight: 19, marginBottom: 20 },
  label: { fontSize: 13, fontWeight: '700', marginBottom: 8, letterSpacing: 0.2 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  fieldText: { flex: 1, fontSize: 15 },
  radiusRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  radiusChip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, borderWidth: 1 },
  radiusChipText: { fontSize: 14, fontWeight: '700' },
  resolvedBox: {
    marginTop: 24,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  resolvedLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 6 },
  resolvedRow: { fontSize: 15, fontWeight: '700' },
  resolvedMeta: { fontSize: 12, marginTop: 4 },
  saveBtn: {
    marginTop: 28,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  saveBtnText: { color: '#0F0F10', fontSize: 16, fontWeight: '800' },
  // Modals
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: { maxHeight: '85%', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 24 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 17, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginHorizontal: 14,
    marginVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowMeta: { fontSize: 12, marginTop: 2 },
});

/**
 * Карта Auto Search — Leaflet через WebView (native) / iframe (web).
 *
 * Что показывает:
 *   • контуры 7 операционных стран (DE / PL / LT / LV / EE / BY / UA)
 *   • 4 типа партнёрских маркеров с фильтрами вверху:
 *       🔧 workshops   — партнёрские СТО (жёлтый)
 *       🔍 inspectors  — партнёрские подборщики (синий)
 *       🏢 dealers     — партнёрские дилерские салоны (фиолетовый)
 *       🚿 carwashes   — мойки (бирюзовый, только в выбранном городе)
 *   • маркеры моих заявок (📋 красный)
 *
 * Данные тянутся реально из `/api/marketplace/providers?kinds=…&city=…` — это
 * не косметика, а живой фильтр на бэкенде (см. providers.py).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
const WebView: any = Platform.OS === 'web' ? null : require('react-native-webview').WebView;
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../src/context/ThemeContext';
import { useCity } from '../src/context/CityContext';
import { api } from '../src/services/api';
import { PARTNER_KINDS, PARTNER_KIND_MAP, PartnerKind } from '../src/lib/map/kinds';
import { buildLeafletHtml } from '../src/lib/map/buildLeafletHtml';

const KIND_META = PARTNER_KIND_MAP;

export default function MapScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { selectedCity } = useCity();
  const [providers, setProviders] = useState<any[]>([]);
  const [myReqs, setMyReqs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Defaults: workshops + inspectors + dealers ON; carwashes OFF (city-only).
  const [enabled, setEnabled] = useState<Record<PartnerKind, boolean>>({
    workshop: true, inspector: true, dealer: true, carwash: false,
  });

  const hasCity = !!selectedCity?.lat && !!selectedCity?.lng;

  // Re-fetch when filters or selected city change.
  useEffect(() => {
    const activeKinds = (Object.keys(enabled) as PartnerKind[]).filter(k => enabled[k]);
    if (activeKinds.length === 0) {
      setProviders([]);
      setLoading(false);
      return;
    }
    // Carwashes are city-scoped — if user enables carwash without a city,
    // we silently drop carwash from the request to avoid a huge global pull.
    const requestKinds = activeKinds.filter(k => k !== 'carwash' || hasCity);
    const params: any = { kinds: requestKinds.join(',') };
    if (hasCity) {
      params.city = selectedCity!.code;
      params.lat = selectedCity!.lat;
      params.lng = selectedCity!.lng;
      params.radius = 60;
      params.limit = 800;
    } else {
      params.lat = 52.0;
      params.lng = 19.5;
      params.radius = 2500;
      params.limit = 1500;
    }
    setLoading(true);
    Promise.all([
      api.get('/marketplace/providers', { params }).catch(() => ({ data: { providers: [] } })),
      api.get('/service-requests/me').catch(() => ({ data: { requests: [] } })),
    ]).then(([p, r]) => {
      setProviders(p.data?.providers || []);
      setMyReqs((r.data?.requests || []).filter((req: any) => req.location));
    }).finally(() => setLoading(false));
  }, [selectedCity?.code, selectedCity?.lat, selectedCity?.lng, enabled.workshop, enabled.inspector, enabled.dealer, enabled.carwash, hasCity]);

  const toggle = (k: PartnerKind) => setEnabled(e => ({ ...e, [k]: !e[k] }));

  const html = useMemo(
    () => buildLeafletHtml({
      centerLat: selectedCity?.lat,
      centerLng: selectedCity?.lng,
      hasCity,
      providers,
      myRequests: myReqs,
      drawCountries: true,
    }),
    [providers, myReqs, selectedCity?.code, selectedCity?.lat, selectedCity?.lng, hasCity],
  );

  // Per-kind visible count (for legend).
  const visibleCounts = useMemo(() => {
    const out: Record<PartnerKind, number> = { workshop: 0, inspector: 0, dealer: 0, carwash: 0 };
    providers.forEach(p => {
      const k = (p.kind || p.partnerType) as PartnerKind;
      if (out[k] !== undefined) out[k] += 1;
    });
    return out;
  }, [providers]);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity testID="map-back" onPress={() => router.back()} style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          Карта · {selectedCity?.name || 'Регион'}
        </Text>
        <TouchableOpacity
          testID="map-new-request"
          onPress={() => router.push('/service-marketplace/create' as any)}
          style={[styles.backBtn, { backgroundColor: colors.primary }]}
          activeOpacity={0.7}
        >
          <Ionicons name="add" size={22} color="#000" />
        </TouchableOpacity>
      </View>

      {/* Filter chips for 4 partner kinds */}
      <View style={{ height: 44 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
        {(Object.keys(KIND_META) as PartnerKind[]).map(k => {
          const meta = KIND_META[k];
          const on = enabled[k];
          const disabledCarwash = k === 'carwash' && !hasCity;
          return (
            <TouchableOpacity
              key={k}
              testID={`map-filter-${k}`}
              activeOpacity={0.7}
              onPress={() => !disabledCarwash && toggle(k)}
              style={[
                styles.chip,
                { backgroundColor: on ? meta.color : colors.card, borderColor: on ? meta.color : colors.border, opacity: disabledCarwash ? 0.4 : 1 },
              ]}
            >
              <Text style={[styles.chipText, { color: on ? '#000' : colors.text }]}>
                {meta.emoji} {meta.label} ({visibleCounts[k]})
              </Text>
            </TouchableOpacity>
          );
        })}
        </ScrollView>
      </View>

      <View style={{ flex: 1 }}>
        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
        ) : Platform.OS === 'web' ? (
          React.createElement('iframe', {
            srcDoc: html,
            title: 'map',
            style: { width: '100%', height: '100%', border: 0, backgroundColor: '#f5f7fb' },
            sandbox: 'allow-scripts allow-same-origin',
            'data-testid': 'map-iframe',
          })
        ) : (
          <WebView
            testID="map-webview"
            source={{ html }}
            style={{ flex: 1 }}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            scalesPageToFit
          />
        )}
      </View>

      {!hasCity && (
        <View style={[styles.hint, { backgroundColor: colors.card, borderColor: colors.border }]} testID="map-carwash-hint">
          <Text style={[styles.hintText, { color: colors.textSecondary }]}>
            🚿 Мойки показываются только при выборе города. Откройте «Choose city» в шапке Home.
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingTop: 8, paddingBottom: 8,
  },
  backBtn: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  headerTitle: { fontSize: 17, fontWeight: '700', flex: 1, textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  chipsRow: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  chip: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, marginRight: 8 },
  chipText: { fontSize: 13, fontWeight: '700' },
  hint: { position: 'absolute', left: 16, right: 16, bottom: 18, padding: 10, borderRadius: 10, borderWidth: 1 },
  hintText: { fontSize: 12, textAlign: 'center' },
});

// Vehicle Memory — lightweight compare screen.
// Route: /vehicles/compare?ids=vehicle_a,vehicle_b,...
//
// Shows 2–4 candidate vehicles side-by-side as scrollable columns. Per row we
// expose the smallest comparable attributes. No "winner highlight" yet — just
// honest tabular comparison so the user can read it quickly.
//
// i18n: row labels come from `vehicles.row.*`, header/empty/CTA strings from
// `vehicles.compare_*` so a future locale only edits one namespace.
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';
import { vehiclesApi, Vehicle } from '../../src/services/vehicles';
import i18n from '../../src/i18n';

const COLUMN_W = 180;

type Row = { key: keyof Vehicle | string; labelKey: string; render: (v: Vehicle, km: string) => string };

const fmt = (n: number) => Number(n).toLocaleString('de-DE');

const ROWS: Row[] = [
  { key: 'price',        labelKey: 'vehicles.row.price',        render: (v) => v.price ? `€${fmt(v.price)}` : '—' },
  { key: 'year',         labelKey: 'vehicles.row.year',         render: (v) => v.year ? String(v.year) : '—' },
  { key: 'mileage',      labelKey: 'vehicles.row.mileage',      render: (v, km) => typeof v.mileage === 'number' ? `${fmt(v.mileage)} ${km}` : '—' },
  { key: 'fuel',         labelKey: 'vehicles.row.fuel',         render: (v) => v.fuel ? v.fuel.toUpperCase() : '—' },
  { key: 'transmission', labelKey: 'vehicles.row.transmission', render: (v) => v.transmission || '—' },
  { key: 'location',     labelKey: 'vehicles.row.location',     render: (v) => v.location || '—' },
  { key: 'source',       labelKey: 'vehicles.row.source',       render: (v) => v.source || '—' },
];

export default function VehicleCompareScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ ids?: string }>();
  const idList = useMemo(
    () => (params.ids || '').split(',').map((s) => s.trim()).filter(Boolean),
    [params.ids],
  );

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (idList.length === 0) {
      setLoading(false);
      setError('no_ids');
      return;
    }
    (async () => {
      try {
        const settled = await Promise.all(idList.map((id) => vehiclesApi.get(id).catch(() => null)));
        if (!alive) return;
        const ok = settled.filter((x): x is Vehicle => !!x);
        setVehicles(ok);
      } catch {
        if (alive) setError('fetch');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [idList]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (error || vehicles.length < 2) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
        <Header colors={colors} title={t('vehicles.compare_title')} onBack={() => router.back()} />
        <View style={styles.center}>
          <Ionicons name="git-compare-outline" size={48} color={colors.textSecondary} />
          <Text style={[styles.errTitle, { color: colors.text }]}>
            {error === 'no_ids' ? t('vehicles.compare_empty_no_ids') : t('vehicles.compare_empty_fetch')}
          </Text>
          <Text style={[styles.errSub, { color: colors.textSecondary }]}>
            {t('vehicles.compare_empty_hint')}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const km = i18n.t('common.km');

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <Header
        colors={colors}
        title={t('vehicles.compare_title_with_count', { n: vehicles.length })}
        onBack={() => router.back()}
      />

      <ScrollView contentContainerStyle={{ paddingBottom: 32 }} testID="vehicles-compare">
        {/* Header columns: brand + model titles */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.colsHeader}>
          <View style={[styles.labelCell, { backgroundColor: colors.background }]} />
          {vehicles.map((v) => (
            <View key={v.id} style={[styles.headCell, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.headTitle, { color: colors.text }]} numberOfLines={1}>{v.brand}</Text>
              <Text style={[styles.headSub, { color: colors.textSecondary }]} numberOfLines={1}>{v.model}</Text>
            </View>
          ))}
        </ScrollView>

        {/* Body rows */}
        <ScrollView horizontal showsHorizontalScrollIndicator={true}>
          <View>
            {ROWS.map((row, idx) => (
              <View
                key={row.key as string}
                style={[
                  styles.row,
                  { backgroundColor: idx % 2 === 0 ? 'transparent' : 'rgba(127,127,127,0.06)' },
                ]}
              >
                <View style={styles.labelCell}>
                  <Text style={[styles.labelTxt, { color: colors.textSecondary }]}>{t(row.labelKey)}</Text>
                </View>
                {vehicles.map((v) => (
                  <View key={v.id + row.key} style={styles.valueCell}>
                    <Text style={[styles.valueTxt, { color: colors.text }]} numberOfLines={2}>
                      {row.render(v, km)}
                    </Text>
                  </View>
                ))}
              </View>
            ))}

            {/* Notes row — multi-line */}
            <View style={[styles.row, { backgroundColor: 'rgba(245,184,0,0.06)', minHeight: 76 }]}>
              <View style={styles.labelCell}>
                <Text style={[styles.labelTxt, { color: colors.textSecondary }]}>{t('vehicles.row.notes')}</Text>
              </View>
              {vehicles.map((v) => (
                <View key={v.id + '-notes'} style={[styles.valueCell, { paddingVertical: 10 }]}>
                  <Text style={[styles.notesTxt, { color: colors.text }]} numberOfLines={5}>
                    {v.notes || '—'}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        </ScrollView>

        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <TouchableOpacity
            testID="compare-cta-inspect"
            onPress={() => router.push({ pathname: '/auto-request/create' as any, params: { type: 'inspection' } })}
            style={[styles.cta, { backgroundColor: colors.primary }]}
          >
            <Ionicons name="shield-checkmark" size={20} color="#000" />
            <Text style={styles.ctaTxt}>{t('vehicles.compare_cta_inspect')}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Header({ colors, title, onBack }: any) {
  return (
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <TouchableOpacity onPress={onBack} style={styles.headerSide} testID="compare-back">
        <Ionicons name="chevron-back" size={26} color={colors.text} />
      </TouchableOpacity>
      <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>{title}</Text>
      <View style={styles.headerSide} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSide: { width: 60, alignItems: 'flex-start' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  colsHeader: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 14 },
  labelCell: {
    width: 110,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  labelTxt: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  headCell: {
    width: COLUMN_W,
    marginRight: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  headTitle: { fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  headSub: { fontSize: 13, fontWeight: '600', marginTop: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 48,
  },
  valueCell: {
    width: COLUMN_W,
    marginRight: 10,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  valueTxt: { fontSize: 14, fontWeight: '600' },
  notesTxt: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  errTitle: { fontSize: 18, fontWeight: '800', textAlign: 'center', marginTop: 8 },
  errSub: { fontSize: 13, textAlign: 'center' },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 52,
    borderRadius: 14,
  },
  ctaTxt: { fontSize: 15, fontWeight: '900', color: '#000', letterSpacing: -0.2 },
});

// Vehicle Memory — candidate list screen.
// Route: /vehicles
//
// Shows the customer's saved vehicles (from POST /api/customer/vehicles).
// Each card supports: open (future detail), select for compare, delete.
// Up to 4 candidates can be selected for the lightweight compare view.
//
// i18n: all user-facing strings come from the `vehicles.*` and `common.*`
// namespaces. Status pill labels live under `vehicles.status.*`.
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';
import { vehiclesApi, Vehicle } from '../../src/services/vehicles';
import i18n from '../../src/i18n';

const MAX_COMPARE = 4;

export default function VehiclesIndexScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareSet, setCompareSet] = useState<string[]>([]); // vehicle ids
  // Sprint 2C — compare is now an explicit mode toggled via header. By default,
  // tapping a card opens the workspace. This makes the workspace primary —
  // compare is a deliberate secondary action.
  const [compareMode, setCompareMode] = useState(false);

  const fetchAll = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (mode === 'initial') setLoading(true); else setRefreshing(true);
    setError(null);
    try {
      const list = await vehiclesApi.list();
      setVehicles(list);
    } catch (e: any) {
      // Customer-only endpoint → unauthenticated visitors get 401. Show a
      // friendly state instead of a raw error.
      if (e?.response?.status === 401) {
        setError('auth');
      } else {
        setError('fetch');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchAll('initial'); }, [fetchAll]));

  const toggleCompare = (id: string) => {
    setCompareSet((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_COMPARE) {
        Alert.alert(
          i18n.t('vehicles.compare_limit_title'),
          i18n.t('vehicles.compare_limit_msg', { max: MAX_COMPARE }),
        );
        return prev;
      }
      return [...prev, id];
    });
  };

  const handleDelete = (v: Vehicle) => {
    const name = `${v.brand} ${v.model}`.trim();
    const yearSuffix = v.year ? ` · ${v.year}` : '';
    const doDelete = async () => {
      try {
        await vehiclesApi.remove(v.id);
        setVehicles((prev) => prev.filter((x) => x.id !== v.id));
        setCompareSet((prev) => prev.filter((x) => x !== v.id));
      } catch {
        Alert.alert(i18n.t('common.error'), i18n.t('vehicles.delete_error'));
      }
    };
    if (Platform.OS === 'web') {
      // Alert.alert button callbacks are unreliable on web — use confirm.
      // eslint-disable-next-line no-alert
      if (confirm(i18n.t('vehicles.delete_confirm_web', { name }))) doDelete();
      return;
    }
    Alert.alert(
      i18n.t('vehicles.delete_title'),
      i18n.t('vehicles.delete_msg', { name, yearSuffix }),
      [
        { text: i18n.t('common.cancel'), style: 'cancel' },
        { text: i18n.t('common.delete'), style: 'destructive', onPress: doDelete },
      ],
    );
  };

  const goCompare = () => {
    if (compareSet.length < 2) {
      Alert.alert(i18n.t('vehicles.compare_min_title'), i18n.t('vehicles.compare_min_msg'));
      return;
    }
    router.push({ pathname: '/vehicles/compare' as any, params: { ids: compareSet.join(',') } });
  };

  // ── render
  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (error === 'auth') {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
        <Header colors={colors} title={t('vehicles.title')} onBack={() => router.back()} />
        <View style={styles.emptyBox}>
          <Ionicons name="lock-closed" size={48} color={colors.textSecondary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('vehicles.auth_required_title')}</Text>
          <Text style={[styles.emptySub, { color: colors.textSecondary }]}>
            {t('vehicles.auth_required_msg')}
          </Text>
          <TouchableOpacity
            testID="vehicles-empty-login"
            onPress={() => router.push('/login')}
            style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
          >
            <Text style={styles.primaryBtnTxt}>{t('common.login')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (vehicles.length === 0) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
        <Header colors={colors} title={t('vehicles.title')} onBack={() => router.back()} />
        <View style={styles.emptyBox}>
          <Ionicons name="car-sport-outline" size={56} color={colors.textSecondary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('vehicles.empty_title')}</Text>
          <Text style={[styles.emptySub, { color: colors.textSecondary }]}>
            {t('vehicles.empty_msg')}
          </Text>
          <TouchableOpacity
            testID="vehicles-empty-create"
            onPress={() => router.push({ pathname: '/auto-request/create' as any, params: { type: 'selection' } })}
            style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
          >
            <Ionicons name="add-circle" size={20} color="#000" />
            <Text style={styles.primaryBtnTxt}>{t('vehicles.empty_cta')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <Header
        colors={colors}
        title={t('vehicles.title_with_count', { n: vehicles.length })}
        onBack={() => router.back()}
        rightLabel={
          compareMode
            ? (compareSet.length >= 2
                ? t('vehicles.compare_action_count', { n: compareSet.length })
                : t('common.cancel'))
            : t('vehicles.compare_action')
        }
        onRight={() => {
          if (!compareMode) { setCompareMode(true); setCompareSet([]); return; }
          if (compareSet.length >= 2) goCompare();
          else { setCompareMode(false); setCompareSet([]); }
        }}
      />

      <ScrollView
        contentContainerStyle={styles.listPad}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchAll('refresh')} />}
        testID="vehicles-list"
      >
        {compareMode && (
          <View style={[styles.compareBanner, { backgroundColor: colors.card, borderColor: colors.primary }]}>
            <Ionicons name="git-compare-outline" size={18} color={colors.primary} />
            <Text style={[styles.compareBannerTxt, { color: colors.text }]}>
              {t('vehicles.compare_banner', { max: MAX_COMPARE })}
            </Text>
          </View>
        )}

        {vehicles.map((v) => (
          <VehicleCard
            key={v.id}
            v={v}
            colors={colors}
            compareMode={compareMode}
            selected={compareSet.includes(v.id)}
            onPress={() => {
              if (compareMode) toggleCompare(v.id);
              else router.push({ pathname: '/vehicles/[id]' as any, params: { id: v.id } });
            }}
            onDelete={() => handleDelete(v)}
          />
        ))}

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ──────────────── helpers ────────────────
function Header({ colors, title, onBack, rightLabel, onRight }: any) {
  return (
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <TouchableOpacity onPress={onBack} style={styles.headerSide} testID="vehicles-back">
        <Ionicons name="chevron-back" size={26} color={colors.text} />
      </TouchableOpacity>
      <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>{title}</Text>
      <View style={styles.headerSide}>
        {rightLabel ? (
          <TouchableOpacity onPress={onRight} testID="vehicles-compare-cta">
            <Text style={[styles.headerRightTxt, { color: colors.primary }]}>{rightLabel}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

function VehicleCard({ v, colors, compareMode, selected, onPress, onDelete }: { v: Vehicle; colors: any; compareMode: boolean; selected: boolean; onPress: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  const fmt = (n: number) => Number(n).toLocaleString('de-DE');
  const priceTxt = v.price ? `€${fmt(v.price)}` : '—';
  const meta = [
    v.year ? String(v.year) : null,
    typeof v.mileage === 'number' ? `${fmt(v.mileage)} ${t('common.km')}` : null,
    v.fuel ? v.fuel.toUpperCase() : null,
    v.location || null,
  ].filter(Boolean) as string[];

  // Sprint 2C: render status pill on the card so users can see lifecycle at a
  // glance. Falls back to "saved" for unknown statuses.
  const statusKey = ((): string => {
    switch (v.status) {
      case 'inspection_requested': return 'vehicles.status.inspection_requested';
      case 'inspection_completed': return 'vehicles.status.inspection_completed';
      case 'purchased': return 'vehicles.status.purchased';
      case 'archived': return 'vehicles.status.archived';
      case 'saved':
      default: return 'vehicles.status.saved';
    }
  })();
  const statusLabel = i18n.t(statusKey);

  return (
    <TouchableOpacity
      testID={`vehicle-card-${v.id}`}
      activeOpacity={0.85}
      onPress={onPress}
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: selected ? colors.primary : colors.border, borderWidth: selected ? 2 : 1 },
      ]}
    >
      <View style={styles.cardRow}>
        {/* Left selection check / icon — different visuals for compare mode vs default */}
        <View
          style={[
            styles.checkBox,
            {
              backgroundColor: selected ? colors.primary : 'transparent',
              borderColor: selected ? colors.primary : colors.border,
            },
          ]}
        >
          {compareMode ? (
            selected ? (
              <Ionicons name="checkmark" size={18} color="#000" />
            ) : (
              <Ionicons name="square-outline" size={18} color={colors.textSecondary} />
            )
          ) : (
            <Ionicons name="car-sport-outline" size={20} color={colors.textSecondary} />
          )}
        </View>

        {/* Body */}
        <View style={{ flex: 1 }}>
          <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
            {v.brand} {v.model}
          </Text>
          {meta.length > 0 && (
            <Text style={[styles.cardMeta, { color: colors.textSecondary }]} numberOfLines={1}>
              {meta.join(' · ')}
            </Text>
          )}
          <View style={styles.statusPillRow}>
            <View style={[styles.statusPill, { borderColor: colors.border, backgroundColor: 'rgba(127,127,127,0.06)' }]}>
              <Text style={[styles.statusPillTxt, { color: colors.textSecondary }]}>{statusLabel}</Text>
            </View>
          </View>
          {v.notes ? (
            <Text style={[styles.cardNote, { color: colors.textSecondary }]} numberOfLines={2}>
              📝 {v.notes}
            </Text>
          ) : null}
        </View>

        {/* Right column: price + delete */}
        <View style={styles.cardRight}>
          <Text style={[styles.cardPrice, { color: colors.text }]} numberOfLines={1}>{priceTxt}</Text>
          {!compareMode && (
            <TouchableOpacity
              testID={`vehicle-delete-${v.id}`}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={onDelete}
              style={styles.deleteBtn}
            >
              <Ionicons name="trash-outline" size={18} color="#EF4444" />
            </TouchableOpacity>
          )}
          {!compareMode && (
            <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSide: { width: 80, alignItems: 'flex-start', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  headerRightTxt: { fontSize: 14, fontWeight: '700', textAlign: 'right', paddingRight: 12 },
  listPad: { padding: 16, paddingBottom: 40 },
  card: {
    padding: 14,
    marginBottom: 12,
    borderRadius: 16,
  },
  cardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  checkBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  cardMeta: { fontSize: 12, fontWeight: '600', marginTop: 4 },
  // Sprint 2C — small status pill on each card. Subtle, no color drama; the
  // workspace screen handles the loud "selected" rendering.
  statusPillRow: { flexDirection: 'row', marginTop: 6 },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  statusPillTxt: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  cardNote: { fontSize: 12, marginTop: 6, lineHeight: 16 },
  cardRight: { alignItems: 'flex-end', gap: 8, minWidth: 76 },
  cardPrice: { fontSize: 16, fontWeight: '900', letterSpacing: -0.2 },
  deleteBtn: { padding: 4 },
  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '800' },
  emptySub: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 14,
    marginTop: 12,
  },
  primaryBtnTxt: { fontSize: 15, fontWeight: '800', color: '#000' },
  compareBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    marginBottom: 12,
  },
  compareBannerTxt: { flex: 1, fontSize: 13, fontWeight: '600' },
});

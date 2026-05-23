import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Platform,
  ActivityIndicator,
  ScrollView,
  Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useThemeContext } from '../../src/context/ThemeContext';
import { useTranslation } from 'react-i18next';
import { useCity } from '../../src/context/CityContext';
import { mapAPI, marketplaceAPI } from '../../src/services/api';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const KYIV = { lat: 50.4501, lng: 30.5234 };

interface MapProvider {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distanceKm: number;
  rating: number;
  isVerified: boolean;
  isMobile: boolean;
  pinType: 'verified' | 'admin' | 'unverified' | 'popular' | 'mobile' | 'standard';
  locationSource: 'self' | 'admin' | 'auto';
  isLocationVerified: boolean;
  specializations: string[];
}

// Pin colors by type
const PIN_COLORS: Record<string, string> = {
  verified: colors.success,
  admin: colors.brand,
  unverified: colors.warning,
  popular: colors.brand,
  mobile: colors.brand,
  standard: colors.textMuted,
};

// Sprint 34 Day 4: single source-of-truth map. The duplicate top-header map icon
// in (tabs)/index.tsx was removed — this tab is now the only entrypoint.
// Stage 2 — Geo + Search: city selection from CityContext drives map center
// when GPS is unavailable and city-filters provider list.
export default function ServicesMapScreen() {
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { selectedCity } = useCity();

  const [providers, setProviders] = useState<MapProvider[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedRadius, setSelectedRadius] = useState(5);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationGranted, setLocationGranted] = useState(false);
  const [showList, setShowList] = useState(false);

  // City center as fallback when GPS not available
  const cityCenter = selectedCity
    ? { lat: selectedCity.lat, lng: selectedCity.lng }
    : KYIV;

  const requestLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        setLocationGranted(true);
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const coords = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        setUserLocation(coords);
        fetchProviders(coords.lat, coords.lng, selectedRadius);
      }
    } catch (e) {
      console.log('Location error:', e);
    }
  };

  const fetchProviders = useCallback(async (lat: number, lng: number, radius: number) => {
    try {
      setIsLoading(true);
      // Stage 2: prefer marketplace endpoint with city filter when a city is selected.
      // Falls back to legacy `mapAPI.getNearby` when no city or empty result.
      const cityCode = selectedCity?.code;
      let raw: any[] = [];
      if (cityCode) {
        const res = await marketplaceAPI.getProviders(lat, lng, radius, 30, cityCode);
        raw = res.data?.providers || [];
      }
      if (!raw.length) {
        const fallback = await mapAPI.getNearby(lat, lng, radius, 30);
        raw = (fallback.data && fallback.data.providers) || [];
      }
      const adapted: MapProvider[] = raw.map((p: any) => ({
        id: p.id || p.slug || p.providerId,
        name: p.name || '',
        lat: p.lat ?? (p.location?.coordinates ? p.location.coordinates[1] : lat),
        lng: p.lng ?? (p.location?.coordinates ? p.location.coordinates[0] : lng),
        distanceKm: typeof p.distance === 'number' ? p.distance : (p.distanceKm ?? 0),
        rating: typeof p.ratingAvg === 'number' ? p.ratingAvg : (p.rating ?? 0),
        isVerified: !!p.isVerified,
        isMobile: !!(p.isMobile || p.providerType === 'mobile' || (p.badges || []).includes('mobile')),
        pinType: p.isVerified ? 'verified' : (p.visibilityState === 'boosted' ? 'popular' : 'standard'),
        locationSource: p.locationSource || 'self',
        isLocationVerified: !!(p.isLocationVerified ?? p.isVerified),
        specializations: p.specializations || p.clusters || [],
      }));
      setProviders(adapted);
    } catch (error) {
      console.log('map fetch error', error);
      setProviders([]);
    } finally {
      setIsLoading(false);
    }
  }, [selectedCity?.code]);

  useEffect(() => {
    requestLocation().then(() => {
      if (!userLocation) {
        fetchProviders(cityCenter.lat, cityCenter.lng, selectedRadius);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const coords = userLocation || cityCenter;
    fetchProviders(coords.lat, coords.lng, selectedRadius);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRadius, selectedCity?.code]);

  const handleSelectProvider = (provider: MapProvider) => {
    const coords = userLocation || cityCenter;
    setShowList(false);
    router.push({
      pathname: '/direct',
      params: { providerId: provider.id, lat: String(coords.lat), lng: String(coords.lng) },
    });
  };

  const coords = userLocation || cityCenter;
  const mapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${coords.lng - selectedRadius * 0.01},${coords.lat - selectedRadius * 0.008},${coords.lng + selectedRadius * 0.01},${coords.lat + selectedRadius * 0.008}&layer=mapnik&marker=${coords.lat},${coords.lng}`;

  const getTypeBadge = (provider: MapProvider) => {
    if (provider.locationSource === 'admin') return { icon: 'shield-checkmark', color: colors.brand, label: 'Админ' };
    if (provider.isLocationVerified) return { icon: 'checkmark-circle', color: colors.success, label: 'Проверен' };
    if (provider.locationSource === 'auto') return { icon: 'help-circle', color: colors.warning, label: 'Авто' };
    return null;
  };

  // Bottom-bar must clear the (tabs) custom tab bar (~80px including safe-area)
  const tabBarSpace = 80 + Math.max(insets.bottom, 0);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]} testID="map-tab">
      {/* Header — no back arrow, this is a tab */}
      <View style={[styles.header, { paddingTop: insets.top + 4, backgroundColor: colors.background }]}>
        <View style={styles.headerSide} />
        <TouchableOpacity
          testID="map-city-btn"
          onPress={() => router.push('/city-select?redirect=/services')}
          style={styles.cityBtn}
          activeOpacity={0.7}
        >
          <Ionicons name="location" size={16} color={colors.primary} />
          <Text style={[styles.title, { color: colors.text, marginLeft: 6 }]}>
            {selectedCity?.name || t('services_map.title', { defaultValue: 'Карта мастеров' })}
          </Text>
          <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => fetchProviders(coords.lat, coords.lng, selectedRadius)}
          style={styles.headerBtn}
          testID="map-refresh-btn"
        >
          <Ionicons name="refresh" size={22} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {/* Radius selector */}
      <View style={[styles.radiusBar, { backgroundColor: colors.background }]}>
        {[1, 2, 5, 10].map((r) => (
          <TouchableOpacity
            key={r}
            testID={`map-radius-${r}`}
            style={[styles.radiusBtn, { backgroundColor: selectedRadius === r ? colors.primary : colors.card }]}
            onPress={() => setSelectedRadius(r)}
          >
            <Text style={{ color: selectedRadius === r ? colors.brandText : colors.text, fontWeight: '600', fontSize: 13 }}>
              {r}км
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Legend */}
      <View style={[styles.legend, { backgroundColor: colors.card }]}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: PIN_COLORS.verified }]} />
          <Text style={[styles.legendText, { color: colors.textSecondary }]}>Проверен</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: PIN_COLORS.admin }]} />
          <Text style={[styles.legendText, { color: colors.textSecondary }]}>Админ</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: PIN_COLORS.unverified }]} />
          <Text style={[styles.legendText, { color: colors.textSecondary }]}>Авто</Text>
        </View>
      </View>

      {/* Map */}
      <View style={styles.mapContainer}>
        {Platform.OS === 'web' ? (
          <>
            <iframe
              src={mapUrl}
              style={{ width: '100%', height: '100%', border: 'none', display: 'block' } as any}
            />
            {/* Cover OSM attribution that overlaps bottom-bar */}
            <View pointerEvents="none" style={styles.osmAttrCover} />
          </>
        ) : (
          <View style={[styles.mapPlaceholder, { backgroundColor: colors.card }]}>
            <Ionicons name="map" size={48} color={colors.textMuted} />
          </View>
        )}

        {/* FABs */}
        <TouchableOpacity
          style={[styles.quickFab, { bottom: tabBarSpace + 70 }]}
          onPress={() => router.push('/auto-request/choose')}
          testID="map-quick-fab"
        >
          <Ionicons name="flash" size={22} color="#fff" />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.locateFab, { bottom: tabBarSpace + 70, backgroundColor: colors.card }]}
          onPress={requestLocation}
          testID="map-locate-fab"
        >
          <Ionicons
            name={locationGranted ? 'locate' : 'location-outline'}
            size={22}
            color={locationGranted ? colors.primary : colors.warning}
          />
        </TouchableOpacity>
      </View>

      {/* Bottom bar — sits ABOVE the (tabs) tab bar */}
      <TouchableOpacity
        style={[styles.bottomBar, { backgroundColor: colors.card, bottom: tabBarSpace }]}
        onPress={() => setShowList(true)}
        activeOpacity={0.9}
        testID="map-bottombar"
        // @ts-ignore — web-only outline reset for keyboard focus
        focusable={false}
      >
        <View style={[styles.handle, { backgroundColor: colors.border || '#555' }]} />
        <View style={styles.bottomBarContent}>
          <Text style={[styles.bottomBarText, { color: colors.text }]}>
            {isLoading ? t('common.loading') : t('services_map.providers_count', { count: providers.length, defaultValue: `${providers.length} мастеров рядом` })}
          </Text>
          <View style={[styles.expandIcon, { backgroundColor: colors.primary }]}>
            <Ionicons name="chevron-up" size={18} color="#fff" />
          </View>
        </View>
      </TouchableOpacity>

      {/* Modal with providers list */}
      <Modal
        visible={showList}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowList(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBg} onPress={() => setShowList(false)} />
          <View style={[styles.modalContent, { backgroundColor: colors.background, paddingBottom: insets.bottom }]}>
            <TouchableOpacity style={styles.modalHeader} onPress={() => setShowList(false)}>
              <View style={[styles.handle, { backgroundColor: colors.border || '#555' }]} />
              <View style={styles.modalTitleRow}>
                <Text style={[styles.modalTitle, { color: colors.text }]}>{providers.length} мастеров</Text>
                <View style={[styles.closeBtn, { backgroundColor: colors.card }]}>
                  <Ionicons name="chevron-down" size={20} color={colors.text} />
                </View>
              </View>
            </TouchableOpacity>

            <ScrollView style={styles.list} showsVerticalScrollIndicator={true}>
              {isLoading ? (
                <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 40 }} />
              ) : providers.length === 0 ? (
                <View style={styles.empty}>
                  <Ionicons name="search" size={40} color={colors.textMuted} />
                  <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                    Нет мастеров в радиусе {selectedRadius}км
                  </Text>
                </View>
              ) : (
                providers.map((p) => {
                  const badge = getTypeBadge(p);
                  return (
                    <TouchableOpacity
                      key={p.id}
                      style={[styles.card, { backgroundColor: colors.card }]}
                      onPress={() => handleSelectProvider(p)}
                    >
                      <View style={[styles.avatar, { backgroundColor: PIN_COLORS[p.pinType] || colors.primary }]}>
                        <Text style={styles.avatarText}>{p.name[0]}</Text>
                      </View>
                      <View style={styles.cardInfo}>
                        <View style={styles.cardNameRow}>
                          <Text style={[styles.cardName, { color: colors.text }]} numberOfLines={1}>
                            {p.name}
                          </Text>
                          {badge && (
                            <View style={[styles.typeBadge, { backgroundColor: badge.color + '20' }]}>
                              <Ionicons name={badge.icon as any} size={11} color={badge.color} />
                              <Text style={[styles.typeBadgeText, { color: badge.color }]}>{badge.label}</Text>
                            </View>
                          )}
                        </View>
                        <View style={styles.cardMeta}>
                          <Ionicons name="star" size={12} color={colors.brand} />
                          <Text style={{ color: colors.text, fontSize: 12, marginLeft: 2 }}>
                            {p.rating > 0 ? p.rating.toFixed(1) : '—'}
                          </Text>
                          <Text style={{ color: colors.textSecondary, fontSize: 12, marginLeft: 8 }}>
                            {p.distanceKm < 1 ? `${Math.round(p.distanceKm * 1000)}м` : `${p.distanceKm.toFixed(1)}км`}
                          </Text>
                          {p.isMobile && (
                            <View style={styles.mobileBadge}>
                              <Ionicons name="car" size={11} color={colors.brand} />
                              <Text style={{ color: colors.brand, fontSize: 10, marginLeft: 2 }}>Выезд</Text>
                            </View>
                          )}
                        </View>
                      </View>
                      <View style={[styles.selectBtn, { backgroundColor: colors.primary }]}>
                        <Text style={[styles.selectBtnText, { color: colors.brandText }]}>Выбрать</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 6 },
  headerSide: { width: 44, height: 44 },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '700' },
  cityBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    // @ts-ignore — web-only outline reset
    outlineStyle: 'none',
    // @ts-ignore — web-only cursor
    cursor: 'pointer',
  },

  radiusBar: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  radiusBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 18 },

  legend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    paddingVertical: 8,
    marginHorizontal: 16,
    borderRadius: 10,
    marginBottom: 8,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 11 },

  mapContainer: { flex: 1, position: 'relative' },
  mapPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  quickFab: {
    position: 'absolute',
    left: 16,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: colors.brand,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  locateFab: {
    position: 'absolute',
    right: 16,
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
  },

  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingTop: 10,
    paddingBottom: 14,
    paddingHorizontal: 16,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    // @ts-ignore — web-only outline reset
    outlineStyle: 'none',
    // @ts-ignore — web-only cursor
    cursor: 'pointer',
  },
  osmAttrCover: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 22,
    backgroundColor: 'rgba(0,0,0,0)',
    // Note: hides OSM attribution overlap behind bottom-bar via z-index stacking
  },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 10 },
  bottomBarContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bottomBarText: { fontSize: 16, fontWeight: '600' },
  expandIcon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },

  // Modal
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBg: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  modalContent: {
    maxHeight: SCREEN_HEIGHT * 0.75,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    elevation: 20,
  },
  modalHeader: { paddingTop: 10, paddingBottom: 12, paddingHorizontal: 16 },
  modalTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalTitle: { fontSize: 18, fontWeight: '600' },
  closeBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },

  list: { paddingHorizontal: 16, maxHeight: SCREEN_HEIGHT * 0.6 },
  empty: { alignItems: 'center', paddingVertical: 40, gap: 12 },
  emptyText: { fontSize: 15 },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 14,
    marginBottom: 10,
    gap: 10,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  cardInfo: { flex: 1 },
  cardNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' },
  cardName: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },

  typeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 5,
    gap: 2,
  },
  typeBadgeText: { fontSize: 9, fontWeight: '600' },

  mobileBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
  },

  selectBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  selectBtnText: { fontSize: 13, fontWeight: '600' },
});

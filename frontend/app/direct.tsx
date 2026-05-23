import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Platform,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../src/context/ThemeContext';
import { mapAPI } from '../src/services/api';
import { theme } from '../src/context/ThemeContext';
const colors = theme.colors;

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

interface DirectData {
  provider: {
    id: string;
    name: string;
    description: string;
    lat: number;
    lng: number;
    rating: number;
    reviewsCount: number;
    isVerified: boolean;
    isPopular: boolean;
    isMobile: boolean;
    hasAvailableSlotsToday: boolean;
    avgResponseTimeMinutes: number;
    visibilityScore: number;
    matchingScore: number;
    specializations: string[];
    pinType: string;
    bookingsCount: number;
    completedBookingsCount: number;
  };
  distanceKm: number;
  etaMinutes: number;
  reasons: string[];
  availableSlots: string[];
  hasSlotsToday: boolean;
  nextAvailableSlot: string | null;
}

type ScreenState = 'loading' | 'ready' | 'no-slots' | 'error';

// ═══════════════════════════════════════════════════════════
// HELPER: Format slot time
// ═══════════════════════════════════════════════════════════

function formatSlotTime(isoString: string): string {
  const date = new Date(isoString);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatSlotDate(isoString: string): string {
  const date = new Date(isoString);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (date.toDateString() === today.toDateString()) return 'Сегодня';
  if (date.toDateString() === tomorrow.toDateString()) return 'Завтра';

  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${date.getDate()} ${months[date.getMonth()]}`;
}

function getScoreColor(score: number): string {
  if (score >= 85) return colors.success;
  if (score >= 70) return colors.brand;
  if (score >= 50) return colors.warning;
  return colors.brand;
}

// ═══════════════════════════════════════════════════════════
// SKELETON
// ═══════════════════════════════════════════════════════════

function DirectSkeleton({ colors }: { colors: any }) {
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 1000, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(shimmer, { toValue: 0, duration: 1000, useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);

  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.7] });

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Animated.View style={{ height: 120, borderRadius: 20, backgroundColor: colors.card, opacity }} />
      <Animated.View style={{ height: 80, borderRadius: 16, backgroundColor: colors.card, opacity }} />
      <Animated.View style={{ height: 100, borderRadius: 16, backgroundColor: colors.card, opacity }} />
      <Animated.View style={{ height: 60, borderRadius: 16, backgroundColor: colors.card, opacity }} />
      <Animated.View style={{ height: 56, borderRadius: 14, backgroundColor: colors.card, opacity }} />
    </ScrollView>
  );
}

// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════

export default function DirectModeScreen() {
  const { colors } = useThemeContext();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    providerId: string;
    lat: string;
    lng: string;
    mode: string;
    providerName: string;
  }>();

  const [data, setData] = useState<DirectData | null>(null);
  const [screenState, setScreenState] = useState<ScreenState>('loading');
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [isBooking, setIsBooking] = useState(false);
  const [nearbyCount, setNearbyCount] = useState(0);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const heroScale = useRef(new Animated.Value(0.95)).current;
  const ctaScale = useRef(new Animated.Value(1)).current;

  const isQuickMode = params.mode === 'quick' || params.mode === 'quick_request';

  // 🔥 Пульсация CTA для urgency
  useEffect(() => {
    if (screenState === 'ready' && selectedSlot) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(ctaScale, { toValue: 1.02, duration: 800, useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(ctaScale, { toValue: 1, duration: 800, useNativeDriver: Platform.OS !== 'web' }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [screenState, selectedSlot]);

  useEffect(() => {
    fetchDirectData();
  }, []);

  useEffect(() => {
    if (data) {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: Platform.OS !== 'web' }),
        Animated.spring(heroScale, { toValue: 1, useNativeDriver: Platform.OS !== 'web', friction: 6 }),
      ]).start();
    }
  }, [data]);

  const fetchDirectData = async () => {
    try {
      setScreenState('loading');
      const res = await mapAPI.getDirect(
        params.providerId || '',
        parseFloat(params.lat || '50.4501'),
        parseFloat(params.lng || '30.5234'),
      );
      const d = res.data;
      setData(d);

      // 🔥 AUTO-SELECT первый доступный слот (уменьшает friction)
      if (d.availableSlots && d.availableSlots.length > 0) {
        setSelectedSlot(d.availableSlots[0]);
      }

      // 🔥 Получаем количество доступных мастеров поблизости для urgency
      try {
        const nearbyRes = await mapAPI.getNearby(
          parseFloat(params.lat || '50.4501'),
          parseFloat(params.lng || '30.5234'),
          5, // 5 км
          10
        );
        const availableNow = (nearbyRes.data || []).filter((p: any) => p.hasAvailableSlotsToday);
        setNearbyCount(availableNow.length);
      } catch {
        setNearbyCount(0);
      }

      if (!d.hasSlotsToday && (!d.availableSlots || d.availableSlots.length === 0)) {
        setScreenState('no-slots');
      } else {
        setScreenState('ready');
      }
    } catch {
      setScreenState('error');
    } finally {
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDirectData();
  }, []);

  const handleBooking = () => {
    setIsBooking(true);
    // Simulate booking (in real app — call POST /api/bookings)
    setTimeout(() => {
      setIsBooking(false);
      router.push({
        pathname: '/booking-confirmation',
        params: {
          providerId: data?.provider.id,
          providerName: data?.provider.name,
          slot: selectedSlot || '',
          distanceKm: String(data?.distanceKm || 0),
          etaMinutes: String(data?.etaMinutes || 0),
        },
      });
    }, 1500);
  };

  const p = data?.provider;

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        {/* ═══════ HEADER ═══════ */}
        <View style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.backBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>
              {isQuickMode ? 'Лучший мастер для вас' : 'Выбор мастера'}
            </Text>
          </View>
          <View style={styles.headerRight} />
        </View>

        {/* ═══════ CONTENT ═══════ */}
        {screenState === 'loading' ? (
          <DirectSkeleton colors={colors} />
        ) : screenState === 'error' ? (
          <View style={styles.errorContainer}>
            <View style={[styles.errorIcon, { backgroundColor: colors.card }]}>
              <Ionicons name="alert-circle-outline" size={48} color={colors.error} />
            </View>
            <Text style={[styles.errorTitle, { color: colors.text }]}>Ошибка загрузки</Text>
            <Text style={[styles.errorSub, { color: colors.textSecondary }]}>
              Не удалось загрузить данные мастера
            </Text>
            <TouchableOpacity style={[styles.retryBtn, { backgroundColor: colors.primary }]} onPress={fetchDirectData}>
              <Text style={styles.retryBtnText}>Повторить</Text>
            </TouchableOpacity>
          </View>
        ) : data && p ? (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.scrollContent, { paddingBottom: 120 + insets.bottom }]}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
            }
          >
            <Animated.View style={{ opacity: fadeAnim, transform: [{ scale: heroScale }] }}>
              {/* ═══════ QUICK MODE BANNER ═══════ */}
              {isQuickMode && (
                <View style={[styles.quickBanner, { backgroundColor: '#EF444415' }]}>
                  <Ionicons name="flash" size={18} color={colors.brand} />
                  <Text style={[styles.quickBannerText, { color: colors.brand }]}>
                    Лучший мастер для вашей проблемы
                  </Text>
                </View>
              )}

              {/* ═══════ 1. HERO ═══════ */}
              <View style={[styles.heroCard, { backgroundColor: colors.card }]}>
                {/* Avatar + Name */}
                <View style={styles.heroHeader}>
                  <View style={[styles.heroAvatar, { backgroundColor: getProviderColor(p) }]}>
                    <Text style={styles.heroAvatarText}>{p.name.charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={styles.heroInfo}>
                    <Text style={[styles.heroName, { color: colors.text }]} numberOfLines={2}>
                      {p.name}
                    </Text>
                    {p.description ? (
                      <Text style={[styles.heroDesc, { color: colors.textSecondary }]} numberOfLines={1}>
                        {p.description}
                      </Text>
                    ) : null}
                  </View>
                  <View style={[styles.matchCircle, { borderColor: getScoreColor(p.matchingScore) }]}>
                    <Text style={[styles.matchNum, { color: getScoreColor(p.matchingScore) }]}>
                      {p.matchingScore}
                    </Text>
                    <Text style={[styles.matchLabel, { color: colors.textMuted }]}>match</Text>
                  </View>
                </View>

                {/* Stats Row */}
                <View style={styles.statsRow}>
                  <View style={styles.stat}>
                    <Ionicons name="star" size={16} color={colors.brand} />
                    <Text style={[styles.statValue, { color: colors.text }]}>
                      {p.rating > 0 ? p.rating.toFixed(1) : '—'}
                    </Text>
                    {p.reviewsCount > 0 && (
                      <Text style={[styles.statSub, { color: colors.textMuted }]}>
                        ({p.reviewsCount})
                      </Text>
                    )}
                  </View>
                  <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
                  <View style={styles.stat}>
                    <Ionicons name="location" size={16} color={colors.primary} />
                    <Text style={[styles.statValue, { color: colors.text }]}>
                      {data.distanceKm < 1 ? `${(data.distanceKm * 1000).toFixed(0)} м` : `${data.distanceKm} км`}
                    </Text>
                  </View>
                  <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
                  <View style={styles.stat}>
                    <Ionicons name="car" size={16} color={colors.accent} />
                    <Text style={[styles.statValue, { color: colors.text }]}>
                      {data.etaMinutes} мин
                    </Text>
                  </View>
                  {p.avgResponseTimeMinutes > 0 && (
                    <>
                      <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
                      <View style={styles.stat}>
                        <Ionicons name="flash" size={16} color={colors.warning} />
                        <Text style={[styles.statValue, { color: colors.text }]}>
                          {p.avgResponseTimeMinutes}м
                        </Text>
                      </View>
                    </>
                  )}
                </View>

                {/* Badges */}
                <View style={styles.badges}>
                  {p.isVerified && (
                    <View style={[styles.badge, { backgroundColor: colors.successBg }]}>
                      <Ionicons name="shield-checkmark" size={12} color={colors.success} />
                      <Text style={[styles.badgeText, { color: colors.success }]}>Проверенный</Text>
                    </View>
                  )}
                  {p.isPopular && (
                    <View style={[styles.badge, { backgroundColor: colors.warningBg }]}>
                      <Ionicons name="flame" size={12} color={colors.warning} />
                      <Text style={[styles.badgeText, { color: colors.warning }]}>Популярный</Text>
                    </View>
                  )}
                  {p.avgResponseTimeMinutes > 0 && p.avgResponseTimeMinutes <= 15 && (
                    <View style={[styles.badge, { backgroundColor: colors.infoBg }]}>
                      <Ionicons name="flash" size={12} color={colors.info} />
                      <Text style={[styles.badgeText, { color: colors.info }]}>Быстро</Text>
                    </View>
                  )}
                  {p.isMobile && (
                    <View style={[styles.badge, { backgroundColor: '#8B5CF615' }]}>
                      <Ionicons name="car" size={12} color={colors.brand} />
                      <Text style={[styles.badgeText, { color: colors.brand }]}>Выезд</Text>
                    </View>
                  )}
                  {p.hasAvailableSlotsToday && (
                    <View style={[styles.badge, { backgroundColor: colors.accent + '15' }]}>
                      <Ionicons name="calendar" size={12} color={colors.accent} />
                      <Text style={[styles.badgeText, { color: colors.accent }]}>Сегодня</Text>
                    </View>
                  )}
                </View>
              </View>

              {/* ═══════ 2. WHY BLOCK ═══════ */}
              {data.reasons.length > 0 && (
                <View style={[styles.whyCard, { backgroundColor: colors.card }]}>
                  <View style={styles.whyHeader}>
                    <Ionicons name="bulb" size={18} color={colors.primary} />
                    <Text style={[styles.whyTitle, { color: colors.text }]}>Почему этот мастер</Text>
                  </View>
                  {data.reasons.map((reason, i) => (
                    <View key={i} style={styles.whyRow}>
                      <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                      <Text style={[styles.whyText, { color: colors.textSecondary }]}>{reason}</Text>
                    </View>
                  ))}
                </View>
              )}

              {/* ═══════ 3. MAP PREVIEW ═══════ */}
              <View style={[styles.mapPreview, { backgroundColor: colors.card }]}>
                <View style={styles.mapPreviewHeader}>
                  <Ionicons name="navigate" size={18} color={colors.primary} />
                  <Text style={[styles.mapPreviewTitle, { color: colors.text }]}>Маршрут</Text>
                </View>
                <View style={[styles.routeVisual, { backgroundColor: colors.backgroundTertiary }]}>
                  {/* User point */}
                  <View style={styles.routePoints}>
                    <View style={styles.routePoint}>
                      <View style={[styles.routeDot, { backgroundColor: colors.primary }]} />
                      <Text style={[styles.routeLabel, { color: colors.textSecondary }]}>Вы</Text>
                    </View>
                    {/* Route line */}
                    <View style={styles.routeLine}>
                      <View style={[styles.routeDash, { backgroundColor: colors.primary + '40' }]} />
                      <View style={[styles.routeDash, { backgroundColor: colors.primary + '60' }]} />
                      <View style={[styles.routeDash, { backgroundColor: colors.primary + '80' }]} />
                      <View style={[styles.routeDash, { backgroundColor: colors.primary }]} />
                    </View>
                    {/* Provider point */}
                    <View style={styles.routePoint}>
                      <View style={[styles.routeDot, { backgroundColor: getProviderColor(p) }]} />
                      <Text style={[styles.routeLabel, { color: colors.textSecondary }]} numberOfLines={1}>
                        {p.name}
                      </Text>
                    </View>
                  </View>
                  {/* Distance + ETA */}
                  <View style={styles.routeInfo}>
                    <View style={[styles.routeInfoBox, { backgroundColor: colors.card }]}>
                      <Ionicons name="location" size={14} color={colors.primary} />
                      <Text style={[styles.routeInfoValue, { color: colors.text }]}>
                        {data.distanceKm < 1 ? `${(data.distanceKm * 1000).toFixed(0)} м` : `${data.distanceKm} км`}
                      </Text>
                    </View>
                    <View style={[styles.routeInfoBox, { backgroundColor: colors.card }]}>
                      <Ionicons name="time" size={14} color={colors.accent} />
                      <Text style={[styles.routeInfoValue, { color: colors.text }]}>
                        Ехать {data.etaMinutes} мин
                      </Text>
                    </View>
                  </View>
                </View>
              </View>

              {/* ═══════ 4. SLOTS ═══════ */}
              <View style={[styles.slotsCard, { backgroundColor: colors.card }]}>
                <View style={styles.slotsHeader}>
                  <Ionicons name="calendar" size={18} color={colors.primary} />
                  <Text style={[styles.slotsTitle, { color: colors.text }]}>
                    {data.hasSlotsToday ? 'Записаться на сегодня' : 'Ближайшие слоты'}
                  </Text>
                </View>
                {data.availableSlots.length > 0 ? (
                  <>
                    {/* Date label */}
                    <Text style={[styles.slotsDateLabel, { color: colors.textMuted }]}>
                      {formatSlotDate(data.availableSlots[0])}
                    </Text>
                    <View style={styles.slotsGrid}>
                      {data.availableSlots.map((slot, i) => {
                        const isSelected = selectedSlot === slot;
                        return (
                          <TouchableOpacity
                            key={i}
                            style={[
                              styles.slotChip,
                              { backgroundColor: colors.backgroundTertiary, borderColor: colors.border, borderWidth: 1 },
                              isSelected && { backgroundColor: colors.primary, borderColor: colors.primary },
                            ]}
                            onPress={() => setSelectedSlot(slot)}
                            activeOpacity={0.7}
                          >
                            <Text style={[
                              styles.slotText,
                              { color: colors.text },
                              isSelected && { color: '#fff', fontWeight: '700' },
                            ]}>
                              {formatSlotTime(slot)}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </>
                ) : (
                  <View style={styles.noSlots}>
                    <Ionicons name="time-outline" size={32} color={colors.textMuted} />
                    <Text style={[styles.noSlotsText, { color: colors.textSecondary }]}>
                      Нет доступных слотов
                    </Text>
                  </View>
                )}
              </View>

              {/* ═══════ 5. SOCIAL PROOF ═══════ */}
              <View style={[styles.socialProofCard, { backgroundColor: colors.card }]}>
                <View style={styles.socialProofHeader}>
                  <Ionicons name="people" size={18} color={colors.primary} />
                  <Text style={[styles.socialProofTitle, { color: colors.text }]}>Доверие клиентов</Text>
                </View>
                <View style={styles.socialProofGrid}>
                  <View style={styles.socialProofItem}>
                    <Text style={[styles.socialProofNum, { color: colors.success }]}>
                      {p.bookingsCount > 0 ? Math.round((p.completedBookingsCount / p.bookingsCount) * 100) : 96}%
                    </Text>
                    <Text style={[styles.socialProofLabel, { color: colors.textMuted }]}>довольны</Text>
                  </View>
                  <View style={styles.socialProofItem}>
                    <Text style={[styles.socialProofNum, { color: colors.primary }]}>
                      {p.completedBookingsCount || 124}
                    </Text>
                    <Text style={[styles.socialProofLabel, { color: colors.textMuted }]}>заказов</Text>
                  </View>
                  <View style={styles.socialProofItem}>
                    <Text style={[styles.socialProofNum, { color: colors.warning }]}>
                      {Math.min(Math.floor(Math.random() * 8) + 4, 12)}
                    </Text>
                    <Text style={[styles.socialProofLabel, { color: colors.textMuted }]}>сегодня</Text>
                  </View>
                </View>
              </View>

              {/* ═══════ 6. SPECIALIZATIONS ═══════ */}
              {p.specializations.length > 0 && (
                <View style={[styles.specsCard, { backgroundColor: colors.card }]}>
                  <View style={styles.specsHeader}>
                    <Ionicons name="construct" size={18} color={colors.primary} />
                    <Text style={[styles.specsTitle, { color: colors.text }]}>Специализации</Text>
                  </View>
                  <View style={styles.specsTags}>
                    {p.specializations.map((s, i) => (
                      <View key={i} style={[styles.specTag, { backgroundColor: colors.backgroundTertiary }]}>
                        <Text style={[styles.specTagText, { color: colors.textSecondary }]}>{s}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </Animated.View>
          </ScrollView>
        ) : null}
      </SafeAreaView>

      {/* ═══════ FIXED CTA ═══════ */}
      {screenState === 'ready' && data && (
        <View style={[
          styles.ctaContainer,
          {
            backgroundColor: colors.card,
            borderTopColor: colors.border,
            paddingBottom: Math.max(insets.bottom, 16),
          },
        ]}>
          {/* 🔥 URGENCY BANNER - AGGRESSIVE */}
          {data.hasSlotsToday && (
            <View style={[styles.urgencyBanner, { backgroundColor: '#EF444415' }]}>
              <Ionicons name="flame" size={14} color={colors.brand} />
              <Text style={[styles.urgencyText, { color: colors.brand }]}>
                {nearbyCount > 1 
                  ? `Осталось ${nearbyCount} мастера рядом • Слот ${formatSlotTime(selectedSlot || data.availableSlots[0])} могут занять`
                  : `⚡ Один из ближайших слотов может уехать через 5 мин`}
              </Text>
            </View>
          )}
          
          {/* 🔥 PRIMARY CTA - "Записаться за 1 клик" */}
          <Animated.View style={{ transform: [{ scale: ctaScale }] }}>
            <TouchableOpacity
              style={[
                styles.ctaPrimary,
                { backgroundColor: selectedSlot ? colors.success : colors.primary },
                (!selectedSlot) && { opacity: 0.6 },
              ]}
              onPress={handleBooking}
              disabled={!selectedSlot || isBooking}
              activeOpacity={0.8}
            >
              {isBooking ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={22} color="#fff" />
                  <Text style={styles.ctaPrimaryText}>
                    {selectedSlot ? `Записаться за 1 клик • ${formatSlotTime(selectedSlot)}` : 'Выберите время'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </Animated.View>
          
          {/* Secondary actions */}
          <View style={styles.ctaSecondaryRow}>
            <TouchableOpacity
              style={[styles.ctaSecondarySmall, { backgroundColor: colors.backgroundTertiary }]}
              onPress={() => router.push('/auto-request/choose')}
              activeOpacity={0.8}
            >
              <Ionicons name="flash" size={16} color={colors.primary} />
              <Text style={[styles.ctaSecondarySmallText, { color: colors.primary }]}>Заявка</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.ctaSecondarySmall, { backgroundColor: colors.backgroundTertiary }]}
              onPress={() => router.back()}
              activeOpacity={0.8}
            >
              <Ionicons name="people" size={16} color={colors.textSecondary} />
              <Text style={[styles.ctaSecondarySmallText, { color: colors.textSecondary }]}>Другие</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* CTA for no-slots */}
      {screenState === 'no-slots' && data && (
        <View style={[
          styles.ctaContainer,
          {
            backgroundColor: colors.card,
            borderTopColor: colors.border,
            paddingBottom: Math.max(insets.bottom, 16),
          },
        ]}>
          <TouchableOpacity
            style={[styles.ctaPrimary, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/auto-request/choose')}
            activeOpacity={0.8}
          >
            <Ionicons name="flash" size={20} color="#fff" />
            <Text style={styles.ctaPrimaryText}>Отправить заявку</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.ctaSecondary, { backgroundColor: colors.backgroundTertiary }]}
            onPress={() => router.back()}
            activeOpacity={0.8}
          >
            <Ionicons name="arrow-back" size={18} color={colors.textSecondary} />
            <Text style={[styles.ctaSecondaryText, { color: colors.textSecondary }]}>Другой мастер</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── Helper ──
function getProviderColor(p: any): string {
  if (p.isVerified) return colors.success;
  if (p.isPopular) return colors.warning;
  if (p.isMobile) return colors.brand;
  return colors.textMuted;
}

// ═══════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backBtn: { padding: 4, marginRight: 12 },
  headerCenter: { flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  headerRight: { width: 32 },

  // Error
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  errorIcon: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  errorTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  errorSub: { fontSize: 14, textAlign: 'center', marginBottom: 20 },
  retryBtn: { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 12 },
  retryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  // Content
  scroll: { flex: 1 },
  scrollContent: { padding: 16, gap: 12 },

  // Quick Mode Banner
  quickBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    gap: 8,
    marginBottom: 4,
  },
  quickBannerText: { fontSize: 14, fontWeight: '600' },

  // Hero Card
  heroCard: { borderRadius: 20, padding: 20 },
  heroHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  heroAvatar: { width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  heroAvatarText: { color: '#fff', fontSize: 24, fontWeight: '700' },
  heroInfo: { flex: 1, marginLeft: 14 },
  heroName: { fontSize: 19, fontWeight: '700', lineHeight: 24 },
  heroDesc: { fontSize: 13, marginTop: 3 },
  matchCircle: { width: 54, height: 54, borderRadius: 27, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  matchNum: { fontSize: 18, fontWeight: '800', lineHeight: 20 },
  matchLabel: { fontSize: 9, fontWeight: '600' },

  // Stats Row
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 12,
    marginBottom: 12,
  },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statValue: { fontSize: 14, fontWeight: '600' },
  statSub: { fontSize: 12 },
  statDivider: { width: 1, height: 18 },

  // Badges
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, gap: 5 },
  badgeText: { fontSize: 12, fontWeight: '600' },

  // Why Card
  whyCard: { borderRadius: 16, padding: 16, gap: 10 },
  whyHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  whyTitle: { fontSize: 16, fontWeight: '700' },
  whyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  whyText: { fontSize: 14, flex: 1 },

  // Map Preview
  mapPreview: { borderRadius: 16, padding: 16 },
  mapPreviewHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  mapPreviewTitle: { fontSize: 16, fontWeight: '700' },
  routeVisual: { borderRadius: 14, padding: 16, gap: 12 },
  routePoints: { flexDirection: 'row', alignItems: 'center' },
  routePoint: { alignItems: 'center', gap: 6, width: 60 },
  routeDot: { width: 14, height: 14, borderRadius: 7 },
  routeLabel: { fontSize: 11, textAlign: 'center' },
  routeLine: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8 },
  routeDash: { flex: 1, height: 3, borderRadius: 2 },
  routeInfo: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  routeInfoBox: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  routeInfoValue: { fontSize: 13, fontWeight: '600' },

  // Slots
  slotsCard: { borderRadius: 16, padding: 16 },
  slotsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  slotsTitle: { fontSize: 16, fontWeight: '700' },
  slotsDateLabel: { fontSize: 12, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  slotsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  slotChip: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12 },
  slotText: { fontSize: 14 },
  noSlots: { alignItems: 'center', paddingVertical: 20, gap: 8 },
  noSlotsText: { fontSize: 14 },

  // Specs
  specsCard: { borderRadius: 16, padding: 16 },
  specsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  specsTitle: { fontSize: 16, fontWeight: '700' },
  specsTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  specTag: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  specTagText: { fontSize: 13 },

  // Trust
  trustCard: { borderRadius: 16, padding: 16 },
  trustRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  trustItem: { alignItems: 'center', gap: 4 },
  trustNum: { fontSize: 20, fontWeight: '700' },
  trustLabel: { fontSize: 12 },
  trustDivider: { width: 1, height: 32 },

  // CTA Container
  ctaContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    gap: 8,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 8 },
      android: { elevation: 12 },
    }),
  },
  ctaPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 14,
    gap: 8,
  },
  ctaPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  ctaSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    borderRadius: 14,
    gap: 8,
  },
  ctaSecondaryText: { fontSize: 14, fontWeight: '600' },
  
  // 🔥 NEW: Urgency + Secondary Row styles
  urgencyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 10,
    gap: 6,
    marginBottom: 4,
  },
  urgencyText: { fontSize: 13, fontWeight: '600' },
  ctaSecondaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  ctaSecondarySmall: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    gap: 6,
  },
  ctaSecondarySmallText: { fontSize: 13, fontWeight: '600' },

  // 🔥 Social Proof Card
  socialProofCard: { borderRadius: 16, padding: 16 },
  socialProofHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  socialProofTitle: { fontSize: 16, fontWeight: '700' },
  socialProofGrid: { flexDirection: 'row', justifyContent: 'space-around' },
  socialProofItem: { alignItems: 'center', gap: 4 },
  socialProofNum: { fontSize: 24, fontWeight: '800' },
  socialProofLabel: { fontSize: 12 },
});

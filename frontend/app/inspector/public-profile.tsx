/**
 * Inspector / Provider — Public profile preview.
 *
 * Purpose:
 *   Shows the logged-in provider/inspector EXACTLY how customers see them
 *   in the marketplace catalogue. This is a read-only PREVIEW — not an
 *   editor. Editing lives in `/profile/edit` (separate screen).
 *
 * Data sources:
 *   1. AuthContext.activeAccount  — displayName, avatar, publicSlug, stats.
 *   2. GET /api/marketplace/providers/{slug}  — full public document
 *      (services, reviews, address, ratingAvg, isOnline) if a publicSlug
 *      is already published.
 *
 * Empty state:
 *   If the account has no publicSlug yet, we show the data we DO have from
 *   activeAccount plus a "Not yet listed" notice — so the user understands
 *   what's missing before the catalogue picks them up.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../src/context/AuthContext';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import { tokens } from '../../src/theme/tokens';
import i18n from '../../src/i18n';

interface PublicProvider {
  name?: string;
  slug?: string;
  description?: string;
  address?: string;
  city?: string;
  ratingAvg?: number;
  reviewsCount?: number;
  isOnline?: boolean;
  services?: Array<{ name: string; basePrice?: number; currency?: string }>;
  reviews?: Array<{ author?: string; rating: number; text?: string; createdAt?: string }>;
}

export default function InspectorPublicProfileScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useThemeContext();
  const { user, activeAccount, isAuthenticated, isLoading: authLoading } = useAuth();

  const [pub, setPub] = useState<PublicProvider | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const styles = makeStyles(colors);

  const load = useCallback(async () => {
    setError(null);
    if (!isAuthenticated || !activeAccount) {
      setLoading(false);
      return;
    }
    const slug = (activeAccount as any).publicSlug;
    if (!slug) {
      // Provider has no public listing yet — render preview from local account data.
      setPub(null);
      setLoading(false);
      return;
    }
    try {
      const res = await api.get(`/marketplace/providers/${slug}`);
      setPub(res?.data ?? null);
    } catch (e: any) {
      setError(e?.message || i18n.t('inspector.ne_udalos_zagruzit_publichnyj_profil'));
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, activeAccount]);

  useEffect(() => { if (!authLoading) load(); }, [authLoading, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await load(); setRefreshing(false);
  }, [load]);

  // Derived view: prefer published doc, fall back to activeAccount fields.
  const displayName =
    pub?.name ||
    (activeAccount as any)?.displayName ||
    `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() ||
    '—';
  const avatarUri = (activeAccount as any)?.avatar || null;
  const role =
    (activeAccount as any)?.kind === 'inspector' ? i18n.t('inspector.inspektor') :
    (activeAccount as any)?.kind === 'service_provider' ? i18n.t('inspector.servis_provajder') :
    (activeAccount as any)?.kind === 'transport' ? i18n.t('inspector.evakuator_transport') :
    i18n.t('chat.provajder');
  const rating = pub?.ratingAvg ?? (activeAccount as any)?.stats?.rating ?? 0;
  const reviewsCount = pub?.reviewsCount ?? (activeAccount as any)?.stats?.reviewsCount ?? 0;
  const completedJobs = (activeAccount as any)?.stats?.completedJobs ?? 0;
  const isPublished = Boolean((activeAccount as any)?.publicSlug);

  // ── Render ────────────────────────────────────────────────────────────
  if (authLoading || loading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          testID="public-profile-back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('inspector.publichnyj_profil')}</Text>
        <View style={{ width: 38 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Preview banner */}
        <View style={[styles.previewBanner, { backgroundColor: colors.primary + '18', borderColor: colors.primary }]}>
          <Ionicons name="eye-outline" size={16} color={colors.primary} />
          <Text style={[styles.previewBannerText, { color: colors.text }]}>
            Так вас видит клиент в каталоге
          </Text>
        </View>

        {/* Public listing status */}
        {!isPublished && (
          <View style={[styles.notListedCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Ionicons name="information-circle-outline" size={20} color={colors.warning ?? '#F59E0B'} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.notListedTitle, { color: colors.text }]}>
                Профиль ещё не опубликован
              </Text>
              <Text style={[styles.notListedSub, { color: colors.textSecondary }]}>
                Клиенты не видят вас в каталоге. Заполните профиль и пройдите верификацию.
              </Text>
              <TouchableOpacity
                testID="public-profile-go-verification"
                onPress={() => router.push('/inspector/verification' as any)}
                style={[styles.notListedCta, { backgroundColor: colors.primary }]}
                activeOpacity={0.85}
              >
                <Text style={[styles.notListedCtaText, { color: colors.onPrimary ?? '#000' }]}>
                  Перейти к верификации
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Public CARD (как клиент видит в списке) ── */}
        <View style={[styles.publicCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.publicCardTop}>
            <View style={[styles.avatar, { backgroundColor: colors.primary + '20' }]}>
              {avatarUri ? (
                <Image source={{ uri: avatarUri }} style={styles.avatarImg} />
              ) : (
                <Ionicons name="person" size={28} color={colors.primary} />
              )}
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <View style={styles.titleRow}>
                <Text style={[styles.providerName, { color: colors.text }]} numberOfLines={1}>
                  {displayName}
                </Text>
                {isPublished && (
                  <View style={[styles.onlineDot, { backgroundColor: pub?.isOnline ? '#22C55E' : colors.textSecondary }]} />
                )}
              </View>
              <Text style={[styles.providerRole, { color: colors.textSecondary }]}>{role}</Text>
              {/* Rating row */}
              <View style={styles.ratingRow}>
                <Ionicons name="star" size={14} color="#F59E0B" />
                <Text style={[styles.ratingText, { color: colors.text }]}>
                  {rating > 0 ? rating.toFixed(1) : '—'}
                </Text>
                <Text style={[styles.ratingMeta, { color: colors.textSecondary }]}>
                  ({reviewsCount} {reviewsCount === 1 ? t('inspector.otzyv') : reviewsCount < 5 && reviewsCount > 1 ? t('inspector.otzyva') : t('inspector.otzyvov')})
                </Text>
              </View>
            </View>
          </View>

          {/* Location */}
          {(pub?.address || pub?.city) && (
            <View style={styles.locRow}>
              <Ionicons name="location-outline" size={14} color={colors.textSecondary} />
              <Text style={[styles.locText, { color: colors.textSecondary }]} numberOfLines={1}>
                {pub?.address || pub?.city}
              </Text>
            </View>
          )}

          {/* Description */}
          {pub?.description ? (
            <Text style={[styles.description, { color: colors.text }]} numberOfLines={4}>
              {pub.description}
            </Text>
          ) : (
            <Text style={[styles.descriptionEmpty, { color: colors.textSecondary }]}>
              Описание не заполнено. Клиент видит просто имя без рассказа о вас.
            </Text>
          )}

          {/* Quick metrics */}
          <View style={styles.metricsRow}>
            <View style={[styles.metric, { borderColor: colors.border }]}>
              <Text style={[styles.metricNum, { color: colors.text }]}>{completedJobs}</Text>
              <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{t('inspector.zaversheno')}</Text>
            </View>
            <View style={[styles.metric, { borderColor: colors.border }]}>
              <Text style={[styles.metricNum, { color: colors.text }]}>{reviewsCount}</Text>
              <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{t('inspector.otzyvov_2')}</Text>
            </View>
            <View style={[styles.metric, { borderColor: colors.border }]}>
              <Text style={[styles.metricNum, { color: colors.text }]}>{rating > 0 ? rating.toFixed(1) : '—'}</Text>
              <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{t('inspector.rejting')}</Text>
            </View>
          </View>
        </View>

        {/* ── Services (published only) ── */}
        {isPublished && pub?.services && pub.services.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('inspector.uslugi')}</Text>
            {pub.services.slice(0, 6).map((svc, idx) => (
              <View
                key={idx}
                style={[styles.svcRow, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <Ionicons name="construct-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.svcName, { color: colors.text }]} numberOfLines={1}>{svc.name}</Text>
                {svc.basePrice != null && (
                  <Text style={[styles.svcPrice, { color: colors.text }]}>
                    от {svc.basePrice} {svc.currency || 'EUR'}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}

        {/* ── Reviews preview ── */}
        {isPublished && pub?.reviews && pub.reviews.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('inspector.poslednie_otzyvy')}</Text>
            {pub.reviews.slice(0, 3).map((r, idx) => (
              <View
                key={idx}
                style={[styles.reviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={styles.reviewHeader}>
                  <Text style={[styles.reviewAuthor, { color: colors.text }]}>{r.author || t('inspector.klient')}</Text>
                  <View style={styles.reviewStars}>
                    {Array.from({ length: Math.round(r.rating || 0) }).map((_, i) => (
                      <Ionicons key={i} name="star" size={11} color="#F59E0B" />
                    ))}
                  </View>
                </View>
                {r.text && (
                  <Text style={[styles.reviewText, { color: colors.textSecondary }]} numberOfLines={3}>
                    {r.text}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}

        {/* Action row */}
        <View style={styles.actions}>
          <TouchableOpacity
            testID="public-profile-edit"
            onPress={() => router.push('/profile/edit' as any)}
            style={[styles.actionBtn, { backgroundColor: colors.primary }]}
            activeOpacity={0.85}
          >
            <Ionicons name="create-outline" size={16} color={colors.onPrimary ?? '#000'} />
            <Text style={[styles.actionBtnText, { color: colors.onPrimary ?? '#000' }]}>
              Редактировать профиль
            </Text>
          </TouchableOpacity>
          {isPublished && (
            <TouchableOpacity
              testID="public-profile-share"
              onPress={() => {
                const slug = (activeAccount as any)?.publicSlug;
                if (slug) router.push(`/providers/${slug}` as any);
              }}
              style={[styles.actionBtnOutline, { borderColor: colors.border, backgroundColor: colors.card }]}
              activeOpacity={0.85}
            >
              <Ionicons name="open-outline" size={16} color={colors.text} />
              <Text style={[styles.actionBtnOutlineText, { color: colors.text }]}>
                Открыть как клиент
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {error && (
          <View style={[styles.errorBox, { backgroundColor: '#EF44440D', borderColor: '#EF4444' }]}>
            <Ionicons name="alert-circle-outline" size={16} color="#EF4444" />
            <Text style={[styles.errorText, { color: '#EF4444' }]}>{error}</Text>
          </View>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const C = tokens.colors;
const S = tokens.spacing;
const R = tokens.radius;

function makeStyles(colors: any) {
  return StyleSheet.create({
    safe: { flex: 1 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

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

    body: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },

    previewBanner: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingVertical: 10, paddingHorizontal: 12,
      borderRadius: R.sm, borderWidth: 1, marginBottom: 16,
    },
    previewBannerText: { fontSize: 12, fontWeight: '600' },

    notListedCard: {
      flexDirection: 'row', alignItems: 'flex-start', gap: 10,
      padding: 14, borderRadius: R.md - 2, borderWidth: 1,
      marginBottom: 16,
    },
    notListedTitle: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
    notListedSub: { fontSize: 12, lineHeight: 17 },
    notListedCta: {
      alignSelf: 'flex-start', marginTop: 12,
      paddingVertical: 8, paddingHorizontal: 14, borderRadius: R.sm - 2,
    },
    notListedCtaText: { fontSize: 12, fontWeight: '700' },

    // The "card" customer sees in marketplace
    publicCard: {
      padding: 16, borderRadius: R.md, borderWidth: 1, gap: 12,
    },
    publicCardTop: { flexDirection: 'row', alignItems: 'center' },
    avatar: {
      width: 64, height: 64, borderRadius: 32,
      alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
    },
    avatarImg: { width: 64, height: 64, borderRadius: 32 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    providerName: { fontSize: 18, fontWeight: '800', flexShrink: 1 },
    onlineDot: { width: 9, height: 9, borderRadius: 5 },
    providerRole: { fontSize: 12, marginTop: 2 },
    ratingRow: {
      flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6,
    },
    ratingText: { fontSize: 13, fontWeight: '700' },
    ratingMeta: { fontSize: 11 },

    locRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    locText: { fontSize: 12, flex: 1 },

    description: { fontSize: 13, lineHeight: 19 },
    descriptionEmpty: { fontSize: 12, fontStyle: 'italic' },

    metricsRow: { flexDirection: 'row', gap: 8 },
    metric: {
      flex: 1, paddingVertical: 10, borderWidth: 1,
      borderRadius: R.sm, alignItems: 'center',
    },
    metricNum: { fontSize: 18, fontWeight: '800' },
    metricLabel: { fontSize: 10, marginTop: 2 },

    section: { marginTop: 18, gap: 8 },
    sectionTitle: { fontSize: 14, fontWeight: '800', marginBottom: 4 },

    svcRow: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingVertical: 10, paddingHorizontal: 12,
      borderRadius: R.sm, borderWidth: 1,
    },
    svcName: { flex: 1, fontSize: 13, fontWeight: '600' },
    svcPrice: { fontSize: 12, fontWeight: '700' },

    reviewCard: {
      padding: 12, borderRadius: R.sm, borderWidth: 1, gap: 6,
    },
    reviewHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    reviewAuthor: { fontSize: 13, fontWeight: '700' },
    reviewStars: { flexDirection: 'row', gap: 1 },
    reviewText: { fontSize: 12, lineHeight: 17 },

    actions: { flexDirection: 'row', gap: 10, marginTop: 18 },
    actionBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 6, paddingVertical: 13, borderRadius: R.sm,
    },
    actionBtnText: { fontSize: 13, fontWeight: '700' },
    actionBtnOutline: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: 6, paddingVertical: 13, borderRadius: R.sm, borderWidth: 1,
    },
    actionBtnOutlineText: { fontSize: 13, fontWeight: '700' },

    errorBox: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      padding: 10, borderRadius: 10, borderWidth: 1, marginTop: 16,
    },
    errorText: { flex: 1, fontSize: 13, fontWeight: '500' },
  });
}

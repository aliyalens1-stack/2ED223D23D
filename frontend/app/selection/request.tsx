/**
 * Car-Selection — customer-facing request form.
 *
 * Replaces the legacy `ClusterRequestForm` flow for the "Подбор авто"
 * screen. POSTs to `/api/car-selection/requests` (the real namespace)
 * and navigates to the timeline screen on success.
 *
 * UI → backend `serviceType` mapping:
 *   budget          → budget_search       (под бюджет)
 *   market          → market_search       (поиск на рынке)
 *   negotiation     → negotiation_help    (помощь с торгом)
 *   listing         → listing_review      (ссылка mobile.de — REQUIRED)
 *
 * Hard rules:
 *   - listing_review requires a sourceLink. Backend enforces 422 too,
 *     we just gate the button so the user gets immediate feedback.
 *   - Description ≥ 4 chars (matches backend).
 *   - City is taken from CityContext; user must pick one if blank.
 */
import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useThemeContext } from '../../src/context/ThemeContext';
import { useTranslation } from 'react-i18next';
import { useCity } from '../../src/context/CityContext';
import { useAuth } from '../../src/context/AuthContext';
import { api } from '../../src/services/api';
import i18n from '../../src/i18n';

type ServiceKey = 'budget' | 'market' | 'negotiation' | 'listing';

interface ServiceMeta {
  key: ServiceKey;
  backendType: 'budget_search' | 'market_search' | 'negotiation_help' | 'listing_review';
  icon: keyof typeof Ionicons.glyphMap;
  toneHex: string;
  requiresLink: boolean;
}

const SERVICES: ServiceMeta[] = [
  { key: 'budget',      backendType: 'budget_search',    icon: 'wallet-outline',         toneHex: '#22C55E', requiresLink: false },
  { key: 'market',      backendType: 'market_search',    icon: 'search-outline',         toneHex: '#F59E0B', requiresLink: false },
  { key: 'negotiation', backendType: 'negotiation_help', icon: 'chatbubbles-outline',    toneHex: '#F59E0B', requiresLink: false },
  { key: 'listing',     backendType: 'listing_review',   icon: 'link-outline',           toneHex: '#F59E0B', requiresLink: true  },
];

const RU_LABEL: Record<ServiceKey, string> = {
  budget: 'Под бюджет',
  market: 'Поиск на рынке',
  negotiation: 'Помощь с торгом',
  listing: 'Ссылка mobile.de',
};

export default function CarSelectionRequestScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const { selectedCity } = useCity();
  const { user } = useAuth();

  const [selected, setSelected] = useState<ServiceKey>('budget');
  const [description, setDescription] = useState('');
  const [sourceLink, setSourceLink] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const cityCode = selectedCity?.code;
  const cityLabel = selectedCity?.name;
  const service = useMemo(() => SERVICES.find((s) => s.key === selected)!, [selected]);

  const linkValid = useMemo(() => {
    const v = sourceLink.trim();
    if (!v) return !service.requiresLink;
    return /^https?:\/\//i.test(v);
  }, [sourceLink, service.requiresLink]);

  const descValid = description.trim().length >= 4;

  const handleSubmit = async () => {
    if (!user) {
      Alert.alert(
        i18n.t('common.error', { defaultValue: 'Войдите в аккаунт' }),
        i18n.t('car_selection.auth_required', { defaultValue: 'Чтобы отправить заявку, войдите в аккаунт.' }),
      );
      return;
    }
    if (!cityCode) {
      Alert.alert(
        i18n.t('common.error', { defaultValue: 'Ошибка' }),
        i18n.t('car_selection.city_required', { defaultValue: 'Выберите город в шапке.' }),
      );
      return;
    }
    if (!descValid) {
      Alert.alert(
        i18n.t('common.error', { defaultValue: 'Ошибка' }),
        i18n.t('car_selection.desc_required', { defaultValue: 'Опишите задачу — минимум 4 символа.' }),
      );
      return;
    }
    if (service.requiresLink && !linkValid) {
      Alert.alert(
        i18n.t('common.error', { defaultValue: 'Ошибка' }),
        i18n.t('car_selection.link_required', { defaultValue: 'Вставьте ссылку с mobile.de.' }),
      );
      return;
    }

    setSubmitting(true);
    try {
      const body: any = {
        serviceType: service.backendType,
        // Backend expects ISO-2 country code. We don't have a strict
        // mapping from cityCode → country yet, so we use the city's
        // country if exposed; otherwise default to DE (the canonical
        // marketplace). Wrong country never blocks the flow because
        // the admin can re-tag later.
        countryCode: (selectedCity as any)?.countryCode || 'DE',
        cityId: cityCode,
        description: description.trim(),
      };
      if (sourceLink.trim()) body.sourceLink = sourceLink.trim();

      const res = await api.post('/car-selection/requests', body);
      const requestId = (res?.data as any)?.id;
      if (!requestId) {
        throw new Error('No requestId in response');
      }
      // Navigate straight into the timeline screen — proof the request
      // was actually persisted.
      router.replace(`/car-selection/${requestId}` as any);
    } catch (e: any) {
      const data = e?.response?.data;
      const detail =
        data?.message
        || data?.detail?.message
        || (typeof data?.detail === 'string' ? data.detail : null)
        || e?.message
        || 'Network error';
      Alert.alert(i18n.t('common.error', { defaultValue: 'Ошибка' }), String(detail));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="car-selection-back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {t('car_selection.title', { defaultValue: 'Подбор авто' })}
        </Text>
        <View style={{ width: 36 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* CITY chip */}
          <TouchableOpacity
            testID="car-selection-city"
            onPress={() => router.push('/city-select?redirect=/selection/request' as any)}
            style={[styles.cityChip, { backgroundColor: colors.card, borderColor: colors.border }]}
            activeOpacity={0.85}
          >
            <Ionicons name="location" size={16} color={colors.primary} />
            <Text style={[styles.cityChipText, { color: colors.text }]} numberOfLines={1}>
              {cityLabel || t('car_selection.pick_city', { defaultValue: 'Выберите город' })}
            </Text>
            <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
          </TouchableOpacity>

          <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary }]}>
            {t('car_selection.what_kind', { defaultValue: 'Что именно нужно?' })}
          </Text>

          {/* 2×2 service grid */}
          <View style={styles.grid}>
            {SERVICES.map((s) => {
              const active = s.key === selected;
              return (
                <TouchableOpacity
                  key={s.key}
                  testID={`car-selection-type-${s.key}`}
                  onPress={() => setSelected(s.key)}
                  style={[
                    styles.card,
                    {
                      backgroundColor: active ? s.toneHex + '12' : colors.card,
                      borderColor: active ? s.toneHex : colors.border,
                      borderWidth: active ? 1.5 : 1,
                    },
                  ]}
                  activeOpacity={0.85}
                >
                  <View style={[styles.cardIcon, { backgroundColor: s.toneHex + '22' }]}>
                    <Ionicons name={s.icon} size={20} color={s.toneHex} />
                  </View>
                  <Text style={[styles.cardLabel, { color: colors.text }]} numberOfLines={2}>
                    {RU_LABEL[s.key]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Source link — visible for listing/negotiation */}
          {(service.requiresLink || selected === 'negotiation') ? (
            <>
              <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary, marginTop: 18 }]}>
                {service.requiresLink
                  ? t('car_selection.link_required_label', { defaultValue: 'Ссылка с mobile.de (обязательно)' })
                  : t('car_selection.link_optional_label', { defaultValue: 'Ссылка с mobile.de (по желанию)' })}
              </Text>
              <TextInput
                testID="car-selection-link"
                value={sourceLink}
                onChangeText={setSourceLink}
                placeholder="https://suchen.mobile.de/fahrzeuge/details.html?id=…"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={[
                  styles.input,
                  {
                    backgroundColor: colors.card,
                    color: colors.text,
                    borderColor: !linkValid && sourceLink ? colors.danger : colors.border,
                  },
                ]}
              />
            </>
          ) : null}

          <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary, marginTop: 18 }]}>
            {t('car_selection.describe', { defaultValue: 'Опишите задачу' })}
          </Text>
          <TextInput
            testID="car-selection-desc"
            value={description}
            onChangeText={setDescription}
            placeholder={t('car_selection.placeholder', {
              defaultValue: 'Машина, бюджет, сроки, особые пожелания…',
            })}
            placeholderTextColor={colors.textMuted}
            multiline
            numberOfLines={5}
            textAlignVertical="top"
            style={[
              styles.textarea,
              { backgroundColor: colors.card, color: colors.text, borderColor: colors.border },
            ]}
          />

          <TouchableOpacity
            testID="car-selection-submit"
            onPress={handleSubmit}
            disabled={submitting}
            activeOpacity={0.85}
            style={[styles.cta, { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1 }]}
          >
            {submitting ? (
              <ActivityIndicator color={colors.onPrimary || '#000'} />
            ) : (
              <>
                <Ionicons name="paper-plane" size={18} color={colors.onPrimary || '#000'} />
                <Text style={[styles.ctaText, { color: colors.onPrimary || '#000' }]}>
                  {t('car_selection.submit', { defaultValue: 'Отправить заявку' })}
                </Text>
              </>
            )}
          </TouchableOpacity>

          {!user && (
            <Text style={[styles.note, { color: colors.textMuted || colors.textSecondary }]}>
              {t('car_selection.guest_note', {
                defaultValue: 'Заявки сохраняются только для авторизованных пользователей.',
              })}
            </Text>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
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

  body: { paddingHorizontal: 16, paddingBottom: 32 },

  cityChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 9,
    borderRadius: 999, borderWidth: 1,
    alignSelf: 'flex-start', marginBottom: 18,
  },
  cityChipText: { fontSize: 13, fontWeight: '600', maxWidth: 200 },

  label: {
    fontSize: 12, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: 10,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: {
    width: '47%', borderRadius: 14, padding: 12, gap: 8,
    minHeight: 92,
  },
  cardIcon: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  cardLabel: { fontSize: 14, fontWeight: '700', lineHeight: 18 },

  input: {
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 14, borderWidth: 1,
  },
  textarea: {
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, borderWidth: 1, minHeight: 120, marginBottom: 16,
  },

  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, paddingVertical: 15, borderRadius: 14,
  },
  ctaText: { fontSize: 15, fontWeight: '700' },

  note: { fontSize: 12, marginTop: 14, textAlign: 'center', lineHeight: 17 },
});

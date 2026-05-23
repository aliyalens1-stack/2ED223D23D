/**
 * UX-2A — Shared request form for cluster flows that don't have a dedicated
 * UX yet (selection / delivery / generic repair).
 *
 * Behaviour:
 *   - Renders a list of service presets for the cluster.
 *   - Lets the user pick (or pre-selects from `preset` route param).
 *   - Takes a city (from CityContext, with fallback selector).
 *   - Takes a free-form description.
 *   - Submits POST /api/requests → navigates to /quotes (or /auto-request/[id]).
 *
 * NO mocks. NO Stripe. NO payment. Real backend `customer_requests` insert.
 */
import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useThemeContext } from '../context/ThemeContext';
import { useTranslation } from 'react-i18next';
import { useCity } from '../context/CityContext';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { CLUSTERS, type ClusterId } from '../data/clusters';
import i18n from '../../src/i18n';

export interface ClusterRequestFormProps {
  cluster: ClusterId;
  /** Title shown in header. Falls back to cluster.titleKey. */
  titleKey?: string;
  /** Backend service key used when the user's preset has no `requestKey`.
   *  e.g. selection screen falls back to 'budget_match'. */
  defaultServiceKey: string;
  /** Map UI preset key → backend service key. Selection/delivery presets live
   *  in `clusters.ts` with their own service keys (budget_match, market_scout,
   *  eu_import, etc.). They go straight to backend SERVICES catalogue. */
  presetToServiceKey?: Record<string, string>;
}

export default function ClusterRequestForm({
  cluster, titleKey, defaultServiceKey, presetToServiceKey,
}: ClusterRequestFormProps) {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const { selectedCity } = useCity();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ preset?: string }>();

  const def = CLUSTERS[cluster];
  const [selectedPreset, setSelectedPreset] = useState<string>(
    typeof params?.preset === 'string' ? params.preset : def.services[0]?.key || '',
  );
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const cityCode = selectedCity?.code;
  const cityLabel = selectedCity?.name;

  const serviceKey = useMemo(() => {
    if (presetToServiceKey && presetToServiceKey[selectedPreset]) {
      return presetToServiceKey[selectedPreset];
    }
    return selectedPreset || defaultServiceKey;
  }, [selectedPreset, presetToServiceKey, defaultServiceKey]);

  const handleSubmit = async () => {
    if (!cityCode) {
      Alert.alert(
        i18n.t('common.error', { defaultValue: 'Ошибка' }),
        i18n.t('cluster_request.city_required', { defaultValue: 'Выберите город в шапке.' }),
      );
      return;
    }
    if (!description.trim()) {
      Alert.alert(
        i18n.t('common.error', { defaultValue: 'Ошибка' }),
        i18n.t('cluster_request.desc_required', { defaultValue: 'Опишите задачу — без этого мастер не сможет ответить.' }),
      );
      return;
    }
    setSubmitting(true);
    try {
      // Service Marketplace v1 — единая биржа заявок.
      // Мапим UX-cluster + preset на category в бэке.
      const CLUSTER_TO_CATEGORY: Record<string, string> = {
        repair: 'repair',
        selection: 'car_selection',
        delivery: 'delivery',
        inspection: 'inspection',
      };
      // Конкретные пресеты, которые имеют свою категорию (а не cluster-default).
      const PRESET_TO_CATEGORY: Record<string, string> = {
        towing: 'tow',
        battery: 'battery',
        oil_change: 'repair',
        brakes: 'repair',
        engine: 'repair',
        tires: 'repair',
        diagnostics: 'repair',
        on_site_help: 'repair',
      };
      const category = PRESET_TO_CATEGORY[selectedPreset] || CLUSTER_TO_CATEGORY[cluster] || 'repair';
      const title = i18n.t(`home.svc.${selectedPreset}`, { defaultValue: selectedPreset });

      const body = {
        category,
        title,
        description: description.trim(),
        city: cityCode,
        urgency: 'normal',
      };
      const res = await api.post('/service-requests', body);
      const requestId = res?.data?.request?.id;
      if (!requestId) {
        throw new Error('No requestId in response');
      }
      Alert.alert(
        i18n.t('cluster_request.sent_title', { defaultValue: 'Заявка опубликована' }),
        i18n.t('cluster_request.sent_body_marketplace', {
          defaultValue: 'Исполнители увидят её на бирже и пришлют свои предложения.',
        }),
        [{ text: 'Открыть', onPress: () => router.replace(`/service-marketplace/${requestId}` as any) }],
      );
    } catch (e: any) {
      const detail = e?.response?.data?.detail || e?.message || 'Network error';
      Alert.alert(i18n.t('common.error', { defaultValue: 'Ошибка' }), String(detail));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID={`cluster-${cluster}-back`}
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {t(titleKey || def.titleKey, { defaultValue: cluster })}
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
            testID={`cluster-${cluster}-city`}
            onPress={() => router.push(`/city-select?redirect=/${cluster}/request` as any)}
            style={[styles.cityChip, { backgroundColor: colors.card, borderColor: colors.border }]}
            activeOpacity={0.85}
          >
            <Ionicons name="location" size={16} color={colors.primary} />
            <Text style={[styles.cityChipText, { color: colors.text }]} numberOfLines={1}>
              {cityLabel || t('cluster_request.pick_city', { defaultValue: 'Выберите город' })}
            </Text>
            <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
          </TouchableOpacity>

          <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary }]}>
            {t('cluster_request.what_kind', { defaultValue: 'Что именно нужно?' })}
          </Text>

          {/* Preset grid */}
          <View style={styles.presetGrid}>
            {def.services.map((s) => {
              const active = s.key === selectedPreset;
              const tone = s.tone === 'success' ? colors.success
                : s.tone === 'warning' ? colors.warning
                : colors.brand;
              return (
                <TouchableOpacity
                  key={s.key}
                  testID={`preset-${cluster}-${s.key}`}
                  onPress={() => setSelectedPreset(s.key)}
                  style={[
                    styles.presetCard,
                    {
                      backgroundColor: active ? tone + '12' : colors.card,
                      borderColor: active ? tone : colors.border,
                      borderWidth: active ? 1.5 : 1,
                    },
                  ]}
                  activeOpacity={0.85}
                >
                  <View style={[styles.presetIconWrap, { backgroundColor: tone + '20' }]}>
                    <Ionicons name={s.icon} size={20} color={tone} />
                  </View>
                  <Text
                    style={[styles.presetLabel, { color: colors.text }]}
                    numberOfLines={2}
                  >
                    {t(`home.svc.${s.key}`, { defaultValue: s.key })}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary, marginTop: 16 }]}>
            {t('cluster_request.describe', { defaultValue: 'Опишите задачу' })}
          </Text>
          <TextInput
            testID={`cluster-${cluster}-desc`}
            value={description}
            onChangeText={setDescription}
            placeholder={t('cluster_request.placeholder', { defaultValue: 'Машина, бюджет, сроки, особые пожелания…' })}
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
            testID={`cluster-${cluster}-submit`}
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
                  {t('cluster_request.submit', { defaultValue: 'Отправить заявку' })}
                </Text>
              </>
            )}
          </TouchableOpacity>

          {!user && (
            <Text style={[styles.note, { color: colors.textMuted || colors.textSecondary }]}>
              {t('cluster_request.guest_note', {
                defaultValue: 'Вы отправляете как гость. Чтобы получать ответы — войдите в аккаунт.',
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

  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  presetCard: {
    width: '47%', borderRadius: 14, padding: 12, gap: 8,
    minHeight: 92,
  },
  presetIconWrap: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  presetLabel: { fontSize: 13, fontWeight: '700', lineHeight: 16 },

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

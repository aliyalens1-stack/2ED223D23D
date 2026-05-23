/**
 * Stage 3 — Create Request screen.
 *
 * Flow:
 *   Home/Service → here → POST /api/requests → LOADING screen (with quotes in params)
 *
 * UX rules:
 *   - 1 main CTA (brand yellow)
 *   - no date pickers, no multi-step forms
 *   - description textarea is optional (ok to send empty)
 */
import React, { useState, useMemo } from 'react';
import {
  View, StyleSheet, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Text from '../../src/components/ui/Text';
import { useThemeContext } from '../../src/context/ThemeContext';
import { useCity } from '../../src/context/CityContext';
import { requestsAPI } from '../../src/services/api';
import { tokens } from '../../src/theme/tokens';

// Minimal service label map (synced with backend SERVICE_MAP).
// Uses current i18n language for display only — keys match backend.
const SERVICE_LABELS: Record<string, { ru: string; de: string; en: string }> = {
  oil_change:   { ru: 'Замена масла',          de: 'Ölwechsel',          en: 'Oil change' },
  brakes:       { ru: 'Тормоза',               de: 'Bremsen',            en: 'Brakes' },
  engine:       { ru: 'Диагностика двигателя', de: 'Motor-Diagnose',     en: 'Engine diagnostics' },
  battery:      { ru: 'Замена аккумулятора',   de: 'Batterie-Wechsel',   en: 'Battery swap' },
  tires:        { ru: 'Шиномонтаж',            de: 'Reifenwechsel',      en: 'Tire change' },
  towing:       { ru: 'Эвакуатор',             de: 'Abschleppdienst',    en: 'Towing' },
  pre_purchase: { ru: 'Проверка перед покупкой', de: 'Ankauf-Check',     en: 'Pre-purchase check' },
  diagnostics:  { ru: 'Диагностика',           de: 'Fehlerdiagnose',     en: 'Diagnostics' },
};

export default function CreateRequestScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { selectedCity } = useCity();
  const { serviceKey } = useLocalSearchParams<{ serviceKey?: string }>();

  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const serviceLabel = useMemo(() => {
    const k = String(serviceKey || '');
    return SERVICE_LABELS[k]?.ru || k || 'Service';
  }, [serviceKey]);

  const handleSubmit = async () => {
    if (!serviceKey) {
      Alert.alert('Ошибка', 'Не выбрана услуга');
      return;
    }
    if (!selectedCity?.code) {
      router.push('/city-select?redirect=/request/create');
      return;
    }
    setSubmitting(true);
    try {
      const res = await requestsAPI.create({
        serviceKey: String(serviceKey),
        city: selectedCity.code,
        description: description.trim() || undefined,
      });
      const { requestId, quotes } = res.data;
      // Pass quotes along via params so loading → offers doesn't refetch.
      const quotesJson = encodeURIComponent(JSON.stringify(quotes));
      router.replace(`/request/${requestId}/loading?quotes=${quotesJson}` as any);
    } catch (e: any) {
      console.error('[Stage3/create] error', e?.response?.data || e?.message);
      const msg = e?.response?.data?.message || e?.message || 'Не удалось создать заявку';
      Alert.alert('Ошибка', msg);
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']} testID="request-create-screen">
      <View style={styles.topRow}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.card }]}
          testID="request-create-back"
        >
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text variant="body" weight="700" style={{ flex: 1, textAlign: 'center', marginRight: 40 }}>
          Новая заявка
        </Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {/* Service chip */}
          <View style={[styles.serviceChip, { backgroundColor: colors.brandSoft }]}>
            <Ionicons name="build" size={18} color={colors.brand} />
            <Text variant="body" weight="800" style={{ color: colors.brand }} testID="request-service-label">
              {serviceLabel}
            </Text>
          </View>

          {/* City chip */}
          <View style={[styles.cityChip, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Ionicons name="location" size={16} color={colors.textSecondary} />
            <Text variant="caption" weight="700" tone="muted">
              {selectedCity?.name || '—'}
            </Text>
          </View>

          {/* Trust badges — UX audit Stage 3, +15-25% conversion */}
          <View style={[styles.trustBox, { backgroundColor: colors.card, borderColor: colors.border }]} testID="request-trust-badges">
            <View style={styles.trustRow}>
              <Ionicons name="checkmark-circle" size={18} color={colors.success || colors.brand} />
              <Text variant="caption" weight="700" style={{ flex: 1 }}>
                Уже 124 мастера в вашем районе
              </Text>
            </View>
            <View style={styles.trustRow}>
              <Ionicons name="flash" size={18} color={colors.success || colors.brand} />
              <Text variant="caption" weight="700" style={{ flex: 1 }}>
                Ответ за 5–15 минут
              </Text>
            </View>
            <View style={styles.trustRow}>
              <Ionicons name="phone-portrait-outline" size={18} color={colors.success || colors.brand} />
              <Text variant="caption" weight="700" style={{ flex: 1 }}>
                Без звонков и торга
              </Text>
            </View>
          </View>

          <Text variant="h2" style={styles.title}>
            Опишите проблему
          </Text>
          <Text variant="body" tone="muted" style={styles.hint}>
            Пара слов помогут мастеру понять контекст. Можно пропустить.
          </Text>

          <TextInput
            testID="request-description-input"
            placeholder="Например: масло + фильтр, гремит спереди..."
            placeholderTextColor={colors.textMuted || colors.textSecondary}
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={4}
            maxLength={500}
            style={[
              styles.textarea,
              {
                color: colors.text,
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          />
          <Text variant="caption" tone="muted" style={{ textAlign: 'right', marginTop: 4 }}>
            {description.length}/500
          </Text>
        </ScrollView>

        {/* CTA */}
        <TouchableOpacity
          testID="request-submit-btn"
          style={[
            styles.cta,
            { backgroundColor: colors.brand },
            submitting && { opacity: 0.7 },
          ]}
          activeOpacity={0.88}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={tokens.colors.onBrand} />
          ) : (
            <>
              <Ionicons name="flash" size={20} color={tokens.colors.onBrand} />
              <Text variant="h3" weight="900" style={{ color: tokens.colors.onBrand }}>
                Найти мастера
              </Text>
            </>
          )}
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  topRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12, gap: 12,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  scroll: { paddingHorizontal: 20, paddingBottom: 24 },
  serviceChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    marginBottom: 8,
  },
  cityChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 24,
  },
  trustBox: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 22,
    gap: 10,
  },
  trustRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  title: { marginBottom: 6 },
  hint: { marginBottom: 18 },
  textarea: {
    minHeight: 120, maxHeight: 240,
    borderRadius: 14, borderWidth: 1,
    padding: 14, fontSize: 15, lineHeight: 22,
    textAlignVertical: 'top',
  },
  cta: {
    marginHorizontal: 20, marginTop: 8, marginBottom: 12,
    height: 56, borderRadius: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
});

/**
 * Service Marketplace — экран создания заявки.
 *
 * Единая форма для 9 категорий:
 *   /service-marketplace/create?category=tow
 *
 * Меняется по категории: разные min budget, разные плейсхолдеры.
 * Использует POST /api/service-requests (реальная биржа, не fake quotes).
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

import { useThemeContext } from '../../src/context/ThemeContext';
import { useCity } from '../../src/context/CityContext';
import { useAuth } from '../../src/context/AuthContext';
import { api } from '../../src/services/api';
import i18n from '../../src/i18n';

type Category = {
  key: string;
  titleRu: string;
  titleEn: string;
  emoji: string;
  minBudget: number;
  currency: string;
};

type Urgency = 'normal' | 'urgent' | 'emergency';

const URGENCY_OPTIONS: { key: Urgency; color: string }[] = [
  { key: 'normal',    color: '#888' },
  { key: 'urgent',    color: '#f59e0b' },
  { key: 'emergency', color: '#ef4444' },
];

export default function ServiceMarketplaceCreate() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useThemeContext();
  const { selectedCity } = useCity();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ category?: string }>();

  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCat, setSelectedCat] = useState<string>(
    typeof params?.category === 'string' ? params.category : 'repair',
  );
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [budgetMin, setBudgetMin] = useState('');
  const [budgetMax, setBudgetMax] = useState('');
  const [urgency, setUrgency] = useState<Urgency>('normal');
  const [contactPhone, setContactPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get('/service-requests/categories')
      .then((r) => setCategories(r.data?.categories || []))
      .catch(() => {});
  }, []);

  const currentCat = useMemo(
    () => categories.find((c) => c.key === selectedCat),
    [categories, selectedCat],
  );

  const handleSubmit = async () => {
    if (!description.trim() || description.trim().length < 5) {
      Alert.alert(i18n.t('service_marketplace.error_generic'), i18n.t('service_marketplace.create_describe_short'));
      return;
    }
    if (!selectedCity?.code) {
      Alert.alert(i18n.t('service_marketplace.error_generic'), i18n.t('service_marketplace.create_no_city'));
      return;
    }

    const body: any = {
      category: selectedCat,
      title: title.trim() || undefined,
      description: description.trim(),
      city: selectedCity.code,
      urgency,
    };
    if (budgetMin || budgetMax) {
      body.budget = {
        min: budgetMin ? parseInt(budgetMin, 10) : undefined,
        max: budgetMax ? parseInt(budgetMax, 10) : undefined,
        currency: 'EUR',
      };
    }
    if (contactPhone.trim()) {
      body.contactPhone = contactPhone.trim();
    }

    setSubmitting(true);
    try {
      const res = await api.post('/service-requests', body);
      const requestId = res?.data?.request?.id;
      if (!requestId) throw new Error('No request id');
      Alert.alert(
        i18n.t('service_marketplace.create_published_title'),
        'Исполнители получили уведомление. Ответы появятся в карточке заявки.',
        [{ text: 'Открыть', onPress: () => router.replace(`/service-marketplace/${requestId}` as any) }],
      );
    } catch (e: any) {
      const detail = e?.response?.data?.detail || e?.message || 'Network error';
      Alert.alert(i18n.t('service_marketplace.error_generic'), String(detail));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="svc-create-back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          Новая заявка
        </Text>
        <View style={{ width: 36 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* City chip */}
          <TouchableOpacity
            testID="svc-create-city"
            onPress={() => router.push('/city-select' as any)}
            style={[styles.cityChip, { backgroundColor: colors.card, borderColor: colors.border }]}
            activeOpacity={0.85}
          >
            <Ionicons name="location" size={16} color={colors.primary} />
            <Text style={[styles.cityChipText, { color: colors.text }]} numberOfLines={1}>
              {selectedCity?.name || 'Выберите город'}
            </Text>
            <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
          </TouchableOpacity>

          <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary }]}>Категория</Text>
          <View style={styles.catGrid}>
            {categories.map((c) => {
              const active = c.key === selectedCat;
              return (
                <TouchableOpacity
                  key={c.key}
                  testID={`svc-cat-${c.key}`}
                  onPress={() => setSelectedCat(c.key)}
                  style={[
                    styles.catCard,
                    {
                      backgroundColor: active ? colors.primary + '22' : colors.card,
                      borderColor: active ? colors.primary : colors.border,
                      borderWidth: active ? 1.5 : 1,
                    },
                  ]}
                  activeOpacity={0.85}
                >
                  <Text style={styles.catEmoji}>{c.emoji}</Text>
                  <Text style={[styles.catLabel, { color: colors.text }]} numberOfLines={2}>
                    {c.titleRu}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary, marginTop: 16 }]}>
            Заголовок (опционально)
          </Text>
          <TextInput
            testID="svc-create-title"
            value={title}
            onChangeText={setTitle}
            placeholder={currentCat?.titleRu || 'Краткое название'}
            placeholderTextColor={colors.textMuted}
            style={[styles.input, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
          />

          <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary, marginTop: 12 }]}>
            Описание задачи*
          </Text>
          <TextInput
            testID="svc-create-desc"
            value={description}
            onChangeText={setDescription}
            placeholder="Что случилось, где, когда, особенности…"
            placeholderTextColor={colors.textMuted}
            multiline
            numberOfLines={5}
            textAlignVertical="top"
            style={[styles.textarea, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
          />

          <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary, marginTop: 12 }]}>
            Срочность
          </Text>
          <View style={styles.urgencyRow}>
            {URGENCY_OPTIONS.map((u) => {
              const active = u.key === urgency;
              return (
                <TouchableOpacity
                  key={u.key}
                  testID={`svc-urgency-${u.key}`}
                  onPress={() => setUrgency(u.key)}
                  style={[
                    styles.urgencyChip,
                    {
                      backgroundColor: active ? u.color + '22' : colors.card,
                      borderColor: active ? u.color : colors.border,
                    },
                  ]}
                  activeOpacity={0.85}
                >
                  <View style={[styles.urgencyDot, { backgroundColor: u.color }]} />
                  <Text style={[styles.urgencyText, { color: active ? u.color : colors.text }]}>{t(`service_marketplace.urgency_${u.key}`)}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary, marginTop: 12 }]}>
            Бюджет, € (опционально){currentCat ? ` — мин. €${currentCat.minBudget}` : ''}
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TextInput
              testID="svc-budget-min"
              value={budgetMin}
              onChangeText={setBudgetMin}
              placeholder="От"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              style={[styles.input, { flex: 1, backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
            />
            <TextInput
              testID="svc-budget-max"
              value={budgetMax}
              onChangeText={setBudgetMax}
              placeholder="До"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              style={[styles.input, { flex: 1, backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
            />
          </View>

          {!user && (
            <>
              <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary, marginTop: 12 }]}>
                Телефон для связи (нужен, если без аккаунта)
              </Text>
              <TextInput
                testID="svc-contact-phone"
                value={contactPhone}
                onChangeText={setContactPhone}
                placeholder="+49 ..."
                placeholderTextColor={colors.textMuted}
                keyboardType="phone-pad"
                style={[styles.input, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
              />
            </>
          )}

          <TouchableOpacity
            testID="svc-create-submit"
            onPress={handleSubmit}
            disabled={submitting}
            activeOpacity={0.85}
            style={[styles.cta, { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1, marginTop: 20 }]}
          >
            {submitting ? (
              <ActivityIndicator color={colors.onPrimary || '#000'} />
            ) : (
              <>
                <Ionicons name="paper-plane" size={18} color={colors.onPrimary || '#000'} />
                <Text style={[styles.ctaText, { color: colors.onPrimary || '#000' }]}>
                  Опубликовать на бирже
                </Text>
              </>
            )}
          </TouchableOpacity>

          <Text style={[styles.note, { color: colors.textMuted || colors.textSecondary }]}>
            Заявка попадёт в общую биржу. Исполнители увидят её и предложат свои цены. Вы выберете лучшее предложение.
          </Text>
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
    marginBottom: 8,
  },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  catCard: {
    width: '31%', borderRadius: 12, padding: 10, gap: 4,
    alignItems: 'center', minHeight: 72, justifyContent: 'center',
  },
  catEmoji: { fontSize: 22 },
  catLabel: { fontSize: 11, fontWeight: '700', textAlign: 'center' },
  input: {
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, borderWidth: 1, minHeight: 44,
  },
  textarea: {
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, borderWidth: 1, minHeight: 120,
  },
  urgencyRow: { flexDirection: 'row', gap: 8 },
  urgencyChip: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1,
    justifyContent: 'center',
  },
  urgencyDot: { width: 8, height: 8, borderRadius: 4 },
  urgencyText: { fontSize: 13, fontWeight: '700' },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, paddingVertical: 15, borderRadius: 14,
  },
  ctaText: { fontSize: 15, fontWeight: '700' },
  note: { fontSize: 12, marginTop: 14, textAlign: 'center', lineHeight: 17 },
});

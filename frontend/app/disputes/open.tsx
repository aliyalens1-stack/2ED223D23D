/**
 * Sprint 6 — Open Dispute screen.
 *
 * URL: /disputes/open?requestId=...
 *
 * Triggered from service request detail or chat when escrow is locked
 * and customer/provider needs admin intervention. Single-form flow:
 *   reason (chips) → description (optional) → submit
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { disputesAPI } from '../../src/services/api';

const REASONS: { key: string; label: string; icon: string }[] = [
  { key: 'not_completed', label: 'Услуга не выполнена', icon: 'close-circle' },
  { key: 'quality_issue', label: 'Плохое качество', icon: 'warning' },
  { key: 'no_show', label: 'Не приехал', icon: 'car-outline' },
  { key: 'overcharge', label: 'Переплата / скрытые расходы', icon: 'cash-outline' },
  { key: 'damage', label: 'Повреждение', icon: 'alert-circle' },
  { key: 'wrong_service', label: 'Не то, о чём договаривались', icon: 'swap-horizontal' },
  { key: 'communication', label: 'Не отвечает', icon: 'chatbubble-outline' },
  { key: 'other', label: 'Другое', icon: 'help-circle' },
];

export default function OpenDisputeScreen() {
  const router = useRouter();
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  const [reason, setReason] = useState<string>('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!reason) {
      Alert.alert('Выберите причину', 'Укажите, что произошло');
      return;
    }
    if (!requestId) {
      Alert.alert('Ошибка', 'Не указана заявка');
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await disputesAPI.create({
        requestId: String(requestId),
        reason,
        description: description.trim() || undefined,
      });
      const msg = data.alreadyOpen
        ? 'По этой сделке уже открыт спор — администратор разберётся.'
        : 'Спор открыт. Эскроу заморожен. Администратор уведомлён.';
      Alert.alert('Спор зарегистрирован', msg, [
        { text: 'OK', onPress: () => router.replace(`/disputes/${data.dispute.id}` as any) },
      ]);
    } catch (e: any) {
      const detail = e?.response?.data?.detail || 'Не удалось открыть спор';
      Alert.alert('Ошибка', String(detail));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8} testID="dispute-open-back">
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Открыть спор</Text>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.warningBox}>
            <Ionicons name="lock-closed" size={20} color="#FFD23F" />
            <Text style={styles.warningText}>
              Эскроу будет заморожен до решения администратора. Это может занять до 3 рабочих дней.
            </Text>
          </View>

          <Text style={styles.sectionTitle}>Что произошло?</Text>
          <View style={styles.reasonsList}>
            {REASONS.map((r) => {
              const active = reason === r.key;
              return (
                <TouchableOpacity
                  key={r.key}
                  onPress={() => setReason(r.key)}
                  style={[styles.reason, active && styles.reasonActive]}
                  testID={`dispute-reason-${r.key}`}
                >
                  <Ionicons
                    name={r.icon as any}
                    size={18}
                    color={active ? '#000' : '#E5E7EB'}
                  />
                  <Text style={[styles.reasonText, active && styles.reasonTextActive]}>
                    {r.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.sectionTitle}>Подробности (опционально)</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            multiline
            maxLength={2000}
            placeholder="Опишите ситуацию: что было обещано, что произошло, что вы хотите как результат…"
            placeholderTextColor="#6B7280"
            style={styles.textArea}
            testID="dispute-description"
          />
          <Text style={styles.counter}>{description.length}/2000</Text>
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            disabled={!reason || submitting}
            onPress={handleSubmit}
            style={[styles.submit, (!reason || submitting) && styles.submitDisabled]}
            testID="dispute-submit-btn"
          >
            {submitting ? (
              <ActivityIndicator color="#000" />
            ) : (
              <Text style={styles.submitText}>Открыть спор</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: '#1f2937',
    borderBottomWidth: 1,
  },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  scroll: { padding: 16, paddingBottom: 32 },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    backgroundColor: '#FFD23F11',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FFD23F44',
    marginBottom: 24,
  },
  warningText: { color: '#FFD23F', fontSize: 13, flex: 1, lineHeight: 18 },
  sectionTitle: { color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 10, marginTop: 8 },
  reasonsList: { marginBottom: 8 },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    backgroundColor: '#1f2937',
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#374151',
  },
  reasonActive: { backgroundColor: '#FFD23F', borderColor: '#FFD23F' },
  reasonText: { color: '#E5E7EB', fontSize: 14, flex: 1 },
  reasonTextActive: { color: '#000', fontWeight: '600' },
  textArea: {
    backgroundColor: '#1f2937',
    color: '#fff',
    borderRadius: 10,
    padding: 12,
    minHeight: 120,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: '#374151',
  },
  counter: { color: '#6B7280', fontSize: 12, textAlign: 'right', marginTop: 4 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: '#1f2937' },
  submit: {
    backgroundColor: '#FFD23F',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: '#000', fontSize: 16, fontWeight: '700' },
});

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Modal,
  TextInput,
  Alert,
} from 'react-native';
import { useThemeContext } from '../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { disputesAPI, bookingsAPI } from '../src/services/api';
import { useAuth } from '../src/context/AuthContext';
import { theme } from '../src/context/ThemeContext';
const colors = theme.colors;

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  open: { label: 'Открыт', color: colors.warning },
  in_review: { label: 'На рассмотрении', color: colors.brand },
  resolved: { label: 'Решён', color: colors.success },
  rejected: { label: 'Отклонён', color: colors.brand },
};

export default function DisputesScreen() {
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [disputes, setDisputes] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [bookings, setBookings] = useState<any[]>([]);
  const [selectedBooking, setSelectedBooking] = useState<string>('');
  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchDisputes = async () => {
    try {
      const res = await disputesAPI.getMy();
      setDisputes(res.data || []);
    } catch (error) {
      console.error('Error fetching disputes:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const fetchBookings = async () => {
    try {
      const res = await bookingsAPI.getMy();
      const completed = (res.data || []).filter((b: any) => b.status === 'completed' || b.status === 'confirmed');
      setBookings(completed);
    } catch {}
  };

  useEffect(() => {
    if (user) {
      fetchDisputes();
      fetchBookings();
    } else {
      setLoading(false);
    }
  }, [user]);

  const onRefresh = () => { setRefreshing(true); fetchDisputes(); };

  const handleCreate = async () => {
    if (!selectedBooking) {
      Alert.alert('Ошибка', 'Выберите запись');
      return;
    }
    if (!reason.trim()) {
      Alert.alert('Ошибка', 'Укажите причину');
      return;
    }

    setSubmitting(true);
    try {
      await disputesAPI.create({
        bookingId: selectedBooking,
        reason: reason.trim(),
        description: description.trim(),
      });
      setShowModal(false);
      setSelectedBooking('');
      setReason('');
      setDescription('');
      fetchDisputes();
      Alert.alert('Успешно', 'Жалоба отправлена на рассмотрение');
    } catch (error: any) {
      Alert.alert('Ошибка', error.response?.data?.message || 'Не удалось создать жалобу');
    } finally {
      setSubmitting(false);
    }
  };

  if (!user) {
    // Sprint Guest-1: дисптуты привязаны к заказу — у гостя их не может быть.
    // Показываем дружелюбный empty state, а не блок-стену.
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Мои жалобы</Text>
          <View style={{ width: 44 }} />
        </View>
        <View style={styles.empty}>
          <Ionicons name="checkmark-circle-outline" size={64} color={colors.success} />
          <Text style={styles.emptyTitle}>Жалоб пока нет</Text>
          <Text style={styles.emptyText}>
            Жалобы появляются после оформления заказа. Войдите, чтобы видеть жалобы по своим заказам.
          </Text>
          <TouchableOpacity
            style={styles.authButton}
            onPress={() => router.push('/login')}
            testID="disputes-login-cta"
          >
            <Ionicons name="log-in-outline" size={18} color={colors.onPrimary} style={{ marginRight: 8 }} />
            <Text style={styles.authButtonText}>Войти</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Мои жалобы</Text>
        <TouchableOpacity onPress={() => setShowModal(true)} style={styles.addBtn}>
          <Ionicons name="add" size={24} color={colors.text} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
      >
        {loading ? (
          <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
        ) : disputes.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="checkmark-circle-outline" size={64} color={colors.success} />
            <Text style={styles.emptyTitle}>Нет жалоб</Text>
            <Text style={styles.emptyText}>Если возникнут проблемы с заказом, вы можете подать жалобу</Text>
          </View>
        ) : (
          disputes.map((dispute, idx) => {
            const status = STATUS_LABELS[dispute.status] || STATUS_LABELS.open;
            return (
              <View key={dispute._id || idx} style={styles.disputeCard}>
                <View style={styles.disputeHeader}>
                  <View style={[styles.statusBadge, { backgroundColor: `${status.color}20` }]}>
                    <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
                  </View>
                  <Text style={styles.disputeDate}>
                    {new Date(dispute.createdAt).toLocaleDateString('ru-RU')}
                  </Text>
                </View>
                <Text style={styles.disputeReason}>{dispute.reason}</Text>
                {dispute.description && (
                  <Text style={styles.disputeDesc} numberOfLines={2}>{dispute.description}</Text>
                )}
                {dispute.resolution && (
                  <View style={styles.resolutionBox}>
                    <Ionicons name="chatbubble" size={14} color={colors.success} />
                    <Text style={styles.resolutionText}>{dispute.resolution}</Text>
                  </View>
                )}
              </View>
            );
          })
        )}
        <View style={{ height: 20 }} />
      </ScrollView>

      {/* Create Dispute Modal */}
      <Modal visible={showModal} animationType="slide" transparent onRequestClose={() => setShowModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Новая жалоба</Text>
              <TouchableOpacity onPress={() => setShowModal(false)}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Выберите запись</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bookingsScroll}>
              {bookings.length === 0 ? (
                <Text style={styles.noBookings}>Нет доступных записей</Text>
              ) : (
                bookings.map((b) => (
                  <TouchableOpacity
                    key={b._id}
                    style={[styles.bookingChip, selectedBooking === b._id && styles.bookingChipSelected]}
                    onPress={() => setSelectedBooking(b._id)}
                  >
                    <Text style={[styles.bookingChipText, selectedBooking === b._id && styles.bookingChipTextSelected]}>
                      {b.service?.name || 'Услуга'} - {new Date(b.scheduledAt).toLocaleDateString('ru-RU')}
                    </Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>

            <Text style={styles.inputLabel}>Причина *</Text>
            <TextInput
              style={styles.input}
              placeholder="Кратко опишите проблему"
              placeholderTextColor={colors.textMuted}
              value={reason}
              onChangeText={setReason}
            />

            <Text style={styles.inputLabel}>Подробное описание</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Подробно опишите ситуацию..."
              placeholderTextColor={colors.textMuted}
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />

            <TouchableOpacity
              style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
              onPress={handleCreate}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text style={styles.submitBtnText}>Отправить жалобу</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  addBtn: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 18, fontWeight: '600', color: colors.text },
  content: { flex: 1, paddingHorizontal: 16 },
  empty: { alignItems: 'center', paddingVertical: 60 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: colors.text, marginTop: 16 },
  emptyText: { fontSize: 14, color: colors.textMuted, marginTop: 6, textAlign: 'center', paddingHorizontal: 20 },
  disputeCard: {
    backgroundColor: colors.backgroundTertiary, borderRadius: 16,
    padding: 16, marginTop: 12,
  },
  disputeHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10,
  },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  statusText: { fontSize: 12, fontWeight: '600' },
  disputeDate: { fontSize: 12, color: colors.textMuted },
  disputeReason: { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 4 },
  disputeDesc: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  resolutionBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    marginTop: 12, padding: 12, backgroundColor: 'rgba(16,185,129,0.1)', borderRadius: 10,
  },
  resolutionText: { flex: 1, fontSize: 13, color: colors.success, lineHeight: 18 },
  authPrompt: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  authTitle: { fontSize: 18, fontWeight: '600', color: colors.text, marginTop: 16, textAlign: 'center' },
  authButton: {
    marginTop: 24, paddingHorizontal: 48, paddingVertical: 14,
    backgroundColor: colors.primary, borderRadius: 12,
  },
  authButtonText: { fontSize: 16, fontWeight: '600', color: colors.onPrimary },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 40, maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20,
  },
  modalTitle: { fontSize: 20, fontWeight: '700', color: colors.text },
  inputLabel: { fontSize: 14, fontWeight: '500', color: colors.textMuted, marginBottom: 8, marginTop: 12 },
  bookingsScroll: { marginBottom: 8 },
  noBookings: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic' },
  bookingChip: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10,
    backgroundColor: colors.border, marginRight: 8,
  },
  bookingChipSelected: { backgroundColor: colors.primary },
  bookingChipText: { fontSize: 13, color: colors.onPrimaryMuted },
  bookingChipTextSelected: { color: colors.text, fontWeight: '600' },
  input: {
    backgroundColor: colors.border, borderRadius: 12, padding: 16,
    fontSize: 16, color: colors.text, borderWidth: 1, borderColor: colors.border,
  },
  textArea: { height: 100, paddingTop: 12 },
  submitBtn: {
    backgroundColor: colors.brand, paddingVertical: 16, borderRadius: 12,
    alignItems: 'center', marginTop: 20,
  },
  submitBtnDisabled: { opacity: 0.7 },
  submitBtnText: { fontSize: 17, fontWeight: '600', color: colors.onPrimary },
});

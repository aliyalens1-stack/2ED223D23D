/**
 * Admin screen — partner verification queue.
 *
 * Lists pending / approved / rejected partner applications coming from
 * /api/marketplace/partner/register and lets the admin approve or reject
 * each one. Both backend actions are bound to existing JWT-admin
 * endpoints in app/admin/partner_verifications.py.
 *
 * Кino-light file: networking lives in `src/services/admin/partnerVerifications.ts`,
 * UI primitives use shared `PARTNER_KIND_MAP`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Alert, TextInput, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { partnerVerificationsApi, PartnerApplication } from '../../src/services/admin/partnerVerifications';
import { PARTNER_KIND_MAP } from '../../src/lib/map/kinds';

type Tab = 'pending' | 'approved' | 'rejected';

export default function PartnerVerificationsScreen() {
  const { colors } = useThemeContext();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<PartnerApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Reject modal state
  const [rejectFor, setRejectFor] = useState<PartnerApplication | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await partnerVerificationsApi.list({ status: tab, limit: 100 });
      setItems(r.applications);
    } catch (e: any) {
      Alert.alert('Ошибка', e?.response?.data?.detail || 'Не удалось загрузить заявки. Требуются права администратора.');
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tab]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const onApprove = async (app: PartnerApplication) => {
    setBusyId(app.id);
    try {
      await partnerVerificationsApi.approve(app.id);
      setItems(prev => prev.filter(x => x.id !== app.id));
    } catch (e: any) {
      Alert.alert('Ошибка', e?.response?.data?.detail || 'approve failed');
    } finally {
      setBusyId(null);
    }
  };

  const submitReject = async () => {
    if (!rejectFor || !rejectNote.trim()) {
      Alert.alert('Ошибка', 'Укажите причину отказа');
      return;
    }
    setBusyId(rejectFor.id);
    try {
      await partnerVerificationsApi.reject(rejectFor.id, rejectNote.trim());
      setItems(prev => prev.filter(x => x.id !== rejectFor!.id));
      setRejectFor(null);
      setRejectNote('');
    } catch (e: any) {
      Alert.alert('Ошибка', e?.response?.data?.detail || 'reject failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity testID="admin-verif-back" onPress={() => router.back()} style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Партнёрские заявки</Text>
        <View style={{ width: 36 }} />
      </View>

      {/* Tabs */}
      <View style={styles.tabsRow}>
        {(['pending', 'approved', 'rejected'] as Tab[]).map(t => (
          <TouchableOpacity
            key={t}
            testID={`admin-verif-tab-${t}`}
            onPress={() => setTab(t)}
            style={[styles.tabBtn, { backgroundColor: tab === t ? colors.primary : colors.card, borderColor: tab === t ? colors.primary : colors.border }]}
          >
            <Text style={[styles.tabBtnText, { color: tab === t ? '#000' : colors.text }]}>
              {t === 'pending' ? 'На рассмотрении' : t === 'approved' ? 'Одобрены' : 'Отклонены'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="document-outline" size={48} color={colors.textMuted} />
          <Text style={[styles.empty, { color: colors.textMuted }]}>Нет заявок в этой вкладке</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
        >
          {items.map(app => {
            const meta = PARTNER_KIND_MAP[app.kind];
            const coords = app.organization?.location?.coordinates || app.location?.coordinates;
            return (
              <View key={app.id} testID={`admin-verif-card-${app.id}`} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardHead}>
                  <View style={[styles.kindBadge, { backgroundColor: meta.color }]}>
                    <Text style={styles.kindBadgeText}>{meta.emoji} {meta.label}</Text>
                  </View>
                  <Text style={[styles.cardDate, { color: colors.textMuted }]} numberOfLines={1}>
                    {new Date(app.submittedAt).toLocaleString()}
                  </Text>
                </View>
                <Text style={[styles.cardName, { color: colors.text }]} numberOfLines={2}>
                  {app.organization?.name || '(без названия)'}
                </Text>
                <View style={styles.cardRow}>
                  <Ionicons name="location-outline" size={14} color={colors.textMuted} />
                  <Text style={[styles.cardMeta, { color: colors.textMuted }]} numberOfLines={1}>
                    {(app.organization?.city || app.city).toUpperCase()} · {app.organization?.address || '—'}
                  </Text>
                </View>
                {coords && (
                  <Text style={[styles.cardCoords, { color: colors.textMuted }]} selectable>
                    📍 {coords[1].toFixed(5)}, {coords[0].toFixed(5)}
                  </Text>
                )}
                {app.note ? (
                  <Text style={[styles.cardNote, { color: colors.textMuted }]} numberOfLines={3}>
                    Комментарий: {app.note}
                  </Text>
                ) : null}

                {tab === 'pending' && (
                  <View style={styles.actionsRow}>
                    <TouchableOpacity
                      testID={`admin-verif-reject-${app.id}`}
                      onPress={() => { setRejectFor(app); setRejectNote(''); }}
                      disabled={busyId === app.id}
                      style={[styles.rejectBtn, { borderColor: '#ef4444', opacity: busyId === app.id ? 0.5 : 1 }]}
                    >
                      <Ionicons name="close" size={16} color="#ef4444" />
                      <Text style={styles.rejectBtnText}>Отклонить</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`admin-verif-approve-${app.id}`}
                      onPress={() => onApprove(app)}
                      disabled={busyId === app.id}
                      style={[styles.approveBtn, { backgroundColor: '#10b981', opacity: busyId === app.id ? 0.5 : 1 }]}
                    >
                      {busyId === app.id ? <ActivityIndicator color="#fff" /> : <>
                        <Ionicons name="checkmark" size={16} color="#fff" />
                        <Text style={styles.approveBtnText}>Одобрить</Text>
                      </>}
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      {/* Reject modal */}
      <Modal visible={!!rejectFor} transparent animationType="fade" onRequestClose={() => setRejectFor(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalBox, { backgroundColor: colors.card }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Причина отказа</Text>
            <TextInput
              testID="admin-verif-reject-note"
              style={[styles.modalInput, { color: colors.text, borderColor: colors.border }]}
              placeholder="Кратко опишите причину…"
              placeholderTextColor={colors.textMuted}
              value={rejectNote}
              onChangeText={setRejectNote}
              multiline
            />
            <View style={styles.modalRow}>
              <TouchableOpacity onPress={() => setRejectFor(null)} style={[styles.modalBtn, { borderColor: colors.border }]}>
                <Text style={[styles.modalBtnText, { color: colors.text }]}>Отмена</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="admin-verif-reject-confirm"
                onPress={submitReject}
                style={[styles.modalBtn, { backgroundColor: '#ef4444', borderColor: '#ef4444' }]}
              >
                <Text style={[styles.modalBtnText, { color: '#fff' }]}>Отклонить</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10 },
  backBtn: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  tabsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  tabBtn: { flex: 1, paddingVertical: 9, borderRadius: 14, borderWidth: 1, alignItems: 'center' },
  tabBtnText: { fontSize: 13, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  empty: { fontSize: 14 },
  card: { borderRadius: 16, borderWidth: 1, padding: 14, marginBottom: 12 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  kindBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
  kindBadgeText: { color: '#000', fontWeight: '800', fontSize: 11 },
  cardDate: { fontSize: 11 },
  cardName: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  cardMeta: { fontSize: 12, flex: 1 },
  cardCoords: { fontSize: 11, marginTop: 4 },
  cardNote: { fontSize: 12, marginTop: 6, fontStyle: 'italic' },
  actionsRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  rejectBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1 },
  rejectBtnText: { color: '#ef4444', fontWeight: '700', fontSize: 13 },
  approveBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10 },
  approveBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 },
  modalBox: { borderRadius: 16, padding: 18, gap: 12 },
  modalTitle: { fontSize: 16, fontWeight: '800' },
  modalInput: { minHeight: 88, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 14, textAlignVertical: 'top' },
  modalRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  modalBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  modalBtnText: { fontSize: 14, fontWeight: '700' },
});

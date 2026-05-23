/**
 * Service Marketplace — детали заявки с откликами.
 * GET /api/service-requests/{id}
 * POST /api/service-requests/{id}/accept-bid
 * POST /api/service-requests/{id}/cancel
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import i18n from '../../src/i18n';

type Bid = {
  id: string;
  providerId: string;
  providerName: string;
  providerRating: number | null;
  providerPhone?: string | null;
  providerEmail?: string | null;
  price: number;
  currency: string;
  message: string;
  etaMinutes: number | null;
  status: string;
  createdAt: string;
};

const STATUS_COLOR: Record<string, string> = {
  open: '#3b82f6', bidding: '#f59e0b',
  awaiting_payment: '#f97316', paid: '#22c55e', released: '#10b981',
  assigned: '#22c55e',
  in_progress: '#0ea5e9', completed: '#10b981', cancelled: '#6b7280',
  expired: '#9ca3af', disputed: '#ef4444',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  open: 'status_open', bidding: 'status_bidding',
  awaiting_payment: 'status_awaiting_payment',
  paid: 'status_paid',
  released: 'status_released',
  assigned: 'status_assigned',
  in_progress: 'status_in_progress', completed: 'status_completed', cancelled: 'status_cancelled',
  expired: 'status_expired', disputed: 'status_disputed',
};

export default function ServiceRequestDetail() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useThemeContext();
  const params = useLocalSearchParams<{ id: string }>();
  const [doc, setDoc] = useState<any>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [payment, setPayment] = useState<any>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async () => {
    if (!params.id) return;
    try {
      const r = await api.get(`/service-requests/${params.id}`);
      setDoc(r.data?.request);
      setBids(r.data?.bids || []);
      setIsOwner(!!r.data?.isOwner);
      setPayment(r.data?.payment || null);
    } catch (e: any) {
      Alert.alert(i18n.t('service_marketplace.error_generic'), e?.response?.data?.detail || e?.message || 'Network error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [params.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleAccept = async (bidId: string) => {
    Alert.alert(
      i18n.t('service_marketplace.owner_accept_bid_title'),
      'Сейчас откроется страница оплаты. Деньги пойдут в escrow платформы и перейдут исполнителю только после завершения работы.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: i18n.t('service_marketplace.owner_accept_bid_cta'),
          onPress: async () => {
            setAccepting(bidId);
            try {
              const r = await api.post(`/service-requests/${params.id}/accept-bid`, { bidId });
              const pid = r.data?.payment?.id;
              if (pid) {
                router.push(`/payments/checkout/${pid}` as any);
              } else {
                await load();
              }
            } catch (e: any) {
              Alert.alert(i18n.t('service_marketplace.error_generic'), e?.response?.data?.message || e?.message);
            } finally {
              setAccepting(null);
            }
          },
        },
      ],
    );
  };

  const handleGoToCheckout = () => {
    if (payment?.id) router.push(`/payments/checkout/${payment.id}` as any);
  };

  const handleComplete = () => {
    Alert.alert(i18n.t('service_marketplace.owner_complete_confirm_title'), 'После этого деньги уйдут исполнителю.', [
      { text: 'Назад', style: 'cancel' },
      {
        text: i18n.t('service_marketplace.owner_complete_yes'),
        onPress: async () => {
          setActionBusy(true);
          try {
            await api.post(`/service-requests/${params.id}/complete`, {});
            await load();
          } catch (e: any) {
            Alert.alert(i18n.t('service_marketplace.error_generic'), e?.response?.data?.message || e?.message);
          } finally { setActionBusy(false); }
        },
      },
    ]);
  };

  const handleRelease = async () => {
    if (!payment?.id) return;
    setActionBusy(true);
    try {
      await api.post(`/service-payments/${payment.id}/release`, {});
      await load();
    } catch (e: any) {
      Alert.alert(i18n.t('service_marketplace.error_generic'), e?.response?.data?.message || e?.message);
    } finally { setActionBusy(false); }
  };

  const openChat = async () => {
    try {
      const r = await api.post(`/service-chats/from-request/${params.id}`, {});
      const chatId = r.data?.chat?.id;
      if (chatId) router.push(`/chat/service/${chatId}` as any);
    } catch (e: any) {
      Alert.alert('Чат недоступен', e?.response?.data?.message || 'Чат откроется после оплаты');
    }
  };

  const handleCancel = () => {
    Alert.alert(i18n.t('service_marketplace.owner_cancel_title'), 'Все отклики будут аннулированы.', [
      { text: 'Назад', style: 'cancel' },
      {
        text: i18n.t('service_marketplace.owner_cancel_yes'),
        style: 'destructive',
        onPress: async () => {
          try {
            await api.post(`/service-requests/${params.id}/cancel`, {});
            await load();
          } catch (e: any) {
            Alert.alert(i18n.t('service_marketplace.error_generic'), e?.response?.data?.detail || e?.message);
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background, justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  if (!doc) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: colors.textSecondary }}>Заявка не найдена</Text>
      </SafeAreaView>
    );
  }

  const statusColor = STATUS_COLOR[doc.status] || '#888';
  const acceptedBid = bids.find((b) => b.status === 'accepted');

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity testID="req-detail-back" onPress={() => router.back()} style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>Заявка</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        {/* Status */}
        <View style={[styles.statusBox, { backgroundColor: statusColor + '15', borderColor: statusColor }]}>
          <View style={[styles.dot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>{t(`service_marketplace.${STATUS_LABEL_KEYS[doc.status] || 'status_open'}`) || doc.status}</Text>
        </View>

        {/* Sprint 3A — Payment status / actions */}
        {isOwner && doc.status === 'awaiting_payment' && payment && (
          <TouchableOpacity testID="resume-checkout" onPress={handleGoToCheckout} activeOpacity={0.85} style={[styles.payBar, { backgroundColor: '#f97316' }]}>
            <Ionicons name="card" size={18} color="#fff" />
            <Text style={styles.payBarText}>Перейти к оплате · €{payment.grossAmount}</Text>
          </TouchableOpacity>
        )}
        {isOwner && doc.status === 'paid' && (
          <View style={[styles.escrowBox, { backgroundColor: '#22c55e22', borderColor: '#22c55e' }]}>
            <Ionicons name="shield-checkmark" size={18} color="#22c55e" />
            <Text style={[styles.escrowText, { color: colors.text }]}>
              €{payment?.grossAmount} в escrow. После завершения работы подтвердите выполнение — деньги уйдут исполнителю.
            </Text>
          </View>
        )}
        {isOwner && doc.status === 'paid' && (
          <TouchableOpacity testID="complete-request" onPress={handleComplete} disabled={actionBusy} activeOpacity={0.85} style={[styles.payBar, { backgroundColor: '#22c55e', opacity: actionBusy ? 0.5 : 1 }]}>
            <Ionicons name="checkmark-done" size={18} color="#fff" />
            <Text style={styles.payBarText}>Работа выполнена — подтвердить</Text>
          </TouchableOpacity>
        )}
        {isOwner && doc.status === 'completed' && payment?.status === 'paid' && (
          <TouchableOpacity testID="release-escrow" onPress={handleRelease} disabled={actionBusy} activeOpacity={0.85} style={[styles.payBar, { backgroundColor: '#10b981', opacity: actionBusy ? 0.5 : 1 }]}>
            <Ionicons name="send" size={18} color="#fff" />
            <Text style={styles.payBarText}>Отправить €{payment?.providerPayout} исполнителю</Text>
          </TouchableOpacity>
        )}
        {doc.status === 'released' && (
          <View style={[styles.escrowBox, { backgroundColor: '#10b98122', borderColor: '#10b981' }]}>
            <Ionicons name="checkmark-circle" size={18} color="#10b981" />
            <Text style={[styles.escrowText, { color: colors.text }]}>
              Сделка закрыта. €{payment?.providerPayout} выплачено исполнителю, €{payment?.commissionAmount} — комиссия платформы.
            </Text>
          </View>
        )}

        {/* Sprint 4 — Chat shortcut (только после оплаты) */}
        {(doc.status === 'paid' || doc.status === 'in_progress' || doc.status === 'completed' || doc.status === 'released') && (
          <TouchableOpacity testID="open-chat-btn" onPress={openChat} activeOpacity={0.85} style={[styles.chatBtn, { backgroundColor: colors.card, borderColor: colors.primary }]}>
            <Ionicons name="chatbubbles" size={18} color={colors.primary} />
            <Text style={[styles.chatBtnText, { color: colors.primary }]}>Открыть чат с исполнителем</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.primary} />
          </TouchableOpacity>
        )}

        {/* Title */}
        <Text style={[styles.title, { color: colors.text }]}>{doc.title}</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {doc.category} · {doc.city} · {new Date(doc.createdAt).toLocaleString()}
        </Text>

        {/* Description */}
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{t('service_marketplace.description')}</Text>
          <Text style={[styles.body, { color: colors.text }]}>{doc.description}</Text>
        </View>

        {/* Budget */}
        {doc.budget?.min || doc.budget?.max ? (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{t('service_marketplace.budget')}</Text>
            <Text style={[styles.body, { color: colors.text }]}>
              €{doc.budget.min || '?'}{doc.budget.max ? ` – €${doc.budget.max}` : '+'}
            </Text>
          </View>
        ) : null}

        {/* Bids section */}
        <Text style={[styles.h2, { color: colors.text }]}>
          {bids.length === 0 ? 'Ожидаем отклики…' : `Отклики (${bids.length})`}
        </Text>

        {bids.length === 0 && doc.status === 'open' && (
          <Text style={[styles.empty, { color: colors.textSecondary }]}>
            Исполнители увидят вашу заявку и предложат свои цены. Обычно первые отклики приходят в течение часа.
          </Text>
        )}

        {bids.map((bid) => {
          const isAccepted = bid.status === 'accepted';
          const isRejected = bid.status === 'rejected';
          return (
            <View
              key={bid.id}
              testID={`bid-${bid.id}`}
              style={[
                styles.bidCard,
                {
                  backgroundColor: colors.card,
                  borderColor: isAccepted ? '#22c55e' : isRejected ? colors.border : colors.border,
                  borderWidth: isAccepted ? 2 : 1,
                  opacity: isRejected ? 0.5 : 1,
                },
              ]}
            >
              <View style={styles.bidHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.providerName, { color: colors.text }]}>{bid.providerName}</Text>
                  {bid.providerRating ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Ionicons name="star" size={12} color="#f59e0b" />
                      <Text style={[styles.rating, { color: colors.textSecondary }]}>{bid.providerRating.toFixed(1)}</Text>
                    </View>
                  ) : null}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[styles.price, { color: colors.primary }]}>€{bid.price}</Text>
                  {bid.etaMinutes ? (
                    <Text style={[styles.eta, { color: colors.textSecondary }]}>{bid.etaMinutes} мин</Text>
                  ) : null}
                </View>
              </View>
              <Text style={[styles.bidMessage, { color: colors.text }]}>{bid.message}</Text>

              {/* Контакты — видны только если bid принят */}
              {isAccepted && (bid.providerPhone || bid.providerEmail) && (
                <View style={[styles.contactsBox, { borderTopColor: colors.border }]}>
                  <Text style={[styles.contactsLabel, { color: colors.textSecondary }]}>Контакты исполнителя:</Text>
                  {bid.providerPhone && (
                    <Text style={[styles.contactsValue, { color: colors.text }]}>📞 {bid.providerPhone}</Text>
                  )}
                  {bid.providerEmail && (
                    <Text style={[styles.contactsValue, { color: colors.text }]}>✉️ {bid.providerEmail}</Text>
                  )}
                </View>
              )}

              {/* Accept button — только если владелец и статус позволяет */}
              {isOwner && (doc.status === 'open' || doc.status === 'bidding') && bid.status === 'submitted' && (
                <TouchableOpacity
                  testID={`accept-bid-${bid.id}`}
                  onPress={() => handleAccept(bid.id)}
                  disabled={!!accepting}
                  style={[styles.acceptBtn, { backgroundColor: '#22c55e', opacity: accepting === bid.id ? 0.5 : 1 }]}
                  activeOpacity={0.85}
                >
                  {accepting === bid.id ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="checkmark-circle" size={16} color="#fff" />
                      <Text style={styles.acceptText}>Принять отклик</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
              {isAccepted && (
                <View style={[styles.acceptedBadge, { backgroundColor: '#22c55e' + '22' }]}>
                  <Ionicons name="checkmark-circle" size={14} color="#22c55e" />
                  <Text style={[styles.acceptedText, { color: '#22c55e' }]}>Принят</Text>
                </View>
              )}
            </View>
          );
        })}

        {/* Cancel button */}
        {isOwner && (doc.status === 'open' || doc.status === 'bidding') && (
          <TouchableOpacity
            testID="cancel-request"
            onPress={handleCancel}
            style={[styles.cancelBtn, { borderColor: '#ef4444' }]}
            activeOpacity={0.85}
          >
            <Ionicons name="close-circle-outline" size={16} color="#ef4444" />
            <Text style={[styles.cancelText, { color: '#ef4444' }]}>Отменить заявку</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
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
  headerTitle: { fontSize: 17, fontWeight: '700' },
  statusBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1, alignSelf: 'flex-start', marginBottom: 16 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13, fontWeight: '700' },
  title: { fontSize: 22, fontWeight: '800', marginBottom: 4 },
  subtitle: { fontSize: 13, marginBottom: 16 },
  section: { padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 12 },
  sectionTitle: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  body: { fontSize: 15, lineHeight: 22 },
  h2: { fontSize: 16, fontWeight: '800', marginTop: 12, marginBottom: 10 },
  empty: { fontSize: 13, fontStyle: 'italic', textAlign: 'center', padding: 16 },
  bidCard: { padding: 14, borderRadius: 14, marginBottom: 10 },
  bidHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  providerName: { fontSize: 15, fontWeight: '700' },
  rating: { fontSize: 12, fontWeight: '600' },
  price: { fontSize: 20, fontWeight: '800' },
  eta: { fontSize: 11, marginTop: 2 },
  bidMessage: { fontSize: 14, lineHeight: 20 },
  contactsBox: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, gap: 4 },
  contactsLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  contactsValue: { fontSize: 14, fontWeight: '600' },
  acceptBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 11, borderRadius: 10 },
  acceptText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  acceptedBadge: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, paddingVertical: 8, borderRadius: 8 },
  acceptedText: { fontSize: 13, fontWeight: '700' },
  cancelBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 16, paddingVertical: 12, borderRadius: 10, borderWidth: 1 },
  cancelText: { fontSize: 14, fontWeight: '700' },
  payBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 12, marginBottom: 14 },
  payBarText: { fontSize: 14, fontWeight: '800', color: '#fff' },
  escrowBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 14, borderRadius: 12, borderWidth: 1, marginBottom: 14 },
  escrowText: { flex: 1, fontSize: 13, lineHeight: 18 },
  chatBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 13, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1.5, marginBottom: 14 },
  chatBtnText: { flex: 1, fontSize: 14, fontWeight: '700' },
});

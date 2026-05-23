/**
 * Service Marketplace — биржа доступных заявок для исполнителя.
 * GET /api/provider/service-requests
 * POST /api/provider/service-requests/{id}/bids
 */
import React, { useCallback, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator,
  Modal, TextInput, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { useCity } from '../../src/context/CityContext';
import { api } from '../../src/services/api';
import i18n from '../../src/i18n';

type AvailReq = {
  id: string; category: string; title: string; description: string;
  city: string; urgency: string; bidsCount: number; createdAt: string;
  budget?: { min?: number; max?: number; currency: string };
  distanceKm?: number;
};

const CAT_EMOJI: Record<string, string> = {
  repair: '🔧', tow: '🚛', wash: '🚿', detailing: '✨', battery: '🔋',
  parts: '🔩', delivery: '🚚', inspection: '🛡', car_selection: '🎯',
};

const URGENCY_COLOR: Record<string, string> = {
  normal: '#888', urgent: '#f59e0b', emergency: '#ef4444',
};

export default function ProviderServiceExchange() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useThemeContext();
  const { selectedCity } = useCity();
  const [items, setItems] = useState<AvailReq[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bidTarget, setBidTarget] = useState<AvailReq | null>(null);
  const [bidPrice, setBidPrice] = useState('');
  const [bidMessage, setBidMessage] = useState('');
  const [bidEta, setBidEta] = useState('');
  const [submittingBid, setSubmittingBid] = useState(false);

  const load = useCallback(async () => {
    try {
      // Sprint 2: use matched feed if available, fall back to legacy filter
      const endpoint = '/provider/service-requests/feed';
      const r = await api.get(endpoint);
      setItems(r.data?.requests || []);
      setError(null);
    } catch (e: any) {
      const msg = e?.response?.status === 401
        ? 'Войдите как provider/inspector чтобы видеть биржу'
        : e?.response?.status === 403
          ? 'Только для исполнителей (provider/inspector)'
          : e?.message;
      setError(String(msg));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Sprint 2: push our GPS to /api/provider/location so that backend can
  // match incoming requests to us by haversine.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (cancelled) return;
        await api.post('/provider/location', {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          city: selectedCity?.code,
          serviceRadiusKm: 30,
          isOnline: true,
        });
      } catch {
        // Если без GPS — UX продолжается; fallback на city-based matching
      }
    })();
    return () => { cancelled = true; };
  }, [selectedCity?.code]);

  const openBidModal = (req: AvailReq) => {
    setBidTarget(req);
    setBidPrice(String(req.budget?.min || ''));
    setBidMessage('');
    setBidEta('');
  };

  // Sprint 2 — quick-bid: одной кнопкой, без модалки
  const handleQuickBid = async (req: AvailReq, price: number, etaMinutes?: number) => {
    setSubmittingBid(true);
    try {
      await api.post(`/provider/service-requests/${req.id}/quick-bid`, {
        price,
        etaMinutes,
      });
      load();
    } catch (e: any) {
      Alert.alert(i18n.t('service_marketplace.error_generic'), e?.response?.data?.detail || e?.message);
    } finally {
      setSubmittingBid(false);
    }
  };

  const handleSubmitBid = async () => {
    if (!bidTarget) return;
    const price = parseInt(bidPrice, 10);
    if (!price || price < 1) {
      Alert.alert(i18n.t('service_marketplace.error_generic'), 'Укажите цену');
      return;
    }
    if (!bidMessage.trim()) {
      Alert.alert(i18n.t('service_marketplace.error_generic'), 'Опишите ваше предложение');
      return;
    }
    setSubmittingBid(true);
    try {
      await api.post(`/provider/service-requests/${bidTarget.id}/bids`, {
        price,
        currency: 'EUR',
        message: bidMessage.trim(),
        etaMinutes: bidEta ? parseInt(bidEta, 10) : undefined,
      });
      setBidTarget(null);
      Alert.alert('Ставка отправлена', 'Клиент увидит ваше предложение в своём кабинете.');
      load();
    } catch (e: any) {
      Alert.alert(i18n.t('service_marketplace.error_generic'), e?.response?.data?.detail || e?.message);
    } finally {
      setSubmittingBid(false);
    }
  };

  const renderItem = ({ item }: { item: AvailReq & { myBid?: { price: number; etaMinutes?: number; status: string } | null } }) => {
    const uColor = URGENCY_COLOR[item.urgency] || '#888';
    // Sprint 2 — fast-bid presets: min budget, mid (avg of min/max), full max
    const minB = item.budget?.min ?? 50;
    const maxB = item.budget?.max ?? minB * 2;
    const midB = Math.round((minB + maxB) / 2);
    const presets = [
      { label: `€${minB}`, price: minB, eta: 60 },
      { label: `€${midB}`, price: midB, eta: 45 },
      { label: `€${maxB}`, price: maxB, eta: 30 },
    ];
    const hasBid = !!item.myBid;
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.cardRow}>
          <Text style={styles.emoji}>{CAT_EMOJI[item.category] || '📋'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{item.title}</Text>
            <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>
              {item.city}
              {item.distanceKm !== undefined ? ` · ${item.distanceKm} км` : ''}
              {' · '}{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
          {item.urgency !== 'normal' && (
            <View style={[styles.urgencyBadge, { backgroundColor: uColor + '22', borderColor: uColor }]}>
              <Text style={[styles.urgencyText, { color: uColor }]}>
                {item.urgency === 'urgent' ? 'Срочно' : 'Аварийная'}
              </Text>
            </View>
          )}
        </View>
        <Text style={[styles.desc, { color: colors.text }]} numberOfLines={3}>{item.description}</Text>

        {/* Sprint 2 — Quick Bid bar */}
        {hasBid ? (
          <View style={[styles.cardFooter, { borderTopColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.budget, { color: '#22c55e' }]}>Ваша ставка: €{item.myBid?.price}</Text>
              <Text style={[styles.bidsCount, { color: colors.textSecondary }]}>
                {item.bidsCount} {item.bidsCount === 1 ? 'отклик' : 'откликов'} · ждём ответа клиента
              </Text>
            </View>
            <TouchableOpacity
              testID={`update-bid-${item.id}`}
              onPress={() => openBidModal(item)}
              style={[styles.bidBtn, { backgroundColor: colors.card, borderColor: colors.primary, borderWidth: 1 }]}
              activeOpacity={0.85}
            >
              <Text style={[styles.bidBtnText, { color: colors.primary }]}>Изменить</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={[styles.quickBidBar, { borderTopColor: colors.border }]}>
            <Text style={[styles.quickBidLabel, { color: colors.textSecondary }]}>Быстрая ставка ·</Text>
            {presets.map((p) => (
              <TouchableOpacity
                key={p.label}
                testID={`quick-bid-${item.id}-${p.price}`}
                onPress={() => handleQuickBid(item, p.price, p.eta)}
                disabled={submittingBid}
                style={[styles.quickBidChip, { backgroundColor: colors.primary, opacity: submittingBid ? 0.5 : 1 }]}
                activeOpacity={0.85}
              >
                <Text style={styles.quickBidChipText}>{p.label}</Text>
                <Text style={styles.quickBidChipEta}>{p.eta}м</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              testID={`custom-bid-${item.id}`}
              onPress={() => openBidModal(item)}
              style={styles.quickBidEdit}
              activeOpacity={0.7}
            >
              <Ionicons name="create-outline" size={18} color={colors.text} />
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity testID="exch-back" onPress={() => router.back()} style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Биржа заявок</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: colors.textSecondary, textAlign: 'center' }]}>{error}</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="briefcase-outline" size={48} color={colors.textMuted} />
          <Text style={[styles.empty, { color: colors.textSecondary, marginTop: 12 }]}>
            Пока нет доступных заявок в {selectedCity?.name || 'вашем городе'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
        />
      )}

      <Modal visible={!!bidTarget} animationType="slide" transparent onRequestClose={() => setBidTarget(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalWrap}>
          <View style={[styles.modalBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Ваше предложение</Text>
              <TouchableOpacity onPress={() => setBidTarget(null)} testID="bid-modal-close">
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={[styles.modalLabel, { color: colors.textSecondary }]}>Цена (€)</Text>
            <TextInput
              testID="bid-price"
              value={bidPrice}
              onChangeText={setBidPrice}
              placeholder="100"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              style={[styles.modalInput, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
            />
            <Text style={[styles.modalLabel, { color: colors.textSecondary, marginTop: 10 }]}>Сообщение клиенту</Text>
            <TextInput
              testID="bid-message"
              value={bidMessage}
              onChangeText={setBidMessage}
              placeholder="Можем выехать сегодня после 18:00…"
              placeholderTextColor={colors.textMuted}
              multiline
              numberOfLines={3}
              style={[styles.modalInput, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border, minHeight: 80, textAlignVertical: 'top' }]}
            />
            <Text style={[styles.modalLabel, { color: colors.textSecondary, marginTop: 10 }]}>ETA (минут, опционально)</Text>
            <TextInput
              testID="bid-eta"
              value={bidEta}
              onChangeText={setBidEta}
              placeholder="60"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              style={[styles.modalInput, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
            />
            <TouchableOpacity
              testID="bid-submit"
              onPress={handleSubmitBid}
              disabled={submittingBid}
              style={[styles.modalCta, { backgroundColor: colors.primary, opacity: submittingBid ? 0.6 : 1 }]}
              activeOpacity={0.85}
            >
              {submittingBid ? (
                <ActivityIndicator color="#000" />
              ) : (
                <Text style={[styles.modalCtaText, { color: '#000' }]}>Отправить ставку</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12,
  },
  backBtn: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  card: { padding: 14, borderRadius: 14, borderWidth: 1, marginBottom: 10 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  emoji: { fontSize: 28 },
  title: { fontSize: 15, fontWeight: '700' },
  meta: { fontSize: 12, marginTop: 2 },
  desc: { fontSize: 13, lineHeight: 18, marginBottom: 10 },
  urgencyBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1 },
  urgencyText: { fontSize: 11, fontWeight: '700' },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10, borderTopWidth: 1 },
  budget: { fontSize: 16, fontWeight: '800' },
  bidsCount: { fontSize: 11, marginTop: 2 },
  bidBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  bidBtnText: { fontSize: 13, fontWeight: '700', color: '#000' },
  // Sprint 2 — Quick-bid bar (≤10 sec)
  quickBidBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 10, borderTopWidth: 1 },
  quickBidLabel: { fontSize: 11, fontWeight: '700' },
  quickBidChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, alignItems: 'center' },
  quickBidChipText: { fontSize: 13, fontWeight: '800', color: '#000' },
  quickBidChipEta: { fontSize: 9, color: '#000', opacity: 0.7, marginTop: -1 },
  quickBidEdit: { padding: 6 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  empty: { fontSize: 14 },
  modalWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  modalBox: { padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: '700' },
  modalLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginBottom: 6 },
  modalInput: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, borderWidth: 1 },
  modalCta: { marginTop: 16, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  modalCtaText: { fontSize: 15, fontWeight: '700' },
});

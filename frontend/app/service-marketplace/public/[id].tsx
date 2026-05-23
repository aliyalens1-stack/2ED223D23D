/**
 * Service Marketplace — публичная страница ОДНОЙ заявки (i18n: DE/EN/RU).
 *
 * Все строки через `t('service_marketplace.*')`. Контакты клиента и
 * провайдеров СКРЫТЫ — это контракт public-роутера на backend.
 *
 * Backend:
 *   GET  /api/marketplace/feed/{id}
 *   POST /api/marketplace/feed/{id}/bid   — только provider/inspector
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Alert, RefreshControl, Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useThemeContext } from '../../../src/context/ThemeContext';
import { useAuth } from '../../../src/context/AuthContext';
import { api } from '../../../src/services/api';
import { pickCategoryTitle } from '../../../src/lib/marketplace/category';
import i18n from '../../../src/i18n';

type Bid = {
  id: string;
  providerId: string;
  providerName: string;
  providerRating: number | null;
  price: number;
  currency: string;
  message: string;
  etaMinutes: number | null;
  status: string;
  createdAt: string;
};

type RequestDoc = {
  id: string;
  category: string;
  title: string;
  description?: string;
  city: string;
  urgency: 'normal' | 'urgent' | 'emergency';
  status: 'open' | 'bidding';
  bidsCount: number;
  createdAt: string;
  expiresAt?: string;
  budget?: { min?: number; max?: number; currency: string };
  photos?: string[];
  categoryMeta?: { titleRu?: string; titleEn?: string; titleDe?: string; emoji?: string; minBudget?: number };
};

const URGENCY_COLOR: Record<string, string> = {
  normal: '#888', urgent: '#f59e0b', emergency: '#ef4444',
};

function fmtCur(amount: number, currency: string): string {
  const cur = currency === 'EUR' ? '€' : currency;
  return `${cur}${amount}`;
}

function useTimeAgo() {
  const { t } = useTranslation();
  return useCallback((iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return t('service_marketplace.time_now');
    if (m < 60) return t('service_marketplace.time_min_ago', { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('service_marketplace.time_hr_ago', { n: h });
    const d = Math.floor(h / 24);
    return t('service_marketplace.time_day_ago', { n: d });
  }, [t]);
}

export default function PublicRequestDetail() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const { mode, isAuthenticated } = useAuth();
  const params = useLocalSearchParams<{ id: string }>();
  const timeAgo = useTimeAgo();

  const [doc, setDoc] = useState<RequestDoc | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [bidOpen, setBidOpen] = useState(false);
  const [bidPrice, setBidPrice] = useState('');
  const [bidMessage, setBidMessage] = useState('');
  const [bidEta, setBidEta] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!params.id) return;
    try {
      const r = await api.get(`/marketplace/feed/${params.id}`);
      setDoc(r.data?.request || null);
      setBids(r.data?.bids || []);
    } catch (e: any) {
      if (e?.response?.status === 404) setDoc(null);
      else Alert.alert(i18n.t('service_marketplace.error_generic'), e?.response?.data?.detail || e?.message || i18n.t('service_marketplace.error_network'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [params.id, t]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const canBid = mode === 'provider';

  const handleOpenBid = () => {
    if (!isAuthenticated) {
      Alert.alert(
        i18n.t('service_marketplace.detail_login_required_title'),
        i18n.t('service_marketplace.detail_login_required_body'),
        [
          { text: i18n.t('service_marketplace.bid_cancel'), style: 'cancel' },
          { text: i18n.t('common.sign_in'), onPress: () => router.push('/login' as any) },
        ],
      );
      return;
    }
    if (!canBid) {
      Alert.alert(
        i18n.t('service_marketplace.detail_provider_only_title'),
        i18n.t('service_marketplace.detail_provider_only_body'),
      );
      return;
    }
    setBidPrice('');
    setBidMessage('');
    setBidEta('');
    setBidOpen(true);
  };

  const handleSubmitBid = async () => {
    const priceNum = parseInt(bidPrice, 10);
    if (!priceNum || priceNum <= 0) {
      Alert.alert(i18n.t('service_marketplace.error_generic'), i18n.t('service_marketplace.bid_validation_price'));
      return;
    }
    const etaNum = bidEta.trim() ? parseInt(bidEta, 10) : null;
    setSubmitting(true);
    try {
      const r = await api.post(`/marketplace/feed/${params.id}/bid`, {
        price: priceNum,
        currency: doc?.budget?.currency || 'EUR',
        message: bidMessage.trim(),
        etaMinutes: etaNum,
      });
      const action = r.data?.action;
      setBidOpen(false);
      Alert.alert(
        action === 'updated' ? i18n.t('service_marketplace.bid_updated_title') : i18n.t('service_marketplace.bid_sent_title'),
        action === 'updated' ? i18n.t('service_marketplace.bid_updated_body') : i18n.t('service_marketplace.bid_sent_body'),
      );
      await load();
    } catch (e: any) {
      const status = e?.response?.status;
      const msg =
        status === 401 ? i18n.t('service_marketplace.bid_error_session') :
        status === 403 ? i18n.t('service_marketplace.bid_error_role') :
        (e?.response?.data?.detail || e?.message || i18n.t('service_marketplace.bid_error_generic'));
      Alert.alert(i18n.t('service_marketplace.error_generic'), String(msg));
    } finally {
      setSubmitting(false);
    }
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
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity testID="public-detail-back" onPress={() => router.back()} style={[styles.iconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Ionicons name="chevron-back" size={20} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('service_marketplace.request')}</Text>
          <View style={{ width: 36 }} />
        </View>
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
          <Text style={[styles.empty, { color: colors.textSecondary }]}>
            {t('service_marketplace.request_not_public_anymore')}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const urgCol = URGENCY_COLOR[doc.urgency];
  const statusCol = doc.status === 'bidding' ? '#f59e0b' : '#3b82f6';
  const catLabel = pickCategoryTitle(doc.categoryMeta, doc.category);

  const budgetText = doc.budget
    ? (doc.budget.min != null && doc.budget.max != null
        ? i18n.t('service_marketplace.budget_range', { from: fmtCur(doc.budget.min, doc.budget.currency), to: fmtCur(doc.budget.max, doc.budget.currency) })
        : doc.budget.max != null
          ? i18n.t('service_marketplace.budget_up_to', { amount: fmtCur(doc.budget.max, doc.budget.currency) })
          : i18n.t('service_marketplace.budget_from', { amount: fmtCur(doc.budget.min || 0, doc.budget.currency) }))
    : null;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity testID="public-detail-back" onPress={() => router.back()} style={[styles.iconBtn, { backgroundColor: colors.card, borderColor: colors.border }]} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {t('service_marketplace.detail_title_short', { id: doc.id.slice(0, 6) })}
        </Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        <View style={styles.pillRow}>
          <View style={[styles.statusBox, { backgroundColor: statusCol + '15', borderColor: statusCol }]}>
            <View style={[styles.dot, { backgroundColor: statusCol }]} />
            <Text style={[styles.statusText, { color: statusCol }]}>
              {t(`service_marketplace.status_${doc.status}`)}
            </Text>
          </View>
          {doc.urgency !== 'normal' && (
            <View style={[styles.urgencyBox, { backgroundColor: urgCol + '15', borderColor: urgCol }]}>
              <Ionicons name="flash" size={12} color={urgCol} />
              <Text style={[styles.urgencyText, { color: urgCol }]}>
                {t(`service_marketplace.urgency_${doc.urgency}`)}
              </Text>
            </View>
          )}
        </View>

        <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={styles.heroEmoji}>{doc.categoryMeta?.emoji || '📋'}</Text>
          <Text style={[styles.heroTitle, { color: colors.text }]}>
            {doc.title || catLabel}
          </Text>
          <View style={styles.heroMetaRow}>
            <Ionicons name="location-outline" size={14} color={colors.textSecondary} />
            <Text style={[styles.heroMeta, { color: colors.textSecondary }]}>
              {doc.city.charAt(0).toUpperCase() + doc.city.slice(1)}
            </Text>
            <Text style={[styles.heroMeta, { color: colors.textSecondary }]}>·</Text>
            <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
            <Text style={[styles.heroMeta, { color: colors.textSecondary }]}>{timeAgo(doc.createdAt)}</Text>
          </View>
          {!!catLabel && (
            <View style={[styles.catBadge, { backgroundColor: colors.background, borderColor: colors.border }]}>
              <Text style={[styles.catBadgeText, { color: colors.textSecondary }]}>
                {t('service_marketplace.category')} · {catLabel}
              </Text>
            </View>
          )}
        </View>

        {!!doc.description && (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {t('service_marketplace.description')}
            </Text>
            <Text style={[styles.sectionText, { color: colors.text }]}>{doc.description}</Text>
          </View>
        )}

        {doc.budget && (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.sectionHeader}>
              <Ionicons name="cash-outline" size={16} color={colors.primary} />
              <Text style={[styles.sectionTitle, { color: colors.text }]}>
                {t('service_marketplace.budget_client')}
              </Text>
            </View>
            <Text style={[styles.budgetText, { color: colors.text }]}>{budgetText}</Text>
            <Text style={[styles.budgetHint, { color: colors.textSecondary }]}>
              {t('service_marketplace.budget_hint')}
            </Text>
          </View>
        )}

        {Array.isArray(doc.photos) && doc.photos.length > 0 && (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {t('service_marketplace.photos')} ({doc.photos.length})
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
              {doc.photos.map((_url, i) => (
                <View key={i} style={[styles.photoBox, { backgroundColor: colors.background, borderColor: colors.border }]}>
                  <Text style={{ color: colors.textMuted, fontSize: 10 }}>{`📷 ${i + 1}`}</Text>
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        <View style={[styles.noticeBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="lock-closed-outline" size={14} color={colors.textSecondary} />
          <Text style={[styles.noticeText, { color: colors.textSecondary }]}>
            {t('service_marketplace.privacy_notice')}
          </Text>
        </View>

        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.sectionHeader}>
            <Ionicons name="chatbubbles-outline" size={16} color={colors.primary} />
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {t('service_marketplace.responses')} ({bids.length})
            </Text>
          </View>
          {bids.length === 0 ? (
            <Text style={[styles.sectionText, { color: colors.textSecondary, marginTop: 8 }]}>
              {t('service_marketplace.responses_empty')}
            </Text>
          ) : (
            bids.map((b) => (
              <View key={b.id} style={[styles.bidCard, { borderColor: colors.border }]}>
                <View style={styles.bidHeader}>
                  <View style={[styles.avatar, { backgroundColor: colors.primary + '22' }]}>
                    <Ionicons name="business" size={16} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.bidProvider, { color: colors.text }]} numberOfLines={1}>
                      {b.providerName?.includes('@') ? t('service_marketplace.executor') : (b.providerName || t('service_marketplace.executor'))}
                    </Text>
                    <View style={styles.bidMetaRow}>
                      {b.providerRating != null && (
                        <>
                          <Ionicons name="star" size={11} color="#f59e0b" />
                          <Text style={[styles.bidMeta, { color: colors.textSecondary }]}>
                            {t('service_marketplace.rating_short', { value: b.providerRating.toFixed(1) })}
                          </Text>
                          <Text style={[styles.bidMeta, { color: colors.textSecondary }]}>·</Text>
                        </>
                      )}
                      <Text style={[styles.bidMeta, { color: colors.textSecondary }]}>{timeAgo(b.createdAt)}</Text>
                    </View>
                  </View>
                  <Text style={[styles.bidPrice, { color: colors.text }]}>{fmtCur(b.price, b.currency)}</Text>
                </View>
                {!!b.message && (
                  <Text style={[styles.bidMessage, { color: colors.text }]} numberOfLines={3}>
                    {b.message}
                  </Text>
                )}
                {b.etaMinutes != null && (
                  <View style={styles.bidEtaRow}>
                    <Ionicons name="time-outline" size={12} color={colors.textSecondary} />
                    <Text style={[styles.bidEta, { color: colors.textSecondary }]}>
                      {t('service_marketplace.eta_about', { minutes: b.etaMinutes })}
                    </Text>
                  </View>
                )}
              </View>
            ))
          )}
        </View>
      </ScrollView>

      <View style={[styles.bottomBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
        {canBid ? (
          <TouchableOpacity
            testID="public-bid-cta"
            onPress={handleOpenBid}
            activeOpacity={0.85}
            style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
          >
            <Ionicons name="paper-plane" size={18} color="#000" />
            <Text style={styles.primaryBtnText}>{t('service_marketplace.detail_cta_provider')}</Text>
          </TouchableOpacity>
        ) : isAuthenticated ? (
          <View style={[styles.infoBtn, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Ionicons name="information-circle-outline" size={16} color={colors.textSecondary} />
            <Text style={[styles.infoText, { color: colors.textSecondary }]} numberOfLines={2}>
              {t('service_marketplace.detail_cta_customer_hint')}
            </Text>
          </View>
        ) : (
          <View style={styles.guestActions}>
            <TouchableOpacity
              testID="public-login-cta"
              onPress={() => router.push('/login' as any)}
              activeOpacity={0.85}
              style={[styles.primaryBtn, { backgroundColor: colors.primary, flex: 1 }]}
            >
              <Ionicons name="log-in-outline" size={18} color="#000" />
              <Text style={styles.primaryBtnText}>{t('service_marketplace.detail_cta_guest')}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <Modal
        visible={bidOpen}
        animationType="slide"
        transparent
        onRequestClose={() => !submitting && setBidOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalRoot}
        >
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={() => !submitting && setBidOpen(false)}
          />
          <View style={[styles.modalSheet, { backgroundColor: colors.card }]}>
            <View style={styles.modalHandle} />
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {t('service_marketplace.bid_modal_title')}
            </Text>
            <Text style={[styles.modalSub, { color: colors.textSecondary }]}>
              {t('service_marketplace.bid_modal_sub')}
            </Text>

            <Text style={[styles.label, { color: colors.text }]}>
              {t('service_marketplace.bid_price_label', { currency: doc.budget?.currency || 'EUR' })}
            </Text>
            <TextInput
              testID="bid-price"
              style={[styles.input, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
              placeholder={t('service_marketplace.bid_price_placeholder_example', { n: doc.budget?.max ?? 100 })}
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              value={bidPrice}
              onChangeText={setBidPrice}
              editable={!submitting}
            />

            <Text style={[styles.label, { color: colors.text }]}>
              {t('service_marketplace.bid_eta_label')}
            </Text>
            <TextInput
              testID="bid-eta"
              style={[styles.input, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
              placeholder={t('service_marketplace.bid_eta_placeholder_example')}
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              value={bidEta}
              onChangeText={setBidEta}
              editable={!submitting}
            />

            <Text style={[styles.label, { color: colors.text }]}>
              {t('service_marketplace.bid_message_label')}
            </Text>
            <TextInput
              testID="bid-message"
              style={[styles.input, styles.textarea, { backgroundColor: colors.background, color: colors.text, borderColor: colors.border }]}
              placeholder={t('service_marketplace.bid_message_placeholder')}
              placeholderTextColor={colors.textMuted}
              value={bidMessage}
              onChangeText={setBidMessage}
              multiline
              maxLength={500}
              editable={!submitting}
            />
            <Text style={[styles.counter, { color: colors.textMuted }]}>{bidMessage.length}/500</Text>

            <View style={styles.modalActions}>
              <TouchableOpacity
                testID="bid-cancel"
                onPress={() => setBidOpen(false)}
                disabled={submitting}
                activeOpacity={0.8}
                style={[styles.secondaryBtn, { borderColor: colors.border }]}
              >
                <Text style={[styles.secondaryBtnText, { color: colors.text }]}>
                  {t('service_marketplace.bid_cancel')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="bid-submit"
                onPress={handleSubmitBid}
                disabled={submitting}
                activeOpacity={0.85}
                style={[styles.primaryBtn, { backgroundColor: colors.primary, flex: 1, opacity: submitting ? 0.6 : 1 }]}
              >
                {submitting ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <>
                    <Ionicons name="paper-plane" size={18} color="#000" />
                    <Text style={styles.primaryBtnText}>{t('service_marketplace.bid_submit')}</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
  iconBtn: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  pillRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  statusBox: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, borderWidth: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 12, fontWeight: '700' },
  urgencyBox: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, borderWidth: 1 },
  urgencyText: { fontSize: 12, fontWeight: '700' },
  heroCard: { padding: 18, borderRadius: 16, borderWidth: 1, alignItems: 'center', marginBottom: 12 },
  heroEmoji: { fontSize: 40 },
  heroTitle: { fontSize: 20, fontWeight: '700', marginTop: 8, textAlign: 'center' },
  heroMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  heroMeta: { fontSize: 12 },
  catBadge: { marginTop: 10, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, borderWidth: 1 },
  catBadgeText: { fontSize: 11, fontWeight: '600' },
  section: { padding: 14, borderRadius: 14, borderWidth: 1, marginBottom: 12 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  sectionTitle: { fontSize: 14, fontWeight: '700' },
  sectionText: { fontSize: 14, lineHeight: 21 },
  budgetText: { fontSize: 22, fontWeight: '700', marginTop: 4 },
  budgetHint: { fontSize: 11, marginTop: 6, lineHeight: 16 },
  photoBox: { width: 80, height: 80, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  noticeBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, marginBottom: 12 },
  noticeText: { flex: 1, fontSize: 11, lineHeight: 16 },
  bidCard: { padding: 12, borderRadius: 10, borderWidth: 1, marginTop: 8 },
  bidHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  bidProvider: { fontSize: 14, fontWeight: '700' },
  bidMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  bidMeta: { fontSize: 11 },
  bidPrice: { fontSize: 16, fontWeight: '700' },
  bidMessage: { fontSize: 13, lineHeight: 18, marginTop: 8 },
  bidEtaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  bidEta: { fontSize: 11 },
  bottomBar: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, paddingBottom: 24, borderTopWidth: 1 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 12 },
  primaryBtnText: { fontSize: 15, fontWeight: '700', color: '#000' },
  infoBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  infoText: { flex: 1, fontSize: 12, lineHeight: 16 },
  guestActions: { flexDirection: 'row', gap: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  empty: { fontSize: 14, textAlign: 'center' },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 24, borderTopLeftRadius: 22, borderTopRightRadius: 22 },
  modalHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: '#888', opacity: 0.4, marginBottom: 12 },
  modalTitle: { fontSize: 18, fontWeight: '700' },
  modalSub: { fontSize: 12, marginTop: 4, lineHeight: 17 },
  label: { fontSize: 12, fontWeight: '600', marginTop: 14, marginBottom: 6 },
  input: { paddingHorizontal: 12, paddingVertical: 12, borderRadius: 10, borderWidth: 1, fontSize: 14 },
  textarea: { minHeight: 90, textAlignVertical: 'top' },
  counter: { fontSize: 10, textAlign: 'right', marginTop: 2 },
  modalActions: { flexDirection: 'row', gap: 8, marginTop: 16 },
  secondaryBtn: { paddingHorizontal: 18, paddingVertical: 14, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  secondaryBtnText: { fontSize: 14, fontWeight: '600' },
});

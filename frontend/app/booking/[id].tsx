import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import { useThemeContext } from '../../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { bookingsAPI, api } from '../../src/services/api';
import { theme } from '../../src/context/ThemeContext';
import i18n from '../../src/i18n';
const colors = theme.colors;

export default function BookingDetailsScreen() {
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [booking, setBooking] = useState<any>(null);
  const [cancelling, setCancelling] = useState(false);

  const fetchBooking = async () => {
    try {
      const res = await bookingsAPI.getById(id as string);
      setBooking(res.data);
    } catch (error) {
      console.error('Error fetching booking:', error);
      Alert.alert(i18n.t('common.error'), i18n.t('booking.load_error'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchBooking();
  }, [id]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchBooking();
  };

  const handlePay = () => {
    router.push({
      pathname: '/booking/payment',
      params: {
        bookingId: booking._id,
        price: String(booking.snapshot?.price || 0),
        orgName: booking.snapshot?.orgName || i18n.t('booking.fallback_org'),
        serviceName: booking.snapshot?.serviceName || i18n.t('booking.fallback_service'),
      },
    });
  };

  const handleCancel = () => {
    Alert.alert(i18n.t('booking.cancel_confirm_title'), i18n.t('booking.cancel_confirm_msg'), [
      { text: i18n.t('booking.cancel_no'), style: 'cancel' },
      {
        text: i18n.t('booking.cancel_yes'),
        style: 'destructive',
        onPress: async () => {
          setCancelling(true);
          try {
            await api.patch(`/bookings/${id}/status`, { status: 'cancelled' });
            Alert.alert(i18n.t('booking.cancel_success'));
            fetchBooking();
          } catch (error: any) {
            const msg = error.response?.data?.message || i18n.t('booking.cancel_error');
            Alert.alert(i18n.t('common.error'), Array.isArray(msg) ? msg[0] : msg);
          } finally {
            setCancelling(false);
          }
        },
      },
    ]);
  };

  const handleReview = () => {
    router.push({
      pathname: '/review/create',
      params: {
        bookingId: booking._id,
        orgName: booking.snapshot?.orgName || i18n.t('booking.fallback_org'),
        serviceName: booking.snapshot?.serviceName || i18n.t('booking.fallback_service'),
      },
    });
  };

  const handleDispute = () => {
    Alert.alert(i18n.t('booking.dispute_title'), i18n.t('booking.dispute_msg'));
  };

  // 🔥 REPEAT BOOKING - 1 клік = новий заказ
  const handleRepeat = () => {
    router.push({
      pathname: '/booking/repeat',
      params: {
        bookingId: booking._id,
        organizationId: booking.organizationId,
        branchId: booking.branchId,
        serviceId: booking.providerServiceId,
        vehicleId: booking.vehicleId || '',
        orgName: booking.snapshot?.orgName || i18n.t('booking.fallback_org'),
        serviceName: booking.snapshot?.serviceName || i18n.t('booking.fallback_service'),
        price: String(booking.snapshot?.price || 0),
        branchAddress: booking.snapshot?.branchAddress || '',
      },
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return colors.warning;
      case 'confirmed': return colors.brand;
      case 'in_progress': return colors.brand;
      case 'completed': return colors.success;
      case 'cancelled': return colors.brand;
      default: return colors.textMuted;
    }
  };

  // Status / payment labels resolved via i18n. Unknown statuses fall back to
  // the raw token so the surface still renders something readable.
  const STATUS_KEYS = ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show'];
  const PAYMENT_KEYS = ['paid', 'refunded'];

  const getStatusText = (status: string) =>
    STATUS_KEYS.includes(status) ? i18n.t(`booking.status.${status}`) : status;

  const getPaymentText = (status: string) =>
    PAYMENT_KEYS.includes(status) ? i18n.t(`booking.payment.${status}`) : i18n.t('booking.payment.unpaid');

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (!booking) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <View style={[styles.emptyIconWrap, { backgroundColor: colors.cardElevated, borderColor: colors.border }]}>
            <Ionicons name="document-text-outline" size={42} color={colors.textMuted} />
          </View>
          <Text style={styles.emptyTitle}>{t('booking_screen.not_found_title')}</Text>
          <Text style={styles.emptySub}>{t('booking_screen.not_found_sub')}</Text>
          <TouchableOpacity style={styles.goBackBtn} onPress={() => router.back()} testID="booking-not-found-back">
            <Text style={styles.goBackText}>{t('booking_screen.not_found_back')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const isPaid = booking.paymentStatus === 'paid' || booking.isPaid;
  const canPay = !isPaid && booking.status !== 'cancelled' && booking.status !== 'completed';
  const canCancel = booking.status === 'pending' || booking.status === 'confirmed';
  const isCompleted = booking.status === 'completed';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity testID="booking-back-btn" onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('booking.header_title')}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        style={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
      >
        {/* Status */}
        <View style={styles.statusSection}>
          <View style={[styles.statusBadge, { backgroundColor: `${getStatusColor(booking.status)}20` }]}>
            <View style={[styles.statusDot, { backgroundColor: getStatusColor(booking.status) }]} />
            <Text testID="booking-status" style={[styles.statusText, { color: getStatusColor(booking.status) }]}>
              {getStatusText(booking.status)}
            </Text>
          </View>
          <View style={[styles.paymentBadge, { backgroundColor: isPaid ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)' }]}>
            <Text style={[styles.paymentText, { color: isPaid ? colors.success : colors.warning }]}>
              {getPaymentText(booking.paymentStatus)}
            </Text>
          </View>
        </View>

        {/* Main Card */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.orgIcon}>
              <Ionicons name="business" size={28} color={colors.brand} />
            </View>
            <View style={styles.cardHeaderInfo}>
              <Text testID="booking-org-name" style={styles.orgName}>{booking.snapshot?.orgName || t('booking.fallback_org')}</Text>
              <Text style={styles.serviceName}>{booking.snapshot?.serviceName || t('booking.fallback_service')}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          {/* Schedule */}
          {booking.scheduledAt && (
            <View style={styles.detailRow}>
              <View style={styles.detailIcon}>
                <Ionicons name="calendar-outline" size={20} color={colors.brand} />
              </View>
              <View style={styles.detailInfo}>
                <Text style={styles.detailLabel}>{t('booking.date_time_label')}</Text>
                <Text style={styles.detailValue}>
                  {new Date(booking.scheduledAt).toLocaleDateString('ru-RU', {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })}{' '}
                  {t('booking.date_time_at')}{' '}
                  {new Date(booking.scheduledAt).toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
            </View>
          )}

          {/* Address */}
          {booking.snapshot?.branchAddress && (
            <View style={styles.detailRow}>
              <View style={styles.detailIcon}>
                <Ionicons name="location-outline" size={20} color={colors.brand} />
              </View>
              <View style={styles.detailInfo}>
                <Text style={styles.detailLabel}>{t('booking.address_label')}</Text>
                <Text style={styles.detailValue}>{booking.snapshot.branchAddress}</Text>
              </View>
            </View>
          )}

          <View style={styles.divider} />

          {/* Price */}
          <View style={styles.priceRow}>
            <Text style={styles.priceLabel}>{t('booking.price_label')}</Text>
            <Text testID="booking-price" style={styles.priceValue}>
              {(booking.snapshot?.price || 0).toLocaleString()} ₽
            </Text>
          </View>
        </View>

        {/* Actions */}
        <View style={styles.actionsSection}>
          {canPay && (
            <TouchableOpacity testID="booking-pay-btn" style={styles.payButton} onPress={handlePay}>
              <Ionicons name="card" size={20} color={colors.text} />
              <Text style={styles.payButtonText}>{t('booking.pay_cta')}</Text>
            </TouchableOpacity>
          )}

          {isCompleted && (
            <>
              {/* 🔥 REPEAT BOOKING - головна кнопка для LTV */}
              <TouchableOpacity 
                testID="booking-repeat-btn" 
                style={styles.repeatButton} 
                onPress={handleRepeat}
              >
                <Ionicons name="repeat" size={20} color={colors.text} />
                <Text style={styles.repeatButtonText}>{t('booking.repeat_cta')}</Text>
              </TouchableOpacity>
              
              <TouchableOpacity testID="booking-review-btn" style={styles.reviewButton} onPress={handleReview}>
                <Ionicons name="star" size={20} color={colors.warning} />
                <Text style={styles.reviewButtonText}>{t('booking.review_cta')}</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="booking-dispute-btn" style={styles.disputeButton} onPress={handleDispute}>
                <Ionicons name="alert-circle" size={20} color={colors.brand} />
                <Text style={styles.disputeButtonText}>{t('booking.dispute_cta')}</Text>
              </TouchableOpacity>
            </>
          )}

          {canCancel && (
            <TouchableOpacity
              testID="booking-cancel-btn"
              style={styles.cancelButton}
              onPress={handleCancel}
              disabled={cancelling}
            >
              {cancelling ? (
                <ActivityIndicator color={colors.brand} />
              ) : (
                <Text style={styles.cancelButtonText}>{t('booking.cancel_cta')}</Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { fontSize: 16, color: colors.brand },
  emptyIconWrap: {
    width: 88, height: 88, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, marginBottom: 18,
  },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: colors.text, marginBottom: 6, textAlign: 'center' },
  emptySub: { fontSize: 14, color: colors.textMuted, textAlign: 'center', paddingHorizontal: 32, lineHeight: 20 },
  goBackBtn: {
    marginTop: 22, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 12,
    backgroundColor: colors.brand,
  },
  goBackText: { fontSize: 15, fontWeight: '800', color: colors.brandText },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backButton: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 18, fontWeight: '600', color: colors.text },
  content: { flex: 1, paddingHorizontal: 20 },
  statusSection: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginTop: 20,
  },
  statusBadge: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 20, gap: 8,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 14, fontWeight: '600' },
  paymentBadge: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
  },
  paymentText: { fontSize: 13, fontWeight: '600' },
  card: {
    backgroundColor: colors.backgroundTertiary,
    borderRadius: 16, padding: 20, marginTop: 20,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center' },
  orgIcon: {
    width: 56, height: 56, borderRadius: 14,
    backgroundColor: 'rgba(59,130,246,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  cardHeaderInfo: { flex: 1, marginLeft: 16 },
  orgName: { fontSize: 18, fontWeight: '700', color: colors.text },
  serviceName: { fontSize: 14, color: colors.textMuted, marginTop: 4 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 16 },
  detailRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  detailIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(59,130,246,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  detailInfo: { marginLeft: 12 },
  detailLabel: { fontSize: 12, color: colors.textMuted },
  detailValue: { fontSize: 15, fontWeight: '600', color: colors.text, marginTop: 2 },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  priceLabel: { fontSize: 15, color: colors.textMuted },
  priceValue: { fontSize: 22, fontWeight: '700', color: colors.success },
  actionsSection: { marginTop: 24, gap: 12 },
  payButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.success, paddingVertical: 16, borderRadius: 12, gap: 8,
  },
  payButtonText: { fontSize: 17, fontWeight: '600', color: colors.onPrimary },
  repeatButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary, paddingVertical: 16, borderRadius: 12, gap: 8,
  },
  repeatButtonText: { fontSize: 16, fontWeight: '700', color: colors.onPrimary },
  reviewButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(245,158,11,0.15)', paddingVertical: 16, borderRadius: 12, gap: 8,
  },
  reviewButtonText: { fontSize: 15, fontWeight: '600', color: colors.warning },
  disputeButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(239,68,68,0.1)', paddingVertical: 14, borderRadius: 12, gap: 8,
  },
  disputeButtonText: { fontSize: 15, fontWeight: '600', color: colors.brand },
  cancelButton: { alignItems: 'center', paddingVertical: 16 },
  cancelButtonText: { fontSize: 15, color: colors.brand },
});

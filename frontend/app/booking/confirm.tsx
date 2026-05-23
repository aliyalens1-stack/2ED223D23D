import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/services/api';
import { useRequireAuth } from '../../src/hooks/useRequireAuth';
import { AuthRequiredModal } from '../../src/components/AuthRequiredModal';
import { theme } from '../../src/context/ThemeContext';
import i18n from '../../src/i18n';
const colors = theme.colors;

export default function BookingConfirmScreen() {
  const { colors } = useThemeContext();
  const { t, i18n } = useTranslation();
  const styles = makeStyles(colors);
  const router = useRouter();
  const params = useLocalSearchParams();
  const {
    slotId,
    quoteId,
    responseId,
    branchId,
    providerServiceId,
    price,
    orgName,
    serviceName,
    date,
    startTime,
    endTime,
  } = params;

  const [submitting, setSubmitting] = useState(false);
  // Sprint Auth-2: protected action — booking confirm требует auth
  const { requireAuth, authModalVisible, closeAuthModal, authReason } = useRequireAuth();

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const locale = i18n.language === 'de' ? 'de-DE' : i18n.language === 'en' ? 'en-US' : 'ru-RU';
    return d.toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  };

  const handleConfirmBooking = async () => {
    requireAuth(
      async () => {
        await doConfirmBooking();
      },
      {
        intent: 'booking_confirm',
        reason: i18n.t('booking_flow.confirm.auth_reason'),
        params: {
          slotId: String(slotId || ''),
          quoteId: String(quoteId || ''),
          responseId: String(responseId || ''),
          branchId: String(branchId || ''),
          providerServiceId: String(providerServiceId || ''),
          price: String(price || ''),
          orgName: String(orgName || ''),
          serviceName: String(serviceName || ''),
          date: String(date || ''),
          startTime: String(startTime || ''),
          endTime: String(endTime || ''),
        },
      }
    );
  };

  const doConfirmBooking = async () => {
    setSubmitting(true);
    try {
      const res = await api.post('/bookings/create-with-slot', {
        slotId,
        branchId,
        providerServiceId,
        quoteId: quoteId || undefined,
        customerNotes: '',
      });

      const booking = res.data.booking;
      router.replace({
        pathname: '/booking/payment',
        params: {
          bookingId: booking._id,
          price: price as string,
          orgName: orgName as string,
          serviceName: serviceName as string,
        },
      });
    } catch (error: any) {
      const message = error.response?.data?.message || i18n.t('booking_flow.confirm.error_default');
      Alert.alert(i18n.t('booking_flow.confirm.error_title'), Array.isArray(message) ? message[0] : message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('booking_flow.confirm.title')}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView style={styles.content}>
        <View style={styles.bookingCard}>
          <View style={styles.cardHeader}>
            <View style={styles.orgIcon}>
              <Ionicons name="business" size={28} color={colors.brand} />
            </View>
            <View style={styles.cardHeaderInfo}>
              <Text style={styles.orgName}>{orgName}</Text>
              <Text style={styles.serviceName}>{serviceName}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.detailRow}>
            <View style={styles.detailIcon}>
              <Ionicons name="calendar-outline" size={20} color={colors.brand} />
            </View>
            <View style={styles.detailInfo}>
              <Text style={styles.detailLabel}>{t('booking_flow.confirm.date_label')}</Text>
              <Text style={styles.detailValue}>{formatDate(date as string)}</Text>
            </View>
          </View>

          <View style={styles.detailRow}>
            <View style={styles.detailIcon}>
              <Ionicons name="time-outline" size={20} color={colors.brand} />
            </View>
            <View style={styles.detailInfo}>
              <Text style={styles.detailLabel}>{t('booking_flow.confirm.time_label')}</Text>
              <Text style={styles.detailValue}>{startTime} - {endTime}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.priceRow}>
            <Text style={styles.priceLabel}>{t('booking_flow.confirm.service_price')}</Text>
            <Text style={styles.priceValue}>{Number(price).toLocaleString()} €</Text>
          </View>
        </View>

        <View style={styles.infoNotice}>
          <Ionicons name="information-circle" size={20} color={colors.brand} />
          <Text style={styles.infoText}>
            {t('booking_flow.confirm.info_notice')}
          </Text>
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>

      <View style={styles.bottomCTA}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>{t('booking_flow.confirm.total')}</Text>
          <Text style={styles.totalValue}>{Number(price).toLocaleString()} €</Text>
        </View>
        <TouchableOpacity
          style={[styles.confirmButton, submitting && styles.confirmButtonDisabled]}
          onPress={handleConfirmBooking}
          disabled={submitting}
          testID="confirm-booking-btn"
        >
          {submitting ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <>
              <Text style={styles.confirmButtonText}>{t('booking_flow.confirm.confirm_pay')}</Text>
              <Ionicons name="arrow-forward" size={20} color={colors.text} />
            </>
          )}
        </TouchableOpacity>
      </View>
      <AuthRequiredModal
        visible={authModalVisible}
        onClose={closeAuthModal}
        reason={authReason}
      />
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
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
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
  },
  bookingCard: {
    backgroundColor: colors.backgroundTertiary,
    borderRadius: 16,
    padding: 20,
    marginTop: 20,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  orgIcon: {
    width: 56,
    height: 56,
    borderRadius: 14,
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardHeaderInfo: {
    flex: 1,
    marginLeft: 16,
  },
  orgName: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  },
  serviceName: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 4,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 16,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  detailIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailInfo: {
    marginLeft: 12,
  },
  detailLabel: {
    fontSize: 12,
    color: colors.textMuted,
  },
  detailValue: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    marginTop: 2,
  },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  priceLabel: {
    fontSize: 15,
    color: colors.textMuted,
  },
  priceValue: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.success,
  },
  infoNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderRadius: 12,
    padding: 16,
    marginTop: 20,
    gap: 12,
  },
  infoText: {
    flex: 1,
    fontSize: 14,
    color: colors.textMuted,
    lineHeight: 20,
  },
  bottomCTA: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 20,
    paddingVertical: 16,
    paddingBottom: 32,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  totalLabel: {
    fontSize: 15,
    color: colors.textMuted,
  },
  totalValue: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  confirmButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.success,
    paddingVertical: 16,
    borderRadius: 12,
    gap: 8,
  },
  confirmButtonDisabled: {
    opacity: 0.7,
  },
  confirmButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.onPrimary,
  },
});

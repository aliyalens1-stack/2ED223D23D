import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useThemeContext } from '../../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api, paymentsAPI } from '../../src/services/api';
import { theme } from '../../src/context/ThemeContext';
import i18n from '../../src/i18n';
const colors = theme.colors;

export default function PaymentScreen() {
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const router = useRouter();
  const params = useLocalSearchParams();
  const { bookingId, price, orgName, serviceName } = params;

  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [payment, setPayment] = useState<any>(null);

  useEffect(() => {
    createPayment();
  }, []);

  const createPayment = async () => {
    try {
      const res = await paymentsAPI.create(bookingId as string);
      setPayment(res.data);
    } catch (error: any) {
      const message = error.response?.data?.message || i18n.t('booking.ne_udalos_sozdat_platezh');
      Alert.alert(i18n.t('chat.oshibka'), Array.isArray(message) ? message[0] : message);
    } finally {
      setLoading(false);
    }
  };

  const handlePay = async () => {
    if (!payment) return;

    setProcessing(true);
    try {
      // In mock mode, confirm payment directly
      await api.post(`/payments/${payment._id}/confirm-mock`);

      // Navigate to success
      router.replace({
        pathname: '/booking/success',
        params: {
          bookingId: bookingId as string,
        },
      });
    } catch (error: any) {
      const message = error.response?.data?.message || i18n.t('booking.oshibka_oplaty');
      Alert.alert(i18n.t('chat.oshibka'), Array.isArray(message) ? message[0] : message);
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.brand} />
          <Text style={styles.loadingText}>{t('booking.sozdanie_platezha')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const amount = payment?.amount || Number(price) || 0;
  const platformFee = payment?.platformFee || Math.round(amount * 0.15);

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="close" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('booking.oplata')}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView style={styles.content}>
        {/* Payment Card */}
        <View style={styles.paymentCard}>
          <View style={styles.iconContainer}>
            <Ionicons name="card" size={40} color={colors.brand} />
          </View>
          <Text style={styles.amountText}>{amount.toLocaleString()} ₽</Text>
          <Text style={styles.serviceText}>{serviceName}</Text>
          <Text style={styles.orgText}>{orgName}</Text>
        </View>

        {/* Details */}
        <View style={styles.detailsCard}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('booking.stoimost_uslugi')}</Text>
            <Text style={styles.detailValue}>{amount.toLocaleString()} ₽</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>{t('booking.komissiya_platformy')}</Text>
            <Text style={styles.detailValueSmall}>{t('booking.vklyuchena')}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.detailRow}>
            <Text style={styles.totalLabel}>{t('booking.itogo')}</Text>
            <Text style={styles.totalValue}>{amount.toLocaleString()} ₽</Text>
          </View>
        </View>

        {/* Payment Methods */}
        <View style={styles.methodsSection}>
          <Text style={styles.sectionTitle}>{t('booking.sposob_oplaty')}</Text>
          <View style={styles.methodCard}>
            <View style={styles.methodIcon}>
              <Ionicons name="card-outline" size={24} color={colors.brand} />
            </View>
            <View style={styles.methodInfo}>
              <Text style={styles.methodTitle}>{t('booking.bankovskaya_karta')}</Text>
              <Text style={styles.methodSubtitle}>{t('booking.visa_mastercard_mir')}</Text>
            </View>
            <View style={styles.methodCheck}>
              <Ionicons name="checkmark-circle" size={24} color={colors.success} />
            </View>
          </View>
        </View>

        {/* Test Mode Notice */}
        <View style={styles.testNotice}>
          <Ionicons name="information-circle" size={20} color={colors.warning} />
          <Text style={styles.testNoticeText}>
            Тестовый режим. Реальная оплата не производится.
          </Text>
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Bottom CTA */}
      <View style={styles.bottomCTA}>
        <TouchableOpacity
          style={[styles.payButton, processing && styles.payButtonDisabled]}
          onPress={handlePay}
          disabled={processing}
          testID="pay-btn"
        >
          {processing ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <>
              <Ionicons name="lock-closed" size={20} color={colors.text} />
              <Text style={styles.payButtonText}>Оплатить {amount.toLocaleString()} ₽</Text>
            </>
          )}
        </TouchableOpacity>
        <Text style={styles.secureText}>
          <Ionicons name="shield-checkmark" size={12} color={colors.textMuted} /> Безопасная оплата
        </Text>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: 16,
    color: colors.textMuted,
    marginTop: 16,
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
  paymentCard: {
    alignItems: 'center',
    backgroundColor: colors.backgroundTertiary,
    borderRadius: 20,
    padding: 32,
    marginTop: 20,
  },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: 20,
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  amountText: {
    fontSize: 36,
    fontWeight: '800',
    color: colors.text,
  },
  serviceText: {
    fontSize: 16,
    color: colors.textMuted,
    marginTop: 8,
  },
  orgText: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 4,
  },
  detailsCard: {
    backgroundColor: colors.backgroundTertiary,
    borderRadius: 16,
    padding: 20,
    marginTop: 20,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  detailLabel: {
    fontSize: 14,
    color: colors.textMuted,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  detailValueSmall: {
    fontSize: 14,
    color: colors.success,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 12,
  },
  totalLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  totalValue: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  },
  methodsSection: {
    marginTop: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 12,
  },
  methodCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.backgroundTertiary,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.brand,
  },
  methodIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  methodInfo: {
    flex: 1,
    marginLeft: 12,
  },
  methodTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  methodSubtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },
  methodCheck: {
    marginLeft: 8,
  },
  testNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderRadius: 12,
    padding: 16,
    marginTop: 20,
    gap: 12,
  },
  testNoticeText: {
    flex: 1,
    fontSize: 14,
    color: colors.warning,
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
  payButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.success,
    paddingVertical: 16,
    borderRadius: 12,
    gap: 8,
  },
  payButtonDisabled: {
    opacity: 0.7,
  },
  payButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  secureText: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 12,
  },
});

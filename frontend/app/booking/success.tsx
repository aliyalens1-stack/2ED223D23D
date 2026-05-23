import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

export default function PaymentSuccessScreen() {
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { bookingId } = useLocalSearchParams();

  const handleViewBooking = () => {
    router.replace({
      pathname: '/booking/[id]',
      params: { id: bookingId as string },
    });
  };

  const handleGoHome = () => {
    router.replace('/(tabs)');
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconContainer}>
          <View style={styles.iconCircle}>
            <Ionicons name="checkmark" size={64} color={colors.success} />
          </View>
        </View>

        <Text style={styles.title}>{t('booking_flow.success.title')}</Text>
        <Text style={styles.subtitle}>{t('booking_flow.success.subtitle')}</Text>

        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Ionicons name="notifications-outline" size={20} color={colors.brand} />
            <Text style={styles.infoText}>
              {t('booking_flow.success.info_reminder')}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="location-outline" size={20} color={colors.brand} />
            <Text style={styles.infoText}>
              {t('booking_flow.success.info_address')}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.buttons}>
        <TouchableOpacity style={styles.primaryButton} onPress={handleViewBooking} testID="view-booking-btn">
          <Text style={styles.primaryButtonText}>{t('booking_flow.success.view_booking')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={handleGoHome} testID="go-home-btn">
          <Text style={styles.secondaryButtonText}>{t('booking_flow.success.go_home')}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  iconContainer: {
    marginBottom: 32,
  },
  iconCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  infoCard: {
    backgroundColor: colors.backgroundTertiary,
    borderRadius: 16,
    padding: 20,
    width: '100%',
    gap: 16,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  infoText: {
    flex: 1,
    fontSize: 14,
    color: colors.textMuted,
  },
  buttons: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    paddingBottom: 32,
    gap: 12,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  secondaryButton: {
    backgroundColor: colors.border,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  secondaryButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.onPrimary,
  },
});

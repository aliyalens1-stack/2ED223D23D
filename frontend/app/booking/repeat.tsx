import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import { useThemeContext } from '../../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { quotesAPI, api } from '../../src/services/api';
import { useAuth } from '../../src/context/AuthContext';
import { theme } from '../../src/context/ThemeContext';
import i18n from '../../src/i18n';
const colors = theme.colors;

export default function RepeatBookingScreen() {
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams();
  
  const {
    bookingId,
    organizationId,
    branchId,
    serviceId,
    vehicleId,
    orgName,
    serviceName,
    price,
    branchAddress,
  } = params;
  
  const [submitting, setSubmitting] = useState(false);
  const [vehicle, setVehicle] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadVehicle();
  }, []);

  const loadVehicle = async () => {
    if (vehicleId) {
      try {
        const res = await api.get(`/garage/${vehicleId}`);
        setVehicle(res.data);
      } catch (e) {
        console.log('Error loading vehicle:', e);
      }
    }
    setLoading(false);
  };

  const handleRepeat = async () => {
    setSubmitting(true);
    try {
      // Create quote directly to preferred provider
      const quoteData = {
        branchId,
        serviceIds: [serviceId],
        vehicleId: vehicleId || undefined,
        description: i18n.t('booking.povtornyj_zakaz_uslugi_servicename'),
        preferredProviderId: organizationId,
      };
      
      const res = await quotesAPI.create(quoteData);
      
      Alert.alert(
        i18n.t('booking.zayavka_sozdana'),
        i18n.t('booking.vasha_zayavka_otpravlena_masteru_ozhidajte_otveta'),
        [
          {
            text: i18n.t('booking.posmotret'),
            onPress: () => router.replace(`/quote/${res.data._id}`),
          },
          {
            text: i18n.t('inspector.na_glavnuyu'),
            onPress: () => router.replace('/(tabs)'),
          },
        ]
      );
    } catch (error: any) {
      const msg = error.response?.data?.message || i18n.t('booking.ne_udalos_sozdat_zayavku');
      Alert.alert(i18n.t('chat.oshibka'), Array.isArray(msg) ? msg[0] : msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.brand} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('booking.povtorit_zakaz')}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Quick Info Banner */}
        <LinearGradient
          colors={[colors.brand, colors.brand]}
          style={styles.banner}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        >
          <View style={styles.bannerIcon}>
            <Ionicons name="flash" size={24} color={colors.text} />
          </View>
          <View style={styles.bannerText}>
            <Text style={styles.bannerTitle}>{t('booking.bystryj_zakaz')}</Text>
            <Text style={styles.bannerSubtitle}>{t('booking.odin_klik_i_zayavka_sozdana')}</Text>
          </View>
        </LinearGradient>

        {/* Order Summary Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('booking.detali_zakaza')}</Text>
          
          {/* Service */}
          <View style={styles.row}>
            <View style={[styles.iconWrap, { backgroundColor: '#3B82F620' }]}>
              <Ionicons name="construct" size={20} color={colors.brand} />
            </View>
            <View style={styles.rowInfo}>
              <Text style={styles.rowLabel}>{t('booking.usluga')}</Text>
              <Text style={styles.rowValue}>{serviceName}</Text>
            </View>
          </View>

          {/* Organization */}
          <View style={styles.row}>
            <View style={[styles.iconWrap, { backgroundColor: '#8B5CF620' }]}>
              <Ionicons name="business" size={20} color={colors.brand} />
            </View>
            <View style={styles.rowInfo}>
              <Text style={styles.rowLabel}>{t('booking.sto')}</Text>
              <Text style={styles.rowValue}>{orgName}</Text>
            </View>
          </View>

          {/* Vehicle */}
          {vehicle && (
            <View style={styles.row}>
              <View style={[styles.iconWrap, { backgroundColor: '#10B98120' }]}>
                <Ionicons name="car-sport" size={20} color={colors.success} />
              </View>
              <View style={styles.rowInfo}>
                <Text style={styles.rowLabel}>{t('booking.avtomobil')}</Text>
                <Text style={styles.rowValue}>
                  {vehicle.brand} {vehicle.model} ({vehicle.year})
                </Text>
              </View>
            </View>
          )}

          {/* Address */}
          {branchAddress && (
            <View style={styles.row}>
              <View style={[styles.iconWrap, { backgroundColor: '#F59E0B20' }]}>
                <Ionicons name="location" size={20} color={colors.warning} />
              </View>
              <View style={styles.rowInfo}>
                <Text style={styles.rowLabel}>{t('booking.adres')}</Text>
                <Text style={styles.rowValue}>{branchAddress}</Text>
              </View>
            </View>
          )}

          {/* Price */}
          <View style={styles.divider} />
          <View style={styles.priceRow}>
            <Text style={styles.priceLabel}>{t('booking.stoimost')}</Text>
            <Text style={styles.priceValue}>
              {Number(price || 0).toLocaleString()} ₽
            </Text>
          </View>
        </View>

        {/* Info */}
        <View style={styles.infoCard}>
          <Ionicons name="information-circle" size={20} color={colors.textMuted} />
          <Text style={styles.infoText}>
            Заявка будет отправлена напрямую выбранному мастеру. 
            После ответа вы сможете выбрать удобное время.
          </Text>
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Footer */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.repeatBtn, submitting && styles.repeatBtnDisabled]}
          onPress={handleRepeat}
          disabled={submitting}
          activeOpacity={0.8}
        >
          {submitting ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <>
              <Ionicons name="repeat" size={22} color={colors.text} />
              <Text style={styles.repeatBtnText}>{t('booking.povtorit_zakaz')}</Text>
            </>
          )}
        </TouchableOpacity>
        
        <TouchableOpacity
          style={styles.newOrderBtn}
          onPress={() => router.push('/create-quote')}
        >
          <Text style={styles.newOrderBtnText}>{t('booking.sozdat_novuyu_zayavku')}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.backgroundSecondary,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.backgroundSecondary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardElevated,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.cardElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  },
  content: {
    flex: 1,
    padding: 20,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    marginBottom: 20,
  },
  bannerIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerText: {
    marginLeft: 16,
  },
  bannerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  },
  bannerSubtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 4,
  },
  card: {
    backgroundColor: colors.cardElevated,
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowInfo: {
    flex: 1,
    marginLeft: 12,
  },
  rowLabel: {
    fontSize: 12,
    color: colors.textMuted,
  },
  rowValue: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 16,
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
    fontSize: 24,
    fontWeight: '700',
    color: colors.success,
  },
  infoCard: {
    flexDirection: 'row',
    backgroundColor: 'rgba(107,114,128,0.1)',
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 20,
  },
  footer: {
    padding: 20,
    paddingBottom: 32,
    backgroundColor: colors.backgroundSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.cardElevated,
    gap: 12,
  },
  repeatBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 18,
    borderRadius: 14,
    gap: 10,
  },
  repeatBtnDisabled: {
    opacity: 0.6,
  },
  repeatBtnText: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.onPrimary,
  },
  newOrderBtn: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  newOrderBtnText: {
    fontSize: 15,
    color: colors.brand,
    fontWeight: '600',
  },
});

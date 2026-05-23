import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Dimensions,
  Platform,
  Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../context/ThemeContext';
import { useLocation } from '../context/LocationContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

const { width } = Dimensions.get('window');

// LOCATION PERMISSION MODAL

export default function LocationPermissionModal() {
  const { colors, isDark } = useThemeContext();
  const { t } = useTranslation();
  const {
    showPermissionModal,
    setShowPermissionModal,
    requestPermission,
    dismissPermissionModal,
    isLocationEnabled,
  } = useLocation();

  const handleEnable = async () => {
    await requestPermission();
  };

  const handleSkip = () => {
    dismissPermissionModal();
  };

  return (
    <Modal
      visible={showPermissionModal}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        {Platform.OS === 'ios' ? (
          <BlurView intensity={30} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.7)' }]} />
        )}
        
        <View style={[styles.container, { backgroundColor: colors.card }]}>
          {/* Icon */}
          <View style={[styles.iconContainer, { backgroundColor: colors.primary + '20' }]}>
            <Ionicons name="location" size={48} color={colors.primary} />
          </View>

          {/* Title */}
          <Text style={[styles.title, { color: colors.text }]}>
            {t('location_perm.title')}
          </Text>

          {/* Description */}
          <Text style={[styles.description, { color: colors.textSecondary }]}>
            {t('location_perm.description')}
          </Text>

          {/* Benefits */}
          <View style={styles.benefits}>
            <View style={styles.benefitRow}>
              <View style={[styles.benefitIcon, { backgroundColor: '#22C55E20' }]}>
                <Ionicons name="navigate" size={16} color={colors.success} />
              </View>
              <Text style={[styles.benefitText, { color: colors.text }]}>
                {t('location_perm.benefit_auto')}
              </Text>
            </View>
            <View style={styles.benefitRow}>
              <View style={[styles.benefitIcon, { backgroundColor: '#3B82F620' }]}>
                <Ionicons name="map" size={16} color={colors.brand} />
              </View>
              <Text style={[styles.benefitText, { color: colors.text }]}>
                {t('location_perm.benefit_distance')}
              </Text>
            </View>
            <View style={styles.benefitRow}>
              <View style={[styles.benefitIcon, { backgroundColor: '#F59E0B20' }]}>
                <Ionicons name="time" size={16} color={colors.warning} />
              </View>
              <Text style={[styles.benefitText, { color: colors.text }]}>
                {t('location_perm.benefit_eta')}
              </Text>
            </View>
          </View>

          {/* Main Button */}
          <TouchableOpacity
            testID="location-perm-allow-btn"
            style={[styles.enableButton, { backgroundColor: colors.brand }]}
            onPress={handleEnable}
            activeOpacity={0.8}
          >
            <Ionicons name="location" size={22} color={colors.brandText} />
            <Text style={[styles.enableButtonText, { color: colors.brandText }]}>
              {t('location_perm.allow')}
            </Text>
          </TouchableOpacity>

          {/* Skip Button */}
          <TouchableOpacity
            testID="location-perm-skip-btn"
            style={[styles.skipButton, { backgroundColor: colors.cardSecondary || colors.background }]}
            onPress={handleSkip}
            activeOpacity={0.7}
          >
            <Text style={[styles.skipButtonText, { color: colors.textSecondary }]}>
              {t('location_perm.later')}
            </Text>
          </TouchableOpacity>

          {/* Privacy note */}
          <Text style={[styles.privacyNote, { color: colors.textMuted }]}>
            {t('location_perm.privacy')}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  container: {
    width: width - 48,
    maxWidth: 360,
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.25,
        shadowRadius: 24,
      },
      android: {
        elevation: 16,
      },
    }),
  },
  iconContainer: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  description: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 24,
  },
  benefits: {
    width: '100%',
    marginBottom: 24,
    gap: 12,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  benefitIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  benefitText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
  },
  enableButton: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 14,
    gap: 10,
    marginBottom: 10,
  },
  enableButtonText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  skipButton: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 14,
  },
  skipButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  privacyNote: {
    fontSize: 11,
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 16,
  },
});

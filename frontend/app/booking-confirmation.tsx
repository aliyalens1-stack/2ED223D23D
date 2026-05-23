import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  Dimensions,
  Platform,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useThemeContext } from '../src/context/ThemeContext';
import { theme } from '../src/context/ThemeContext';
import { useTranslation } from 'react-i18next';
import i18n from '../src/i18n';
const colors = theme.colors;
const { width } = Dimensions.get('window');

export default function BookingConfirmationScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useThemeContext();
  const { t } = useTranslation();
  // Parse params
  const vehicle = params.vehicle ? JSON.parse(params.vehicle as string) : null;
  const service = params.service ? JSON.parse(params.service as string) : null;
  const description = params.description as string || '';
  const preferredDate = (params.date as string) || i18n.t('create_quote.dates.asap');
  
  // Animations
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const checkmarkScale = useRef(new Animated.Value(0)).current;
  const confettiOpacity = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    // Sequence of animations
    Animated.sequence([
      // 1. Scale in the success circle
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 4,
        tension: 40,
        useNativeDriver: Platform.OS !== 'web',
      }),
      // 2. Show checkmark
      Animated.spring(checkmarkScale, {
        toValue: 1,
        friction: 3,
        useNativeDriver: Platform.OS !== 'web',
      }),
    ]).start();
    
    // Fade in content
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 600,
      delay: 300,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
    
    // Slide up content
    Animated.timing(slideAnim, {
      toValue: 0,
      duration: 500,
      delay: 400,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
    
    // Confetti fade
    Animated.sequence([
      Animated.delay(200),
      Animated.timing(confettiOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.delay(2000),
      Animated.timing(confettiOpacity, {
        toValue: 0,
        duration: 500,
        useNativeDriver: Platform.OS !== 'web',
      }),
    ]).start();
  }, []);
  
  const handleGoHome = () => {
    router.replace('/(tabs)');
  };
  
  const handleViewBookings = () => {
    router.replace('/(tabs)/quotes');
  };
  
  const handleShare = async () => {
    try {
      await Share.share({
        message: i18n.t('booking_confirmation.share_text', {
          service: service?.name || '',
          brand: vehicle?.brand || '',
          model: vehicle?.model || '',
        }),
      });
    } catch (error) {
      console.log('Error sharing:', error);
    }
  };
  
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Background gradient */}
      <LinearGradient
        colors={isDark ? [colors.bg, colors.backgroundSecondary] : [colors.border, colors.border]}
        style={StyleSheet.absoluteFillObject}
      />
      
      {/* Confetti overlay */}
      <Animated.View style={[styles.confettiContainer, { opacity: confettiOpacity }]}>
        {[...Array(20)].map((_, i) => (
          <ConfettiPiece key={i} index={i} colors={colors} />
        ))}
      </Animated.View>
      
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.content}>
          {/* Success Animation */}
          <View style={styles.successSection}>
            <Animated.View 
              style={[
                styles.successCircle,
                { 
                  backgroundColor: colors.successBg,
                  transform: [{ scale: scaleAnim }],
                }
              ]}
            >
              <Animated.View style={{ transform: [{ scale: checkmarkScale }] }}>
                <Ionicons name="checkmark" size={64} color={colors.success} />
              </Animated.View>
            </Animated.View>
            
            <Animated.View 
              style={[
                styles.titleSection,
                { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }
              ]}
            >
              <Text style={[styles.successTitle, { color: colors.text }]} testID="booking-confirm-title">
                {t('booking_confirmation.title')}
              </Text>
              <Text style={[styles.successSubtitle, { color: colors.textSecondary }]}>
                {t('booking_confirmation.subtitle')}
              </Text>
            </Animated.View>
          </View>
          
          {/* Booking Details Card */}
          <Animated.View 
            style={[
              styles.detailsCard,
              { 
                backgroundColor: colors.card,
                opacity: fadeAnim,
                transform: [{ translateY: slideAnim }],
              }
            ]}
          >
            <View style={styles.detailRow}>
              <View style={[styles.detailIcon, { backgroundColor: colors.infoBg }]}>
                <Ionicons name="car-sport" size={20} color={colors.primary} />
              </View>
              <View style={styles.detailContent}>
                <Text style={[styles.detailLabel, { color: colors.textMuted }]}>
                  {t('booking_confirmation.vehicle')}
                </Text>
                <Text style={[styles.detailValue, { color: colors.text }]}>
                  {vehicle?.brand} {vehicle?.model} ({vehicle?.year})
                </Text>
              </View>
            </View>
            
            <View style={[styles.divider, { backgroundColor: colors.divider }]} />
            
            <View style={styles.detailRow}>
              <View style={[styles.detailIcon, { backgroundColor: colors.warningBg }]}>
                <Ionicons name="construct" size={20} color={colors.warning} />
              </View>
              <View style={styles.detailContent}>
                <Text style={[styles.detailLabel, { color: colors.textMuted }]}>
                  {t('booking_confirmation.service')}
                </Text>
                <Text style={[styles.detailValue, { color: colors.text }]}>
                  {service?.name}
                </Text>
              </View>
            </View>
            
            <View style={[styles.divider, { backgroundColor: colors.divider }]} />
            
            <View style={styles.detailRow}>
              <View style={[styles.detailIcon, { backgroundColor: colors.successBg }]}>
                <Ionicons name="time" size={20} color={colors.success} />
              </View>
              <View style={styles.detailContent}>
                <Text style={[styles.detailLabel, { color: colors.textMuted }]}>
                  {t('booking_confirmation.deadline')}
                </Text>
                <Text style={[styles.detailValue, { color: colors.text }]}>
                  {preferredDate}
                </Text>
              </View>
            </View>
            
            {/* Booking ID */}
            <View style={[styles.bookingIdSection, { backgroundColor: colors.backgroundTertiary }]}>
              <Text style={[styles.bookingIdLabel, { color: colors.textMuted }]}>
                {t('booking_confirmation.booking_id')}
              </Text>
              <Text style={[styles.bookingIdValue, { color: colors.text }]}>
                #{Math.random().toString(36).substr(2, 8).toUpperCase()}
              </Text>
            </View>
          </Animated.View>
          
          {/* Info Note */}
          <Animated.View 
            style={[
              styles.infoNote,
              { 
                backgroundColor: colors.infoBg,
                opacity: fadeAnim,
              }
            ]}
          >
            <Ionicons name="notifications" size={20} color={colors.primary} />
            <Text style={[styles.infoNoteText, { color: colors.primary }]}>
              {t('booking_confirmation.info_note')}
            </Text>
          </Animated.View>
        </View>
        
        {/* Actions */}
        <Animated.View style={[styles.actions, { opacity: fadeAnim }]}>
          {/* Share button */}
          <TouchableOpacity
            testID="booking-confirm-share-btn"
            style={[styles.shareButton, { backgroundColor: colors.card }]}
            onPress={handleShare}
            activeOpacity={0.8}
          >
            <Ionicons name="share-outline" size={22} color={colors.text} />
          </TouchableOpacity>
          
          {/* Primary CTA */}
          <TouchableOpacity
            testID="booking-confirm-my-bookings-btn"
            style={styles.primaryButton}
            onPress={handleViewBookings}
            activeOpacity={0.9}
          >
            <LinearGradient
              colors={[colors.primary, colors.primaryDark]}
              style={styles.primaryGradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
            >
              <Text style={styles.primaryButtonText}>{t('booking_confirmation.my_bookings')}</Text>
              <Ionicons name="arrow-forward" size={20} color={colors.text} />
            </LinearGradient>
          </TouchableOpacity>
        </Animated.View>

        {/* Sprint 29: Growth loop — referral CTA after booking create */}
        <Animated.View style={{ opacity: fadeAnim, paddingHorizontal: 24, marginTop: 12 }}>
          <TouchableOpacity
            testID="booking-confirm-referral-cta"
            onPress={() => router.push('/referral')}
            activeOpacity={0.9}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 12,
              padding: 14, borderRadius: 14,
              backgroundColor: 'rgba(245, 184, 0, 0.10)',
              borderWidth: 1, borderColor: 'rgba(245, 184, 0, 0.35)',
            }}
          >
            <Text style={{ fontSize: 28 }}>🎁</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}>
                {t('booking_confirmation.referral_title')}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
                {t('booking_confirmation.referral_sub')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.primary} />
          </TouchableOpacity>
        </Animated.View>
        
        {/* Secondary action */}
        <TouchableOpacity
          testID="booking-confirm-home-btn"
          style={styles.secondaryButton}
          onPress={handleGoHome}
          activeOpacity={0.7}
        >
          <Text style={[styles.secondaryButtonText, { color: colors.textSecondary }]}>
            {t('booking_confirmation.go_home')}
          </Text>
        </TouchableOpacity>
      </SafeAreaView>
    </View>
  );
}

/* ──────────── Confetti Piece ──────────── */
function ConfettiPiece({ index, colors }: { index: number; colors: any }) {
  const translateY = useRef(new Animated.Value(-50)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const rotate = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  
  const confettiColors = [colors.brand, colors.success, colors.warning, colors.brand, colors.brand, colors.brand];
  const color = confettiColors[index % confettiColors.length];
  const startX = Math.random() * width;
  const endX = startX + (Math.random() - 0.5) * 100;
  
  useEffect(() => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 800,
        duration: 2000 + Math.random() * 1000,
        delay: Math.random() * 500,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(translateX, {
        toValue: endX - startX,
        duration: 2000 + Math.random() * 1000,
        delay: Math.random() * 500,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(rotate, {
        toValue: Math.random() * 10,
        duration: 2000,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 2000,
        delay: 1500,
        useNativeDriver: Platform.OS !== 'web',
      }),
    ]).start();
  }, []);
  
  const spin = rotate.interpolate({
    inputRange: [0, 10],
    outputRange: ['0deg', '360deg'],
  });
  
  return (
    <Animated.View
      style={[
        styles.confettiPiece,
        {
          left: startX,
          backgroundColor: color,
          opacity,
          transform: [
            { translateY },
            { translateX },
            { rotate: spin },
          ],
        },
      ]}
    />
  );
}

/* ──────────── Styles ──────────── */
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    justifyContent: 'space-between',
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  
  // Confetti
  confettiContainer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  confettiPiece: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 2,
  },
  
  // Success Section
  successSection: {
    alignItems: 'center',
    marginBottom: 32,
  },
  successCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  titleSection: {
    alignItems: 'center',
  },
  successTitle: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  successSubtitle: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
  },
  
  // Details Card
  detailsCard: {
    borderRadius: 20,
    padding: 4,
    marginBottom: 16,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  detailIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailContent: {
    flex: 1,
    marginLeft: 14,
  },
  detailLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  detailValue: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 2,
  },
  divider: {
    height: 1,
    marginLeft: 74,
  },
  bookingIdSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
    marginTop: 4,
    borderRadius: 12,
    marginHorizontal: 12,
    marginBottom: 12,
  },
  bookingIdLabel: {
    fontSize: 13,
    fontWeight: '500',
  },
  bookingIdValue: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 1,
  },
  
  // Info Note
  infoNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 14,
    borderRadius: 14,
    gap: 12,
  },
  infoNoteText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  
  // Actions
  actions: {
    flexDirection: 'row',
    paddingHorizontal: 24,
    gap: 12,
  },
  shareButton: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButton: {
    flex: 1,
    borderRadius: 16,
    overflow: 'hidden',
  },
  primaryGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 56,
    gap: 8,
  },
  primaryButtonText: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '600',
  },
  secondaryButton: {
    alignItems: 'center',
    paddingVertical: 16,
    marginBottom: Platform.OS === 'ios' ? 0 : 16,
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: '500',
  },
});

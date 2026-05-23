import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  Dimensions,
  Animated,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api, bookingsAPI } from '../../src/services/api';
import { useAuth } from '../../src/context/AuthContext';
import { theme } from '../../src/context/ThemeContext';
import { useTranslation } from 'react-i18next';
import i18n from '../../src/i18n';
const colors = theme.colors;

const { width } = Dimensions.get('window');

type TabType = 'info' | 'services' | 'reviews';

export default function OrganizationScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const { colors, isDark } = useThemeContext();
  const { user } = useAuth();
  const { t } = useTranslation();
  
  const [loading, setLoading] = useState(true);
  const [org, setOrg] = useState<any>(null);
  const [branch, setBranch] = useState<any>(null);
  const [services, setServices] = useState<any[]>([]);
  const [reviews, setReviews] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<TabType>('info');
  const [isFavorite, setIsFavorite] = useState(false);
  const [hasPaidBooking, setHasPaidBooking] = useState(false);
  
  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const headerOpacity = useRef(new Animated.Value(0)).current;
  const tabIndicatorAnim = useRef(new Animated.Value(0)).current;
  const heartScale = useRef(new Animated.Value(1)).current;
  
  useEffect(() => {
    fetchData();
  }, [id]);

  useEffect(() => {
    // Animate tab indicator
    const tabIndex = activeTab === 'info' ? 0 : activeTab === 'services' ? 1 : 2;
    Animated.spring(tabIndicatorAnim, {
      toValue: tabIndex * (width - 40) / 3,
      useNativeDriver: Platform.OS !== 'web',
      friction: 8,
    }).start();
  }, [activeTab]);
  
  const fetchData = async () => {
    try {
      const orgRes = await api.get(`/organizations/${id}`);
      setOrg(orgRes.data);
      
      if (orgRes.data?.branches?.[0]) {
        setBranch(orgRes.data.branches[0]);
      }
      
      // 🔥 Check if user has paid booking with this organization
      if (user) {
        try {
          const bookingsRes = await bookingsAPI.getMy();
          const paidBooking = (bookingsRes.data || []).find(
            (b: any) => b.organizationId === id && (b.isPaid || b.paymentStatus === 'paid')
          );
          setHasPaidBooking(!!paidBooking);
        } catch (e) {
          console.log('Error checking bookings:', e);
        }
      }
      
      // Animate in
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 400,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 400,
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(headerOpacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]).start();
      
      // Mock services
      setServices([
        { _id: '1', nameKey: 'engine_diagnostics', priceMin: 30 },
        { _id: '2', nameKey: 'oil_change', priceMin: 45 },
        { _id: '3', nameKey: 'inspection', priceMin: 60 },
        { _id: '4', nameKey: 'brake_repair', priceMin: 80 },
      ]);
      
      // Mock reviews
      setReviews([
        { _id: '1', user: { firstName: 'Alex' }, rating: 5, text: 'Great service — fast and professional.' },
        { _id: '2', user: { firstName: 'Maria' }, rating: 4, text: 'Fair prices and friendly staff.' },
        { _id: '3', user: { firstName: 'Thomas' }, rating: 5, text: 'Highly recommended — professional approach.' },
      ]);
    } catch (error) {
      console.log('Error fetching organization:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const handleCall = () => {
    // 🔥 ANTI-BYPASS: Contacts available only after payment
    if (!hasPaidBooking) {
      Alert.alert(
        i18n.t('organization.paywall_title'),
        i18n.t('organization.paywall_msg'),
        [
          { text: i18n.t('organization.paywall_create'), onPress: () => handleBook() },
          { text: i18n.t('organization.paywall_close'), style: 'cancel' },
        ]
      );
      return;
    }
    
    const phone = branch?.phone || org?.phone || '+49 30 1234567';
    Linking.openURL(`tel:${phone}`);
  };
  
  const handleDirections = () => {
    const address = branch?.address || org?.address || 'Berlin';
    Linking.openURL(`https://maps.google.com/?q=${encodeURIComponent(address)}`);
  };
  
  const handleFavorite = () => {
    if (!user) {
      router.push('/login');
      return;
    }
    
    // Animate heart
    Animated.sequence([
      Animated.timing(heartScale, {
        toValue: 1.3,
        duration: 150,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(heartScale, {
        toValue: 1,
        duration: 150,
        useNativeDriver: Platform.OS !== 'web',
      }),
    ]).start();
    
    setIsFavorite(!isFavorite);
  };
  
  const handleBook = (serviceId?: string) => {
    router.push(`/create-quote?orgId=${id}${serviceId ? `&serviceId=${serviceId}` : ''}` as any);
  };
  
  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <SafeAreaView style={styles.loadingContainer}>
          <ActivityIndicator color={colors.primary} size="large" />
        </SafeAreaView>
      </View>
    );
  }
  
  if (!org) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.header}>
            <TouchableOpacity 
              onPress={() => router.back()} 
              style={[styles.headerBtn, { backgroundColor: colors.card }]}
            >
              <Ionicons name="arrow-back" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
          <View style={styles.errorContainer}>
            <Ionicons name="alert-circle" size={64} color={colors.textMuted} />
            <Text style={[styles.errorText, { color: colors.text }]}>{t('organization.not_found')}</Text>
          </View>
        </SafeAreaView>
      </View>
    );
  }
  
  const rating = org.ratingAvg || 4.6;
  const reviewsCount = org.reviewsCount || reviews.length;
  const responseTime = org.avgResponseTimeMinutes || 15;
  const isOpen = true;
  const tabs: TabType[] = ['info', 'services', 'reviews'];
  const tabLabels = {
    info: i18n.t('organization.tabs.info'),
    services: i18n.t('organization.tabs.services'),
    reviews: i18n.t('organization.tabs.reviews', { n: reviewsCount }),
  };
  
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        {/* Animated Header */}
        <Animated.View style={[styles.header, { opacity: headerOpacity }]}>
          <TouchableOpacity 
            onPress={() => router.back()} 
            style={[styles.headerBtn, { backgroundColor: colors.card }]}
          >
            <Ionicons name="arrow-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.headerRight}>
            <TouchableOpacity onPress={handleFavorite} style={[styles.headerBtn, { backgroundColor: colors.card }]}>
              <Animated.View style={{ transform: [{ scale: heartScale }] }}>
                <Ionicons 
                  name={isFavorite ? 'heart' : 'heart-outline'} 
                  size={22} 
                  color={isFavorite ? colors.error : colors.text} 
                />
              </Animated.View>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.headerBtn, { backgroundColor: colors.card }]}>
              <Ionicons name="share-outline" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
        </Animated.View>
        
        <Animated.ScrollView 
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Hero Section */}
          <View style={styles.heroSection}>
            {/* Avatar with gradient */}
            <LinearGradient
              colors={[colors.primary, colors.primaryDark]}
              style={styles.heroAvatar}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            >
              <Ionicons name="car-sport" size={40} color={colors.text} />
            </LinearGradient>
            
            <Text style={[styles.orgName, { color: colors.text }]}>{org.name}</Text>
            
            {/* Rating */}
            <View style={styles.ratingContainer}>
              <View style={[styles.ratingBadge, { backgroundColor: colors.warningBg }]}>
                <Ionicons name="star" size={16} color={colors.warning} />
                <Text style={[styles.ratingText, { color: colors.text }]}>{rating.toFixed(1)}</Text>
              </View>
              <Text style={[styles.reviewsText, { color: colors.textSecondary }]}>
                {t('organization.reviews_count', { n: reviewsCount })}
              </Text>
            </View>
            
            {/* Info Badges */}
            <View style={styles.badgesContainer}>
              {/* Verified Badge */}
              {org?.isVerified && (
                <View style={[styles.infoBadge, { backgroundColor: colors.successBg }]}>
                  <Ionicons name="shield-checkmark" size={14} color={colors.success} />
                  <Text style={[styles.badgeText, { color: colors.success }]}>
                    {t('organization.badges.verified')}
                  </Text>
                </View>
              )}
              {/* Popular Badge */}
              {org?.isPopular && (
                <View style={[styles.infoBadge, { backgroundColor: colors.warningBg }]}>
                  <Ionicons name="flame" size={14} color={colors.warning} />
                  <Text style={[styles.badgeText, { color: colors.warning }]}>
                    {t('organization.badges.popular')}
                  </Text>
                </View>
              )}
              {/* Fast Response */}
              {responseTime <= 15 && (
                <View style={[styles.infoBadge, { backgroundColor: colors.brandSoft }]}>
                  <Ionicons name="flash" size={14} color={colors.brand} />
                  <Text style={[styles.badgeText, { color: colors.brand }]}>
                    {t('organization.badges.fast', { n: responseTime })}
                  </Text>
                </View>
              )}
              {responseTime > 15 && (
                <View style={[styles.infoBadge, { backgroundColor: colors.infoBg }]}>
                  <Ionicons name="time" size={14} color={colors.primary} />
                  <Text style={[styles.badgeText, { color: colors.primary }]}>
                    {t('organization.badges.response_time', { n: responseTime })}
                  </Text>
                </View>
              )}
              <View style={[styles.infoBadge, { backgroundColor: colors.successBg }]}>
                <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                <Text style={[styles.badgeText, { color: colors.success }]}>
                  {isOpen ? t('organization.badges.open') : t('organization.badges.closed')}
                </Text>
              </View>
              {branch?.distance && (
                <View style={[styles.infoBadge, { backgroundColor: colors.card }]}>
                  <Ionicons name="location" size={14} color={colors.textSecondary} />
                  <Text style={[styles.badgeText, { color: colors.textSecondary }]}>
                    {branch.distance < 1 
                      ? `${(branch.distance * 1000).toFixed(0)} m`
                      : `${branch.distance.toFixed(1)} km`}
                  </Text>
                </View>
              )}
            </View>

            {/* 🔥 V5: "Why Choose" Block */}
            {(org?.isVerified || org?.completedBookingsCount > 0 || rating >= 4.5) && (
              <View style={[styles.whyChooseBlock, { backgroundColor: isDark ? colors.successBg : colors.successBg }]}>
                <Text style={[styles.whyChooseTitle, { color: colors.success }]}>
                  {t('organization.why_choose.title')}
                </Text>
                {rating >= 4.5 && (
                  <View style={styles.whyChooseItem}>
                    <Ionicons name="checkmark" size={14} color={colors.success} />
                    <Text style={[styles.whyChooseText, { color: colors.success }]}>
                      {t('organization.why_choose.happy_customers', { pct: Math.round(rating * 20) })}
                    </Text>
                  </View>
                )}
                {responseTime <= 15 && (
                  <View style={styles.whyChooseItem}>
                    <Ionicons name="checkmark" size={14} color={colors.success} />
                    <Text style={[styles.whyChooseText, { color: colors.success }]}>
                      {t('organization.why_choose.response_within', { n: responseTime })}
                    </Text>
                  </View>
                )}
                {(org?.completedBookingsCount || 0) > 0 && (
                  <View style={styles.whyChooseItem}>
                    <Ionicons name="checkmark" size={14} color={colors.success} />
                    <Text style={[styles.whyChooseText, { color: colors.success }]}>
                      {t('organization.why_choose.completed_orders', { n: org.completedBookingsCount })}
                    </Text>
                  </View>
                )}
                {org?.isVerified && (
                  <View style={styles.whyChooseItem}>
                    <Ionicons name="checkmark" size={14} color={colors.success} />
                    <Text style={[styles.whyChooseText, { color: colors.success }]}>
                      {t('organization.why_choose.verified')}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>
          
          {/* Stats Row - completed orders */}
          <View style={styles.statsRow}>
            <View style={[styles.statItem, { backgroundColor: colors.card }]}>
              <Text style={[styles.statNumber, { color: colors.primary }]}>
                {org?.completedBookingsCount || 0}
              </Text>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
                {t('organization.stats.orders')}
              </Text>
            </View>
            <View style={[styles.statItem, { backgroundColor: colors.card }]}>
              <Text style={[styles.statNumber, { color: colors.warning }]}>
                {reviewsCount}
              </Text>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
                {t('organization.stats.reviews')}
              </Text>
            </View>
            <View style={[styles.statItem, { backgroundColor: colors.card }]}>
              <Text style={[styles.statNumber, { color: colors.success }]}>
                {rating > 0 ? rating.toFixed(1) : '-'}
              </Text>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
                {t('organization.stats.rating')}
              </Text>
            </View>
          </View>
          
          {/* Quick Actions */}
          <View style={styles.quickActions}>
            <QuickActionButton 
              icon="call" 
              label={t('organization.actions.call')}
              colors={colors}
              onPress={handleCall}
            />
            <QuickActionButton 
              icon="navigate" 
              label={t('organization.actions.directions')}
              colors={colors}
              onPress={handleDirections}
            />
            <QuickActionButton 
              icon="chatbubble-ellipses" 
              label={t('organization.actions.chat')}
              colors={colors}
              onPress={() => {}}
            />
          </View>
          
          {/* Tabs */}
          <View style={[styles.tabsContainer, { backgroundColor: colors.card }]}>
            <View style={styles.tabsRow}>
              {tabs.map((tab) => (
                <TouchableOpacity
                  key={tab}
                  style={styles.tab}
                  onPress={() => setActiveTab(tab)}
                  activeOpacity={0.7}
                >
                  <Text 
                    style={[
                      styles.tabText, 
                      { color: activeTab === tab ? colors.primary : colors.textMuted }
                    ]}
                  >
                    {tabLabels[tab]}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {/* Animated Indicator */}
            <Animated.View 
              style={[
                styles.tabIndicator, 
                { 
                  backgroundColor: colors.primary,
                  transform: [{ translateX: tabIndicatorAnim }],
                }
              ]} 
            />
          </View>
          
          {/* Tab Content */}
          <View style={styles.tabContent}>
            {activeTab === 'info' && (
              <InfoTab org={org} branch={branch} colors={colors} t={t} />
            )}
            {activeTab === 'services' && (
              <ServicesTab services={services} colors={colors} onBook={handleBook} t={t} />
            )}
            {activeTab === 'reviews' && (
              <ReviewsTab reviews={reviews} colors={colors} t={t} />
            )}
          </View>
          
          <View style={{ height: 100 }} />
        </Animated.ScrollView>
        
        {/* Sticky CTA */}
        <View style={[styles.stickyFooter, { backgroundColor: colors.background }]}>
          <TouchableOpacity
            testID="organization-book-btn"
            style={styles.ctaButton}
            onPress={() => handleBook()}
            activeOpacity={0.9}
          >
            <LinearGradient
              colors={[colors.primary, colors.primaryDark]}
              style={styles.ctaGradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
            >
              <Text style={styles.ctaText}>{t('organization.book_now')}</Text>
              <Ionicons name="arrow-forward" size={20} color={colors.text} />
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

/* ──────────── Quick Action Button ──────────── */
function QuickActionButton({ icon, label, colors, onPress }: any) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  
  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.95,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  };
  
  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  };
  
  return (
    <TouchableOpacity
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      activeOpacity={1}
    >
      <Animated.View 
        style={[
          styles.quickAction, 
          { backgroundColor: colors.card, transform: [{ scale: scaleAnim }] }
        ]}
      >
        <View style={[styles.quickActionIcon, { backgroundColor: colors.infoBg }]}>
          <Ionicons name={icon} size={20} color={colors.primary} />
        </View>
        <Text style={[styles.quickActionText, { color: colors.text }]}>{label}</Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

/* ──────────── Info Tab ──────────── */
function InfoTab({ org, branch, colors, t }: any) {
  return (
    <View>
      {org.description && (
        <View style={styles.infoBlock}>
          <Text style={[styles.infoLabel, { color: colors.textMuted }]}>{t('organization.info.about')}</Text>
          <Text style={[styles.infoValue, { color: colors.text }]}>{org.description}</Text>
        </View>
      )}
      
      <View style={styles.infoBlock}>
        <Text style={[styles.infoLabel, { color: colors.textMuted }]}>{t('organization.info.address')}</Text>
        <Text style={[styles.infoValue, { color: colors.text }]}>
          {branch?.address || org.address || 'Friedrichstr. 123, Berlin'}
        </Text>
      </View>
      
      <View style={styles.infoBlock}>
        <Text style={[styles.infoLabel, { color: colors.textMuted }]}>{t('organization.info.hours')}</Text>
        <View style={styles.hoursRow}>
          <Text style={[styles.hoursDay, { color: colors.text }]}>{t('organization.info.days.mon_fri')}</Text>
          <Text style={[styles.hoursTime, { color: colors.textSecondary }]}>09:00 – 20:00</Text>
        </View>
        <View style={styles.hoursRow}>
          <Text style={[styles.hoursDay, { color: colors.text }]}>{t('organization.info.days.sat')}</Text>
          <Text style={[styles.hoursTime, { color: colors.textSecondary }]}>10:00 – 18:00</Text>
        </View>
        <View style={styles.hoursRow}>
          <Text style={[styles.hoursDay, { color: colors.text }]}>{t('organization.info.days.sun')}</Text>
          <Text style={[styles.hoursTime, { color: colors.textMuted }]}>{t('organization.info.closed')}</Text>
        </View>
      </View>
      
      {org.specializations && org.specializations.length > 0 && (
        <View style={styles.infoBlock}>
          <Text style={[styles.infoLabel, { color: colors.textMuted }]}>{t('organization.info.specialization')}</Text>
          <View style={styles.tagsRow}>
            {org.specializations.map((spec: string, idx: number) => (
              <View key={idx} style={[styles.tag, { backgroundColor: colors.infoBg }]}>
                <Text style={[styles.tagText, { color: colors.primary }]}>{spec}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

/* ──────────── Services Tab ──────────── */
function ServicesTab({ services, colors, onBook, t }: any) {
  return (
    <View style={styles.servicesGrid}>
      {services.map((service: any) => (
        <ServiceCard key={service._id} service={service} colors={colors} onBook={onBook} t={t} />
      ))}
    </View>
  );
}

function ServiceCard({ service, colors, onBook, t }: any) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  
  const handlePressIn = () => {
    Animated.spring(scaleAnim, { toValue: 0.98, useNativeDriver: Platform.OS !== 'web' }).start();
  };
  
  const handlePressOut = () => {
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: Platform.OS !== 'web' }).start();
  };
  
  const serviceName = service.nameKey
    ? i18n.t(`organization.mock_services.${service.nameKey}`)
    : service.name;
  const serviceDesc = service.nameKey
    ? i18n.t(`organization.mock_services.${service.nameKey}_desc`)
    : service.description;
  
  return (
    <TouchableOpacity
      testID={`org-service-${service._id}`}
      onPress={() => onBook(service._id)}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      activeOpacity={1}
    >
      <Animated.View 
        style={[
          styles.serviceCard, 
          { backgroundColor: colors.card, transform: [{ scale: scaleAnim }] }
        ]}
      >
        <View style={styles.serviceInfo}>
          <Text style={[styles.serviceName, { color: colors.text }]}>{serviceName}</Text>
          {serviceDesc && (
            <Text style={[styles.serviceDesc, { color: colors.textSecondary }]} numberOfLines={1}>
              {serviceDesc}
            </Text>
          )}
        </View>
        <View style={styles.serviceRight}>
          <Text style={[styles.servicePrice, { color: colors.primary }]}>
            {t('organization.price_from', { n: service.priceMin })}
          </Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </View>
      </Animated.View>
    </TouchableOpacity>
  );
}

/* ──────────── Reviews Tab ──────────── */
function ReviewsTab({ reviews, colors, t }: any) {
  return (
    <View>
      {reviews.map((review: any, idx: number) => (
        <ReviewCard key={review._id || idx} review={review} colors={colors} index={idx} t={t} />
      ))}
    </View>
  );
}

function ReviewCard({ review, colors, index, t }: any) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      delay: index * 100,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, []);
  
  const initials = (review.user?.firstName?.[0] || 'U').toUpperCase();
  
  return (
    <Animated.View 
      style={[
        styles.reviewCard, 
        { backgroundColor: colors.card, opacity: fadeAnim }
      ]}
    >
      <View style={styles.reviewHeader}>
        <View style={styles.reviewUser}>
          <LinearGradient
            colors={[colors.primary, colors.accent]}
            style={styles.reviewAvatar}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          >
            <Text style={styles.reviewAvatarText}>{initials}</Text>
          </LinearGradient>
          <View>
            <Text style={[styles.reviewName, { color: colors.text }]}>
              {review.user?.firstName || t('organization.user_fallback')}
            </Text>
            <View style={styles.starsRow}>
              {[1, 2, 3, 4, 5].map((star) => (
                <Ionicons
                  key={star}
                  name={star <= review.rating ? 'star' : 'star-outline'}
                  size={12}
                  color={colors.warning}
                />
              ))}
            </View>
          </View>
        </View>
      </View>
      <Text style={[styles.reviewText, { color: colors.textSecondary }]}>
        {review.text}
      </Text>
    </Animated.View>
  );
}

/* ──────────── Styles ──────────── */
const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { fontSize: 18, fontWeight: '600', marginTop: 16 },
  
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRight: { flexDirection: 'row', gap: 10 },
  
  scrollContent: { paddingBottom: 40 },
  
  // Hero
  heroSection: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  heroAvatar: {
    width: 80,
    height: 80,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  orgName: {
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  ratingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  ratingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    gap: 4,
  },
  ratingText: { fontSize: 15, fontWeight: '700' },
  reviewsText: { fontSize: 14 },
  
  badgesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
  },
  infoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    gap: 5,
  },
  badgeText: { fontSize: 13, fontWeight: '500' },

  // Why Choose Block
  whyChooseBlock: {
    marginTop: 16,
    marginHorizontal: 20,
    padding: 14,
    borderRadius: 12,
  },
  whyChooseTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  whyChooseItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 3,
  },
  whyChooseText: {
    fontSize: 13,
    flex: 1,
  },
  
  // Quick Actions
  quickActions: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    marginBottom: 24,
    gap: 12,
  },
  quickAction: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 8,
    borderRadius: 16,
    minHeight: 90,
  },
  quickActionIcon: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  quickActionText: { 
    fontSize: 12, 
    fontWeight: '600',
    textAlign: 'center',
  },
  
  // Tabs
  tabsContainer: {
    marginHorizontal: 20,
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 20,
  },
  tabsRow: {
    flexDirection: 'row',
  },
  tab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
  },
  tabText: { fontSize: 14, fontWeight: '600' },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: (width - 40) / 3,
    height: 3,
    borderRadius: 2,
  },
  
  // Tab Content
  tabContent: { paddingHorizontal: 20 },
  
  // Stats Row
  statsRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    gap: 12,
    marginBottom: 20,
  },
  statItem: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  statNumber: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  
  // Info Tab
  infoBlock: { marginBottom: 20 },
  infoLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: 8 },
  infoValue: { fontSize: 15, lineHeight: 22 },
  hoursRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  hoursDay: { fontSize: 14, fontWeight: '500' },
  hoursTime: { fontSize: 14 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10 },
  tagText: { fontSize: 13, fontWeight: '500' },
  
  // Services Tab
  servicesGrid: { gap: 10 },
  serviceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 14,
  },
  serviceInfo: { flex: 1, marginRight: 12 },
  serviceName: { fontSize: 15, fontWeight: '600' },
  serviceDesc: { fontSize: 13, marginTop: 4 },
  serviceRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  servicePrice: { fontSize: 15, fontWeight: '700' },
  
  // Reviews Tab
  reviewCard: { padding: 16, borderRadius: 14, marginBottom: 12 },
  reviewHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  reviewUser: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  reviewAvatar: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  reviewAvatarText: { color: colors.text, fontSize: 16, fontWeight: '600' },
  reviewName: { fontSize: 15, fontWeight: '600', marginBottom: 4 },
  starsRow: { flexDirection: 'row', gap: 2 },
  reviewText: { fontSize: 14, lineHeight: 20 },
  
  // Sticky Footer
  stickyFooter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
  },
  ctaButton: { borderRadius: 16, overflow: 'hidden' },
  ctaGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 56,
    gap: 8,
  },
  ctaText: { color: colors.text, fontSize: 17, fontWeight: '600' },
});

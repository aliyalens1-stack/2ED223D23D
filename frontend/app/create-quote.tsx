import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useThemeContext } from '../src/context/ThemeContext';
import { api, quotesAPI, vehiclesAPI } from '../src/services/api';
import { useAuth } from '../src/context/AuthContext';
import { theme } from '../src/context/ThemeContext';
import { useTranslation } from 'react-i18next';
import i18n from '../src/i18n';
const colors = theme.colors;

const { width } = Dimensions.get('window');
type Step = 1 | 2 | 3 | 4;

// Service key mapping — labels resolved via i18n inside the component
const SERVICE_DEFS = [
  { _id: '1', key: 'diagnostics', icon: 'speedometer-outline', color: colors.brand },
  { _id: '2', key: 'oil_change', icon: 'water-outline', color: colors.success },
  { _id: '3', key: 'brakes', icon: 'disc-outline', color: colors.brand },
  { _id: '4', key: 'engine', icon: 'cog-outline', color: colors.warning },
  { _id: '5', key: 'suspension', icon: 'car-sport-outline', color: colors.brand },
  { _id: '6', key: 'electrical', icon: 'flash-outline', color: colors.brand },
  { _id: '7', key: 'body', icon: 'construct-outline', color: colors.brand },
  { _id: '8', key: 'tires', icon: 'ellipse-outline', color: colors.brand },
];

// Mock vehicles for demo
const MOCK_VEHICLES = [
  { _id: '1', brand: 'BMW', model: '320i', year: 2020, licensePlate: 'A 123 BC' },
  { _id: '2', brand: 'Mercedes', model: 'C200', year: 2019, licensePlate: 'B 456 DE' },
];

export default function CreateQuoteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { colors, isDark } = useThemeContext();
  const { user } = useAuth();
  const { t } = useTranslation();

  const dateOptions = React.useMemo(
    () => [
      { id: 'asap', label: i18n.t('create_quote.dates.asap') },
      { id: 'this_week', label: i18n.t('create_quote.dates.this_week') },
      { id: 'flex_week', label: i18n.t('create_quote.dates.flex_week') },
    ],
    [t]
  );

  const MOCK_SERVICES = React.useMemo(
    () =>
      SERVICE_DEFS.map((s) => ({
        ...s,
        name: i18n.t(`create_quote.services.${s.key}`),
      })),
    [t]
  );

  const [step, setStep] = useState<Step>(1);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Data
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);

  // Selected values
  const [selectedVehicle, setSelectedVehicle] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [preferredDateId, setPreferredDateId] = useState<string>('asap');
  
  // Animations
  const progressAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;
  
  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    // Animate progress bar
    Animated.timing(progressAnim, {
      toValue: (step - 1) / 3,
      duration: 300,
      useNativeDriver: false,
    }).start();
    
    // Animate step content
    fadeAnim.setValue(0);
    slideAnim.setValue(20);
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: Platform.OS !== 'web',
      }),
    ]).start();
  }, [step]);
  
  const fetchData = async () => {
    try {
      // Try to fetch real data, fallback to mock
      try {
        const vehiclesRes = await vehiclesAPI.getMy();
        if (vehiclesRes.data?.length > 0) {
          setVehicles(vehiclesRes.data);
        } else {
          setVehicles(MOCK_VEHICLES);
        }
      } catch {
        setVehicles(MOCK_VEHICLES);
      }
      
      setServices(MOCK_SERVICES);
      
      if (params.serviceId) {
        setSelectedService(params.serviceId as string);
      }
    } catch (error) {
      console.log('Error fetching data:', error);
      setVehicles(MOCK_VEHICLES);
      setServices(MOCK_SERVICES);
    } finally {
      setLoading(false);
    }
  };
  
  const handleNext = () => {
    if (step < 4) {
      setStep((step + 1) as Step);
    }
  };
  
  const handleBack = () => {
    if (step > 1) {
      setStep((step - 1) as Step);
    } else {
      router.back();
    }
  };
  
  const canProceed = () => {
    switch (step) {
      case 1: return !!selectedVehicle;
      case 2: return !!selectedService;
      case 3: return true;
      case 4: return true;
      default: return false;
    }
  };
  
  const handleSubmit = async () => {
    setSubmitting(true);
    
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    setSubmitting(false);
    
    // Navigate to confirmation screen
    router.push({
      pathname: '/booking-confirmation',
      params: {
        vehicleId: selectedVehicle,
        serviceId: selectedService,
        vehicle: JSON.stringify(getSelectedVehicle()),
        service: JSON.stringify(getSelectedService()),
        description: description,
        date: dateOptions.find((d) => d.id === preferredDateId)?.label || preferredDateId,
      },
    } as any);
  };
  
  const getSelectedVehicle = () => vehicles.find((v) => v._id === selectedVehicle);
  const getSelectedService = () => services.find((s) => s._id === selectedService);
  
  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });
  
  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <SafeAreaView style={styles.loadingContainer}>
          <ActivityIndicator color={colors.primary} size="large" />
        </SafeAreaView>
      </View>
    );
  }
  
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <KeyboardAvoidingView 
          style={styles.keyboardView} 
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity 
              onPress={handleBack} 
              style={[styles.headerBtn, { backgroundColor: colors.card }]}
            >
              <Ionicons name="arrow-back" size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={[styles.headerTitle, { color: colors.text }]} testID="create-quote-title">
              {t('create_quote.new_request')}
            </Text>
            <View style={{ width: 44 }} />
          </View>
          
          {/* Progress Bar */}
          <View style={styles.progressContainer}>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              <Animated.View 
                style={[
                  styles.progressFill, 
                  { width: progressWidth, backgroundColor: colors.primary }
                ]} 
              />
            </View>
            <Text style={[styles.stepIndicator, { color: colors.textSecondary }]}>
              {t('create_quote.step_of', { step, total: 4 })}
            </Text>
          </View>
          
          {/* Step Content */}
          <Animated.ScrollView 
            style={[styles.content, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}
            contentContainerStyle={styles.contentContainer}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* STEP 1: Select Vehicle */}
            {step === 1 && (
              <View style={styles.stepContent}>
                <Text style={[styles.stepTitle, { color: colors.text }]}>
                  {t('create_quote.step1_title')}
                </Text>
                <Text style={[styles.stepSubtitle, { color: colors.textSecondary }]}>
                  {t('create_quote.step1_subtitle')}
                </Text>
                
                <View style={styles.vehicleList}>
                  {vehicles.map((vehicle, index) => (
                    <VehicleCard
                      key={vehicle._id}
                      vehicle={vehicle}
                      selected={selectedVehicle === vehicle._id}
                      onSelect={() => setSelectedVehicle(vehicle._id)}
                      colors={colors}
                      index={index}
                    />
                  ))}
                  
                  {/* Add Vehicle Card */}
                  <TouchableOpacity
                    testID="add-vehicle-btn"
                    style={[styles.addVehicleCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                    onPress={() => router.push('/(tabs)/garage')}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.addIconCircle, { backgroundColor: colors.infoBg }]}>
                      <Ionicons name="add" size={24} color={colors.primary} />
                    </View>
                    <Text style={[styles.addVehicleText, { color: colors.primary }]}>
                      {t('create_quote.add_vehicle')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            
            {/* STEP 2: Select Service */}
            {step === 2 && (
              <View style={styles.stepContent}>
                <Text style={[styles.stepTitle, { color: colors.text }]}>
                  {t('create_quote.step2_title')}
                </Text>
                <Text style={[styles.stepSubtitle, { color: colors.textSecondary }]}>
                  {t('create_quote.step2_subtitle')}
                </Text>
                
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                  {services.map((service, index) => (
                    <TouchableOpacity
                      key={service._id}
                      onPress={() => setSelectedService(service._id)}
                      activeOpacity={0.7}
                      style={{
                        width: '48%',
                        backgroundColor: selectedService === service._id ? colors.brand : colors.cardElevated,
                        padding: 16,
                        borderRadius: 16,
                        borderWidth: 2,
                        borderColor: selectedService === service._id ? colors.brand : colors.border,
                        alignItems: 'center',
                        marginBottom: 12,
                      }}
                    >
                      <View 
                        style={{
                          width: 48,
                          height: 48,
                          backgroundColor: selectedService === service._id ? 'rgba(255,255,255,0.2)' : `${service.color}20`,
                          borderRadius: 14,
                          alignItems: 'center',
                          justifyContent: 'center',
                          marginBottom: 12,
                        }}
                      >
                        <Ionicons 
                          name={service.icon as any} 
                          size={24} 
                          color={selectedService === service._id ? colors.text : service.color} 
                        />
                      </View>
                      <Text 
                        style={{ 
                          fontSize: 14, 
                          fontWeight: '600', 
                          textAlign: 'center',
                          color: selectedService === service._id ? colors.text : colors.border,
                        }}
                      >
                        {service.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            
            {/* STEP 3: Description & Date */}
            {step === 3 && (
              <View style={styles.stepContent}>
                <Text style={[styles.stepTitle, { color: colors.text }]}>
                  {t('create_quote.step3_title')}
                </Text>
                <Text style={[styles.stepSubtitle, { color: colors.textSecondary }]}>
                  {t('create_quote.step3_subtitle')}
                </Text>
                
                <View style={[styles.textAreaWrapper, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <TextInput
                    testID="quote-description-input"
                    style={[styles.textArea, { color: colors.text }]}
                    placeholder={t('create_quote.description_placeholder')}
                    placeholderTextColor={colors.textMuted}
                    value={description}
                    onChangeText={setDescription}
                    multiline
                    numberOfLines={5}
                    textAlignVertical="top"
                  />
                </View>
                
                <Text style={[styles.dateLabel, { color: colors.text }]}>
                  {t('create_quote.date_label')}
                </Text>
                
                <View style={styles.dateOptions}>
                  {dateOptions.map((option) => (
                    <TouchableOpacity
                      key={option.id}
                      testID={`quote-date-${option.id}`}
                      style={[
                        styles.dateOption,
                        { 
                          backgroundColor: preferredDateId === option.id ? colors.primary : colors.card,
                          borderColor: preferredDateId === option.id ? colors.primary : colors.border,
                        }
                      ]}
                      onPress={() => setPreferredDateId(option.id)}
                      activeOpacity={0.7}
                    >
                      <Text 
                        style={[
                          styles.dateOptionText, 
                          { color: preferredDateId === option.id ? colors.text : colors.text }
                        ]}
                      >
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            
            {/* STEP 4: Review */}
            {step === 4 && (
              <View style={styles.stepContent}>
                <Text style={[styles.stepTitle, { color: colors.text }]}>
                  {t('create_quote.step4_title')}
                </Text>
                <Text style={[styles.stepSubtitle, { color: colors.textSecondary }]}>
                  {t('create_quote.step4_subtitle')}
                </Text>
                
                <View style={[styles.reviewCard, { backgroundColor: colors.card }]}>
                  {/* Vehicle */}
                  <View style={styles.reviewItem}>
                    <View style={[styles.reviewIconWrap, { backgroundColor: colors.infoBg }]}>
                      <Ionicons name="car-sport" size={20} color={colors.primary} />
                    </View>
                    <View style={styles.reviewItemContent}>
                      <Text style={[styles.reviewItemLabel, { color: colors.textMuted }]}>
                        {t('create_quote.vehicle')}
                      </Text>
                      <Text style={[styles.reviewItemValue, { color: colors.text }]}>
                        {getSelectedVehicle()?.brand} {getSelectedVehicle()?.model}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => setStep(1)} testID="edit-step-1">
                      <Text style={[styles.editLink, { color: colors.primary }]}>{t('create_quote.edit')}</Text>
                    </TouchableOpacity>
                  </View>
                  
                  <View style={[styles.reviewDivider, { backgroundColor: colors.divider }]} />
                  
                  {/* Service */}
                  <View style={styles.reviewItem}>
                    <View style={[styles.reviewIconWrap, { backgroundColor: colors.warningBg }]}>
                      <Ionicons name="construct" size={20} color={colors.warning} />
                    </View>
                    <View style={styles.reviewItemContent}>
                      <Text style={[styles.reviewItemLabel, { color: colors.textMuted }]}>
                        {t('create_quote.service')}
                      </Text>
                      <Text style={[styles.reviewItemValue, { color: colors.text }]}>
                        {getSelectedService()?.name}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => setStep(2)} testID="edit-step-2">
                      <Text style={[styles.editLink, { color: colors.primary }]}>{t('create_quote.edit')}</Text>
                    </TouchableOpacity>
                  </View>
                  
                  <View style={[styles.reviewDivider, { backgroundColor: colors.divider }]} />
                  
                  {/* Date */}
                  <View style={styles.reviewItem}>
                    <View style={[styles.reviewIconWrap, { backgroundColor: colors.successBg }]}>
                      <Ionicons name="calendar" size={20} color={colors.success} />
                    </View>
                    <View style={styles.reviewItemContent}>
                      <Text style={[styles.reviewItemLabel, { color: colors.textMuted }]}>
                        {t('create_quote.deadline')}
                      </Text>
                      <Text style={[styles.reviewItemValue, { color: colors.text }]}>
                        {dateOptions.find((d) => d.id === preferredDateId)?.label || ''}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => setStep(3)} testID="edit-step-3">
                      <Text style={[styles.editLink, { color: colors.primary }]}>{t('create_quote.edit')}</Text>
                    </TouchableOpacity>
                  </View>
                  
                  {description && (
                    <>
                      <View style={[styles.reviewDivider, { backgroundColor: colors.divider }]} />
                      <View style={styles.reviewItem}>
                        <View style={[styles.reviewIconWrap, { backgroundColor: colors.card }]}>
                          <Ionicons name="chatbubble-ellipses" size={20} color={colors.textSecondary} />
                        </View>
                        <View style={styles.reviewItemContent}>
                          <Text style={[styles.reviewItemLabel, { color: colors.textMuted }]}>
                            {t('create_quote.description')}
                          </Text>
                          <Text style={[styles.reviewItemValue, { color: colors.text }]} numberOfLines={2}>
                            {description}
                          </Text>
                        </View>
                      </View>
                    </>
                  )}
                </View>
                
                {/* Info Note */}
                <View style={[styles.infoNote, { backgroundColor: colors.infoBg }]}>
                  <Ionicons name="information-circle" size={20} color={colors.primary} />
                  <Text style={[styles.infoNoteText, { color: colors.primary }]}>
                    {t('create_quote.info_note')}
                  </Text>
                </View>
              </View>
            )}
          </Animated.ScrollView>
          
          {/* Footer */}
          <View style={[styles.footer, { backgroundColor: colors.background }]}>
            {step === 4 ? (
              <TouchableOpacity
                style={styles.submitButton}
                onPress={handleSubmit}
                disabled={submitting}
                activeOpacity={0.9}
              >
                <LinearGradient
                  colors={submitting ? [colors.textMuted, colors.textMuted] : [colors.primary, colors.primaryDark]}
                  style={styles.submitGradient}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                >
                  {submitting ? (
                    <ActivityIndicator color={colors.text} />
                  ) : (
                    <>
                      <Text style={styles.submitText}>{t('create_quote.submit')}</Text>
                      <Ionicons name="send" size={20} color={colors.text} />
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                testID="create-quote-next-btn"
                style={[
                  styles.nextButton,
                  { 
                    backgroundColor: canProceed() ? colors.primary : colors.border,
                  }
                ]}
                onPress={handleNext}
                disabled={!canProceed()}
                activeOpacity={0.8}
              >
                <Text style={[styles.nextButtonText, { color: canProceed() ? colors.text : colors.textMuted }]}>
                  {t('create_quote.continue')}
                </Text>
                <Ionicons name="arrow-forward" size={20} color={canProceed() ? colors.text : colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

/* ──────────── Vehicle Card ──────────── */
function VehicleCard({ vehicle, selected, onSelect, colors, index }: any) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 300,
      delay: index * 100,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, []);
  
  const handlePressIn = () => {
    Animated.spring(scaleAnim, { toValue: 0.98, useNativeDriver: Platform.OS !== 'web' }).start();
  };
  
  const handlePressOut = () => {
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: Platform.OS !== 'web' }).start();
  };
  
  return (
    <TouchableOpacity
      onPress={onSelect}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      activeOpacity={1}
    >
      <Animated.View
        style={[
          styles.vehicleCard,
          {
            backgroundColor: colors.card,
            borderColor: selected ? colors.primary : colors.border,
            opacity: fadeAnim,
            transform: [{ scale: scaleAnim }],
          },
        ]}
      >
        <View style={[styles.vehicleIconWrap, { backgroundColor: selected ? colors.infoBg : colors.backgroundTertiary }]}>
          <Ionicons name="car-sport" size={28} color={selected ? colors.primary : colors.textSecondary} />
        </View>
        <View style={styles.vehicleInfo}>
          <Text style={[styles.vehicleName, { color: colors.text }]}>
            {vehicle.brand} {vehicle.model}
          </Text>
          <Text style={[styles.vehicleDetails, { color: colors.textSecondary }]}>
            {vehicle.year} • {vehicle.licensePlate}
          </Text>
        </View>
        <View style={[styles.radioCircle, { borderColor: selected ? colors.primary : colors.border }]}>
          {selected && <View style={[styles.radioFill, { backgroundColor: colors.primary }]} />}
        </View>
      </Animated.View>
    </TouchableOpacity>
  );
}

/* ──────────── Service Card ──────────── */
function ServiceCard({ service, selected, onSelect, colors, index }: any) {
  // DEBUG
  console.log('SERVICE DATA:', service);
  
  return (
    <TouchableOpacity
      onPress={onSelect}
      activeOpacity={0.7}
      style={{
        backgroundColor: '#222',
        padding: 16,
        borderRadius: 12,
        marginBottom: 12,
        width: (width - 52) / 2,
        alignItems: 'center',
        borderWidth: 2,
        borderColor: selected ? colors.brand : '#333',
      }}
    >
      {/* DEBUG BLOCK instead of Ionicons */}
      <View
        style={{
          width: 40,
          height: 40,
          backgroundColor: service?.color || 'blue',
          borderRadius: 10,
          marginBottom: 10,
        }}
      />

      <Text style={{ color: 'white', fontSize: 14, fontWeight: '600', textAlign: 'center' }}>
        {service?.name || 'NO NAME'}
      </Text>
    </TouchableOpacity>
  );
}

/* ──────────── Styles ──────────── */
const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  keyboardView: { flex: 1 },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  headerTitle: { fontSize: 18, fontWeight: '600' },
  
  progressContainer: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  stepIndicator: {
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
  },
  
  content: { flex: 1 },
  contentContainer: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  stepContent: { flex: 1 },
  stepTitle: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
  },
  stepSubtitle: {
    fontSize: 15,
    marginBottom: 24,
  },
  
  // Vehicle List
  vehicleList: { gap: 12 },
  vehicleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    borderWidth: 2,
  },
  vehicleIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vehicleInfo: {
    flex: 1,
    marginLeft: 14,
  },
  vehicleName: {
    fontSize: 17,
    fontWeight: '600',
  },
  vehicleDetails: {
    fontSize: 14,
    marginTop: 4,
  },
  radioCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioFill: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  addVehicleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    borderWidth: 2,
    borderStyle: 'dashed',
  },
  addIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addVehicleText: {
    fontSize: 15,
    fontWeight: '600',
    marginLeft: 14,
  },
  
  // Services Grid
  servicesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  serviceCard: {
    width: (width - 52) / 2,
    padding: 16,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'center',
  },
  serviceIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  serviceCardText: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  
  // Text Area
  textAreaWrapper: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 24,
  },
  textArea: {
    fontSize: 16,
    minHeight: 100,
    lineHeight: 24,
  },
  dateLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  dateOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  dateOption: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  dateOptionText: {
    fontSize: 14,
    fontWeight: '500',
  },
  
  // Review Card
  reviewCard: {
    borderRadius: 18,
    padding: 4,
    marginBottom: 16,
  },
  reviewItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
  },
  reviewIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewItemContent: {
    flex: 1,
    marginLeft: 14,
  },
  reviewItemLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  reviewItemValue: {
    fontSize: 15,
    fontWeight: '600',
    marginTop: 2,
  },
  editLink: {
    fontSize: 14,
    fontWeight: '600',
  },
  reviewDivider: {
    height: 1,
    marginLeft: 68,
  },
  
  infoNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 14,
    borderRadius: 12,
    gap: 10,
  },
  infoNoteText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  
  // Footer
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
  },
  nextButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 56,
    borderRadius: 16,
    gap: 8,
  },
  nextButtonText: {
    fontSize: 17,
    fontWeight: '600',
  },
  submitButton: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  submitGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 56,
    gap: 10,
  },
  submitText: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '600',
  },
});

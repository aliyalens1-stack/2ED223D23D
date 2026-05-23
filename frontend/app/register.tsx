import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../src/context/ThemeContext';
import Brand from '../src/components/Brand';

import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../src/context/AuthContext';
import { theme } from '../src/context/ThemeContext';
import i18n from '../src/i18n';
const colors = theme.colors;

const REF_CODE_KEY = 'pending_referral_code';

export default function RegisterScreen() {
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  const router = useRouter();
  const params = useLocalSearchParams<{ role?: string; fromInvite?: string }>();
  const intentRole = params.role === 'provider' ? 'provider' : 'customer';
  const { register } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [referralCode, setReferralCode] = useState('');
  const [referralLocked, setReferralLocked] = useState(false);

  // Sprint 29: Capture pending referral code from AsyncStorage (after /invite/:code)
  useEffect(() => {
    (async () => {
      const stored = await AsyncStorage.getItem(REF_CODE_KEY);
      if (stored) {
        setReferralCode(stored);
        setReferralLocked(true);
      }
    })();
  }, []);

  const handleRegister = async () => {
    if (!firstName || !email || !password) {
      Alert.alert(i18n.t('common.error'), i18n.t('auth.fill_required'));
      return;
    }

    if (password.length < 6) {
      Alert.alert(i18n.t('common.error'), i18n.t('auth.password_too_short'));
      return;
    }

    setLoading(true);
    try {
      await register({
        email: email.toLowerCase().trim(),
        password,
        firstName,
        lastName,
        role: intentRole,
        referralCode: referralCode ? referralCode.toUpperCase().trim() : undefined,
      });
      // Sprint 29: consume the pending referral code after successful registration
      if (referralCode) {
        await AsyncStorage.removeItem(REF_CODE_KEY);
      }
      // Sprint: Mobile Welcome — role-based redirect after register
      router.replace('/(tabs)');
    } catch (error: any) {
      const message = error.response?.data?.message || i18n.t('errors.network') || 'Error';
      Alert.alert(i18n.t('common.error'), Array.isArray(message) ? message[0] : message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Back Button */}
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => router.back()}
          >
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>

          {/* Logo */}
          <View style={styles.logoContainer}>
            <Brand height={32} testID="register-logo" />
          </View>

          {/* Title */}
          <Text style={styles.title}>Регистрация</Text>
          <Text style={styles.subtitle}>Создайте новый аккаунт</Text>

          {/* Form */}
          <View style={styles.form}>
            <View style={styles.row}>
              <View style={[styles.inputContainer, { flex: 1 }]}>
                <TextInput
                  style={styles.input}
                  placeholder="Имя *"
                  placeholderTextColor={colors.textMuted}
                  value={firstName}
                  onChangeText={setFirstName}
                />
              </View>
              <View style={[styles.inputContainer, { flex: 1 }]}>
                <TextInput
                  style={styles.input}
                  placeholder="Фамилия"
                  placeholderTextColor={colors.textMuted}
                  value={lastName}
                  onChangeText={setLastName}
                />
              </View>
            </View>

            <View style={styles.inputContainer}>
              <Ionicons name="mail-outline" size={20} color={colors.textMuted} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Email *"
                placeholderTextColor={colors.textMuted}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={styles.inputContainer}>
              <Ionicons name="lock-closed-outline" size={20} color={colors.textMuted} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Пароль *"
                placeholderTextColor={colors.textMuted}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
                <Ionicons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={20}
                  color={colors.textMuted}
                />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.registerButton, loading && styles.registerButtonDisabled]}
              onPress={handleRegister}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text style={styles.registerButtonText}>Создать аккаунт</Text>
              )}
            </TouchableOpacity>

            {/* Sprint 29: Referral code field + bonus banner */}
            {referralLocked && (
              <View style={styles.bonusBanner} testID="register-bonus-banner">
                <Ionicons name="gift-outline" size={20} color={colors.primary} />
                <Text style={styles.bonusText}>
                  Применён код <Text style={{ fontWeight: '900', color: colors.primary }}>{referralCode}</Text> — получишь ₴300 после первого заказа
                </Text>
              </View>
            )}
            {!referralLocked && (
              <View style={styles.inputContainer}>
                <Ionicons name="gift-outline" size={20} color={colors.textMuted} style={styles.inputIcon} />
                <TextInput
                  testID="register-referral-input"
                  style={styles.input}
                  placeholder="Реферальный код (необязательно)"
                  placeholderTextColor={colors.textMuted}
                  value={referralCode}
                  onChangeText={(v) => setReferralCode(v.toUpperCase())}
                  autoCapitalize="characters"
                  maxLength={12}
                />
              </View>
            )}
          </View>

          {/* Login Link */}
          <View style={styles.loginLink}>
            <Text style={styles.loginText}>Уже есть аккаунт? </Text>
            <TouchableOpacity onPress={() => router.push('/login')}>
              <Text style={styles.loginLinkText}>Войти</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  backButton: {
    marginTop: 16,
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoContainer: {
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 32,
  },
  logoText: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
    marginTop: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: colors.textMuted,
    marginBottom: 32,
  },
  form: {
    gap: 16,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  inputIcon: {
    marginRight: 12,
  },
  input: {
    flex: 1,
    paddingVertical: 16,
    fontSize: 16,
    color: colors.text,
  },
  registerButton: {
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  registerButtonDisabled: {
    opacity: 0.7,
  },
  registerButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  loginLink: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 24,
  },
  loginText: {
    fontSize: 15,
    color: colors.textMuted,
  },
  loginLinkText: {
    fontSize: 15,
    color: colors.brand,
    fontWeight: '600',
  },
  bonusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(245, 184, 0, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(245, 184, 0, 0.4)',
    marginTop: 8,
  },
  bonusText: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 },
});

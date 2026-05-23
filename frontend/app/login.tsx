import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Spacing, BorderRadius, Typography } from '../src/theme';
import { Input } from '../src/ui/Input';
import { PrimaryButton } from '../src/ui/Button';
import { useAuth } from '../src/context/AuthContext';
import { useThemeContext } from '../src/context/ThemeContext';
import Brand from '../src/components/Brand';
import { theme } from '../src/context/ThemeContext';
import i18n from '../src/i18n';
const colors = theme.colors;

// После login роутим по роли: всегда → /(tabs). ProviderHome внутри (tabs) сам отрендерит provider-кабинет, если role.startsWith('provider').
function pickPostLoginRoute(_role?: string): string {
  return '/(tabs)';
}

export default function LoginScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ role?: string }>();
  const { login, isLoading: authLoading, consumePendingIntent } = useAuth();
  const { colors } = useThemeContext();
  const { t } = useTranslation();

  const intentRole = params.role === 'provider' ? 'provider' : 'customer';

  // Sprint Auth-2: после login проверяем pendingIntent → возвращаем юзера к прерванному действию
  const routeAfterLogin = async (userRole?: string) => {
    const { intent: pending, params: pendingParams } = await consumePendingIntent();
    const role = (userRole || '').toString();

    // Provider role → пропускаем pendingIntent, идём в (tabs) — там ProviderHome сам отрендерится
    if (role.startsWith('provider')) {
      router.replace('/(tabs)');
      return;
    }

    if (pending) {
      switch (pending) {
        case 'booking_confirm': {
          const qp = pendingParams || {};
          const qs = Object.keys(qp).length
            ? '?' + Object.entries(qp).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
            : '';
          router.replace(`/booking/confirm${qs}` as any);
          return;
        }
        case 'favorites':
          router.replace('/favorites');
          return;
        case 'garage':
          router.replace('/(tabs)/garage');
          return;
        case 'review_create': {
          const qp = pendingParams || {};
          const qs = Object.keys(qp).length
            ? '?' + Object.entries(qp).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
            : '';
          router.replace(`/review/create${qs}` as any);
          return;
        }
        case 'provider_dashboard':
          router.replace('/(tabs)');
          return;
        default:
          break;
      }
    }
    router.replace('/(tabs)');
  };

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Real-device testing helpers — pre-fill seeded demo accounts so the
  // user can validate both customer and provider flows on the same
  // device without typing credentials. Visible only when demo seeds
  // exist in the backend (always true in preview / dev).
  const fillDemo = (kind: 'customer' | 'provider' | 'admin') => {
    if (kind === 'customer') {
      setEmail('customer@test.com');
      setPassword('Customer123!');
    } else if (kind === 'provider') {
      setEmail('provider@test.com');
      setPassword('Provider123!');
    } else {
      setEmail('admin@autoservice.com');
      setPassword('Admin123!');
    }
    setError('');
  };

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setError(i18n.t('auth.credentials_required'));
      return;
    }
    
    setError('');
    setLoading(true);
    
    try {
      // login() возвращает userData — ему доверяем role напрямую (не email-heuristic)
      const userData = await login(email.trim(), password);
      await routeAfterLogin(userData?.role);
    } catch (err: any) {
      // Sprint 2FA: server demands a TOTP code — navigate to verify screen.
      if (err?.code === '2FA_REQUIRED' && err?.challengeToken) {
        router.push({
          pathname: '/2fa-verify',
          params: {
            challengeToken: err.challengeToken,
            email: err.email || email.trim(),
          },
        } as any);
        return;
      }
      setError(err.response?.data?.message || i18n.t('auth.wrong_email_or_password'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Back Button */}
          <TouchableOpacity
            onPress={() => router.back()}
            style={[styles.backButton, { backgroundColor: colors.card }]}
          >
            <Ionicons name="arrow-back" size={22} color={colors.text} />
          </TouchableOpacity>
          
          {/* Logo & Header */}
          <View style={styles.header}>
            <Brand height={32} style={{ marginBottom: Spacing.md }} testID="login-logo" />
            <Text style={[styles.title, { color: colors.text }]}>
              {t('auth.login_btn')}
            </Text>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              {t('auth.subtitle')}
            </Text>
          </View>
          
          {/* Form */}
          <View style={styles.form}>
            {error ? (
              <View style={[styles.errorBox, { backgroundColor: colors.errorBg }]}>
                <Ionicons name="alert-circle" size={18} color={colors.error} />
                <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>
              </View>
            ) : null}
            
            <Input
              label={t('auth.email')}
              placeholder={t('auth.email_placeholder')}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              icon="mail-outline"
            />
            
            <Input
              label={t('auth.password')}
              placeholder={t('auth.password_placeholder')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              icon="lock-closed-outline"
            />
            
            <TouchableOpacity style={styles.forgotPassword} onPress={() => router.push('/forgot-password')} testID="forgot-password-link">
              <Text style={[styles.forgotText, { color: colors.primary }]}>
                {t('auth.forgot_password')}
              </Text>
            </TouchableOpacity>
            
            <PrimaryButton
              testID="login-submit-button"
              onPress={handleLogin}
              loading={loading || authLoading}
              fullWidth
              size="lg"
            >
              {t('auth.login_btn')}
            </PrimaryButton>
          </View>

          {/* Register Link */}
          <View style={styles.footer}>
            <Text style={[styles.footerText, { color: colors.textSecondary }]}>
              {t('auth.no_account')}{' '}
            </Text>
            <TouchableOpacity onPress={() => router.push('/register')}>
              <Text style={[styles.linkText, { color: colors.primary }]}>
                {t('auth.register_btn')}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Demo seeds — visible on every preview/dev build for quick
              real-device validation. Not gated by __DEV__ on purpose:
              these are seeded test accounts users explicitly request. */}
          <View style={styles.demoSection}>
            <View style={styles.demoHeader}>
              <View style={[styles.demoDivider, { backgroundColor: colors.border }]} />
              <Text style={[styles.demoTitle, { color: colors.textSecondary }]}>DEMO ACCOUNTS</Text>
              <View style={[styles.demoDivider, { backgroundColor: colors.border }]} />
            </View>
            <TouchableOpacity
              style={[styles.demoButton, { borderColor: colors.border, backgroundColor: colors.card }]}
              onPress={() => fillDemo('customer')}
              testID="demo-fill-customer"
            >
              <View style={[styles.demoIcon, { backgroundColor: colors.primary + '22' }]}>
                <Ionicons name="person-outline" size={20} color={colors.primary} />
              </View>
              <View style={styles.demoInfo}>
                <Text style={[styles.demoLabel, { color: colors.text }]}>Customer</Text>
                <Text style={[styles.demoDesc, { color: colors.textSecondary }]}>customer@test.com</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.demoButton, { borderColor: colors.border, backgroundColor: colors.card }]}
              onPress={() => fillDemo('provider')}
              testID="demo-fill-provider"
            >
              <View style={[styles.demoIcon, { backgroundColor: '#f59e0b22' }]}>
                <Ionicons name="construct-outline" size={20} color="#f59e0b" />
              </View>
              <View style={styles.demoInfo}>
                <Text style={[styles.demoLabel, { color: colors.text }]}>Provider / Inspector</Text>
                <Text style={[styles.demoDesc, { color: colors.textSecondary }]}>provider@test.com</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.base,
    paddingBottom: Spacing.xxl,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.xl,
  },
  header: {
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  logoContainer: {
    width: 72,
    height: 72,
    borderRadius: BorderRadius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  title: {
    fontSize: Typography.size.xl,
    fontWeight: '700',
    marginBottom: Spacing.sm,
  },
  subtitle: {
    fontSize: Typography.size.base,
    textAlign: 'center',
  },
  form: {
    flex: 1,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    marginBottom: Spacing.base,
    gap: Spacing.sm,
  },
  errorText: {
    flex: 1,
    fontSize: Typography.size.sm,
  },
  forgotPassword: {
    alignSelf: 'flex-end',
    marginBottom: Spacing.lg,
    marginTop: -Spacing.sm,
  },
  forgotText: {
    fontSize: Typography.size.sm,
    fontWeight: '500',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: Spacing.xl,
  },
  footerText: {
    fontSize: Typography.size.base,
  },
  linkText: {
    fontSize: Typography.size.base,
    fontWeight: '600',
  },
  demoSection: {
    marginTop: Spacing.lg,
  },
  demoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: Spacing.base,
  },
  demoDivider: {
    flex: 1,
    height: 1,
  },
  demoTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  demoButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    marginBottom: 8,
    gap: 12,
  },
  demoIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  demoInfo: {
    flex: 1,
  },
  demoLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  demoDesc: {
    fontSize: 12,
    marginTop: 1,
  },
});

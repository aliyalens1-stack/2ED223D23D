/**
 * 2FA verify screen — Sprint 2FA.
 * Receives challengeToken from /login; user enters 6-digit TOTP code (or
 * a recovery code), we POST /api/auth/2fa/verify and on success the
 * AuthContext is populated with the real JWT.
 *
 * i18n: all user-facing strings come from the `two_factor.*` namespace.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../src/context/ThemeContext';
import { useAuth } from '../src/context/AuthContext';
import i18n from '../src/i18n';

export default function TwoFactorVerifyScreen() {
  const { colors } = useThemeContext();
  const { loginWith2FA } = useAuth();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ challengeToken: string; email?: string }>();
  const challengeToken = params.challengeToken || '';
  const email = params.email || '';

  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = useCallback(async () => {
    if (!challengeToken) {
      setError(i18n.t('two_factor.error_session_expired'));
      return;
    }
    setError('');
    setLoading(true);
    try {
      if (useRecovery) {
        if (recovery.trim().length < 6) {
          setError(i18n.t('two_factor.error_enter_recovery'));
          setLoading(false);
          return;
        }
        await loginWith2FA(challengeToken, undefined, recovery.trim().toUpperCase());
      } else {
        if (code.length !== 6) {
          setError(i18n.t('two_factor.error_enter_six_digits'));
          setLoading(false);
          return;
        }
        await loginWith2FA(challengeToken, code, undefined);
      }
      router.replace('/(tabs)' as any);
    } catch (e: any) {
      const msg = e?.response?.data?.message || i18n.t('two_factor.error_invalid_code');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [challengeToken, code, recovery, useRecovery, loginWith2FA, t]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} testID="2fa-verify-screen">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="2fa-back">
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>

          <View style={[styles.iconWrap, { backgroundColor: (colors.brand || colors.primary) + '20' }]}>
            <Ionicons name="shield-checkmark" size={32} color={colors.brand || colors.primary} />
          </View>
          <Text style={[styles.title, { color: colors.text }]}>{t('two_factor.title')}</Text>
          {email ? <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{email}</Text> : null}
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            {useRecovery
              ? t('two_factor.hint_recovery')
              : t('two_factor.hint_totp')}
          </Text>

          {!useRecovery ? (
            <TextInput
              testID="2fa-code-input"
              style={[styles.codeInput, { borderColor: colors.border, color: colors.text }]}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
              placeholder="000000"
              placeholderTextColor={colors.textMuted || colors.textSecondary}
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            />
          ) : (
            <TextInput
              testID="2fa-recovery-input"
              style={[styles.recoveryInput, { borderColor: colors.border, color: colors.text }]}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={12}
              autoFocus
              placeholder="ABCDEF1234"
              placeholderTextColor={colors.textMuted || colors.textSecondary}
              value={recovery}
              onChangeText={(v) => setRecovery(v.toUpperCase())}
            />
          )}

          {error ? <Text style={[styles.error, { color: colors.danger || '#EF4444' }]}>{error}</Text> : null}

          <TouchableOpacity
            testID="2fa-submit"
            onPress={submit}
            disabled={loading}
            style={[styles.submitBtn, { backgroundColor: colors.primary, opacity: loading ? 0.6 : 1 }]}
          >
            {loading ? (
              <ActivityIndicator color={colors.onPrimary || '#000'} />
            ) : (
              <Text style={[styles.submitText, { color: colors.onPrimary || '#000' }]}>{t('two_factor.submit')}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            testID="2fa-toggle-mode"
            onPress={() => { setUseRecovery(!useRecovery); setError(''); setCode(''); setRecovery(''); }}
            style={styles.linkBtn}
          >
            <Text style={[styles.linkText, { color: colors.brand || colors.primary }]}>
              {useRecovery ? t('two_factor.link_use_totp') : t('two_factor.link_use_recovery')}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 24, gap: 16, alignItems: 'center' },
  backBtn: { alignSelf: 'flex-start', padding: 8, marginBottom: 8 },
  iconWrap: { width: 72, height: 72, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  title: { fontSize: 22, fontWeight: '800', textAlign: 'center' },
  subtitle: { fontSize: 14, fontWeight: '600' },
  hint: { fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 8 },
  codeInput: {
    borderWidth: 2, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 22,
    fontSize: 28, fontWeight: '700', letterSpacing: 10, textAlign: 'center',
    minWidth: 240,
  },
  recoveryInput: {
    borderWidth: 2, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 18,
    fontSize: 18, fontWeight: '700', letterSpacing: 3, textAlign: 'center',
    minWidth: 240,
  },
  error: { fontSize: 13, fontWeight: '600' },
  submitBtn: { paddingHorizontal: 40, paddingVertical: 14, borderRadius: 12, marginTop: 8, minWidth: 240, alignItems: 'center' },
  submitText: { fontSize: 16, fontWeight: '800' },
  linkBtn: { padding: 10, marginTop: 4 },
  linkText: { fontSize: 13, fontWeight: '600' },
});

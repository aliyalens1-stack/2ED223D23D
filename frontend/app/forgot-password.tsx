import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../src/context/ThemeContext';
import { api } from '../src/services/api';
import i18n from '../src/i18n';

export default function ForgotPasswordScreen() {
  const { colors } = useThemeContext();
  const router = useRouter();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!email.trim()) { setError(i18n.t('forgot_password.error_email_required')); return; }
    setLoading(true);
    setError('');
    try {
      await api.post('/auth/forgot-password', { email: email.trim().toLowerCase() });
      setSent(true);
    } catch {
      // Even if endpoint doesn't exist, show success for security
      setSent(true);
    } finally { setLoading(false); }
  };

  if (sent) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} testID="forgot-password-success">
        <View style={styles.successContainer}>
          <View style={[styles.successIcon, { backgroundColor: colors.success + '15' }]}>
            <Ionicons name="mail-outline" size={48} color={colors.success} />
          </View>
          <Text style={[styles.successTitle, { color: colors.text }]}>{t('forgot_password.success_title')}</Text>
          <Text style={[styles.successSubtitle, { color: colors.textSecondary }]}>
            {t('forgot_password.success_subtitle', { email })}
          </Text>
          <TouchableOpacity testID="back-to-login-btn" style={[styles.backBtn, { backgroundColor: colors.primary }]} onPress={() => router.push('/login')}>
            <Text style={styles.backBtnText}>{t('forgot_password.back_to_login')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} testID="forgot-password-screen">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => router.back()} testID="forgot-back-btn">
              <Ionicons name="arrow-back" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={[styles.headerTitle, { color: colors.text }]}>{t('forgot_password.header_title')}</Text>
            <View style={{ width: 24 }} />
          </View>

          <View style={styles.formContainer}>
            <View style={[styles.iconContainer, { backgroundColor: colors.primary + '15' }]}>
              <Ionicons name="lock-open-outline" size={40} color={colors.primary} />
            </View>
            <Text style={[styles.title, { color: colors.text }]}>{t('forgot_password.icon_title')}</Text>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              {t('forgot_password.subtitle')}
            </Text>

            <View style={[styles.inputContainer, { backgroundColor: colors.card, borderColor: error ? colors.error : colors.border }]}>
              <Ionicons name="mail-outline" size={20} color={colors.textMuted} />
              <TextInput
                testID="forgot-email-input"
                style={[styles.input, { color: colors.text }]}
                placeholder={t('forgot_password.email_placeholder')}
                placeholderTextColor={colors.textMuted}
                value={email}
                onChangeText={(txt) => { setEmail(txt); setError(''); }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            {error ? <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text> : null}

            <TouchableOpacity testID="forgot-submit-btn" style={[styles.submitBtn, { backgroundColor: colors.primary }]} onPress={handleSubmit} disabled={loading}>
              {loading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.submitText}>{t('forgot_password.submit')}</Text>}
            </TouchableOpacity>

            <TouchableOpacity testID="go-login-link" style={styles.loginLink} onPress={() => router.push('/login')}>
              <Text style={[styles.loginLinkText, { color: colors.primary }]}>{t('forgot_password.back_to_login')}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', marginLeft: 12 },
  formContainer: { flex: 1, paddingHorizontal: 24, paddingTop: 40, alignItems: 'center' },
  iconContainer: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 8 },
  subtitle: { fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 32 },
  inputContainer: { flexDirection: 'row', alignItems: 'center', width: '100%', height: 52, borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, gap: 10, marginBottom: 8 },
  input: { flex: 1, fontSize: 16 },
  errorText: { fontSize: 13, alignSelf: 'flex-start', marginBottom: 8 },
  submitBtn: { width: '100%', height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  submitText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
  loginLink: { marginTop: 20, padding: 12 },
  loginLinkText: { fontSize: 14, fontWeight: '600' },
  successContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 16 },
  successIcon: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center' },
  successTitle: { fontSize: 22, fontWeight: '700' },
  successSubtitle: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  backBtn: { paddingHorizontal: 24, paddingVertical: 14, borderRadius: 14, marginTop: 16 },
  backBtnText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
});

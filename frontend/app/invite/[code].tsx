/**
 * Deep-link capture: /invite/{code}
 *
 * Flow:
 *   1. User taps share link → app opens this route with :code param
 *   2. We store code in AsyncStorage under 'pending_referral_code'
 *   3. Redirect to /register (or /login if already logged in)
 *   4. register.tsx reads the code from AsyncStorage and sends it in /auth/register
 *
 * Shows a quick confirmation card so user sees WHY they got a bonus.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { useThemeContext } from '../../src/context/ThemeContext';
import { useAuth } from '../../src/context/AuthContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

const API = process.env.EXPO_PUBLIC_BACKEND_URL || '';
const REF_CODE_KEY = 'pending_referral_code';

export default function InviteCaptureScreen() {
  const router = useRouter();
  const { code: rawCode } = useLocalSearchParams<{ code: string }>();
  const { colors } = useThemeContext();
  const { isAuthenticated } = useAuth();
  const styles = makeStyles(colors);
  const [status, setStatus] = useState<'loading' | 'ok' | 'invalid'>('loading');
  const [code, setCode] = useState('');

  useEffect(() => {
    const c = (rawCode || '').toString().toUpperCase().trim();
    if (!c) { setStatus('invalid'); return; }
    setCode(c);
    (async () => {
      try {
        // Validate code exists via public stats + store
        // (we don't have a /validate endpoint, so just store and let register do the work)
        await AsyncStorage.setItem(REF_CODE_KEY, c);
        setStatus('ok');
      } catch {
        setStatus('invalid');
      }
    })();
  }, [rawCode]);

  const handleContinue = () => {
    if (isAuthenticated) {
      // Already logged in → try to apply the code via /api/referrals/apply
      applyForExisting(code);
    } else {
      router.replace({ pathname: '/register', params: { fromInvite: '1' } });
    }
  };

  const applyForExisting = async (c: string) => {
    try {
      const token = await AsyncStorage.getItem('auth_token');
      await axios.post(`${API}/api/referrals/apply`,
        { code: c },
        { headers: { Authorization: `Bearer ${token}` } });
      await AsyncStorage.removeItem(REF_CODE_KEY);
      router.replace('/referral');
    } catch {
      router.replace('/referral');
    }
  };

  if (status === 'loading') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  if (status === 'invalid') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={56} color={colors.textMuted} />
          <Text style={styles.titleMuted}>Приглашение не найдено</Text>
          <TouchableOpacity style={styles.btnPrimary} onPress={() => router.replace('/')}>
            <Text style={styles.btnPrimaryText}>На главную</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} testID="invite-capture-screen">
      <View style={styles.content}>
        <View style={styles.gift}><Text style={{ fontSize: 64 }}>🎁</Text></View>
        <Text style={styles.title}>Ваш бонус ждёт</Text>
        <Text style={styles.subtitle}>
          Ты приглашён по коду{'\n'}
          <Text style={styles.codeHighlight}>{code}</Text>
        </Text>

        <View style={styles.rewardCard}>
          <View style={styles.rewardRow}>
            <Ionicons name="cash-outline" size={22} color={colors.primary} />
            <Text style={styles.rewardText}>
              <Text style={{ fontWeight: '800' }}>₴300</Text> на кошелёк после первого заказа
            </Text>
          </View>
          <View style={styles.rewardRow}>
            <Ionicons name="flash-outline" size={22} color={colors.primary} />
            <Text style={styles.rewardText}>Мгновенная активация при регистрации</Text>
          </View>
        </View>

        <TouchableOpacity
          testID="invite-continue-btn"
          style={styles.btnPrimary}
          onPress={handleContinue}
        >
          <Text style={styles.btnPrimaryText}>
            {isAuthenticated ? 'Активировать код' : 'Зарегистрироваться'}
          </Text>
          <Ionicons name="arrow-forward" size={18} color={colors.onPrimary || colors.brandText} />
        </TouchableOpacity>

        {!isAuthenticated && (
          <TouchableOpacity onPress={() => router.replace('/login')}>
            <Text style={styles.secondaryLink}>У меня уже есть аккаунт</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  content: { flex: 1, padding: 28, justifyContent: 'center', alignItems: 'center' },
  gift: { marginBottom: 12 },
  title: { fontSize: 26, fontWeight: '900', color: c.text, textAlign: 'center' },
  titleMuted: { fontSize: 18, fontWeight: '700', color: c.text, marginTop: 14, textAlign: 'center' },
  subtitle: { fontSize: 15, color: c.textMuted, marginTop: 10, textAlign: 'center', lineHeight: 22 },
  codeHighlight: { color: c.primary, fontSize: 18, fontWeight: '900', letterSpacing: 3 },
  rewardCard: {
    width: '100%', marginTop: 28, backgroundColor: c.card,
    borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 18, gap: 14,
  },
  rewardRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rewardText: { flex: 1, fontSize: 14, color: c.text, lineHeight: 20 },
  btnPrimary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 32, paddingVertical: 15, paddingHorizontal: 28,
    backgroundColor: c.primary, borderRadius: 14, width: '100%',
  },
  btnPrimaryText: { color: c.onPrimary || colors.brandText, fontSize: 16, fontWeight: '800' },
  secondaryLink: { color: c.textMuted, marginTop: 18, fontSize: 13, textDecorationLine: 'underline' },
});

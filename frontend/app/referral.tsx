/**
 * Sprint 29 — Growth loop screen.
 *
 * Customer UX: "Пригласи друга → он получит ₴300, ты ₴200 после его первого заказа"
 * Provider UX: "Приведи мастера → 7 дней × 1.5 буста бесплатно"
 *
 * Render:
 *  - My referral code (big, tappable to copy)
 *  - Share URL (native Share + copy)
 *  - Progress: pending / completed counters + earned wallet credit
 *  - Urgency banner: "🔥 Осталось N дней акции"
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, Share, Platform,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import axios from 'axios';
import { useAuth } from '../src/context/AuthContext';
import { useThemeContext } from '../src/context/ThemeContext';
import { theme } from '../src/context/ThemeContext';
const colors = theme.colors;

const API = process.env.EXPO_PUBLIC_BACKEND_URL || '';

type MyRef = {
  code: string;
  shareUrl: string;
  ownerType: 'customer' | 'provider';
  totalUses: number;
  pending: number;
  completed: number;
  walletBalanceUAH: number;
  rewardCopy: string;
  urgencyDaysLeft: number;
  recentUses: any[];
};

export default function ReferralScreen() {
  const router = useRouter();
  const { user, token } = useAuth() as any;
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const [data, setData] = useState<MyRef | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    axios.get(`${API}/api/referrals/my`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [user, token]);

  const copyCode = async () => {
    if (!data) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await Clipboard.setStringAsync(data.code);
    Alert.alert('Скопировано', `Код ${data.code} в буфере обмена`);
  };

  const shareLink = async () => {
    if (!data) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (Platform.OS === 'web') {
        await Clipboard.setStringAsync(data.shareUrl);
        Alert.alert('Ссылка скопирована', data.shareUrl);
        return;
      }
      await Share.share({
        message: data.ownerType === 'provider'
          ? `🔧 Приводи мастеров — получай 7 дней × 1.5 буста бесплатно. Мой код: ${data.code}\n${data.shareUrl}`
          : `🚗 Нашёл топ-сервис для авто в Киеве! Регистрируйся по моей ссылке — получишь ₴300 на первый заказ.\n${data.shareUrl}`,
        url: data.shareUrl,
        title: 'Auto Search',
      });
    } catch (e) { /* user cancel */ }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingWrap}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }
  if (!user || !data) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.emptyWrap}>
          <Ionicons name="log-in-outline" size={48} color={colors.textMuted} />
          <Text style={styles.emptyTxt}>Войдите чтобы получить свой реферальный код</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => router.push('/login')}>
            <Text style={styles.primaryBtnTxt}>Войти</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const isProvider = data.ownerType === 'provider';
  const headline = isProvider
    ? 'Приведи мастера → получи 7 дней × 1.5 буста бесплатно'
    : `Пригласи друга → получи ₴200, он ₴300`;

  return (
    <SafeAreaView style={styles.container} testID="referral-screen">
      <View style={styles.header}>
        <TouchableOpacity testID="referral-back-btn" onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Growth x10</Text>
        <View style={styles.iconBtn} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Urgency banner */}
        <View style={styles.urgencyBanner} testID="referral-urgency-banner">
          <Ionicons name="flame" size={16} color={colors.brand} />
          <Text style={styles.urgencyTxt}>
            🔥 Осталось <Text style={{ fontWeight: '900' }}>{data.urgencyDaysLeft}</Text> дней акции
          </Text>
        </View>

        {/* Hero */}
        <View style={styles.hero}>
          <View style={styles.heroIconWrap}>
            <Text style={{ fontSize: 44 }}>{isProvider ? '🚀' : '🎁'}</Text>
          </View>
          <Text style={styles.heroHeadline}>{headline}</Text>
          <Text style={styles.heroSub}>{data.rewardCopy}</Text>
        </View>

        {/* Code card */}
        <View style={styles.codeCard}>
          <Text style={styles.codeLabel}>ВАШ КОД</Text>
          <TouchableOpacity testID="referral-copy-code" onPress={copyCode} style={styles.codeValueWrap}>
            <Text style={styles.codeValue}>{data.code}</Text>
            <Ionicons name="copy-outline" size={20} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.codeUrl}>{data.shareUrl}</Text>
          <TouchableOpacity testID="referral-share-btn" onPress={shareLink} style={styles.shareBtn}>
            <Ionicons name="share-social" size={18} color={colors.onPrimary || colors.brandText} />
            <Text style={styles.shareBtnTxt}>Пригласить {isProvider ? 'мастера' : 'друга'}</Text>
          </TouchableOpacity>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statVal}>{data.totalUses}</Text>
            <Text style={styles.statLab}>приглашено</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statVal, { color: colors.success }]}>{data.completed}</Text>
            <Text style={styles.statLab}>активировано</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statVal, { color: colors.primary }]}>
              {isProvider ? `${data.completed * 7}д` : `₴${data.walletBalanceUAH}`}
            </Text>
            <Text style={styles.statLab}>{isProvider ? 'буста получено' : 'в кошельке'}</Text>
          </View>
        </View>

        {/* How it works */}
        <View style={styles.stepsCard}>
          <Text style={styles.stepsTitle}>Как это работает</Text>
          <Step n={1} text={`Отправь ${isProvider ? 'мастеру' : 'другу'} свой код или ссылку`} />
          <Step n={2} text={isProvider
            ? 'Он регистрируется как мастер и вводит твой код'
            : 'Он регистрируется по ссылке'} />
          <Step n={3} text={isProvider
            ? 'После 3 завершённых заказов у него — ты получаешь 7 дней ×1.5 буста'
            : 'После его первого заказа — тебе ₴200, ему ₴300 на ремонт'} />
        </View>

        {/* Recent uses */}
        {data.recentUses.length > 0 && (
          <View style={styles.recentCard}>
            <Text style={styles.stepsTitle}>Последние приглашения</Text>
            {data.recentUses.map((u, i) => (
              <View key={i} style={styles.recentRow}>
                <Text style={styles.recentName}>
                  {u.invitedUserId ? u.invitedUserId.slice(-6) : u.invitedSlug || '—'}
                </Text>
                <View style={[
                  styles.statusPill,
                  { backgroundColor: u.status === 'completed' ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)' },
                ]}>
                  <Text style={[
                    styles.statusTxt,
                    { color: u.status === 'completed' ? colors.success : colors.warning },
                  ]}>{u.status === 'completed' ? 'активирован' : 'ожидание'}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  const { colors } = useThemeContext();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: 10 }}>
      <View style={{
        width: 26, height: 26, borderRadius: 13,
        backgroundColor: colors.brandSoft || 'rgba(245,184,0,0.2)',
        alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 2,
      }}>
        <Text style={{ color: colors.primary, fontWeight: '900', fontSize: 13 }}>{n}</Text>
      </View>
      <Text style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 }}>{text}</Text>
    </View>
  );
}

const makeStyles = (c: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyTxt: { color: c.text, textAlign: 'center', marginTop: 12, fontSize: 15 },
  primaryBtn: {
    marginTop: 20, paddingHorizontal: 32, paddingVertical: 12,
    backgroundColor: c.primary, borderRadius: 10,
  },
  primaryBtnTxt: { color: c.onPrimary || colors.brandText, fontWeight: '800', fontSize: 15 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  iconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: c.card },
  title: { fontSize: 17, fontWeight: '800', color: c.text },

  urgencyBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 10, borderRadius: 10,
    backgroundColor: 'rgba(239,68,68,0.10)',
    marginBottom: 12,
  },
  urgencyTxt: { flex: 1, fontSize: 13, color: c.text },

  hero: {
    alignItems: 'center', padding: 20, borderRadius: 18,
    backgroundColor: c.card, borderWidth: 1, borderColor: c.border,
    marginBottom: 12,
  },
  heroIconWrap: { marginBottom: 8 },
  heroHeadline: { fontSize: 18, fontWeight: '900', color: c.text, textAlign: 'center', lineHeight: 25 },
  heroSub: { fontSize: 13, color: c.textMuted, marginTop: 8, textAlign: 'center', lineHeight: 19 },

  codeCard: {
    backgroundColor: c.card, borderRadius: 18, padding: 20, marginBottom: 12,
    borderWidth: 2, borderColor: c.primary,
    alignItems: 'center',
  },
  codeLabel: { fontSize: 11, letterSpacing: 1.5, color: c.textMuted, fontWeight: '700' },
  codeValueWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginVertical: 8,
  },
  codeValue: { fontSize: 36, fontWeight: '900', color: c.text, letterSpacing: 4 },
  codeUrl: { fontSize: 12, color: c.textMuted, marginBottom: 16 },
  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 13, paddingHorizontal: 22,
    backgroundColor: c.primary, borderRadius: 12, width: '100%',
  },
  shareBtnTxt: { color: c.onPrimary || colors.brandText, fontSize: 15, fontWeight: '800' },

  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  statCard: {
    flex: 1, backgroundColor: c.card, borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: c.border, alignItems: 'center',
  },
  statVal: { fontSize: 22, fontWeight: '900', color: c.text },
  statLab: { fontSize: 11, color: c.textMuted, marginTop: 3, letterSpacing: 0.4 },

  stepsCard: {
    backgroundColor: c.card, borderRadius: 14, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: c.border,
  },
  stepsTitle: { fontSize: 14, fontWeight: '800', color: c.text },

  recentCard: {
    backgroundColor: c.card, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: c.border,
  },
  recentRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  recentName: { color: c.text, fontSize: 14, fontWeight: '600' },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  statusTxt: { fontSize: 11, fontWeight: '700' },
});

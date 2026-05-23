/**
 * Sprint 27 — Legacy boost packages screen (fallback).
 *
 * Auction (/provider-boost) is the primary monetisation surface.
 * This screen keeps fixed 7d/24h SKUs available for providers who prefer
 * predictable spend rather than competing in the auction.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert,
} from 'react-native';
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

type Product = {
  code: string; name: string; price: number; currency: string;
  durationDays: number; benefit: string;
  config: { boostMultiplier: number; boostLevel: string };
};

export default function PackagesScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const providerSlug = (user as any)?.providerSlug || (user as any)?.organization?.slug || 'avtomaster-pro';

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<string | null>(null);

  useEffect(() => {
    axios.get(`${API}/api/billing/boost/products`)
      .then(r => setProducts(r.data?.products || []))
      .finally(() => setLoading(false));
  }, []);

  const buy = async (p: Product) => {
    try {
      setPurchasing(p.code);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await axios.post(`${API}/api/provider/boost/buy`, {
        providerSlug,
        plan: p.config.boostLevel,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Boost активирован 🚀', `${p.name} • ×${p.config.boostMultiplier}`);
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Ошибка', e?.response?.data?.message || 'Не удалось купить');
    } finally {
      setPurchasing(null);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingWrap}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} testID="packages-screen">
      <View style={styles.header}>
        <TouchableOpacity testID="packages-back-btn" onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Boost-пакеты</Text>
        <View style={styles.iconBtn} />
      </View>

      <View style={styles.warningBanner}>
        <Ionicons name="information-circle" size={16} color={colors.primary} />
        <Text style={styles.warningTxt}>
          Старая модель. Новая <Text style={{ color: colors.primary, fontWeight: '700' }}>живая аукционка</Text> печатает деньги лучше.
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {products.map(p => (
          <View key={p.code} style={styles.card} testID={`package-${p.code}`}>
            <View style={styles.cardHead}>
              <Text style={styles.cardName}>{p.name}</Text>
              <View style={styles.priceTag}>
                <Text style={styles.priceVal}>₴{p.price}</Text>
                <Text style={styles.priceUnit}>/{p.durationDays === 1 ? '24ч' : `${p.durationDays}д`}</Text>
              </View>
            </View>
            <Text style={styles.cardBenefit}>{p.benefit}</Text>
            <Text style={styles.multTxt}>×{p.config.boostMultiplier} к позиции</Text>
            <TouchableOpacity
              testID={`package-buy-${p.code}`}
              onPress={() => buy(p)}
              disabled={purchasing === p.code}
              style={[styles.buyBtn, purchasing === p.code && { opacity: 0.6 }]}
            >
              {purchasing === p.code ? (
                <ActivityIndicator color={colors.onPrimary || colors.brandText} />
              ) : (
                <Text style={styles.buyTxt}>Активировать</Text>
              )}
            </TouchableOpacity>
          </View>
        ))}

        <TouchableOpacity
          style={styles.auctionFooter}
          onPress={() => router.replace('/provider-boost')}
          testID="packages-back-to-auction"
        >
          <Ionicons name="trophy" size={16} color={colors.primary} />
          <Text style={styles.auctionFooterTxt}>Перейти в аукцион — заработай больше</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  iconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: c.card },
  title: { fontSize: 17, fontWeight: '800', color: c.text },
  warningBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    margin: 16, padding: 12, borderRadius: 10,
    backgroundColor: c.brandSoft || 'rgba(245,184,0,0.10)',
  },
  warningTxt: { flex: 1, fontSize: 13, color: c.text, lineHeight: 18 },
  card: {
    backgroundColor: c.card, borderRadius: 16, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: c.border,
  },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  cardName: { fontSize: 17, fontWeight: '800', color: c.text, flex: 1 },
  priceTag: { alignItems: 'flex-end' },
  priceVal: { fontSize: 22, fontWeight: '900', color: c.text },
  priceUnit: { fontSize: 12, color: c.textMuted },
  cardBenefit: { fontSize: 13, color: c.textMuted, marginTop: 6 },
  multTxt: { fontSize: 13, fontWeight: '700', color: c.primary, marginTop: 8 },
  buyBtn: {
    marginTop: 12, paddingVertical: 12, borderRadius: 10,
    backgroundColor: c.primary, alignItems: 'center',
  },
  buyTxt: { color: c.onPrimary || colors.brandText, fontSize: 15, fontWeight: '800' },
  auctionFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, marginTop: 8,
    borderRadius: 12, borderWidth: 1, borderColor: c.primary,
    backgroundColor: c.brandSoft || 'rgba(245,184,0,0.10)',
  },
  auctionFooterTxt: { fontSize: 13, color: c.primary, fontWeight: '700' },
});

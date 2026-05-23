/**
 * Sprint 5 · Block 3 — Mobile packages screen with PayPal payment.
 * Shows 3 credit packs and a "Pay with PayPal" button per pack.
 * Flow: tap → POST /create-order → open approveUrl → return page captures.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const API = (Constants.expoConfig as any)?.extra?.apiUrl
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || 'http://localhost:8001';

interface PackageItem {
  id: string;
  title: string;
  credits: number;
  price: number;
  currency: string;
  savings: number;
  badge: string | null;
}

export default function PackagesScreen() {
  const router = useRouter();
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<string | null>(null);
  const [balance, setBalance] = useState<{ balance: number; available: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [pkgRes, balRes] = await Promise.all([
        fetch(`${API}/api/packages`).then((r) => r.json()),
        (async () => {
          const t = await AsyncStorage.getItem('auth_token');
          if (!t) return null;
          const r = await fetch(`${API}/api/customer/credits`, { headers: { Authorization: `Bearer ${t}` } });
          return r.ok ? r.json() : null;
        })(),
      ]);
      setPackages(Array.isArray(pkgRes) ? pkgRes : []);
      if (balRes) setBalance({ balance: balRes.balance, available: balRes.available });
    } catch (e) {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const buyWithPayPal = async (pkg: PackageItem) => {
    setCreating(pkg.id);
    try {
      const token = await AsyncStorage.getItem('auth_token');
      if (!token) { router.push('/login'); return; }
      const origin = API.replace(/\/$/, '');
      const res = await fetch(`${API}/api/payments/paypal/create-order`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ packageId: pkg.id, origin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);

      // Demo / mock branch — auto-capture without leaving the app
      if (data.mock) {
        const cap = await fetch(`${API}/api/payments/paypal/capture-order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: data.orderId, paymentId: data.paymentId }),
        });
        const capData = await cap.json();
        if (!cap.ok) throw new Error(capData?.message || 'Capture failed');
        Alert.alert(
          'Payment captured (DEMO)',
          `+${capData.credits} credits added. Sandbox key not configured — order auto-approved.`,
          [{ text: 'OK', onPress: load }],
        );
        return;
      }

      // Real PayPal: open approveUrl in browser/system, user returns via /packages/paypal-return
      const supported = await Linking.canOpenURL(data.approveUrl);
      if (!supported) {
        Alert.alert('Cannot open PayPal', 'Browser is not available.');
        return;
      }
      await Linking.openURL(data.approveUrl);
      Alert.alert(
        'Complete payment',
        'Approve the payment in PayPal, then return to the app. We will finalize the credits.',
        [{ text: 'OK' }],
      );
    } catch (e: any) {
      Alert.alert('PayPal error', e?.message || 'unknown');
    } finally {
      setCreating(null);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}><ActivityIndicator style={{ marginTop: 100 }} color="#FFB020" /></SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} testID="packages-screen">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="packages-back">
          <Ionicons name="chevron-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Buy credits</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.kicker}>/ INSPECTION CREDITS /</Text>
        <Text style={styles.title}>Pre-pay & save</Text>
        <Text style={styles.subtitle}>1 credit = 1 inspection. Use any time, in any city.</Text>

        {balance && (
          <View style={styles.balanceCard}>
            <Text style={styles.balanceLabel}>YOUR BALANCE</Text>
            <Text style={styles.balanceValue}>{balance.available}</Text>
            <Text style={styles.balanceSub}>{balance.balance} total · {balance.balance - balance.available} reserved</Text>
          </View>
        )}

        {packages.map((pkg) => (
          <View key={pkg.id} style={[styles.pkgCard, pkg.badge && styles.pkgCardHighlight]} testID={`pkg-${pkg.id}`}>
            {pkg.badge && (
              <View style={styles.badgeRow}><Text style={styles.badge}>{pkg.badge}</Text></View>
            )}
            <Text style={styles.pkgTitle}>{pkg.title}</Text>
            <View style={styles.pkgPriceRow}>
              <Text style={styles.pkgPrice}>€{pkg.price}</Text>
              <Text style={styles.pkgCredits}>{pkg.credits} credit{pkg.credits === 1 ? '' : 's'}</Text>
            </View>
            {pkg.savings > 0 && (
              <Text style={styles.pkgSavings}>Save €{pkg.savings} vs single</Text>
            )}
            <TouchableOpacity
              style={[styles.payBtn, creating === pkg.id && { opacity: 0.6 }]}
              onPress={() => buyWithPayPal(pkg)}
              disabled={creating !== null}
              testID={`pkg-paypal-${pkg.id}`}
            >
              {creating === pkg.id ? <ActivityIndicator color="#003087" /> : (
                <>
                  <Ionicons name="logo-paypal" size={16} color="#003087" />
                  <Text style={styles.payBtnText}>Pay with PayPal</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ))}

        <Text style={styles.disclaimer}>
          Demo mode: PayPal sandbox credentials are placeholder. Order auto-completes for testing.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderBottomWidth: 1, borderBottomColor: '#2E2E2E' },
  headerTitle: { fontSize: 17, fontWeight: '800', color: '#FFF', letterSpacing: 1, textTransform: 'uppercase' },
  body: { padding: 18, paddingBottom: 60 },
  kicker: { fontSize: 11, fontWeight: '800', color: '#FFB020', letterSpacing: 2 },
  title: { fontSize: 32, fontWeight: '900', color: '#FFF', marginTop: 6 },
  subtitle: { fontSize: 13, color: '#A1A1AA', marginTop: 6, marginBottom: 24 },
  balanceCard: { borderWidth: 1, borderColor: '#FFB020', borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 16, backgroundColor: '#0d0d0d', marginBottom: 24, alignItems: 'center' },
  balanceLabel: { fontSize: 10, fontWeight: '700', color: '#FFB020', letterSpacing: 2 },
  balanceValue: { fontSize: 48, fontWeight: '900', color: '#FFF', marginTop: 4 },
  balanceSub: { fontSize: 11, color: '#A1A1AA' },
  pkgCard: { borderWidth: 1, borderColor: '#2E2E2E', borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 18, backgroundColor: '#0d0d0d', marginBottom: 12 },
  pkgCardHighlight: { borderColor: '#FFB020' },
  badgeRow: { marginBottom: 8 },
  badge: { alignSelf: 'flex-start', fontSize: 10, fontWeight: '900', color: '#000', backgroundColor: '#FFB020', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 3, letterSpacing: 1 },
  pkgTitle: { fontSize: 17, fontWeight: '800', color: '#FFF' },
  pkgPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 12, marginTop: 8 },
  pkgPrice: { fontSize: 28, fontWeight: '900', color: '#FFB020' },
  pkgCredits: { fontSize: 13, color: '#A1A1AA', fontWeight: '600' },
  pkgSavings: { fontSize: 11, color: '#22C55E', fontWeight: '700', marginTop: 4 },
  payBtn: { marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#FFC439', paddingVertical: 14, borderRadius: 6 },
  payBtnText: { fontSize: 14, fontWeight: '900', color: '#003087', letterSpacing: 0.5 },
  disclaimer: { marginTop: 24, fontSize: 11, color: '#5A5A5A', textAlign: 'center', fontStyle: 'italic' },
});

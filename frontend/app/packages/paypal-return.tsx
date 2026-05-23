/**
 * Sprint 5 · Block 3 — PayPal return page.
 * After approving in PayPal, user lands here with ?paymentId=...&token=ORDER_ID.
 * We auto-call /capture-order. (Mock orders also land here.)
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';

const API = (Constants.expoConfig as any)?.extra?.apiUrl
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || 'http://localhost:8001';

export default function PayPalReturn() {
  const router = useRouter();
  const params = useLocalSearchParams<{ paymentId?: string; token?: string }>();
  const [state, setState] = useState<'capturing' | 'paid' | 'error'>('capturing');
  const [credits, setCredits] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string>('');

  useEffect(() => {
    (async () => {
      const paymentId = String(params.paymentId || '');
      const orderId = String(params.token || '');
      if (!paymentId || !orderId) {
        setState('error');
        setErrorMsg('Missing paymentId or order token in return URL');
        return;
      }
      try {
        const res = await fetch(`${API}/api/payments/paypal/capture-order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentId, orderId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
        setCredits(Number(data.credits || 0));
        setState('paid');
      } catch (e: any) {
        setErrorMsg(e?.message || 'unknown');
        setState('error');
      }
    })();
  }, [params.paymentId, params.token]);

  return (
    <SafeAreaView style={styles.safe} testID="paypal-return">
      <View style={styles.body}>
        {state === 'capturing' && (
          <>
            <ActivityIndicator color="#FFB020" size="large" />
            <Text style={styles.heading}>Finalizing payment…</Text>
            <Text style={styles.sub}>Please wait — capturing your PayPal order.</Text>
          </>
        )}
        {state === 'paid' && (
          <>
            <Ionicons name="checkmark-circle" size={64} color="#22C55E" />
            <Text style={styles.heading}>Payment received ✓</Text>
            <Text style={styles.sub}>+{credits} credits added to your account.</Text>
            <TouchableOpacity style={styles.btn} onPress={() => router.replace('/packages')}>
              <Text style={styles.btnText}>Back to packages</Text>
            </TouchableOpacity>
          </>
        )}
        {state === 'error' && (
          <>
            <Ionicons name="close-circle" size={64} color="#EF4444" />
            <Text style={styles.heading}>Capture failed</Text>
            <Text style={styles.sub}>{errorMsg}</Text>
            <TouchableOpacity style={styles.btn} onPress={() => router.replace('/packages')}>
              <Text style={styles.btnText}>Try again</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#000' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  heading: { fontSize: 22, fontWeight: '900', color: '#FFF', marginTop: 18, textAlign: 'center' },
  sub: { fontSize: 14, color: '#A1A1AA', textAlign: 'center', maxWidth: 320 },
  btn: { marginTop: 24, paddingVertical: 14, paddingHorizontal: 32, backgroundColor: '#FFB020', borderRadius: 8 },
  btnText: { fontSize: 14, fontWeight: '900', color: '#000', letterSpacing: 1, textTransform: 'uppercase' },
});

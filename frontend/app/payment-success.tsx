// Phase 3.0b P0-1 — Inline payment confirmation screen.
// Polls /api/payments/auto-request/status/{session_id} until paid → routes to
// /auto-request/[id] with the freshly created request, OR shows error/cancel UI.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../src/context/ThemeContext';
import { api } from '../src/services/api';
import { getSnapshotTransaction } from '../src/services/snapshotPayments';
import i18n from '../src/i18n';

const POLL_INTERVAL_MS = 2500;
const MAX_ATTEMPTS = 40; // ~100s budget

type Phase = 'polling' | 'paid' | 'failed' | 'cancelled' | 'timeout';

export default function PaymentSuccessScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const params = useLocalSearchParams<{
    session_id?: string;
    amount?: string;
    currency?: string;
    simulated?: string;
    requestId?: string;
  }>();
  const sessionId = (params.session_id as string | undefined) || '';
  const simulated = String(params.simulated || '') === '1';
  const directRequestId = (params.requestId as string | undefined) || '';

  const [phase, setPhase] = useState<Phase>('polling');
  const [errorText, setErrorText] = useState<string>('');
  const [requestId, setRequestId] = useState<string>('');
  const attemptsRef = useRef(0);
  const stoppedRef = useRef(false);

  const navigateToRequest = useCallback((id: string) => {
    router.replace({ pathname: '/auto-request/[id]', params: { id } } as any);
  }, [router]);

  const poll = useCallback(async () => {
    if (stoppedRef.current) return;

    // Legacy simulated/test path — landed with `?simulated=1&requestId=...`
    // (no Stripe session). Treat as already-paid so the user is taken
    // straight to the request, avoiding the false "no session id" failure.
    if (simulated && directRequestId) {
      stoppedRef.current = true;
      setRequestId(directRequestId);
      setPhase('paid');
      setTimeout(() => navigateToRequest(directRequestId), 800);
      return;
    }

    if (!sessionId) {
      // No session and no simulated context — likely a direct nav / refresh.
      // Treat as cancelled (no charge), with a friendly retry CTA back to
      // the request form. This avoids the misleading "Платёж не прошёл"
      // screen when no payment was ever attempted.
      stoppedRef.current = true;
      setPhase('cancelled');
      return;
    }
    attemptsRef.current += 1;

    try {
      // Payments-2A — try the snapshot-bound transaction first. This is
      // the canonical Payments-1 surface (read transaction by session_id,
      // snapshot copy lives inside `payment_transactions`). The legacy
      // /payments/auto-request/status flow (Phase 3.0b P0-1) stays as a
      // fallback for older sessions still in-flight.
      const snap = await getSnapshotTransaction(sessionId);
      if (snap) {
        if (snap.paid && snap.requestId) {
          stoppedRef.current = true;
          setRequestId(snap.requestId);
          setPhase('paid');
          setTimeout(() => navigateToRequest(snap.requestId), 1200);
          return;
        }
        if (snap.status === 'expired') {
          stoppedRef.current = true;
          setPhase('cancelled');
          return;
        }
        if (snap.status === 'failed') {
          stoppedRef.current = true;
          setPhase('failed');
          setErrorText(i18n.t('payment.error_generic') || 'Payment processing failed');
          return;
        }
        // Still initiated/unpaid — Stripe webhook (Payments-2B) hasn't
        // landed yet. Continue polling without falling back to legacy.
        if (attemptsRef.current >= MAX_ATTEMPTS) {
          stoppedRef.current = true;
          setPhase('timeout');
          return;
        }
        if (!stoppedRef.current) {
          setTimeout(poll, POLL_INTERVAL_MS);
        }
        return;
      }

      // No snapshot tx → legacy auto-request status (Phase 3.0b).
      const res = await api.get(`/payments/auto-request/status/${encodeURIComponent(sessionId)}`);
      const { paid, status, paymentStatus, request } = res.data || {};

      if (paid && request?.id) {
        stoppedRef.current = true;
        setRequestId(request.id);
        setPhase('paid');
        setTimeout(() => navigateToRequest(request.id), 1200);
        return;
      }

      if (status === 'expired') {
        stoppedRef.current = true;
        setPhase('cancelled');
        return;
      }

      if (status === 'error') {
        stoppedRef.current = true;
        setPhase('failed');
        setErrorText(i18n.t('payment.error_generic') || 'Payment processing failed');
        return;
      }

      if (attemptsRef.current >= MAX_ATTEMPTS) {
        stoppedRef.current = true;
        setPhase('timeout');
        return;
      }

      // Still pending → poll again
      if (!stoppedRef.current) {
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) {
        stoppedRef.current = true;
        setPhase('failed');
        setErrorText(i18n.t('payment.session_not_found') || 'Session not found');
        return;
      }
      // Transient — retry
      if (attemptsRef.current >= MAX_ATTEMPTS) {
        stoppedRef.current = true;
        setPhase('timeout');
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  }, [sessionId, simulated, directRequestId, navigateToRequest, t]);

  useEffect(() => {
    poll();
    return () => { stoppedRef.current = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderBody = () => {
    if (phase === 'polling') {
      return (
        <>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.title, { color: colors.text }]} testID="payment-polling-title">
            {t('payment.processing_title') || 'Processing payment…'}
          </Text>
          <Text style={[styles.sub, { color: colors.textSecondary }]}>
            {t('payment.processing_hint') || 'Please don’t close this screen. We are confirming your payment with Stripe.'}
          </Text>
        </>
      );
    }
    if (phase === 'paid') {
      return (
        <>
          <View style={[styles.iconBox, { backgroundColor: 'rgba(34,197,94,0.15)' }]}>
            <Ionicons name="checkmark-circle" size={56} color="#22C55E" />
          </View>
          <Text style={[styles.title, { color: colors.text }]} testID="payment-paid-title">
            {t('payment.paid_title') || 'Payment received'}
          </Text>
          <Text style={[styles.sub, { color: colors.textSecondary }]}>
            {t('payment.paid_hint') || 'Your inspection request is being created. Redirecting…'}
          </Text>
        </>
      );
    }
    if (phase === 'cancelled') {
      return (
        <>
          <View style={[styles.iconBox, { backgroundColor: 'rgba(245,158,11,0.15)' }]}>
            <Ionicons name="close-circle" size={56} color="#F59E0B" />
          </View>
          <Text style={[styles.title, { color: colors.text }]} testID="payment-cancelled-title">
            {t('payment.cancelled_title') || 'Payment cancelled'}
          </Text>
          <Text style={[styles.sub, { color: colors.textSecondary }]}>
            {t('payment.cancelled_hint') || 'No charge was made. You can try again any time.'}
          </Text>
          <TouchableOpacity
            testID="payment-back-form"
            style={[styles.btn, { backgroundColor: colors.primary }]}
            onPress={() => router.replace('/auto-request/choose' as any)}
          >
            <Text style={styles.btnText}>{t('payment.try_again') || 'Try again'}</Text>
          </TouchableOpacity>
        </>
      );
    }
    if (phase === 'timeout') {
      return (
        <>
          <View style={[styles.iconBox, { backgroundColor: 'rgba(245,158,11,0.15)' }]}>
            <Ionicons name="time-outline" size={56} color="#F59E0B" />
          </View>
          <Text style={[styles.title, { color: colors.text }]} testID="payment-timeout-title">
            {t('payment.timeout_title') || 'Still processing'}
          </Text>
          <Text style={[styles.sub, { color: colors.textSecondary }]}>
            {t('payment.timeout_hint') || 'Confirmation is taking longer than expected. We will email you once it is finalised.'}
          </Text>
          <TouchableOpacity
            testID="payment-retry"
            style={[styles.btn, { backgroundColor: colors.primary }]}
            onPress={() => { stoppedRef.current = false; attemptsRef.current = 0; setPhase('polling'); poll(); }}
          >
            <Text style={styles.btnText}>{t('payment.check_again') || 'Check again'}</Text>
          </TouchableOpacity>
        </>
      );
    }
    return (
      <>
        <View style={[styles.iconBox, { backgroundColor: 'rgba(239,68,68,0.15)' }]}>
          <Ionicons name="alert-circle" size={56} color="#EF4444" />
        </View>
        <Text style={[styles.title, { color: colors.text }]} testID="payment-failed-title">
          {t('payment.failed_title') || 'Payment failed'}
        </Text>
        <Text style={[styles.sub, { color: colors.textSecondary }]}>
          {errorText || t('payment.failed_hint') || 'Something went wrong. Please try again.'}
        </Text>
        <TouchableOpacity
          testID="payment-back-form"
          style={[styles.btn, { backgroundColor: colors.primary }]}
          onPress={() => router.replace('/auto-request/choose' as any)}
        >
          <Text style={styles.btnText}>{t('payment.try_again') || 'Try again'}</Text>
        </TouchableOpacity>
      </>
    );
  };

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top', 'bottom']} testID="payment-success-screen">
      <ScrollView contentContainerStyle={styles.body}>
        {renderBody()}
        {!!sessionId && (
          <Text style={[styles.session, { color: colors.textSecondary }]} testID="payment-session-id">
            {t('payment.session_label') || 'Session'}: {sessionId.slice(0, 14)}…
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 18 },
  iconBox: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 8,
  },
  title: { fontSize: 22, fontWeight: '800', textAlign: 'center', maxWidth: 320 },
  sub: { fontSize: 15, textAlign: 'center', lineHeight: 22, maxWidth: 360 },
  btn: { marginTop: 20, paddingVertical: 14, paddingHorizontal: 26, borderRadius: 14 },
  btnText: { color: '#FFF', fontSize: 16, fontWeight: '800' },
  session: { fontSize: 11, marginTop: 32, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' as any },
});

/**
 * Sprint 33 C8.1 — ReactivationBanner
 *
 * Subscribes to `provider:reactivation` realtime events (fired by the
 * Reactivation Engine sweep loop) and shows an inline FOMO banner with
 * "Включить онлайн" CTA that toggles the provider status back online.
 *
 * Auto-dismisses after 30s; vibrates once on appearance (mobile).
 * Banner hides automatically once provider goes online.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Vibration,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRealtime } from '../hooks/useWebSocket';
import { useThemeContext } from '../context/ThemeContext';
import { providerStatusAPI } from '../services/api';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

type ReactivationPayload = {
  providerSlug: string;
  cluster: string;
  zone?: string;
  missedRequests: number;
  potentialRevenue: number;
  currencySymbol?: string;
  ctaRoute?: string;
  cta?: string;
  target?: { providerSlug?: string };
};

export default function ReactivationBanner({
  providerSlug,
  onWentOnline,
}: {
  providerSlug: string;
  onWentOnline?: () => void;
}) {
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const { on } = useRealtime({ autoConnect: true });
  const [current, setCurrent] = useState<ReactivationPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const fade = useState(new Animated.Value(0))[0];

  const dismiss = useCallback(() => {
    Animated.timing(fade, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => setCurrent(null));
  }, [fade]);

  useEffect(() => {
    const unsub = on('provider:reactivation', (data: ReactivationPayload) => {
      const slug = data?.target?.providerSlug || data?.providerSlug;
      if (!slug || slug !== providerSlug) return;
      setCurrent(data);
      Animated.timing(fade, {
        toValue: 1,
        duration: 240,
        useNativeDriver: true,
      }).start();
      if (Platform.OS !== 'web') Vibration.vibrate(220);
    });
    return () => {
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, providerSlug]);

  // Auto-dismiss after 30s when banner becomes visible
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => dismiss(), 30000);
    return () => clearTimeout(t);
  }, [current, dismiss]);

  const goOnline = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    try {
      await providerStatusAPI.set(providerSlug, true);
      onWentOnline?.();
      dismiss();
    } catch (e) {
      // keep banner visible on failure so user can retry
      // eslint-disable-next-line no-console
      console.log('[Reactivation] go online failed:', e);
    } finally {
      setLoading(false);
    }
  }, [providerSlug, loading, dismiss, onWentOnline]);

  if (!current) return null;
  const sym = current.currencySymbol || '₴';
  const missed = Math.max(0, Number(current.missedRequests) || 0);
  const revenue = Math.max(0, Math.round(Number(current.potentialRevenue) || 0));

  return (
    <Animated.View
      testID="reactivation-banner"
      style={[
        styles.wrap,
        {
          opacity: fade,
          transform: [
            {
              translateY: fade.interpolate({
                inputRange: [0, 1],
                outputRange: [-20, 0],
              }),
            },
          ],
        },
      ]}
    >
      <View style={styles.iconCircle}>
        <Ionicons name="cash" size={20} color="#fff" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title} testID="reactivation-banner-title">
          🔥 Ты теряешь деньги
        </Text>
        <Text style={styles.sub} testID="reactivation-banner-sub">
          {missed > 0 ? `Пока вы офлайн: ${missed} заявок` : 'Пока вы офлайн'}
          {revenue > 0 ? ` · ~${sym}${revenue.toLocaleString('ru-RU')}` : ''}
          . Вернись онлайн и забери поток.
        </Text>
        <TouchableOpacity
          testID="reactivation-banner-cta"
          onPress={goOnline}
          disabled={loading}
          activeOpacity={0.85}
          style={[styles.cta, loading && { opacity: 0.7 }]}
        >
          {loading ? (
            <ActivityIndicator size="small" color={colors.brandText} />
          ) : (
            <>
              <Ionicons name="flash" size={14} color={colors.brandText} />
              <Text style={styles.ctaText}>Включить онлайн</Text>
              <Ionicons name="arrow-forward" size={14} color={colors.brandText} />
            </>
          )}
        </TouchableOpacity>
      </View>
      <TouchableOpacity
        onPress={dismiss}
        style={styles.close}
        testID="reactivation-banner-close"
      >
        <Ionicons name="close" size={18} color="#fff" />
      </TouchableOpacity>
    </Animated.View>
  );
}

const makeStyles = (c: any) =>
  StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
      backgroundColor: 'rgba(234,88,12,0.95)', // burning orange — money/FOMO
      marginHorizontal: 0,
      marginTop: 8,
      marginBottom: 8,
      padding: 12,
      borderRadius: 14,
      shadowColor: '#000',
      shadowOpacity: 0.28,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    iconCircle: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: 'rgba(255,255,255,0.22)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { color: '#fff', fontSize: 14, fontWeight: '900' },
    sub: { color: colors.warningBg, fontSize: 12, marginTop: 3, lineHeight: 17 },
    cta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      marginTop: 10,
      paddingHorizontal: 12,
      paddingVertical: 7,
      backgroundColor: c.primary,
      borderRadius: 9,
    },
    ctaText: { color: colors.brandText, fontSize: 13, fontWeight: '800' },
    close: { padding: 4 },
  });

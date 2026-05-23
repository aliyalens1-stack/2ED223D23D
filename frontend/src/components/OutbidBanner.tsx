/**
 * Sprint 31 → Sprint 33 C8.3 — OutbidBanner (Escalation tiers)
 *
 * Subscribes to `auction:outbid` realtime events fired by the auction
 * engine whenever a provider gets pushed down in a zone. Severity is
 * decided server-side and passed via payload.severity:
 *
 *   soft     (yellow) — "Вас обогнали" · rank 1→2
 *   pressure (orange) — "⚠️ Вы теряете €X/день" · rank≥3 OR loss>200
 *   critical (red)    — "🚨 Вы вне топ-3 · доход = 0"
 *
 * CTA uses `payload.suggestedBid` (computed on backend = topBid+1, floored)
 * and deep-links to /provider-boost where the new bid can be submitted.
 *
 * Haptics:
 *   soft     → selection tick
 *   pressure → medium impact
 *   critical → error notification
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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useRealtime } from '../hooks/useWebSocket';
import { useThemeContext } from '../context/ThemeContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

type Severity = 'soft' | 'pressure' | 'critical';

type OutbidPayload = {
  providerSlug: string;
  zone: string;
  zoneName: string;
  newTopBid: number;
  yourBid: number;
  rank: number;
  prevRank?: number;
  severity?: Severity;
  estimatedDailyLoss?: number;
  suggestedBid?: number;
  currencySymbol?: string;
  pushTitle?: string;
  pushBody?: string;
  target?: { providerSlug?: string };
};

// ── Severity style map (single source of truth for copy + palette) ──
type TierStyle = {
  bg: string;
  border: string;
  subColor: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconCircleBg: string;
};
const TIER: Record<Severity, TierStyle> = {
  soft: {
    bg: 'rgba(234,179,8,0.96)',          // yellow — informational
    border: 'rgba(161,98,7,0.6)',
    subColor: colors.warningBg,
    icon: 'notifications',
    iconCircleBg: 'rgba(255,255,255,0.22)',
  },
  pressure: {
    bg: 'rgba(234,88,12,0.96)',          // orange — $ pain
    border: 'rgba(154,52,18,0.6)',
    subColor: colors.warningBg,
    icon: 'warning',
    iconCircleBg: 'rgba(255,255,255,0.22)',
  },
  critical: {
    bg: 'rgba(220,38,38,0.98)',          // red — zero income
    border: 'rgba(153,27,27,0.7)',
    subColor: colors.brandSoft,
    icon: 'alert',
    iconCircleBg: 'rgba(0,0,0,0.22)',
  },
};

function fireHaptic(sev: Severity) {
  try {
    if (sev === 'critical') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else if (sev === 'pressure') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } else {
      Haptics.selectionAsync();
    }
  } catch {
    /* haptics unavailable on web / unsupported device */
  }
}

export default function OutbidBanner({ providerSlug }: { providerSlug: string }) {
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { on } = useRealtime({ autoConnect: true });
  const [current, setCurrent] = useState<OutbidPayload | null>(null);
  const fade = useState(new Animated.Value(0))[0];

  const dismiss = useCallback(() => {
    Animated.timing(fade, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => setCurrent(null));
  }, [fade]);

  useEffect(() => {
    const unsub = on('auction:outbid', (data: OutbidPayload) => {
      const slug = data?.target?.providerSlug || data?.providerSlug;
      if (!slug || slug !== providerSlug) return;
      setCurrent(data);
      Animated.timing(fade, { toValue: 1, duration: 240, useNativeDriver: true }).start();
      const sev: Severity = (data?.severity as Severity) || 'soft';
      if (Platform.OS !== 'web') {
        fireHaptic(sev);
        Vibration.vibrate(sev === 'critical' ? 350 : sev === 'pressure' ? 220 : 120);
      }
    });
    return () => {
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, providerSlug]);

  // Auto-dismiss: soft=20s, pressure=30s, critical=45s
  useEffect(() => {
    if (!current) return;
    const sev: Severity = (current?.severity as Severity) || 'soft';
    const ms = sev === 'critical' ? 45000 : sev === 'pressure' ? 30000 : 20000;
    const t = setTimeout(() => dismiss(), ms);
    return () => clearTimeout(t);
  }, [current, dismiss]);

  if (!current) return null;
  const sev: Severity = (current?.severity as Severity) || 'soft';
  const tier = TIER[sev];
  const sym = current.currencySymbol || '₴';
  const top = Math.round(current.newTopBid || 0);
  const mine = Math.round(current.yourBid || 0);
  const rank = Math.max(1, Math.round(current.rank || 0));
  const suggested =
    Math.max(
      Math.round(current.suggestedBid || 0),
      mine + 1,
      top + 1,
    ) || mine + 1;
  const estLoss = Math.max(0, Math.round(current.estimatedDailyLoss || 0));

  // Copy by severity
  let title: string;
  let sub: string;
  if (sev === 'critical') {
    title = '🚨 Вы вне топ-3';
    sub = `${current.zoneName || current.zone} · доход остановлен. Перебейте до ${sym}${suggested}.`;
  } else if (sev === 'pressure') {
    title = '⚠️ Вы теряете деньги';
    const lossPart = estLoss > 0 ? `~${sym}${estLoss.toLocaleString('ru-RU')}/день` : `#${rank}`;
    sub = `${current.zoneName || current.zone} · позиция #${rank} · ${lossPart}.`;
  } else {
    title = `Вас обогнали в ${current.zoneName || current.zone}`;
    sub = `Вы теперь #${rank} · Лидер: ${sym}${top} · Ваша: ${sym}${mine}.`;
  }

  return (
    <Animated.View
      testID="outbid-banner"
      style={[
        styles.wrap,
        {
          backgroundColor: tier.bg,
          borderColor: tier.border,
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
      <View style={[styles.iconCircle, { backgroundColor: tier.iconCircleBg }]}>
        <Ionicons name={tier.icon} size={20} color="#fff" />
      </View>

      <View style={{ flex: 1 }}>
        <Text style={styles.title} testID={`outbid-banner-title-${sev}`}>
          {title}
        </Text>
        <Text style={[styles.sub, { color: tier.subColor }]} testID="outbid-banner-sub">
          {sub}
        </Text>

        <TouchableOpacity
          testID="outbid-banner-cta"
          activeOpacity={0.85}
          onPress={() => {
            dismiss();
            router.push({
              pathname: '/provider-boost',
              params: {
                zone: current.zone,
                suggestedBid: String(suggested),
              },
            });
          }}
          style={styles.cta}
        >
          <Ionicons name="flash" size={14} color={colors.brandText} />
          <Text style={styles.ctaText}>
            Перебить до {sym}{suggested}
          </Text>
          <Ionicons name="arrow-forward" size={14} color={colors.brandText} />
        </TouchableOpacity>
      </View>

      <TouchableOpacity onPress={dismiss} style={styles.close} testID="outbid-banner-close">
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
      marginHorizontal: 0,
      marginTop: 8,
      marginBottom: 8,
      padding: 12,
      borderRadius: 14,
      borderWidth: 1,
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    iconCircle: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { color: '#fff', fontSize: 14, fontWeight: '900', letterSpacing: -0.1 },
    sub: { fontSize: 12, marginTop: 3, lineHeight: 17 },
    cta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      marginTop: 10,
      paddingHorizontal: 12,
      paddingVertical: 7,
      backgroundColor: c.brand || c.primary,
      borderRadius: 9,
    },
    ctaText: { color: c.brandText || colors.brandText, fontSize: 13, fontWeight: '800' },
    close: { padding: 4 },
  });

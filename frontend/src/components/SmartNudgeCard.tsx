/**
 * Sprint 33 C8.2 — SmartNudgeCard
 *
 * "Where should I earn right now?" card. Fetches `/api/provider/nudges`
 * for the active provider, shows the top (zone, cluster) cell with copy
 * tuned by `reason` (high_demand / low_competition / mixed / balanced).
 * Also auto-upgrades on realtime `provider:smart_nudge` push events.
 *
 * Rendered ABOVE the outbid/reactivation banners in ProviderActionHub —
 * so it becomes the money-primary surface of the provider screen.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import axios from 'axios';
import { useRealtime } from '../hooks/useWebSocket';
import { useThemeContext } from '../context/ThemeContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

const API = process.env.EXPO_PUBLIC_BACKEND_URL || '';

type Reason = 'high_demand_low_competition' | 'high_demand' | 'low_competition' | 'balanced';

type NudgePayload = {
  zone: string;
  zoneName: string;
  cluster: string;
  clusterName: string;
  currencySymbol?: string;
  score: number;
  expectedRevenue: number;
  revenueLo: number;
  revenueHi: number;
  revenueHint: string;
  competition: 'low' | 'medium' | 'high';
  reason: Reason;
  ctaRoute: string;
  components?: {
    demandRatio?: number;
    bidders?: number;
    alreadyActive?: boolean;
  };
  title?: string;
  body?: string;
  lead?: string;
};

const REASON_COPY: Record<Reason, { lead: string; hint: string; accent: string }> = {
  high_demand_low_competition: {
    lead:   '🔥 Лёгкие деньги прямо сейчас',
    hint:   'Высокий спрос · низкая конкуренция',
    accent: colors.success, // green — easy money
  },
  high_demand: {
    lead:   '🔥 Высокий спрос',
    hint:   'Поток заявок выше обычного',
    accent: colors.warning, // orange — busy
  },
  low_competition: {
    lead:   '😏 Почти никого нет',
    hint:   'Низкая конкуренция — лёгкий вход',
    accent: colors.brand, // blue — opportunity
  },
  balanced: {
    lead:   '💡 Где сейчас зарабатывать',
    hint:   'Сбалансированный спрос',
    accent: colors.brand, // purple — neutral
  },
};

export default function SmartNudgeCard({ providerSlug }: { providerSlug: string }) {
  const { colors } = useThemeContext();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { on } = useRealtime({ autoConnect: true });

  const [data, setData] = useState<NudgePayload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!providerSlug) {
      setLoading(false);
      return;
    }
    try {
      const { data: res } = await axios.get(
        `${API}/api/provider/nudges`,
        { params: { providerSlug, limit: 1 }, timeout: 6000 }
      );
      setData(res?.best || null);
    } catch (e) {
      // silent — card just disappears on failure
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [providerSlug]);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime: when a fresh nudge push arrives, hot-swap the card content
  useEffect(() => {
    const unsub = on('provider:smart_nudge', (payload: any) => {
      const slug = payload?.target?.providerSlug || payload?.providerSlug;
      if (!slug || slug !== providerSlug) return;
      const mapped: NudgePayload = {
        zone: payload.zone,
        zoneName: payload.zoneName,
        cluster: payload.cluster,
        clusterName: payload.clusterName,
        currencySymbol: payload.currencySymbol,
        score: payload.score,
        expectedRevenue: payload.expectedRevenue,
        revenueLo: payload.revenueLo,
        revenueHi: payload.revenueHi,
        revenueHint: payload.revenueHint,
        competition: payload.competition,
        reason: payload.reason,
        ctaRoute: payload.ctaRoute,
        lead: payload.lead,
        title: payload.pushTitle,
        body: payload.pushBody,
      };
      setData(mapped);
    });
    return () => { unsub?.(); };
  }, [on, providerSlug]);

  if (loading) {
    return (
      <View style={[styles.wrap, styles.loadingWrap]} testID="smart-nudge-card-loading">
        <ActivityIndicator size="small" color={colors.brand || colors.primary} />
      </View>
    );
  }
  if (!data) return null;

  const reason = (data.reason as Reason) || 'balanced';
  const copy = REASON_COPY[reason];
  const sym = data.currencySymbol || '₴';

  const onGo = () => {
    // Route includes cluster + zone so provider-boost pre-fills the form
    const route = data.ctaRoute || `/provider-boost?cluster=${data.cluster}&zone=${data.zone}`;
    router.push(route as any);
  };

  const competitionLabel =
    data.competition === 'low' ? 'низкая конкуренция' :
    data.competition === 'high' ? 'высокая конкуренция' : 'средняя конкуренция';

  return (
    <View style={styles.wrap} testID="smart-nudge-card">
      {/* header strip */}
      <View style={styles.headerRow}>
        <View style={[styles.dot, { backgroundColor: copy.accent }]} />
        <Text style={[styles.lead, { color: copy.accent }]} testID="smart-nudge-lead">
          {copy.lead}
        </Text>
      </View>

      {/* main title line: cluster · zone */}
      <Text style={styles.title} numberOfLines={2} testID="smart-nudge-title">
        🎯 {prettyCluster(data.clusterName || data.cluster)} · {data.zoneName}
      </Text>

      {/* revenue potential */}
      <View style={styles.revenueRow}>
        <Ionicons name="cash-outline" size={15} color={colors.brand || colors.brand} />
        <Text style={styles.revenue} testID="smart-nudge-revenue">
          Потенциал: {data.revenueHint || `${sym}${data.revenueLo}–${sym}${data.revenueHi} сегодня`}
        </Text>
      </View>

      {/* meta: demand + competition */}
      <View style={styles.metaRow}>
        <View style={styles.metaPill}>
          <Ionicons name="trending-up" size={12} color={copy.accent} />
          <Text style={[styles.metaText, { color: colors.text }]}>
            ×{(data.components?.demandRatio || 1).toFixed(1)} спрос
          </Text>
        </View>
        <View style={styles.metaPill}>
          <Ionicons name="people-outline" size={12} color={colors.textMuted || colors.textSecondary} />
          <Text style={[styles.metaText, { color: colors.textMuted || colors.textSecondary }]}>
            {data.components?.bidders ?? 0} конкурентов · {competitionLabel}
          </Text>
        </View>
        {data.components?.alreadyActive ? (
          <View style={styles.metaPill}>
            <Ionicons name="checkmark-circle" size={12} color={colors.success} />
            <Text style={[styles.metaText, { color: colors.success }]}>Вы уже здесь</Text>
          </View>
        ) : null}
      </View>

      {/* CTA */}
      <TouchableOpacity
        activeOpacity={0.88}
        onPress={onGo}
        style={styles.cta}
        testID="smart-nudge-cta"
      >
        <Ionicons name="flash" size={15} color={colors.brandText || colors.brandText} />
        <Text style={styles.ctaText}>Перейти и заработать</Text>
        <Ionicons name="arrow-forward" size={15} color={colors.brandText || colors.brandText} />
      </TouchableOpacity>
    </View>
  );
}

function prettyCluster(id: string): string {
  switch ((id || '').toLowerCase()) {
    case 'repair':     return 'Ремонт авто';
    case 'inspection': return 'Проверка перед покупкой';
    case 'selection':  return 'Подбор авто';
    case 'delivery':   return 'Пригон авто';
    default:           return id || 'Услуга';
  }
}

const makeStyles = (c: any) =>
  StyleSheet.create({
    wrap: {
      borderRadius: 18,
      padding: 14,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.card,
      ...Platform.select({
        ios: {
          shadowColor: '#000',
          shadowOpacity: 0.06,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
        },
        android: { elevation: 2 },
        default: {},
      }),
    },
    loadingWrap: {
      minHeight: 92,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 8,
    },
    dot: { width: 7, height: 7, borderRadius: 4 },
    lead: {
      fontSize: 11,
      fontWeight: '900',
      letterSpacing: 1.2,
      textTransform: 'uppercase',
    },
    title: {
      color: c.text,
      fontSize: 17,
      fontWeight: '900',
      letterSpacing: -0.3,
      lineHeight: 22,
      marginBottom: 8,
    },
    revenueRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 10,
    },
    revenue: {
      color: c.text,
      fontSize: 13,
      fontWeight: '700',
    },
    metaRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginBottom: 12,
    },
    metaPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 8,
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.border,
    },
    metaText: { fontSize: 11, fontWeight: '700' },
    cta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 12,
      borderRadius: 12,
      backgroundColor: c.brand || colors.brand,
    },
    ctaText: {
      color: c.brandText || colors.brandText,
      fontSize: 14,
      fontWeight: '900',
      letterSpacing: -0.2,
    },
  });

/**
 * Sprint 30 — Retention Hub (provider-facing)
 *
 * Shows three dopamine/FOMO cards in one pull:
 *   1. 💰 Earnings trend  — today vs yesterday + best-day badge
 *   2. 🎯 Daily goal      — progress bar + CTA to keep going
 *   3. 🔥 Missed revenue  — FOMO "you lost X while offline"
 *
 * Pulls /api/provider/retention/hub once (single round trip).
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import axios from 'axios';
import { useThemeContext } from '../context/ThemeContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

const API = process.env.EXPO_PUBLIC_BACKEND_URL || '';

type HubData = {
  missed: {
    missedRequests: number;
    potentialRevenue: number;
    avgTicket: number;
    zones: string[];
    windowDays: number;
    today: { missedRequests: number; potentialRevenue: number };
  };
  earnings: {
    today: number;
    yesterday: number;
    trend: string;
    trendPct: number | null;
    bestDay: boolean;
    week: { day: string; amount: number }[];
  };
  goal: {
    goalUAH: number;
    todayUAH: number;
    progressPct: number;
    remainingUAH: number;
    achieved: boolean;
  };
};

export default function ProviderRetentionHub({ providerSlug }: { providerSlug: string }) {
  const { colors } = useThemeContext();
  const router = useRouter();
  const styles = makeStyles(colors);
  const [data, setData] = useState<HubData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchHub = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/api/provider/retention/hub`, {
        params: { providerSlug },
      });
      setData(r.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [providerSlug]);

  useEffect(() => { fetchHub(); }, [fetchHub]);

  if (loading) {
    return (
      <View style={styles.loadingWrap} testID="retention-hub-loading">
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!data) return null;

  const e = data.earnings;
  const g = data.goal;
  const m = data.missed;
  const trendColor = e.trendPct === null ? colors.textMuted
    : (e.trendPct >= 0 ? colors.success : colors.brand);

  return (
    <View style={styles.wrap} testID="retention-hub">
      {/* 💰 Earnings card */}
      <View style={styles.card} testID="retention-earnings-card">
        <View style={styles.row}>
          <View style={[styles.iconCircle, { backgroundColor: 'rgba(34,197,94,0.15)' }]}>
            <Ionicons name="cash-outline" size={20} color={colors.success} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Сегодня</Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text style={styles.bigValue}>₴{e.today.toLocaleString('ru-RU')}</Text>
              <Text style={[styles.trend, { color: trendColor }]}>{e.trend !== '—' ? `↑ ${e.trend}` : '—'}</Text>
            </View>
            <Text style={styles.sub}>вчера: ₴{e.yesterday.toLocaleString('ru-RU')}</Text>
          </View>
          {e.bestDay && e.today > 0 && (
            <View style={styles.bestBadge} testID="retention-best-day-badge">
              <Text style={styles.bestBadgeText}>🔥 лучший день</Text>
            </View>
          )}
        </View>
      </View>

      {/* 🎯 Daily goal card */}
      <TouchableOpacity
        style={styles.card}
        testID="retention-goal-card"
        onPress={() => router.push('/provider-boost')}
        activeOpacity={0.85}
      >
        <View style={styles.row}>
          <View style={[styles.iconCircle, { backgroundColor: 'rgba(245,184,0,0.15)' }]}>
            <Ionicons name="flag-outline" size={20} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.rowBetween}>
              <Text style={styles.label}>Цель дня</Text>
              <Text style={styles.goalValue}>
                ₴{g.todayUAH} / ₴{g.goalUAH}
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View style={[
                styles.progressFill,
                { width: `${g.progressPct}%`, backgroundColor: g.achieved ? colors.success : colors.primary },
              ]} />
            </View>
            <Text style={styles.sub}>
              {g.achieved
                ? '🏆 Цель достигнута — держи темп!'
                : `Добить ещё ₴${g.remainingUAH}`}
            </Text>
          </View>
        </View>
      </TouchableOpacity>

      {/* 🔥 Missed FOMO card (only if missed > 0) */}
      {m.missedRequests > 0 && (
        <TouchableOpacity
          style={[styles.card, styles.fomoCard]}
          testID="retention-missed-card"
          onPress={() => router.push('/provider-boost')}
          activeOpacity={0.85}
        >
          <View style={styles.row}>
            <View style={[styles.iconCircle, { backgroundColor: 'rgba(239,68,68,0.18)' }]}>
              <Ionicons name="flame" size={20} color={colors.brand} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.label, { color: colors.brand }]}>
                Пока ты был офлайн
              </Text>
              <Text style={styles.fomoHeadline}>
                — {m.missedRequests} заявок в зонах {m.zones.length > 0 ? m.zones.length : 1}
              </Text>
              <Text style={styles.fomoHeadline}>
                — средний чек ₴{m.avgTicket || 0}
              </Text>
              <Text style={[styles.fomoHeadline, { fontWeight: '900', marginTop: 4 }]}>
                — потенциально ₴{m.potentialRevenue.toLocaleString('ru-RU')}
              </Text>
              <View style={styles.fomoCta} testID="retention-fomo-cta">
                <Text style={styles.fomoCtaText}>Включить и забрать поток</Text>
                <Ionicons name="arrow-forward" size={14} color={colors.brandText} />
              </View>
            </View>
          </View>
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (c: any) => StyleSheet.create({
  wrap: { gap: 10, marginVertical: 8 },
  loadingWrap: { padding: 20, alignItems: 'center' },
  card: {
    backgroundColor: c.card,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: c.border,
  },
  fomoCard: {
    backgroundColor: 'rgba(239,68,68,0.06)',
    borderColor: 'rgba(239,68,68,0.4)',
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  iconCircle: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },

  label: { color: c.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  bigValue: { color: c.text, fontSize: 24, fontWeight: '900' },
  trend: { fontSize: 13, fontWeight: '800' },
  sub: { color: c.textMuted, fontSize: 12, marginTop: 4 },

  bestBadge: {
    backgroundColor: 'rgba(245,184,0,0.2)',
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
    alignSelf: 'flex-start',
  },
  bestBadgeText: { color: c.primary, fontSize: 10, fontWeight: '800' },

  goalValue: { color: c.text, fontSize: 13, fontWeight: '700' },
  progressTrack: {
    height: 8, backgroundColor: c.border, borderRadius: 4,
    marginTop: 6, overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 4 },

  fomoHeadline: { color: c.text, fontSize: 13, marginTop: 3, lineHeight: 19 },
  fomoCta: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 12, alignSelf: 'flex-start',
    backgroundColor: c.primary,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
  },
  fomoCtaText: { color: colors.brandText, fontSize: 13, fontWeight: '800' },
});

/**
 * Sprint 33 C7.4 — Provider Money Dashboard
 *
 * Embedded into ProviderActionHub. Surfaces the money lens that turns the
 * marketplace from "tool that providers use" into "system that drives spend":
 *   1. "Где ты зарабатываешь" — today revenue per active cluster
 *   2. UPSALE — yellow card: "Вы теряете деньги, добавьте 🔍 Проверку"
 *   3. FOMO   — "Сегодня в этом рынке заработали €2,400"
 *   4. Daily Goal — earned vs target, nudge CTA toward zero-revenue cluster
 *   5. Deep-link CTA → /provider-boost?cluster=<id>
 *
 * Data source: GET /api/marketplace/active-markets/{slug} (extended in C7.4).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import axios from 'axios';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../context/ThemeContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

const API = process.env.EXPO_PUBLIC_BACKEND_URL || '';

type ActiveCard = {
  cluster: string;
  title: string;
  emoji?: string;
  currency?: string;
  currencySymbol?: string;
  todayRevenue: number;
  todayLeads: number;
  marketRevenueToday: number;
  marketLeadsToday: number;
  marketProvidersToday: number;
};

type Upsell = {
  cluster: string;
  title: string;
  emoji?: string;
  currency?: string;
  currencySymbol?: string;
  priceRange?: [number, number];
  hint?: string;
  marketRevenueToday: number;
  marketLeadsToday: number;
  marketProvidersToday: number;
  ctaRoute?: string;
};

type DailyGoal = {
  currency: string;
  currencySymbol: string;
  target: number;
  earned: number;
  remaining: number;
  percent: number;
  nudgeCluster?: string | null;
  nudgeCtaLabel?: string | null;
  nudgeCtaRoute?: string | null;
};

type Payload = {
  providerSlug: string;
  active: ActiveCard[];
  upsells: Upsell[];
  dailyGoal: DailyGoal;
};

const fmt = (n: number) => Number(n || 0).toLocaleString('ru-RU');

export default function ProviderMoneyDashboard({ providerSlug }: { providerSlug: string }) {
  const router = useRouter();
  const { colors, isDark } = useThemeContext();
  const styles = makeStyles(colors, isDark);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/api/marketplace/active-markets/${providerSlug}`);
      setData(r.data as Payload);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [providerSlug]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  if (loading) {
    return (
      <View style={styles.loadingBox} testID="money-dashboard-loading">
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!data) return null;

  const goal = data.dailyGoal;
  const goalPct = Math.max(0, Math.min(100, goal?.percent || 0));

  return (
    <View testID="provider-money-dashboard" style={{ marginTop: 14 }}>
      {/* ── Header ─────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>💰 Сегодня по рынкам</Text>

      {/* ── Active cluster rows ────────────────────────────── */}
      <View style={styles.activeBlock}>
        {data.active.map((c) => (
          <View
            key={c.cluster}
            testID={`money-row-${c.cluster}`}
            style={[styles.activeRow, c.todayRevenue === 0 && styles.activeRowZero]}
          >
            <Text style={styles.activeEmoji}>{c.emoji || '•'}</Text>
            <Text style={styles.activeTitle}>{c.title}</Text>
            <Text
              style={[
                styles.activeAmount,
                c.todayRevenue === 0 && styles.activeAmountZero,
              ]}
              testID={`money-amount-${c.cluster}`}
            >
              {c.currencySymbol}
              {fmt(c.todayRevenue)}
            </Text>
          </View>
        ))}
      </View>

      {/* ── Daily Goal (только если есть EUR/UAH трекинг) ────── */}
      {goal && goal.target > 0 && (
        <View style={styles.goalCard} testID="money-daily-goal">
          <View style={styles.goalHead}>
            <Text style={styles.goalTitle}>🎯 Цель дня</Text>
            <Text style={styles.goalAmount}>
              {goal.currencySymbol}
              {fmt(goal.earned)}{' '}
              <Text style={styles.goalAmountMuted}>
                / {goal.currencySymbol}
                {fmt(goal.target)}
              </Text>
            </Text>
          </View>
          <View style={styles.goalBarBg}>
            <View
              style={[styles.goalBarFill, { width: `${goalPct}%` }]}
              testID="money-goal-bar"
            />
          </View>
          <Text style={styles.goalRemain}>
            Осталось: {goal.currencySymbol}
            {fmt(goal.remaining)}
          </Text>
          {!!goal.nudgeCtaLabel && !!goal.nudgeCtaRoute && (
            <TouchableOpacity
              testID="money-goal-nudge-cta"
              onPress={() => router.push(goal.nudgeCtaRoute as any)}
              style={styles.goalNudgeBtn}
              activeOpacity={0.85}
            >
              <Text style={styles.goalNudgeText}>{goal.nudgeCtaLabel}</Text>
              <Ionicons name="arrow-forward" size={14} color={colors.onPrimary} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── UPSALE: missing clusters with FOMO ─────────────── */}
      {data.upsells.length > 0 && (
        <View style={{ marginTop: 12 }}>
          {data.upsells.map((u) => {
            const lo = u.priceRange?.[0] ?? 0;
            const hi = u.priceRange?.[1] ?? 0;
            const fomoActive = u.marketRevenueToday > 0;
            return (
              <View
                key={u.cluster}
                style={styles.upsellCard}
                testID={`money-upsell-${u.cluster}`}
              >
                <View style={styles.upsellHead}>
                  <Text style={styles.upsellEmoji}>{u.emoji || '🚀'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.upsellTitle}>Вы теряете деньги</Text>
                    <Text style={styles.upsellSub}>
                      Добавьте {u.title} → {u.currencySymbol}{lo}–{hi} за заявку
                    </Text>
                  </View>
                </View>

                {fomoActive && (
                  <View style={styles.fomoBox} testID={`money-fomo-${u.cluster}`}>
                    <Text style={styles.fomoLabel}>
                      Сегодня в этом рынке заработали:
                    </Text>
                    <Text style={styles.fomoAmount}>
                      {u.emoji} {u.title} → {u.currencySymbol}
                      {fmt(u.marketRevenueToday)}
                      {u.marketProvidersToday > 0
                        ? `  ·  ${u.marketProvidersToday} мастер${u.marketProvidersToday === 1 ? '' : (u.marketProvidersToday < 5 ? 'а' : 'ов')}`
                        : ''}
                    </Text>
                  </View>
                )}

                <TouchableOpacity
                  testID={`money-upsell-cta-${u.cluster}`}
                  onPress={() => router.push((u.ctaRoute || `/provider-boost?cluster=${u.cluster}`) as any)}
                  style={styles.upsellCta}
                  activeOpacity={0.85}
                >
                  <Text style={styles.upsellCtaText}>
                    Зарабатывать в {u.title}
                  </Text>
                  <Ionicons name="arrow-forward" size={16} color={colors.brandText} />
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const makeStyles = (c: any, dark: boolean) =>
  StyleSheet.create({
    loadingBox: { paddingVertical: 24, alignItems: 'center' },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '800',
      color: c.textSecondary,
      marginBottom: 10,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },

    // Active rows
    activeBlock: {
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      paddingVertical: 4,
    },
    activeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    activeRowZero: { opacity: 0.85 },
    activeEmoji: { fontSize: 20, marginRight: 12 },
    activeTitle: { flex: 1, fontSize: 14, fontWeight: '600', color: c.text },
    activeAmount: { fontSize: 16, fontWeight: '800', color: c.text },
    activeAmountZero: { color: c.textMuted },

    // Daily goal
    goalCard: {
      marginTop: 12,
      padding: 14,
      borderRadius: 14,
      backgroundColor: c.card,
      borderWidth: 1,
      borderColor: c.border,
    },
    goalHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    goalTitle: { fontSize: 14, fontWeight: '800', color: c.text },
    goalAmount: { fontSize: 14, fontWeight: '800', color: c.text },
    goalAmountMuted: { fontSize: 13, fontWeight: '600', color: c.textMuted },
    goalBarBg: {
      height: 8,
      borderRadius: 4,
      backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
      overflow: 'hidden',
    },
    goalBarFill: {
      height: '100%',
      backgroundColor: c.primary,
      borderRadius: 4,
    },
    goalRemain: { fontSize: 12, color: c.textMuted, marginTop: 8 },
    goalNudgeBtn: {
      marginTop: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: c.primary,
    },
    goalNudgeText: { fontSize: 13, fontWeight: '800', color: c.onPrimary || colors.brandText },

    // Upsell card (yellow / amber soft)
    upsellCard: {
      marginBottom: 10,
      padding: 14,
      borderRadius: 14,
      backgroundColor: dark ? 'rgba(255, 196, 0, 0.10)' : colors.warningBg,
      borderWidth: 1,
      borderColor: dark ? 'rgba(255, 196, 0, 0.30)' : colors.brand,
    },
    upsellHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    upsellEmoji: { fontSize: 22, marginTop: 1 },
    upsellTitle: { fontSize: 15, fontWeight: '800', color: c.text },
    upsellSub: { fontSize: 12, fontWeight: '600', color: c.textSecondary, marginTop: 2 },

    fomoBox: {
      marginTop: 10,
      padding: 10,
      borderRadius: 10,
      backgroundColor: dark ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.55)',
    },
    fomoLabel: { fontSize: 11, fontWeight: '600', color: c.textMuted, marginBottom: 2 },
    fomoAmount: { fontSize: 13, fontWeight: '800', color: c.text },

    upsellCta: {
      marginTop: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 11,
      borderRadius: 10,
      backgroundColor: c.primary,
    },
    upsellCtaText: { fontSize: 13, fontWeight: '800', color: c.onPrimary || colors.brandText },
  });

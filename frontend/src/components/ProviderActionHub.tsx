/**
 * Sprint 11 — Provider Action Hub (dark-theme rewrite)
 * Money cockpit: earnings, lost revenue, opportunities, performance.
 * Full theme integration — no hardcoded light cards.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { providerIntelligenceAPI } from '../services/api';
import { useThemeContext } from '../context/ThemeContext';
import ProviderRetentionHub from './ProviderRetentionHub';
import ProviderMoneyDashboard from './ProviderMoneyDashboard';
import OutbidBanner from './OutbidBanner';
import ReactivationBanner from './ReactivationBanner';
import SmartNudgeCard from './SmartNudgeCard';
import AutoMoneyCard from './AutoMoneyCard';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

type Props = { colors?: any; providerSlug?: string };

export default function ProviderActionHub({ colors: _colorsProp, providerSlug }: Props) {
  const router = useRouter();
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);

  const slug = providerSlug || 'avtomaster-pro';

  const [loading, setLoading] = useState(true);
  const [earnings, setEarnings] = useState<any>(null);
  const [lost, setLost] = useState<any>(null);
  const [opps, setOpps] = useState<any[]>([]);
  const [demand, setDemand] = useState<any>(null);
  const [perf, setPerf] = useState<any>(null);
  const [intel, setIntel] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [e, l, o, d, p, i] = await Promise.all([
        providerIntelligenceAPI.getEarnings().catch(() => ({ data: null })),
        providerIntelligenceAPI.getLostRevenue().catch(() => ({ data: null })),
        providerIntelligenceAPI.getOpportunities().catch(() => ({ data: { opportunities: [] } })),
        providerIntelligenceAPI.getDemand().catch(() => ({ data: null })),
        providerIntelligenceAPI.getPerformance().catch(() => ({ data: null })),
        providerIntelligenceAPI.getIntelligence().catch(() => ({ data: null })),
      ]);
      setEarnings(e.data);
      setLost(l.data);
      setOpps(((o.data as any)?.opportunities || (o.data as any)?.items || []).slice(0, 4));
      setDemand(d.data);
      setPerf(p.data);
      setIntel(i.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const today = earnings?.today?.total ?? earnings?.today ?? 0;
  const week = earnings?.week?.total ?? earnings?.week ?? 0;
  const month = earnings?.month?.total ?? earnings?.month ?? 0;
  const lostAmount = lost?.today?.lostRevenue ?? lost?.totalLost ?? lost?.lostRevenue ?? lost?.amount ?? 0;
  const missedJobs = lost?.today?.missed ?? lost?.missedJobs ?? lost?.missedBookings ?? 0;
  const tier = intel?.tier || perf?.tier || 'Bronze';
  const score = perf?.score ?? intel?.score ?? 0;
  const topZone = demand?.topZone || demand?.zones?.[0];

  if (loading && !earnings && !lost) {
    return (
      <View style={{ padding: 20, alignItems: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View testID="provider-action-hub" style={{ paddingVertical: 8 }}>
      {/* Tier & score */}
      <View style={styles.tierCard}>
        <View style={styles.tierIconWrap}>
          <Ionicons name="trophy" size={20} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.tierLabel}>TIER</Text>
          <Text style={styles.tierName}>
            {tier} · score {score}
          </Text>
        </View>
      </View>

      {/* Sprint 26 — Boost CTA: главный денежный конверсионный ход */}
      <TouchableOpacity
        testID="boost-cta-primary"
        onPress={() => router.push('/provider-boost')}
        activeOpacity={0.85}
        style={styles.boostCta}
      >
        <View style={styles.boostCtaIcon}>
          <Ionicons name="flame" size={20} color={colors.onPrimary || colors.brandText} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.boostCtaTitle}>🔥 Подняться в топ</Text>
          <Text style={styles.boostCtaSub}>×1.3 / ×1.5 / ×2.0 — больше заявок прямо сейчас</Text>
        </View>
        <Ionicons name="arrow-forward-circle" size={26} color={colors.onPrimary || colors.brandText} />
      </TouchableOpacity>

      {/* Sprint 29 — Referral CTA: Growth loop */}
      <TouchableOpacity
        testID="referral-cta-provider"
        onPress={() => router.push('/referral')}
        activeOpacity={0.85}
        style={styles.referralCta}
      >
        <View style={styles.referralIcon}>
          <Ionicons name="people" size={18} color={colors.success} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.referralTitle}>🚀 Приведи мастера</Text>
          <Text style={styles.referralSub}>+7 дней ×1.5 буста бесплатно</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.success} />
      </TouchableOpacity>

      {/* Sprint 33 C8.2 — Smart Nudge Card: "where should I earn right now?" */}
      <SmartNudgeCard providerSlug={slug} />

      {/* Sprint 33 C8.4 — Auto-money mode: system bids for the provider */}
      <AutoMoneyCard providerSlug={slug} />

      {/* Sprint 33 C8.1 — Reactivation banner: FOMO when offline */}
      <ReactivationBanner providerSlug={slug} onWentOnline={load} />

      {/* Sprint 31 — Outbid banner fires on auction:outbid realtime event */}
      <OutbidBanner providerSlug={slug} />

      {/* Sprint 33 C7.4 — Provider Money Dashboard (per-cluster revenue, FOMO, upsell, daily goal) */}
      <ProviderMoneyDashboard providerSlug={slug} />

      {/* Sprint 30 — Retention Hub: earnings trend, daily goal, missed FOMO */}
      <ProviderRetentionHub providerSlug={slug} />

      {/* Earnings */}
      <Text style={styles.sectionTitle}>Заработок</Text>
      <View style={styles.earningsRow}>
        <EarnCard colors={colors} label="Сегодня" value={today} testId="earn-today" />
        <EarnCard colors={colors} label="Неделя" value={week} testId="earn-week" />
        <EarnCard colors={colors} label="Месяц" value={month} testId="earn-month" />
      </View>

      {/* Pressure UX — lost revenue */}
      {lostAmount > 0 && (
        <TouchableOpacity
          testID="lost-revenue-card"
          onPress={() => router.push('/provider-boost')}
          style={styles.lostCard}
          activeOpacity={0.85}
        >
          <View style={styles.lostIconWrap}>
            <Ionicons name="trending-down" size={20} color={colors.error} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.lostTitle}>Вы потеряли {lostAmount} ₴</Text>
            <Text style={styles.lostSub}>
              {missedJobs > 0 ? `Пропущено ${missedJobs} заказ${missedJobs > 1 ? 'ов' : ''} — ` : ''}
              включите Boost
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      )}

      {/* Demand zone */}
      {topZone && (
        <TouchableOpacity
          testID="demand-zone-card"
          onPress={() => router.push('/services')}
          style={styles.demandCard}
          activeOpacity={0.85}
        >
          <View style={styles.demandIconWrap}>
            <Ionicons name="location" size={20} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.demandTitle}>
              Перейдите в {topZone.name || topZone.id}
            </Text>
            <Text style={styles.demandSub}>
              {topZone.demandScore ?? 0} заявок · surge ×{topZone.surgeMultiplier || 1}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      )}

      {/* Opportunities */}
      {opps.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Возможности</Text>
          {opps.map((o: any, i: number) => (
            <View key={i} testID={`opp-${i}`} style={styles.oppRow}>
              <View style={styles.oppIcon}>
                <Ionicons name="flame" size={16} color={colors.primary} />
              </View>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Text style={styles.oppTitle} numberOfLines={1}>
                  {o.title || o.name || 'Возможность'}
                </Text>
                <Text style={styles.oppSub} numberOfLines={2}>
                  {o.description || o.reason || ''}
                  {o.potentialRevenue ? `  +${o.potentialRevenue} ₴` : ''}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => router.push(o.ctaRoute || '/provider-boost')}
                style={styles.oppBtn}
              >
                <Text style={styles.oppBtnText}>{o.ctaLabel || 'Взять'}</Text>
              </TouchableOpacity>
            </View>
          ))}
        </>
      )}

      {/* Performance */}
      {perf && (
        <>
          <Text style={styles.sectionTitle}>Производительность</Text>
          <TouchableOpacity
            testID="perf-open-detail"
            onPress={() => router.push('/provider/performance')}
            activeOpacity={0.85}
            style={styles.perfRow}
          >
            <PerfCard colors={colors} label="Принято" value={`${perf.acceptanceRate ?? 0}%`} />
            <PerfCard colors={colors} label="Отмены" value={`${perf.cancellationRate ?? 0}%`} />
            <PerfCard colors={colors} label="Рейтинг" value={perf.avgRating ?? '—'} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="perf-open-link"
            onPress={() => router.push('/provider/performance')}
            style={styles.perfLinkBtn}
          >
            <Text style={styles.perfLinkText}>Подробнее → как попасть в топ</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="explain-open-link"
            onPress={() => router.push('/provider/explain')}
            style={styles.explainLinkBtn}
          >
            <Text style={styles.explainLinkText}>Почему я не в топе? →</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

function EarnCard({
  colors, label, value, testId,
}: { colors: any; label: string; value: number; testId: string }) {
  const styles = makeStyles(colors);
  return (
    <View testID={testId} style={styles.earnCard}>
      <Text style={styles.earnLabel}>{label}</Text>
      <Text style={styles.earnValue}>
        {typeof value === 'number' ? `${value.toLocaleString('ru-RU')} ₴` : value}
      </Text>
    </View>
  );
}

function PerfCard({
  colors, label, value,
}: { colors: any; label: string; value: string | number }) {
  const styles = makeStyles(colors);
  return (
    <View style={styles.perfCard}>
      <Text style={styles.perfLabel}>{label}</Text>
      <Text style={styles.perfValue}>{value}</Text>
    </View>
  );
}

const makeStyles = (c: any) => StyleSheet.create({
  // ── Tier ─────────────────────────────────────────────────
  tierCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 14,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 12,
  },
  tierIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: c.brandSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  tierLabel: { fontSize: 10, color: c.textMuted, letterSpacing: 1.2, fontWeight: '700' },
  tierName: { fontSize: 16, fontWeight: '700', color: c.text, marginTop: 2 },

  // ── Boost CTA (Sprint 26) ───────────────────────────────
  boostCta: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 14,
    backgroundColor: c.primary,
    marginBottom: 8,
    gap: 12,
  },
  boostCtaIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  boostCtaTitle: { fontSize: 16, fontWeight: '800', color: c.onPrimary || colors.brandText },
  boostCtaSub:   { fontSize: 12, fontWeight: '600', color: c.onPrimary || colors.brandText, opacity: 0.85, marginTop: 2 },

  // Sprint 29 — Referral CTA
  referralCta: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 13, borderRadius: 14, marginBottom: 12,
    backgroundColor: 'rgba(34,197,94,0.08)',
    borderWidth: 1, borderColor: 'rgba(34,197,94,0.35)',
  },
  referralIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(34,197,94,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  referralTitle: { fontSize: 15, fontWeight: '800', color: c.text },
  referralSub: { fontSize: 12, fontWeight: '600', color: c.textMuted, marginTop: 2 },

  // ── Section title ────────────────────────────────────────
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: c.textSecondary,
    marginTop: 18,
    marginBottom: 10,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },

  // ── Earnings ────────────────────────────────────────────
  earningsRow: { flexDirection: 'row', gap: 8 },
  earnCard: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
  },
  earnLabel: { fontSize: 11, color: c.textMuted, fontWeight: '600' },
  earnValue: { fontSize: 17, fontWeight: '800', marginTop: 4, color: c.text },

  // ── Lost revenue ────────────────────────────────────────
  lostCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 14,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.error + '40',
    marginTop: 12,
    gap: 12,
  },
  lostIconWrap: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: c.errorBg,
    alignItems: 'center', justifyContent: 'center',
  },
  lostTitle: { fontSize: 15, fontWeight: '700', color: c.text },
  lostSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },

  // ── Demand zone ─────────────────────────────────────────
  demandCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 14,
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    marginTop: 12,
    gap: 12,
  },
  demandIconWrap: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: c.brandSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  demandTitle: { fontSize: 15, fontWeight: '700', color: c.text },
  demandSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },

  // ── Opportunities ───────────────────────────────────────
  oppRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: c.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 8,
  },
  oppIcon: {
    width: 32, height: 32, borderRadius: 10,
    backgroundColor: c.brandSoft,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 10,
  },
  oppTitle: { fontSize: 13, fontWeight: '700', color: c.text },
  oppSub: { fontSize: 12, color: c.textMuted, marginTop: 2 },
  oppBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: c.primary,
    borderRadius: 10,
  },
  oppBtnText: { color: c.onPrimary, fontSize: 13, fontWeight: '800' },

  // ── Performance ─────────────────────────────────────────
  perfRow: { flexDirection: 'row', gap: 8 },
  perfLinkBtn: {
    marginTop: 10,
    paddingVertical: 12,
    backgroundColor: c.brandSoft,
    borderRadius: 12,
    alignItems: 'center',
  },
  perfLinkText: { color: c.primary, fontSize: 13, fontWeight: '700' },
  explainLinkBtn: {
    marginTop: 6,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
  },
  explainLinkText: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
  perfCard: {
    flex: 1,
    padding: 12,
    backgroundColor: c.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
  },
  perfLabel: { fontSize: 11, color: c.textMuted, fontWeight: '600' },
  perfValue: { fontSize: 17, fontWeight: '800', marginTop: 4, color: c.text },
});

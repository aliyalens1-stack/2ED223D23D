/**
 * Sprint 33 C8.4 — AutoMoneyCard
 *
 * Subscription-grade autobidder UI. Two states:
 *   - disabled: compact CTA "🤖 Авто-заработок · Включить"
 *   - enabled: live dashboard (strategy, target rank, max bid, spent/budget, leads)
 *              with inline "Пауза" button.
 *
 * Tap CTA → inline setup panel expands with:
 *   targetRank (1/2/3 segmented), maxBid (€/₴ input), dailyBudget (€/₴ input),
 *   strategy (conservative/balanced/aggressive segmented).
 *
 * Rendered in `ProviderActionHub` right below the Smart Nudge card — so:
 *   Smart Nudge (tells where)  →  Auto-money (does it for you)
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { useThemeContext } from '../context/ThemeContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

const API = process.env.EXPO_PUBLIC_BACKEND_URL || '';

type Strategy = 'conservative' | 'balanced' | 'aggressive';

type StatusResponse = {
  providerSlug: string;
  enabled?: boolean;
  targetRank?: number;
  maxBid?: number;
  dailyBudget?: number;
  strategy?: Strategy;
  spent?: number;
  todayLeads?: number;
  activeBids?: Array<{ zone: string; cluster: string; bid: number; leadsReceived?: number }>;
  disableReason?: string | null;
  day?: string;
};

const STRATEGY_LABELS: Record<Strategy, string> = {
  conservative: 'Осторожно',
  balanced: 'Сбалансированно',
  aggressive: 'Агрессивно',
};

const STRATEGY_HINT: Record<Strategy, string> = {
  conservative: 'Только самая прибыльная ячейка, минимум перебитий',
  balanced: 'Топ-2 ячейки, ставка +1 над лидером',
  aggressive: 'Топ-3 ячейки, ставка +2 над лидером, жёстко держим позиции',
};

export default function AutoMoneyCard({ providerSlug }: { providerSlug: string }) {
  const { colors } = useThemeContext();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // setup form state
  const [targetRank, setTargetRank] = useState<1 | 2 | 3>(3);
  const [maxBid, setMaxBid] = useState('40');
  const [budget, setBudget] = useState('500');
  const [strategy, setStrategy] = useState<Strategy>('balanced');

  const refresh = useCallback(async () => {
    if (!providerSlug) {
      setLoading(false);
      return;
    }
    try {
      const { data } = await axios.get(
        `${API}/api/provider/auto-money/status`,
        { params: { providerSlug }, timeout: 6000 }
      );
      setStatus(data);
      if (data?.enabled) {
        setTargetRank((data.targetRank || 3) as any);
        setMaxBid(String(data.maxBid || 40));
        setBudget(String(data.dailyBudget || 500));
        setStrategy((data.strategy as Strategy) || 'balanced');
      }
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [providerSlug]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000); // gentle polling for live stats
    return () => clearInterval(t);
  }, [refresh]);

  const enable = useCallback(async () => {
    const mb = parseFloat(maxBid);
    const b  = parseFloat(budget);
    if (!Number.isFinite(mb) || mb <= 0) {
      Alert.alert('Проверьте ставку', 'Максимальная ставка должна быть больше 0');
      return;
    }
    if (!Number.isFinite(b) || b < 10) {
      Alert.alert('Проверьте бюджет', 'Дневной бюджет должен быть не меньше 10');
      return;
    }
    if (mb > b) {
      Alert.alert('Неправильная настройка', 'Максимальная ставка не может быть больше бюджета');
      return;
    }
    setBusy(true);
    try {
      await axios.post(`${API}/api/provider/auto-money/enable`, {
        providerSlug,
        targetRank,
        maxBid: mb,
        dailyBudget: b,
        strategy,
      }, { timeout: 8000 });
      setExpanded(false);
      await refresh();
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.response?.data?.detail || 'Не удалось включить авто-заработок';
      Alert.alert('Ошибка', String(msg));
    } finally {
      setBusy(false);
    }
  }, [providerSlug, targetRank, maxBid, budget, strategy, refresh]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await axios.post(`${API}/api/provider/auto-money/disable`, { providerSlug }, { timeout: 6000 });
      await refresh();
    } catch {
      /* silent */
    } finally {
      setBusy(false);
    }
  }, [providerSlug, refresh]);

  if (loading) {
    return (
      <View style={[styles.wrap, styles.loading]} testID="auto-money-card-loading">
        <ActivityIndicator size="small" color={colors.brand || colors.primary} />
      </View>
    );
  }

  const enabled = !!status?.enabled;

  // ── Live dashboard when enabled ──
  if (enabled) {
    const spent = Math.round(Number(status?.spent) || 0);
    const budgetN = Math.round(Number(status?.dailyBudget) || 0);
    const pct = budgetN > 0 ? Math.min(100, Math.round((spent / budgetN) * 100)) : 0;
    const leads = Number(status?.todayLeads) || 0;
    const activeBidsN = status?.activeBids?.length || 0;
    const strat = (status?.strategy as Strategy) || 'balanced';

    return (
      <View style={styles.wrap} testID="auto-money-card-enabled">
        <View style={styles.headerRow}>
          <View style={[styles.headerIcon, { backgroundColor: '#22C55E20', borderColor: '#22C55E40' }]}>
            <Ionicons name="sparkles" size={18} color={colors.success} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.titleRow}>
              <Text style={[styles.title, { color: colors.text }]}>🤖 Авто-заработок</Text>
              <View style={styles.livePill}>
                <View style={styles.liveDot} />
                <Text style={styles.liveText}>LIVE</Text>
              </View>
            </View>
            <Text style={[styles.sub, { color: colors.textMuted || colors.textSecondary }]}>
              {STRATEGY_LABELS[strat]} · держим в топ-{status?.targetRank || 3}
            </Text>
          </View>
        </View>

        <View style={styles.statsRow}>
          <Stat label="Макс ставка" value={`${symFor(status)}${Math.round(status?.maxBid || 0)}`} c={colors} />
          <Stat label="Потрачено" value={`${symFor(status)}${spent}/${budgetN}`} c={colors} />
          <Stat label="Лидов" value={`${leads}`} c={colors} />
          <Stat label="Активных зон" value={`${activeBidsN}`} c={colors} />
        </View>

        {/* spend progress */}
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              {
                width: `${pct}%`,
                backgroundColor: pct >= 90 ? colors.brand : pct >= 60 ? colors.warning : colors.success,
              },
            ]}
          />
        </View>
        <Text style={[styles.progressLabel, { color: colors.textMuted || colors.textSecondary }]}>
          {pct}% дневного бюджета
        </Text>

        <TouchableOpacity
          testID="auto-money-disable"
          activeOpacity={0.85}
          onPress={disable}
          disabled={busy}
          style={[styles.secondaryBtn, { borderColor: colors.border }]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.text} />
          ) : (
            <>
              <Ionicons name="pause" size={14} color={colors.text} />
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Пауза авто-заработка</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    );
  }

  // ── Collapsed CTA (disabled state) ──
  if (!expanded) {
    return (
      <TouchableOpacity
        testID="auto-money-card-cta"
        activeOpacity={0.9}
        onPress={() => setExpanded(true)}
        style={styles.wrap}
      >
        <View style={styles.headerRow}>
          <View style={[styles.headerIcon, { backgroundColor: (colors.brand || colors.brand) + '22', borderColor: (colors.brand || colors.brand) + '55' }]}>
            <Ionicons name="sparkles" size={18} color={colors.brand || colors.brand} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: colors.text }]}>🤖 Авто-заработок</Text>
            <Text style={[styles.sub, { color: colors.textMuted || colors.textSecondary }]}>
              Система держит вас в топ-3 там, где больше денег
            </Text>
          </View>
          <View style={[styles.inlineCta, { backgroundColor: colors.brand || colors.brand }]}>
            <Text style={[styles.inlineCtaText, { color: colors.brandText || colors.brandText }]}>Включить</Text>
            <Ionicons name="arrow-forward" size={13} color={colors.brandText || colors.brandText} />
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  // ── Expanded setup form ──
  return (
    <View style={styles.wrap} testID="auto-money-setup">
      <View style={styles.headerRow}>
        <View style={[styles.headerIcon, { backgroundColor: (colors.brand || colors.brand) + '22', borderColor: (colors.brand || colors.brand) + '55' }]}>
          <Ionicons name="sparkles" size={18} color={colors.brand || colors.brand} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.text }]}>🤖 Авто-заработок</Text>
          <Text style={[styles.sub, { color: colors.textMuted || colors.textSecondary }]}>
            Настройте и включите — дальше мы сами
          </Text>
        </View>
        <TouchableOpacity onPress={() => setExpanded(false)} style={styles.closeX}>
          <Ionicons name="close" size={18} color={colors.textMuted || colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Target rank */}
      <Text style={[styles.fieldLabel, { color: colors.text }]}>Цель позиции</Text>
      <View style={styles.segRow}>
        {[1, 2, 3].map((r) => (
          <TouchableOpacity
            key={r}
            testID={`auto-money-rank-${r}`}
            onPress={() => setTargetRank(r as any)}
            activeOpacity={0.85}
            style={[
              styles.segBtn,
              { borderColor: colors.border, backgroundColor: colors.card },
              targetRank === r && { backgroundColor: colors.brand || colors.brand, borderColor: colors.brand || colors.brand },
            ]}
          >
            <Text
              style={[
                styles.segText,
                { color: colors.text },
                targetRank === r && { color: colors.brandText || colors.brandText, fontWeight: '900' },
              ]}
            >
              Топ-{r}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Max bid / Budget */}
      <View style={styles.inputsRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.fieldLabel, { color: colors.text }]}>Макс ставка / лид</Text>
          <TextInput
            testID="auto-money-maxbid"
            value={maxBid}
            onChangeText={setMaxBid}
            placeholder="40"
            placeholderTextColor={colors.textMuted}
            keyboardType="numeric"
            style={[styles.input, { borderColor: colors.border, color: colors.text, backgroundColor: colors.card }]}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.fieldLabel, { color: colors.text }]}>Бюджет / день</Text>
          <TextInput
            testID="auto-money-budget"
            value={budget}
            onChangeText={setBudget}
            placeholder="500"
            placeholderTextColor={colors.textMuted}
            keyboardType="numeric"
            style={[styles.input, { borderColor: colors.border, color: colors.text, backgroundColor: colors.card }]}
          />
        </View>
      </View>

      {/* Strategy */}
      <Text style={[styles.fieldLabel, { color: colors.text, marginTop: 10 }]}>Стратегия</Text>
      <View style={styles.segRow}>
        {(['conservative', 'balanced', 'aggressive'] as Strategy[]).map((s) => (
          <TouchableOpacity
            key={s}
            testID={`auto-money-strategy-${s}`}
            onPress={() => setStrategy(s)}
            activeOpacity={0.85}
            style={[
              styles.segBtn,
              { borderColor: colors.border, backgroundColor: colors.card },
              strategy === s && { backgroundColor: colors.brand || colors.brand, borderColor: colors.brand || colors.brand },
            ]}
          >
            <Text
              style={[
                styles.segText,
                { color: colors.text },
                strategy === s && { color: colors.brandText || colors.brandText, fontWeight: '900' },
              ]}
            >
              {STRATEGY_LABELS[s]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={[styles.hint, { color: colors.textMuted || colors.textSecondary }]}>
        {STRATEGY_HINT[strategy]}
      </Text>

      <TouchableOpacity
        testID="auto-money-enable"
        activeOpacity={0.88}
        onPress={enable}
        disabled={busy}
        style={[styles.enableBtn, { backgroundColor: colors.brand || colors.brand }, busy && { opacity: 0.6 }]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.brandText || colors.brandText} />
        ) : (
          <>
            <Ionicons name="flash" size={15} color={colors.brandText || colors.brandText} />
            <Text style={[styles.enableBtnText, { color: colors.brandText || colors.brandText }]}>
              Включить авто-заработок
            </Text>
            <Ionicons name="arrow-forward" size={15} color={colors.brandText || colors.brandText} />
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

function Stat({ label, value, c }: { label: string; value: string; c: any }) {
  return (
    <View style={statStyles.wrap}>
      <Text style={[statStyles.label, { color: c.textMuted || c.textSecondary }]}>{label}</Text>
      <Text style={[statStyles.value, { color: c.text }]}>{value}</Text>
    </View>
  );
}

function symFor(s: StatusResponse | null): string {
  const bid = s?.activeBids?.[0];
  const zone = bid?.zone || '';
  if (zone.startsWith('berlin') || zone.startsWith('munich') || zone.startsWith('hamburg') ||
      zone.startsWith('frankfurt') || zone.startsWith('vienna') || zone.startsWith('warsaw')) {
    return '€';
  }
  return '₴';
}

const statStyles = StyleSheet.create({
  wrap: { flex: 1, gap: 2 },
  label: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  value: { fontSize: 14, fontWeight: '900' },
});

const makeStyles = (c: any) =>
  StyleSheet.create({
    wrap: {
      borderRadius: 16,
      padding: 14,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.card,
      gap: 10,
      ...Platform.select({
        ios: {
          shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 3 },
        },
        android: { elevation: 2 },
        default: {},
      }),
    },
    loading: { minHeight: 72, alignItems: 'center', justifyContent: 'center' },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    headerIcon: {
      width: 36, height: 36, borderRadius: 11, borderWidth: 1,
      alignItems: 'center', justifyContent: 'center',
    },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { fontSize: 15, fontWeight: '900', letterSpacing: -0.2 },
    sub: { fontSize: 12, fontWeight: '500', marginTop: 2 },
    livePill: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      paddingHorizontal: 6, paddingVertical: 2,
      borderRadius: 6, backgroundColor: '#22C55E22',
    },
    liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
    liveText: { fontSize: 9, fontWeight: '900', color: colors.success, letterSpacing: 0.8 },
    inlineCta: {
      flexDirection: 'row', alignItems: 'center', gap: 5,
      paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10,
    },
    inlineCtaText: { fontSize: 12, fontWeight: '800' },
    statsRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
    progressTrack: {
      height: 6, borderRadius: 3, backgroundColor: c.border, overflow: 'hidden',
    },
    progressFill: { height: '100%', borderRadius: 3 },
    progressLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4, marginTop: -2 },
    secondaryBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      paddingVertical: 10, borderRadius: 11, borderWidth: 1,
    },
    secondaryBtnText: { fontSize: 13, fontWeight: '800' },
    closeX: { padding: 4 },
    fieldLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4, marginBottom: 6 },
    segRow: { flexDirection: 'row', gap: 6 },
    segBtn: {
      flex: 1, paddingVertical: 9, borderRadius: 10, borderWidth: 1,
      alignItems: 'center', justifyContent: 'center',
    },
    segText: { fontSize: 12, fontWeight: '700' },
    inputsRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
    input: {
      paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1,
      fontSize: 14, fontWeight: '700',
    },
    hint: { fontSize: 11, lineHeight: 15, marginTop: 2 },
    enableBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      paddingVertical: 12, borderRadius: 12, marginTop: 6,
    },
    enableBtnText: { fontSize: 14, fontWeight: '900', letterSpacing: -0.2 },
  });

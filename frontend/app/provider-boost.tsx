/**
 * Sprint 27 — Provider Boost / Auction screen.
 * Replaces fixed-price packages as the primary monetisation surface.
 *
 * Live bidding per zone:
 *   1st place → ×2.0
 *   2nd place → ×1.6
 *   3rd place → ×1.3
 *   rest      → ×1.0
 *
 * Charged per LEAD: when a request lands on the provider in the zone, the
 * `bid` amount is debited from `spent`. dailyBudget is the safety cap.
 *
 * Legacy 7d/24h packages are kept as a "Старая модель" fallback link.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  RefreshControl,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter, useLocalSearchParams } from 'expo-router';
import axios from 'axios';
import { useAuth } from '../src/context/AuthContext';
import { useThemeContext } from '../src/context/ThemeContext';
import { theme } from '../src/context/ThemeContext';
const colors = theme.colors;

const API = process.env.EXPO_PUBLIC_BACKEND_URL || '';

type Zone = { id: string; name: string; emoji?: string };
type ZoneAuction = {
  zone: string;
  totalBidders: number;
  topBid: number;
  minBid: number;
  suggestedBid: number;
  recommendedBid: number;
  minCompetitiveBid: number;
  pressure: 'high' | 'medium' | 'low';
  pricingMessage: string;
  standings: { rank: number; providerSlug: string; bid: number; multiplier: number; leadsReceived: number; isDominator?: boolean }[];
  dominance: { providerSlug: string; daysHolding: number; status: 'hot' | 'king' | null; since: string } | null;
  you: { providerSlug: string; position: number | null; rank: number | null; bid: number | null; multiplier: number; isDominator?: boolean } | null;
};

const KYIV_ZONES: Zone[] = [
  { id: 'kyiv-pechersk',   name: 'Печерск',   emoji: '🔥' },
  { id: 'kyiv-podil',      name: 'Подол',     emoji: '⚡' },
  { id: 'kyiv-obolon',     name: 'Оболонь',   emoji: '🌊' },
  { id: 'kyiv-darnytsia',  name: 'Дарница',   emoji: '🚀' },
  { id: 'kyiv-sviatoshyn', name: 'Святошин',  emoji: '✨' },
  { id: 'kyiv-center',     name: 'Центр',     emoji: '🏙️' },
];

// Sprint 33 C7.3 — Germany zones (EUR) appear when cluster != repair
const DE_ZONES: Zone[] = [
  { id: 'berlin-mitte',    name: 'Berlin Mitte',    emoji: '🇩🇪' },
  { id: 'berlin-neukolln', name: 'Berlin Neukölln', emoji: '🇩🇪' },
  { id: 'munich-zentrum',  name: 'Munich Zentrum',  emoji: '🇩🇪' },
  { id: 'hamburg-altona',  name: 'Hamburg Altona',  emoji: '🇩🇪' },
];

// Sprint 33 C7.3 — cluster tabs (aligned to canonical backend IDs)
type ClusterId = 'repair' | 'inspection' | 'selection' | 'delivery';
const CLUSTER_TABS: { id: ClusterId; title: string; icon: string; hint: string; currency: string }[] = [
  { id: 'repair',     title: 'Ремонт',   icon: '🔧', hint: '₴ стабильный поток — массовый рынок',             currency: '₴' },
  { id: 'inspection', title: 'Проверка', icon: '🔍', hint: '€120–250 за заявку — осмотр перед покупкой',     currency: '€' },
  { id: 'selection',  title: 'Подбор',   icon: '🎯', hint: '€500–1500 🔥 — high-LTV эксперт',                 currency: '€' },
  { id: 'delivery',   title: 'Пригон',   icon: '🚛', hint: '€300–900 — логистика из Европы',                  currency: '€' },
];

export default function BoostAuctionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ cluster?: string }>();
  const { user } = useAuth();
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);

  const providerSlug =
    (user as any)?.providerSlug || (user as any)?.organization?.slug || 'avtomaster-pro';

  const [auctions, setAuctions] = useState<Record<string, ZoneAuction>>({});
  const [drafts, setDrafts] = useState<Record<string, { bid: string; budget: string }>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  // Sprint 33 C7.3 — cluster tabs state. Sprint 33 C7.4 — accept ?cluster=
  // deep-link from Provider Money Dashboard CTAs.
  const initialCluster: ClusterId = ((): ClusterId => {
    const c = (params.cluster as string) || '';
    return (['repair','inspection','selection','delivery'] as ClusterId[]).includes(c as ClusterId)
      ? (c as ClusterId)
      : 'repair';
  })();
  const [cluster, setCluster] = useState<ClusterId>(initialCluster);
  const [providerClusters, setProviderClusters] = useState<ClusterId[]>(['repair']);
  const activeZones = cluster === 'repair' ? KYIV_ZONES : DE_ZONES;
  const clusterCfg = CLUSTER_TABS.find((c) => c.id === cluster) || CLUSTER_TABS[0];
  const providerHasCluster = providerClusters.includes(cluster);

  // Load provider's registered clusters (C7.1 endpoint)
  useEffect(() => {
    (async () => {
      try {
        const r = await axios.get(`${API}/api/provider/profile/clusters`, { params: { providerSlug } });
        setProviderClusters((r.data?.clusters || ['repair']) as ClusterId[]);
      } catch {
        setProviderClusters(['repair']);
      }
    })();
  }, [providerSlug]);

  const loadAll = useCallback(async () => {
    try {
      const results = await Promise.all(
        activeZones.map((z) =>
          axios
            .get(`${API}/api/zones/${z.id}/auction`, { params: { providerSlug, cluster } })
            .then((r) => [z.id, r.data] as const)
        )
      );
      const map: Record<string, ZoneAuction> = {};
      const draftsMap: Record<string, { bid: string; budget: string }> = {};
      results.forEach(([id, data]) => {
        map[id] = data;
        const myBid = data.you?.bid;
        const suggested = data.suggestedBid || 5;
        draftsMap[id] = {
          bid: String(myBid || suggested),
          budget: '500',
        };
      });
      setAuctions(map);
      setDrafts((prev) => ({ ...draftsMap, ...prev })); // preserve user edits
    } catch (e) {
      console.log('[auction] load error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [providerSlug, cluster, activeZones]);

  useEffect(() => {
    loadAll();
    // poll every 8s for live competition feel
    const t = setInterval(loadAll, 8000);
    return () => clearInterval(t);
  }, [loadAll]);

  const onRefresh = () => {
    setRefreshing(true);
    loadAll();
  };

  const submitBid = async (zone: string) => {
    const draft = drafts[zone];
    const bid = Number(draft?.bid || 0);
    const budget = Number(draft?.budget || 0);
    if (!bid || bid < 1) { Alert.alert('Ставка', 'Введите ставку ≥ 1 ₴'); return; }
    if (!budget || budget < 10) { Alert.alert('Бюджет', 'Дневной бюджет ≥ 10 ₴'); return; }
    if (bid > budget) { Alert.alert('Ошибка', 'Ставка не может быть больше дневного бюджета'); return; }

    try {
      setSubmitting(zone);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await axios.post(`${API}/api/provider/boost/bid`, {
        providerSlug,
        zone,
        cluster,
        bid,
        dailyBudget: budget,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const m = res.data?.multiplier;
      const pos = res.data?.position;
      Alert.alert(
        'Ставка принята',
        pos !== null && pos < 3
          ? `Вы на ${pos + 1} месте — множитель ×${m}`
          : `Ставка ниже топ-3. Текущий ×${m}. Поднимите ставку чтобы попасть в топ.`,
      );
      await loadAll();
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg = e?.response?.data?.message || 'Не удалось обновить ставку';
      Alert.alert('Ошибка', msg);
    } finally {
      setSubmitting(null);
    }
  };

  // Sprint 28: Auto-bidding (AI keeps you at targetRank)
  const enableAutoBid = async (zone: string, targetRank: number, maxBid: number, dailyBudget: number) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await axios.post(`${API}/api/provider/boost/auto-bid`, {
        providerSlug, zone, targetRank, maxBid, dailyBudget,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('🤖 Авто-ставка включена', `Держим ${targetRank}-е место. Макс ₴${maxBid}/лид. Бюджет ₴${dailyBudget}/день.`);
      await loadAll();
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Ошибка', e?.response?.data?.message || 'Не удалось включить');
    }
  };

  const pauseBid = async (zone: string) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await axios.delete(`${API}/api/provider/boost/bid`, { params: { providerSlug, zone } });
      await loadAll();
    } catch (e: any) {
      Alert.alert('Ошибка', e?.response?.data?.message || 'Не удалось приостановить');
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={styles.loadingText}>Загружаю аукцион...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Sticky summary header ──
  const myActiveBids = activeZones.filter(z => auctions[z.id]?.you?.position !== null && auctions[z.id]?.you?.bid).length;
  const totalSpend = activeZones.reduce((sum, z) => sum + (auctions[z.id]?.you?.bid ?? 0), 0);
  const currencySym = clusterCfg.currency;

  return (
    <SafeAreaView style={styles.container} testID="auction-screen">
      <View style={styles.header}>
        <TouchableOpacity testID="auction-back-btn" onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.title}>Аукцион зон</Text>
          <Text style={styles.subtitle}>Бейся за поток заказов</Text>
        </View>
        <TouchableOpacity
          testID="auction-packages-link"
          onPress={() => router.push('/provider-boost-packages')}
          style={styles.iconBtn}
        >
          <Ionicons name="cube-outline" size={20} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Sprint 33 C7.3 — Cluster tabs (4 рынка) */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 10, gap: 8 }}
        testID="boost-cluster-tabs"
      >
        {CLUSTER_TABS.map((t) => {
          const isActive = cluster === t.id;
          const isMine = providerClusters.includes(t.id);
          return (
            <TouchableOpacity
              key={t.id}
              onPress={() => setCluster(t.id)}
              activeOpacity={0.85}
              style={[
                {
                  paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12,
                  borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: isActive ? colors.primary : colors.surface,
                  borderColor: isActive ? colors.primary : colors.border,
                },
              ]}
              testID={`boost-tab-${t.id}`}
            >
              <Text style={{ fontSize: 16 }}>{t.icon}</Text>
              <Text style={{ color: isActive ? colors.onPrimary : colors.text, fontSize: 13, fontWeight: '800' }}>
                {t.title}
              </Text>
              {!isMine && (
                <View style={{ marginLeft: 4, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: 'rgba(245,184,0,0.2)' }}>
                  <Text style={{ color: colors.brand, fontSize: 9, fontWeight: '900' }}>OFF</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Cluster hint / pricing psychology */}
      <View style={{ marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
        <Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>
          💰 {clusterCfg.hint}
        </Text>
      </View>

      {/* Guard — provider not registered in this cluster */}
      {!providerHasCluster && (
        <View style={{ marginHorizontal: 16, marginBottom: 12, padding: 16, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.brand }} testID="cluster-guard">
          <Text style={{ color: colors.text, fontSize: 14, fontWeight: '900', marginBottom: 4 }}>
            Вы не работаете в рынке «{clusterCfg.title}»
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 10 }}>
            Чтобы делать ставки, сначала добавьте этот рынок в свою специализацию.
          </Text>
          <TouchableOpacity
            onPress={() => router.push('/provider/clusters')}
            style={{ backgroundColor: colors.brand, paddingVertical: 10, borderRadius: 10, alignItems: 'center' }}
            testID="cluster-guard-cta"
          >
            <Text style={{ color: '#111', fontWeight: '900', fontSize: 13 }}>Подключить рынок</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Ionicons name="trophy" size={28} color={colors.primary} />
          </View>
          <Text style={styles.heroTitle}>Конкурируй за зону — печатай деньги</Text>
          <Text style={styles.heroSub}>
            1 место ×2.0 · 2 место ×1.6 · 3 место ×1.3{'\n'}
            Списываем ставку только когда заявка пришла к тебе.
          </Text>
          <View style={styles.heroStats}>
            <View style={styles.heroStat}>
              <Text style={styles.heroStatVal}>{myActiveBids}</Text>
              <Text style={styles.heroStatLab}>зон в борьбе</Text>
            </View>
            <View style={styles.heroDivider} />
            <View style={styles.heroStat}>
              <Text style={styles.heroStatVal}>{currencySym}{totalSpend}</Text>
              <Text style={styles.heroStatLab}>ставок суммой</Text>
            </View>
          </View>
        </View>

        {/* Sprint 29: Growth loop — free boost via referral */}
        <TouchableOpacity
          testID="boost-referral-cta"
          onPress={() => router.push('/referral')}
          activeOpacity={0.9}
          style={{
            marginHorizontal: 16, marginBottom: 12, padding: 14,
            flexDirection: 'row', alignItems: 'center', gap: 12,
            borderRadius: 14,
            backgroundColor: 'rgba(245, 184, 0, 0.12)',
            borderWidth: 1, borderColor: 'rgba(245, 184, 0, 0.45)',
          }}
        >
          <Text style={{ fontSize: 32 }}>🚀</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}>
              Приведи мастера → 7 дней ×1.5 буста БЕСПЛАТНО
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 3 }}>
              После 3 завершённых заказов от приглашённого
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.primary} />
        </TouchableOpacity>

        {/* Zone cards */}
        {activeZones.map((z) => {
          const a = auctions[z.id];
          if (!a) return null;
          const draft = drafts[z.id] || { bid: '', budget: '500' };
          const myRank = a.you?.rank;
          const myMult = a.you?.multiplier ?? 1.0;
          const myActive = a.you?.position !== null && (a.you?.bid ?? 0) > 0;
          const isSubmitting = submitting === z.id;

          return (
            <View key={z.id} style={styles.zoneCard} testID={`auction-zone-${z.id}`}>
              {/* Zone header + dominance badge */}
              <View style={styles.zoneHead}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                  <Text style={styles.zoneName}>{z.emoji} {z.name}</Text>
                  {a.dominance?.status === 'king' && (
                    <View style={[styles.domBadge, { backgroundColor: colors.warning }]} testID={`dominator-king-${z.id}`}>
                      <Text style={styles.domBadgeTxt}>👑 DOMINATOR · {a.dominance.daysHolding}д</Text>
                    </View>
                  )}
                  {a.dominance?.status === 'hot' && (
                    <View style={[styles.domBadge, { backgroundColor: colors.brand }]}>
                      <Text style={styles.domBadgeTxt}>🔥 {a.dominance.daysHolding}д</Text>
                    </View>
                  )}
                </View>
                <View style={styles.biddersChip}>
                  <Ionicons name="people" size={13} color={colors.textMuted} />
                  <Text style={styles.biddersTxt}>{a.totalBidders}</Text>
                </View>
              </View>

              {/* 🧠 AI Pricing hint */}
              <View style={[styles.aiHint, { backgroundColor: pressureColor(a.pressure, colors) }]} testID={`ai-hint-${z.id}`}>
                <Ionicons name="sparkles" size={14} color={colors.text} />
                <Text style={styles.aiHintTxt}>{a.pricingMessage}</Text>
              </View>

              {/* Top bid + my position */}
              <View style={styles.statsRow}>
                <View style={styles.statBlock}>
                  <Text style={styles.statLabel}>Лидер</Text>
                  <Text style={[styles.statValue, { color: colors.primary }]}>
                    ₴{a.topBid || 0}
                  </Text>
                </View>
                <View style={styles.statBlock}>
                  <Text style={styles.statLabel}>Вы</Text>
                  {myActive ? (
                    <Text style={[styles.statValue, { color: rankColor(myRank) }]}>
                      ₴{a.you?.bid ?? 0} · {myRank} место
                    </Text>
                  ) : (
                    <Text style={[styles.statValue, { color: colors.textMuted }]}>не участвуете</Text>
                  )}
                </View>
                <View style={styles.statBlock}>
                  <Text style={styles.statLabel}>Множитель</Text>
                  <Text style={[styles.statValue, { color: myMult > 1 ? colors.primary : colors.textMuted }]}>
                    ×{myMult.toFixed(1)}
                    {a.you?.isDominator && <Text style={{ fontSize: 10 }}> 👑</Text>}
                  </Text>
                </View>
              </View>

              {/* Standings podium */}
              <View style={styles.podium}>
                {a.standings.slice(0, 3).map((s) => (
                  <View
                    key={s.providerSlug}
                    style={[
                      styles.podiumRow,
                      s.providerSlug === providerSlug && styles.podiumRowMine,
                    ]}
                  >
                    <View style={[styles.rankBadge, { backgroundColor: rankColor(s.rank) }]}>
                      <Text style={styles.rankBadgeTxt}>{s.rank}</Text>
                    </View>
                    <Text style={styles.podiumName}>
                      {s.providerSlug === providerSlug ? 'Вы' : maskSlug(s.providerSlug)}
                    </Text>
                    <Text style={[styles.podiumMult, { color: rankColor(s.rank) }]}>×{s.multiplier.toFixed(1)}</Text>
                    <Text style={styles.podiumBid}>₴{s.bid}</Text>
                  </View>
                ))}
                {a.standings.length === 0 && (
                  <Text style={styles.emptyTxt}>Зона пустая — бери 1 место сейчас</Text>
                )}
              </View>

              {/* Bid form */}
              <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                <View style={styles.formRow}>
                  <View style={styles.formField}>
                    <Text style={styles.formLabel}>Ваша ставка ₴/лид</Text>
                    <TextInput
                      testID={`auction-bid-input-${z.id}`}
                      style={styles.input}
                      keyboardType="numeric"
                      value={draft.bid}
                      placeholder={String(a.suggestedBid || 5)}
                      placeholderTextColor={colors.textMuted}
                      onChangeText={(v) => setDrafts(p => ({ ...p, [z.id]: { ...p[z.id], bid: v.replace(/[^0-9]/g, '') } }))}
                    />
                  </View>
                  <View style={styles.formField}>
                    <Text style={styles.formLabel}>Бюджет/день ₴</Text>
                    <TextInput
                      testID={`auction-budget-input-${z.id}`}
                      style={styles.input}
                      keyboardType="numeric"
                      value={draft.budget}
                      placeholder="500"
                      placeholderTextColor={colors.textMuted}
                      onChangeText={(v) => setDrafts(p => ({ ...p, [z.id]: { ...p[z.id], budget: v.replace(/[^0-9]/g, '') } }))}
                    />
                  </View>
                </View>

                <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <TouchableOpacity
                    testID={`auction-quick-recommended-${z.id}`}
                    onPress={() => setDrafts(p => ({ ...p, [z.id]: { ...p[z.id], bid: String(a.recommendedBid) } }))}
                    style={[styles.quickBtn, { backgroundColor: 'rgba(34,197,94,0.15)' }]}
                  >
                    <Ionicons name="sparkles" size={14} color={colors.success} />
                    <Text style={[styles.quickBtnTxt, { color: colors.success }]}>🔥 Рекомендовано: ₴{a.recommendedBid}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID={`auction-quick-suggested-${z.id}`}
                    onPress={() => setDrafts(p => ({ ...p, [z.id]: { ...p[z.id], bid: String(a.suggestedBid) } }))}
                    style={styles.quickBtn}
                  >
                    <Ionicons name="flash" size={14} color={colors.primary} />
                    <Text style={styles.quickBtnTxt}>Beat top: ₴{a.suggestedBid}</Text>
                  </TouchableOpacity>
                  {myActive && (
                    <TouchableOpacity
                      testID={`auction-pause-${z.id}`}
                      onPress={() => pauseBid(z.id)}
                      style={styles.pauseBtn}
                    >
                      <Ionicons name="pause" size={14} color={colors.brand} />
                      <Text style={styles.pauseBtnTxt}>Пауза</Text>
                    </TouchableOpacity>
                  )}
                </View>

                <View style={styles.minBidNote}>
                  <Ionicons name="shield-checkmark" size={12} color={colors.textMuted} />
                  <Text style={styles.minBidNoteTxt}>
                    Минимум для топ-3: <Text style={{ fontWeight: '700', color: colors.text }}>₴{a.minCompetitiveBid}</Text> · флор зоны: ₴{a.minBid}
                  </Text>
                </View>

                <TouchableOpacity
                  testID={`auction-submit-${z.id}`}
                  disabled={isSubmitting}
                  style={[styles.submitBtn, isSubmitting && { opacity: 0.6 }]}
                  onPress={() => submitBid(z.id)}
                >
                  {isSubmitting ? (
                    <ActivityIndicator color={colors.onPrimary || colors.brandText} />
                  ) : (
                    <>
                      <Ionicons name="trending-up" size={16} color={colors.onPrimary || colors.brandText} />
                      <Text style={styles.submitTxt}>
                        {myActive ? 'Обновить ставку' : 'Поднять ставку'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  testID={`auction-autobid-${z.id}`}
                  onPress={() => enableAutoBid(z.id, 3, Math.max(a.recommendedBid * 2, a.minCompetitiveBid * 2), Number(draft.budget) || 500)}
                  style={styles.autoBidBtn}
                >
                  <Ionicons name="hardware-chip" size={14} color={colors.primary} />
                  <Text style={styles.autoBidTxt}>🤖 Авто-ставка · держи топ-3 до ₴{Math.max(a.recommendedBid * 2, a.minCompetitiveBid * 2)}/лид</Text>
                </TouchableOpacity>
              </KeyboardAvoidingView>
            </View>
          );
        })}

        {/* Old packages footer */}
        <TouchableOpacity
          style={styles.packagesFooter}
          onPress={() => router.push('/provider-boost-packages')}
          testID="auction-old-packages-link"
        >
          <Ionicons name="cube-outline" size={16} color={colors.textMuted} />
          <Text style={styles.packagesFooterTxt}>Старая модель: пакеты на 7д / 24ч</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function rankColor(rank?: number | null): string {
  if (rank === 1) return colors.warning;
  if (rank === 2) return colors.textSecondary;
  if (rank === 3) return colors.warning;
  return colors.textMuted;
}

function pressureColor(p: 'high' | 'medium' | 'low', c: any): string {
  if (p === 'high') return 'rgba(239,68,68,0.12)';
  if (p === 'medium') return 'rgba(245,158,11,0.12)';
  return 'rgba(34,197,94,0.10)';
}

function maskSlug(slug: string): string {
  if (!slug) return '—';
  if (slug.length <= 3) return slug;
  return slug.slice(0, 3) + '***';
}

const makeStyles = (c: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { marginTop: 12, color: c.textMuted, fontSize: 14 },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.card,
  },
  title: { fontSize: 17, fontWeight: '800', color: c.text },
  subtitle: { fontSize: 12, color: c.textMuted, marginTop: 2 },

  hero: {
    margin: 16, padding: 20, borderRadius: 18,
    backgroundColor: c.card, borderWidth: 1, borderColor: c.border,
    alignItems: 'center',
  },
  heroIcon: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: c.brandSoft || 'rgba(245,184,0,0.15)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 12,
  },
  heroTitle: { fontSize: 17, fontWeight: '800', color: c.text, textAlign: 'center' },
  heroSub: { marginTop: 8, fontSize: 13, color: c.textMuted, textAlign: 'center', lineHeight: 19 },
  heroStats: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 16, gap: 24,
  },
  heroStat: { alignItems: 'center' },
  heroStatVal: { fontSize: 22, fontWeight: '800', color: c.primary },
  heroStatLab: { fontSize: 11, color: c.textMuted, marginTop: 2, letterSpacing: 0.4 },
  heroDivider: { width: 1, height: 28, backgroundColor: c.border },

  zoneCard: {
    marginHorizontal: 16, marginBottom: 14,
    padding: 16, borderRadius: 16,
    backgroundColor: c.card, borderWidth: 1, borderColor: c.border,
  },
  zoneHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10,
  },
  zoneName: { fontSize: 17, fontWeight: '800', color: c.text },
  biddersChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
    backgroundColor: c.backgroundTertiary,
  },
  biddersTxt: { fontSize: 12, color: c.textMuted, fontWeight: '600' },

  statsRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    marginBottom: 12, gap: 8,
  },
  statBlock: { flex: 1 },
  statLabel: { fontSize: 11, color: c.textMuted, letterSpacing: 0.5 },
  statValue: { fontSize: 14, fontWeight: '800', marginTop: 4, color: c.text },

  podium: {
    paddingVertical: 8, borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.border,
    marginBottom: 12,
  },
  podiumRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 6, paddingHorizontal: 4, gap: 10,
  },
  podiumRowMine: { backgroundColor: c.brandSoft || 'rgba(245,184,0,0.10)', borderRadius: 8 },
  rankBadge: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  rankBadgeTxt: { color: colors.brandText, fontWeight: '900', fontSize: 11 },
  podiumName: { flex: 1, fontSize: 13, color: c.text, fontWeight: '600' },
  podiumMult: { fontSize: 13, fontWeight: '800' },
  podiumBid: { fontSize: 13, fontWeight: '800', color: c.text, minWidth: 50, textAlign: 'right' },
  emptyTxt: { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 8 },

  // Sprint 28
  domBadge: {
    marginLeft: 8, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7,
  },
  domBadgeTxt: { color: colors.brandText, fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
  aiHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    padding: 10, borderRadius: 10, marginBottom: 12,
  },
  aiHintTxt: { flex: 1, fontSize: 12, color: c.text, lineHeight: 17 },
  minBidNote: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 10, paddingHorizontal: 4,
  },
  minBidNoteTxt: { fontSize: 11, color: c.textMuted },
  autoBidBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 8, paddingVertical: 11, borderRadius: 10,
    borderWidth: 1, borderColor: c.primary,
    backgroundColor: c.brandSoft || 'rgba(245,184,0,0.08)',
  },
  autoBidTxt: { color: c.primary, fontSize: 12, fontWeight: '700' },

  formRow: { flexDirection: 'row', gap: 10 },
  formField: { flex: 1 },
  formLabel: { fontSize: 11, color: c.textMuted, letterSpacing: 0.4, marginBottom: 6 },
  input: {
    backgroundColor: c.backgroundTertiary,
    borderWidth: 1, borderColor: c.border,
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
    color: c.text, fontSize: 15, fontWeight: '700',
  },

  quickBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    backgroundColor: c.brandSoft || 'rgba(245,184,0,0.12)',
  },
  quickBtnTxt: { color: c.primary, fontSize: 12, fontWeight: '700' },
  pauseBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    backgroundColor: 'rgba(239,68,68,0.10)',
  },
  pauseBtnTxt: { color: colors.brand, fontSize: 12, fontWeight: '700' },

  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: c.primary, borderRadius: 12,
    paddingVertical: 14, marginTop: 12,
  },
  submitTxt: { color: c.onPrimary || colors.brandText, fontSize: 15, fontWeight: '800' },

  packagesFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, marginTop: 4, marginHorizontal: 16,
    borderRadius: 12,
    backgroundColor: c.card, borderWidth: 1, borderColor: c.border,
  },
  packagesFooterTxt: { fontSize: 13, color: c.textMuted, fontWeight: '600' },
});

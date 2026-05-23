// Inspector / Provider Earnings tab — "Доходы".
//
// Re-written from scratch (2026-05-17): the previous version
// read `accessToken` directly from AsyncStorage (wrong key — the
// real key is `auth_token`), used raw `fetch` instead of the
// central `api` service, hard-coded #fff/#333/#eee colors so the
// dark theme never worked, and consequently always rendered a
// "Необходимо войти в аккаунт" gate even for an authenticated
// inspector.
//
// New contract:
//   • auth state is read from `useAuth()` — single source of truth.
//   • Network goes through `api` service (token injected globally).
//   • Two real endpoints power the screen for inspector / provider
//     accounts:
//       GET /api/inspector/dashboard  → summary + warnings
//       GET /api/inspector/payouts    → payouts: history + bank
//   • All colors use `useThemeContext()` tokens so dark + light
//     render identically without forks.
//   • testIDs on every interactive / metric so we can exercise
//     this in playwright / testing-agent.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useThemeContext } from '../src/context/ThemeContext';
import { useAuth } from '../src/context/AuthContext';
import { api } from '../src/services/api';

// ── Types matching the real backend responses ───────────────────
interface DashboardSummary {
  activeJobs: number;
  awaitingReport: number;
  completedMonth: number;
  ratingAvg: number;
  reviewsCount: number;
  earningsMonth: number;
  pendingPayout: number;
  currency: string;
}

interface DashboardWarning {
  kind: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  missing?: string[];
}

interface DashboardResponse {
  summary: DashboardSummary;
  warnings: DashboardWarning[];
  recentEvents?: Array<{
    id: string;
    status: string;
    requestId: string | null;
    timestamp: string;
    source?: string;
  }>;
}

interface PayoutsSummary {
  earningsMonth: number;
  pendingPayout: number;
  paidTotal: number;
  pendingReports: number;
  currency: string;
}

interface PayoutHistoryRow {
  id: string;
  amount: number;
  currency: string;
  status: 'paid' | 'pending' | 'failed';
  paidAt?: string;
  createdAt?: string;
  bookingId?: string;
}

interface PayoutsResponse {
  summary: PayoutsSummary;
  history: PayoutHistoryRow[];
  bank: {
    iban: string | null;
    bic: string | null;
    holderName: string | null;
    country: string | null;
  };
  note?: string;
}

const ROLE_ALLOWED = ['provider_owner', 'provider_manager', 'inspector', 'admin'];

function fmtMoney(n: number, currency: string = 'EUR'): string {
  const symbol = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtDate(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
  } catch {
    return '';
  }
}

export default function InspectorEarningsScreen() {
  const router = useRouter();
  const { colors, isDark } = useThemeContext();
  const styles = makeStyles(colors, isDark);
  const { isLoading: authLoading, isAuthenticated, user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [payouts, setPayouts] = useState<PayoutsResponse | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const role = user?.role || '';
  const isAllowed = ROLE_ALLOWED.includes(role);

  const fetchData = useCallback(async () => {
    setErrMsg(null);
    try {
      const [dashRes, payRes] = await Promise.allSettled([
        api.get<DashboardResponse>('/inspector/dashboard'),
        api.get<PayoutsResponse>('/inspector/payouts'),
      ]);
      if (dashRes.status === 'fulfilled') setDashboard(dashRes.value.data);
      if (payRes.status === 'fulfilled') setPayouts(payRes.value.data);
      // If both rails failed, surface a soft error. Auth-related
      // 401s never bubble here because the api interceptor logs the
      // user out at the AuthProvider level.
      if (dashRes.status === 'rejected' && payRes.status === 'rejected') {
        setErrMsg('Не удалось загрузить доходы. Потяните вниз, чтобы повторить.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    if (!isAllowed) {
      setLoading(false);
      return;
    }
    fetchData();
  }, [authLoading, isAuthenticated, isAllowed, fetchData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [fetchData]);

  // ── Auth loading or initial fetch ─────────────────────────────
  if (authLoading || loading) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <SafeAreaView style={styles.fillCenter} edges={['top']}>
          <ActivityIndicator size="large" color={colors.primary} />
        </SafeAreaView>
      </View>
    );
  }

  // ── Genuine guest / signed-out — the only case where the
  // "Войти" prompt is actually correct. Themed properly now.
  if (!isAuthenticated) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <SafeAreaView style={styles.fillCenter} edges={['top', 'bottom']} testID="earnings-auth-gate">
          <View style={[styles.gateIcon, { backgroundColor: colors.brandSoft }]}>
            <Ionicons name="lock-closed" size={32} color={colors.primary} />
          </View>
          <Text style={[styles.gateTitle, { color: colors.text }]}>Войдите, чтобы увидеть доходы</Text>
          <Text style={[styles.gateSub, { color: colors.textSecondary }]}>
            Эта страница доступна только инспекторам и СТО.
          </Text>
          <TouchableOpacity
            testID="earnings-login-btn"
            style={[styles.gateBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.push('/login')}
            activeOpacity={0.85}
          >
            <Text style={[styles.gateBtnText, { color: colors.onPrimary }]}>Войти</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </View>
    );
  }

  // ── Authenticated but in a role that doesn't have earnings ────
  // (customers shouldn't see this surface at all, but they can
  // accidentally land here via deep link / tab).
  if (!isAllowed) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <SafeAreaView style={styles.fillCenter} edges={['top', 'bottom']} testID="earnings-role-gate">
          <View style={[styles.gateIcon, { backgroundColor: colors.brandSoft }]}>
            <Ionicons name="wallet" size={32} color={colors.primary} />
          </View>
          <Text style={[styles.gateTitle, { color: colors.text }]}>Доходы — для инспекторов</Text>
          <Text style={[styles.gateSub, { color: colors.textSecondary }]}>
            Этот раздел доступен пользователям со статусом инспектора или СТО.
          </Text>
          <TouchableOpacity
            testID="earnings-home-btn"
            style={[styles.gateBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.replace('/(tabs)')}
            activeOpacity={0.85}
          >
            <Text style={[styles.gateBtnText, { color: colors.onPrimary }]}>На главную</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </View>
    );
  }

  // ── Earnings dashboard for inspector / provider ──────────────
  const summary: DashboardSummary = dashboard?.summary || {
    activeJobs: 0,
    awaitingReport: 0,
    completedMonth: 0,
    ratingAvg: 0,
    reviewsCount: 0,
    earningsMonth: 0,
    pendingPayout: 0,
    currency: 'EUR',
  };
  const paySum: PayoutsSummary = payouts?.summary || {
    earningsMonth: summary.earningsMonth,
    pendingPayout: summary.pendingPayout,
    paidTotal: 0,
    pendingReports: 0,
    currency: summary.currency,
  };
  const history: PayoutHistoryRow[] = payouts?.history || [];
  const bank = payouts?.bank;
  const warnings = dashboard?.warnings || [];
  const currency = paySum.currency || 'EUR';

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <SafeAreaView style={{ flex: 1 }} edges={['top']}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity
            testID="earnings-back-btn"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
            style={styles.headerBtn}
          >
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]} testID="earnings-title">
            Доходы
          </Text>
          <View style={styles.headerBtn} />
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        >
          {errMsg ? (
            <View
              testID="earnings-error-banner"
              style={[styles.errorBanner, { backgroundColor: colors.warningBg, borderColor: colors.warning }]}
            >
              <Ionicons name="alert-circle" size={18} color={colors.warning} />
              <Text style={[styles.errorBannerText, { color: colors.warning }]}>{errMsg}</Text>
            </View>
          ) : null}

          {/* Hero — month earnings */}
          <View
            testID="earnings-hero-card"
            style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.heroLabel, { color: colors.textSecondary }]}>Заработано за месяц</Text>
            <Text style={[styles.heroValue, { color: colors.text }]} testID="earnings-month-value">
              {fmtMoney(paySum.earningsMonth, currency)}
            </Text>
            <View style={styles.heroMetaRow}>
              <View style={styles.heroMetaCell}>
                <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                <Text style={[styles.heroMetaLabel, { color: colors.textSecondary }]}>Завершено</Text>
                <Text style={[styles.heroMetaValue, { color: colors.text }]} testID="earnings-completed-value">
                  {summary.completedMonth}
                </Text>
              </View>
              <View style={[styles.heroMetaDivider, { backgroundColor: colors.border }]} />
              <View style={styles.heroMetaCell}>
                <Ionicons name="star" size={16} color={colors.primary} />
                <Text style={[styles.heroMetaLabel, { color: colors.textSecondary }]}>Рейтинг</Text>
                <Text style={[styles.heroMetaValue, { color: colors.text }]} testID="earnings-rating-value">
                  {summary.ratingAvg ? summary.ratingAvg.toFixed(1) : '—'}
                </Text>
              </View>
            </View>
          </View>

          {/* Payout split — pending / paid */}
          <View style={styles.splitRow}>
            <View
              testID="earnings-pending-card"
              style={[styles.splitCard, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[styles.splitIcon, { backgroundColor: colors.warningBg }]}>
                <Ionicons name="time-outline" size={18} color={colors.warning} />
              </View>
              <Text style={[styles.splitLabel, { color: colors.textSecondary }]}>К выплате</Text>
              <Text style={[styles.splitValue, { color: colors.text }]} testID="earnings-pending-value">
                {fmtMoney(paySum.pendingPayout, currency)}
              </Text>
              {paySum.pendingReports > 0 ? (
                <Text style={[styles.splitHint, { color: colors.textMuted }]}>
                  {paySum.pendingReports} отчёт(а) на проверке
                </Text>
              ) : null}
            </View>
            <View
              testID="earnings-paid-card"
              style={[styles.splitCard, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[styles.splitIcon, { backgroundColor: colors.successBg }]}>
                <Ionicons name="cash-outline" size={18} color={colors.success} />
              </View>
              <Text style={[styles.splitLabel, { color: colors.textSecondary }]}>Выплачено всего</Text>
              <Text style={[styles.splitValue, { color: colors.text }]} testID="earnings-paid-value">
                {fmtMoney(paySum.paidTotal, currency)}
              </Text>
            </View>
          </View>

          {/* Workload — active / awaiting report */}
          <View
            testID="earnings-workload-card"
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.cardTitle, { color: colors.text }]}>Текущая нагрузка</Text>
            <View style={styles.workloadRow}>
              <WorkloadStat
                icon="briefcase"
                color={colors.primary}
                bg={colors.brandSoft}
                label="Активные"
                value={summary.activeJobs}
                colors={colors}
                testID="earnings-active-jobs"
              />
              <WorkloadStat
                icon="document-text"
                color={colors.warning}
                bg={colors.warningBg}
                label="Ждут отчёт"
                value={summary.awaitingReport}
                colors={colors}
                testID="earnings-awaiting-report"
              />
              <WorkloadStat
                icon="chatbubbles"
                color={colors.success}
                bg={colors.successBg}
                label="Отзывов"
                value={summary.reviewsCount}
                colors={colors}
                testID="earnings-reviews-count"
              />
            </View>
          </View>

          {/* Payout history */}
          <View
            testID="earnings-history-card"
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Text style={[styles.cardTitle, { color: colors.text }]}>История выплат</Text>
            {history.length === 0 ? (
              <View style={styles.emptyHistory}>
                <Ionicons name="receipt-outline" size={28} color={colors.textMuted} />
                <Text style={[styles.emptyHistoryText, { color: colors.textSecondary }]}>
                  Выплат пока нет. Первая поступит после выполнения первого отчёта.
                </Text>
              </View>
            ) : (
              history.slice(0, 10).map((row, idx) => (
                <View
                  key={row.id || idx}
                  testID={`earnings-history-row-${idx}`}
                  style={[
                    styles.historyRow,
                    idx < Math.min(history.length, 10) - 1 && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
                  ]}
                >
                  <View style={styles.historyLeft}>
                    <View
                      style={[
                        styles.historyDot,
                        {
                          backgroundColor:
                            row.status === 'paid'
                              ? colors.success
                              : row.status === 'failed'
                              ? '#EF4444'
                              : colors.warning,
                        },
                      ]}
                    />
                    <View>
                      <Text style={[styles.historyTitle, { color: colors.text }]}>
                        {row.status === 'paid'
                          ? 'Выплата получена'
                          : row.status === 'failed'
                          ? 'Не прошла'
                          : 'Ожидает выплаты'}
                      </Text>
                      <Text style={[styles.historyDate, { color: colors.textMuted }]}>
                        {fmtDate(row.paidAt || row.createdAt)}
                      </Text>
                    </View>
                  </View>
                  <Text
                    style={[
                      styles.historyAmount,
                      { color: row.status === 'paid' ? colors.success : colors.text },
                    ]}
                  >
                    {fmtMoney(row.amount, row.currency || currency)}
                  </Text>
                </View>
              ))
            )}
          </View>

          {/* Bank account placeholder */}
          <TouchableOpacity
            testID="earnings-bank-card"
            activeOpacity={0.8}
            onPress={() => router.push('/inspector/verification')}
            style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <View style={styles.bankRow}>
              <View style={[styles.bankIcon, { backgroundColor: colors.brandSoft }]}>
                <Ionicons name="card" size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardTitle, { color: colors.text }]}>Реквизиты выплат</Text>
                <Text style={[styles.bankHint, { color: colors.textSecondary }]} numberOfLines={2}>
                  {bank?.iban
                    ? `IBAN •••• ${bank.iban.slice(-4)}`
                    : 'Добавьте IBAN, чтобы получать выплаты'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </View>
          </TouchableOpacity>

          {/* Verification warnings — explains why earnings may be 0 */}
          {warnings.length > 0 ? (
            <View
              testID="earnings-warnings-card"
              style={[styles.card, { backgroundColor: colors.warningBg, borderColor: colors.warning }]}
            >
              <View style={styles.warningHeader}>
                <Ionicons name="alert-circle" size={20} color={colors.warning} />
                <Text style={[styles.cardTitle, { color: colors.warning, marginBottom: 0 }]}>
                  Что мешает получать выплаты
                </Text>
              </View>
              {warnings.slice(0, 3).map((w, i) => (
                <Text key={i} style={[styles.warningItem, { color: colors.warning }]}>
                  • {w.message}
                </Text>
              ))}
              <TouchableOpacity
                testID="earnings-fix-verification-btn"
                onPress={() => router.push('/inspector/verification')}
                style={[styles.warningCta, { backgroundColor: colors.warning }]}
                activeOpacity={0.85}
              >
                <Text style={[styles.warningCtaText, { color: colors.onPrimary }]}>
                  Пройти верификацию
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

// ── Workload stat sub-component ──────────────────────────────────
function WorkloadStat({
  icon,
  color,
  bg,
  label,
  value,
  colors,
  testID,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  bg: string;
  label: string;
  value: number;
  colors: any;
  testID: string;
}) {
  return (
    <View style={workloadStyles.cell} testID={testID}>
      <View style={[workloadStyles.iconBox, { backgroundColor: bg }]}>
        <Ionicons name={icon} size={18} color={color} />
      </View>
      <Text style={[workloadStyles.value, { color: colors.text }]}>{value}</Text>
      <Text style={[workloadStyles.label, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

const workloadStyles = StyleSheet.create({
  cell: { flex: 1, alignItems: 'center', gap: 6 },
  iconBox: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: 20, fontWeight: '800', marginTop: 4 },
  label: { fontSize: 12, fontWeight: '600' },
});

// ── Themed stylesheet factory ────────────────────────────────────
const makeStyles = (colors: any, isDark: boolean) =>
  StyleSheet.create({
    screen: { flex: 1 },
    fillCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },

    // Auth / role gate
    gateIcon: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
    gateTitle: { fontSize: 20, fontWeight: '800', textAlign: 'center', marginBottom: 8 },
    gateSub: { fontSize: 14, lineHeight: 20, textAlign: 'center', maxWidth: 280, marginBottom: 24 },
    gateBtn: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14, minWidth: 180, alignItems: 'center' },
    gateBtnText: { fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },

    // Header
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth,
    },
    headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    headerTitle: { fontSize: 17, fontWeight: '800' },

    body: { padding: 16, gap: 14 },

    // Error banner
    errorBanner: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      padding: 12, borderRadius: 12, borderWidth: 1,
    },
    errorBannerText: { flex: 1, fontSize: 13, fontWeight: '600' },

    // Hero card
    heroCard: { borderRadius: 18, borderWidth: 1, padding: 22, alignItems: 'center' },
    heroLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
    heroValue: { fontSize: 44, fontWeight: '800', letterSpacing: -0.5, marginTop: 6 },
    heroMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 18, alignSelf: 'stretch' },
    heroMetaCell: { flex: 1, alignItems: 'center', gap: 4 },
    heroMetaDivider: { width: 1, height: 30, marginHorizontal: 4 },
    heroMetaLabel: { fontSize: 11, fontWeight: '600' },
    heroMetaValue: { fontSize: 18, fontWeight: '800' },

    // Split (pending / paid) cards
    splitRow: { flexDirection: 'row', gap: 12 },
    splitCard: { flex: 1, borderRadius: 16, borderWidth: 1, padding: 16, gap: 6 },
    splitIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
    splitLabel: { fontSize: 12, fontWeight: '700' },
    splitValue: { fontSize: 22, fontWeight: '800', letterSpacing: -0.3 },
    splitHint: { fontSize: 11, fontWeight: '500', marginTop: 2 },

    // Generic card
    card: { borderRadius: 16, borderWidth: 1, padding: 16 },
    cardTitle: { fontSize: 15, fontWeight: '800', marginBottom: 12 },

    // Workload
    workloadRow: { flexDirection: 'row', gap: 8 },

    // History
    emptyHistory: { alignItems: 'center', paddingVertical: 18, gap: 8 },
    emptyHistoryText: { fontSize: 13, fontWeight: '500', textAlign: 'center', maxWidth: 260, lineHeight: 18 },
    historyRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: 12,
    },
    historyLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
    historyDot: { width: 10, height: 10, borderRadius: 5 },
    historyTitle: { fontSize: 14, fontWeight: '700' },
    historyDate: { fontSize: 12, marginTop: 2, fontWeight: '500' },
    historyAmount: { fontSize: 15, fontWeight: '800' },

    // Bank
    bankRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    bankIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    bankHint: { fontSize: 12, fontWeight: '500', marginTop: 2 },

    // Warnings
    warningHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
    warningItem: { fontSize: 13, fontWeight: '600', lineHeight: 19, marginTop: 4 },
    warningCta: { marginTop: 14, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
    warningCtaText: { fontSize: 14, fontWeight: '800' },
  });

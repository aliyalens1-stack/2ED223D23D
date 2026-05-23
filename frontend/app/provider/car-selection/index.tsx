/**
 * Car-Selection-3 — Provider Workspace · List "Assigned to me".
 *
 * Hard invariants (mirrors /api/provider/car-selection/me):
 *   1. Provider sees ONLY their own assignments. Server enforces by
 *      filtering on assignedProviderId == user_id. There is no route
 *      to a "global queue" — admin queue lives in the admin panel.
 *   2. Frozen customer brief — list shows only meta (type/city/status);
 *      the full description appears on the detail screen and is never
 *      editable.
 *   3. List-only screen — no actions here. Buttons live on detail
 *      page where the lifecycle context is unambiguous.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { api } from '../../../src/services/api';
import { useAuth } from '../../../src/context/AuthContext';
import { useThemeContext } from '../../../src/context/ThemeContext';
import { tokens } from '../../../src/theme/tokens';
import { mapCarSelectionError } from '../../../src/i18n/carSelectionErrors';
import CarSelectionInboxBell from '../../../src/components/CarSelectionInboxBell';
import i18n from '../../../src/i18n';

// ── Types — mirrors backend response shape ────────────────────────────

type ServiceType =
  | 'budget_search'
  | 'market_search'
  | 'negotiation_help'
  | 'listing_review';

type CSStatus =
  | 'submitted'
  | 'reviewing'
  | 'assigned'
  | 'in_progress'
  | 'waiting_customer'
  | 'completed'
  | 'cancelled';

interface CSRequest {
  id: string;
  customerId: string;
  serviceType: ServiceType;
  countryCode: string;
  cityId: string;
  description: string;
  sourceLink?: string | null;
  status: CSStatus;
  assignedProviderId?: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: Array<{ at: string; type: string }>;
}

interface MeResponse {
  items: CSRequest[];
  total: number;
  counts: Record<CSStatus, number>;
}

const SERVICE_LABEL_KEY: Record<ServiceType, string> = {
  budget_search: 'car_selection.service.budget_search',
  market_search: 'car_selection.service.market_search',
  negotiation_help: 'car_selection.service.negotiation_help',
  listing_review: 'car_selection.service.listing_review',
};

const STATUS_LABEL_KEY: Record<CSStatus, string> = {
  submitted: 'car_selection.status.submitted',
  reviewing: 'car_selection.status.reviewing',
  assigned: 'car_selection.status.assigned',
  in_progress: 'car_selection.status.in_progress',
  waiting_customer: 'car_selection.status.waiting_customer',
  completed: 'car_selection.status.completed',
  cancelled: 'car_selection.status.cancelled',
};

const C = tokens.colors;

function statusTone(s: CSStatus): string {
  switch (s) {
    case 'assigned':         return C.warning;     // amber — needs my action
    case 'in_progress':      return C.success;     // green — active
    case 'waiting_customer': return C.brand;       // brand — context switch
    case 'completed':        return C.success;
    case 'cancelled':        return C.error;
    default:                 return C.warning;
  }
}

function formatRelative(iso?: string, agoLabel = 'ago'): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!t) return '';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${agoLabel}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${agoLabel}`;
  return `${Math.floor(h / 24)}d ${agoLabel}`;
}

export default function ProviderCarSelectionList() {
  const { t } = useTranslation();
  const router = useRouter();
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  const { isDark } = useThemeContext();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);

  const [items, setItems] = useState<CSRequest[]>([]);
  const [counts, setCounts] = useState<Record<CSStatus, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    try {
      const { data } = await api.get<MeResponse>('/provider/car-selection/me');
      setItems(data.items || []);
      setCounts(data.counts);
      setError(null);
    } catch (e: any) {
      const code = e?.response?.status;
      if (code === 403) {
        setError(i18n.t('car_selection.error.FORBIDDEN_PROVIDER'));
      } else {
        setError(mapCarSelectionError(t, e) || i18n.t('car_selection.list_load_failed'));
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    fetchItems();
  }, [authLoading, isAuthenticated, fetchItems]);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)' as any);
  }, [router]);

  // Group by status — execution lane first, then assigned, then closed.
  const grouped = useMemo(() => {
    const order: CSStatus[] = ['assigned', 'in_progress', 'waiting_customer', 'completed', 'cancelled'];
    const out: Array<{ status: CSStatus; list: CSRequest[] }> = [];
    for (const s of order) {
      const list = items.filter((i) => i.status === s);
      if (list.length) out.push({ status: s, list });
    }
    return out;
  }, [items]);

  const totalActive = useMemo(
    () => items.filter((i) => i.status === 'assigned' || i.status === 'in_progress' || i.status === 'waiting_customer').length,
    [items],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header} testID="pcs-header">
        <View style={styles.headerTopRow}>
          <TouchableOpacity
            onPress={handleBack}
            hitSlop={12}
            activeOpacity={0.7}
            style={styles.backBtn}
            testID="pcs-back-btn"
          >
            <Ionicons name="chevron-back" size={22} color={isDark ? C.textDark : C.textLight} />
            <Text style={styles.backText}>{t('car_selection.back')}</Text>
          </TouchableOpacity>
          {/* Phase 9 — provider parity with customer bell discipline
              (Phase 8.1 Hybrid U4). Count-only, no dropdown, no
              realtime. Same component, same polling cadence, same
              401/403 silent fallback as on customer surfaces. */}
          <View style={{ marginLeft: 'auto' }}>
            <CarSelectionInboxBell testID="pcs-cs-inbox-bell" />
          </View>
        </View>

        <Text style={styles.title}>{t('car_selection.list.title')}</Text>
        <Text style={styles.subtitle}>
          {t('car_selection.list.subtitle')}
        </Text>

        {counts && (
          <View style={styles.kpiRow} testID="pcs-kpi-row">
            <KpiTile
              num={totalActive}
              label={t('car_selection.kpi.active')}
              tone={totalActive > 0 ? C.success : undefined}
              styles={styles}
              tid="pcs-kpi-active"
            />
            <KpiTile
              num={counts.assigned}
              label={t('car_selection.kpi.new')}
              tone={counts.assigned > 0 ? C.warning : undefined}
              styles={styles}
              tid="pcs-kpi-new"
            />
            <KpiTile
              num={counts.waiting_customer}
              label={t('car_selection.kpi.wait')}
              tone={counts.waiting_customer > 0 ? C.brand : undefined}
              styles={styles}
              tid="pcs-kpi-wait"
            />
            <KpiTile
              num={counts.completed}
              label={t('car_selection.kpi.done')}
              styles={styles}
              tid="pcs-kpi-done"
            />
          </View>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              fetchItems();
            }}
            tintColor={C.brand}
          />
        }
        testID="pcs-scroll"
      >
        {loading && (
          <View style={styles.center} testID="pcs-loading">
            <ActivityIndicator color={C.brand} />
            <Text style={styles.dim}>{t('car_selection.list.loading')}</Text>
          </View>
        )}

        {!loading && error && (
          <View style={styles.center} testID="pcs-error">
            <Ionicons name="alert-circle" size={28} color={C.error} />
            <Text style={[styles.dim, { color: C.error, textAlign: 'center' }]}>{error}</Text>
          </View>
        )}

        {!loading && !error && items.length === 0 && (
          <View style={styles.center} testID="pcs-empty">
            <Ionicons name="briefcase-outline" size={32} color={isDark ? C.subtextDark : C.subtextLight} />
            <Text style={styles.dim}>{t('car_selection.list.empty')}</Text>
            <Text style={styles.dimSmall}>
              {t('car_selection.list.empty_hint')}
            </Text>
          </View>
        )}

        {!loading && !error && grouped.map(({ status, list }) => (
          <View key={status} style={styles.group} testID={`pcs-group-${status}`}>
            <View style={styles.groupHeader}>
              <View style={[styles.dot, { backgroundColor: statusTone(status) }]} />
              <Text style={styles.groupTitle}>{t(STATUS_LABEL_KEY[status])}</Text>
              <View style={styles.groupCount}>
                <Text style={styles.groupCountText}>{list.length}</Text>
              </View>
            </View>
            {list.map((r) => (
              <RequestCard
                key={r.id}
                req={r}
                styles={styles}
                onPress={() => router.push(`/provider/car-selection/${r.id}` as any)}
              />
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── KPI tile ──────────────────────────────────────────────────────────

function KpiTile({
  num, label, tone, styles, tid,
}: { num: number; label: string; tone?: string; styles: ReturnType<typeof makeStyles>; tid: string }) {
  return (
    <View style={styles.kpi} testID={tid}>
      <Text style={[styles.kpiNum, tone ? { color: tone } : null]}>{num}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
    </View>
  );
}

// ── Card ──────────────────────────────────────────────────────────────

function RequestCard({
  req, styles, onPress,
}: { req: CSRequest; styles: ReturnType<typeof makeStyles>; onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      activeOpacity={0.75}
      testID={`pcs-card-${req.id}`}
    >
      <View style={[styles.statusStrip, { backgroundColor: statusTone(req.status) }]} />
      <View style={styles.cardBody}>
        <View style={styles.cardTopRow}>
          <View style={styles.kindPill}>
            <Text style={styles.kindPillText}>{t(SERVICE_LABEL_KEY[req.serviceType])}</Text>
          </View>
          <Text style={styles.cardTimeAgo}>{formatRelative(req.updatedAt, t('car_selection.list.ago'))}</Text>
        </View>
        <Text style={styles.cardLocation}>
          <Ionicons name="location-outline" size={13} />
          {' '}{req.countryCode}/{req.cityId}
        </Text>
        <Text style={styles.cardDescription} numberOfLines={2}>
          {req.description}
        </Text>
        <View style={styles.cardFooter}>
          <Text style={[styles.statusLabel, { color: statusTone(req.status) }]}>
            {t(STATUS_LABEL_KEY[req.status]).toUpperCase()}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={statusTone(req.status)} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const S = tokens.spacing;
const R = tokens.radius;

function makeStyles(isDark: boolean) {
  const bg        = isDark ? C.bgDark        : C.bgLight;
  const card      = isDark ? C.cardDark      : C.cardLight;
  const text      = isDark ? C.textDark      : C.textLight;
  const subtext   = isDark ? C.subtextDark   : C.subtextLight;
  const border    = isDark ? C.borderDark    : C.borderLight;
  const brandSoft = isDark ? C.brandSoftDark : C.brandSoftLight;

  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: bg },
    header: {
      paddingHorizontal: S.md,
      paddingTop: S.xs,
      paddingBottom: S.md,
      backgroundColor: card,
      borderBottomWidth: 1,
      borderBottomColor: border,
    },
    headerTopRow: {
      height: 36,
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: S.xs,
    },
    backBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 4,
      paddingHorizontal: 4,
      marginLeft: -4,
      gap: 2,
    },
    backText: { fontSize: 15, fontWeight: '500', color: text },
    title: { fontSize: tokens.typography.h2, fontWeight: '700', color: text },
    subtitle: { fontSize: tokens.typography.caption, color: subtext, marginTop: 2 },

    kpiRow: { flexDirection: 'row', gap: S.xs + 2, marginTop: S.sm + 2 },
    kpi: {
      flex: 1,
      backgroundColor: bg,
      borderRadius: R.sm,
      paddingVertical: S.sm,
      paddingHorizontal: S.xs + 2,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: border,
    },
    kpiNum: { fontSize: 22, fontWeight: '800', color: text },
    kpiLabel: { fontSize: tokens.typography.micro, color: subtext, marginTop: 2, textAlign: 'center' },

    scroll: { padding: S.md, paddingBottom: S.xxl + 32 },
    center: { paddingVertical: S.xxl, alignItems: 'center', gap: S.sm },
    dim: { color: subtext, fontSize: tokens.typography.caption + 1, textAlign: 'center' },
    dimSmall: { color: subtext, fontSize: tokens.typography.micro, textAlign: 'center', maxWidth: 280 },

    group: { marginBottom: S.lg },
    groupHeader: { flexDirection: 'row', alignItems: 'center', gap: S.xs + 2, marginBottom: S.sm },
    dot: { width: 10, height: 10, borderRadius: 5 },
    groupTitle: { fontSize: tokens.typography.h3, fontWeight: '700', color: text, flex: 1 },
    groupCount: {
      backgroundColor: border,
      borderRadius: R.sm,
      paddingHorizontal: S.xs + 2,
      paddingVertical: 2,
      minWidth: 26,
      alignItems: 'center',
    },
    groupCountText: { fontSize: tokens.typography.caption, fontWeight: '700', color: subtext },

    card: {
      backgroundColor: card,
      borderRadius: R.md,
      marginBottom: S.sm + 2,
      borderWidth: 1,
      borderColor: border,
      overflow: 'hidden',
    },
    statusStrip: { height: 3, width: '100%' },
    cardBody: { padding: S.md },
    cardTopRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: S.xs + 2,
    },
    kindPill: {
      backgroundColor: brandSoft,
      borderRadius: R.sm - 2,
      paddingHorizontal: S.xs + 2,
      paddingVertical: 3,
    },
    kindPillText: {
      fontSize: tokens.typography.micro,
      fontWeight: '800',
      color: C.brandDark,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    cardTimeAgo: { fontSize: tokens.typography.micro, color: subtext },
    cardLocation: {
      fontSize: tokens.typography.caption + 1,
      color: text,
      fontWeight: '600',
      marginBottom: S.xs,
    },
    cardDescription: {
      fontSize: tokens.typography.caption + 1,
      color: subtext,
      lineHeight: 18,
      marginBottom: S.sm,
    },
    cardFooter: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: S.xs + 2,
      borderTopWidth: 1,
      borderTopColor: border,
    },
    statusLabel: {
      fontSize: tokens.typography.micro,
      fontWeight: '800',
      letterSpacing: 0.6,
    },
  });
}

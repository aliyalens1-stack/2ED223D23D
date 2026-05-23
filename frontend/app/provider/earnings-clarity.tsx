/**
 * Mobile Provider Earnings Clarity — surface twin of web ProviderEarningsClarity.
 *
 * Doctrine carry-over (see /app/memory/PRD.md, Phase 3.1):
 *   "What does provider believe about money?"
 *   work completed ≠ client paid ≠ provider earned ≠ provider paid out
 *
 * Provider Mobile Parity discipline:
 *   - SAME backend endpoint: GET /api/provider/earnings/items
 *   - SAME shared contract:  @platform/domain/contracts/provider-earnings-item
 *   - SAME six states. lead_fee → state='deducted', NEVER 'paid_out'.
 *   - Currencies NEVER auto-sum.
 *   - NO payout button. Read-only.
 *
 * Visual rule (tokens.ts):
 *   amber = primary,  green = positive flow,  red = held/error,  slate = neutral/passive.
 */
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import i18n from '../../src/i18n';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/services/api';
import { useAuth } from '../../src/context/AuthContext';
import { tokens } from '../../src/theme/tokens';
import { useThemeContext } from '../../src/context/ThemeContext';

import type {
  ProviderEarningsItem,
  ProviderEarningsItemState,
  ProviderEarningsCurrencyBucket,
  ProviderEarningsItemsResponse,
} from '@platform/domain/contracts/provider-earnings-item';

interface ViewerPersona {
  displayName: string;
  kind: string;
  organizationName?: string | null;
  slug?: string | null;
}
type EarningsResponseWithViewer = ProviderEarningsItemsResponse & { viewer?: ViewerPersona };

const C = tokens.colors;
const S = tokens.spacing;
const R = tokens.radius;
const T = tokens.typography;

const KIND_LABEL: Record<string, string> = {
  inspector: 'Inspector',
  service_provider: 'Service Provider',
  dealer: 'Dealer',
  transport: 'Transport',
  transport_provider: 'Transport',
  customer: 'Customer',
  admin: 'Admin',
};

const STATE_GROUPS: Array<{ state: ProviderEarningsItemState; label: string; helper: string }> = [
  { state: 'disputed_hold', label: i18n.t('provider.uderzhano'),         helper: i18n.t('provider.spor_ili_vozvrat_dengi_ne_dvigayutsya') },
  { state: 'payable',       label: i18n.t('provider.gotovo_k_vyplate'), helper: i18n.t('provider.u_platformy_zhdut_perevoda') },
  { state: 'pending',       label: i18n.t('provider.zhdem_oplaty'),      helper: i18n.t('provider.klient_esche_ne_oplatil') },
  { state: 'processing',    label: i18n.t('provider.v_obrabotke'),      helper: i18n.t('provider.vyplata_zapuschena') },
  { state: 'paid_out',      label: i18n.t('provider.vyplacheno'),        helper: i18n.t('provider.dengi_u_vas') },
  { state: 'deducted',      label: i18n.t('provider.spisaniya'),         helper: i18n.t('provider.platezhi_za_lidy') },
];

// State → semantic colour. Theme-invariant for action states; the
// two neutral states (paid_out / deducted) follow the surface theme.
function stateColors(isDark: boolean): Record<ProviderEarningsItemState, string> {
  const neutral = isDark ? C.subtextDark : C.subtextLight;
  return {
    disputed_hold: C.error,      // red — held / dispute
    payable:       C.success,    // green — ready to pay out
    pending:       C.warning,    // amber — awaiting customer
    processing:    C.brand,      // brand amber — platform in motion
    paid_out:      neutral,      // neutral — already in your hands
    deducted:      neutral,      // neutral — lead fee, no actionable signal
  };
}

// Module-level light defaults — used by sub-components rendered
// outside the main themed component scope. Sub-component theme
// parity is a deferred follow-up.
const STATE_COLOR: Record<ProviderEarningsItemState, string> = stateColors(false);

const SUMMARY_TILES: Array<{ state: ProviderEarningsItemState; label: string }> = [
  { state: 'disputed_hold', label: i18n.t('provider.uderzhano') },
  { state: 'payable',       label: i18n.t('provider.k_vyplate') },
  { state: 'pending',       label: i18n.t('provider.zhdem_oplaty') },
  { state: 'deducted',      label: i18n.t('provider.spisano') },
];

const CONTACT_LABEL: Record<'support' | 'admin' | 'customer', string> = {
  support: i18n.t('provider.napisat_v_podderzhku'),
  admin: i18n.t('provider.svyazatsya_s_adminom'),
  customer: i18n.t('provider.svyazatsya_s_klientom'),
};

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return i18n.t('provider.seconds_s_nazad');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return i18n.t('provider.minutes_min_nazad');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n.t('provider.hours_ch_nazad');
  return i18n.t('provider.math_floor_hours_24_dn_nazad');
}

function formatMoney(amount: number, currency: string): string {
  const sign = amount < 0 ? '−' : '';
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${sign}${formatted} ${currency}`;
}

function pluralPositions(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return i18n.t('provider.poziciya');
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return i18n.t('provider.pozicii');
  return i18n.t('provider.pozicij');
}

function formatExpected(iso?: string): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!t) return null;
  const days = Math.ceil((t - Date.now()) / (1000 * 60 * 60 * 24));
  if (days < 0) return i18n.t('provider.math_abs_days_dn_prosrocheno');
  if (days === 0) return i18n.t('provider.segodnya');
  return i18n.t('provider.cherez_days_dn');
}

export default function MobileProviderEarningsClarity() {
  const { t } = useTranslation();
  // Theme-aware styling — see makeStyles(isDark) below.
  const { isDark } = useThemeContext();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);
  const STATE_COLOR_THEMED = useMemo(() => stateColors(isDark), [isDark]);
  const router = useRouter();
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  const [data, setData] = useState<EarningsResponseWithViewer | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<ProviderEarningsItemState | 'all'>('all');
  const mountedRef = useRef(true);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/profile');
  }, [router]);

  const fetchData = useCallback(async () => {
    try {
      const { data } = await api.get<ProviderEarningsItemsResponse>('/provider/earnings/items');
      if (mountedRef.current) {
        setData(data);
        setError(null);
      }
    } catch (e: any) {
      if (mountedRef.current) {
        setError(e?.response?.data?.message || i18n.t('provider.ne_udalos_zagruzit_earnings'));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (authLoading) return;
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    fetchData();
    return () => {
      mountedRef.current = false;
    };
  }, [authLoading, isAuthenticated, fetchData]);

  const filteredItems = useMemo(() => {
    if (!data) return [];
    if (stateFilter === 'all') return data.items;
    return data.items.filter((it) => it.state === stateFilter);
  }, [data, stateFilter]);

  const grouped = useMemo(() => {
    const m = new Map<ProviderEarningsItemState, ProviderEarningsItem[]>();
    for (const it of filteredItems) {
      const list = m.get(it.state) || [];
      list.push(it);
      m.set(it.state, list);
    }
    return m;
  }, [filteredItems]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header}>
        <View style={styles.headerTopRow}>
          <TouchableOpacity
            onPress={handleBack}
            hitSlop={12}
            activeOpacity={0.7}
            style={styles.backBtn}
            testID="mobile-earnings-back"
          >
            <Ionicons name="chevron-back" size={22} color={(isDark ? C.textDark : C.textLight)} />
            <Text style={styles.backText}>{t('inspector.nazad_2')}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.title}>{t('provider.gde_moi_dengi')}</Text>
        <Text style={styles.subtitle}>
          За последние 90 дней. Каждая валюта — отдельная реальность; ничего не складывается.
        </Text>

        {data?.viewer && (
          <View style={styles.personaBar} testID="mobile-earnings-persona">
            <Text style={styles.personaLabel}>{t('provider.platezhi_uchityvayutsya_dlya')}</Text>
            <Text style={styles.personaName} numberOfLines={1}>
              {data.viewer.organizationName ?? data.viewer.displayName}
            </Text>
            <Text style={styles.personaOrg} numberOfLines={1}>
              {data.viewer.displayName}
              {data.viewer.kind ? ` · ${KIND_LABEL[data.viewer.kind] ?? data.viewer.kind}` : ''}
            </Text>
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
              fetchData();
            }}
            tintColor={C.brand}
          />
        }
        testID="mobile-earnings-clarity"
      >
        {loading && (
          <View style={styles.center} testID="mobile-earnings-loading">
            <ActivityIndicator color={C.brand} />
            <Text style={styles.dim}>{t('provider.schitaem_earnings')}</Text>
          </View>
        )}

        {error && !loading && (
          <View style={styles.center} testID="mobile-earnings-error">
            <Text style={[styles.dim, { color: C.error }]}>{error}</Text>
          </View>
        )}

        {!loading && !error && data && data.summary.byCurrency.length === 0 && (
          <View style={styles.center} testID="mobile-earnings-empty">
            <Text style={styles.dim}>{t('provider.za_90_dnej_net_zavershennyh_zakazov')}</Text>
          </View>
        )}

        {data?.summary.byCurrency.map((bucket) => (
          <CurrencyCard
            key={bucket.currency}
            bucket={bucket}
            activeFilter={stateFilter}
            onTilePress={(state) => setStateFilter((s) => (s === state ? 'all' : state))}
            styles={styles}
            isDark={isDark}
          />
        ))}

        {data && stateFilter !== 'all' && (
          <View style={styles.filterBar} testID="mobile-earnings-filter-active">
            <Text style={styles.filterText}>
              Только:{' '}
              <Text style={{ fontWeight: '700' }}>
                {STATE_GROUPS.find((g) => g.state === stateFilter)?.label}
              </Text>
            </Text>
            <TouchableOpacity
              onPress={() => setStateFilter('all')}
              testID="mobile-earnings-filter-clear"
            >
              <Text style={styles.filterClear}>{t('provider.pokazat_vse')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {STATE_GROUPS.map(({ state, label, helper }) => {
          const list = grouped.get(state) || [];
          if (list.length === 0) return null;
          return (
            <View key={state} style={styles.group} testID={`mobile-earnings-group-${state}`}>
              <View style={styles.groupHeader}>
                <View style={[styles.dot, { backgroundColor: STATE_COLOR[state] }]} />
                <Text style={styles.groupTitle}>{label}</Text>
                <View style={styles.groupCount}>
                  <Text style={styles.groupCountText}>{list.length}</Text>
                </View>
              </View>
              <Text style={styles.groupHelper}>{helper}</Text>
              {list.map((it) => (
                <EarningsRow key={it.id} item={it} styles={styles} isDark={isDark} />
              ))}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

interface CurrencyCardProps {
  bucket: ProviderEarningsCurrencyBucket;
  activeFilter: ProviderEarningsItemState | 'all';
  onTilePress: (state: ProviderEarningsItemState) => void;
}

function CurrencyCard({ bucket, activeFilter, onTilePress, styles, isDark }: CurrencyCardProps & { styles: any; isDark: boolean }) {
  // Aggregate ONLY within the same currency. payable+pending = t('provider.chto_v_dvizhenii');
  // disputed_hold and deducted stay separate (см. doctrine).
  const inMotion = (bucket.payable?.net ?? 0) + (bucket.pending?.net ?? 0);
  const brandSoft = isDark ? C.brandSoftDark : C.brandSoftLight;
  const subtext = isDark ? C.subtextDark : C.subtextLight;

  return (
    <View style={styles.summaryCard} testID={`mobile-earnings-summary-${bucket.currency}`}>
      <View style={styles.summaryHeader}>
        <View style={styles.summaryHeaderLeft}>
          <Text style={styles.summaryCurrency}>{bucket.currency}</Text>
          <Text style={styles.summaryHelper}>{t('provider.otdelnaya_valyuta_ne_summiruetsya')}</Text>
        </View>
        <View style={styles.summaryHeaderRight}>
          <Text style={styles.summaryInMotionLabel}>{t('provider.v_dvizhenii')}</Text>
          <Text style={styles.summaryInMotionValue}>
            {formatMoney(inMotion, bucket.currency)}
          </Text>
        </View>
      </View>

      <View style={styles.tilesGrid}>
        {SUMMARY_TILES.map(({ state, label }) => {
          const v = bucket[state];
          const active = activeFilter === state;
          const isHeld = state === 'disputed_hold';
          const isDeducted = state === 'deducted';
          return (
            <TouchableOpacity
              key={state}
              onPress={() => onTilePress(state)}
              activeOpacity={0.75}
              style={[
                styles.tile,
                active && {
                  borderColor: STATE_COLOR[state],
                  borderWidth: 2,
                  backgroundColor: brandSoft,
                },
              ]}
              testID={`mobile-earnings-summary-tile-${bucket.currency}-${state}`}
            >
              <View style={styles.tileLabelRow}>
                <View style={[styles.tileDot, { backgroundColor: STATE_COLOR[state] }]} />
                <Text style={styles.tileLabel} numberOfLines={1}>
                  {label}
                </Text>
              </View>
              <Text
                style={[
                  styles.tileNet,
                  isHeld && { color: C.error },
                  isDeducted && v.net < 0 && { color: subtext },
                ]}
                numberOfLines={1}
              >
                {formatMoney(v.net, bucket.currency)}
              </Text>
              <Text style={styles.tileCount}>
                {v.count} {pluralPositions(v.count)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function EarningsRow({ item, styles, isDark }: { item: ProviderEarningsItem; styles: any; isDark: boolean }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const isNegative = item.amount.net < 0;
  const expected = item.state === 'payable' ? formatExpected(item.expectedSettlementBy) : null;
  const canExpand = item.amount.gross > 0 || item.amount.fee > 0;
  const themedText = isDark ? C.textDark : C.textLight;

  return (
    <View style={styles.row} testID={`mobile-earnings-item-${item.id}`}>
      <View style={styles.rowMain}>
        <View style={{ flex: 1, marginRight: S.xs + 2 }}>
          <View style={styles.rowLabelRow}>
            <View style={styles.kindPill}>
              <Text style={styles.kindPillText}>
                {item.kind === 'lead_fee' ? t('provider.lid') : t('provider.zakaz')}
              </Text>
            </View>
            <Text style={styles.rowLabel} numberOfLines={1}>
              {item.service.label}
            </Text>
          </View>
          {item.service.customerName && (
            <Text style={styles.rowCustomer} numberOfLines={1}>
              {item.service.customerName}
            </Text>
          )}
          <Text style={styles.rowMeta}>
            {formatRelative(item.recognizedAt)}
            {expected ? ` · ожидается ${expected}` : ''}
          </Text>
        </View>
        <View style={styles.rowAmounts}>
          <Text
            style={[styles.rowNet, { color: isNegative ? C.error : themedText }]}
            testID={`mobile-earnings-item-net-${item.id}`}
          >
            {formatMoney(item.amount.net, item.amount.currency)}
          </Text>
          {canExpand && (
            <TouchableOpacity
              onPress={() => setExpanded((v) => !v)}
              testID={`mobile-earnings-item-expand-${item.id}`}
              hitSlop={6}
            >
              <Text style={styles.rowExpander}>
                {expanded ? t('provider.svernut') : t('provider.razbivka')}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {expanded && (
        <View style={styles.breakdown} testID={`mobile-earnings-item-breakdown-${item.id}`}>
          {item.kind === 'job' ? (
            <>
              <View style={styles.breakdownRow}>
                <Text style={styles.breakdownLabel}>{t('provider.klient_platit_gross')}</Text>
                <Text style={styles.breakdownValue}>
                  {formatMoney(item.amount.gross, item.amount.currency)}
                </Text>
              </View>
              <View style={styles.breakdownRow}>
                <Text style={styles.breakdownLabel}>{t('provider.komissiya_uderzhaniya')}</Text>
                <Text style={[styles.breakdownValue, { color: C.error }]}>
                  −{formatMoney(item.amount.fee, item.amount.currency).replace('−', '')}
                </Text>
              </View>
              <View style={[styles.breakdownRow, styles.breakdownTotal]}>
                <Text style={styles.breakdownLabelStrong}>{t('provider.chistymi')}</Text>
                <Text style={styles.breakdownValueStrong}>
                  {formatMoney(item.amount.net, item.amount.currency)}
                </Text>
              </View>
            </>
          ) : (
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownLabel}>{t('provider.spisano_platformoj_za_lid')}</Text>
              <Text style={[styles.breakdownValue, { color: C.error }]}>
                {formatMoney(item.amount.net, item.amount.currency)}
              </Text>
            </View>
          )}
        </View>
      )}

      {item.blockedReason && (
        <View style={styles.blockedBox} testID={`mobile-earnings-item-blocked-${item.id}`}>
          <Text style={styles.blockedTitle}>{t('provider.chto_meshaet')}</Text>
          <Text style={styles.blockedMessage}>{item.blockedReason.message}</Text>
          <TouchableOpacity
            style={styles.blockedBtn}
            testID={`mobile-earnings-item-contact-${item.blockedReason.contactWho}-${item.id}`}
            activeOpacity={0.75}
            onPress={() => {
              const who = item.blockedReason!.contactWho;
              const issue = item.blockedReason!.message;
              const ref = `Earnings ${item.id} (${item.service.label})`;
              const subject = who === 'customer' ? i18n.t('provider.soobschenie_klientu_po_ref') : i18n.t('provider.uderzhanie_spor_ref');
              const messageBody = i18n.t('provider.chto_meshaet_issue_n_npoziciya_ref');
              const category = who === 'customer' ? 'general' : who === 'admin' ? 'admin' : 'general';
              router.push({
                pathname: '/support',
                params: { subject, message: messageBody, category },
              } as any);
            }}
          >
            <Text style={styles.blockedBtnText}>
              {CONTACT_LABEL[item.blockedReason.contactWho]}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function makeStyles(isDark: boolean) {
  // ── Theme-aware token swap (Day 5 audit, 2026-05-15).
  //   *Light → *Dark when isDark; semantic colours (brand/success/
  //   warning/error) are intentionally theme-invariant.
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
  headerTopRow: { height: 36, flexDirection: 'row', alignItems: 'center', marginBottom: S.xs },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 4,
    marginLeft: -4,
    gap: 2,
  },
  backText: { fontSize: 15, fontWeight: '500', color: text },

  title: { fontSize: T.h2, fontWeight: '700', color: text },
  subtitle: { fontSize: T.caption - 1, color: subtext, marginTop: 4, lineHeight: 18 },

  personaBar: {
    marginTop: S.sm + 2,
    paddingHorizontal: S.sm,
    paddingVertical: S.xs + 2,
    backgroundColor: brandSoft,
    borderRadius: R.sm,
    borderLeftWidth: 3,
    borderLeftColor: C.success,
  },
  personaLabel: {
    fontSize: T.micro,
    color: subtext,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  personaName: { fontSize: T.body - 1, color: text, fontWeight: '700', marginTop: 2 },
  personaOrg: { fontSize: T.caption - 1, color: subtext, marginTop: 2 },

  scroll: { padding: S.md, paddingBottom: S.xxl + 32 },
  center: { paddingVertical: S.xxl, alignItems: 'center', gap: S.sm },
  dim: { color: subtext, fontSize: T.caption + 1 },

  summaryCard: {
    backgroundColor: card,
    borderRadius: R.md - 2,
    padding: S.md - 2,
    marginBottom: S.sm + 2,
    borderWidth: 1,
    borderColor: border,
  },
  summaryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: S.sm + 2,
    gap: S.sm,
  },
  summaryHeaderLeft: { flexShrink: 1 },
  summaryHeaderRight: { alignItems: 'flex-end' },
  summaryCurrency: { fontSize: T.h3, fontWeight: '800', color: text, letterSpacing: 0.5 },
  summaryHelper: { fontSize: T.micro, color: subtext, marginTop: 2 },
  summaryInMotionLabel: {
    fontSize: T.micro,
    color: subtext,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '700',
  },
  summaryInMotionValue: { fontSize: T.h3, fontWeight: '800', color: text, marginTop: 2 },

  // 2 × 2 fixed grid. flexBasis 48% leaves room for `gap: S.xs+2`
  // and keeps tiles equal width on every viewport (no wrapping flicker on web).
  tilesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: S.xs + 2,
    columnGap: S.xs + 2,
  },
  tile: {
    flexBasis: '48%',
    flexGrow: 1,
    minWidth: 130,
    backgroundColor: bg,
    borderRadius: R.sm,
    paddingVertical: S.sm,
    paddingHorizontal: S.sm,
    borderWidth: 1,
    borderColor: border,
  },
  tileLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  tileDot: { width: 8, height: 8, borderRadius: 4 },
  tileLabel: {
    fontSize: T.micro,
    color: subtext,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontWeight: '700',
    flexShrink: 1,
  },
  tileNet: { fontSize: T.body + 1, fontWeight: '800', color: text },
  tileCount: { fontSize: T.micro, color: subtext, marginTop: 2 },

  filterBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: brandSoft,
    borderRadius: R.sm,
    paddingHorizontal: S.sm + 2,
    paddingVertical: S.xs + 2,
    marginBottom: S.sm + 2,
    borderWidth: 1,
    borderColor: C.brandSoftDark,
  },
  filterText: { fontSize: T.caption, color: text },
  filterClear: {
    fontSize: T.caption,
    color: C.brandDark,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },

  group: { marginBottom: S.md },
  groupHeader: { flexDirection: 'row', alignItems: 'center', gap: S.xs + 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  groupTitle: { fontSize: T.h3, fontWeight: '700', color: text, flex: 1 },
  groupCount: {
    backgroundColor: border,
    borderRadius: R.sm,
    paddingHorizontal: S.xs + 2,
    paddingVertical: 2,
    minWidth: 26,
    alignItems: 'center',
  },
  groupCountText: { fontSize: T.caption, fontWeight: '700', color: subtext },
  groupHelper: {
    fontSize: T.caption - 1,
    color: subtext,
    marginTop: 2,
    marginBottom: S.sm,
  },

  row: {
    backgroundColor: card,
    borderRadius: R.sm,
    padding: S.sm + 2,
    marginBottom: S.xs + 2,
    borderWidth: 1,
    borderColor: border,
  },
  rowMain: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  kindPill: {
    backgroundColor: brandSoft,
    borderRadius: R.sm - 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  kindPillText: {
    fontSize: T.micro - 1,
    fontWeight: '800',
    color: C.brandDark,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  rowLabel: { flexShrink: 1, fontSize: T.caption + 1, fontWeight: '600', color: text },
  rowCustomer: { fontSize: T.caption, color: subtext, marginTop: 2 },
  rowMeta: { fontSize: T.micro, color: subtext, marginTop: 4 },
  rowAmounts: { alignItems: 'flex-end', gap: 4 },
  rowNet: { fontSize: T.body + 1, fontWeight: '800' },
  rowExpander: {
    fontSize: T.micro,
    color: C.brandDark,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },

  breakdown: {
    marginTop: S.sm,
    padding: S.sm,
    backgroundColor: bg,
    borderRadius: R.sm - 2,
    borderWidth: 1,
    borderColor: border,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  breakdownTotal: {
    marginTop: 4,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: border,
  },
  breakdownLabel: { fontSize: T.caption, color: subtext },
  breakdownValue: { fontSize: T.caption, color: text, fontWeight: '600' },
  breakdownLabelStrong: { fontSize: T.caption + 1, color: text, fontWeight: '700' },
  breakdownValueStrong: { fontSize: T.caption + 1, color: text, fontWeight: '800' },

  blockedBox: {
    backgroundColor: 'rgba(239,68,68,0.06)',
    borderColor: 'rgba(239,68,68,0.25)',
    borderWidth: 1,
    borderRadius: R.sm,
    padding: S.sm,
    marginTop: S.sm,
  },
  blockedTitle: {
    fontSize: T.micro,
    fontWeight: '800',
    color: C.error,
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  blockedMessage: { fontSize: T.caption, color: text, marginBottom: S.xs + 2 },
  blockedBtn: {
    borderColor: C.error,
    borderWidth: 1,
    borderRadius: R.sm - 4,
    paddingVertical: 6,
    paddingHorizontal: S.sm,
    alignSelf: 'flex-start',
  },
  blockedBtnText: { fontSize: T.caption, color: C.error, fontWeight: '700' },
});
}
// ── Module-level fallback styles for sub-components (light-mode only).
// Main component uses the themed `useMemo(() => makeStyles(isDark), ...)`
// override which shadows this fallback. Theme parity for the
// module-level sub-components (Section / Field / etc.) is a follow-up
// task — see /app/memory/theme_audit_2026_05_15.md.
const styles = makeStyles(false);


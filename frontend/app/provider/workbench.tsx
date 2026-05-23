/**
 * Mobile Provider Workbench — surface twin of web ProviderWorkbench.
 *
 * Doctrine carry-over (see /app/memory/PRD.md, Phase 1):
 *   "Provider Workbench is not a workflow engine. It is a provider-facing
 *    operational projection over existing truths."
 *
 * Provider Mobile Parity discipline:
 *   - SAME backend endpoint: GET /api/provider/work-items
 *                            POST /api/provider/work-items/{id}/action
 *   - SAME shared contract:  @platform/domain/contracts/provider-work-item
 *   - SAME state vocabulary, SAME verbs, SAME blocked-reason codes.
 *
 * Visual rule (tokens.ts):
 *   amber = primary action,  green = accept/success,  red = error/danger.
 *   Reject is neutral at rest and turns red ONLY on press (no permanent red).
 */
import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Modal,
} from 'react-native';
import i18n from '../../src/i18n';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/services/api';
import { useAuth } from '../../src/context/AuthContext';
import { useThemeContext } from '../../src/context/ThemeContext';
import { tokens } from '../../src/theme/tokens';

import type {
  ProviderWorkItem,
  ProviderWorkItemState,
  ProviderWorkItemActionVerb,
} from '@platform/domain/contracts/provider-work-item';

interface ViewerPersona {
  displayName: string;
  kind: string;
  organizationName?: string | null;
  slug?: string | null;
}

const KIND_LABEL: Record<string, string> = {
  inspector: 'Inspector',
  service_provider: 'Service Provider',
  dealer: 'Dealer',
  transport: 'Transport',
  transport_provider: 'Transport',
  customer: 'Customer',
  admin: 'Admin',
};

const STATE_GROUPS: Array<{ state: ProviderWorkItemState; label: string; helper: string }> = [
  { state: 'needs_response',    label: i18n.t('provider.zhdut_moego_otveta'),   helper: i18n.t('provider.prinyat_ili_otklonit') },
  { state: 'blocked',           label: i18n.t('provider.zablokirovano'),        helper: i18n.t('provider.nuzhen_kontakt') },
  { state: 'in_progress',       label: i18n.t('provider.sejchas_v_rabote'),      helper: i18n.t('provider.aktivnye_zakazy') },
  { state: 'on_site',           label: i18n.t('inspector.na_meste'),             helper: i18n.t('provider.mozhno_nachinat') },
  { state: 'en_route',          label: i18n.t('inspector.v_puti'),               helper: i18n.t('provider.edete_k_klientu') },
  { state: 'report_required',   label: i18n.t('provider.nuzhen_otchet'),          helper: i18n.t('provider.zapolnit_na_meste') },
  { state: 'awaiting_customer', label: i18n.t('provider.zhdem_klienta'),         helper: i18n.t('provider.klient_dolzhen_podtverdit') },
  { state: 'awaiting_review',   label: i18n.t('provider.na_proverke'),          helper: i18n.t('provider.platforma_proveryaet') },
  { state: 'scheduled',         label: i18n.t('provider.zaplanirovano'),        helper: i18n.t('provider.prinyato_bez_dejstvij_sejchas') },
  { state: 'awaiting_payout',   label: i18n.t('provider.zhdem_vyplatu'),         helper: i18n.t('provider.dengi_v_obrabotke') },
  { state: 'completed',         label: i18n.t('inspector.zaversheno'),            helper: i18n.t('provider.za_poslednie_24_chasa') },
];

// State dots are semantic indicators, not action colours.
// Stay strictly within the platform palette:
//   amber  → action required / attention
//   green  → progress / payout / final positive
//   red    → blocked / error
//   slate  → neutral / passive / archival
const C = tokens.colors;

// Status-dot colour map. Semantic colours (brand/warning/error/success)
// are theme-invariant. The neutral/passive/archival states use a
// subtext token — its palette differs between light & dark, hence the
// `isDark`-aware factory so the dot stays legible in both themes.
function stateColors(isDark: boolean): Record<ProviderWorkItemState, string> {
  const neutral = isDark ? C.subtextDark : C.subtextLight;
  return {
    needs_response:    C.warning,     // amber — needs my action
    blocked:           C.error,       // red — only for true blocking
    in_progress:       C.success,     // green — progress
    on_site:           C.success,
    en_route:          C.success,
    report_required:   C.brand,       // brand amber — primary platform attention
    awaiting_customer: neutral,
    awaiting_review:   neutral,
    scheduled:         neutral,
    awaiting_payout:   C.success,
    completed:         neutral,
  };
}

const CONTACT_LABEL: Record<'customer' | 'support' | 'admin', string> = {
  customer: i18n.t('provider.svyazatsya_s_klientom'),
  support:  i18n.t('provider.napisat_v_podderzhku'),
  admin:    i18n.t('provider.svyazatsya_s_adminom'),
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

function formatCountdown(iso?: string): string | null {
  if (!iso) return null;
  const remain = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
  if (remain <= 0) return i18n.t('provider.prosrocheno');
  const m = Math.floor(remain / 60);
  const s = remain % 60;
  return m === 0 ? `${s}s` : `${m}:${s.toString().padStart(2, '0')}`;
}

function formatPrice(p: ProviderWorkItem['priceShown']): string {
  return `${p.amount} ${p.currency}${p.surge && p.surge > 1 ? ` · x${p.surge.toFixed(2)}` : ''}`;
}

interface ConfirmState {
  itemId: string;
  verb: ProviderWorkItemActionVerb;
  label: string;
  serviceLabel: string;
}

export default function MobileProviderWorkbench() {
  const { t } = useTranslation();
  const router = useRouter();
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  // Theme-aware styling — workbench was previously hardcoded to *Light tokens
  // (bgLight/cardLight/textLight/...) which forced light mode regardless of
  // the global theme. Now we swap each *Light → *Dark when `isDark`, so the
  // surface follows the app-wide ThemeContext.
  const { isDark } = useThemeContext();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);
  const [items, setItems] = useState<ProviderWorkItem[]>([]);
  const [viewer, setViewer] = useState<ViewerPersona | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [, setTick] = useState(0);
  const mountedRef = useRef(true);

  // Theme-aware status-dot colour map (memoised — depends only on isDark).
  const STATE_COLOR = useMemo(() => stateColors(isDark), [isDark]);

  // Back navigation:
  //   - if router can go back, do that (preserve stack)
  //   - else fall back to Profile (the canonical entry point)
  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/profile');
    }
  }, [router]);

  const fetchItems = useCallback(async () => {
    try {
      const { data } = await api.get<{ items: ProviderWorkItem[]; viewer?: ViewerPersona }>(
        '/provider/work-items',
      );
      if (mountedRef.current) {
        setItems(data.items || []);
        setViewer(data.viewer || null);
        setError(null);
      }
    } catch (e: any) {
      if (mountedRef.current) {
        setError(e?.response?.data?.message || i18n.t('provider.ne_udalos_zagruzit_rabochij_stol'));
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
    fetchItems();
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [authLoading, isAuthenticated, fetchItems]);

  const callAction = useCallback(
    async (item: ProviderWorkItem, verb: ProviderWorkItemActionVerb) => {
      if (verb === 'submit_report' && item.kind === 'inspection') {
        const rawId = item.id.replace(/^ij_/, '');
        router.push(`/inspector/job/${rawId}/report` as any);
        return;
      }
      setBusyId(item.id);
      try {
        // Sprint: Provider Dispatch Hardening + Action Idempotency.
        // Same (item, verb, epoch-minute) ⇒ same key ⇒ backend short-circuits
        // duplicates within a 60-second window without re-firing side-effects.
        const idemKey = `wb_${item.id}_${verb}_${Math.floor(Date.now() / 60000)}`;
        const { data } = await api.post<{ item?: ProviderWorkItem; removed?: boolean; id?: string }>(
          `/provider/work-items/${encodeURIComponent(item.id)}/action`,
          { verb },
          { headers: { 'Idempotency-Key': idemKey } },
        );
        if (data.removed) {
          setItems((prev) => prev.filter((x) => x.id !== item.id));
        } else if (data.item) {
          setItems((prev) => {
            const idx = prev.findIndex((x) => x.id === item.id);
            if (idx === -1) return [data.item as ProviderWorkItem, ...prev];
            const next = prev.slice();
            next[idx] = data.item as ProviderWorkItem;
            return next;
          });
        }
      } catch (e: any) {
        Alert.alert(i18n.t('provider.dejstvie_ne_vypolneno'), e?.response?.data?.message || i18n.t('inspector.poprobujte_esche_raz'));
      } finally {
        setBusyId(null);
      }
    },
    [router],
  );

  const handlePrimary = useCallback(
    (item: ProviderWorkItem) => {
      const action = item.primaryAction;
      if (!action) return;
      if (action.confirmationRequired) {
        setConfirm({
          itemId: item.id,
          verb: action.verb,
          label: action.label,
          serviceLabel: item.serviceLabel,
        });
        return;
      }
      callAction(item, action.verb);
    },
    [callAction],
  );

  const grouped = useMemo(() => {
    const m = new Map<ProviderWorkItemState, ProviderWorkItem[]>();
    for (const it of items) {
      const list = m.get(it.state) || [];
      list.push(it);
      m.set(it.state, list);
    }
    return m;
  }, [items]);

  const totals = useMemo(
    () => ({
      needsResponse: items.filter((i) => i.state === 'needs_response').length,
      inProgress: items.filter((i) =>
        ['in_progress', 'on_site', 'en_route'].includes(i.state),
      ).length,
      blocked: items.filter((i) => i.state === 'blocked').length,
    }),
    [items],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header} testID="mobile-workbench-header">
        {/* Back affordance — primary discoverability for return flow. */}
        <View style={styles.headerTopRow}>
          <TouchableOpacity
            onPress={handleBack}
            hitSlop={12}
            activeOpacity={0.7}
            style={styles.backBtn}
            testID="mobile-workbench-back"
          >
            <Ionicons name="chevron-back" size={22} color={isDark ? C.textDark : C.textLight} />
            <Text style={styles.backText}>{t('inspector.nazad_2')}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.title}>Workbench</Text>
        <Text style={styles.subtitle}>{t('provider.chto_ot_menya_sejchas_trebuetsya_i_pochemu')}</Text>

        {viewer && (
          <View style={styles.personaBar} testID="mobile-workbench-persona">
            <Text style={styles.personaLabel}>{t('provider.vy_rabotaete_kak')}</Text>
            <Text style={styles.personaName} numberOfLines={1}>
              {viewer.displayName}
              {viewer.kind ? ` · ${KIND_LABEL[viewer.kind] ?? viewer.kind}` : ''}
            </Text>
            {viewer.organizationName ? (
              <Text style={styles.personaOrg} numberOfLines={1}>
                от имени · {viewer.organizationName}
              </Text>
            ) : null}
          </View>
        )}

        <View style={styles.kpiRow}>
          <View style={styles.kpi} testID="mobile-workbench-kpi-needs">
            <Text style={[styles.kpiNum, totals.needsResponse > 0 && { color: C.warning }]}>
              {totals.needsResponse}
            </Text>
            <Text style={styles.kpiLabel}>{t('provider.zhdut_otveta')}</Text>
          </View>
          <View style={styles.kpi} testID="mobile-workbench-kpi-progress">
            <Text style={[styles.kpiNum, totals.inProgress > 0 && { color: C.success }]}>
              {totals.inProgress}
            </Text>
            <Text style={styles.kpiLabel}>{t('provider.v_rabote')}</Text>
          </View>
          <View style={styles.kpi} testID="mobile-workbench-kpi-blocked">
            <Text style={[styles.kpiNum, totals.blocked > 0 && { color: C.error }]}>
              {totals.blocked}
            </Text>
            <Text style={styles.kpiLabel}>{t('provider.blok')}</Text>
          </View>
        </View>
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
        testID="mobile-workbench"
      >
        {loading && (
          <View style={styles.center} testID="mobile-workbench-loading">
            <ActivityIndicator color={C.brand} />
            <Text style={styles.dim}>{t('provider.zagruzhaem_rabochij_stol')}</Text>
          </View>
        )}

        {error && !loading && (
          <View style={styles.center} testID="mobile-workbench-error">
            <Text style={[styles.dim, { color: C.error }]}>{error}</Text>
          </View>
        )}

        {!loading && !error && items.length === 0 && (
          <View style={styles.center} testID="mobile-workbench-empty">
            <Text style={styles.dim}>{t('provider.poka_net_aktivnyh_zakazov_i_predlozhenij')}</Text>
          </View>
        )}

        {STATE_GROUPS.map(({ state, label, helper }) => {
          const list = grouped.get(state) || [];
          if (list.length === 0) return null;
          return (
            <View key={state} style={styles.group} testID={`mobile-workbench-group-${state}`}>
              <View style={styles.groupHeader}>
                <View style={[styles.dot, { backgroundColor: STATE_COLOR[state] }]} />
                <Text style={styles.groupTitle}>{label}</Text>
                <View style={styles.groupCount}>
                  <Text style={styles.groupCountText}>{list.length}</Text>
                </View>
              </View>
              <Text style={styles.groupHelper}>{helper}</Text>
              {list.map((it) => (
                <WorkItemCard
                  key={it.id}
                  item={it}
                  busy={busyId === it.id}
                  onPrimary={() => handlePrimary(it)}
                  onReject={() => callAction(it, 'reject')}
                  styles={styles}
                  isDark={isDark}
                />
              ))}
            </View>
          );
        })}
      </ScrollView>

      <Modal
        visible={confirm !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirm(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modal} testID="mobile-workbench-confirm">
            <Text style={styles.modalTitle}>{t('provider.podtverdit_dejstvie')}</Text>
            <Text style={styles.modalLabel}>{confirm?.label}</Text>
            <Text style={styles.modalService}>{confirm?.serviceLabel}</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.btn, styles.btnNeutral]}
                onPress={() => setConfirm(null)}
                testID="mobile-workbench-confirm-cancel"
              >
                <Text style={styles.btnNeutralText}>{t('inspector.otmena')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnAccept]}
                onPress={() => {
                  const c = confirm;
                  setConfirm(null);
                  if (!c) return;
                  const item = items.find((x) => x.id === c.itemId);
                  if (item) callAction(item, c.verb);
                }}
                testID="mobile-workbench-confirm-ok"
              >
                <Text style={styles.btnAcceptText}>{t('provider.podtverdit')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

interface CardProps {
  item: ProviderWorkItem;
  busy: boolean;
  onPrimary: () => void;
  onReject: () => void;
  // Theme-aware styles + isDark flag are passed down from the main
  // component scope so this sub-component renders with the correct
  // palette (was previously closing over a module-level light-only
  // `styles` fallback, hence the white card on dark page bug).
  styles: ReturnType<typeof makeStyles>;
  isDark: boolean;
}

function WorkItemCard({ item, busy, onPrimary, onReject, styles, isDark }: CardProps) {
  const router = useRouter();
  const isOffer = item.state === 'needs_response';
  const countdown = formatCountdown(item.expectedActionBy);
  const overdue = countdown === i18n.t('provider.prosrocheno');
  // `isDark` is intentionally unused inside this card today — the
  // themed `styles` already encode the right surface palette. We keep
  // the prop so future inline JSX colours (e.g. icon tints) can pivot
  // without another signature change.
  void isDark;

  // Status header colour follows the same semantic mapping as state dots.
  const statusColor = stateColors(isDark)[item.state];
  const statusLabel = STATE_GROUPS.find((g) => g.state === item.state)?.label ?? item.state;

  // Format scheduled time human-friendly (HH:mm · dd.MM).
  const scheduledLabel = (() => {
    if (!item.scheduledFor) return null;
    const d = new Date(item.scheduledFor);
    if (isNaN(d.getTime())) return null;
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const dd = d.getDate().toString().padStart(2, '0');
    const mo = (d.getMonth() + 1).toString().padStart(2, '0');
    return `${hh}:${mm} · ${dd}.${mo}`;
  })();

  const kindIcon = item.kind === 'inspection' ? 'search' : 'construct';
  const surgeActive = (item.priceShown.surge ?? 1) > 1;

  return (
    <View
      style={[styles.card, overdue && styles.cardOverdue]}
      testID={`mobile-workitem-${item.id}`}
    >
      {/* ── BLOCK 1: STATUS HEADER ── */}
      <View style={[styles.statusStrip, { backgroundColor: statusColor }]} />
      <View style={styles.statusHeader}>
        <View style={styles.statusHeaderLeft}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={styles.statusHeaderLabel} numberOfLines={1}>
            {statusLabel.toUpperCase()}
          </Text>
        </View>
        <View style={styles.kindPill}>
          <Ionicons name={kindIcon} size={11} color={C.brandDark} style={{ marginRight: 4 }} />
          <Text style={styles.kindPillText}>
            {item.kind === 'inspection' ? t('provider.osmotr') : t('provider.servis')}
          </Text>
        </View>
      </View>

      {/* ── BLOCK 2: SERVICE TITLE ── */}
      <View style={styles.titleBlock}>
        <Text style={styles.cardTitle} numberOfLines={2}>{item.serviceLabel}</Text>
        <Text style={styles.cardTimeAgo}>{formatRelative(item.enteredCurrentStateAt)}</Text>
      </View>

      <View style={styles.divider} />

      {/* ── BLOCK 3: CUSTOMER / LOCATION / SCHEDULE ── */}
      <View style={styles.infoBlock}>
        <View style={styles.infoRow}>
          <Ionicons name="person-outline" size={14} color={C.subtextLight === C.subtextLight && isDark ? C.subtextDark : C.subtextLight} style={styles.infoIcon} />
          <Text style={styles.infoText} numberOfLines={1}>{item.customer.name}</Text>
        </View>
        {(item.customer.address || item.customer.distanceKm != null) && (
          <View style={styles.infoRow}>
            <Ionicons name="location-outline" size={14} color={isDark ? C.subtextDark : C.subtextLight} style={styles.infoIcon} />
            <Text style={styles.infoText} numberOfLines={1}>
              {item.customer.address || '—'}
              {item.customer.distanceKm != null ? `  ·  ${item.customer.distanceKm.toFixed(1)} km` : ''}
            </Text>
          </View>
        )}
        {scheduledLabel && (
          <View style={styles.infoRow}>
            <Ionicons name="calendar-outline" size={14} color={isDark ? C.subtextDark : C.subtextLight} style={styles.infoIcon} />
            <Text style={styles.infoText} numberOfLines={1}>{scheduledLabel}</Text>
          </View>
        )}
      </View>

      <View style={styles.divider} />

      {/* ── BLOCK 4: PRICE + SLA COUNTDOWN ── */}
      <View style={styles.priceBlock}>
        <View style={styles.priceLeft}>
          <Text style={styles.priceAmount}>
            {item.priceShown.amount} <Text style={styles.priceCurrency}>{item.priceShown.currency}</Text>
          </Text>
          {surgeActive && (
            <View style={styles.surgeBadge}>
              <Ionicons name="trending-up" size={10} color={C.warning} />
              <Text style={styles.surgeBadgeText}>×{item.priceShown.surge!.toFixed(2)}</Text>
            </View>
          )}
        </View>
        {countdown && (
          <View style={[styles.countdownPill, overdue && styles.countdownPillOverdue]}>
            <Ionicons
              name={overdue ? 'warning' : 'time-outline'}
              size={12}
              color={overdue ? C.error : C.warning}
            />
            <Text style={[styles.countdownText, overdue && { color: C.error }]}>
              {overdue ? t('provider.prosrocheno_2') : countdown}
            </Text>
          </View>
        )}
      </View>

      {/* ── BLOCK 5 (optional): BLOCKED REASON ── */}
      {item.blockedReason && (
        <View style={styles.blockedBox} testID={`mobile-workitem-blocked-${item.id}`}>
          <View style={styles.blockedHeader}>
            <Ionicons name="alert-circle" size={14} color={C.error} />
            <Text style={styles.blockedTitle}>{t('provider.chto_meshaet')}</Text>
          </View>
          <Text style={styles.blockedMessage}>{item.blockedReason.message}</Text>
          <TouchableOpacity
            style={styles.blockedBtn}
            testID={`mobile-workitem-contact-${item.blockedReason.contactWho}-${item.id}`}
            activeOpacity={0.75}
            onPress={() => {
              const who = item.blockedReason!.contactWho;
              const issue = item.blockedReason!.message;
              const ref = `${item.kind === 'inspection' ? 'Inspection' : 'Booking'} ${item.id} (${item.serviceLabel})`;
              const subject = who === 'customer' ? i18n.t('provider.soobschenie_klientu_po_ref') : i18n.t('provider.zablokirovano_ref');
              const messageBody = i18n.t('provider.chto_meshaet_issue_n_nzayavka_ref_nklient_item_cus');
              const category = who === 'customer' ? 'general' : who === 'admin' ? 'admin' : 'general';
              router.push({
                pathname: '/support',
                params: { subject, message: messageBody, category },
              } as any);
            }}
          >
            <Ionicons
              name={item.blockedReason.contactWho === 'customer' ? 'call-outline' : 'chatbubble-outline'}
              size={14}
              color={C.error}
              style={{ marginRight: 6 }}
            />
            <Text style={styles.blockedBtnText}>
              {CONTACT_LABEL[item.blockedReason.contactWho]}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {item.primaryAction && (
        <View style={styles.actions}>
          {/* Primary action: «Принять» for offers (green) / amber for everything else. */}
          <Pressable
            disabled={busy}
            onPress={onPrimary}
            testID={`mobile-workitem-action-${item.primaryAction.verb}-${item.id}`}
            style={({ pressed }) => [
              styles.btn,
              isOffer ? styles.btnAccept : styles.btnBrand,
              busy && { opacity: 0.6 },
              pressed && !busy && { transform: [{ scale: 0.98 }], opacity: 0.92 },
            ]}
          >
            <Text style={isOffer ? styles.btnAcceptText : styles.btnBrandText}>
              {busy ? t('provider.vypolnyaem') : item.primaryAction.label}
            </Text>
          </Pressable>

          {/* Reject lives next to Accept ONLY on offer cards.
              At rest: neutral outline (no permanent red).
              On press: turns red — explicit, intentional, no ambiguity. */}
          {isOffer && (
            <Pressable
              disabled={busy}
              onPress={onReject}
              testID={`mobile-workitem-action-reject-${item.id}`}
              style={({ pressed }) => [
                styles.btn,
                pressed && !busy ? styles.btnRejectPressed : styles.btnReject,
              ]}
            >
              {({ pressed }) => (
                <Text
                  style={pressed && !busy ? styles.btnRejectPressedText : styles.btnRejectText}
                >
                  Отклонить
                </Text>
              )}
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

// ═════════════════════════════════════════════════════════
//  Styles — strictly from tokens. No raw hex outside palette.
// ═════════════════════════════════════════════════════════
// Styles factory — theme-aware (Day 5, 2026-05-15).
//
// Previously this was a top-level `StyleSheet.create({...})` referencing
// `*Light` tokens directly, so the workbench always rendered light even
// when the global theme was dark. The factory now swaps each `*Light`
// token to its `*Dark` counterpart when `isDark` is true. Semantic colours
// (brand, success, warning, error, onBrand) are theme-invariant and stay
// the same — they are intent, not surface.
// ═════════════════════════════════════════════════════════
const S = tokens.spacing;
const R = tokens.radius;

function makeStyles(isDark: boolean) {
  // Theme-flipped surface tokens. Brand/success/warning/error are
  // identical in both palettes (they encode intent, not surface).
  const bg          = isDark ? C.bgDark         : C.bgLight;
  const card        = isDark ? C.cardDark       : C.cardLight;
  const text        = isDark ? C.textDark       : C.textLight;
  const subtext     = isDark ? C.subtextDark    : C.subtextLight;
  const border      = isDark ? C.borderDark     : C.borderLight;
  const brandSoft   = isDark ? C.brandSoftDark  : C.brandSoftLight;

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
  backText: {
    fontSize: 15,
    fontWeight: '500',
    color: text,
  },

  title: { fontSize: tokens.typography.h2, fontWeight: '700', color: text },
  subtitle: { fontSize: tokens.typography.caption, color: subtext, marginTop: 2 },

  personaBar: {
    marginTop: S.sm,
    paddingHorizontal: S.sm,
    paddingVertical: S.xs + 2,
    backgroundColor: brandSoft,
    borderRadius: R.sm,
    borderLeftWidth: 3,
    borderLeftColor: C.brand,
  },
  personaLabel: {
    fontSize: tokens.typography.micro,
    color: subtext,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: '600',
  },
  personaName: {
    fontSize: tokens.typography.body - 1,
    color: text,
    fontWeight: '700',
    marginTop: 2,
  },
  personaOrg: {
    fontSize: tokens.typography.caption - 1,
    color: subtext,
    marginTop: 2,
  },

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
  kpiLabel: { fontSize: tokens.typography.micro, color: subtext, marginTop: 2 },

  scroll: { padding: S.md, paddingBottom: S.xxl + 32 },
  center: { paddingVertical: S.xxl, alignItems: 'center', gap: S.sm },
  dim: { color: subtext, fontSize: tokens.typography.caption + 1 },

  group: { marginBottom: S.lg },
  groupHeader: { flexDirection: 'row', alignItems: 'center', gap: S.xs + 2 },
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
  groupHelper: {
    fontSize: tokens.typography.caption - 1,
    color: subtext,
    marginTop: 2,
    marginBottom: S.sm,
  },

  card: {
    backgroundColor: card,
    borderRadius: R.md,
    marginBottom: S.sm + 2,
    borderWidth: 1,
    borderColor: border,
    overflow: 'hidden',
    // Subtle elevation via boxShadow (RN 0.81 — shadow* deprecated).
    ...(isDark
      ? {}
      : { boxShadow: '0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04)' as any }),
  },
  cardOverdue: { borderColor: C.error, borderWidth: 1.5 },

  // ── BLOCK 1: STATUS HEADER ──
  statusStrip: {
    height: 3,
    width: '100%',
  },
  statusHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: S.md,
    paddingTop: S.sm + 2,
    paddingBottom: S.xs,
  },
  statusHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 6,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusHeaderLabel: {
    fontSize: tokens.typography.micro - 1,
    fontWeight: '800',
    color: subtext,
    letterSpacing: 0.8,
  },
  kindPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: brandSoft,
    borderRadius: R.sm - 2,
    paddingHorizontal: S.xs + 2,
    paddingVertical: 4,
  },
  kindPillText: {
    fontSize: tokens.typography.micro - 1,
    fontWeight: '800',
    color: C.brandDark,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  // ── BLOCK 2: SERVICE TITLE ──
  titleBlock: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: S.md,
    paddingTop: 2,
    paddingBottom: S.sm,
    gap: S.sm,
  },
  cardTitle: {
    fontSize: tokens.typography.body + 2,
    fontWeight: '700',
    color: text,
    flex: 1,
    lineHeight: 22,
  },
  cardTimeAgo: {
    fontSize: tokens.typography.micro,
    color: subtext,
    paddingTop: 2,
  },

  // ── Section divider ──
  divider: {
    height: 1,
    backgroundColor: border,
    opacity: 0.6,
    marginHorizontal: S.md,
  },

  // ── BLOCK 3: INFO ──
  infoBlock: {
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
    gap: 6,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  infoIcon: {
    width: 16,
    textAlign: 'center',
  },
  infoText: {
    flex: 1,
    fontSize: tokens.typography.caption + 1,
    color: text,
    fontWeight: '500',
  },

  // ── BLOCK 4: PRICE + COUNTDOWN ──
  priceBlock: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: S.md,
    paddingVertical: S.sm + 2,
  },
  priceLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: S.xs + 2,
  },
  priceAmount: {
    fontSize: 22,
    fontWeight: '800',
    color: text,
    letterSpacing: -0.5,
  },
  priceCurrency: {
    fontSize: tokens.typography.caption + 1,
    fontWeight: '600',
    color: subtext,
    letterSpacing: 0,
  },
  surgeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: R.sm - 4,
  },
  surgeBadgeText: {
    fontSize: tokens.typography.micro,
    fontWeight: '800',
    color: C.warning,
  },
  countdownPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(245, 158, 11, 0.10)',
    paddingHorizontal: S.xs + 2,
    paddingVertical: 5,
    borderRadius: R.sm - 4,
  },
  countdownPillOverdue: {
    backgroundColor: 'rgba(239, 68, 68, 0.10)',
  },
  countdownText: {
    fontSize: tokens.typography.caption,
    fontWeight: '700',
    color: C.warning,
  },

  // ── Legacy aliases kept for any leftover refs (cardTopRow etc removed) ──
  cardTime: { fontSize: tokens.typography.micro, color: subtext },
  cardCustomer: { fontSize: tokens.typography.caption, color: subtext, marginBottom: S.xs + 2 },
  cardMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardPrice: { fontSize: tokens.typography.body + 1, fontWeight: '800', color: text },
  cardCountdown: { fontSize: tokens.typography.caption - 1, fontWeight: '700', color: C.warning },
  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between' },

  // ── BLOCK 5: BLOCKED REASON ──
  blockedBox: {
    backgroundColor: 'rgba(239,68,68,0.06)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(239,68,68,0.20)',
    paddingHorizontal: S.md,
    paddingVertical: S.sm,
  },
  blockedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  blockedTitle: {
    fontSize: tokens.typography.micro,
    fontWeight: '800',
    color: C.error,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  blockedMessage: {
    fontSize: tokens.typography.caption + 1,
    color: text,
    marginBottom: S.xs + 2,
    lineHeight: 18,
  },
  blockedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderColor: C.error,
    borderWidth: 1,
    borderRadius: R.sm - 4,
    paddingVertical: 7,
    paddingHorizontal: S.sm,
    alignSelf: 'flex-start',
    backgroundColor: card,
  },
  blockedBtnText: { fontSize: tokens.typography.caption, color: C.error, fontWeight: '700' },

  // ── BLOCK 6: ACTIONS ──
  actions: {
    flexDirection: 'row',
    gap: S.xs + 2,
    paddingHorizontal: S.md,
    paddingTop: S.xs + 2,
    paddingBottom: S.md - 2,
    borderTopWidth: 1,
    borderTopColor: border,
    backgroundColor: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(15,23,42,0.02)',
  },
  btn: {
    flex: 1,
    borderRadius: R.sm,
    paddingVertical: S.sm + 2,
    paddingHorizontal: S.sm + 2,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },

  // Accept — green (success).
  btnAccept: { backgroundColor: C.success },
  btnAcceptText: { color: '#FFFFFF', fontWeight: '700', fontSize: tokens.typography.body },

  // Brand amber primary — for non-offer primary actions (start, finish, etc.).
  btnBrand: { backgroundColor: C.brand },
  btnBrandText: { color: C.onBrand, fontWeight: '800', fontSize: tokens.typography.body },

  // Reject at rest — neutral outline (no permanent red).
  btnReject: {
    backgroundColor: card,
    borderWidth: 1,
    borderColor: border,
  },
  btnRejectText: {
    color: subtext,
    fontWeight: '700',
    fontSize: tokens.typography.body,
  },
  // Reject pressed — explicit red affordance, only while finger is down.
  btnRejectPressed: {
    backgroundColor: 'rgba(239,68,68,0.08)',
    borderWidth: 1,
    borderColor: C.error,
  },
  btnRejectPressedText: {
    color: C.error,
    fontWeight: '700',
    fontSize: tokens.typography.body,
  },

  // Neutral cancel (modal only).
  btnNeutral: {
    backgroundColor: card,
    borderWidth: 1,
    borderColor: border,
  },
  btnNeutralText: { color: subtext, fontWeight: '700', fontSize: tokens.typography.body },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    padding: S.lg,
  },
  modal: { backgroundColor: card, borderRadius: R.md, padding: S.lg },
  modalTitle: {
    fontSize: tokens.typography.h3,
    fontWeight: '700',
    marginBottom: S.sm + 2,
    color: text,
  },
  modalLabel: { fontSize: tokens.typography.body + 1, fontWeight: '700', color: text },
  modalService: {
    fontSize: tokens.typography.caption + 1,
    color: subtext,
    marginTop: 4,
    marginBottom: S.md,
  },
  modalActions: { flexDirection: 'row', gap: S.xs + 2 },
  });
}

// Note: there is intentionally NO module-level `styles` constant any more.
// Every consumer of `styles` (the main component and `WorkItemCard`)
// resolves it from the themed `useMemo(() => makeStyles(isDark), ...)`
// in the main component scope. WorkItemCard receives both `styles` and
// `isDark` via props. This is the canonical fix for "sub-component
// theme parity" — see /app/memory/theme_audit_2026_05_15.md.


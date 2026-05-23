/**
 * Car-Selection-3 — Provider Workspace · Detail.
 *
 * Reads: GET  /api/provider/car-selection/{id}
 * Writes: POST /api/provider/car-selection/{id}/status
 *
 * Hard invariants:
 *   - Frozen customer brief — rendered read-only with a Lock marker
 *     and an explicit "Customer wrote this. You cannot change it"
 *     subtitle. There is no input bound to `description`.
 *
 *   - Provider-only restricted lifecycle (mirrors backend
 *     PROVIDER_ALLOWED_TRANSITIONS):
 *
 *        assigned         → in_progress / waiting_customer
 *        in_progress      → waiting_customer / completed
 *        waiting_customer → in_progress / completed
 *
 *     Action buttons are derived from this map. From terminal /
 *     pre-assigned states we render the read-only brief plus
 *     timeline only — no action surface.
 *
 *   - Note input is optional and rides the timeline event; it is
 *     NEVER merged into `description`.
 *
 *   - Existence privacy: 404 from backend → friendly "not yours
 *     or not found" empty state.
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
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { api } from '../../../src/services/api';
import { useAuth } from '../../../src/context/AuthContext';
import { useThemeContext } from '../../../src/context/ThemeContext';
import { tokens } from '../../../src/theme/tokens';
import CarSelectionThreadBlock from '../../../src/components/CarSelectionThreadBlock';
import OfferPackageBlock from '../../../src/components/OfferPackageBlock';
import { mapCarSelectionError } from '../../../src/i18n/carSelectionErrors';
import i18n from '../../../src/i18n';

// ── Types ─────────────────────────────────────────────────────────────

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

interface BudgetExtras {
  budgetMin?: number;
  budgetMax?: number;
  brands?: string[];
  fuelTypes?: string[];
  transmission?: 'manual' | 'automatic';
  yearMin?: number;
  yearMax?: number;
}

interface TimelineEvent {
  type: string;
  at: string;
  actorId?: string | null;
  actorRole?: string | null;
  note?: string | null;
  data?: Record<string, unknown> | null;
}

interface CSRequest {
  id: string;
  customerId: string;
  serviceType: ServiceType;
  countryCode: string;
  cityId: string;
  description: string;
  sourceLink?: string | null;
  budget?: BudgetExtras | null;
  status: CSStatus;
  assignedAdminId?: string | null;
  assignedProviderId?: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineEvent[];
}

// ── Mirror of backend PROVIDER_ALLOWED_TRANSITIONS ────────────────────

const PROVIDER_ALLOWED: Partial<Record<CSStatus, CSStatus[]>> = {
  assigned:         ['in_progress', 'waiting_customer'],
  in_progress:      ['waiting_customer', 'completed'],
  waiting_customer: ['in_progress', 'completed'],
};

// Localized maps live inside the component (see useMemo below) so they
// react to language switches without remounting.

const C = tokens.colors;

function statusTone(s: CSStatus): string {
  switch (s) {
    case 'assigned':         return C.warning;
    case 'in_progress':      return C.success;
    case 'waiting_customer': return C.brand;
    case 'completed':        return C.success;
    case 'cancelled':        return C.error;
    default:                 return C.warning;
  }
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const dd = d.getDate().toString().padStart(2, '0');
    const mo = (d.getMonth() + 1).toString().padStart(2, '0');
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${dd}.${mo} · ${hh}:${mm}`;
  } catch {
    return iso;
  }
}

export default function ProviderCarSelectionDetail() {
  const { t } = useTranslation();
  const router = useRouter();
  const { id, focusPackageId: focusPkgParam } = useLocalSearchParams<{ id: string; focusPackageId?: string | string[] }>();
  const focusPackageId = Array.isArray(focusPkgParam) ? focusPkgParam[0] : focusPkgParam;
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  const { isDark } = useThemeContext();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);

  // Localized maps — provider surface uses the canonical "waiting customer"
  // wording (no "for you" softening — the provider is operationally external).
  const SERVICE_LABEL: Record<ServiceType, string> = useMemo(() => ({
    budget_search:    i18n.t('car_selection.service.budget_search'),
    market_search:    i18n.t('car_selection.service.market_search'),
    negotiation_help: i18n.t('car_selection.service.negotiation_help'),
    listing_review:   i18n.t('car_selection.service.listing_review'),
  }), [t]);

  const STATUS_LABEL: Record<CSStatus, string> = useMemo(() => ({
    submitted:        i18n.t('car_selection.status.submitted'),
    reviewing:        i18n.t('car_selection.status.reviewing'),
    assigned:         i18n.t('car_selection.status.assigned'),
    in_progress:      i18n.t('car_selection.status.in_progress'),
    waiting_customer: i18n.t('car_selection.status.waiting_customer'),
    completed:        i18n.t('car_selection.status.completed'),
    cancelled:        i18n.t('car_selection.status.cancelled'),
  }), [t]);

  const TRANSITION_LABEL: Record<CSStatus, string> = useMemo(() => ({
    in_progress:      i18n.t('car_selection.actions_block.transition.in_progress'),
    waiting_customer: i18n.t('car_selection.actions_block.transition.waiting_customer'),
    completed:        i18n.t('car_selection.actions_block.transition.completed'),
    submitted: '',
    reviewing: '',
    assigned: '',
    cancelled: '',
  }), [t]);

  const [req, setReq] = useState<CSRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<CSStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [note, setNote] = useState('');

  const fetchOne = useCallback(async () => {
    if (!id) return;
    try {
      const { data } = await api.get<CSRequest>(`/provider/car-selection/${id}`);
      setReq(data);
      setError(null);
      setNotFound(false);
    } catch (e: any) {
      const code = e?.response?.status;
      if (code === 404) {
        setNotFound(true);
      } else if (code === 403) {
        setError(i18n.t('car_selection.error.FORBIDDEN_PROVIDER'));
      } else {
        setError(mapCarSelectionError(t, e) || i18n.t('car_selection.load_failed'));
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    fetchOne();
  }, [authLoading, isAuthenticated, fetchOne]);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/provider/car-selection' as any);
  }, [router]);

  const callTransition = useCallback(
    async (target: CSStatus) => {
      if (!req) return;
      setBusy(target);
      try {
        const body = { status: target, note: note.trim() || null };
        const { data } = await api.post<CSRequest>(
          `/provider/car-selection/${req.id}/status`,
          body,
        );
        setReq(data);
        setNote('');
      } catch (e: any) {
        Alert.alert(
          i18n.t('car_selection.actions_block.status_update_failed'),
          mapCarSelectionError(t, e),
        );
      } finally {
        setBusy(null);
      }
    },
    [req, note, t],
  );

  // ── Render branches ──────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <ActivityIndicator color={C.brand} />
          <Text style={styles.dim}>{t('car_selection.loading')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (notFound) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center} testID="pcs-detail-notfound">
          <Ionicons name="lock-closed" size={32} color={isDark ? C.subtextDark : C.subtextLight} />
          <Text style={styles.dim}>{t('car_selection.not_found')}</Text>
          <Text style={styles.dimSmall}>
            {t('car_selection.not_found_hint')}
          </Text>
          <TouchableOpacity style={styles.linkBtn} onPress={handleBack} testID="pcs-detail-back-fromempty">
            <Text style={styles.linkBtnText}>{t('car_selection.back_to_list')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (error || !req) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <Ionicons name="alert-circle" size={28} color={C.error} />
          <Text style={[styles.dim, { color: C.error }]}>{error || t('car_selection.not_found')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const allowed = PROVIDER_ALLOWED[req.status] || [];
  const isExecLane = allowed.length > 0;
  const isTerminal = req.status === 'completed' || req.status === 'cancelled';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.header} testID="pcs-detail-header">
        <View style={styles.headerTopRow}>
          <TouchableOpacity
            onPress={handleBack}
            hitSlop={12}
            activeOpacity={0.7}
            style={styles.backBtn}
            testID="pcs-detail-back"
          >
            <Ionicons name="chevron-back" size={22} color={isDark ? C.textDark : C.textLight} />
            <Text style={styles.backText}>{t('car_selection.back')}</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.titleRow}>
          <View style={[styles.statusDot, { backgroundColor: statusTone(req.status) }]} />
          <Text style={styles.titleSmall}>{SERVICE_LABEL[req.serviceType]}</Text>
          <View style={[styles.statusPill, { backgroundColor: statusTone(req.status) + '22', borderColor: statusTone(req.status) }]}>
            <Text style={[styles.statusPillText, { color: statusTone(req.status) }]}>
              {STATUS_LABEL[req.status].toUpperCase()}
            </Text>
          </View>
        </View>
        <Text style={styles.subtitle}>
          {req.countryCode}/{req.cityId} · {t('car_selection.meta.updated').toLowerCase()} {fmtDateTime(req.updatedAt)}
        </Text>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                fetchOne();
              }}
              tintColor={C.brand}
            />
          }
          testID="pcs-detail-scroll"
        >
          {/* ── FROZEN customer brief ───────────────────────────── */}
          <View style={styles.briefBlock} testID="pcs-detail-brief">
            <View style={styles.briefHeader}>
              <Ionicons name="lock-closed" size={12} color={isDark ? C.subtextDark : C.subtextLight} />
              <Text style={styles.briefHeaderText}>{t('car_selection.brief.lock_label')}</Text>
            </View>
            <Text style={styles.briefBody} selectable testID="pcs-detail-description">
              {req.description}
            </Text>
            <Text style={styles.briefHint}>
              {t('car_selection.brief.lock_hint')}
            </Text>
          </View>

          {/* ── Source link / budget extras ─────────────────────── */}
          {req.sourceLink && (
            <View style={styles.metaBlock} testID="pcs-detail-source">
              <Text style={styles.metaLabel}>{t('car_selection.section.source')}</Text>
              <Text style={styles.metaLink} selectable>{req.sourceLink}</Text>
            </View>
          )}

          {req.budget && (
            <View style={styles.metaBlock} testID="pcs-detail-budget">
              <Text style={styles.metaLabel}>{t('car_selection.section.criteria')}</Text>
              {req.budget.budgetMin != null || req.budget.budgetMax != null ? (
                <Text style={styles.metaValue}>
                  {req.budget.budgetMin ?? '—'} – {req.budget.budgetMax ?? '—'} €
                </Text>
              ) : null}
              {req.budget.brands?.length ? (
                <Text style={styles.metaValueSub}>{t('car_selection.criteria.brands')}: {req.budget.brands.join(' · ')}</Text>
              ) : null}
              {req.budget.fuelTypes?.length ? (
                <Text style={styles.metaValueSub}>{t('car_selection.criteria.fuel')}: {req.budget.fuelTypes.join(' · ')}</Text>
              ) : null}
              {req.budget.transmission ? (
                <Text style={styles.metaValueSub}>{t('car_selection.criteria.transmission')}: {req.budget.transmission}</Text>
              ) : null}
              {req.budget.yearMin != null || req.budget.yearMax != null ? (
                <Text style={styles.metaValueSub}>
                  {t('car_selection.criteria.year')}: {req.budget.yearMin ?? '—'} – {req.budget.yearMax ?? '—'}
                </Text>
              ) : null}
            </View>
          )}

          {/* ── Action surface ──────────────────────────────────── */}
          {isExecLane && (
            <View style={styles.actionBlock} testID="pcs-detail-actions">
              <Text style={styles.sectionTitle}>{t('car_selection.section.actions')}</Text>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder={t('car_selection.actions_block.note_placeholder')}
                placeholderTextColor={isDark ? C.subtextDark : C.subtextLight}
                multiline
                maxLength={500}
                style={styles.noteInput}
                testID="pcs-detail-note-input"
              />
              <Text style={styles.noteHint}>
                {t('car_selection.actions_block.note_hint')}
              </Text>
              <View style={styles.btnRow}>
                {allowed.map((target) => {
                  const tone =
                    target === 'completed' ? C.success
                      : target === 'waiting_customer' ? C.brand
                        : C.warning;
                  return (
                    <TouchableOpacity
                      key={target}
                      style={[styles.actionBtn, { backgroundColor: tone }, busy && busy !== target ? { opacity: 0.5 } : null]}
                      disabled={busy !== null}
                      onPress={() => callTransition(target)}
                      activeOpacity={0.8}
                      testID={`pcs-detail-action-${target}`}
                    >
                      <Text style={styles.actionBtnText}>
                        {busy === target ? t('car_selection.actions_block.busy') : TRANSITION_LABEL[target]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )}

          {isTerminal && (
            <View style={styles.terminalBlock} testID="pcs-detail-terminal">
              <Ionicons
                name={req.status === 'completed' ? 'checkmark-circle' : 'close-circle'}
                size={20}
                color={statusTone(req.status)}
              />
              <Text style={[styles.terminalText, { color: statusTone(req.status) }]}>
                {req.status === 'completed'
                  ? t('car_selection.terminal.completed')
                  : t('car_selection.terminal.cancelled')}
              </Text>
            </View>
          )}

          {!isExecLane && !isTerminal && (
            <View style={styles.terminalBlock} testID="pcs-detail-pre-assigned">
              <Ionicons name="hourglass-outline" size={20} color={isDark ? C.subtextDark : C.subtextLight} />
              <Text style={[styles.terminalText, { color: isDark ? C.subtextDark : C.subtextLight }]}>
                {t('car_selection.terminal.pre_assigned')}
              </Text>
            </View>
          )}

          {/* ── Offer packages (Car-Selection-6) — draft composer + own list ─ */}
          <OfferPackageBlock
            requestId={req.id}
            surface="provider"
            isDark={isDark}
            enabled={isExecLane || isTerminal}
          />

          {/* ── Thread (Car-Selection-4) ─────────────────────── */}
          <CarSelectionThreadBlock
            requestId={req.id}
            surface="provider"
            isDark={isDark}
          />

          {/* ── Timeline rail ───────────────────────────────────── */}
          <View style={styles.timelineBlock} testID="pcs-detail-timeline">
            <Text style={styles.sectionTitle}>{t('car_selection.section.timeline')} · {req.timeline.length}</Text>
            <View style={styles.timelineRail}>
              {req.timeline.slice().reverse().map((ev, i) => (
                <View key={i} style={styles.timelineEvent} testID={`pcs-detail-timeline-${req.timeline.length - 1 - i}`}>
                  <View style={[styles.timelineDot, { backgroundColor: ev.actorRole === 'provider' ? C.success : ev.actorRole === 'admin' ? C.warning : C.brand }]} />
                  <View style={styles.timelineEventBody}>
                    <Text style={styles.timelineEventType}>{ev.type}</Text>
                    <Text style={styles.timelineEventMeta}>
                      {fmtDateTime(ev.at)} · {ev.actorRole || '—'}
                    </Text>
                    {ev.note ? (
                      <Text style={styles.timelineEventNote}>«{ev.note}»</Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
    headerTopRow: { height: 36, flexDirection: 'row', alignItems: 'center', marginBottom: S.xs },
    backBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingHorizontal: 4, marginLeft: -4, gap: 2 },
    backText: { fontSize: 15, fontWeight: '500', color: text },

    titleRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm, marginBottom: 4 },
    statusDot: { width: 10, height: 10, borderRadius: 5 },
    titleSmall: { fontSize: tokens.typography.h3, fontWeight: '700', color: text, flex: 1 },
    statusPill: {
      paddingHorizontal: S.xs + 2,
      paddingVertical: 3,
      borderRadius: 999,
      borderWidth: 1,
    },
    statusPillText: { fontSize: tokens.typography.micro - 1, fontWeight: '800', letterSpacing: 0.6 },
    subtitle: { fontSize: tokens.typography.caption, color: subtext },

    scroll: { padding: S.md, paddingBottom: S.xxl + 32, gap: S.md },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: S.sm, padding: S.lg },
    dim: { color: subtext, fontSize: tokens.typography.caption + 1, textAlign: 'center' },
    dimSmall: { color: subtext, fontSize: tokens.typography.micro, textAlign: 'center', maxWidth: 280 },

    linkBtn: { marginTop: S.md, padding: S.sm },
    linkBtnText: { color: C.brand, fontWeight: '700' },

    // FROZEN BRIEF
    briefBlock: {
      backgroundColor: card,
      borderRadius: R.md,
      borderWidth: 1,
      borderColor: border,
      padding: S.md,
    },
    briefHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: S.xs + 2 },
    briefHeaderText: {
      fontSize: tokens.typography.micro,
      fontWeight: '800',
      color: subtext,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
    },
    briefBody: {
      fontSize: tokens.typography.body,
      color: text,
      lineHeight: 22,
    },
    briefHint: {
      marginTop: S.sm,
      fontSize: tokens.typography.micro,
      color: subtext,
      fontStyle: 'italic',
    },

    // META
    metaBlock: {
      backgroundColor: card,
      borderRadius: R.md,
      borderWidth: 1,
      borderColor: border,
      padding: S.md,
      gap: 4,
    },
    metaLabel: {
      fontSize: tokens.typography.micro,
      fontWeight: '800',
      color: subtext,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginBottom: 2,
    },
    metaValue: { fontSize: tokens.typography.body, color: text, fontWeight: '700' },
    metaValueSub: { fontSize: tokens.typography.caption + 1, color: text },
    metaLink: { fontSize: tokens.typography.caption + 1, color: C.brand },

    // ACTIONS
    actionBlock: {
      backgroundColor: card,
      borderRadius: R.md,
      borderWidth: 1,
      borderColor: border,
      padding: S.md,
    },
    sectionTitle: {
      fontSize: tokens.typography.h3 - 1,
      fontWeight: '700',
      color: text,
      marginBottom: S.sm,
    },
    noteInput: {
      backgroundColor: bg,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: border,
      padding: S.sm,
      color: text,
      fontSize: tokens.typography.caption + 1,
      minHeight: 64,
      textAlignVertical: 'top',
    },
    noteHint: {
      fontSize: tokens.typography.micro,
      color: subtext,
      marginTop: 4,
      marginBottom: S.sm,
      fontStyle: 'italic',
    },
    btnRow: { flexDirection: 'row', gap: S.xs + 2, flexWrap: 'wrap' },
    actionBtn: {
      flexGrow: 1,
      flexBasis: '40%',
      borderRadius: R.sm,
      paddingVertical: S.sm + 2,
      paddingHorizontal: S.sm,
      alignItems: 'center',
      minHeight: 48,
      justifyContent: 'center',
    },
    actionBtnText: { color: '#FFFFFF', fontWeight: '800', fontSize: tokens.typography.body },

    // TERMINAL / PRE
    terminalBlock: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: S.sm,
      backgroundColor: card,
      borderRadius: R.md,
      borderWidth: 1,
      borderColor: border,
      padding: S.md,
    },
    terminalText: {
      flex: 1,
      fontSize: tokens.typography.caption + 1,
      fontWeight: '600',
    },

    // TIMELINE
    timelineBlock: {
      backgroundColor: card,
      borderRadius: R.md,
      borderWidth: 1,
      borderColor: border,
      padding: S.md,
    },
    timelineRail: { gap: S.sm + 2, marginLeft: 4 },
    timelineEvent: {
      flexDirection: 'row',
      gap: S.sm,
      alignItems: 'flex-start',
    },
    timelineDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      marginTop: 5,
    },
    timelineEventBody: { flex: 1 },
    timelineEventType: { fontSize: tokens.typography.caption + 1, fontWeight: '700', color: text },
    timelineEventMeta: { fontSize: tokens.typography.micro, color: subtext, marginTop: 2 },
    timelineEventNote: {
      fontSize: tokens.typography.caption,
      color: text,
      fontStyle: 'italic',
      marginTop: 4,
      backgroundColor: brandSoft,
      paddingHorizontal: S.xs + 2,
      paddingVertical: 4,
      borderRadius: R.sm - 2,
      alignSelf: 'flex-start',
    },
  });
}

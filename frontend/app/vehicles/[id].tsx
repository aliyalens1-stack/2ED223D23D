// Sprint 2C — Vehicle Workspace (detail screen).
// P4.2 — Mobile parity on Vehicle Memory.
//   This screen now consumes the EXACT same `@platform/domain/state-machines/vehicle`
//   projections as the web-app (`CustomerVehicleDetail.tsx`). No fork. No
//   surface-local domain logic. Backend timeline aggregator (P4.1) feeds
//   both surfaces from a single endpoint:
//     GET /api/customer/vehicles/:id/timeline → { vehicle, reports, quotes, payments, bookings }
//   And shared owns ALL semantic mapping:
//     reports/quotes/payments/bookings + vehicle.activity → Memory + TimelineItem[]
//
// Route: /vehicles/[id]
//
// Per architectural review, this screen must feel like
//   "this is one car I'm seriously considering"
// — NOT a report center, analytics hub, or admin screen.
//
// INCLUDED (per spec):
//   - vehicle hero (brand/model, price, location, year, source)
//   - memory badge (stage + perception, derived in shared/)
//   - editable user notes (PATCH on blur)
//   - status pill + lightweight progression chips (surface UX, not domain)
//   - activity timeline (shared projection — combines activity + linked refs)
//   - linked-records counters (reports / quotes / payments / bookings)
//   - CTA: request inspection (preserves vehicleId in params for later linking)
//
// EXCLUDED (intentionally — would corrupt scope):
//   - graph / similar cars / recommendations
//   - public data / market estimates
//   - AI scoring / resale prediction
//   - cross-vehicle aggregations
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Alert,
  Platform,
  KeyboardAvoidingView,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';
import { useAuth } from '../../src/context/AuthContext';
import { vehiclesApi, Vehicle, VehicleStatus } from '../../src/services/vehicles';
import i18n from '../../src/i18n';
// P4.2 — shared semantic kernel. Same imports as web-app
// (web-app/src/pages/customer/CustomerVehicleDetail.tsx). NO fork.
import {
  projectVehicleMemory,
  projectVehicleTimeline,
} from '@platform/domain/state-machines/vehicle';
import type {
  VehicleDoc,
  VehicleMemoryProjectionInput,
  LinkedInspectionReportRef,
  LinkedQuoteRef,
  LinkedPaymentRef,
  LinkedBookingRef,
  CustomerVehiclePerception,
  VehicleMemoryStage,
  TimelineItemKind,
  TimelineItemSeverity,
  VehicleOperationalStatus,
} from '@platform/domain/contracts/vehicle';
// P4.3 — Vehicle Memory cache (mirror of web-app store).
import {
  useVehicleMemory,
  useVehicleMemoryStore,
} from '../../src/stores/vehicleMemoryStore';

// ── Status progression. Open string set on the backend; UI just renders these
// four common ones. Unknown statuses fall back to "saved" rendering.
// Labels are resolved via t() inside the component (key is the i18n suffix).
const STATUS_FLOW: { key: VehicleStatus; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'saved',                labelKey: 'vehicles.status.saved',                icon: 'bookmark' },
  { key: 'inspection_requested', labelKey: 'vehicles.status.inspection_requested', icon: 'shield-half' },
  { key: 'inspection_completed', labelKey: 'vehicles.status.inspection_completed', icon: 'shield-checkmark' },
  { key: 'purchased',            labelKey: 'vehicles.status.purchased',            icon: 'car-sport' },
];

const fmt = (n: number) => Number(n).toLocaleString('de-DE');

// ─────────────────────────────────────────────────────────────────────
// P4.2 — surface translator: backend wire shape → shared VehicleDoc.
// MUST stay in lock-step with web-app's `toVehicleDoc()`. The shared
// projection is the same; this is just adapter code per surface.
// ─────────────────────────────────────────────────────────────────────
function toVehicleDoc(raw: Vehicle): VehicleDoc {
  // The mobile `Vehicle` interface (src/services/vehicles.ts) already
  // mirrors the backend wire shape — but the shared `VehicleDoc`
  // expects different field names for a few props (camelCase listingUrl
  // instead of snake_case listing_url). Translate explicitly so the
  // shared invariants hold.
  const anyRaw: any = raw;
  return {
    id: raw.id,
    customerId: raw.customerId,
    brand: raw.brand,
    model: raw.model,
    year: raw.year ?? null,
    mileage: raw.mileage ?? anyRaw.mileageKm ?? null,
    price: raw.price ?? null,
    currency: raw.currency ?? null,
    thumbnail: raw.thumbnail ?? null,
    listingUrl: raw.listing_url ?? null,
    source: raw.source ?? null,
    notes: raw.notes ?? null,
    status: raw.status ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt ?? null,
    activity: (raw.activity ?? []).map((a) => ({
      type: a.type,
      at: a.at,
      text: a.text ?? null,
    })),
    ...(anyRaw.plate ? { plate: anyRaw.plate } : {}),
    ...(anyRaw.vin ? { vin: anyRaw.vin } : {}),
  } as VehicleDoc;
}

// ─────────────────────────────────────────────────────────────────────
// Shared → presentation labels. Same dictionaries as web-app —
// surface owns translation, shared owns semantics. Maps to i18n keys
// (resolved via t() inside the component); shared owns enums only.
// ─────────────────────────────────────────────────────────────────────
const STAGE_LABEL_KEY: Readonly<Record<VehicleMemoryStage, string>> = {
  discovery:   'vehicles.stage.discovery',
  validation:  'vehicles.stage.validation',
  decision:    'vehicles.stage.decision',
  acquisition: 'vehicles.stage.acquisition',
  ownership:   'vehicles.stage.ownership',
  parted_ways: 'vehicles.stage.parted_ways',
};

const STAGE_HINT_KEY: Readonly<Record<VehicleMemoryStage, string>> = {
  discovery:   'vehicles.stage_hint.discovery',
  validation:  'vehicles.stage_hint.validation',
  decision:    'vehicles.stage_hint.decision',
  acquisition: 'vehicles.stage_hint.acquisition',
  ownership:   'vehicles.stage_hint.ownership',
  parted_ways: 'vehicles.stage_hint.parted_ways',
};

const PERCEPTION_LABEL_KEY: Readonly<Record<CustomerVehiclePerception, string>> = {
  considering:              'vehicles.perception.considering',
  inspection_pending:       'vehicles.perception.inspection_pending',
  evaluating:               'vehicles.perception.evaluating',
  evaluating_with_concerns: 'vehicles.perception.evaluating_with_concerns',
  negotiating:              'vehicles.perception.negotiating',
  awaiting_delivery:        'vehicles.perception.awaiting_delivery',
  owned:                    'vehicles.perception.owned',
  parted_with:              'vehicles.perception.parted_with',
  not_interested:           'vehicles.perception.not_interested',
};

const PERCEPTION_TONE: Readonly<Record<CustomerVehiclePerception, string>> = {
  considering: '#B8B8B8',
  inspection_pending: '#7DD3FC',
  evaluating: '#FFB020',
  evaluating_with_concerns: '#F97316',
  negotiating: '#FFB020',
  awaiting_delivery: '#FFB020',
  owned: '#22C55E',
  parted_with: '#8A8A8A',
  not_interested: '#8A8A8A',
};

const KIND_ICON: Readonly<Record<TimelineItemKind, keyof typeof Ionicons.glyphMap>> = {
  inspection_report: 'document-text',
  quote: 'pricetag',
  payment: 'card',
  booking: 'calendar',
  vehicle_event: 'flag',
};

const SEVERITY_COLOR: Readonly<Record<TimelineItemSeverity, string>> = {
  info: '#7DD3FC',
  success: '#22C55E',
  warning: '#FFB020',
  danger: '#EF4444',
};

export default function VehicleWorkspaceScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  const params = useLocalSearchParams<{ id?: string }>();
  const vehicleId = params.id || '';

  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [reports, setReports] = useState<LinkedInspectionReportRef[]>([]);
  const [quotes, setQuotes] = useState<LinkedQuoteRef[]>([]);
  const [payments, setPayments] = useState<LinkedPaymentRef[]>([]);
  const [bookings, setBookings] = useState<LinkedBookingRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState<'auth' | 'not_found' | 'fetch' | null>(null);

  const [notesDraft, setNotesDraft] = useState('');
  const notesDirty = useRef(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);

  const fetchOne = useCallback(async () => {
    if (!vehicleId) return;
    setLoading(true);
    setErrorState(null);
    try {
      // P4.2 — single round-trip via P4.1 aggregator. Same endpoint
      // the web-app surface uses; same shape; same downstream
      // projection. No mobile-specific fan-out, no fork.
      const data = await vehiclesApi.getTimeline(vehicleId);
      setVehicle(data.vehicle);
      setReports(Array.isArray(data.reports) ? (data.reports as LinkedInspectionReportRef[]) : []);
      setQuotes(Array.isArray(data.quotes) ? (data.quotes as LinkedQuoteRef[]) : []);
      setPayments(Array.isArray(data.payments) ? (data.payments as LinkedPaymentRef[]) : []);
      setBookings(Array.isArray(data.bookings) ? (data.bookings as LinkedBookingRef[]) : []);
      setNotesDraft(data.vehicle.notes || '');
      notesDirty.current = false;
    } catch (e: any) {
      const code = e?.response?.status;
      if (code === 401) setErrorState('auth');
      else if (code === 404) setErrorState('not_found');
      else setErrorState('fetch');
    } finally {
      setLoading(false);
    }
  }, [vehicleId]);

  // P4.2 — gate fetch behind AuthContext bootstrap.
  // Direct deep-links to /vehicles/:id (push-notification, share, browser
  // refresh) used to race AsyncStorage → api.defaults.headers and 401.
  // Wait until auth has finished initialising; only then fire the
  // timeline aggregator. If the user is genuinely guest, render the
  // existing 'auth' empty-state without an unnecessary network round-trip.
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setLoading(false);
      setErrorState('auth');
      return;
    }
    fetchOne();
  }, [authLoading, isAuthenticated, fetchOne]);

  // P4.2 — projection input identical to web-app's. Shared owns
  // perception / stage / timeline derivation. Surface only renders.
  const projectionInput: VehicleMemoryProjectionInput | null = useMemo(() => {
    if (!vehicle) return null;
    return {
      vehicle: toVehicleDoc(vehicle),
      reports,
      quotes,
      payments,
      bookings,
    };
  }, [vehicle, reports, quotes, payments, bookings]);

  const memory = useMemo(() => {
    if (!projectionInput) return null;
    return projectVehicleMemory(projectionInput);
  }, [projectionInput]);

  // P4.3 — write canonical server-derived projection into the cache.
  // mergeVehicleMemory inside the store rejects stale snapshots that
  // would regress operationalStatus / counts / flags below local.
  const setSnapshot = useVehicleMemoryStore((s) => s.setSnapshot);
  const optimisticPatch = useVehicleMemoryStore((s) => s.optimisticPatch);
  const invalidate = useVehicleMemoryStore((s) => s.invalidate);
  const cachedMemory = useVehicleMemory(vehicleId);
  useEffect(() => {
    if (memory) setSnapshot(vehicleId, memory);
  }, [memory, vehicleId, setSnapshot]);

  // What the rest of the screen consumes. The CACHE is the single
  // source of truth for what we render — it holds either the latest
  // server projection (post `setSnapshot` below), or an optimistic
  // patch applied via `optimisticPatch`. Server projection is the
  // INPUT to the cache, not a parallel render path.
  // On cold start (cache empty) we fall back to the just-computed
  // `memory` for one frame; the next effect tick writes it into the
  // cache and from there onwards `cachedMemory` wins.
  const effectiveMemory = cachedMemory ?? memory;

  const timelineItems = useMemo(() => {
    if (!projectionInput) return [];
    return projectVehicleTimeline(projectionInput);
  }, [projectionInput]);

  // Persist notes on blur. We avoid PATCH-per-keystroke; a single PATCH on blur
  // is plenty given how short notes are.
  const handleNotesBlur = useCallback(async () => {
    if (!vehicle) return;
    if (!notesDirty.current) return;
    if ((notesDraft || '') === (vehicle.notes || '')) {
      notesDirty.current = false;
      return;
    }
    setSavingNotes(true);
    try {
      const updated = await vehiclesApi.update(vehicle.id, { notes: notesDraft });
      setVehicle(updated);
      notesDirty.current = false;
    } catch {
      Alert.alert(i18n.t('vehicles.notes_save_error_title'), i18n.t('vehicles.notes_save_error_msg'));
    } finally {
      setSavingNotes(false);
    }
  }, [vehicle, notesDraft]);

  // P4.3 — surface→cache mapping. Mobile `VehicleStatus` is a 1:1 alias
  // of the backend raw status, which lines up with the
  // shared `VehicleOperationalStatus` ontology (same names). Surface
  // owns this map; if shared ever expands the union, TS will scream.
  const STATUS_TO_OPERATIONAL: Readonly<Record<string, VehicleOperationalStatus>> = {
    saved: 'unknown',
    inspection_requested: 'inspection_requested',
    inspection_completed: 'inspection_completed',
    purchased: 'purchased',
    archived: 'archived',
  };

  const handleStatusChange = useCallback(async (next: VehicleStatus) => {
    if (!vehicle || updatingStatus || vehicle.status === next) return;
    setUpdatingStatus(true);
    // P4.3 — optimistic patch on memory cache. The badge / linked-records
    // counters / stage hint flip instantly. mergeVehicleMemory inside
    // the store enforces monotonic operationalStatus — pressing a chip
    // that would regress (e.g. saved after purchased) is silently
    // ignored at the cache level (and the chip itself is no-op gated
    // by `vehicle.status === next` above).
    const opStatus = STATUS_TO_OPERATIONAL[next as string] ?? 'unknown';
    const rollback = optimisticPatch(vehicle.id, (prev) => {
      if (!prev) return null;
      return { ...prev, operationalStatus: opStatus };
    });
    try {
      const updated = await vehiclesApi.update(vehicle.id, { status: next });
      setVehicle(updated);
      // P4.3 — drop the optimistic snapshot and refetch canonical
      // timeline. The fresh server projection will overwrite the
      // optimistic guess (going through mergeVehicleMemory means a
      // stale server response still cannot regress us).
      invalidate(vehicle.id);
      fetchOne();
    } catch {
      rollback();
      Alert.alert(i18n.t('vehicles.status_update_error_title'), i18n.t('vehicles.status_update_error_msg'));
    } finally {
      setUpdatingStatus(false);
    }
  }, [vehicle, updatingStatus, optimisticPatch, invalidate, fetchOne, STATUS_TO_OPERATIONAL]);

  const handleRequestInspection = useCallback(async () => {
    if (!vehicle) return;
    // Optimistically log activity so timeline reflects intent immediately.
    // We don't fail the navigation if logging fails — the inspection form is
    // the priority. Status change happens through PATCH (frontend or future
    // hook from the request flow); we don't auto-promote here because the user
    // hasn't paid yet.
    try {
      await vehiclesApi.appendActivity(vehicle.id, 'inspection_requested', i18n.t('vehicles.activity_inspection_open'));
    } catch {
      // swallow — non-critical
    }
    router.push({
      pathname: '/auto-request/create' as any,
      params: { type: 'inspection', vehicleId: vehicle.id, prefillUrl: vehicle.listing_url || '' },
    });
  }, [vehicle, router]);

  const handleOpenListing = useCallback(() => {
    if (!vehicle?.listing_url) return;
    Linking.openURL(vehicle.listing_url).catch(() => {
      Alert.alert(i18n.t('vehicles.listing_open_error_title'), i18n.t('vehicles.listing_open_error_msg'));
    });
  }, [vehicle]);

  // ── render ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
        <Header colors={colors} title="" onBack={() => router.back()} />
        <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  if (errorState || !vehicle) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
        <Header colors={colors} title={t('vehicles.header_error_title')} onBack={() => router.back()} />
        <View style={styles.center}>
          <Ionicons
            name={errorState === 'auth' ? 'lock-closed' : 'alert-circle-outline'}
            size={48}
            color={colors.textSecondary}
          />
          <Text style={[styles.errTitle, { color: colors.text }]}>
            {errorState === 'auth' ? t('vehicles.auth_required_title')
              : errorState === 'not_found' ? t('vehicles.error_not_found_title')
              : t('vehicles.error_fetch_title')}
          </Text>
          <Text style={[styles.errSub, { color: colors.textSecondary }]}>
            {errorState === 'auth'
              ? t('vehicles.error_auth_msg')
              : errorState === 'not_found'
                ? t('vehicles.error_not_found_msg')
                : t('vehicles.error_fetch_msg')}
          </Text>
          {errorState === 'auth' ? (
            <TouchableOpacity testID="vehicle-detail-login-cta" onPress={() => router.push('/login')} style={[styles.primaryBtn, { backgroundColor: colors.primary }]}>
              <Text style={styles.primaryBtnTxt}>{t('common.login')}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity testID="vehicle-detail-back-cta" onPress={() => router.replace('/vehicles' as any)} style={[styles.primaryBtn, { backgroundColor: colors.primary }]}>
              <Text style={styles.primaryBtnTxt}>{t('vehicles.error_back_cta')}</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const meta = [
    vehicle.year ? String(vehicle.year) : null,
    typeof vehicle.mileage === 'number' ? `${fmt(vehicle.mileage)} ${t('common.km')}` : null,
    vehicle.fuel ? vehicle.fuel.toUpperCase() : null,
    vehicle.transmission || null,
    vehicle.location || null,
  ].filter(Boolean) as string[];

  const priceTxt = vehicle.price ? `€${fmt(vehicle.price)}` : '—';
  const currentStatusIdx = STATUS_FLOW.findIndex((s) => s.key === vehicle.status);
  const safeStatusIdx = currentStatusIdx >= 0 ? currentStatusIdx : 0;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <Header colors={colors} title={`${vehicle.brand} ${vehicle.model}`} onBack={() => router.back()} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ paddingBottom: 120 }}
          testID="vehicle-workspace"
          keyboardShouldPersistTaps="handled"
        >
          {/* ─── Hero ─── */}
          <View style={[styles.hero, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {/* Image placeholder — keep it premium but neutral. We don't fake a
                photo when none is available; instead we render a quiet icon. */}
            <View style={[styles.heroImage, { backgroundColor: 'rgba(127,127,127,0.08)' }]}>
              {vehicle.thumbnail ? (
                // Future scope: <Image source={{ uri: vehicle.thumbnail }} ... />
                <Ionicons name="car-sport" size={64} color={colors.textSecondary} />
              ) : (
                <Ionicons name="car-sport-outline" size={64} color={colors.textSecondary} />
              )}
            </View>
            <View style={styles.heroBody}>
              <Text style={[styles.heroBrand, { color: colors.text }]} numberOfLines={1}>
                {vehicle.brand} {vehicle.model}
              </Text>
              {meta.length > 0 && (
                <Text style={[styles.heroMeta, { color: colors.textSecondary }]} numberOfLines={2}>
                  {meta.join(' · ')}
                </Text>
              )}
              <View style={styles.heroPriceRow}>
                <Text style={[styles.heroPrice, { color: colors.text }]}>{priceTxt}</Text>
                {vehicle.source ? (
                  <View style={[styles.sourceBadge, { borderColor: colors.border }]}>
                    <Ionicons name="link" size={10} color={colors.textSecondary} />
                    <Text style={[styles.sourceTxt, { color: colors.textSecondary }]} numberOfLines={1}>
                      {vehicle.source}
                    </Text>
                  </View>
                ) : null}
              </View>
              {vehicle.listing_url ? (
                <TouchableOpacity
                  testID="vehicle-open-listing"
                  onPress={handleOpenListing}
                  activeOpacity={0.7}
                  style={[styles.linkBtn, { borderColor: colors.border }]}
                >
                  <Ionicons name="open-outline" size={14} color={colors.text} />
                  <Text style={[styles.linkBtnTxt, { color: colors.text }]} numberOfLines={1}>
                    {t('vehicles.open_listing')}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          {/* ─── P4.2: Memory badge ─── derived in shared/, surface only renders.
              P4.3: reads from cache fallback → optimistic update is visible
              instantly, rollback restores prior render in the same tick. */}
          {effectiveMemory ? (
            <View
              testID="vehicle-memory-badge"
              style={[
                styles.memoryCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <View style={styles.memoryRow}>
                <Text style={[styles.memoryStage, { color: colors.textSecondary }]}>
                  {t(STAGE_LABEL_KEY[effectiveMemory.memoryStage]).toUpperCase()}
                </Text>
                <View
                  style={[
                    styles.perceptionPill,
                    { backgroundColor: PERCEPTION_TONE[effectiveMemory.customerPerception] + '22', borderColor: PERCEPTION_TONE[effectiveMemory.customerPerception] },
                  ]}
                >
                  <Text style={[styles.perceptionTxt, { color: PERCEPTION_TONE[effectiveMemory.customerPerception] }]}>
                    {t(PERCEPTION_LABEL_KEY[effectiveMemory.customerPerception])}
                  </Text>
                </View>
              </View>
              <Text style={[styles.memoryHint, { color: colors.textSecondary }]}>
                {t(STAGE_HINT_KEY[effectiveMemory.memoryStage])}
              </Text>
            </View>
          ) : null}

          {/* ─── Status progression ─── */}
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>{t('vehicles.section_status')}</Text>
            <View style={styles.statusRow}>
              {STATUS_FLOW.map((s, idx) => {
                const reached = idx <= safeStatusIdx;
                const active = idx === safeStatusIdx;
                return (
                  <TouchableOpacity
                    key={s.key as string}
                    testID={`vehicle-status-${s.key}`}
                    activeOpacity={0.75}
                    disabled={updatingStatus || active}
                    onPress={() => handleStatusChange(s.key)}
                    style={[
                      styles.statusChip,
                      {
                        backgroundColor: active ? colors.primary : (reached ? 'rgba(245,184,0,0.10)' : colors.card),
                        borderColor: active ? colors.primary : (reached ? colors.primary : colors.border),
                      },
                    ]}
                  >
                    <Ionicons
                      name={s.icon}
                      size={14}
                      color={active ? '#000' : (reached ? colors.primary : colors.textSecondary)}
                    />
                    <Text
                      style={[
                        styles.statusChipTxt,
                        { color: active ? '#000' : (reached ? colors.text : colors.textSecondary) },
                      ]}
                      numberOfLines={1}
                    >
                      {t(s.labelKey)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={[styles.statusHint, { color: colors.textSecondary }]}>
              {t('vehicles.status_hint')}
            </Text>
          </View>

          {/* ─── Notes ─── */}
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>{t('vehicles.section_notes')}</Text>
              {savingNotes ? <ActivityIndicator size="small" color={colors.primary} /> : null}
            </View>
            <TextInput
              testID="vehicle-notes-input"
              value={notesDraft}
              onChangeText={(v) => { setNotesDraft(v); notesDirty.current = true; }}
              onBlur={handleNotesBlur}
              placeholder={t('vehicles.notes_placeholder')}
              placeholderTextColor={colors.textSecondary}
              multiline
              numberOfLines={4}
              maxLength={2000}
              style={[
                styles.notesInput,
                { color: colors.text, backgroundColor: colors.card, borderColor: colors.border },
              ]}
            />
            <Text style={[styles.notesHint, { color: colors.textSecondary }]}>
              {t('vehicles.notes_hint')}
            </Text>
          </View>

          {/* ─── P4.2: Timeline (shared projection) ───
              Combines vehicle.activity events with linked-domain refs
              (reports / quotes / payments / bookings) into one
              chronological strip — derivation lives in
              @platform/domain/state-machines/vehicle.projectVehicleTimeline.
              Surface only renders the typed result. */}
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>{t('vehicles.section_timeline')}</Text>
            <Timeline items={timelineItems} colors={colors} t={t} />
          </View>

          {/* ─── P4.2: Linked records (counts derived in shared `VehicleMemory.counts`) ─── */}
          {effectiveMemory ? (
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>{t('vehicles.section_linked')}</Text>
              <View style={[styles.linkedCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <LinkedRow icon="document-text" label={t('vehicles.linked.reports')}  count={effectiveMemory.counts.reports}  colors={colors} />
                <LinkedRow icon="pricetag"      label={t('vehicles.linked.quotes')}   count={effectiveMemory.counts.quotes}   colors={colors} />
                <LinkedRow icon="card"          label={t('vehicles.linked.payments')} count={effectiveMemory.counts.payments} colors={colors} />
                <LinkedRow icon="calendar"      label={t('vehicles.linked.bookings')} count={effectiveMemory.counts.bookings} colors={colors} />
              </View>
            </View>
          ) : null}
        </ScrollView>

        {/* ─── Sticky CTA ─── */}
        <View style={[styles.ctaBar, { backgroundColor: colors.background, borderTopColor: colors.border }]}>
          <TouchableOpacity
            testID="vehicle-cta-inspect"
            onPress={handleRequestInspection}
            activeOpacity={0.85}
            style={[styles.cta, { backgroundColor: colors.primary }]}
          >
            <Ionicons name="shield-checkmark" size={20} color="#000" />
            <Text style={styles.ctaTxt}>{t('vehicles.cta_inspect')}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── helpers ────────────────────────────────────────────────────────────
function Header({ colors, title, onBack }: any) {
  return (
    <View style={[styles.header, { borderBottomColor: colors.border }]}>
      <TouchableOpacity onPress={onBack} style={styles.headerSide} testID="vehicle-detail-back">
        <Ionicons name="chevron-back" size={26} color={colors.text} />
      </TouchableOpacity>
      <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>{title}</Text>
      <View style={styles.headerSide} />
    </View>
  );
}

function Timeline({ items, colors, t }: { items: ReadonlyArray<import('@platform/domain/contracts/vehicle').VehicleTimelineItem>; colors: any; t: (k: string) => string }) {
  if (!items || items.length === 0) {
    return (
      <Text style={{ color: colors.textSecondary, fontSize: 13, padding: 12 }}>
        {t('vehicles.timeline_empty')}
      </Text>
    );
  }
  // The shared `projectVehicleTimeline` already returns items sorted
  // newest-first (it's part of the projection contract; surfaces MUST
  // NOT re-sort or re-derive severity).
  const fmtDate = (iso: string | null | undefined) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const day = String(d.getDate()).padStart(2, '0');
      const mon = d.toLocaleString('ru-RU', { month: 'short' });
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `${day} ${mon} · ${time}`;
    } catch { return iso; }
  };
  return (
    <View>
      {items.map((it, i) => {
        const sev = it.severity ?? 'info';
        const tone = SEVERITY_COLOR[sev];
        return (
          <View
            key={it.id || `${it.kind}-${it.at}-${i}`}
            style={timelineStyles.row}
            testID={`vehicle-timeline-item-${it.kind}`}
          >
            <View style={timelineStyles.dotCol}>
              <View style={[timelineStyles.dot, { backgroundColor: tone }]}>
                <Ionicons name={KIND_ICON[it.kind]} size={11} color="#000" />
              </View>
              {i < items.length - 1 && (
                <View style={[timelineStyles.line, { backgroundColor: colors.border }]} />
              )}
            </View>
            <View style={timelineStyles.body}>
              <Text style={[timelineStyles.title, { color: colors.text }]}>
                {it.title}
              </Text>
              {it.body ? (
                <Text style={[timelineStyles.text, { color: colors.textSecondary }]}>
                  {it.body}
                </Text>
              ) : null}
              <Text style={[timelineStyles.meta, { color: colors.textSecondary }]}>
                {fmtDate(it.at)}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function LinkedRow({ icon, label, count, colors }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  count: number;
  colors: any;
}) {
  return (
    <View style={styles.linkedRow}>
      <View style={styles.linkedRowL}>
        <Ionicons name={icon} size={16} color={colors.textSecondary} />
        <Text style={[styles.linkedRowLabel, { color: colors.text }]}>{label}</Text>
      </View>
      <Text style={[styles.linkedRowCount, { color: count > 0 ? colors.primary : colors.textSecondary }]}>
        {count}
      </Text>
    </View>
  );
}

const timelineStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 40 },
  dotCol: { width: 28, alignItems: 'center' },
  dot: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  line: { width: 2, flex: 1, marginTop: 2, opacity: 0.7 },
  body: { flex: 1, paddingBottom: 14 },
  title: { fontSize: 13, fontWeight: '700' },
  text: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  meta: { fontSize: 11, fontWeight: '600', marginTop: 2 },
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerSide: { width: 60, alignItems: 'flex-start' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },

  // Hero
  hero: {
    margin: 16,
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  heroImage: {
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBody: { padding: 16, gap: 6 },
  heroBrand: { fontSize: 22, fontWeight: '900', letterSpacing: -0.4 },
  heroMeta: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
  heroPriceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  heroPrice: { fontSize: 24, fontWeight: '900', letterSpacing: -0.4 },
  sourceBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 6, borderWidth: 1,
  },
  sourceTxt: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  linkBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8, borderWidth: 1,
    marginTop: 10,
  },
  linkBtnTxt: { fontSize: 12, fontWeight: '700' },

  section: { paddingHorizontal: 16, marginTop: 8, marginBottom: 16 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionLabel: {
    fontSize: 11, fontWeight: '800',
    textTransform: 'uppercase', letterSpacing: 0.6,
    marginBottom: 10,
  },

  // Status
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statusChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 10, borderWidth: 1.5,
  },
  statusChipTxt: { fontSize: 12, fontWeight: '700' },
  statusHint: { fontSize: 11, marginTop: 8, lineHeight: 14 },

  // Notes
  notesInput: {
    minHeight: 100, padding: 14,
    borderRadius: 12, borderWidth: 1.5,
    fontSize: 14, lineHeight: 20,
    textAlignVertical: 'top',
  },
  notesHint: { fontSize: 11, marginTop: 6 },

  // Related placeholder
  relatedBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    padding: 14, borderRadius: 12, borderWidth: 1,
  },
  relatedTitle: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  relatedSub: { fontSize: 12, lineHeight: 16 },

  // P4.2 — Memory badge (shared projection result)
  memoryCard: {
    marginHorizontal: 16, marginTop: 4,
    padding: 14, borderRadius: 14, borderWidth: 1,
  },
  memoryRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 6,
  },
  memoryStage: { fontSize: 11, fontWeight: '900', letterSpacing: 1.0 },
  memoryHint: { fontSize: 12, lineHeight: 16 },
  perceptionPill: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999, borderWidth: 1,
  },
  perceptionTxt: { fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },

  // P4.2 — Linked records counters
  linkedCard: { borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  linkedRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(127,127,127,0.18)',
  },
  linkedRowL: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  linkedRowLabel: { fontSize: 14, fontWeight: '600' },
  linkedRowCount: { fontSize: 16, fontWeight: '900', minWidth: 20, textAlign: 'right' },

  // CTA
  ctaBar: {
    paddingHorizontal: 16, paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, height: 52, borderRadius: 14,
  },
  ctaTxt: { fontSize: 15, fontWeight: '900', color: '#000', letterSpacing: -0.2 },

  // Error states
  errTitle: { fontSize: 18, fontWeight: '800', textAlign: 'center', marginTop: 8 },
  errSub: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  primaryBtn: { paddingHorizontal: 22, paddingVertical: 12, borderRadius: 14, marginTop: 12 },
  primaryBtnTxt: { fontSize: 15, fontWeight: '800', color: '#000' },
});

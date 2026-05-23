/**
 * Car-Selection timeline — customer-facing detail screen.
 *
 * Renders one CarSelectionRequest with:
 *   • status chip (locked palette per lifecycle status)
 *   • service-type chip
 *   • description card
 *   • optional sourceLink + budget block
 *   • timeline (newest first)
 *   • "Cancel request" button when status is non-terminal
 *
 * Reads `/api/car-selection/requests/{id}`. The customer can only see
 * requests they own — backend enforces this with a 404.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import CarSelectionThreadBlock from '../../src/components/CarSelectionThreadBlock';
import OfferPackageBlock from '../../src/components/OfferPackageBlock';
import { mapCarSelectionError } from '../../src/i18n/carSelectionErrors';
import i18n from '../../src/i18n';

type Status =
  | 'submitted' | 'reviewing' | 'assigned'
  | 'in_progress' | 'waiting_customer'
  | 'completed' | 'cancelled';

type ServiceType =
  | 'budget_search' | 'market_search'
  | 'negotiation_help' | 'listing_review';

interface TimelineEvent {
  type: string;
  at: string;
  actorRole?: string;
  note?: string | null;
  data?: Record<string, any> | null;
}

interface CarSelectionDoc {
  id: string;
  serviceType: ServiceType;
  countryCode: string;
  cityId: string;
  description: string;
  sourceLink?: string | null;
  budget?: {
    budgetMin?: number;
    budgetMax?: number;
    brands?: string[];
    fuelTypes?: string[];
    transmission?: string;
  } | null;
  status: Status;
  assignedAdminId?: string | null;
  assignedProviderId?: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineEvent[];
}

// Status colour palette is locked to keep audit screenshots readable.
// Grey for "not yet picked up", blue for active, green for done,
// muted red for cancelled.
const STATUS_COLOR: Record<Status, string> = {
  submitted:        '#9CA3AF',
  reviewing:        '#3B82F6',
  assigned:         '#3B82F6',
  in_progress:      '#10B981',
  waiting_customer: '#F59E0B',
  completed:        '#10B981',
  cancelled:        '#EF4444',
};

const TERMINAL: Status[] = ['completed', 'cancelled'];

// Locale-aware date formatter — uses the device locale via Intl. The
// thread block elsewhere uses dd.mm pattern; on the timeline we keep
// the more contextual dd.mm.yy + hh:mm rendering.
function formatDate(iso: string, locale: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(locale, {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}


export default function CarSelectionDetailScreen() {
  const { t, i18n } = useTranslation();
  const { colors, isDark } = useThemeContext();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[]; focusPackageId?: string | string[] }>();
  const requestId = Array.isArray(params.id) ? params.id[0] : params.id;
  const focusPackageId = Array.isArray(params.focusPackageId) ? params.focusPackageId[0] : params.focusPackageId;

  const [doc, setDoc] = useState<CarSelectionDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Localized maps — derived from t() so language switches re-render naturally.
  // Customer surface gets the "waiting for you" variant of the wait status.
  const STATUS_LABEL: Record<Status, string> = useMemo(() => ({
    submitted:        i18n.t('car_selection.status.submitted'),
    reviewing:        i18n.t('car_selection.status.reviewing'),
    assigned:         i18n.t('car_selection.status.assigned'),
    in_progress:      i18n.t('car_selection.status.in_progress'),
    waiting_customer: i18n.t('car_selection.status.waiting_customer_customer'),
    completed:        i18n.t('car_selection.status.completed'),
    cancelled:        i18n.t('car_selection.status.cancelled'),
  }), [t]);

  const SERVICE_LABEL: Record<ServiceType, string> = useMemo(() => ({
    budget_search:    i18n.t('car_selection.service.budget_search'),
    market_search:    i18n.t('car_selection.service.market_search'),
    negotiation_help: i18n.t('car_selection.service.negotiation_help'),
    listing_review:   i18n.t('car_selection.service.listing_review'),
  }), [t]);

  const eventLabel = useCallback((ev: TimelineEvent): string => {
    // Canonical event types map into car_selection.timeline_event.* keys.
    const key = `car_selection.timeline_event.${ev.type}`;
    const v = i18n.t(key, { defaultValue: '' });
    if (v) return v;
    // Fallback for status:* events that may not have a direct timeline_event entry.
    if (ev.type.startsWith('status:')) {
      const to = ev.type.replace('status:', '') as Status;
      return STATUS_LABEL[to] || ev.type;
    }
    return ev.type;
  }, [t, STATUS_LABEL]);

  const load = useCallback(async () => {
    if (!requestId) return;
    try {
      const res = await api.get(`/car-selection/requests/${requestId}`);
      setDoc(res.data as CarSelectionDoc);
      setErr(null);
    } catch (e: any) {
      setErr(mapCarSelectionError(t, e) || i18n.t('car_selection.load_failed'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [requestId, t]);

  useEffect(() => { load(); }, [load]);

  const handleCancel = useCallback(() => {
    if (!requestId || !doc) return;
    Alert.alert(
      i18n.t('car_selection.cancel.modal_title'),
      i18n.t('car_selection.cancel.modal_body'),
      [
        { text: i18n.t('car_selection.cancel.modal_keep'), style: 'cancel' },
        {
          text: i18n.t('car_selection.cancel.modal_confirm'), style: 'destructive',
          onPress: async () => {
            setCancelling(true);
            try {
              const res = await api.post(`/car-selection/requests/${requestId}/cancel`, {});
              setDoc(res.data as CarSelectionDoc);
            } catch (e: any) {
              Alert.alert(
                i18n.t('car_selection.cancel.failed'),
                mapCarSelectionError(t, e),
              );
            } finally {
              setCancelling(false);
            }
          },
        },
      ],
    );
  }, [requestId, doc, t]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </SafeAreaView>
    );
  }
  if (err || !doc) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: colors.background }]} edges={['top']}>
        <Ionicons name="alert-circle-outline" size={36} color={colors.danger} />
        <Text style={[styles.errorText, { color: colors.text }]}>{err || t('car_selection.not_found')}</Text>
        <TouchableOpacity onPress={() => router.back()} style={[styles.outlineBtn, { borderColor: colors.border }]}>
          <Text style={{ color: colors.text, fontWeight: '700' }}>{t('car_selection.back')}</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const statusColor = STATUS_COLOR[doc.status];
  const isTerminal = TERMINAL.includes(doc.status);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          testID="car-selection-detail-back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
          {t('car_selection.title')}
        </Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        {/* Status + service chips */}
        <View style={styles.chipRow}>
          <View
            testID={`car-selection-status-${doc.status}`}
            style={[styles.chip, { borderColor: statusColor, backgroundColor: statusColor + '14' }]}
          >
            <View style={[styles.chipDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.chipText, { color: statusColor }]}>
              {STATUS_LABEL[doc.status]}
            </Text>
          </View>
          <View style={[styles.chipSecondary, { borderColor: colors.border, backgroundColor: colors.card }]}>
            <Ionicons name="pricetag-outline" size={12} color={colors.textSecondary} />
            <Text style={[styles.chipSecondaryText, { color: colors.text }]}>
              {SERVICE_LABEL[doc.serviceType]}
            </Text>
          </View>
        </View>

        {/* City + creation */}
        <View style={[styles.meta, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <View style={styles.metaRow}>
            <Ionicons name="location-outline" size={14} color={colors.textSecondary} />
            <Text style={[styles.metaText, { color: colors.text }]}>{doc.cityId} · {doc.countryCode}</Text>
          </View>
          <View style={styles.metaRow}>
            <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
            <Text style={[styles.metaText, { color: colors.text }]}>
              {t('car_selection.meta.created')} {formatDate(doc.createdAt, i18n.language)}
            </Text>
          </View>
          {doc.assignedAdminId || doc.assignedProviderId ? (
            <View style={styles.metaRow}>
              <Ionicons name="person-outline" size={14} color={colors.textSecondary} />
              <Text style={[styles.metaText, { color: colors.text }]} numberOfLines={1}>
                {t('car_selection.meta.assigned_label')}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Description */}
        <Text style={[styles.sectionLabel, { color: colors.textMuted || colors.textSecondary }]}>
          {t('car_selection.section.description')}
        </Text>
        <View style={[styles.block, { borderColor: colors.border, backgroundColor: colors.card }]}>
          <Text style={[styles.body14, { color: colors.text }]}>{doc.description}</Text>
        </View>

        {/* Source link */}
        {doc.sourceLink ? (
          <>
            <Text style={[styles.sectionLabel, { color: colors.textMuted || colors.textSecondary }]}>
              {t('car_selection.section.source')}
            </Text>
            <View style={[styles.block, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Text testID="car-selection-source-link"
                style={[styles.body14, { color: colors.primary }]}
                numberOfLines={2}
              >
                {doc.sourceLink}
              </Text>
            </View>
          </>
        ) : null}

        {/* Budget block */}
        {doc.budget ? (
          <>
            <Text style={[styles.sectionLabel, { color: colors.textMuted || colors.textSecondary }]}>
              {t('car_selection.section.criteria')}
            </Text>
            <View style={[styles.block, { borderColor: colors.border, backgroundColor: colors.card }]}>
              {(doc.budget.budgetMin || doc.budget.budgetMax) ? (
                <Text style={[styles.body14, { color: colors.text }]}>
                  {t('car_selection.criteria.budget')}: {doc.budget.budgetMin ? `${t('car_selection.criteria.budget_from')} €${doc.budget.budgetMin} ` : ''}
                  {doc.budget.budgetMax ? `${t('car_selection.criteria.budget_to')} €${doc.budget.budgetMax}` : ''}
                </Text>
              ) : null}
              {doc.budget.brands?.length ? (
                <Text style={[styles.body14, { color: colors.text }]}>{t('car_selection.criteria.brands')}: {doc.budget.brands.join(', ')}</Text>
              ) : null}
              {doc.budget.fuelTypes?.length ? (
                <Text style={[styles.body14, { color: colors.text }]}>{t('car_selection.criteria.fuel')}: {doc.budget.fuelTypes.join(', ')}</Text>
              ) : null}
              {doc.budget.transmission ? (
                <Text style={[styles.body14, { color: colors.text }]}>{t('car_selection.criteria.transmission')}: {doc.budget.transmission}</Text>
              ) : null}
            </View>
          </>
        ) : null}

        {/* Timeline */}
        <Text style={[styles.sectionLabel, { color: colors.textMuted || colors.textSecondary }]}>
          {t('car_selection.section.history')}
        </Text>
        <View
          testID="car-selection-timeline"
          style={[styles.block, { borderColor: colors.border, backgroundColor: colors.card }]}
        >
          {[...doc.timeline].reverse().map((ev, idx, arr) => (
            <View key={`${ev.at}-${idx}`} style={styles.tlRow}>
              <View style={[styles.tlDot, { backgroundColor: colors.primary }]} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.tlTitle, { color: colors.text }]}>{eventLabel(ev)}</Text>
                <Text style={[styles.tlMeta, { color: colors.textSecondary }]}>
                  {formatDate(ev.at, i18n.language)}{ev.actorRole ? ` · ${ev.actorRole}` : ''}
                </Text>
                {ev.note ? (
                  <Text style={[styles.tlNote, { color: colors.text }]}>{ev.note}</Text>
                ) : null}
              </View>
              {idx < arr.length - 1 ? (
                <View style={[styles.tlLine, { backgroundColor: colors.border }]} />
              ) : null}
            </View>
          ))}
        </View>

        {/* Offer packages (Car-Selection-6) — commercial decision surface */}
        <View style={{ marginBottom: 18 }}>
          <OfferPackageBlock
            requestId={doc.id}
            surface="customer"
            isDark={isDark}
            focusPackageId={typeof focusPackageId === 'string' ? focusPackageId : null}
          />
        </View>

        {/* Thread (Car-Selection-4) — append-only operational messages */}
        <View style={{ marginBottom: 18 }}>
          <Text style={[styles.sectionLabel, { color: colors.textMuted || colors.textSecondary }]}>
            {t('car_selection.section.thread')}
          </Text>
          <CarSelectionThreadBlock
            requestId={doc.id}
            surface="customer"
            isDark={isDark}
          />
        </View>

        {/* Cancel button — only for non-terminal */}
        {!isTerminal ? (
          <TouchableOpacity
            testID="car-selection-cancel"
            onPress={handleCancel}
            disabled={cancelling}
            style={[styles.cancelBtn, { borderColor: colors.danger, opacity: cancelling ? 0.6 : 1 }]}
            activeOpacity={0.85}
          >
            {cancelling ? (
              <ActivityIndicator color={colors.danger} />
            ) : (
              <>
                <Ionicons name="close-circle-outline" size={18} color={colors.danger} />
                <Text style={[styles.cancelText, { color: colors.danger }]}>
                  {t('car_selection.cancel.button')}
                </Text>
              </>
            )}
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  errorText: { fontSize: 14, fontWeight: '600', marginTop: 4 },
  outlineBtn: { marginTop: 4, borderWidth: 1, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 9 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingTop: 8, paddingBottom: 8,
  },
  backBtn: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  headerTitle: { fontSize: 17, fontWeight: '700', flex: 1, textAlign: 'center' },

  body: { paddingHorizontal: 16, paddingBottom: 36 },

  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 14 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, borderWidth: 1,
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontSize: 11.5, fontWeight: '700', letterSpacing: 0.3 },
  chipSecondary: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, borderWidth: 1,
  },
  chipSecondaryText: { fontSize: 11.5, fontWeight: '700' },

  meta: {
    borderRadius: 12, borderWidth: 1,
    padding: 12, gap: 6, marginBottom: 18,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaText: { fontSize: 13, fontWeight: '600' },

  sectionLabel: {
    fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: 8,
  },
  block: {
    borderRadius: 12, borderWidth: 1,
    padding: 14, gap: 6, marginBottom: 18,
  },
  body14: { fontSize: 14, lineHeight: 21, fontWeight: '500' },

  tlRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    gap: 10, marginBottom: 12,
  },
  tlDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  tlLine: { position: 'absolute', left: 3, top: 14, bottom: -10, width: 2 },
  tlTitle: { fontSize: 13.5, fontWeight: '700' },
  tlMeta: { fontSize: 11.5, marginTop: 1 },
  tlNote: { fontSize: 13, marginTop: 4, lineHeight: 18 },

  cancelBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 13, borderRadius: 12, borderWidth: 1,
    marginTop: 8,
  },
  cancelText: { fontSize: 14, fontWeight: '700' },
});

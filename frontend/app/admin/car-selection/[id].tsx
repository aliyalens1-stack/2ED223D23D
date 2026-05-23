/**
 * Car-Selection · Admin Detail (Phase 8).
 *
 * Read-only governance surface. Renders:
 *   • frozen customer brief
 *   • lifecycle status + service-type chips
 *   • OfferPackageBlock with surface="admin"
 *     → admin sees ALL packages (including drafts) and can revoke
 *       non-terminal ones. NO editing, NO content mutation.
 *
 * Hard invariants:
 *   • Admin DOES NOT edit package content. Revoke is the only
 *     write surface — handled inside OfferPackageBlock by hitting
 *     POST /api/admin/car-selection/{rid}/offer-packages/{pid}/revoke.
 *   • Thread is NOT rendered here. Admin governance is package-level,
 *     not message-level; thread is a separate inspection surface.
 *   • Deep-link `?focusPackageId=…` flashes the targeted card.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  ActivityIndicator, RefreshControl, TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useThemeContext } from '../../../src/context/ThemeContext';
import { api } from '../../../src/services/api';
import OfferPackageBlock from '../../../src/components/OfferPackageBlock';
import CarSelectionInboxBell from '../../../src/components/CarSelectionInboxBell';
import { tokens } from '../../../src/theme/tokens';
import i18n from '../../../src/i18n';

type Status =
  | 'submitted' | 'reviewing' | 'assigned'
  | 'in_progress' | 'waiting_customer'
  | 'completed' | 'cancelled';

interface AdminDoc {
  id: string;
  customerId: string;
  serviceType: string;
  countryCode: string;
  cityId: string;
  description: string;
  sourceLink: string | null;
  status: Status;
  assignedProviderId: string | null;
  assignedAdminId: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: Array<{ type: string; at: string; actorRole?: string; note?: string | null }>;
}

const C = tokens.colors;
const S = tokens.spacing;
const R = tokens.radius;

const STATUS_TONE: Record<Status, string> = {
  submitted: C.warning,
  reviewing: C.brand,
  assigned: C.brand,
  in_progress: C.brand,
  waiting_customer: C.warning,
  completed: C.success,
  cancelled: C.error,
};

export default function AdminCarSelectionDetailScreen() {
  const { t } = useTranslation();
  const { isDark } = useThemeContext();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[]; focusPackageId?: string | string[] }>();
  const requestId = Array.isArray(params.id) ? params.id[0] : params.id;
  const focusPackageId = Array.isArray(params.focusPackageId) ? params.focusPackageId[0] : params.focusPackageId;

  const [doc, setDoc] = useState<AdminDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const styles = useMemo(() => makeStyles(isDark), [isDark]);

  const load = useCallback(async () => {
    if (!requestId) return;
    try {
      const { data } = await api.get<AdminDoc>(`/admin/car-selection/${requestId}`);
      setDoc(data);
      setErr(null);
    } catch (e: any) {
      const code = e?.response?.status;
      if (code === 404) setErr(i18n.t('car_selection.not_found'));
      else setErr(i18n.t('car_selection.load_failed'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [requestId, t]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  if (loading && !doc) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={C.brand} />
      </SafeAreaView>
    );
  }

  if (err || !doc) {
    return (
      <SafeAreaView style={styles.center}>
        <Ionicons name="alert-circle-outline" size={28} color={isDark ? C.subtextDark : C.subtextLight} />
        <Text style={styles.errorText}>{err || t('car_selection.not_found')}</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="admin-cs-back">
          <Text style={styles.backText}>{t('car_selection.back')}</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const tone = STATUS_TONE[doc.status] || C.subtextDark;

  return (
    <SafeAreaView style={styles.screen} testID="admin-car-selection-detail">
      <Stack.Screen
        options={{
          title: t('car_selection.title'),
          // Phase 9 — admin parity with customer bell discipline
          // (U4). Count-only, no dropdown, no realtime. The bell
          // disables itself silently on 401/403, so it's safe to
          // mount even though admin reaches this screen via
          // deep-link rather than as a tab entry.
          headerRight: () => <CarSelectionInboxBell testID="admin-cs-inbox-bell" />,
        }}
      />
      <ScrollView
        contentContainerStyle={{ padding: S.md, paddingBottom: S.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.brand} />}
      >
        {/* Status row */}
        <View style={styles.headerRow}>
          <View style={[styles.statusPill, { backgroundColor: tone + '22', borderColor: tone }]}>
            <Text style={[styles.statusPillText, { color: tone }]}>{doc.status.toUpperCase()}</Text>
          </View>
          <View style={styles.svcChip} testID="admin-cs-service-type">
            <Text style={styles.svcChipText}>{doc.serviceType}</Text>
          </View>
          <Text style={styles.metaText}>{doc.countryCode} · {doc.cityId}</Text>
        </View>

        {/* Customer brief (read-only) */}
        <View style={styles.briefCard} testID="admin-cs-brief">
          <View style={styles.briefHeader}>
            <Ionicons name="lock-closed" size={12} color={isDark ? C.subtextDark : C.subtextLight} />
            <Text style={styles.briefHeaderText}>
              {t('car_selection.brief.frozen_title', { defaultValue: 'Customer brief (frozen)' })}
            </Text>
          </View>
          <Text style={styles.briefText} selectable>{doc.description}</Text>
          {doc.sourceLink ? (
            <Text style={styles.briefLink} numberOfLines={1} selectable>{doc.sourceLink}</Text>
          ) : null}
        </View>

        {/* Assignment chips */}
        <View style={styles.assignRow}>
          <View style={styles.assignChip}>
            <Ionicons name="person-outline" size={12} color={isDark ? C.subtextDark : C.subtextLight} />
            <Text style={styles.assignChipText} testID="admin-cs-assigned-provider">
              {doc.assignedProviderId
                ? `provider: ${doc.assignedProviderId.slice(0, 8)}…`
                : t('car_selection.brief.unassigned', { defaultValue: 'No provider assigned' })}
            </Text>
          </View>
          <View style={styles.assignChip}>
            <Ionicons name="shield-checkmark-outline" size={12} color={isDark ? C.subtextDark : C.subtextLight} />
            <Text style={styles.assignChipText} testID="admin-cs-assigned-admin">
              {doc.assignedAdminId ? `admin: ${doc.assignedAdminId.slice(0, 8)}…` : '—'}
            </Text>
          </View>
        </View>

        {/* Offer packages — admin governance (read-only content + revoke) */}
        <OfferPackageBlock
          requestId={doc.id}
          surface="admin"
          isDark={isDark}
          focusPackageId={focusPackageId || null}
        />

        {/* Timeline — compact rail */}
        <View style={styles.timelineBlock} testID="admin-cs-timeline">
          <Text style={styles.sectionLabel}>
            {t('car_selection.section.timeline', { defaultValue: 'Timeline' })} · {doc.timeline.length}
          </Text>
          {doc.timeline.slice().reverse().map((ev, idx) => (
            <View key={idx} style={styles.tlRow}>
              <View style={styles.tlDot} />
              <View style={{ flex: 1 }}>
                <Text style={styles.tlType}>{ev.type}</Text>
                <Text style={styles.tlMeta}>
                  {new Date(ev.at).toLocaleString()} · {ev.actorRole || '—'}
                </Text>
                {ev.note ? <Text style={styles.tlNote}>«{ev.note}»</Text> : null}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(isDark: boolean) {
  const bg = isDark ? C.bgDark : C.bgLight;
  const card = isDark ? C.cardDark : C.cardLight;
  const text = isDark ? C.textDark : C.textLight;
  const subtext = isDark ? C.subtextDark : C.subtextLight;
  const border = isDark ? C.borderDark : C.borderLight;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: bg },
    center: { flex: 1, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', padding: S.md, gap: S.sm },
    errorText: { fontSize: tokens.typography.caption, color: subtext, textAlign: 'center' },
    backBtn: { paddingHorizontal: S.md, paddingVertical: S.sm, borderRadius: R.sm, borderWidth: 1, borderColor: border },
    backText: { color: text, fontSize: tokens.typography.caption },

    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: S.sm },
    statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.sm, borderWidth: 1 },
    statusPillText: { fontSize: tokens.typography.micro, fontWeight: '800', letterSpacing: 0.6 },
    svcChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: R.sm, backgroundColor: card, borderWidth: 1, borderColor: border },
    svcChipText: { fontSize: tokens.typography.micro, color: text, fontWeight: '600' },
    metaText: { fontSize: tokens.typography.micro, color: subtext, marginLeft: 'auto' },

    briefCard: { backgroundColor: card, borderRadius: R.md, borderWidth: 1, borderColor: border, padding: S.md, marginTop: S.sm, gap: 6 },
    briefHeader: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    briefHeaderText: { fontSize: tokens.typography.micro, color: subtext, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
    briefText: { fontSize: tokens.typography.caption + 1, color: text, lineHeight: 20 },
    briefLink: { fontSize: tokens.typography.micro, color: C.brand, marginTop: 4 },

    assignRow: { flexDirection: 'row', gap: 8, marginTop: S.sm, flexWrap: 'wrap' },
    assignChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: R.sm, backgroundColor: card, borderWidth: 1, borderColor: border },
    assignChipText: { fontSize: tokens.typography.micro, color: text },

    timelineBlock: { marginTop: S.md, backgroundColor: card, borderRadius: R.md, borderWidth: 1, borderColor: border, padding: S.md, gap: 8 },
    sectionLabel: { fontSize: tokens.typography.micro, color: subtext, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
    tlRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
    tlDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.brand, marginTop: 6 },
    tlType: { fontSize: tokens.typography.caption, color: text, fontWeight: '600' },
    tlMeta: { fontSize: tokens.typography.micro, color: subtext },
    tlNote: { fontSize: tokens.typography.micro, color: text, fontStyle: 'italic', marginTop: 2 },
  });
}

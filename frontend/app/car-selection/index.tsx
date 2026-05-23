/**
 * Car-Selection · Customer list (Phase 8.2).
 *
 * Customer's own car-selection requests, with a server-projected
 * "delivered offers" chip per row.
 *
 * Discipline (Phase 8.2 brief):
 *   • The chip count comes verbatim from `deliveredOffersCount` on
 *     each item. Frontend MUST NOT aggregate by re-fetching
 *     per-request offer-package lists.
 *   • Chip means: number of delivered, non-terminal, customer-visible
 *     packages. NOT total, NOT drafts, NOT accepted historicals,
 *     NOT competitor identities, NOT provider count, NOT "best
 *     offers". Pure scalar.
 *   • Chip is hidden when count == 0.
 *   • Tap on a row → request detail. Tap on the chip itself = same
 *     destination (no special "focus the offer-package block"
 *     parameter — keep this list a passive index, not a routing
 *     branch). Inbox row remains the surface for deep-linking a
 *     specific package.
 *   • Provider/admin do NOT see this screen. They have their own
 *     lists at `/provider/car-selection` and the admin detail
 *     surface.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import { tokens } from '../../src/theme/tokens';
import CarSelectionInboxBell from '../../src/components/CarSelectionInboxBell';
import i18n from '../../src/i18n';

type Status =
  | 'submitted' | 'reviewing' | 'assigned'
  | 'in_progress' | 'waiting_customer'
  | 'completed' | 'cancelled';

interface RequestItem {
  id: string;
  serviceType: string;
  countryCode: string;
  cityId: string;
  description: string;
  status: Status;
  createdAt: string;
  /** Server-projected count of delivered (non-terminal, visible)
   *  offer packages. Always present on the customer list endpoint;
   *  defaults to 0 when no packages exist yet. */
  deliveredOffersCount?: number;
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

export default function CustomerCarSelectionListScreen() {
  const { t } = useTranslation();
  const { isDark } = useThemeContext();
  const router = useRouter();

  const [items, setItems] = useState<RequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const styles = useMemo(() => makeStyles(isDark), [isDark]);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<{ items: RequestItem[]; total: number }>(
        '/car-selection/requests/me?limit=100'
      );
      setItems(data.items || []);
      setErr(null);
    } catch (e: any) {
      setErr(i18n.t('car_selection.list.load_failed', { defaultValue: 'Failed to load' }));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const renderRow = useCallback((it: RequestItem) => {
    const tone = STATUS_TONE[it.status] || C.subtextDark;
    const count = Math.max(0, Number(it.deliveredOffersCount || 0));
    return (
      <TouchableOpacity
        key={it.id}
        onPress={() => router.push(`/car-selection/${it.id}` as any)}
        activeOpacity={0.7}
        style={styles.card}
        testID={`cs-list-row-${it.id}`}
      >
        <View style={styles.cardTop}>
          <View style={[styles.statusPill, { backgroundColor: tone + '22', borderColor: tone }]}>
            <Text style={[styles.statusPillText, { color: tone }]}>{it.status.toUpperCase()}</Text>
          </View>
          <Text style={styles.svc} numberOfLines={1}>{it.serviceType}</Text>
          {count > 0 ? (
            <View style={styles.offersChip} testID={`cs-list-offers-chip-${it.id}`}>
              <Ionicons name="paper-plane" size={11} color={C.brand} />
              <Text style={styles.offersChipText}>
                {t('car_selection.list.offers_chip', { count, defaultValue: '{{count}} offer' })}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.desc} numberOfLines={2}>{it.description}</Text>
        <View style={styles.cardBottom}>
          <Text style={styles.meta}>{it.countryCode} · {it.cityId}</Text>
          <Text style={styles.meta}>{new Date(it.createdAt).toLocaleDateString()}</Text>
        </View>
      </TouchableOpacity>
    );
  }, [router, styles, t]);

  return (
    <SafeAreaView style={styles.screen} testID="cs-customer-list">
      <Stack.Screen options={{ title: t('car_selection.list.title', { defaultValue: 'My requests' }) }} />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {t('car_selection.list.title', { defaultValue: 'My requests' })}
        </Text>
        <CarSelectionInboxBell testID="cs-list-bell" />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={C.brand} /></View>
      ) : err ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{err}</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="document-outline" size={28} color={C.subtextDark} />
          <Text style={styles.emptyText}>
            {t('car_selection.list.empty', { defaultValue: 'No car-selection requests yet.' })}
          </Text>
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.brand} />}
          contentContainerStyle={{ padding: S.md, gap: S.sm }}
        >
          {items.map(renderRow)}
        </ScrollView>
      )}
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
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.md, paddingVertical: S.sm, borderBottomWidth: 1, borderBottomColor: border },
    headerTitle: { fontSize: tokens.typography.h3, color: text, fontWeight: '800' },

    center: { padding: S.lg, alignItems: 'center', justifyContent: 'center', gap: S.sm, flex: 1 },
    errorText: { color: C.error, fontSize: tokens.typography.caption },
    emptyText: { color: subtext, fontSize: tokens.typography.caption, fontStyle: 'italic' },

    card: { backgroundColor: card, borderWidth: 1, borderColor: border, borderRadius: R.md, padding: S.md, gap: 8 },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: R.sm, borderWidth: 1 },
    statusPillText: { fontSize: tokens.typography.micro, fontWeight: '800', letterSpacing: 0.6 },
    svc: { fontSize: tokens.typography.micro, color: subtext, fontWeight: '600', flex: 1 },
    offersChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: R.sm, backgroundColor: C.brand + '15', borderWidth: 1, borderColor: C.brand + '55' },
    offersChipText: { fontSize: tokens.typography.micro, color: C.brand, fontWeight: '800' },

    desc: { fontSize: tokens.typography.caption + 1, color: text, lineHeight: 20 },
    cardBottom: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
    meta: { fontSize: tokens.typography.micro, color: subtext },
  });
}

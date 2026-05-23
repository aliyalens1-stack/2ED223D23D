// Phase 3 — Inspector t('inspector.dostupnye_zadaniya') screen (exposure-driven).
// Replaces the open-jobs marketplace with a soft-curated list.
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import i18n from '../../src/i18n';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';

type Exposure = {
  id: string;
  requestId: string;
  jobId: string;
  city: string;
  rank: number;
  score: number;
  exposedAt: string;
  expiresAt: string;
  priceEstimate: number;
  request: {
    type: 'inspection' | 'selection';
    brand?: string;
    model?: string;
    budget?: number;
    country?: string;
    urgency?: string;
    links?: string[];
    comment?: string;
    yearFrom?: number;
    yearTo?: number;
    fuel?: string;
    transmission?: string;
    mileageMax?: number;
  };
};

type MyFeedResponse = {
  exposures: Exposure[];
  count: number;
  activeJobsCount: number;
  maxActiveJobs: number;
  canAccept: boolean;
  inspectorId: string;
};

const URGENCY_LABEL: Record<string, string> = {
  asap: i18n.t('inspector.segodnya'),
  '24h': i18n.t('inspector.24ch'),
  week: i18n.t('inspector.nedelya'),
};

export default function ExposuresScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useThemeContext();

  const [items, setItems] = useState<Exposure[]>([]);
  const [activeJobs, setActiveJobs] = useState(0);
  const [maxActive, setMaxActive] = useState(5);
  const [canAccept, setCanAccept] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<MyFeedResponse>('/inspector/exposures');
      setItems(res.data?.exposures ?? []);
      setActiveJobs(res.data?.activeJobsCount ?? 0);
      setMaxActive(res.data?.maxActiveJobs ?? 5);
      setCanAccept(res.data?.canAccept ?? true);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const accept = useCallback(
    async (exp: Exposure) => {
      if (actingId) return;
      if (!canAccept) {
        Alert.alert(
          i18n.t('inspector.limit_aktivnyh_zadanij'),
          i18n.t('inspector.u_vas_activejobs_iz_maxactive_aktivnyh_zadanij_zav')
        );
        return;
      }
      setActingId(exp.id);
      try {
        await api.post(`/inspector/exposures/${exp.id}/accept`);
        Alert.alert(i18n.t('inspector.prinyato'), i18n.t('inspector.zadanie_v_rabote_perejdite_v_moi_zadaniya'), [
          { text: 'OK', onPress: () => router.push('/inspector/jobs' as any) },
        ]);
        await load();
      } catch (e: any) {
        const status = e?.response?.status;
        let msg = i18n.t('inspector.ne_udalos_prinyat_zadanie');
        if (status === 409) {
          const detail = e?.response?.data?.message || e?.response?.data?.detail || '';
          if (/too_many_active_jobs/i.test(detail) || /too.many/i.test(detail)) {
            msg = i18n.t('inspector.limit_aktivnyh_zadanij_maxactive_zavershite_tekusc');
          } else {
            msg = i18n.t('inspector.zadanie_uzhe_prinyato_drugim_inspektorom');
          }
        } else if (status === 429) {
          msg = i18n.t('inspector.slishkom_mnogo_dejstvij_sdelajte_pauzu_na_minutu');
        }
        Alert.alert(i18n.t('chat.oshibka'), msg);
      } finally {
        setActingId(null);
      }
    },
    [actingId, canAccept, activeJobs, maxActive, load, router]
  );

  const reject = useCallback(
    async (exp: Exposure) => {
      if (actingId) return;
      Alert.alert(i18n.t('inspector.propustit_zadanie'), i18n.t('inspector.ono_bolshe_ne_poyavitsya_v_vashem_spiske'), [
        { text: i18n.t('inspector.otmena'), style: 'cancel' },
        {
          text: i18n.t('inspector.propustit'),
          style: 'destructive',
          onPress: async () => {
            setActingId(exp.id);
            try {
              await api.post(`/inspector/exposures/${exp.id}/reject`);
              await load();
            } catch {
              // silent
            } finally {
              setActingId(null);
            }
          },
        },
      ]);
    },
    [actingId, load]
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} testID="exposures-back">
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: colors.text }]}>{t('inspector.dostupnye_zadaniya')}</Text>
          <View style={{ width: 24 }} />
        </View>

        {!loading && items.length > 0 && (
          <View style={styles.subRow}>
            <Text style={[styles.subTitle, { color: colors.textSecondary }]}>
              Подобрано для вас · {items.length}
            </Text>
            <View
              testID="exposures-active-jobs-badge"
              style={[
                styles.activeBadge,
                canAccept
                  ? { backgroundColor: 'rgba(16,185,129,0.12)', borderColor: 'rgba(16,185,129,0.35)' }
                  : { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.35)' },
              ]}
            >
              <Ionicons
                name={canAccept ? 'briefcase-outline' : 'alert-circle-outline'}
                size={12}
                color={canAccept ? '#10B981' : '#EF4444'}
              />
              <Text style={[styles.activeBadgeText, { color: canAccept ? '#10B981' : '#EF4444' }]}>
                {activeJobs}/{maxActive} активных
              </Text>
            </View>
          </View>
        )}

        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {loading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : items.length === 0 ? (
            <View style={[styles.empty, { backgroundColor: colors.card, borderColor: colors.border }]} testID="exposures-empty">
              <Ionicons name="hourglass-outline" size={36} color={colors.textSecondary} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('inspector.poka_net_zadanij')}</Text>
              <Text style={[styles.emptySub, { color: colors.textSecondary }]}>
                Платформа подбирает вам задания по рейтингу, скорости и зоне. Проверьте позже.
              </Text>
            </View>
          ) : (
            items.map((exp) => <ExposureCard key={exp.id} exp={exp} onAccept={accept} onReject={reject} acting={actingId === exp.id} canAccept={canAccept} colors={colors} />)
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function ExposureCard({ exp, onAccept, onReject, acting, canAccept, colors }: any) {
  const isInspection = exp.request.type === 'inspection';
  const title = [exp.request.brand, exp.request.model].filter(Boolean).join(' ') || (isInspection ? i18n.t('inspector.proverka_avto_po_ssylke') : i18n.t('inspector.podbor_avto'));
  const urgency = exp.request.urgency ? URGENCY_LABEL[exp.request.urgency] ?? exp.request.urgency : null;

  const isExpired = useMemo(() => {
    try { return new Date(exp.expiresAt).getTime() <= Date.now(); }
    catch { return false; }
  }, [exp.expiresAt]);

  const expiresAt = useMemo(() => {
    try {
      const date = new Date(exp.expiresAt);
      const mins = Math.max(0, Math.round((date.getTime() - Date.now()) / 60000));
      if (mins <= 0) return i18n.t('inspector.isteklo');
      if (mins < 60) return i18n.t('inspector.istekaet_cherez_mins_min');
      return i18n.t('inspector.istekaet_cherez_math_round_mins_60_ch');
    } catch {
      return '';
    }
  }, [exp.expiresAt]);

  const acceptDisabled = acting || !canAccept || isExpired;

  return (
    <View testID={`exposure-card-${exp.id}`} style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.cardTop}>
        <View style={[styles.typePill, { backgroundColor: isInspection ? '#F59E0B20' : '#8B5CF620' }]}>
          <Ionicons name={isInspection ? 'shield-checkmark' : 'search'} size={12} color={isInspection ? '#F59E0B' : '#8B5CF6'} />
          <Text style={[styles.typeText, { color: isInspection ? '#F59E0B' : '#8B5CF6' }]}>
            {isInspection ? t('inspector.proverka') : t('inspector.podbor')}
          </Text>
        </View>
        <Text style={[styles.priceLabel, { color: colors.text }]}>€{exp.priceEstimate}</Text>
      </View>

      <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={2}>
        {title}
      </Text>

      <View style={styles.metaRow}>
        <MetaChip colors={colors} icon="location-outline" text={[exp.request.country, exp.city].filter(Boolean).join(' · ')} />
        {urgency && <MetaChip colors={colors} icon="time-outline" text={urgency} />}
        {exp.request.budget ? (
          <MetaChip colors={colors} icon="cash-outline" text={t('inspector.do_exp_request_budget_tolocalestring_de_de')} />
        ) : null}
      </View>

      {exp.request.links && exp.request.links.length > 0 && (
        <Text style={[styles.linkPreview, { color: colors.textSecondary }]} numberOfLines={1}>
          🔗 {exp.request.links[0].replace(/^https?:\/\//, '')}
        </Text>
      )}

      {exp.request.comment ? (
        <Text style={[styles.commentPreview, { color: colors.textSecondary }]} numberOfLines={2}>
          {exp.request.comment}
        </Text>
      ) : null}

      <View style={styles.footer}>
        <Text style={[styles.footerMeta, { color: colors.textSecondary }]}>{expiresAt}</Text>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity
          testID={`exposure-skip-${exp.id}`}
          activeOpacity={0.8}
          style={[styles.skipBtn, { borderColor: colors.border }]}
          onPress={() => onReject(exp)}
          disabled={acting}
        >
          <Text style={[styles.skipText, { color: colors.textSecondary }]}>{t('inspector.propustit')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`exposure-accept-${exp.id}`}
          activeOpacity={0.85}
          style={[
            styles.acceptBtn,
            { backgroundColor: acceptDisabled ? '#4B5563' : colors.primary, opacity: isExpired ? 0.55 : 1 },
          ]}
          onPress={() => onAccept(exp)}
          disabled={acceptDisabled}
        >
          {acting ? <ActivityIndicator color="#FFF" /> : <Text style={styles.acceptText}>{isExpired ? t('inspector.isteklo') : (canAccept ? t('inspector.vzyat') : t('inspector.limit_5_5'))}</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function MetaChip({ colors, icon, text }: any) {
  return (
    <View style={styles.metaChip}>
      <Ionicons name={icon} size={12} color={colors.textSecondary} />
      <Text style={[styles.metaText, { color: colors.textSecondary }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  title: { fontSize: 18, fontWeight: '800' },
  subRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginBottom: 8, gap: 12 },
  subTitle: { fontSize: 13 },
  activeBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  activeBadgeText: { fontSize: 11, fontWeight: '700' },
  scroll: { padding: 14, paddingBottom: 40 },
  empty: { borderRadius: 16, padding: 28, alignItems: 'center', borderWidth: 1, marginTop: 40 },
  emptyTitle: { fontSize: 16, fontWeight: '700', marginTop: 10 },
  emptySub: { fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  card: { borderRadius: 16, borderWidth: 1, padding: 14, marginBottom: 12 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  typePill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
  typeText: { fontSize: 11, fontWeight: '700' },
  priceLabel: { fontSize: 16, fontWeight: '800' },
  cardTitle: { fontSize: 17, fontWeight: '800', lineHeight: 22 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(120,120,120,0.10)' },
  metaText: { fontSize: 12, fontWeight: '500' },
  linkPreview: { fontSize: 12, marginTop: 8 },
  commentPreview: { fontSize: 12, fontStyle: 'italic', marginTop: 6, lineHeight: 17 },
  footer: { marginTop: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(120,120,120,0.25)' },
  footerMeta: { fontSize: 11 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  skipBtn: { flex: 1, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  skipText: { fontSize: 14, fontWeight: '600' },
  acceptBtn: { flex: 2, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  acceptText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
});

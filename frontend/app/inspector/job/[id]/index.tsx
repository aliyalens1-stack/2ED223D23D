/**
 * P0 — Inspector Job Detail (full execution flow).
 * Lifecycle: open → claimed → on_route → arrived → inspecting → done
 *
 * Includes:
 *   • Action buttons (state-machine)
 *   • Timeline visualization
 *   • Media upload section with categories (photo/video)
 *   • Path to checklist + report submission
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert, Image,
} from 'react-native';
import i18n from '../../../../src/i18n';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import Constants from 'expo-constants';
import {
  loadPending, queueAndUpload, retryOne, dropOne, pendingCount, failedCount,
} from '../../../../src/inspector/media/uploader';
import type { PendingItem, Severity } from '../../../../src/inspector/media/uploader';
import { SyncStatusBar, useQueueController } from '../../../../src/inspector/runtime/SyncStatusBar';
import PricingBreakdown, { type PricingProjection } from '../../../../src/components/PricingBreakdown';
import { getInspectorJobPricing } from '../../../../src/services/pricingProjection';

const API = (Constants.expoConfig as any)?.extra?.apiUrl
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || 'http://localhost:8001';

interface Job {
  id: string; requestId: string; city: string; status: string;
  brand: string; model: string; budget: number;
  inspectorId?: string | null;
  reportId?: string | null;
  claimedAt?: string | null;
  onRouteAt?: string | null;
  arrivedAt?: string | null;
  inspectionStartedAt?: string | null;
  completedAt?: string | null;
}

interface JobMediaStats {
  total: number;
  photos: number;
  videos: number;
  byCategory: Record<string, number>;
}

const TIMELINE: { key: string; label: string; tsField: keyof Job }[] = [
  { key: 'claimed', label: i18n.t('inspector.prinyato'), tsField: 'claimedAt' },
  { key: 'on_route', label: i18n.t('inspector.v_puti'), tsField: 'onRouteAt' },
  { key: 'arrived', label: i18n.t('inspector.na_meste'), tsField: 'arrivedAt' },
  { key: 'inspecting', label: i18n.t('inspector.proverka_idet'), tsField: 'inspectionStartedAt' },
  { key: 'report_ready', label: i18n.t('inspector.otchet_otpravlen'), tsField: 'completedAt' },
  { key: 'done', label: i18n.t('inspector.prinyat_klientom'), tsField: 'completedAt' },
];

// Media categories (must match backend CATEGORIES set)
const MEDIA_CATEGORIES: { key: string; label: string; icon: any }[] = [
  { key: 'exterior',   label: i18n.t('inspector.kuzov'),    icon: 'car-sport-outline' },
  { key: 'interior',   label: i18n.t('inspector.salon'),    icon: 'cube-outline' },
  { key: 'engine',     label: i18n.t('inspector.dvigatel'), icon: 'cog-outline' },
  { key: 'documents',  label: i18n.t('inspector.dokumenty'), icon: 'document-text-outline' },
  { key: 'damage',     label: i18n.t('inspector.povrezhdeniya'), icon: 'warning-outline' },
  { key: 'odometer',   label: i18n.t('inspector.probeg'),    icon: 'speedometer-outline' },
  { key: 'vin',        label: 'VIN',       icon: 'finger-print-outline' },
  { key: 'test_drive', label: i18n.t('inspector.test_drajv'), icon: 'navigate-outline' },
  { key: 'other',      label: i18n.t('inspector.drugoe'),    icon: 'ellipsis-horizontal' },
];

export default function InspectorJobDetail() {
  const { t } = useTranslation();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [token, setToken] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [mediaStats, setMediaStats] = useState<JobMediaStats>({ total: 0, photos: 0, videos: 0, byCategory: {} });
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [uploadingCat, setUploadingCat] = useState<string | null>(null);
  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);

  const refreshPending = useCallback(async () => {
    if (!id) return;
    const list = await loadPending(String(id));
    setPendingItems(list);
  }, [id]);

  // Step 5 — Offline queue. Stays mounted across the screen; the bar
  // sits below the header so it's always visible during a job session.
  const queueCtl = useQueueController({
    apiBase: API,
    getToken: async () => AsyncStorage.getItem('auth_token'),
  });

  const load = useCallback(async (t: string | null) => {
    if (!t || !id) return;
    try {
      const [jobRes, mediaRes] = await Promise.allSettled([
        fetch(`${API}/api/inspector/jobs/${id}`, { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json()),
        fetch(`${API}/api/inspector/jobs/${id}/media`, { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json()),
      ]);
      if (jobRes.status === 'fulfilled' && jobRes.value?.job) setJob(jobRes.value.job);
      if (mediaRes.status === 'fulfilled' && mediaRes.value?.stats) setMediaStats(mediaRes.value.stats);
      // Pricing projection — best-effort. Many legacy jobs have none yet;
      // we silently hide the section in that case.
      try {
        const p = await getInspectorJobPricing(String(id));
        setPricing(p);
      } catch {
        setPricing(null);
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'failed to load');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      const t = await AsyncStorage.getItem('auth_token');
      setToken(t);
      if (!t) {
        Alert.alert('Sign in required', '', [{ text: 'OK', onPress: () => router.replace('/login?role=provider') }]);
        return;
      }
      await Promise.all([load(t), refreshPending()]);
    })();
  }, [load, refreshPending, router]);

  const action = async (path: string, confirmMsg?: string) => {
    if (!job || !token) return;
    if (confirmMsg) {
      const go = await new Promise<boolean>((resolve) => {
        Alert.alert(i18n.t('inspector.podtverzhdenie'), confirmMsg, [
          { text: i18n.t('inspector.otmena'), onPress: () => resolve(false) },
          { text: i18n.t('inspector.da'), onPress: () => resolve(true), style: 'destructive' },
        ]);
      });
      if (!go) return;
    }
    setActing(true);
    try {
      const res = await fetch(`${API}/api/inspector/jobs/${job.id}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: path === 'cancel' ? JSON.stringify({ reason: 'inspector cancel' }) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      if (path === 'cancel') {
        Alert.alert(i18n.t('inspector.otmeneno'), i18n.t('inspector.zadanie_vozvrascheno_v_obschij_pul'), [
          { text: 'OK', onPress: () => router.replace('/inspector/jobs') },
        ]);
      } else {
        setJob(data.job || job);
      }
    } catch (e: any) {
      Alert.alert(i18n.t('chat.oshibka'), e?.message || i18n.t('inspector.ne_udalos'));
    } finally {
      setActing(false);
    }
  };

  const uploadMedia = async (category: string, mediaType: 'photo' | 'video') => {
    if (!job || !token) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(i18n.t('inspector.dostup_zapreschen'), i18n.t('inspector.nuzhen_dostup_k_galeree'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: mediaType === 'photo' ? ImagePicker.MediaTypeOptions.Images : ImagePicker.MediaTypeOptions.Videos,
      base64: false,
      quality: 1.0,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    setUploadingCat(category);
    try {
      const mimeType =
        (asset.mimeType || '').toLowerCase() ||
        (mediaType === 'photo'
          ? (asset.uri.endsWith('.png') ? 'image/png' : 'image/jpeg')
          : 'video/mp4');

      // sectionKey/itemKey: for category-based uploads we use category itself
      // as the section, with a synthetic itemKey of "untitled_<n>" so the
      // server-side stats still bucket them per item.
      const sectionKey = category;
      const itemKey = `${category}_${Date.now().toString().slice(-6)}`;
      const severity: Severity = category === 'damage' ? 'warning' : 'info';

      await queueAndUpload(
        { apiBase: API, token },
        job.id,
        {
          uri: asset.uri,
          mimeType,
          type: mediaType,
          sectionKey,
          itemKey,
          severity,
          category,
          width: asset.width,
          height: asset.height,
        },
      );
      // Refresh both server stats and local pending list
      await Promise.all([load(token), refreshPending()]);
    } catch (e: any) {
      Alert.alert(i18n.t('chat.oshibka_zagruzki'), e?.message || i18n.t('inspector.ne_udalos_zagruzit'));
      await refreshPending();
    } finally {
      setUploadingCat(null);
    }
  };

  const onRetry = async (itemId: string) => {
    if (!job || !token) return;
    await retryOne({ apiBase: API, token }, job.id, itemId);
    await Promise.all([load(token), refreshPending()]);
  };

  const onDrop = async (itemId: string) => {
    if (!job) return;
    await dropOne(job.id, itemId);
    await refreshPending();
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={{ marginTop: 100 }} color="#FFB020" />
      </SafeAreaView>
    );
  }

  if (!job) {
    return (
      <SafeAreaView style={styles.safe}>
        <Text style={styles.errorText}>{t('inspector.zadanie_ne_najdeno')}</Text>
      </SafeAreaView>
    );
  }

  const status = job.status;
  const canUploadMedia = ['claimed', 'on_route', 'arrived', 'inspecting'].includes(status);

  return (
    <SafeAreaView style={styles.safe} testID="inspector-job-detail">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace('/inspector/jobs')} testID="job-detail-back">
          <Ionicons name="chevron-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('inspector.zadanie')}</Text>
        <View style={{ width: 24 }} />
      </View>

      {/* Step 5 — persistent offline sync surface */}
      <SyncStatusBar controller={queueCtl} />

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.kicker}>{t('inspector.inspekciya')}</Text>
        <Text style={styles.title}>{job.brand} {job.model}</Text>

        <View style={styles.specRow}>
          <View style={styles.specItem}>
            <Ionicons name="location-outline" size={14} color="#A1A1AA" />
            <Text style={styles.specText}>{job.city}</Text>
          </View>
          <View style={styles.specItem}>
            <Ionicons name="cash-outline" size={14} color="#A1A1AA" />
            <Text style={styles.specText}>до {Number(job.budget).toLocaleString('de-DE')} €</Text>
          </View>
        </View>

        {/* Pricing projection — inspector's view of distance compensation.
            Hidden when the job has no projection yet (legacy jobs from
            before Pricing-2 sprint). */}
        {pricing ? (
          <View style={{ marginTop: 16 }}>
            <Text style={styles.sectionLabel}>{t('inspector.kompensaciya')}</Text>
            <PricingBreakdown projection={pricing} inspectorView />
          </View>
        ) : null}

        {/* Timeline */}
        <Text style={styles.sectionLabel}>{t('inspector.hod_raboty')}</Text>
        <View style={styles.timelineBox}>
          {TIMELINE.map((step, idx) => {
            const ts = (job as any)[step.tsField];
            const isDone = !!ts || (step.key === 'claimed' && status !== 'open');
            const isCurrent = status === step.key && !ts;
            const dotColor = isDone ? '#22C55E' : isCurrent ? '#FFB020' : '#2E2E2E';
            return (
              <View key={step.key} style={styles.timelineRow}>
                <View style={styles.timelineCol}>
                  <View style={[styles.timelineDot, { backgroundColor: dotColor }]} />
                  {idx < TIMELINE.length - 1 && <View style={styles.timelineLine} />}
                </View>
                <View style={{ flex: 1, paddingBottom: 14 }}>
                  <Text style={[styles.stepLabel, !isDone && !isCurrent && styles.stepLabelInactive]}>
                    {step.label}
                  </Text>
                  {ts && <Text style={styles.stepTs}>{new Date(ts).toLocaleString('de-DE')}</Text>}
                </View>
              </View>
            );
          })}
        </View>

        {/* Action buttons */}
        <Text style={styles.sectionLabel}>{t('inspector.dejstvie')}</Text>
        <View style={styles.actionBox}>
          {status === 'claimed' && (
            <ActionBtn label={t('inspector.vyehal')} icon="navigate" onPress={() => action('on-route')} disabled={acting} testID="job-action-on-route" />
          )}
          {status === 'on_route' && (
            <ActionBtn label={t('inspector.na_meste_2')} icon="checkmark-circle" onPress={() => action('arrived')} disabled={acting} testID="job-action-arrived" />
          )}
          {status === 'arrived' && (
            <ActionBtn label={t('inspector.nachat_proverku')} icon="construct" onPress={() => action('start-inspection')} disabled={acting} testID="job-action-start-inspection" />
          )}
          {status === 'inspecting' && (
            <ActionBtn
              label={t('inspector.zapolnit_otchet')}

              icon="document-text"
              onPress={() => router.push({ pathname: '/inspector/inspection/[jobId]', params: { jobId: job.id } } as any)}
              disabled={acting}
              testID="job-action-fill-report"
            />
          )}
          {status === 'report_ready' && (
            <View style={styles.doneBox} testID="job-action-report-ready">
              <Ionicons name="paper-plane" size={28} color="#22C55E" />
              <Text style={styles.doneText}>{t('inspector.otchet_otpravlen')}</Text>
              <Text style={styles.doneSub}>{t('inspector.zhdem_proverki_klienta_i_oplaty')}</Text>
              {job.reportId && (
                <Text style={[styles.doneSub, { marginTop: 4 }]}>id: {job.reportId.substring(0, 12)}…</Text>
              )}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                <TouchableOpacity
                  style={[styles.linkBtn, { flex: 1 }]}
                  testID="job-view-report"
                  onPress={() => router.push({ pathname: '/inspector/job/[id]/report', params: { id: job.id } } as any)}
                >
                  <Ionicons name="document-text-outline" size={14} color="#FFB020" />
                  <Text style={styles.linkBtnText}>{t('inspector.otkryt_otchet')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.linkBtn, { flex: 1 }]}
                  testID="job-contact-customer"
                  onPress={() => router.push('/messages' as any)}
                >
                  <Ionicons name="chatbubble-outline" size={14} color="#FFB020" />
                  <Text style={styles.linkBtnText}>{t('inspector.svyaz_s_klientom')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          {status === 'done' && (
            <View style={styles.doneBox}>
              <Ionicons name="checkmark-done-circle" size={28} color="#22C55E" />
              <Text style={styles.doneText}>{t('inspector.prinyat_klientom')}</Text>
              <Text style={styles.doneSub}>{t('inspector.vyplata_na_storone_platezha')}</Text>
              {job.reportId && <Text style={[styles.doneSub, { marginTop: 4 }]}>id: {job.reportId.substring(0, 12)}…</Text>}
              <TouchableOpacity
                style={[styles.linkBtn, { marginTop: 14 }]}
                testID="job-view-earnings"
                onPress={() => router.push('/provider/earnings-clarity' as any)}
              >
                <Ionicons name="cash-outline" size={14} color="#FFB020" />
                <Text style={styles.linkBtnText}>{t('inspector.otkryt_vyplaty')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {(status === 'claimed' || status === 'on_route' || status === 'arrived' || status === 'inspecting') && (
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => action('cancel', t('inspector.otmenit_zadanie_ono_vernetsya_v_obschij_pul'))}
              disabled={acting}
              testID="job-action-cancel"
            >
              <Text style={styles.cancelText}>{t('inspector.otmenit_zadanie')}</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Media uploads (P0) — by category */}
        {canUploadMedia && (
          <>
            <Text style={styles.sectionLabel}>
              [ ФОТО / ВИДЕО · {mediaStats.total} файл(ов) ]
            </Text>
            <Text style={styles.mediaHint}>
              📸 {mediaStats.photos} фото · 🎥 {mediaStats.videos} видео — снимайте по категориям, потом всё это пойдёт в отчёт.
            </Text>

            {/* Pending / failed banner (Sprint 2 Step 3) */}
            {pendingItems.length > 0 && (pendingCount(pendingItems) > 0) && (
              <View style={styles.pendingBanner} testID="media-pending-banner">
                <Text style={styles.pendingBannerTitle}>
                  ⏳ Локально: {pendingCount(pendingItems)}{' '}
                  {failedCount(pendingItems) > 0 ? t('inspector.failedcount_pendingitems_ne_otpravleno') : ''}
                </Text>
                {pendingItems.filter(i => i.state !== 'uploaded').slice(0, 8).map((it) => (
                  <View key={it.id} style={styles.pendingRow}>
                    <Text style={styles.pendingRowText} numberOfLines={1}>
                      {it.state === 'uploading' ? '↑' : it.state === 'failed' ? '✕' : '•'}{' '}
                      {it.sectionKey}/{it.itemKey} · sev={it.severity}
                    </Text>
                    {it.state === 'failed' && (
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <TouchableOpacity
                          testID={`media-retry-${it.id}`}
                          style={styles.retryBtn}
                          onPress={() => onRetry(it.id)}
                        >
                          <Text style={styles.retryBtnText}>{t('inspector.povtorit')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          testID={`media-drop-${it.id}`}
                          style={[styles.retryBtn, { backgroundColor: 'transparent', borderColor: '#666' }]}
                          onPress={() => onDrop(it.id)}
                        >
                          <Text style={[styles.retryBtnText, { color: '#A1A1AA' }]}>{t('inspector.udalit')}</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                ))}
              </View>
            )}

            <View style={styles.mediaGrid}>
              {MEDIA_CATEGORIES.map((cat) => {
                const count = mediaStats.byCategory?.[cat.key] || 0;
                const isUploading = uploadingCat === cat.key;
                return (
                  <TouchableOpacity
                    key={cat.key}
                    testID={`media-cat-${cat.key}`}
                    style={[styles.mediaCell, count > 0 && styles.mediaCellHasItems]}
                    onPress={() => {
                      Alert.alert(cat.label, t('inspector.chto_dobavit'), [
                        { text: t('inspector.otmena'), style: 'cancel' },
                        { text: t('inspector.foto_2'), onPress: () => uploadMedia(cat.key, 'photo') },
                        { text: t('inspector.video'), onPress: () => uploadMedia(cat.key, 'video') },
                      ]);
                    }}
                    disabled={isUploading || acting}
                    activeOpacity={0.8}
                  >
                    {isUploading ? (
                      <ActivityIndicator color="#FFB020" />
                    ) : (
                      <>
                        <Ionicons name={cat.icon} size={22} color={count > 0 ? '#FFB020' : '#A1A1AA'} />
                        <Text style={[styles.mediaLabel, count > 0 && { color: '#FFB020' }]}>{cat.label}</Text>
                        <Text style={styles.mediaCount}>{count > 0 ? `× ${count}` : '+'}</Text>
                      </>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionBtn({ label, icon, onPress, disabled, testID }: any) {
  return (
    <TouchableOpacity
      style={[styles.primaryBtn, disabled && { opacity: 0.5 }]}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
    >
      <Ionicons name={icon} size={18} color="#000" />
      <Text style={styles.primaryBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderBottomWidth: 1, borderBottomColor: '#2E2E2E' },
  headerTitle: { fontSize: 17, fontWeight: '800', color: '#FFF', letterSpacing: 1, textTransform: 'uppercase' },
  body: { padding: 18, paddingBottom: 80 },
  kicker: { fontSize: 11, fontWeight: '800', color: '#FFB020', letterSpacing: 2 },
  title: { fontSize: 32, fontWeight: '900', color: '#FFF', marginTop: 6, letterSpacing: 0.5 },
  specRow: { flexDirection: 'row', gap: 16, marginTop: 12, marginBottom: 24 },
  specItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  specText: { fontSize: 13, color: '#A1A1AA', fontWeight: '600' },
  sectionLabel: { fontSize: 11, fontWeight: '700', color: '#FFB020', letterSpacing: 2, marginBottom: 12, marginTop: 18 },
  timelineBox: { borderWidth: 1, borderColor: '#2E2E2E', borderRadius: 12, padding: 16, backgroundColor: '#0d0d0d' },
  timelineRow: { flexDirection: 'row', gap: 12 },
  timelineCol: { width: 16, alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, marginTop: 4 },
  timelineLine: { width: 2, flex: 1, backgroundColor: '#2E2E2E', marginTop: 2 },
  stepLabel: { fontSize: 14, fontWeight: '700', color: '#FFF' },
  stepLabelInactive: { color: '#5A5A5A' },
  stepTs: { fontSize: 11, color: '#A1A1AA', marginTop: 2 },
  actionBox: { gap: 12 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#FFB020', paddingVertical: 16, borderRadius: 8 },
  primaryBtnText: { fontSize: 15, fontWeight: '900', color: '#000', letterSpacing: 0.5, textTransform: 'uppercase' },
  cancelBtn: { paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: '#2E2E2E', borderRadius: 8 },
  cancelText: { fontSize: 13, color: '#A1A1AA', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  doneBox: { alignItems: 'center', padding: 24, borderWidth: 1, borderColor: '#22C55E', borderRadius: 12, backgroundColor: '#0d0d0d' },
  doneText: { fontSize: 16, fontWeight: '900', color: '#22C55E', marginTop: 8, textTransform: 'uppercase', letterSpacing: 1 },
  doneSub: { fontSize: 11, color: '#A1A1AA', marginTop: 4 },
  linkBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, paddingHorizontal: 12,
    borderWidth: 1, borderColor: '#FFB020', borderRadius: 8,
  },
  linkBtnText: { fontSize: 12, fontWeight: '700', color: '#FFB020' },
  errorText: { marginTop: 60, textAlign: 'center', color: '#EF4444', fontWeight: '700' },
  // Media
  mediaHint: { fontSize: 12, color: '#A1A1AA', marginBottom: 12, lineHeight: 17 },
  mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mediaCell: {
    width: '31%', aspectRatio: 1.05, borderWidth: 1, borderColor: '#2E2E2E', borderRadius: 12,
    backgroundColor: '#0d0d0d', alignItems: 'center', justifyContent: 'center', padding: 8, gap: 4,
  },
  mediaCellHasItems: { borderColor: '#FFB020', backgroundColor: '#1a1408' },
  mediaLabel: { fontSize: 11, fontWeight: '700', color: '#A1A1AA', textAlign: 'center' },
  mediaCount: { fontSize: 10, fontWeight: '900', color: '#FFB020' },
  pendingBanner: {
    marginHorizontal: 16, marginTop: 6, marginBottom: 4,
    padding: 12, borderRadius: 8,
    backgroundColor: '#1A1A1F', borderWidth: 1, borderColor: '#3F3F46',
  },
  pendingBannerTitle: {
    fontSize: 12, fontWeight: '700', color: '#FFB020', marginBottom: 6,
  },
  pendingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 4,
  },
  pendingRowText: { fontSize: 11, color: '#D1D5DB', flex: 1, marginRight: 8 },
  retryBtn: {
    paddingHorizontal: 10, paddingVertical: 4,
    backgroundColor: '#FFB020', borderRadius: 6,
    borderWidth: 1, borderColor: '#FFB020',
  },
  retryBtnText: { fontSize: 10, fontWeight: '800', color: '#000' },
});

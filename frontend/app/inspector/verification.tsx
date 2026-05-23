/**
 * Sprint 3 Step 1 — Inspector Verification screen.
 *
 * Closes the inspector side of the verification trust loop:
 *   • lists every required document with current status
 *   • shows admin rejection reason + note when status=rejected
 *   • t('inspector.zagruzit_zanovo') reuploads through the existing
 *     POST /api/inspector/verification/upload endpoint
 *   • after resubmit, status returns to pending_review
 *
 * Status vocabulary (matches backend Sprint 3 normalisation):
 *   missing | uploaded | pending_review | approved | rejected
 *   | needs_resubmission | expired
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator,
  Alert, RefreshControl,
} from 'react-native';
import i18n from '../../src/i18n';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
// Sprint A3a side-quest — Expo SDK 54 moved EncodingType to the legacy
// subpath. The new top-level `expo-file-system` no longer exports it
// directly. Only `readAsStringAsync` + EncodingType are needed here, so
// we scope the import narrowly rather than running an SDK migration sweep.
import * as FileSystem from 'expo-file-system/legacy';

import { useAuth } from '../../src/context/AuthContext';
import { api } from '../../src/services/api';

type DocStatus =
  | 'missing' | 'uploaded' | 'pending_review'
  | 'approved' | 'rejected' | 'needs_resubmission' | 'expired';

interface VerifDoc {
  id: string | null;
  kind: string;
  status: DocStatus;
  fileName?: string | null;
  mimeType?: string | null;
  note?: string | null;
  uploadedAt?: string | null;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
  rejectionNote?: string | null;
}

interface VerifResponse {
  documents: VerifDoc[];
  totalRequired: number;
  verifiedCount: number;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  overallStatus: 'verified' | 'partial' | 'incomplete';
}

const KIND_LABEL: Record<string, string> = {
  passport: i18n.t('inspector.pasport'),
  businessRegistration: i18n.t('inspector.registraciya_biznesa'),
  insurance: i18n.t('inspector.strahovka'),
  taxId: i18n.t('inspector.nalogovyj_nomer'),
  toolsProof: i18n.t('inspector.podtverzhdenie_instrumentov'),
  tuvCertificate: i18n.t('inspector.sertifikat_t_v'),
};

const REASON_LABEL: Record<string, string> = {
  document_blurry: i18n.t('inspector.foto_nechetkoe'),
  document_expired: i18n.t('inspector.dokument_prosrochen'),
  wrong_document_type: i18n.t('inspector.nevernyj_tip_dokumenta'),
  name_mismatch: i18n.t('inspector.imya_ne_sovpadaet'),
  incomplete_scan: i18n.t('inspector.nepolnoe_skanirovanie'),
  low_quality: i18n.t('inspector.nizkoe_kachestvo'),
  suspicious: i18n.t('inspector.podozritelnye_dannye'),
  other: i18n.t('inspector.drugoe'),
};

export default function InspectorVerificationScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const [data, setData] = useState<VerifResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingKind, setUploadingKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Role gate — verification is for providers / inspectors only.
  // Customers landing here (e.g. wrong link) should see a clear message,
  // not be silently redirected to /login (which used to land them on the
  // "Create account" page and look like an unwanted re-registration).
  const role = (user?.role || '').toString();
  const isProvider = role === 'provider' || role.startsWith('provider');

  const load = useCallback(async () => {
    if (authLoading) return;
    if (!isAuthenticated) {
      // Not signed in at all → show inline notice, don't auto-redirect.
      setLoading(false);
      setError('not_authenticated');
      return;
    }
    if (!isProvider) {
      setLoading(false);
      setError('not_provider');
      return;
    }
    try {
      const { data: json } = await api.get<VerifResponse>('/inspector/verification');
      setData(json);
      setError(null);
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || i18n.t('inspector.set');
      Alert.alert(i18n.t('inspector.ne_udalos_zagruzit'), msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authLoading, isAuthenticated, isProvider]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const handleUpload = async (kind: string) => {
    if (!isAuthenticated || !isProvider) return;
    // Permissions — silently degrade if not granted; user just won't see picker.
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(i18n.t('inspector.dostup_k_foto'),
        i18n.t('inspector.bez_dostupa_k_galeree_ne_poluchitsya_zagruzit_doku'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      base64: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    setUploadingKind(kind);
    try {
      // Read as base64 (existing endpoint stores base64 placeholder).
      // Step 5 of Sprint 5 / Sprint 4 will migrate to GridFS.
      const b64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const fileName = asset.fileName || `${kind}_${Date.now()}.jpg`;
      const mimeType = asset.mimeType || 'image/jpeg';

      await api.post('/inspector/verification/upload', {
        kind, fileName, mimeType, dataBase64: b64,
      });
      Alert.alert(
        i18n.t('inspector.dokument_otpravlen'),
        i18n.t('inspector.admin_rassmotrit_dokument_vy_uvidite_status_i_pric'),
      );
      await load();
    } catch (e: any) {
      const msg = e?.response?.data?.message || e?.message || i18n.t('inspector.oshibka_otpravki');
      Alert.alert(i18n.t('inspector.ne_udalos_zagruzit'), msg);
    } finally {
      setUploadingKind(null);
    }
  };

  // Robust back: prefer in-stack back; fall back to provider home so the
  // user never gets stuck on a deep-linked verification page.
  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)' as any);
  }, [router]);

  if (loading || authLoading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <ActivityIndicator color="#FFB020" />
        </View>
      </SafeAreaView>
    );
  }

  // Inline guard states — never silent-redirect from a deep link.
  if (error === 'not_authenticated' || error === 'not_provider') {
    const isAuthErr = error === 'not_authenticated';
    return (
      <SafeAreaView style={styles.safe} edges={['top']} testID="inspector-verification-guard">
        <View style={styles.header}>
          <TouchableOpacity onPress={handleBack} testID="verification-back" hitSlop={12}>
            <Ionicons name="chevron-back" size={24} color="#FFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('inspector.verifikaciya')}</Text>
          <View style={{ width: 24 }} />
        </View>
        <View style={[styles.center, { paddingHorizontal: 24 }]}>
          <Ionicons name={isAuthErr ? 'lock-closed-outline' : 'shield-outline'} size={42} color="#FFB020" />
          <Text style={[styles.summaryHeadline, { textAlign: 'center', marginTop: 16 }]}>
            {isAuthErr ? t('inspector.nuzhno_vojti_v_akkaunt') : t('inspector.verifikaciya_tolko_dlya_inspektorov')}
          </Text>
          <Text style={[styles.reviewNoteText, { textAlign: 'center', marginTop: 8 }]}>
            {isAuthErr
              ? t('inspector.vojdite_chtoby_prodolzhit_verifikaciyu_dokumentov')
              : t('inspector.etot_razdel_dostupen_tolko_provajderam_i_inspektor')}
          </Text>
          {isAuthErr ? (
            <TouchableOpacity
              style={[styles.uploadBtn, { marginTop: 24, paddingHorizontal: 24 }]}
              onPress={() => router.push('/login' as any)}
              testID="verification-go-login"
            >
              <Text style={styles.uploadBtnText}>{t('inspector.vojti')}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.uploadBtn, { marginTop: 24, paddingHorizontal: 24 }]}
              onPress={() => router.replace('/(tabs)' as any)}
              testID="verification-go-home"
            >
              <Text style={styles.uploadBtnText}>{t('inspector.na_glavnuyu')}</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // Step 3 — restrained continuity headline. NO percentages, NO N-of-M
  // counters, NO deficit framing. Verification is trust continuity, not
  // a compliance score.
  const headline =
    data?.overallStatus === 'verified' ? i18n.t('inspector.verifikaciya_podtverzhdena')
    : data?.overallStatus === 'partial' ? i18n.t('inspector.dokumentaciya_prodolzhaet_formirovatsya')
    : i18n.t('inspector.dokumentaciya_formiruetsya');

  return (
    <SafeAreaView style={styles.safe} edges={['top']} testID="inspector-verification">
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} testID="verification-back" hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('inspector.verifikaciya')}</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FFB020" />}
      >
        <View style={styles.summary} testID="verification-summary">
          <Text style={styles.summaryLabel}>{t('inspector.status')}</Text>
          <Text style={styles.summaryHeadline}>{headline}</Text>
        </View>

        {data?.rejectedCount ? (
          <View style={styles.reviewNote} testID="verification-rejection-banner">
            <Text style={styles.reviewNoteText}>
              По части документов запрошен дополнительный обзор. Обновлённую документацию можно отправить.
            </Text>
          </View>
        ) : null}

        {data?.documents.map((doc) => (
          <DocCard
            key={doc.kind}
            doc={doc}
            busy={uploadingKind === doc.kind}
            onUpload={() => handleUpload(doc.kind)}
          />
        ))}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function DocCard({ doc, busy, onUpload }: {
  doc: VerifDoc; busy: boolean; onUpload: () => void;
}) {
  const tone = STATUS_TONE[doc.status] || STATUS_TONE.missing;
  const canUpload = doc.status === 'missing' || doc.status === 'rejected'
    || doc.status === 'needs_resubmission' || doc.status === 'expired';
  return (
    <View style={[styles.card, { borderColor: tone.border }]} testID={`verification-card-${doc.kind}`}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{KIND_LABEL[doc.kind] || doc.kind}</Text>
          {doc.uploadedAt ? (
            <Text style={styles.cardMeta}>
              Загружено {new Date(doc.uploadedAt).toLocaleDateString('ru-RU')}
            </Text>
          ) : null}
        </View>
        <View style={[styles.statusBadge, { backgroundColor: tone.bg, borderColor: tone.border }]}>
          <Text style={[styles.statusBadgeText, { color: tone.fg }]}>{tone.label}</Text>
        </View>
      </View>

      {doc.status === 'rejected' && (doc.rejectionReason || doc.rejectionNote) ? (
        <View style={styles.rejectBlock} testID={`verification-reject-${doc.kind}`}>
          <Text style={styles.rejectHeader}>{t('inspector.zametka_obzora')}</Text>
          {doc.rejectionReason ? (
            <Text style={styles.rejectReason}>
              {REASON_LABEL[doc.rejectionReason] || doc.rejectionReason}
            </Text>
          ) : null}
          {doc.rejectionNote ? (
            <Text style={styles.rejectNote}>{doc.rejectionNote}</Text>
          ) : null}
        </View>
      ) : null}

      {canUpload ? (
        <TouchableOpacity
          style={[styles.uploadBtn, busy && { opacity: 0.6 }]}
          onPress={onUpload}
          disabled={busy}
          testID={`verification-upload-${doc.kind}`}
        >
          {busy ? (
            <ActivityIndicator size="small" color="#000" />
          ) : (
            <>
              <Ionicons name="cloud-upload-outline" size={16} color="#000" />
              <Text style={styles.uploadBtnText}>
                {doc.status === 'missing' ? t('inspector.dobavit_dokument') : t('inspector.obnovit_dokument')}
              </Text>
            </>
          )}
        </TouchableOpacity>
      ) : null}

      {doc.status === 'pending_review' ? (
        <View style={styles.pendingHint}>
          <Text style={styles.pendingHintText}>{t('inspector.ozhidaet_proverki_2')}</Text>
        </View>
      ) : null}
    </View>
  );
}

// Step 3 — restrained continuity vocabulary for inspector verification.
// All status labels are continuity adjectives; no rejection / failure
// framing. Tones are restricted to neutral / amber / emerald — red
// (#7f1d1d / #2a1010 / #fecaca) is intentionally absent: punitive tone
// is forbidden in verification surfaces per Step 3 doctrine.
const STATUS_TONE: Record<DocStatus, { label: string; fg: string; bg: string; border: string }> = {
  missing:            { label: i18n.t('inspector.ozhidaet_dokumentacii'),  fg: '#A1A1AA', bg: '#1F1F22', border: '#3F3F46' },
  uploaded:           { label: i18n.t('inspector.otpravleno'),            fg: '#fde68a', bg: '#1F1908', border: '#a16207' },
  pending_review:     { label: i18n.t('inspector.ozhidaet_proverki'),      fg: '#fde68a', bg: '#1F1908', border: '#a16207' },
  approved:           { label: i18n.t('inspector.podtverzhdeno'),          fg: '#bbf7d0', bg: '#0a1a0c', border: '#14532d' },
  rejected:           { label: i18n.t('inspector.dop_obzor'),            fg: '#fde68a', bg: '#1F1908', border: '#a16207' },
  needs_resubmission: { label: i18n.t('inspector.dop_obzor'),            fg: '#fde68a', bg: '#1F1908', border: '#a16207' },
  expired:            { label: i18n.t('inspector.obnovlenie'),            fg: '#fde68a', bg: '#1F1908', border: '#a16207' },
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#1f1f22',
  },
  headerTitle: { color: '#FFF', fontSize: 13, fontWeight: '900', letterSpacing: 1.5 },
  content: { padding: 16 },

  summary: {
    padding: 16, borderRadius: 12, backgroundColor: '#141414',
    borderWidth: 1, borderColor: '#27272a', marginBottom: 16,
  },
  summaryLabel: { color: '#71717A', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  summaryHeadline: { color: '#FFF', fontSize: 16, fontWeight: '800', marginTop: 4 },

  // Step 3 — review note (replaces former alertCard). Neutral amber tone
  // only. No red, no alert icon, no urgency theatre. Reads as a quiet
  // continuity note, not a punitive banner.
  reviewNote: {
    padding: 12, marginBottom: 16,
    backgroundColor: '#141414', borderWidth: 1, borderColor: '#27272a', borderRadius: 10,
  },
  reviewNoteText: { color: '#D4D4D8', fontSize: 12, lineHeight: 18 },

  card: {
    backgroundColor: '#141414', padding: 14, borderRadius: 12,
    borderWidth: 1, marginBottom: 10,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { color: '#FFF', fontSize: 15, fontWeight: '800' },
  cardMeta: { color: '#71717A', fontSize: 11, marginTop: 2 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1 },
  statusBadgeText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },

  // Step 3 — review note block (formerly rejection block). Amber tone,
  // never red. Header reads t('inspector.zametka_obzora'), not t('inspector.prichina_otkaza').
  rejectBlock: {
    marginTop: 12, padding: 10, borderRadius: 8,
    backgroundColor: '#1F1908', borderWidth: 1, borderColor: '#a16207',
  },
  rejectHeader: { color: '#fde68a', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  rejectReason: { color: '#fde68a', fontSize: 13, fontWeight: '700', marginTop: 4 },
  rejectNote: { color: '#fde68a', fontSize: 12, marginTop: 4, lineHeight: 17 },

  uploadBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 11, marginTop: 12, borderRadius: 8, backgroundColor: '#FFB020',
  },
  uploadBtnText: { color: '#000', fontSize: 13, fontWeight: '900', letterSpacing: 0.5 },

  pendingHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 10, paddingHorizontal: 4,
  },
  pendingHintText: { color: '#fde68a', fontSize: 11, fontWeight: '700' },
});

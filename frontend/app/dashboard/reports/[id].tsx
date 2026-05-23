/**
 * Sprint 5 — Customer Report Detail (PRO version).
 * New layout (sells the report, not just shows data):
 *   1. Score + Verdict big CTA: "Should you buy this car?" → YES/RISKY/NO
 *   2. Photos gallery
 *   3. Issues (with severity)
 *   4. Checklist (color-coded)
 *   5. Repair estimate (€X – €Y)
 *   6. Summary (human-readable)
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Modal, Dimensions, FlatList } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import AuthedImage from '../../../src/components/AuthedImage';

const API = (Constants.expoConfig as any)?.extra?.apiUrl
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || 'http://localhost:8001';

interface ChecklistItem { key: string; status: string; comment: string | null; }
interface Issue { severity: string; title: string; description: string | null; }
interface Media { id: string; type: 'photo' | 'video'; mimeType: string; url: string; sizeBytes: number; }

interface Report {
  id: string; jobId: string; requestId: string; inspectorId: string;
  vehicleId?: string | null;
  city: string; brand: string; model: string;
  score: number; verdict: string; status: string;
  checklist: ChecklistItem[];
  issues: Issue[];
  summary: string;
  repairEstimateMin: number | null;
  repairEstimateMax: number | null;
  rejectReason: string | null;
  createdAt: string;
  approvedAt: string | null;
  customerAcceptedAt?: string | null;
  customerAcceptanceStatus?: string | null;
  media?: Media[];
}

const STATUS_COLORS: Record<string, string> = { ok: '#22C55E', warning: '#FFB020', problem: '#EF4444' };
const STATUS_LABELS: Record<string, string> = { ok: 'OK', warning: 'Note', problem: 'Issue' };
const VERDICT_INFO: Record<string, { color: string; label: string; cta: string; emoji: string }> = {
  recommended:    { color: '#22C55E', label: 'YES, BUY IT',  cta: 'Recommended for purchase',     emoji: '✓' },
  risky:          { color: '#FFB020', label: 'RISKY',        cta: 'Buy only after negotiation',  emoji: '!' },
  not_recommended:{ color: '#EF4444', label: "DON'T BUY",    cta: 'Walk away from this deal',    emoji: '✕' },
};
const SEVERITY_COLORS: Record<string, string> = { low: '#A1A1AA', medium: '#FFB020', high: '#EF4444' };

const { width: SCREEN_W } = Dimensions.get('window');

export default function CustomerReportDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const t = await AsyncStorage.getItem('auth_token');
      if (!t) { router.replace('/login'); return; }
      const res = await fetch(`${API}/api/customer/reports/${id}`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      setReport(data.report);
    } catch (e: any) {
      setError(e?.message || 'failed');
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => { load(); }, [load]);

  // Slice 1 — quality confirmation (non-financial).
  // The credit is already consumed at submit-time; this is the customer
  // saying "I got this, it counts" — it appends to vehicle history and
  // unlocks downstream signals (inspector quality, post-sale recs).
  const handleAccept = useCallback(async () => {
    if (!id || accepting) return;
    setAccepting(true);
    setAcceptError(null);
    try {
      const t = await AsyncStorage.getItem('auth_token');
      if (!t) { router.replace('/login'); return; }
      const res = await fetch(`${API}/api/customer/reports/${id}/accept`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      // Replace local state with the server's authoritative version so
      // the new acceptance fields render immediately (no re-fetch needed).
      if (data?.report) setReport(data.report);
    } catch (e: any) {
      setAcceptError(e?.message || 'failed');
    } finally {
      setAccepting(false);
    }
  }, [id, accepting, router]);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={{ marginTop: 100 }} color="#FFB020" />
      </SafeAreaView>
    );
  }
  if (error || !report) {
    return (
      <SafeAreaView style={styles.safe}>
        <Text style={styles.errorText}>{error || 'Report not found'}</Text>
      </SafeAreaView>
    );
  }

  const v = VERDICT_INFO[report.verdict] || VERDICT_INFO.risky;
  const photos = (report.media || []).filter((m) => m.type === 'photo');
  const videos = (report.media || []).filter((m) => m.type === 'video');

  return (
    <SafeAreaView style={styles.safe} testID="customer-report-detail">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="report-detail-back">
          <Ionicons name="chevron-back" size={24} color="#FFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Inspection report</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.kicker}>/ {report.city.toUpperCase()} · {new Date(report.createdAt).toLocaleDateString('de-DE')} /</Text>
        <Text style={styles.title}>{report.brand} {report.model}</Text>

        {/* ════════ 1. HERO — Should you buy this car? ════════ */}
        <View style={[styles.heroBox, { borderColor: v.color }]}>
          <Text style={styles.heroQuestion}>Should you buy this car?</Text>
          <View style={styles.heroVerdictRow}>
            <Text style={[styles.heroVerdictEmoji, { color: v.color }]}>{v.emoji}</Text>
            <Text style={[styles.heroVerdictLabel, { color: v.color }]}>{v.label}</Text>
          </View>
          <Text style={styles.heroCta}>{v.cta}</Text>
          <View style={styles.scoreBar}>
            <View style={[styles.scoreFill, { width: `${(report.score / 10) * 100}%`, backgroundColor: v.color }]} />
            <Text style={styles.scoreLabel}>SCORE  {report.score.toFixed(1)} / 10</Text>
          </View>
          {report.status === 'approved' && (
            <Text style={styles.approvedTag}>✓ Verified by Auto Search admin</Text>
          )}
          {report.status === 'rejected' && (
            <Text style={styles.rejectedTag}>✗ Rejected: {report.rejectReason}</Text>
          )}
        </View>

        {/* ════════ ACCEPTANCE — quality confirmation, non-financial ════════
            Closes the ontology loop: report → vehicle memory.
            Appears only on `approved` reports. Idempotent on backend. */}
        {report.status === 'approved' && (
          report.customerAcceptedAt ? (
            <View style={styles.acceptedBox} testID="report-accepted-tag">
              <Ionicons name="checkmark-circle" size={18} color="#22C55E" />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.acceptedTitle}>Сохранено в истории машины</Text>
                <Text style={styles.acceptedHint}>
                  {new Date(report.customerAcceptedAt).toLocaleDateString('de-DE')} ·
                  отчёт стал частью persistent memory автомобиля
                </Text>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.acceptCta, accepting && { opacity: 0.5 }]}
              onPress={handleAccept}
              disabled={accepting}
              testID="report-accept-cta"
              activeOpacity={0.8}
            >
              {accepting ? (
                <ActivityIndicator color="#000" />
              ) : (
                <>
                  <Ionicons name="checkmark-done" size={18} color="#000" />
                  <Text style={styles.acceptCtaText}>Подтвердить получение</Text>
                </>
              )}
            </TouchableOpacity>
          )
        )}
        {acceptError && (
          <Text style={styles.acceptError} testID="report-accept-error">{acceptError}</Text>
        )}

        {/* ════════ 2. PHOTOS GALLERY ════════ */}
        {photos.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>[ PHOTOS · {photos.length} ]</Text>
            <FlatList
              data={photos}
              horizontal
              showsHorizontalScrollIndicator={false}
              keyExtractor={(it) => it.id}
              contentContainerStyle={{ gap: 8 }}
              renderItem={({ item, index }) => (
                <TouchableOpacity
                  onPress={() => setLightboxIndex(index)}
                  testID={`photo-thumb-${item.id}`}
                  activeOpacity={0.7}
                >
                  <AuthedImage mediaUrl={item.url} style={styles.photoThumb} />
                </TouchableOpacity>
              )}
            />
          </>
        )}
        {videos.length > 0 && (
          <View style={styles.videoBadge}>
            <Ionicons name="videocam" size={14} color="#FFB020" />
            <Text style={styles.videoBadgeText}>{videos.length} video{videos.length > 1 ? 's' : ''} attached</Text>
          </View>
        )}
        {photos.length === 0 && videos.length === 0 && (
          <View style={styles.noPhotosBox}>
            <Ionicons name="camera-outline" size={20} color="#5A5A5A" />
            <Text style={styles.noPhotosText}>No photos attached to this report</Text>
          </View>
        )}

        {/* ════════ 3. ISSUES ════════ */}
        {report.issues.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>[ ISSUES FOUND · {report.issues.length} ]</Text>
            <View style={styles.issuesBox}>
              {report.issues.map((iss, i) => {
                const sevColor = SEVERITY_COLORS[iss.severity] || '#FFB020';
                return (
                  <View key={i} style={styles.issueRow}>
                    <View style={[styles.severityBadge, { backgroundColor: sevColor }]}>
                      <Text style={styles.severityBadgeText}>{iss.severity.toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={styles.issueTitle}>{iss.title}</Text>
                      {iss.description && <Text style={styles.issueDesc}>{iss.description}</Text>}
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        )}

        {/* ════════ 4. CHECKLIST ════════ */}
        <Text style={styles.sectionLabel}>[ CHECKLIST · {report.checklist.length} POINTS ]</Text>
        <View style={styles.checkBox}>
          {report.checklist.map((it) => {
            const color = STATUS_COLORS[it.status] || '#A1A1AA';
            return (
              <View key={it.key} style={styles.checkRow}>
                <View style={[styles.checkDot, { backgroundColor: color }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.checkKey}>{it.key.replace(/_/g, ' ')}</Text>
                  {it.comment && <Text style={styles.checkComment}>{it.comment}</Text>}
                </View>
                <Text style={[styles.checkStatus, { color }]}>{STATUS_LABELS[it.status] || it.status}</Text>
              </View>
            );
          })}
        </View>

        {/* ════════ 5. REPAIR ESTIMATE ════════ */}
        {(report.repairEstimateMin !== null || report.repairEstimateMax !== null) && (
          <>
            <Text style={styles.sectionLabel}>[ REPAIR ESTIMATE ]</Text>
            <View style={styles.estimateBox}>
              <Text style={styles.estimateText}>
                € {report.repairEstimateMin?.toLocaleString('de-DE') || '—'}  —  € {report.repairEstimateMax?.toLocaleString('de-DE') || '—'}
              </Text>
              <Text style={styles.estimateHint}>Use this when negotiating the price.</Text>
            </View>
          </>
        )}

        {/* ════════ 6. SUMMARY ════════ */}
        <Text style={styles.sectionLabel}>[ INSPECTOR SUMMARY ]</Text>
        <View style={styles.summaryBox}>
          <Text style={styles.summaryText}>{report.summary}</Text>
        </View>
      </ScrollView>

      {/* Lightbox modal */}
      <Modal visible={lightboxIndex !== null} transparent={true} onRequestClose={() => setLightboxIndex(null)}>
        <View style={styles.lightboxBg}>
          <TouchableOpacity style={styles.lightboxClose} onPress={() => setLightboxIndex(null)} testID="lightbox-close">
            <Ionicons name="close" size={28} color="#FFF" />
          </TouchableOpacity>
          {lightboxIndex !== null && photos[lightboxIndex] && (
            <>
              <AuthedImage
                mediaUrl={photos[lightboxIndex].url}
                style={styles.lightboxImage}
              />
              <Text style={styles.lightboxCounter}>{lightboxIndex + 1} / {photos.length}</Text>
              {lightboxIndex > 0 && (
                <TouchableOpacity style={styles.lightboxLeft} onPress={() => setLightboxIndex(lightboxIndex - 1)}>
                  <Ionicons name="chevron-back" size={36} color="#FFF" />
                </TouchableOpacity>
              )}
              {lightboxIndex < photos.length - 1 && (
                <TouchableOpacity style={styles.lightboxRight} onPress={() => setLightboxIndex(lightboxIndex + 1)}>
                  <Ionicons name="chevron-forward" size={36} color="#FFF" />
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderBottomWidth: 1, borderBottomColor: '#2E2E2E' },
  headerTitle: { fontSize: 17, fontWeight: '800', color: '#FFF', letterSpacing: 1, textTransform: 'uppercase' },
  body: { padding: 18, paddingBottom: 60 },
  kicker: { fontSize: 11, fontWeight: '800', color: '#FFB020', letterSpacing: 2 },
  title: { fontSize: 32, fontWeight: '900', color: '#FFF', marginTop: 6, marginBottom: 24 },

  // HERO
  heroBox: { borderWidth: 2, padding: 24, borderTopLeftRadius: 12, borderTopRightRadius: 12, backgroundColor: '#0d0d0d', alignItems: 'center', marginBottom: 24 },
  heroQuestion: { fontSize: 13, color: '#A1A1AA', fontWeight: '600', letterSpacing: 0.5, textAlign: 'center', marginBottom: 16 },
  heroVerdictRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  heroVerdictEmoji: { fontSize: 36, fontWeight: '900' },
  heroVerdictLabel: { fontSize: 28, fontWeight: '900', letterSpacing: 1.5 },
  heroCta: { fontSize: 13, color: '#FFF', fontWeight: '600', textAlign: 'center', marginBottom: 20 },
  scoreBar: { width: '100%', height: 28, borderRadius: 14, backgroundColor: '#1a1a1a', overflow: 'hidden', position: 'relative', justifyContent: 'center' },
  scoreFill: { position: 'absolute', left: 0, top: 0, bottom: 0, opacity: 0.3 },
  scoreLabel: { textAlign: 'center', fontSize: 11, fontWeight: '900', color: '#FFF', letterSpacing: 1.5 },
  approvedTag: { fontSize: 11, color: '#22C55E', fontWeight: '700', marginTop: 16, letterSpacing: 0.5 },
  rejectedTag: { fontSize: 11, color: '#EF4444', fontWeight: '700', marginTop: 16 },

  // ACCEPTANCE — quality confirmation
  acceptCta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#FFB020',
    paddingVertical: 16, paddingHorizontal: 24,
    borderRadius: 12,
    marginBottom: 24,
  },
  acceptCtaText: { fontSize: 14, fontWeight: '900', color: '#000', letterSpacing: 1 },
  acceptedBox: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: 'rgba(34,197,94,0.10)',
    borderWidth: 1, borderColor: 'rgba(34,197,94,0.35)',
    paddingVertical: 14, paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 24,
  },
  acceptedTitle: { fontSize: 13, fontWeight: '800', color: '#22C55E', letterSpacing: 0.4 },
  acceptedHint: { fontSize: 11, color: '#A1A1AA', marginTop: 4, lineHeight: 16 },
  acceptError: { fontSize: 12, color: '#EF4444', marginTop: -16, marginBottom: 16, textAlign: 'center' },

  sectionLabel: { fontSize: 11, fontWeight: '700', color: '#FFB020', letterSpacing: 2, marginTop: 24, marginBottom: 12 },

  // PHOTOS
  photoThumb: { width: 140, height: 140, borderRadius: 8, borderWidth: 1, borderColor: '#2E2E2E' },
  videoBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, marginTop: 10, borderWidth: 1, borderColor: '#FFB020', borderRadius: 6, alignSelf: 'flex-start' },
  videoBadgeText: { fontSize: 11, color: '#FFB020', fontWeight: '700', letterSpacing: 0.5 },
  noPhotosBox: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 16, borderWidth: 1, borderColor: '#2E2E2E', borderTopLeftRadius: 12, borderTopRightRadius: 12, borderStyle: 'dashed', backgroundColor: '#0d0d0d' },
  noPhotosText: { fontSize: 12, color: '#5A5A5A', fontStyle: 'italic' },

  // ISSUES
  issuesBox: { borderWidth: 1, borderColor: '#2E2E2E', borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 14, backgroundColor: '#0d0d0d' },
  issueRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  severityBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  severityBadgeText: { fontSize: 9, fontWeight: '900', color: '#000', letterSpacing: 1 },
  issueTitle: { fontSize: 13, fontWeight: '700', color: '#FFF' },
  issueDesc: { fontSize: 12, color: '#A1A1AA', marginTop: 2 },

  // CHECKLIST
  checkBox: { borderWidth: 1, borderColor: '#2E2E2E', borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 14, backgroundColor: '#0d0d0d' },
  checkRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1a1a1a', gap: 10 },
  checkDot: { width: 10, height: 10, borderRadius: 5 },
  checkKey: { fontSize: 13, fontWeight: '600', color: '#FFF', textTransform: 'capitalize' },
  checkComment: { fontSize: 11, color: '#A1A1AA', marginTop: 2 },
  checkStatus: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },

  // ESTIMATE
  estimateBox: { borderWidth: 1, borderColor: '#FFB020', borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 16, backgroundColor: '#0d0d0d', alignItems: 'center' },
  estimateText: { fontSize: 22, fontWeight: '900', color: '#FFB020', letterSpacing: 0.5 },
  estimateHint: { fontSize: 11, color: '#A1A1AA', marginTop: 6, textAlign: 'center' },

  // SUMMARY
  summaryBox: { borderWidth: 1, borderColor: '#2E2E2E', borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 16, backgroundColor: '#0d0d0d' },
  summaryText: { fontSize: 14, color: '#FFF', lineHeight: 22 },

  // LIGHTBOX
  lightboxBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center' },
  lightboxImage: { width: SCREEN_W * 0.95, height: SCREEN_W * 0.95, resizeMode: 'contain' as any },
  lightboxClose: { position: 'absolute', top: 60, right: 20, padding: 10, zIndex: 2 },
  lightboxCounter: { position: 'absolute', bottom: 60, color: '#FFF', fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  lightboxLeft: { position: 'absolute', left: 10, top: '50%', padding: 10 },
  lightboxRight: { position: 'absolute', right: 10, top: '50%', padding: 10 },

  errorText: { marginTop: 60, textAlign: 'center', color: '#EF4444', fontWeight: '700' },
});

/**
 * Inspector · Draft Preview (Sprint 2 Step 4).
 *
 * Generates an AI-assisted draft for the current job, shows verdict / score /
 * confidence, contradictions, missing evidence, and an editable summary.
 *
 * Tone is intentionally assistive — never authoritative.
 *   t('inspector.chernovik_sformirovan') / t('inspector.trebuetsya_podtverzhdenie_inspektora').
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator,
  TextInput, Alert,
} from 'react-native';
import i18n from '../../../../src/i18n';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import NetInfo from '@react-native-community/netinfo';
import { enqueue } from '../../../../src/inspector/runtime/queue';
import { SyncStatusBar, useQueueController } from '../../../../src/inspector/runtime/SyncStatusBar';

const API = (process.env.EXPO_PUBLIC_BACKEND_URL || (Constants.expoConfig?.extra as any)?.backendUrl || 'http://localhost:8001');

type Verdict = 'recommended' | 'risky' | 'not_recommended';
type Confidence = 'low' | 'medium' | 'high';

interface Draft {
  id: string;
  verdict: Verdict;
  score: number;
  confidence: Confidence;
  summary: string;
  topProblems: { itemKey: string; severity: string; note?: string }[];
  contradictions: { code: string; itemKey: string; message: string; severity: string }[];
  missingEvidence: { itemKey: string; reason: string; severity: string; message: string }[];
  recommendedActions: string[];
  reasoning?: string;
  ai: { ok: boolean; latencyMs: number; model: string; error?: string };
  generatedAt: string;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  recommended: i18n.t('inspector.rekomenduetsya'),
  risky: i18n.t('inspector.s_riskom'),
  not_recommended: i18n.t('inspector.ne_rekomenduetsya'),
};
const VERDICT_COLOR: Record<Verdict, string> = {
  recommended: '#10B981',
  risky: '#FFB020',
  not_recommended: '#EF4444',
};
const CONF_LABEL: Record<Confidence, string> = { low: i18n.t('inspector.nizkaya'), medium: i18n.t('inspector.srednyaya'), high: i18n.t('inspector.vysokaya') };

export default function DraftPreview() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [editedSummary, setEditedSummary] = useState('');
  const [editedVerdict, setEditedVerdict] = useState<Verdict | null>(null);

  // Step 5 — Offline queue + visible status bar on the draft screen.
  const queueCtl = useQueueController({
    apiBase: API,
    getToken: async () => AsyncStorage.getItem('auth_token'),
  });

  useEffect(() => {
    (async () => {
      const t = await AsyncStorage.getItem('auth_token');
      if (!t) {
        Alert.alert('Sign in required', '', [{ text: 'OK', onPress: () => router.replace('/login?role=provider') }]);
        return;
      }
      setToken(t);
    })();
  }, [router]);

  const generate = async () => {
    if (!token || !id) return;
    // Step 5 — offline-aware: if no network, queue the draft generation
    // request and tell the user it will run when connectivity returns.
    // We use NetInfo.fetch() (not the queueCtl.online which is event-based)
    // so the very first tap after losing service still does the right thing.
    let online = true;
    try {
      const st = await NetInfo.fetch();
      online = !!st.isConnected && (st.isInternetReachable !== false);
    } catch { /* assume online if NetInfo unavailable */ }

    if (!online) {
      // Same Idempotency-Key on every retry of the same (jobId) tap so a
      // replay storm never produces multiple drafts. Re-tapping after the
      // first request was queued just no-ops at the server.
      await enqueue({
        kind: 'draft_generate',
        jobId: String(id),
        idempotencyKey: `draft_${id}_${Date.now()}`,
        payload: { runtimeState: {}, media: [], vehicle: {} },
      });
      queueCtl.triggerReplay();
      Alert.alert(
        i18n.t('inspector.oflajn'),
        i18n.t('inspector.chernovik_budet_sformirovan_posle_podklyucheniya_p'),
      );
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API}/api/inspector/jobs/${id}/draft`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtimeState: {}, media: [], vehicle: {} }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      const d: Draft = data.draft;
      setDraft(d);
      setEditedSummary(d.summary || '');
      setEditedVerdict(d.verdict);
    } catch (e: any) {
      Alert.alert(i18n.t('inspector.ne_udalos_sformirovat_chernovik'), e?.message || i18n.t('inspector.poprobujte_esche_raz'));
    } finally {
      setLoading(false);
    }
  };

  const useDraft = async () => {
    if (!draft || !id) return;
    // Persist locally so the report screen can pre-fill.
    await AsyncStorage.setItem(
      `inspector:draft-staged:${id}`,
      JSON.stringify({
        draftId: draft.id,
        verdict: editedVerdict || draft.verdict,
        summary: editedSummary || draft.summary,
        score: draft.score,
        recommendedActions: draft.recommendedActions,
      }),
    );
    Alert.alert(
      i18n.t('inspector.chernovik_gotov'),
      i18n.t('inspector.perejdite_k_ekranu_otcheta_polya_budut_predzapolne'),
      [{ text: 'OK', onPress: () => router.push(`/inspector/job/${id}/report` as any) }],
    );
  };

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} testID="draft-back">
          <Text style={styles.headerBtn}>{t('inspector.nazad')}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('inspector.ai_chernovik')}</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Step 5 — persistent offline sync surface */}
      <SyncStatusBar controller={queueCtl} />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        {!draft && (
          <View style={styles.introCard}>
            <Text style={styles.introTitle}>{t('inspector.chernovik_sformiruetsya_po_vashej_proverke')}</Text>
            <Text style={styles.introText}>
              AI-ассистент проанализирует checklist, медиа и заметки, найдёт противоречия и
              предложит summary. Финальное решение — за вами.
            </Text>
            <TouchableOpacity
              testID="draft-generate-btn"
              style={[styles.primaryBtn, loading && { opacity: 0.5 }]}
              disabled={loading}
              onPress={generate}
            >
              {loading
                ? <ActivityIndicator color="#000" />
                : <Text style={styles.primaryBtnText}>{t('inspector.sformirovat_chernovik')}</Text>}
            </TouchableOpacity>
            <Text style={styles.introHint}>
              Анализ занимает 5-12 секунд. Если AI недоступен — будет показан детерминированный draft.
            </Text>
          </View>
        )}

        {draft && (
          <View testID="draft-result">
            {/* Verdict */}
            <View style={[styles.card, { borderLeftColor: VERDICT_COLOR[draft.verdict], borderLeftWidth: 4 }]}>
              <Text style={styles.cardTitle}>{t('inspector.predvaritelnyj_verdict')}</Text>
              <Text style={[styles.verdict, { color: VERDICT_COLOR[draft.verdict] }]}>
                {VERDICT_LABEL[draft.verdict]} · score {draft.score}
              </Text>
              <Text style={styles.metaRow}>
                Уверенность: {CONF_LABEL[draft.confidence]} · AI {draft.ai.ok ? 'ok' : 'fallback'} · {draft.ai.latencyMs} ms
              </Text>
              {draft.reasoning ? <Text style={styles.reasoning}>{draft.reasoning}</Text> : null}
              <Text style={styles.assistantNote}>{t('inspector.trebuetsya_podtverzhdenie_inspektora')}</Text>
            </View>

            {/* Contradictions */}
            {draft.contradictions.length > 0 && (
              <View style={[styles.card, { borderColor: '#FFB020' }]}>
                <Text style={[styles.cardTitle, { color: '#FFB020' }]}>
                  Найдены противоречия ({draft.contradictions.length})
                </Text>
                {draft.contradictions.map((c) => (
                  <View key={c.code + c.itemKey} style={styles.listRow}>
                    <Text style={styles.listRowKey}>{c.itemKey}</Text>
                    <Text style={styles.listRowMsg}>{c.message}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Missing evidence */}
            {draft.missingEvidence.length > 0 && (
              <View style={[styles.card, { borderColor: '#3B82F6' }]}>
                <Text style={[styles.cardTitle, { color: '#60A5FA' }]}>
                  Не хватает доказательств ({draft.missingEvidence.length})
                </Text>
                {draft.missingEvidence.map((m) => (
                  <View key={m.itemKey + m.reason} style={styles.listRow}>
                    <Text style={styles.listRowKey}>{m.itemKey}</Text>
                    <Text style={styles.listRowMsg}>{m.message}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Top problems */}
            {draft.topProblems.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('inspector.glavnye_punkty_vnimaniya')}</Text>
                {draft.topProblems.map((p, i) => (
                  <Text key={i} style={styles.problemLine}>
                    • {p.itemKey} ({p.severity}){p.note ? ` — ${p.note}` : ''}
                  </Text>
                ))}
              </View>
            )}

            {/* Editable summary */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t('inspector.summary_redaktiruetsya')}</Text>
              <TextInput
                testID="draft-summary-input"
                style={styles.summaryInput}
                multiline
                value={editedSummary}
                onChangeText={setEditedSummary}
                placeholderTextColor="#71717A"
              />
            </View>

            {/* Recommended actions */}
            {draft.recommendedActions.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{t('inspector.rekomenduemye_dejstviya_dlya_klienta')}</Text>
                {draft.recommendedActions.map((a, i) => (
                  <Text key={i} style={styles.problemLine}>• {a}</Text>
                ))}
              </View>
            )}

            {/* Actions */}
            <View style={styles.actions}>
              <TouchableOpacity
                testID="draft-regenerate-btn"
                style={[styles.secondaryBtn, loading && { opacity: 0.5 }]}
                disabled={loading}
                onPress={generate}
              >
                <Text style={styles.secondaryBtnText}>{loading ? t('inspector.generaciya') : t('inspector.sgenerirovat_snova')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="draft-accept-btn"
                style={styles.primaryBtn}
                onPress={useDraft}
              >
                <Text style={styles.primaryBtnText}>{t('inspector.ispolzovat_chernovik')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0B' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#27272A',
  },
  headerBtn: { color: '#FFB020', fontSize: 14, fontWeight: '700' },
  headerTitle: { color: '#E4E4E7', fontSize: 14, fontWeight: '800', letterSpacing: 1 },

  introCard: { padding: 20, backgroundColor: '#18181B', borderRadius: 12 },
  introTitle: { color: '#E4E4E7', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  introText: { color: '#A1A1AA', fontSize: 13, lineHeight: 20, marginBottom: 16 },
  introHint: { color: '#71717A', fontSize: 11, marginTop: 12, lineHeight: 16 },

  card: {
    padding: 14, marginBottom: 12, borderRadius: 10,
    backgroundColor: '#18181B', borderWidth: 1, borderColor: '#27272A',
  },
  cardTitle: { color: '#E4E4E7', fontSize: 13, fontWeight: '700', marginBottom: 8 },
  verdict: { fontSize: 18, fontWeight: '900' },
  metaRow: { color: '#A1A1AA', fontSize: 11, marginTop: 4 },
  reasoning: { color: '#D4D4D8', fontSize: 12, marginTop: 8, fontStyle: 'italic' },
  assistantNote: { color: '#71717A', fontSize: 10, marginTop: 8 },

  listRow: { marginBottom: 6 },
  listRowKey: { color: '#FAFAFA', fontSize: 12, fontWeight: '700' },
  listRowMsg: { color: '#A1A1AA', fontSize: 11, marginTop: 2 },

  problemLine: { color: '#D4D4D8', fontSize: 12, marginBottom: 4, lineHeight: 18 },

  summaryInput: {
    minHeight: 90, color: '#FAFAFA', fontSize: 13,
    backgroundColor: '#0F0F11', borderRadius: 8, padding: 10,
    borderWidth: 1, borderColor: '#27272A', textAlignVertical: 'top',
  },

  actions: { flexDirection: 'row', gap: 10, marginTop: 4, marginBottom: 24 },
  primaryBtn: {
    flex: 1, padding: 14, borderRadius: 8, backgroundColor: '#FFB020',
    alignItems: 'center', justifyContent: 'center',
  },
  primaryBtnText: { color: '#000', fontWeight: '800', fontSize: 13 },
  secondaryBtn: {
    flex: 1, padding: 14, borderRadius: 8, backgroundColor: 'transparent',
    borderWidth: 1, borderColor: '#3F3F46', alignItems: 'center',
  },
  secondaryBtnText: { color: '#A1A1AA', fontWeight: '700', fontSize: 13 },
});

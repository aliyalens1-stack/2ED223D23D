// ═════════════════════════════════════════════════════════
// 🛠 Phase C.3 — Provider Workspace
// Concierge interface where inspector/provider attaches candidate cars
// to a customer's selection request: paste link → preview → score/risk/comment.
// Customer reads the result as a comparison view.
// ═════════════════════════════════════════════════════════
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Modal,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../../src/context/ThemeContext';
import Text from '../../../src/components/ui/Text';
import { api } from '../../../src/services/api';
import i18n from '../../../src/i18n';
import {
  hasPreviewSignal,
  CanonicalParseEnvelope,
  ParseCompleteness,
} from '@platform/domain/parsers/canonical';

type Risk = 'low' | 'medium' | 'high';

interface Candidate {
  id: string;
  requestId: string;
  listingUrl: string;
  source?: string | null;
  // Persisted server-side `Candidate.preview` shape. NOT the parser
  // contract — this is what the provider API stores on the candidate
  // document. 11D-β2 deliberately keeps this shape untouched: a
  // backend write-side migration is a separate, larger surgery.
  preview: {
    title?: string | null;
    image?: string | null;
    price?: number | null;
    currency?: string;
    year?: number | null;
    mileage?: number | null;
    fuel?: string | null;
    make?: string | null;
    model?: string | null;
  };
  providerComment?: string | null;
  score?: number | null;
  risk?: Risk | null;
  recommended: boolean;
  status: string;
}

// Wire shape returned by `POST /api/parse/car-link` (Step 11C
// published full `canonical` envelope alongside the legacy flat
// mirror). 11D-β2 reads from `canonical` only; legacy flat fields
// are not declared here so a typo can't leak back in.
interface CanonicalFull extends CanonicalParseEnvelope {
  source: string;
  sourceUrl: string;
  externalId: string | null;
  title: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  priceEur: number | null;
  mileageKm: number | null;
  location: string | null;
  vin: string | null;
  fuel: string | null;
  transmission: string | null;
  sellerType: string | null;
  images: string[];
  parseCompleteness: ParseCompleteness;
  degradedReason: string | null;
  ok: boolean;
}
interface ParseCarLinkResponse {
  canonical: CanonicalFull | null;
  // Legacy mirror fields (parsed / recognized / softFail / hardFail /
  // error / hint / title / price / image / etc.) intentionally NOT
  // declared. They still arrive on the wire until 11D-γ, but this
  // surface no longer reads them.
}

const RISK_TINT: Record<Risk, { color: string; bg: string }> = {
  low:    { color: '#22C55E', bg: 'rgba(34,197,94,0.15)' },
  medium: { color: '#FFB020', bg: 'rgba(255,176,32,0.18)' },
  high:   { color: '#EF4444', bg: 'rgba(239,68,68,0.15)' },
};

const fmtEur = (v: number | null | undefined) =>
  v == null ? '—' : `€${Math.round(v).toLocaleString('de-DE')}`;
const fmtNum = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('de-DE');

export default function ProviderWorkspace() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors, isDark } = useThemeContext();
  const params = useLocalSearchParams<{ requestId?: string }>();
  const requestId = (params.requestId || '').toString();

  const [request, setRequest] = useState<any | null>(null);
  const [items, setItems] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const styles = makeStyles(colors, isDark);

  const reload = async () => {
    if (!requestId) return;
    try {
      const [reqRes, candRes] = await Promise.all([
        api.get(`/customer/requests/${requestId}`),
        api.get(`/provider/requests/${requestId}/candidates`),
      ]);
      setRequest(reqRes.data);
      setItems(candRes.data || []);
    } catch (e) {
      // silent — show empty state
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, [requestId]);

  const onCandidateSaved = () => { setShowAdd(false); reload(); };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']} testID="provider-workspace">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} testID="pw-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text variant="h3" weight="800" style={styles.headerTitle}>
          {t('provider_workspace.header') || 'Concierge workspace'}
        </Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {/* Request brief */}
          {request ? (
            <View style={[styles.briefCard, { backgroundColor: colors.card, borderColor: colors.border }]} testID="pw-brief">
              <Text variant="caption" weight="800" tone="brand" style={{ letterSpacing: 1.2 }}>
                {(t('provider_workspace.brief_label') || 'Customer brief').toUpperCase()}
              </Text>
              <Text variant="h2" weight="900" style={{ marginTop: 6 }}>
                {request.brand || '—'} {request.model || ''}
              </Text>
              <View style={styles.metaRow}>
                {request.budget ? <Chip icon="wallet-outline" text={`≤ ${fmtEur(request.budget)}`} colors={colors} /> : null}
                {request.yearFrom || request.yearTo ? (
                  <Chip icon="calendar-outline" text={`${request.yearFrom || '—'} - ${request.yearTo || '—'}`} colors={colors} />
                ) : null}
                {request.mileageMax ? <Chip icon="speedometer-outline" text={`≤ ${fmtNum(request.mileageMax)} km`} colors={colors} /> : null}
                {request.fuel ? <Chip icon="flash-outline" text={String(request.fuel).toUpperCase()} colors={colors} /> : null}
                {Array.isArray(request.cities) && request.cities.length > 0
                  ? <Chip icon="location-outline" text={request.cities.join(', ')} colors={colors} />
                  : null}
              </View>
              {request.comment ? (
                <Text variant="caption" tone="muted" weight="500" style={{ marginTop: 8, lineHeight: 18 }}>
                  "{request.comment}"
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* Add candidate CTA */}
          <TouchableOpacity
            style={[styles.addBtn, { backgroundColor: colors.primary }]}
            onPress={() => setShowAdd(true)}
            activeOpacity={0.85}
            testID="pw-add-candidate-btn"
          >
            <Ionicons name="add-circle" size={20} color="#000" />
            <Text variant="body" weight="900" style={{ color: '#000', marginLeft: 8 }}>
              {t('provider_workspace.add_candidate') || 'Add candidate car'}
            </Text>
          </TouchableOpacity>

          {/* Candidate list */}
          <Text variant="caption" weight="800" tone="brand" style={[styles.sectionLabel, { marginTop: 18 }]}>
            {((t('provider_workspace.candidates') || 'Shortlist') + ` (${items.length})`).toUpperCase()}
          </Text>

          {items.length === 0 ? (
            <View style={[styles.emptyBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="search-outline" size={36} color={colors.textSecondary} />
              <Text variant="body" weight="700" style={{ marginTop: 10 }}>
                {t('provider_workspace.empty_title') || 'No candidates yet'}
              </Text>
              <Text variant="caption" tone="muted" weight="500" style={{ marginTop: 4, textAlign: 'center', lineHeight: 18 }}>
                {t('provider_workspace.empty_sub') || 'Find a car on mobile.de or AutoScout24 and attach the link here'}
              </Text>
            </View>
          ) : (
            items.map((c) => (
              <CandidateCard key={c.id} item={c} colors={colors} isDark={isDark} onChanged={reload} />
            ))
          )}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}

      {/* Add candidate modal */}
      <AddCandidateModal
        visible={showAdd}
        onClose={() => setShowAdd(false)}
        onSaved={onCandidateSaved}
        requestId={requestId}
        colors={colors}
        isDark={isDark}
      />
    </SafeAreaView>
  );
}

// ───────── CandidateCard ─────────
function CandidateCard({ item, colors, isDark, onChanged }: { item: Candidate; colors: any; isDark: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const styles = makeStyles(colors, isDark);
  const tint = item.risk ? RISK_TINT[item.risk] : { color: colors.textSecondary, bg: 'rgba(127,127,127,0.10)' };
  const hasImage = typeof item.preview.image === 'string' && /^https?:\/\//i.test(item.preview.image);
  const title = item.preview.title || [item.preview.make, item.preview.model].filter(Boolean).join(' ') || 'Vehicle';

  const archive = () => {
    Alert.alert(
      i18n.t('provider_workspace.archive_title') || 'Archive candidate?',
      i18n.t('provider_workspace.archive_body') || 'You can re-add a similar one later.',
      [
        { text: i18n.t('common.cancel') || 'Cancel', style: 'cancel' },
        {
          text: i18n.t('common.delete') || 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.delete(`/provider/candidates/${item.id}`);
              onChanged();
            } catch {
              Alert.alert(i18n.t('common.error') || 'Error');
            }
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.candCard, { backgroundColor: colors.card, borderColor: item.recommended ? '#22C55E' : colors.border }]} testID={`pw-cand-${item.id}`}>
      {item.recommended ? (
        <View style={styles.recommendedRibbon}>
          <Ionicons name="star" size={11} color="#000" />
          <Text variant="caption" weight="900" style={{ marginLeft: 4, color: '#000', letterSpacing: 0.6, fontSize: 10 }}>
            {(t('provider_workspace.recommended') || 'Recommended').toUpperCase()}
          </Text>
        </View>
      ) : null}

      <View style={styles.candTop}>
        {hasImage ? (
          <Image source={{ uri: item.preview.image! }} style={styles.candImage} contentFit="cover" />
        ) : (
          <View style={[styles.candImagePlaceholder, { backgroundColor: 'rgba(245,184,0,0.10)' }]}>
            <Ionicons name="car-sport" size={28} color={colors.primary} />
          </View>
        )}

        <View style={{ flex: 1 }}>
          <Text variant="h3" weight="800" numberOfLines={2}>{title}</Text>
          <View style={styles.candMetaRow}>
            {item.preview.year ? <SmallChip text={String(item.preview.year)} colors={colors} /> : null}
            {item.preview.mileage ? <SmallChip text={`${fmtNum(item.preview.mileage)} km`} colors={colors} /> : null}
            {item.preview.fuel ? <SmallChip text={item.preview.fuel.toUpperCase()} colors={colors} /> : null}
          </View>
          <View style={styles.candPriceRow}>
            <Text variant="h3" weight="900">{fmtEur(item.preview.price ?? null)}</Text>
            {item.source ? (
              <Text variant="caption" tone="muted" weight="600" style={{ marginLeft: 8 }}>
                · {item.source}
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      <View style={[styles.candVerdictRow, { backgroundColor: tint.bg }]}>
        <View style={styles.candVerdictLeft}>
          <Text variant="caption" tone="muted" weight="700">
            {(t('provider_workspace.score') || 'Score').toUpperCase()}
          </Text>
          <Text variant="h2" weight="900" style={{ color: tint.color, marginTop: 2 }}>
            {item.score != null ? item.score.toFixed(1) : '—'}
            <Text variant="caption" tone="muted" weight="700"> /10</Text>
          </Text>
        </View>
        <View style={styles.candVerdictRight}>
          <Text variant="caption" tone="muted" weight="700">
            {(t('provider_workspace.risk') || 'Risk').toUpperCase()}
          </Text>
          <View style={[styles.riskPill, { backgroundColor: tint.color }]}>
            <Text variant="caption" weight="900" style={{ color: '#000', letterSpacing: 0.6 }}>
              {(item.risk || '—').toUpperCase()}
            </Text>
          </View>
        </View>
      </View>

      {item.providerComment ? (
        <Text variant="caption" weight="500" tone="muted" style={{ marginTop: 10, lineHeight: 18 }}>
          {item.providerComment}
        </Text>
      ) : null}

      <View style={styles.candActions}>
        <TouchableOpacity onPress={archive} style={styles.archiveBtn} testID={`pw-cand-${item.id}-archive`}>
          <Ionicons name="archive-outline" size={14} color={colors.textSecondary} />
          <Text variant="caption" weight="700" tone="muted" style={{ marginLeft: 4 }}>
            {t('common.delete') || 'Archive'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ───────── AddCandidateModal ─────────
function AddCandidateModal({
  visible, onClose, onSaved, requestId, colors, isDark,
}: { visible: boolean; onClose: () => void; onSaved: () => void; requestId: string; colors: any; isDark: boolean }) {
  const { t } = useTranslation();
  const styles = makeStyles(colors, isDark);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<ParseCarLinkResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [score, setScore] = useState('7.0');
  const [risk, setRisk] = useState<Risk>('low');
  const [recommended, setRecommended] = useState(false);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset on open
  useEffect(() => {
    if (visible) {
      setUrl(''); setPreview(null); setPreviewLoading(false);
      setScore('7.0'); setRisk('low'); setRecommended(false); setComment('');
    }
  }, [visible]);

  // Debounced preview fetch
  useEffect(() => {
    const v = url.trim();
    if (!v || v.length < 12 || !/^https?:\/\//i.test(v)) { setPreview(null); return; }
    let alive = true;
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      api.post('/parse/car-link', { url: v })
        .then((r) => { if (alive) setPreview(r.data as ParseCarLinkResponse); })
        // 11D-β2 — emit a canonical-shaped fallback envelope on
        // network / exception so display + hasPreviewSignal() can
        // route through the "preview unavailable" branch without
        // reading any legacy field.
        .catch(() => {
          if (alive) setPreview({
            canonical: {
              ok: false,
              source: 'unknown',
              sourceUrl: v,
              externalId: null,
              title: null, make: null, model: null, year: null,
              priceEur: null, mileageKm: null, location: null,
              vin: null, fuel: null, transmission: null, sellerType: null,
              images: [],
              parseCompleteness: 'weak',
              degradedReason: 'parse_error',
            },
          });
        })
        .finally(() => { if (alive) setPreviewLoading(false); });
    }, 600);
    return () => { alive = false; clearTimeout(timer); };
  }, [url]);

  const save = async () => {
    const v = url.trim();
    if (!v || !/^https?:\/\//i.test(v)) {
      Alert.alert(i18n.t('provider_workspace.err_url_required') || 'Listing URL required');
      return;
    }
    const numScore = parseFloat(score.replace(',', '.'));
    if (Number.isNaN(numScore) || numScore < 0 || numScore > 10) {
      Alert.alert(i18n.t('provider_workspace.err_score') || 'Score must be 0..10');
      return;
    }
    setSaving(true);
    try {
      // 11D-β2 — submit reads from `canonical.*` so this surface
      // does not depend on `/api/parse/car-link` legacy mirror
      // fields. Backend `Candidate.preview` (persisted shape) is
      // unchanged — we map canonical → that shape here. `image` /
      // `currency` are NOT in canonical (not parser substrate);
      // image → canonical.images[0], currency stays 'EUR' default.
      const c = preview?.canonical ?? null;
      await api.post(`/provider/requests/${requestId}/candidates`, {
        listingUrl: v,
        source: c?.source && c.source !== 'unknown' ? c.source : null,
        preview: {
          title:    c?.title ?? null,
          image:    c?.images?.[0] ?? null,
          price:    c?.priceEur ?? null,
          currency: 'EUR',
          year:     c?.year ?? null,
          mileage:  c?.mileageKm ?? null,
          fuel:     c?.fuel ?? null,
          make:     c?.make ?? null,
          model:    c?.model ?? null,
        },
        providerComment: comment.trim() || null,
        score: numScore,
        risk,
        recommended,
      });
      onSaved();
    } catch (e: any) {
      Alert.alert(i18n.t('common.error') || 'Error', e?.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { backgroundColor: colors.background }]}>
            <View style={styles.modalHeader}>
              <Text variant="h3" weight="800">{t('provider_workspace.add_title') || 'Add candidate car'}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={26} color={colors.text} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
              {/* Listing URL */}
              <Text variant="caption" weight="800" style={styles.fieldLabel}>{t('provider_workspace.listing_url') || 'Listing URL'} *</Text>
              <TextInput
                value={url}
                onChangeText={setUrl}
                placeholder="https://suchen.mobile.de/..."
                placeholderTextColor={colors.textSecondary}
                style={[styles.input, { color: colors.text, backgroundColor: colors.card, borderColor: colors.border }]}
                autoCapitalize="none"
                autoCorrect={false}
                testID="pw-add-url"
              />

              {/* Preview */}
              {previewLoading ? (
                <View style={[styles.previewBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <ActivityIndicator size="small" color={colors.primary} />
                </View>
              ) : preview ? (
                // 11D-β2 — `hasPreviewSignal()` is the SOLE gate. The
                // legacy `preview.recognized` boolean is gone; we
                // delegate to the shared substrate classifier so this
                // surface obeys the same rule as Expo inspection-
                // preview and web InspectPage.
                hasPreviewSignal({
                  ok: preview.canonical?.ok ?? false,
                  parseCompleteness: preview.canonical?.parseCompleteness ?? null,
                  degradedReason: preview.canonical?.degradedReason ?? null,
                }) ? (
                  <View style={[styles.previewBox, { backgroundColor: colors.card, borderColor: '#22C55E' }]}>
                    <Ionicons name="checkmark-circle" size={18} color="#22C55E" />
                    <View style={{ marginLeft: 10, flex: 1 }}>
                      <Text variant="body" weight="700" numberOfLines={1}>
                        {preview.canonical?.title
                          || `${preview.canonical?.make || ''} ${preview.canonical?.model || ''}`.trim()
                          || '—'}
                      </Text>
                      <Text variant="caption" tone="muted" weight="600" style={{ marginTop: 2 }}>
                        {preview.canonical?.year ? `${preview.canonical.year} · ` : ''}
                        {preview.canonical?.mileageKm ? `${fmtNum(preview.canonical.mileageKm)} km · ` : ''}
                        {fmtEur(preview.canonical?.priceEur ?? null)}
                        {preview.canonical?.source && preview.canonical.source !== 'unknown' ? ` · ${preview.canonical.source}` : ''}
                      </Text>
                    </View>
                  </View>
                ) : (
                  <View style={[styles.previewBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Ionicons name="shield-checkmark" size={18} color="#22C55E" />
                    <View style={{ marginLeft: 10, flex: 1 }}>
                      <Text variant="caption" weight="700">{t('create.link_parse_unavailable') || 'Preview unavailable'}</Text>
                      <Text variant="caption" tone="muted" weight="500" style={{ marginTop: 2, lineHeight: 16 }}>
                        {t('create.link_parse_unavailable_sub') || 'The site blocks auto-fetch — link accepted'}
                      </Text>
                    </View>
                  </View>
                )
              ) : null}

              {/* Score */}
              <Text variant="caption" weight="800" style={[styles.fieldLabel, { marginTop: 16 }]}>
                {t('provider_workspace.score_label') || 'Score'} (0–10) *
              </Text>
              <TextInput
                value={score}
                onChangeText={setScore}
                placeholder="7.5"
                placeholderTextColor={colors.textSecondary}
                style={[styles.input, { color: colors.text, backgroundColor: colors.card, borderColor: colors.border }]}
                keyboardType="decimal-pad"
                testID="pw-add-score"
              />

              {/* Risk */}
              <Text variant="caption" weight="800" style={[styles.fieldLabel, { marginTop: 16 }]}>
                {t('provider_workspace.risk_label') || 'Risk'} *
              </Text>
              <View style={styles.chipRow}>
                {(['low','medium','high'] as Risk[]).map((r) => (
                  <TouchableOpacity
                    key={r}
                    onPress={() => setRisk(r)}
                    style={[
                      styles.chip,
                      risk === r ? { backgroundColor: RISK_TINT[r].color } : { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 },
                    ]}
                    testID={`pw-add-risk-${r}`}
                  >
                    <Text variant="caption" weight="800" style={{ color: risk === r ? '#000' : colors.text }}>
                      {r.toUpperCase()}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Recommended toggle */}
              <TouchableOpacity
                onPress={() => setRecommended(v => !v)}
                style={[styles.recRow, { backgroundColor: colors.card, borderColor: recommended ? '#22C55E' : colors.border }]}
                testID="pw-add-recommended"
              >
                <View style={[styles.checkBox, { borderColor: recommended ? '#22C55E' : colors.border, backgroundColor: recommended ? '#22C55E' : 'transparent' }]}>
                  {recommended ? <Ionicons name="checkmark" size={14} color="#000" /> : null}
                </View>
                <View style={{ marginLeft: 10, flex: 1 }}>
                  <Text variant="body" weight="700">{t('provider_workspace.recommend_label') || 'Recommend to customer'}</Text>
                  <Text variant="caption" tone="muted" weight="500" style={{ marginTop: 2, lineHeight: 16 }}>
                    {t('provider_workspace.recommend_sub') || 'Highlights this car at the top of the comparison'}
                  </Text>
                </View>
              </TouchableOpacity>

              {/* Comment */}
              <Text variant="caption" weight="800" style={[styles.fieldLabel, { marginTop: 16 }]}>
                {t('provider_workspace.comment_label') || 'Notes for customer'}
              </Text>
              <TextInput
                value={comment}
                onChangeText={setComment}
                placeholder={t('provider_workspace.comment_placeholder') || 'What did you find? Why this verdict?'}
                placeholderTextColor={colors.textSecondary}
                style={[styles.input, styles.textArea, { color: colors.text, backgroundColor: colors.card, borderColor: colors.border }]}
                multiline
                numberOfLines={3}
                testID="pw-add-comment"
              />

              <TouchableOpacity
                onPress={save}
                disabled={saving}
                style={[styles.saveBtn, { backgroundColor: colors.primary, opacity: saving ? 0.5 : 1 }]}
                testID="pw-add-save"
              >
                {saving ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <>
                    <Ionicons name="checkmark-circle" size={18} color="#000" />
                    <Text variant="body" weight="900" style={{ color: '#000', marginLeft: 8 }}>
                      {t('provider_workspace.save') || 'Save candidate'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ───────── Helpers ─────────
function Chip({ icon, text, colors }: { icon: any; text: string; colors: any }) {
  return (
    <View style={chipStyles.box}>
      <Ionicons name={icon} size={12} color={colors.textSecondary} />
      <Text variant="caption" tone="muted" weight="700" style={{ marginLeft: 4 }}>{text}</Text>
    </View>
  );
}
function SmallChip({ text, colors }: { text: string; colors: any }) {
  return (
    <View style={chipStyles.smallBox}>
      <Text variant="caption" tone="muted" weight="700">{text}</Text>
    </View>
  );
}
const chipStyles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(127,127,127,0.10)', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, marginRight: 6, marginTop: 6 },
  smallBox: { backgroundColor: 'rgba(127,127,127,0.10)', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 5, marginRight: 5, marginTop: 4 },
});

function makeStyles(colors: any, isDark: boolean) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 16, paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    headerTitle: { flex: 1, textAlign: 'center' },
    loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    scroll: { padding: 16, paddingBottom: 24 },

    briefCard: { borderRadius: 16, borderWidth: 1, padding: 16 },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },

    addBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      paddingVertical: 14, borderRadius: 14, marginTop: 18,
    },
    sectionLabel: { letterSpacing: 1.2, marginBottom: 8 },

    emptyBox: { alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, padding: 24 },

    candCard: { borderRadius: 16, borderWidth: 1.5, padding: 14, marginBottom: 12 },
    recommendedRibbon: {
      position: 'absolute', top: 10, right: 10,
      flexDirection: 'row', alignItems: 'center',
      backgroundColor: '#22C55E', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
    },
    candTop: { flexDirection: 'row', gap: 12 },
    candImage: { width: 100, height: 75, borderRadius: 10 },
    candImagePlaceholder: { width: 100, height: 75, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
    candMetaRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
    candPriceRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 4 },
    candVerdictRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, marginTop: 12,
    },
    candVerdictLeft: { flex: 1 },
    candVerdictRight: { alignItems: 'flex-end' },
    riskPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, marginTop: 2 },
    candActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 },
    archiveBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4 },

    // Modal
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
    modalSheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '92%' },
    modalHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    fieldLabel: { letterSpacing: 0.5, marginBottom: 6, color: colors.text },
    input: {
      borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12,
      fontSize: 15,
    },
    textArea: { minHeight: 80, textAlignVertical: 'top' },
    previewBox: {
      flexDirection: 'row', alignItems: 'center',
      borderWidth: 1.5, borderRadius: 12, padding: 12, marginTop: 10,
    },
    chipRow: { flexDirection: 'row', gap: 8 },
    chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
    recRow: {
      flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1.5,
      padding: 12, marginTop: 16,
    },
    checkBox: {
      width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center',
    },
    saveBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      paddingVertical: 16, borderRadius: 14, marginTop: 20,
    },
  });
}

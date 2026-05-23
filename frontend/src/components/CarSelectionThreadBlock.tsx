/**
 * Car-Selection-4/5 — Thread block (mobile, append-only) + artifacts.
 *
 * Shared by customer (`/car-selection/[id]`) and provider
 * (`/provider/car-selection/[id]`). The surface prop chooses the right
 * backend prefix:
 *
 *   customer → /car-selection/requests/{id}
 *   provider → /provider/car-selection/{id}
 *
 * INVARIANTS ENCODED IN THE UI
 *   • messages are append-only (no edit / no delete affordance)
 *   • one input → POST creates a NEW message; prior ones never mutate
 *   • thread is rendered as a clearly separate block from the lifecycle
 *     timeline; they share no data and no actions
 *   • frozen customer brief lives elsewhere; this component never
 *     reads / writes it
 *
 * CAR-SELECTION-5 (artifacts) DISCIPLINE
 *   • paperclip → pick → upload → LOCAL staged chip → user presses Send
 *   • upload of an artifact does NOT post a message (matches backend
 *     invariant: artifact upload is its own operation)
 *   • Send sends the body + attachmentIds in one POST. The thread row
 *     that comes back already carries the resolved attachment
 *     projection — we just append it
 *   • cancel-an-attachment removes it from staged list only; the
 *     server-side artifact stays (immutable) but is never referenced
 *   • tap an attachment row → download with auth → open native viewer
 *     (expo-sharing) — no embedded preview gallery
 *   • restrained errors: inline label, no toast storm, no modal
 *
 * PHASE 5 — i18n freeze
 *   • all visible strings flow through `t('car_selection.*')`
 *   • backend error codes mapped via mapCarSelectionError
 *   • per-kind size-limit copy is EXPLICIT (no `${kind} exceeds ${cap}`)
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { tokens } from '../theme/tokens';
import i18n from '../../src/i18n';
import {
  mapCarSelectionError,
  carSelectionErrorByCode,
} from '../i18n/carSelectionErrors';

export type ThreadSurface = 'customer' | 'provider';

type AuthorRole = 'customer' | 'provider' | 'admin';

type ArtifactKind = 'image' | 'pdf' | 'file';

interface ArtifactOut {
  id: string;
  requestId: string;
  uploadedBy: string;
  uploadedByRole: AuthorRole;
  kind: ArtifactKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  createdAt: string;
}

interface CSMessage {
  id: string;
  requestId: string;
  authorId: string;
  authorRole: AuthorRole;
  body: string;
  attachments?: ArtifactOut[];
  visibility: 'shared' | 'admin_internal';
  createdAt: string;
}

interface ListResponse { items: CSMessage[]; total: number }

const C = tokens.colors;
const S = tokens.spacing;
const R = tokens.radius;

// Caps mirrored from backend (app/car_selection_thread/artifacts.py).
// We pre-check size before uploading so the 413 round-trip never
// happens for clearly-too-big assets — but the server stays the
// source of truth.
const KIND_CAP: Record<ArtifactKind, number> = {
  image: 8 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  file: 10 * 1024 * 1024,
};

function basePathFor(surface: ThreadSurface, requestId: string): string {
  if (surface === 'provider') return `/provider/car-selection/${requestId}`;
  return `/car-selection/requests/${requestId}`;
}

function roleTone(r: AuthorRole): string {
  if (r === 'customer') return '#4FB3FF';   // blue
  if (r === 'provider') return C.success;   // green
  return C.warning;                          // amber for admin
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const dd = d.getDate().toString().padStart(2, '0');
    const mo = (d.getMonth() + 1).toString().padStart(2, '0');
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${dd}.${mo} · ${hh}:${mm}`;
  } catch {
    return iso;
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function kindIcon(k: ArtifactKind): keyof typeof Ionicons.glyphMap {
  if (k === 'image') return 'image-outline';
  if (k === 'pdf') return 'document-text-outline';
  return 'attach-outline';
}

interface Props {
  requestId: string;
  surface: ThreadSurface;
  isDark: boolean;
  /** Hides the composer entirely. Thread list is always visible. */
  composerHidden?: boolean;
  /** Show the paperclip → upload pipeline. Provider gets this by
   *  default; customer can opt in. */
  uploadEnabled?: boolean;
}

export default function CarSelectionThreadBlock({
  requestId,
  surface,
  isDark,
  composerHidden,
  uploadEnabled,
}: Props) {
  const { t } = useTranslation();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);
  const allowUpload = uploadEnabled ?? (surface === 'provider');

  const [items, setItems] = useState<CSMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  // ── Staging area ────────────────────────────────────────────────
  const [staged, setStaged] = useState<ArtifactOut[]>([]);
  const [uploading, setUploading] = useState<ArtifactKind | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // ── Download state per artifact id (only one in-flight at a time) ─
  const [opening, setOpening] = useState<string | null>(null);

  const ROLE_LABEL: Record<AuthorRole, string> = {
    customer: i18n.t('car_selection.role.customer'),
    provider: i18n.t('car_selection.role.provider'),
    admin:    i18n.t('car_selection.role.admin'),
  };

  const base = basePathFor(surface, requestId);
  const threadUrl = `${base}/thread`;
  const artifactsUrl = `${base}/artifacts`;

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<ListResponse>(threadUrl);
      setItems(data.items || []);
      setError(null);
    } catch (e: any) {
      const code = e?.response?.status;
      if (code === 404 || code === 403) {
        setError(null);
        setItems([]);
      } else {
        setError(mapCarSelectionError(t, e) || i18n.t('car_selection.thread.load_failed'));
      }
    } finally {
      setLoading(false);
    }
  }, [threadUrl, t]);

  useEffect(() => { load(); }, [load]);

  // ── Upload pipeline ─────────────────────────────────────────────

  const uploadFile = useCallback(
    async (
      kind: ArtifactKind,
      uri: string,
      filename: string,
      mimeType: string,
      sizeBytes: number,
    ) => {
      // Pre-check size against the per-kind cap before round-tripping.
      const cap = KIND_CAP[kind];
      if (sizeBytes > cap) {
        // Explicit per-kind wording — no `${kind} exceeds ${cap}` interpolation.
        setUploadErr(carSelectionErrorByCode(t, 'ARTIFACT_TOO_LARGE', kind));
        return;
      }
      setUploadErr(null);
      setUploading(kind);
      try {
        const form = new FormData();
        form.append('kind', kind);
        form.append('file', {
          uri,
          name: filename,
          type: mimeType,
        } as any);
        const { data } = await api.post<ArtifactOut>(artifactsUrl, form, {
          headers: { 'Content-Type': 'multipart/form-data' },
          transformRequest: (d) => d, // axios would otherwise JSON.stringify the FormData
        });
        setStaged((prev) => [...prev, data]);
      } catch (e: any) {
        setUploadErr(mapCarSelectionError(t, e, kind) || i18n.t('car_selection.upload.failed'));
      } finally {
        setUploading(null);
      }
    },
    [artifactsUrl, t],
  );

  const pickImage = useCallback(async () => {
    setPickerOpen(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setUploadErr(i18n.t('car_selection.upload.permission_denied'));
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsEditing: false,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    const mime = a.mimeType || 'image/jpeg';
    const name = a.fileName || `photo-${Date.now()}.jpg`;
    const size = a.fileSize ?? 0;
    await uploadFile('image', a.uri, name, mime, size);
  }, [uploadFile, t]);

  const pickDocument = useCallback(
    async (kind: 'pdf' | 'file') => {
      setPickerOpen(false);
      const res = await DocumentPicker.getDocumentAsync({
        type: kind === 'pdf' ? 'application/pdf' : '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const a = res.assets[0];
      const mime = a.mimeType || (kind === 'pdf' ? 'application/pdf' : 'application/octet-stream');
      const name = a.name || `upload-${Date.now()}`;
      const size = a.size ?? 0;
      await uploadFile(kind, a.uri, name, mime, size);
    },
    [uploadFile],
  );

  const removeStaged = useCallback((id: string) => {
    setStaged((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ── Send ────────────────────────────────────────────────────────

  const submit = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const payload: any = { body };
      if (staged.length) payload.attachmentIds = staged.map((s) => s.id);
      const { data } = await api.post<CSMessage>(threadUrl, payload);
      setItems((prev) => [...prev, data]);
      setDraft('');
      setStaged([]);
      setUploadErr(null);
    } catch (e: any) {
      setError(mapCarSelectionError(t, e) || i18n.t('car_selection.thread.send_failed'));
    } finally {
      setSending(false);
    }
  }, [draft, sending, threadUrl, staged, t]);

  // ── Open / download an artifact in the native viewer ────────────

  const openArtifact = useCallback(async (art: ArtifactOut) => {
    if (opening) return; // serialize to avoid duplicate downloads
    setOpening(art.id);
    try {
      // art.url is `/api/...`. The api axios instance prefixes with
      // `${API_URL}/api`, so for raw fetch we use the original
      // backend URL + art.url path.
      const apiUrl = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
      const fullUrl = apiUrl + art.url;
      const token = await AsyncStorage.getItem('accessToken');
      const safe = art.filename.replace(/[^a-z0-9._-]/gi, '_');
      const localUri = `${FileSystem.cacheDirectory}${art.id}-${safe}`;
      const dl = await FileSystem.downloadAsync(fullUrl, localUri, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (dl.status >= 200 && dl.status < 300) {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(dl.uri, {
            mimeType: art.mimeType,
            UTI: art.mimeType, // iOS hint
            dialogTitle: art.filename,
          });
        }
      } else {
        setUploadErr(i18n.t('car_selection.upload.open_failed_status', { status: dl.status }));
      }
    } catch (e: any) {
      setUploadErr(mapCarSelectionError(t, e) || i18n.t('car_selection.upload.open_failed'));
    } finally {
      setOpening(null);
    }
  }, [opening, t]);

  // ── Render ──────────────────────────────────────────────────────

  return (
    <View style={styles.block} testID="cs-thread-block">
      <View style={styles.headerRow}>
        <Ionicons name="chatbubbles-outline" size={13} color={isDark ? C.subtextDark : C.subtextLight} />
        <Text style={styles.headerLabel}>
          {t('car_selection.thread.count', { count: items.length })}
        </Text>
        <Text style={styles.headerHint}>{t('car_selection.thread.hint')}</Text>
      </View>

      <View style={styles.list} testID="cs-thread-list">
        {loading ? (
          <View style={styles.center} testID="cs-thread-loading">
            <ActivityIndicator color={C.brand} size="small" />
          </View>
        ) : items.length === 0 ? (
          <Text style={styles.emptyText} testID="cs-thread-empty">
            {t('car_selection.thread.empty')}
          </Text>
        ) : (
          items.map((m) => (
            <View
              key={m.id}
              style={[styles.msg, { borderColor: roleTone(m.authorRole) + '55', backgroundColor: roleTone(m.authorRole) + '15' }]}
              testID={`cs-thread-msg-${m.id}`}
            >
              <View style={styles.msgHeader}>
                <Text style={[styles.msgRole, { color: roleTone(m.authorRole) }]}>
                  {ROLE_LABEL[m.authorRole].toUpperCase()}
                </Text>
                <Text style={styles.msgTime}>{fmtTime(m.createdAt)}</Text>
              </View>
              <Text style={styles.msgBody} selectable>{m.body}</Text>
              {(m.attachments?.length ?? 0) > 0 ? (
                <View style={styles.attachRow} testID={`cs-thread-msg-attachments-${m.id}`}>
                  {(m.attachments || []).map((a) => (
                    <TouchableOpacity
                      key={a.id}
                      style={styles.attachChip}
                      onPress={() => openArtifact(a)}
                      activeOpacity={0.7}
                      disabled={opening === a.id}
                      testID={`cs-thread-attach-${a.id}`}
                      accessibilityLabel={t('car_selection.thread.open')}
                    >
                      <Ionicons
                        name={kindIcon(a.kind)}
                        size={13}
                        color={isDark ? C.textDark : C.textLight}
                      />
                      <Text style={styles.attachName} numberOfLines={1}>
                        {a.filename}
                      </Text>
                      <Text style={styles.attachMeta}>{fmtBytes(a.sizeBytes)}</Text>
                      {opening === a.id ? (
                        <ActivityIndicator size="small" color={C.brand} />
                      ) : (
                        <Ionicons name="open-outline" size={11} color={isDark ? C.subtextDark : C.subtextLight} />
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}
            </View>
          ))
        )}
      </View>

      {error ? (
        <Text style={styles.errorText} testID="cs-thread-error">
          <Ionicons name="alert-circle" size={11} color={C.error} />  {error}
        </Text>
      ) : null}

      {!composerHidden && (
        <View testID="cs-thread-composer">
          {/* Staged chips (BEFORE send). Tap × removes the staged ref. */}
          {staged.length > 0 ? (
            <View style={styles.stagedRow} testID="cs-thread-staged">
              {staged.map((a) => (
                <View key={a.id} style={styles.stagedChip} testID={`cs-thread-staged-${a.id}`}>
                  <Ionicons name={kindIcon(a.kind)} size={12} color={C.brand} />
                  <Text style={styles.stagedName} numberOfLines={1}>{a.filename}</Text>
                  <Text style={styles.stagedMeta}>{fmtBytes(a.sizeBytes)}</Text>
                  <TouchableOpacity
                    onPress={() => removeStaged(a.id)}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                    testID={`cs-thread-staged-remove-${a.id}`}
                    accessibilityLabel={t('car_selection.picker.cancel')}
                  >
                    <Ionicons name="close" size={13} color={isDark ? C.subtextDark : C.subtextLight} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          ) : null}

          {/* Upload error (inline, restrained). */}
          {uploadErr ? (
            <Text style={styles.uploadErrText} testID="cs-thread-upload-error">
              <Ionicons name="alert-circle" size={11} color={C.error} />  {uploadErr}
            </Text>
          ) : null}

          {/* Inline picker — appears when paperclip is tapped. */}
          {pickerOpen ? (
            <View style={styles.pickerRow} testID="cs-thread-picker">
              <TouchableOpacity
                style={styles.pickerBtn}
                onPress={pickImage}
                disabled={uploading !== null}
                testID="cs-thread-pick-image"
              >
                <Ionicons name="image-outline" size={14} color={C.brand} />
                <Text style={styles.pickerLabel}>{t('car_selection.picker.photo')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.pickerBtn}
                onPress={() => pickDocument('pdf')}
                disabled={uploading !== null}
                testID="cs-thread-pick-pdf"
              >
                <Ionicons name="document-text-outline" size={14} color={C.brand} />
                <Text style={styles.pickerLabel}>{t('car_selection.picker.pdf')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.pickerBtn}
                onPress={() => pickDocument('file')}
                disabled={uploading !== null}
                testID="cs-thread-pick-file"
              >
                <Ionicons name="attach-outline" size={14} color={C.brand} />
                <Text style={styles.pickerLabel}>{t('car_selection.picker.file')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pickerBtn, { opacity: 0.6 }]}
                onPress={() => setPickerOpen(false)}
                testID="cs-thread-pick-cancel"
                accessibilityLabel={t('car_selection.picker.cancel')}
              >
                <Ionicons name="close" size={14} color={isDark ? C.subtextDark : C.subtextLight} />
              </TouchableOpacity>
            </View>
          ) : null}

          <View style={styles.composer}>
            {allowUpload ? (
              <TouchableOpacity
                onPress={() => { setUploadErr(null); setPickerOpen((v) => !v); }}
                style={styles.attachBtn}
                disabled={uploading !== null}
                activeOpacity={0.7}
                testID="cs-thread-paperclip"
              >
                {uploading ? (
                  <ActivityIndicator size="small" color={C.brand} />
                ) : (
                  <Ionicons
                    name={pickerOpen ? 'close' : 'attach'}
                    size={18}
                    color={isDark ? C.textDark : C.textLight}
                  />
                )}
              </TouchableOpacity>
            ) : null}
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={t('car_selection.thread.input_placeholder')}
              placeholderTextColor={isDark ? C.subtextDark : C.subtextLight}
              multiline
              maxLength={4000}
              style={styles.input}
              testID="cs-thread-input"
            />
            <TouchableOpacity
              onPress={submit}
              disabled={!draft.trim() || sending || uploading !== null}
              style={[
                styles.sendBtn,
                (!draft.trim() || sending || uploading !== null) ? { opacity: 0.5 } : null,
              ]}
              activeOpacity={0.8}
              testID="cs-thread-send"
              accessibilityLabel={t('car_selection.thread.send')}
            >
              {sending ? (
                <ActivityIndicator color="#000" size="small" />
              ) : (
                <Ionicons name="send" size={16} color="#000" />
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

function makeStyles(isDark: boolean) {
  const bg      = isDark ? C.bgDark      : C.bgLight;
  const card    = isDark ? C.cardDark    : C.cardLight;
  const text    = isDark ? C.textDark    : C.textLight;
  const subtext = isDark ? C.subtextDark : C.subtextLight;
  const border  = isDark ? C.borderDark  : C.borderLight;

  return StyleSheet.create({
    block: {
      backgroundColor: card,
      borderRadius: R.md,
      borderWidth: 1,
      borderColor: border,
      padding: S.md,
    },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: S.sm, flexWrap: 'wrap' },
    headerLabel: {
      fontSize: tokens.typography.micro,
      fontWeight: '800',
      color: subtext,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    headerHint: {
      fontSize: tokens.typography.micro - 1,
      color: subtext,
      fontStyle: 'italic',
      flex: 1,
    },

    list: {
      gap: S.xs + 2,
      maxHeight: 320,
    },
    center: { paddingVertical: S.md, alignItems: 'center' },
    emptyText: {
      fontSize: tokens.typography.caption,
      color: subtext,
      fontStyle: 'italic',
      paddingVertical: S.sm,
    },
    msg: {
      borderRadius: R.sm,
      borderWidth: 1,
      paddingHorizontal: S.sm,
      paddingVertical: S.xs + 2,
    },
    msgHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 2,
    },
    msgRole: {
      fontSize: tokens.typography.micro - 1,
      fontWeight: '800',
      letterSpacing: 0.5,
    },
    msgTime: {
      fontSize: tokens.typography.micro - 1,
      color: subtext,
    },
    msgBody: {
      fontSize: tokens.typography.caption + 1,
      color: text,
      lineHeight: 18,
    },

    // Attachment chips inside delivered messages.
    attachRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 6,
    },
    attachChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: border,
      backgroundColor: bg,
      maxWidth: 220,
    },
    attachName: {
      fontSize: tokens.typography.micro,
      color: text,
      flexShrink: 1,
    },
    attachMeta: {
      fontSize: tokens.typography.micro - 1,
      color: subtext,
    },

    errorText: {
      marginTop: S.xs + 2,
      fontSize: tokens.typography.micro,
      color: C.error,
    },

    // Staged chips (BEFORE send).
    stagedRow: {
      marginTop: S.sm,
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    stagedChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 5,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: C.brand + '88',
      backgroundColor: C.brand + '14',
      maxWidth: 230,
    },
    stagedName: {
      fontSize: tokens.typography.micro,
      color: text,
      flexShrink: 1,
    },
    stagedMeta: {
      fontSize: tokens.typography.micro - 1,
      color: subtext,
    },

    uploadErrText: {
      marginTop: S.xs + 2,
      fontSize: tokens.typography.micro,
      color: C.error,
    },

    // Inline picker row (paperclip → 3 buttons).
    pickerRow: {
      marginTop: S.xs + 2,
      flexDirection: 'row',
      gap: 6,
      flexWrap: 'wrap',
    },
    pickerBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: C.brand + '66',
      backgroundColor: bg,
    },
    pickerLabel: {
      fontSize: tokens.typography.micro,
      color: text,
      fontWeight: '600',
    },

    composer: {
      marginTop: S.sm,
      flexDirection: 'row',
      gap: S.xs + 2,
      alignItems: 'flex-end',
    },
    attachBtn: {
      backgroundColor: bg,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: border,
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    input: {
      flex: 1,
      backgroundColor: bg,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: border,
      padding: S.sm,
      color: text,
      fontSize: tokens.typography.caption + 1,
      minHeight: 44,
      maxHeight: 120,
      textAlignVertical: 'top',
    },
    sendBtn: {
      backgroundColor: C.brand,
      borderRadius: R.sm,
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}

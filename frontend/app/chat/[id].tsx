/**
 * Chat thread screen — Sprint B2 (canonical contract).
 *
 * All wire reads go through `useChatMessages(threadId)` over
 * `/api/chat/v1/threads/{id}/*`. The screen is now a pure projection:
 *   - `isMine` comes from the backend; no client-side derivation
 *   - `unreadByMe` comes from the backend; we only call `markRead()` on focus
 *     and rely on its `mutated` flag for cache invalidation discipline
 *   - send mutates state from the `{ message, thread }` envelope; no
 *     optimistic temp messages (the server round-trip is sub-second on
 *     polling-only transport, no UX win worth the inconsistency risk)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ActivityIndicator, Image, Alert, Linking,
} from 'react-native';
import i18n from '../../src/i18n';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { Audio } from 'expo-av';
import { useThemeContext } from '../../src/context/ThemeContext';
import { useChatMessages } from '../../src/hooks/useChatMessages';
import { useChatSocket } from '../../src/hooks/useChatSocket';
import api from '../../src/services/api';
import type { ChatMessage, ChatThread, ChatAttachment, ChatVoice, ChatReaction, ChatReactionEmoji } from '@platform/domain/contracts/chat';

// Sprint B4c — must match `_REACTION_WHITELIST` in backend/app/chat/canonical.py.
// Order here is the picker order. Storage/projection order is `count desc`,
// so the picker order is a UI concern only.
const REACTION_EMOJIS: readonly ChatReactionEmoji[] = ['👍', '❤️', '😂', '😮', '😢', '👎'];

function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const ATTACH_MAX_BYTES = 8 * 1024 * 1024;  // matches backend image cap (the more restrictive of the three)
const ATTACH_ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

function threadHeaderTitle(t: ChatThread | null): string {
  if (!t) return i18n.t('chat.chat');
  if (t.kind === 'support') return 'AutoSearch Support';
  if (t.title) return t.title;
  const prov = t.participants.find((p) => p.kind === 'provider');
  if (prov?.displayName) return prov.displayName;
  return i18n.t('chat.chat');
}

export default function ChatScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const threadId = typeof id === 'string' ? id : null;
  const { colors } = useThemeContext();
  const { thread, messages, loading, sending, error, send, markRead, refresh } = useChatMessages(threadId, !!threadId);

  // Sprint B5 — accelerate polling with WS push. The hook does NOT
  // mutate local state; it triggers `refresh()` (canonical refetch)
  // on every semantic event. Polling stays as substrate so a dropped
  // socket NEVER loses state.
  useChatSocket({
    enabled: !!threadId,
    onRefresh: useCallback(() => {
      // Filter on the event would let us skip refetch for unrelated
      // thread updates, but for B5 we keep it simple and dumb: REST
      // is fast enough, and the dedupe-by-id contract guarantees no
      // double-render even if WS and polling overlap.
      if (threadId) refresh();
    }, [threadId, refresh]),
  });
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  // Sprint B4b — voice recording state + Audio.Recording handle.
  const [recording, setRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const recRef = useRef<Audio.Recording | null>(null);
  const recStartRef = useRef<number>(0);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const lastSeenLenRef = useRef(0);

  // Sprint B4a — image attach via the OS picker. We re-use the existing
  // image-picker permission flow from the inspector media uploader; no
  // second uploader universe (per B4a scope guard). pdf/file uploads
  // from mobile are intentionally NOT in B4a — they need a separate
  // DocumentPicker prompt and the Expo mobile journey today is overwhelmingly
  // photo-first. PDFs land via the web surface.
  const pickAndUploadImage = useCallback(async () => {
    if (!threadId || uploading) return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(i18n.t('chat.dostup_k_galeree'), i18n.t('chat.razreshite_dostup_k_foto_chtoby_prikreplyat_izobra'));
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.85,
        allowsMultipleSelection: false,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      const uri = asset.uri;
      const filename = asset.fileName || `image-${Date.now()}.jpg`;
      // Mobile asset.mimeType is unreliable on Android — sniff from extension.
      let mime = asset.mimeType || '';
      if (!mime || mime === 'application/octet-stream') {
        const ext = (filename.split('.').pop() || '').toLowerCase();
        mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'heic' ? 'image/heic' : 'image/jpeg';
      }
      if (!ATTACH_ALLOWED_IMAGE_MIMES.includes(mime)) {
        Alert.alert(i18n.t('chat.nepodderzhivaemyj_format'), i18n.t('chat.mime_nelzya_otpravit_ispolzujte_jpeg_png_webp_heic'));
        return;
      }
      // Pre-flight size check — saves a round-trip on obvious oversizes.
      try {
        const info = await FileSystem.getInfoAsync(uri, { size: true } as any);
        const size = (info as any).size;
        if (typeof size === 'number' && size > ATTACH_MAX_BYTES) {
          Alert.alert(i18n.t('chat.fajl_slishkom_bolshoj'), i18n.t('chat.limit_8_mb_vash_fajl_formatbytes_size'));
          return;
        }
      } catch { /* size sniff is best-effort */ }

      setUploading(true);
      const form = new FormData();
      // React Native form-data needs the URI-shaped blob descriptor.
      form.append('file', { uri, name: filename, type: mime } as any);
      await api.post(`/chat/v1/threads/${encodeURIComponent(threadId)}/attachments`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      await refresh();
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 413) Alert.alert(i18n.t('chat.fajl_slishkom_bolshoj'), i18n.t('chat.limit_dlya_foto_8_mb'));
      else if (status === 415) Alert.alert(i18n.t('chat.nepodderzhivaemyj_format'), i18n.t('chat.ispolzujte_jpeg_png_webp_heic'));
      else if (status === 403) Alert.alert(i18n.t('chat.net_dostupa'), i18n.t('chat.vy_ne_uchastnik_etogo_chata'));
      else Alert.alert(i18n.t('chat.oshibka_zagruzki'), String(e?.message || 'unknown'));
    } finally {
      setUploading(false);
    }
  }, [threadId, uploading, refresh]);

  // Sprint B4b — voice recording on mobile. expo-av (Audio.Recording).
  // Tap mic → start; tap again → stop & upload. Auto-stops at 120s.
  // Tap-start/tap-stop chosen over hold-to-record so accidental palm
  // releases don't cancel a 90-second message. (Hold-to-record is fine
  // for ≤15s patterns but feels brittle for longer voice notes.)
  const startVoice = useCallback(async () => {
    if (recording || !threadId || uploading) return;
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(i18n.t('chat.mikrofon'), i18n.t('chat.razreshite_dostup_k_mikrofonu'));
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recRef.current = rec;
      recStartRef.current = Date.now();
      setRecElapsed(0);
      setRecording(true);
      recTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - recStartRef.current;
        setRecElapsed(elapsed);
        // Auto-stop at the 120s ceiling — matches backend cap exactly.
        if (elapsed >= 120 * 1000) {
          void stopVoice();
        }
      }, 200);
    } catch (e: any) {
      Alert.alert(i18n.t('chat.zapis'), String(e?.message || i18n.t('chat.ne_udalos_nachat_zapis')));
      setRecording(false);
    }
  }, [recording, threadId, uploading]);

  const stopVoice = useCallback(async () => {
    const rec = recRef.current;
    if (!rec) return;
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    setRecording(false);
    let uri: string | null = null;
    let durationMs = Date.now() - recStartRef.current;
    try {
      await rec.stopAndUnloadAsync();
      uri = rec.getURI();
      const status = await rec.getStatusAsync();
      if (typeof (status as any).durationMillis === 'number') {
        durationMs = (status as any).durationMillis;
      }
    } catch {
      // Recorder cleanup is best-effort; the URI may still be usable.
    }
    recRef.current = null;
    if (!uri) return;
    if (durationMs < 200) {
      Alert.alert(i18n.t('chat.slishkom_korotko'), i18n.t('chat.zapis_dolzhna_byt_ne_koroche_0_2_s'));
      return;
    }
    if (durationMs > 120 * 1000) {
      Alert.alert(i18n.t('chat.slishkom_dlinno'), i18n.t('chat.maksimum_120_sekund'));
      return;
    }
    setUploading(true);
    try {
      // expo-av writes m4a on iOS, m4a/3gp on Android. Backend accepts
      // audio/m4a + audio/mp4 — same ftyp container family.
      const form = new FormData();
      form.append('file', { uri, name: `voice-${Date.now()}.m4a`, type: 'audio/m4a' } as any);
      form.append('duration_ms', String(Math.round(durationMs)));
      await api.post(`/chat/v1/threads/${encodeURIComponent(threadId!)}/voice`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      await refresh();
    } catch (e: any) {
      const s = e?.response?.status;
      if (s === 413) Alert.alert(i18n.t('chat.slishkom_bolshoj_fajl'), i18n.t('chat.maksimum_12_mb'));
      else if (s === 415) Alert.alert(i18n.t('chat.format_ne_podderzhivaetsya'), i18n.t('chat.zapishite_v_standartnom_formate'));
      else if (s === 422) Alert.alert(i18n.t('chat.dlitelnost'), i18n.t('chat.dlitelnost_vne_dopustimogo_diapazona'));
      else if (s === 403) Alert.alert(i18n.t('chat.dostup'), i18n.t('chat.net_dostupa_k_chatu'));
      else Alert.alert(i18n.t('chat.oshibka'), String(e?.message || i18n.t('chat.ne_udalos_otpravit')));
    } finally {
      setUploading(false);
    }
  }, [threadId, refresh]);

  useEffect(() => () => {
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    if (recRef.current) {
      // Best-effort cleanup if screen unmounts mid-recording.
      recRef.current.stopAndUnloadAsync().catch(() => undefined);
    }
  }, []);

  // Mark-read on initial load and whenever the unread count goes from >0 → still >0
  // (i.e. new messages arrived while screen is focused).
  useEffect(() => {
    if (!thread || thread.unreadByMe === 0) return;
    void markRead();
  }, [thread?.unreadByMe, markRead, thread]);

  // Auto-scroll to bottom when new messages appear.
  useEffect(() => {
    if (messages.length > lastSeenLenRef.current && listRef.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
    lastSeenLenRef.current = messages.length;
  }, [messages.length]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const ok = await send(text);
    if (ok) setDraft('');
  }, [draft, sending, send]);

  // Sprint B4c — toggle a reaction on a specific message. Tap on existing
  // reaction → DELETE if `reactedByMe`, POST otherwise. The handler is
  // hoisted here (not inlined per-bubble) so the closure doesn't capture
  // a stale `messages` array.
  const toggleReaction = useCallback(async (messageId: string, emoji: ChatReactionEmoji, reactedByMe: boolean) => {
    try {
      if (reactedByMe) {
        await api.delete(`/chat/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`);
      } else {
        await api.post(`/chat/v1/messages/${encodeURIComponent(messageId)}/reactions`, { emoji });
      }
      // Refresh once — reactions DON'T bump unread/preview, so this is a
      // cheap re-projection. No optimistic update: the canonical
      // projection is what we render, period.
      await refresh();
    } catch (e: any) {
      const s = e?.response?.status;
      if (s === 422) Alert.alert(i18n.t('chat.emodzi'), i18n.t('chat.eta_reakciya_ne_podderzhivaetsya'));
      else if (s === 403) Alert.alert(i18n.t('chat.net_dostupa'), i18n.t('chat.vy_ne_uchastnik_etogo_chata'));
      // 404 (message vanished) is silent — user will see refreshed list.
    }
  }, [refresh]);

  const renderItem = useCallback(({ item }: { item: ChatMessage }) => {
    const isSystem = item.type === 'system';
    if (isSystem) {
      return (
        <View style={styles.systemRow} testID={`message-${item.id}`}>
          <Text style={[styles.systemText, { color: colors.textMuted }]}>{item.body}</Text>
        </View>
      );
    }
    const mine = item.isMine;
    const senderLabel = mine
      ? null
      : item.senderDisplayName || (item.senderKind === 'admin' ? i18n.t('chat.podderzhka') : item.senderKind === 'provider' ? i18n.t('chat.provajder') : '');
    return (
      <View
        style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowOther]}
        testID={`message-${item.id}`}
      >
        <View
          style={[
            styles.bubble,
            mine
              ? { backgroundColor: colors.brand, borderBottomRightRadius: 4 }
              : { backgroundColor: colors.card, borderBottomLeftRadius: 4 },
          ]}
        >
          {!mine && senderLabel ? (
            <Text style={[styles.senderName, { color: colors.brand }]}>{senderLabel}</Text>
          ) : null}
          {/* Sprint B4a — attachment payload renders before the body text.
              Image → tappable thumbnail. File/PDF → tappable row that opens
              the URL (the server stamps inline/attachment Content-Disposition
              so the OS picks the right handler). */}
          {item.type === 'attachment' && item.attachment ? (
            <AttachmentBubble att={item.attachment} mine={mine} testIDPrefix={`message-${item.id}-att`} />
          ) : null}
          {/* Sprint B4b — voice payload rendering. Play/pause via expo-av,
              duration shown next to the control. No waveform per spec. */}
          {item.type === 'voice' && item.voice ? (
            <VoiceBubble voice={item.voice} mine={mine} testIDPrefix={`message-${item.id}-voice`} />
          ) : null}
          {item.body ? (
            <Text style={[styles.bubbleText, { color: mine ? '#fff' : colors.text }]}>{item.body}</Text>
          ) : null}
          <Text style={[styles.bubbleTime, { color: mine ? '#ffffffaa' : colors.textMuted }]}>
            {formatTime(item.createdAt)}
            {mine && item.readAt ? '  ✓✓' : mine ? '  ✓' : ''}
          </Text>
        </View>
        {/* Sprint B4c — reactions row sits OUTSIDE the bubble: spec says
            "decoration, not message". Visual hierarchy must reflect that. */}
        <ReactionRow
          messageId={item.id}
          mine={mine}
          reactions={item.reactions || []}
          onToggle={toggleReaction}
        />
      </View>
    );
  }, [colors, toggleReaction]);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]} testID="chat-screen">
      <SafeAreaView edges={['top']} style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="chat-back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {threadHeaderTitle(thread)}
          </Text>
          {thread?.kind === 'support' ? (
            <Text style={[styles.headerSub, { color: colors.textMuted }]}>{t('chat.obychno_otvechayut_za_5_min')}</Text>
          ) : null}
        </View>
        <View style={styles.iconBtn} />
      </SafeAreaView>

      {loading && messages.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.brand} />
        </View>
      ) : error === 'forbidden' ? (
        <View style={styles.center} testID="chat-forbidden">
          <Ionicons name="lock-closed" size={40} color={colors.textMuted} />
          <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>{t('chat.net_dostupa_k_chatu_2')}</Text>
        </View>
      ) : error === 'not_found' ? (
        <View style={styles.center} testID="chat-not-found">
          <Ionicons name="help-circle" size={40} color={colors.textMuted} />
          <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>{t('chat.chat_ne_najden')}</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.center} testID="chat-empty">
              <Ionicons name="chatbubble-ellipses-outline" size={40} color={colors.textMuted} />
              <Text style={[styles.emptyTitle, { color: colors.textSecondary }]}>{t('chat.napishite_pervoe_soobschenie')}</Text>
            </View>
          }
        />
      )}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <View style={[styles.inputBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
          <TouchableOpacity
            onPress={pickAndUploadImage}
            disabled={uploading || sending || recording}
            style={[styles.attachBtn, { backgroundColor: colors.background, borderColor: colors.border }]}
            testID="chat-attach"
            accessibilityLabel={t('chat.prikrepit_foto')}

          >
            {uploading ? (
              <ActivityIndicator size="small" color={colors.brand} />
            ) : (
              <Ionicons name="attach" size={20} color={colors.brand} />
            )}
          </TouchableOpacity>
          {/* Sprint B4b — tap-start/tap-stop mic. Auto-stops at 120s. */}
          <TouchableOpacity
            onPress={recording ? stopVoice : startVoice}
            disabled={uploading || sending}
            style={[
              styles.attachBtn,
              {
                backgroundColor: recording ? '#ef4444' : colors.background,
                borderColor: recording ? '#ef4444' : colors.border,
              },
            ]}
            testID="chat-mic"
            accessibilityLabel={recording ? t('chat.stop_math_round_recelapsed_1000_s') : t('chat.zapisat_golosovoe')}
          >
            <Ionicons
              name={recording ? 'stop' : 'mic'}
              size={20}
              color={recording ? '#fff' : colors.brand}
            />
          </TouchableOpacity>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('chat.soobschenie')}

            placeholderTextColor={colors.textMuted}
            style={[styles.input, { color: colors.text, backgroundColor: colors.background }]}
            multiline
            maxLength={4000}
            testID="chat-input"
            editable={!sending && !uploading}
          />
          <TouchableOpacity
            onPress={handleSend}
            disabled={!draft.trim() || sending || uploading}
            style={[styles.sendBtn, { backgroundColor: draft.trim() && !sending && !uploading ? colors.brand : colors.border }]}
            testID="chat-send"
          >
            {sending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Ionicons name="send" size={18} color="#fff" />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sprint B4a — Attachment rendering helpers
// ─────────────────────────────────────────────────────────────────

interface AttachmentBubbleProps {
  att: ChatAttachment;
  mine: boolean;
  testIDPrefix: string;
}

/**
 * Render a single attachment inside a chat bubble.
 *
 * Image attachments need the JWT for byte fetches. React Native's
 * `<Image source={{ uri, headers }}>` accepts an Authorization header
 * out of the box; that's the simplest path that avoids a second
 * download → blob URI flow on mobile.
 *
 * PDFs and generic files render as a tappable row that opens the URL
 * in the OS — for `application/pdf` iOS/Android already have a system
 * viewer; for generic files the OS prompts to download/share.
 */
function AttachmentBubble({ att, mine, testIDPrefix }: AttachmentBubbleProps) {
  const { colors } = useThemeContext();
  const [token, setToken] = useState<string>('');
  useEffect(() => {
    // Pull the JWT once; the Image header is static after that.
    let alive = true;
    AsyncStorageGetToken().then((t) => { if (alive) setToken(t); });
    return () => { alive = false; };
  }, []);

  const fullUrl = `${process.env.EXPO_PUBLIC_BACKEND_URL || ''}${att.url}`;

  const openExternal = async () => {
    try {
      // The server stamps inline disposition for PDFs (the OS opens the
      // viewer); generic files become a download prompt. We can't pass
      // headers to the OS opener, so the URL must include the token —
      // not ideal, but the alternative is downloading first which we
      // also did NOT include in B4a.
      const urlWithAuth = `${fullUrl}${fullUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
      const can = await Linking.canOpenURL(urlWithAuth);
      if (can) await Linking.openURL(urlWithAuth);
      else Alert.alert(i18n.t('chat.ne_udalos_otkryt'), att.filename);
    } catch (e: any) {
      Alert.alert(i18n.t('chat.oshibka'), String(e?.message || 'open failed'));
    }
  };

  if (att.kind === 'image') {
    if (!token) {
      return (
        <View style={[styles.attachImagePlaceholder, { backgroundColor: mine ? '#ffffff33' : colors.border }]} testID={`${testIDPrefix}-loading`}>
          <ActivityIndicator color={mine ? '#fff' : colors.brand} />
        </View>
      );
    }
    return (
      <TouchableOpacity onPress={openExternal} testID={`${testIDPrefix}-image`} activeOpacity={0.85}>
        <Image
          source={{ uri: fullUrl, headers: { Authorization: `Bearer ${token}` } }}
          style={styles.attachImage}
          resizeMode="cover"
        />
      </TouchableOpacity>
    );
  }

  // pdf / file → row
  const iconName = att.kind === 'pdf' ? 'document-text' : 'document-attach';
  return (
    <TouchableOpacity
      onPress={openExternal}
      testID={`${testIDPrefix}-${att.kind}`}
      style={[
        styles.attachFileRow,
        { backgroundColor: mine ? '#ffffff22' : colors.background, borderColor: mine ? '#ffffff44' : colors.border },
      ]}
      activeOpacity={0.85}
    >
      <Ionicons name={iconName as any} size={22} color={mine ? '#fff' : colors.brand} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          style={[styles.attachFilename, { color: mine ? '#fff' : colors.text }]}
          numberOfLines={1}
        >
          {att.filename}
        </Text>
        <Text style={[styles.attachMeta, { color: mine ? '#ffffffaa' : colors.textMuted }]}>
          {att.kind.toUpperCase()} · {formatBytes(att.sizeBytes)}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// Small isolated helper so AsyncStorage import stays bounded to this
// concern (the rest of the file uses axios interceptors implicitly).
async function AsyncStorageGetToken(): Promise<string> {
  try {
    // Lazily resolve to avoid a top-level import cycle.
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    return (await AsyncStorage.getItem('auth_token')) || '';
  } catch {
    return '';
  }
}


// ─────────────────────────────────────────────────────────────────
// Sprint B4c — Reactions row (mobile)
// ─────────────────────────────────────────────────────────────────

interface ReactionRowProps {
  messageId: string;
  mine: boolean;
  reactions: readonly ChatReaction[];
  onToggle: (mid: string, emoji: ChatReactionEmoji, reactedByMe: boolean) => void;
}

/**
 * Compact reactions UI under each bubble.
 *
 * Doctrine, per B4c spec line 7:
 *   - tap on existing reaction = toggle (no long-press, no floating tray)
 *   - tap "+" = open a single compact row with the 6 whitelisted emojis
 *   - no animated trays, no gesture engine, no haptics tray
 *
 * The picker is local state on the bubble — opening it doesn't reorder
 * the list or trigger a re-render of siblings. Closing happens on
 * pick, on second tap of "+", or on screen blur (handled implicitly
 * via unmount).
 */
function ReactionRow({ messageId, mine, reactions, onToggle }: ReactionRowProps) {
  const { colors } = useThemeContext();
  const [pickerOpen, setPickerOpen] = useState(false);
  // When the picker is open we don't auto-close on pick — many users want
  // to add multiple. They tap "+" again (or anywhere off-row) to dismiss.
  // This is the only ergonomic concession to multi-react.
  return (
    <View style={[styles.reactionRow, mine ? { justifyContent: 'flex-end' } : { justifyContent: 'flex-start' }]}>
      {reactions.map((r) => (
        <TouchableOpacity
          key={r.emoji}
          onPress={() => onToggle(messageId, r.emoji as ChatReactionEmoji, r.reactedByMe)}
          activeOpacity={0.7}
          testID={`message-${messageId}-reaction-${r.emoji}`}
          style={[
            styles.reactionPill,
            r.reactedByMe
              ? { backgroundColor: colors.brand + '22', borderColor: colors.brand }
              : { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={styles.reactionEmoji}>{r.emoji}</Text>
          {r.count > 1 && (
            <Text style={[styles.reactionCount, { color: r.reactedByMe ? colors.brand : colors.textMuted }]}>
              {r.count}
            </Text>
          )}
        </TouchableOpacity>
      ))}
      <TouchableOpacity
        onPress={() => setPickerOpen((x) => !x)}
        activeOpacity={0.7}
        testID={`message-${messageId}-reaction-add`}
        style={[styles.reactionAddBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <Ionicons name={pickerOpen ? 'close' : 'add'} size={14} color={colors.textMuted} />
      </TouchableOpacity>
      {pickerOpen && (
        <View
          style={[styles.reactionPicker, { backgroundColor: colors.card, borderColor: colors.border }]}
          testID={`message-${messageId}-reaction-picker`}
        >
          {REACTION_EMOJIS.map((emoji) => {
            const existing = reactions.find((r) => r.emoji === emoji);
            const reactedByMe = !!existing?.reactedByMe;
            return (
              <TouchableOpacity
                key={emoji}
                onPress={() => onToggle(messageId, emoji, reactedByMe)}
                activeOpacity={0.7}
                testID={`message-${messageId}-reaction-pick-${emoji}`}
                style={styles.reactionPickerCell}
              >
                <Text style={styles.reactionPickerEmoji}>{emoji}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1 },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  headerSub: { fontSize: 11, marginTop: 2 },
  list: { padding: 12, gap: 6, flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  systemRow: { alignItems: 'center', paddingVertical: 6 },
  systemText: { fontSize: 11, fontStyle: 'italic', textAlign: 'center' },
  bubbleRow: { flexDirection: 'row', marginVertical: 2 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowOther: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 16,
  },
  senderName: { fontSize: 11, fontWeight: '700', marginBottom: 2 },
  bubbleText: { fontSize: 15, lineHeight: 20 },
  bubbleTime: { fontSize: 10, marginTop: 4, textAlign: 'right' },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 22,
    fontSize: 15,
    maxHeight: 120,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
  },
  attachBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },
  attachImage: {
    width: 220, height: 220,
    borderRadius: 10,
    marginBottom: 4,
  },
  attachImagePlaceholder: {
    width: 220, height: 160,
    borderRadius: 10,
    marginBottom: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  attachFileRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    minWidth: 200,
    maxWidth: 280,
    marginBottom: 4,
  },
  attachFilename: { fontSize: 13, fontWeight: '600' },
  attachMeta: { fontSize: 11, marginTop: 2 },
  voiceRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    minWidth: 200,
    maxWidth: 260,
    marginBottom: 4,
  },
  voicePlayCircle: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  voiceTrack: {
    height: 4, borderRadius: 2, overflow: 'hidden',
  },
  voiceProgress: {
    height: '100%',
  },
  voiceDuration: {
    fontSize: 11, marginTop: 4,
  },
  // Sprint B4c — reactions row
  reactionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  reactionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
  },
  reactionEmoji: { fontSize: 14 },
  reactionCount: { fontSize: 11, fontWeight: '600' },
  reactionAddBtn: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },
  reactionPicker: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    marginLeft: 4,
  },
  reactionPickerCell: {
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  reactionPickerEmoji: { fontSize: 22 },
});


// ─────────────────────────────────────────────────────────────────
// Sprint B4b — Voice playback (mobile)
// ─────────────────────────────────────────────────────────────────

interface VoiceBubbleProps {
  voice: ChatVoice;
  mine: boolean;
  testIDPrefix: string;
}

/**
 * Voice bubble for mobile chat.
 *
 * Per B4b spec: play / pause + duration. No waveform.
 *
 * Like image attachments, audio bytes need an Authorization header that
 * the OS audio player can't carry — so we ship the URL with `?token=`
 * (server accepts both transports). `expo-av`'s Audio.Sound loads via
 * URI; the player buffers then plays.
 */
function VoiceBubble({ voice, mine, testIDPrefix }: VoiceBubbleProps) {
  const { colors } = useThemeContext();
  const [token, setToken] = useState<string>('');
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    AsyncStorageGetToken().then((t) => { if (alive) setToken(t); });
    return () => { alive = false; };
  }, []);

  useEffect(() => () => {
    // Tear down the audio resource when the bubble unmounts so a long
    // FlatList of voice messages doesn't leak players.
    sound?.unloadAsync().catch(() => undefined);
  }, [sound]);

  const fullUrl = `${process.env.EXPO_PUBLIC_BACKEND_URL || ''}${voice.audioUrl}?token=${encodeURIComponent(token)}`;

  const toggle = async () => {
    if (!token) return;  // token still resolving — block tap, no error
    if (playing && sound) {
      await sound.pauseAsync();
      setPlaying(false);
      return;
    }
    if (sound) {
      await sound.playAsync();
      setPlaying(true);
      return;
    }
    setLoading(true);
    try {
      const { sound: s } = await Audio.Sound.createAsync(
        { uri: fullUrl },
        { shouldPlay: true },
        (status: any) => {
          if (!status?.isLoaded) return;
          setPosition(status.positionMillis ?? 0);
          if (status.didJustFinish) {
            setPlaying(false);
            setPosition(0);
          }
        },
      );
      setSound(s);
      setPlaying(true);
    } catch (e: any) {
      Alert.alert(i18n.t('chat.vosproizvedenie'), i18n.t('chat.ne_udalos_zagruzit_golosovoe'));
    } finally {
      setLoading(false);
    }
  };

  const totalSec = Math.max(0, Math.round(voice.durationMs / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const durationLabel = `${mins}:${secs.toString().padStart(2, '0')}`;
  const progress = voice.durationMs > 0 ? Math.min(1, position / voice.durationMs) : 0;

  return (
    <TouchableOpacity
      onPress={toggle}
      activeOpacity={0.85}
      testID={testIDPrefix}
      style={[
        styles.voiceRow,
        {
          backgroundColor: mine ? '#ffffff22' : colors.background,
          borderColor: mine ? '#ffffff44' : colors.border,
        },
      ]}
    >
      <View style={[styles.voicePlayCircle, { backgroundColor: mine ? '#fff' : colors.brand }]}>
        {loading ? (
          <ActivityIndicator size="small" color={mine ? colors.brand : '#fff'} />
        ) : (
          <Ionicons
            name={playing ? 'pause' : 'play'}
            size={16}
            color={mine ? colors.brand : '#fff'}
          />
        )}
      </View>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <View style={[styles.voiceTrack, { backgroundColor: mine ? '#ffffff44' : colors.border }]}>
          <View
            style={[
              styles.voiceProgress,
              { width: `${progress * 100}%`, backgroundColor: mine ? '#fff' : colors.brand },
            ]}
          />
        </View>
        <Text style={[styles.voiceDuration, { color: mine ? '#ffffffaa' : colors.textMuted }]}>
          🎤 {durationLabel}
        </Text>
      </View>
    </TouchableOpacity>
  );
}


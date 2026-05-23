/**
 * Sprint 4 — In-App Service Chat (polling-based).
 *
 * Polling каждые 6 секунд через `since=last-message-timestamp`.
 * Anti-bypass: серверу всё равно что мы шлём, он молча скроет
 * запрещённое от получателя (мы видим warning от scan-результата).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ActivityIndicator, Alert,
} from 'react-native';
import i18n from '../../../src/i18n';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../../src/context/ThemeContext';
import { api } from '../../../src/services/api';
import { TimelineRail, type TimelineEvent } from '../../../src/components/TimelineRail';

const POLL_MS = 6000;

const QUICK_PROVIDER = [
  { action: 'arriving', label: i18n.t('chat.uzhe_edu'), icon: 'car' as const },
  { action: 'work_started', label: i18n.t('chat.rabota_nachalas'), icon: 'construct' as const },
  { action: 'extra_parts', label: i18n.t('chat.nuzhny_zapchasti'), icon: 'cube' as const },
  { action: 'completed', label: i18n.t('chat.rabota_vypolnena'), icon: 'checkmark-done' as const },
];
const QUICK_CUSTOMER = [
  { action: 'confirm_completed', label: i18n.t('chat.podtverdit_zavershenie'), icon: 'checkmark-circle' as const },
];

export default function ServiceChatScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useThemeContext();
  const params = useLocalSearchParams<{ chatId: string }>();
  const [chat, setChat] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const lastTsRef = useRef<string | null>(null);
  const listRef = useRef<FlatList>(null);
  const myIdRef = useRef<string | null>(null);

  const loadChat = useCallback(async () => {
    try {
      const r = await api.get(`/service-chats/${params.chatId}`);
      setChat(r.data?.chat);
    } catch (e: any) {
      Alert.alert(i18n.t('chat.oshibka'), e?.response?.data?.message || e?.message);
    }
  }, [params.chatId]);

  const loadTimeline = useCallback(async (requestId: string) => {
    try {
      const r = await api.get(`/service-requests/${requestId}/timeline`);
      setTimeline(r.data?.events ?? []);
      setTimelineError(null);
    } catch (e: any) {
      // silent — rail just won't render. surface only network-level errors.
      const msg = e?.response?.data?.detail || e?.message;
      if (msg && msg !== 'Forbidden') setTimelineError(msg);
    }
  }, []);

  const pollMessages = useCallback(async () => {
    try {
      const qs = lastTsRef.current ? `?since=${encodeURIComponent(lastTsRef.current)}&limit=100` : '?limit=100';
      const r = await api.get(`/service-chats/${params.chatId}/messages${qs}`);
      const incoming: any[] = r.data?.messages || [];
      if (incoming.length) {
        setMessages(prev => {
          const ids = new Set(prev.map(m => m.id));
          const fresh = incoming.filter(m => !ids.has(m.id));
          if (!fresh.length) return prev;
          const merged = [...prev, ...fresh];
          lastTsRef.current = merged[merged.length - 1].createdAt;
          return merged;
        });
        setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
      }
    } catch {
      // молча — polling не должен ронять UI
    } finally {
      if (loading) setLoading(false);
    }
  }, [params.chatId, loading]);

  // Identify own user id from /auth/me to color bubbles correctly
  const loadMe = useCallback(async () => {
    try {
      const r = await api.get('/auth/me');
      myIdRef.current = r.data?.user?.id || r.data?.id || null;
    } catch {}
  }, []);

  useEffect(() => {
    loadMe();
    loadChat();
    pollMessages();
    const id = setInterval(pollMessages, POLL_MS);
    return () => clearInterval(id);
  }, [loadChat, pollMessages, loadMe]);

  // Fetch timeline once chat resolved; refresh on lifecycle changes (status, updatedAt).
  useEffect(() => {
    if (chat?.requestId) loadTimeline(chat.requestId);
  }, [chat?.requestId, chat?.status, chat?.updatedAt, loadTimeline]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText('');
    try {
      const r = await api.post(`/service-chats/${params.chatId}/messages`, { type: 'text', body });
      const severity = r.data?.scan?.severity;
      if (severity === 'shadow_hide') {
        Alert.alert(
          i18n.t('chat.soobschenie_skryto'),
          i18n.t('chat.platforma_zaschischaet_sdelku_obmen_kontaktami_vne'),
        );
      } else if (severity === 'warn') {
        Alert.alert(i18n.t('chat.preduprezhdenie'), i18n.t('chat.vneshnie_ssylki_mogut_navredit_sdelke_ispolzujte_f'));
      }
      // Force re-poll to fetch our just-sent message
      await pollMessages();
    } catch (e: any) {
      setText(body);
      Alert.alert(i18n.t('chat.oshibka'), e?.response?.data?.message || e?.message);
    } finally {
      setSending(false);
    }
  };

  const quickAction = async (action: string) => {
    try {
      await api.post(`/service-chats/${params.chatId}/quick-action`, { action });
      await pollMessages();
      await loadChat();
      if (chat?.requestId) await loadTimeline(chat.requestId);
    } catch (e: any) {
      Alert.alert(i18n.t('chat.oshibka'), e?.response?.data?.message || e?.message);
    }
  };

  const isMine = (msg: any) => msg.senderId && myIdRef.current && msg.senderId === myIdRef.current;
  const myRole = chat && myIdRef.current ? (chat.customerId === myIdRef.current ? 'customer' : 'provider') : null;
  const quickButtons = myRole === 'provider' ? QUICK_PROVIDER : myRole === 'customer' ? QUICK_CUSTOMER : [];

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background, justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity testID="chat-back" onPress={() => router.back()} style={[styles.iconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginHorizontal: 12 }}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{t('chat.chat_po_zayavke')}</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={1}>
            {chat?.status === 'active' ? t('chat.zaschita_platformy_aktivna') : chat?.status === 'frozen' ? t('chat.zamorozhen_moderaciej') : t('chat.zakryt')}
          </Text>
        </View>
        {chat?.requestId && (
          <TouchableOpacity testID="chat-open-request" onPress={() => router.push(`/service-marketplace/${chat.requestId}` as any)} style={[styles.iconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Ionicons name="document-text" size={18} color={colors.text} />
          </TouchableOpacity>
        )}
      </View>

      {chat?.requestId && timeline.length > 0 && (
        <TimelineRail events={timeline} error={timelineError} compact />
      )}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
        style={{ flex: 1 }}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={item => item.id}
          contentContainerStyle={{ padding: 12 }}
          renderItem={({ item }) => <MessageBubble msg={item} mine={isMine(item)} colors={colors} />}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        />

        {quickButtons.length > 0 && chat?.status === 'active' && (
          <View style={[styles.quickRow, { borderTopColor: colors.border }]}>
            {quickButtons.map(q => (
              <TouchableOpacity
                key={q.action}
                testID={`quick-${q.action}`}
                onPress={() => quickAction(q.action)}
                style={[styles.quickBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <Ionicons name={q.icon} size={14} color={colors.primary} />
                <Text style={[styles.quickText, { color: colors.text }]}>{q.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={[styles.inputRow, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
          <TextInput
            testID="chat-input"
            value={text}
            onChangeText={setText}
            placeholder={t('chat.soobschenie_2')}

            placeholderTextColor={colors.textSecondary}
            multiline
            style={[styles.input, { color: colors.text, backgroundColor: colors.background }]}
            editable={chat?.status === 'active' && !sending}
          />
          <TouchableOpacity
            testID="chat-send"
            onPress={send}
            disabled={sending || !text.trim() || chat?.status !== 'active'}
            style={[styles.sendBtn, { backgroundColor: colors.primary, opacity: (sending || !text.trim() || chat?.status !== 'active') ? 0.4 : 1 }]}
          >
            <Ionicons name="send" size={18} color="#000" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MessageBubble({ msg, mine, colors }: any) {
  if (msg.senderRole === 'system') {
    return (
      <View style={[styles.systemMsg, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Ionicons name="information-circle-outline" size={14} color={colors.textSecondary} />
        <Text style={[styles.systemText, { color: colors.textSecondary }]}>{msg.body}</Text>
      </View>
    );
  }
  if (msg.senderRole === 'admin') {
    return (
      <View style={[styles.adminMsg, { backgroundColor: '#ef444422', borderColor: '#ef4444' }]}>
        <Ionicons name="shield-checkmark" size={14} color="#ef4444" />
        <Text style={[styles.adminText, { color: colors.text }]}>{msg.body}</Text>
      </View>
    );
  }
  if (msg.type === 'status_change') {
    return (
      <View style={[styles.statusMsg, { backgroundColor: colors.primary + '22', borderColor: colors.primary }]}>
        <Ionicons name="flash" size={14} color={colors.primary} />
        <Text style={[styles.statusText, { color: colors.primary }]}>{msg.body}</Text>
      </View>
    );
  }
  // Skipped/hidden message
  if (msg.body === null && msg.hiddenReason) {
    return (
      <View style={[styles.hiddenMsg, { borderColor: colors.border }]}>
        <Ionicons name="eye-off" size={12} color={colors.textSecondary} />
        <Text style={[styles.hiddenText, { color: colors.textSecondary }]}>{msg.hiddenReason}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.msgRow, mine ? styles.msgRight : styles.msgLeft]}>
      <View style={[styles.bubble, { backgroundColor: mine ? colors.primary : colors.card, borderColor: colors.border }]}>
        <Text style={{ color: mine ? '#000' : colors.text, fontSize: 14 }}>{msg.body}</Text>
        {msg.bypassSeverity && msg.bypassSeverity !== 'clean' && mine && (
          <Text style={{ color: '#f59e0b', fontSize: 10, marginTop: 4, fontStyle: 'italic' }}>
            {msg.bypassSeverity === 'shadow_hide' ? t('chat.skryto_moderaciej') : '⚠ ' + (msg.flags || []).join(', ')}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 10 },
  iconBtn: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  title: { fontSize: 15, fontWeight: '700' },
  subtitle: { fontSize: 11, marginTop: 2 },
  msgRow: { marginVertical: 4, flexDirection: 'row' },
  msgLeft: { justifyContent: 'flex-start' },
  msgRight: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '78%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, borderWidth: 1 },
  systemMsg: { flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 6, padding: 8, borderRadius: 8, borderWidth: 1, alignSelf: 'center', maxWidth: '90%' },
  systemText: { fontSize: 11, flex: 1, lineHeight: 14 },
  adminMsg: { flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 6, padding: 10, borderRadius: 8, borderWidth: 1 },
  adminText: { fontSize: 13, flex: 1 },
  statusMsg: { flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 6, padding: 10, borderRadius: 10, borderWidth: 1, alignSelf: 'center' },
  statusText: { fontSize: 12, fontWeight: '700' },
  hiddenMsg: { flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 4, padding: 8, borderRadius: 8, borderWidth: 1, borderStyle: 'dashed', alignSelf: 'center', maxWidth: '85%' },
  hiddenText: { fontSize: 11, fontStyle: 'italic' },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 10, borderTopWidth: 1 },
  quickBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  quickText: { fontSize: 12, fontWeight: '600' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1 },
  input: { flex: 1, minHeight: 40, maxHeight: 100, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, fontSize: 14 },
  sendBtn: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});

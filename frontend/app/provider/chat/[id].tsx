/**
 * Provider Chat Thread — Sprint 34 D9 (provider-side chat).
 *
 * Reuses /api/chat/threads/{id}/messages (backend now allows provider role
 * with matching providerSlug). Reply uses /api/provider/chat/threads/{id}/reply.
 * Polls every 4s. Same UI as customer chat, but mine = provider (right-side).
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../../src/context/ThemeContext';
import api from '../../../src/services/api';
import i18n from '../../../src/i18n';

interface Message {
  id: string;
  threadId: string;
  senderType: 'user' | 'provider' | 'admin';
  senderId: string;
  text: string;
  createdAt: string;
  readAt?: string | null;
}

interface Thread {
  id: string;
  type: string;
  title: string;
  participantUserId: string;
  bookingId?: string | null;
}

const POLL_MS = 4000;

function fmtTime(ts: string) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export default function ProviderChatScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useThemeContext();

  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<FlatList>(null);
  const pollRef = useRef<any>(null);

  const fetchMessages = useCallback(
    async (initial = false) => {
      if (!id) return;
      try {
        const res = await api.get<{ thread: Thread; messages: Message[] }>(
          `/api/chat/threads/${id}/messages`
        );
        setThread(res.data.thread);
        setMessages(res.data.messages || []);
        setError(null);
        if (initial) {
          api.post(`/api/chat/threads/${id}/read`).catch(() => {});
        }
      } catch (e: any) {
        const status = e?.response?.status;
        if (status === 404) setError(i18n.t('chat.chat_ne_najden'));
        else if (status === 403) setError(i18n.t('provider.net_dostupa_k_etomu_chatu'));
        else if (status === 401) setError(i18n.t('provider.vojdite_kak_master'));
        else setError(e?.message || i18n.t('chat.oshibka_zagruzki'));
      } finally {
        if (initial) setLoading(false);
      }
    },
    [id]
  );

  useEffect(() => {
    fetchMessages(true);
    pollRef.current = setInterval(() => fetchMessages(false), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchMessages]);

  useEffect(() => {
    if (messages.length) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const res = await api.post<{ message: Message }>(
        `/api/provider/chat/threads/${id}/reply`,
        { text: t }
      );
      setMessages((prev) => [...prev, res.data.message]);
      setText('');
    } catch (e: any) {
      setError(e?.response?.data?.message || i18n.t('provider.ne_udalos_otpravit'));
    } finally {
      setSending(false);
    }
  };

  const renderMessage = ({ item, index }: { item: Message; index: number }) => {
    const mine = item.senderType === 'provider';
    const showHeader =
      index === 0 ||
      messages[index - 1].senderType !== item.senderType ||
      new Date(item.createdAt).getTime() - new Date(messages[index - 1].createdAt).getTime() > 60000;

    return (
      <View style={{ paddingVertical: 4 }}>
        {showHeader && !mine && (
          <Text style={[styles.senderLabel, { color: colors.textMuted }]}>
            {item.senderType === 'admin' ? t('provider.podderzhka_autosearch') : t('provider.klient')}
          </Text>
        )}
        <View
          style={[
            styles.bubble,
            mine
              ? [styles.bubbleMine, { backgroundColor: colors.primary }]
              : [styles.bubbleOther, { backgroundColor: colors.card }],
          ]}
        >
          <Text style={[styles.msgText, { color: mine ? '#fff' : colors.text }]} selectable>
            {item.text}
          </Text>
          <Text
            style={[
              styles.msgTime,
              { color: mine ? 'rgba(255,255,255,0.7)' : colors.textMuted },
            ]}
          >
            {fmtTime(item.createdAt)}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]} testID="provider-chat-screen">
      <SafeAreaView edges={['top']} style={[styles.header, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="provider-chat-back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {thread?.title || (loading ? t('provider.zagruzka') : t('provider.chat_s_klientom'))}
          </Text>
          {thread?.bookingId ? (
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>
              · заказ #{thread.bookingId.slice(0, 8)}
            </Text>
          ) : null}
        </View>
        <View style={styles.iconBtn}>
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.textMuted} />
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : error && messages.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{error}</Text>
            <TouchableOpacity onPress={() => router.back()} style={[styles.retryBtn, { backgroundColor: colors.card }]}>
              <Text style={{ color: colors.primary, fontWeight: '700' }}>{t('inspector.nazad_2')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={(it) => it.id}
            contentContainerStyle={styles.list}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            ListEmptyComponent={
              <View style={styles.center}>
                <Ionicons name="chatbubble-outline" size={48} color={colors.textMuted} />
                <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                  Ожидание сообщения от клиента
                </Text>
              </View>
            }
          />
        )}

        <View style={[styles.inputBar, { backgroundColor: colors.card, borderTopColor: colors.border }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={t('provider.otvetit_klientu')}

            placeholderTextColor={colors.textMuted}
            style={[styles.input, { color: colors.text, backgroundColor: colors.background }]}
            multiline
            maxLength={4000}
            testID="provider-chat-input"
          />
          <TouchableOpacity
            testID="provider-chat-send-btn"
            onPress={send}
            disabled={!text.trim() || sending}
            style={[
              styles.sendBtn,
              { backgroundColor: text.trim() && !sending ? colors.primary : colors.border },
            ]}
          >
            {sending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Ionicons name="send" size={20} color={text.trim() ? '#fff' : colors.textMuted} />
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  iconBtn: { padding: 6, minWidth: 36, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '800' },
  subtitle: { fontSize: 11, fontWeight: '600' },
  list: { padding: 12, paddingBottom: 16 },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleMine: {
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
  },
  msgText: { fontSize: 15, lineHeight: 20 },
  msgTime: { fontSize: 10, marginTop: 4, textAlign: 'right' },
  senderLabel: { fontSize: 11, marginLeft: 6, marginTop: 4, marginBottom: 2 },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 10, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  input: {
    flex: 1, minHeight: 40, maxHeight: 120,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 20, fontSize: 15,
  },
  sendBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  emptyText: { fontSize: 14, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 24, paddingVertical: 10, borderRadius: 12, marginTop: 8 },
});

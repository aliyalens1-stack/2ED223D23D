/**
 * UX-2C — Support screen polish.
 *
 * Iteration history:
 *   • UX-1 (round 1): replaced `mailto:` fallback with real POST /api/support/tickets
 *     persisting in Mongo and returning a ticket id.
 *   • UX-2C (this iteration): replaced Alert-based confirmation with a proper
 *     inline success state (ticket id card + tracking note + open-history shortcut),
 *     added history list of past tickets with status pills (open/in_progress/
 *     resolved/closed), cleaned spacing, consistent theme.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, KeyboardAvoidingView, Platform, Linking,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useThemeContext } from '../src/context/ThemeContext';
import { useAuth } from '../src/context/AuthContext';
import { api } from '../src/services/api';
import i18n from '../src/i18n';

const SUPPORT_EMAIL = 'support@autoservice.com';
const SUPPORT_PHONE = '+380 44 555-00-00';

type Ticket = {
  id: string;
  subject: string;
  message?: string;
  status: string;
  category?: string;
  response?: string | null;
  respondedAt?: string | null;
  createdAt: string;
};

type SuccessState = {
  ticketId: string;
  subject: string;
  etaHours: number;
};

const STATUS_COLORS: Record<string, [string, string]> = {
  // [bg-tone-name, fg-tone-name] — resolved at render time.
  open:        ['primary',  'primary'],
  in_progress: ['warning',  'warning'],
  resolved:    ['success',  'success'],
  closed:      ['textMuted','textSecondary'],
};

export default function SupportScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  const { t, i18n } = useTranslation();
  const { user } = useAuth();

  // Allow other screens to deep-link with prefilled subject/message/category.
  // Use case: workbench "Связаться с админом" → /support?category=admin&subject=...&message=...
  const params = useLocalSearchParams<{ subject?: string; message?: string; category?: string }>();

  const [subject, setSubject] = useState(typeof params.subject === 'string' ? params.subject : '');
  const [message, setMessage] = useState(typeof params.message === 'string' ? params.message : '');
  const [category, setCategory] = useState<string>(typeof params.category === 'string' ? params.category : 'general');
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!user) { setHistoryLoading(false); return; }
    try {
      const res = await api.get('/support/tickets/mine');
      const items = res?.data?.items || [];
      setTickets(items);
    } catch { setTickets([]); } finally { setHistoryLoading(false); }
  }, [user]);

  useEffect(() => { loadHistory(); }, [loadHistory]);
  const onRefresh = useCallback(async () => {
    setRefreshing(true); await loadHistory(); setRefreshing(false);
  }, [loadHistory]);

  const handleEmail = () =>
    Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject || 'Support')}`).catch(() => {});
  const handleCall = () =>
    Linking.openURL(`tel:${SUPPORT_PHONE.replace(/\s/g, '')}`).catch(() => {});

  const handleSend = async () => {
    setErrorMsg(null);
    if (!message.trim()) {
      setErrorMsg(i18n.t('support.message_required', { defaultValue: 'Опишите проблему — без этого мы не сможем помочь.' }));
      return;
    }
    setSending(true);
    try {
      const res = await api.post('/support/tickets', {
        subject: subject.trim() || undefined,
        message: message.trim(),
        locale: i18n.language || 'ru',
        category,
        source: 'mobile',
      });
      const tk = res?.data?.ticket;
      if (tk?.id) {
        setSuccess({ ticketId: tk.id, subject: tk.subject || subject || 'Support', etaHours: tk.etaHours ?? 24 });
        setSubject(''); setMessage('');
        loadHistory();  // refresh list to include the new ticket
      } else {
        setErrorMsg(i18n.t('support.send_failed', { defaultValue: 'Не удалось отправить. Попробуйте позже.' }));
      }
    } catch (e: any) {
      const detail = e?.response?.data?.detail || e?.message || 'Network error';
      if (typeof detail === 'string' && /email is required/i.test(detail)) {
        setErrorMsg(i18n.t('support.email_required', { defaultValue: 'Войдите в аккаунт, чтобы мы могли вам ответить.' }));
      } else {
        setErrorMsg(String(detail));
      }
    } finally {
      setSending(false);
    }
  };

  const statusTone = (s: string) => {
    const [tone] = STATUS_COLORS[s] || ['primary', 'primary'];
    return (colors as any)[tone] || colors.primary;
  };

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: colors.divider || colors.border }]}>
        <TouchableOpacity
          testID="support-back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>
          {t('support.title', { defaultValue: 'Поддержка' })}
        </Text>
        <View style={{ width: 38 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Success state ──────────────────────────────────────────── */}
          {success ? (
            <View style={[styles.successCard, { backgroundColor: (colors.success || '#16a34a') + '12', borderColor: colors.success || '#16a34a' }]}>
              <View style={[styles.successIcon, { backgroundColor: (colors.success || '#16a34a') + '25' }]}>
                <Ionicons name="checkmark-circle" size={28} color={colors.success || '#16a34a'} />
              </View>
              <Text style={[styles.successTitle, { color: colors.text }]}>
                {t('support.sent_title', { defaultValue: 'Заявка отправлена' })}
              </Text>
              <View style={[styles.ticketIdBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.ticketIdLabel, { color: colors.textSecondary }]}>
                  {t('support.ticket_id', { defaultValue: 'Номер обращения' })}
                </Text>
                <Text style={[styles.ticketIdValue, { color: colors.text }]}>{success.ticketId}</Text>
              </View>
              <Text style={[styles.successBody, { color: colors.textSecondary }]}>
                {t('support.sent_body_eta', { defaultValue: 'Ответим в течение {{hours}} часов на email, привязанный к аккаунту.', hours: success.etaHours })}
              </Text>
              <View style={styles.successBtnRow}>
                <TouchableOpacity
                  testID="support-new-ticket"
                  style={[styles.outlineBtn, { borderColor: colors.border }]}
                  onPress={() => setSuccess(null)}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.outlineBtnText, { color: colors.text }]}>
                    {t('support.new_ticket', { defaultValue: 'Новое обращение' })}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="support-back-home"
                  style={[styles.filledBtn, { backgroundColor: colors.primary }]}
                  onPress={() => router.back()}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.filledBtnText, { color: colors.onPrimary || '#000' }]}>
                    {t('common.done', { defaultValue: 'Готово' })}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <>
              {/* ── Intro ─────────────────────────────────────────────── */}
              <Text style={[styles.intro, { color: colors.textSecondary }]}>
                {t('support.intro', { defaultValue: 'Опишите вашу проблему — мы ответим в течение 24 часов.' })}
              </Text>

              {/* ── Quick contact tiles ───────────────────────────────── */}
              <View style={styles.tileRow}>
                <TouchableOpacity
                  testID="support-email-btn"
                  style={[styles.tile, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={handleEmail}
                  activeOpacity={0.85}
                >
                  <View style={[styles.tileIcon, { backgroundColor: colors.primary + '20' }]}>
                    <Ionicons name="mail" size={18} color={colors.primary} />
                  </View>
                  <Text style={[styles.tileLabel, { color: colors.text }]}>Email</Text>
                  <Text style={[styles.tileVal, { color: colors.textSecondary }]} numberOfLines={1} ellipsizeMode="middle">
                    {SUPPORT_EMAIL}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="support-call-btn"
                  style={[styles.tile, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={handleCall}
                  activeOpacity={0.85}
                >
                  <View style={[styles.tileIcon, { backgroundColor: (colors.success || '#16a34a') + '20' }]}>
                    <Ionicons name="call" size={18} color={colors.success || '#16a34a'} />
                  </View>
                  <Text style={[styles.tileLabel, { color: colors.text }]}>{t('support.call', { defaultValue: 'Позвонить' })}</Text>
                  <Text style={[styles.tileVal, { color: colors.textSecondary }]} numberOfLines={1} ellipsizeMode="middle">
                    {SUPPORT_PHONE}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* ── Form ──────────────────────────────────────────────── */}
              <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary }]}>
                {t('support.subject_label', { defaultValue: 'Тема' })}
              </Text>
              <TextInput
                testID="support-subject"
                style={[styles.input, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
                placeholder={t('support.subject_placeholder', { defaultValue: 'Кратко — о чём вопрос' })}
                placeholderTextColor={colors.textMuted}
                value={subject}
                onChangeText={setSubject}
              />

              <Text style={[styles.label, { color: colors.textMuted || colors.textSecondary }]}>
                {t('support.message_label', { defaultValue: 'Сообщение' })}
              </Text>
              <TextInput
                testID="support-message"
                style={[styles.input, styles.textarea, { backgroundColor: colors.card, color: colors.text, borderColor: colors.border }]}
                placeholder={t('support.message_placeholder', { defaultValue: 'Опишите проблему подробно — какой заказ, что произошло, что ожидаете.' })}
                placeholderTextColor={colors.textMuted}
                value={message}
                onChangeText={setMessage}
                multiline
                numberOfLines={6}
                textAlignVertical="top"
              />

              {errorMsg ? (
                <View style={[styles.errorBox, { backgroundColor: (colors.danger || '#dc2626') + '12', borderColor: colors.danger || '#dc2626' }]}>
                  <Ionicons name="alert-circle" size={16} color={colors.danger || '#dc2626'} />
                  <Text style={[styles.errorText, { color: colors.danger || '#dc2626' }]}>{errorMsg}</Text>
                </View>
              ) : null}

              <TouchableOpacity
                testID="support-send-btn"
                style={[styles.cta, { backgroundColor: colors.primary, opacity: sending ? 0.6 : 1 }]}
                onPress={handleSend}
                disabled={sending}
                activeOpacity={0.85}
              >
                {sending ? <ActivityIndicator color={colors.onPrimary || '#000'} /> : (
                  <>
                    <Ionicons name="paper-plane" size={16} color={colors.onPrimary || '#000'} />
                    <Text style={[styles.ctaText, { color: colors.onPrimary || '#000' }]}>
                      {t('support.send', { defaultValue: 'Отправить' })}
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              <Text style={[styles.note, { color: colors.textMuted || colors.textSecondary }]}>
                {t('support.eta_note', { defaultValue: 'Среднее время ответа — 6 часов. Максимум — 24 часа.' })}
              </Text>
            </>
          )}

          {/* ── Ticket history (always rendered when authed) ─────────── */}
          {user ? (
            <View style={{ marginTop: 24 }}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>
                {t('support.history_title', { defaultValue: 'Мои обращения' })}
              </Text>
              {historyLoading ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />
              ) : tickets.length === 0 ? (
                <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Ionicons name="archive-outline" size={24} color={colors.textSecondary} />
                  <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                    {t('support.no_tickets', { defaultValue: 'Обращений пока нет.' })}
                  </Text>
                </View>
              ) : (
                tickets.map((tk) => {
                  const tone = statusTone(tk.status);
                  return (
                    <View
                      key={tk.id}
                      testID={`ticket-${tk.id}`}
                      style={[styles.ticketRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                    >
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={[styles.ticketSubject, { color: colors.text }]} numberOfLines={1}>
                          {tk.subject || '—'}
                        </Text>
                        <View style={styles.ticketMetaRow}>
                          <Text style={[styles.ticketMeta, { color: colors.textSecondary }]}>#{tk.id}</Text>
                          <Text style={[styles.ticketMeta, { color: colors.textSecondary }]}>·</Text>
                          <Text style={[styles.ticketMeta, { color: colors.textSecondary }]}>
                            {new Date(tk.createdAt).toLocaleDateString(i18n.language)}
                          </Text>
                        </View>
                      </View>
                      <View style={[styles.statusPill, { backgroundColor: tone + '20' }]}>
                        <Text style={[styles.statusText, { color: tone }]}>
                          {t(`support.status.${tk.status}`, { defaultValue: tk.status })}
                        </Text>
                      </View>
                    </View>
                  );
                })
              )}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },

  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32 },
  intro: { fontSize: 14, lineHeight: 20, marginBottom: 16 },

  tileRow: { flexDirection: 'row', gap: 10, marginBottom: 18 },
  tile: {
    flex: 1, alignItems: 'flex-start', gap: 6,
    paddingVertical: 12, paddingHorizontal: 12,
    borderRadius: 12, borderWidth: 1,
    minHeight: 88,
  },
  tileIcon: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  tileLabel: { fontSize: 13, fontWeight: '700' },
  tileVal: { fontSize: 11, alignSelf: 'stretch' },

  label: {
    fontSize: 11, fontWeight: '700', textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: 6, marginTop: 6,
  },
  input: {
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, borderWidth: 1, marginBottom: 10,
  },
  textarea: { minHeight: 130, paddingTop: 12 },

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 10, borderRadius: 10, borderWidth: 1, marginBottom: 12,
  },
  errorText: { flex: 1, fontSize: 13, fontWeight: '500' },

  cta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 14, borderRadius: 12, marginTop: 4,
  },
  ctaText: { fontSize: 15, fontWeight: '700' },
  note: { fontSize: 12, marginTop: 12, textAlign: 'center', lineHeight: 17 },

  // success state
  successCard: { padding: 18, borderRadius: 16, borderWidth: 1, alignItems: 'center', gap: 12 },
  successIcon: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  successTitle: { fontSize: 17, fontWeight: '800' },
  successBody: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  ticketIdBox: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, borderWidth: 1, alignItems: 'center', alignSelf: 'stretch' },
  ticketIdLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  ticketIdValue: { fontSize: 18, fontWeight: '800', marginTop: 4, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  successBtnRow: { flexDirection: 'row', gap: 10, marginTop: 4, alignSelf: 'stretch' },
  outlineBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10, borderWidth: 1 },
  outlineBtnText: { fontSize: 13, fontWeight: '700' },
  filledBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10 },
  filledBtnText: { fontSize: 13, fontWeight: '700' },

  // history
  sectionTitle: { fontSize: 15, fontWeight: '800', marginBottom: 12 },
  ticketRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12, borderRadius: 12, borderWidth: 1, marginBottom: 8,
  },
  ticketSubject: { fontSize: 14, fontWeight: '700' },
  ticketMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  ticketMeta: { fontSize: 11 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusText: { fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },
  emptyCard: { borderRadius: 12, padding: 18, borderWidth: 1, alignItems: 'center', gap: 8 },
  emptyText: { fontSize: 13 },
});

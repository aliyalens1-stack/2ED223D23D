/**
 * Support Chat Admin page — Sprint B3.4 (Admin Inbox view).
 *
 * Canonical v1 chat substrate. Replaces the legacy `/admin/chat/...`
 * surface with `/api/chat/v1/...` so admin participation reuses the
 * same projector/ownership/idempotency story as user+provider.
 *
 * Scope (B3.4 — minimal):
 *   - thread list (admin scope = adminJoined OR disputeOpen)
 *   - dispute badge on rows + thread header
 *   - "Join thread" button → POST /support/join (admin-only, idempotent)
 *   - canonical messages with `senderDisplayName` (incl. system codes)
 *   - send canonical text message (admin-as-sender requires join first)
 *
 * NOT in B3.4 (deferred to B4+):
 *   attachments / voice / emoji / reactions / read receipts UI /
 *   typing / websocket / escalation queues / SLA metrics / call.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Headphones, Send, RefreshCw, Search, Shield, User as UserIcon,
  MessageCircle, AlertTriangle, UserPlus, CheckCircle2,
  FileText, Paperclip, Loader2,
} from 'lucide-react';
import api from '../services/api';

// ── Canonical wire types (mirrors shared/domain/contracts/chat.ts) ──
type ChatKind = 'user' | 'provider' | 'admin';
type SystemCode = 'support_joined' | 'dispute_opened';
type ChatAttachmentKind = 'image' | 'pdf' | 'file';

interface ChatAttachment {
  id: string;
  kind: ChatAttachmentKind;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface ChatParticipant {
  id: string;
  kind: ChatKind;
  displayName?: string;
  avatarHint?: string | null;
  providerSlug?: string | null;
}

interface ChatThread {
  id: string;
  kind: 'support' | 'provider' | 'admin_user';
  title: string;
  participants: ChatParticipant[];
  providerSlug: string | null;
  bookingId: string | null;
  lastMessagePreview: string;
  lastMessageAt: string | null;
  unreadByMe: number;
  disputeOpen: boolean;
  disputeOpenedAt: string | null;
  adminJoined: boolean;
  createdAt: string;
}

interface ChatVoice {
  id: string;
  audioUrl: string;
  durationMs: number;
  mimeType: string;
  sizeBytes: number;
}

interface ChatReaction {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

interface ChatMessage {
  id: string;
  threadId: string;
  senderKind: ChatKind;
  senderId: string;
  senderDisplayName?: string;
  type: 'text' | 'system' | 'attachment' | 'voice';
  body: string;
  attachment?: ChatAttachment;
  voice?: ChatVoice;
  // Sprint B4c — read-only display in admin (no moderation tooling yet,
  // per spec line 8: "Moderation should come in a separate sprint").
  reactions?: ChatReaction[];
  createdAt: string;
  readAt: string | null;
  isMine: boolean;
}

const POLL_MS = 5000;
const THREADS_POLL_MS = 10000;

// System code → localised copy. Wire stays language-neutral; the
// surface picks the translation. RU here matches the rest of admin.
const SYSTEM_COPY: Record<SystemCode, string> = {
  support_joined: 'Поддержка присоединилась к чату',
  dispute_opened: 'Открыт спор',
};

function fmtTime(ts: string | null) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  if (diff < 86_400_000) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (diff < 172_800_000) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function participantSummary(t: ChatThread): string {
  // The "other side" as a short label for the row. Admin participant is
  // implicit on the rendering side — we summarise user + provider only.
  const user = t.participants.find((p) => p.kind === 'user');
  const provider = t.participants.find((p) => p.kind === 'provider');
  if (provider) return provider.displayName || provider.providerSlug || 'Provider';
  if (user) return user.displayName || user.id.slice(0, 16);
  return t.title || 'Thread';
}

export default function SupportChatPage() {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [joining, setJoining] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const msgEndRef = useRef<HTMLDivElement>(null);

  const fetchThreads = async () => {
    try {
      setError(null);
      const res = await api.get<{ threads: ChatThread[] }>('/chat/v1/threads?limit=100');
      setThreads(res.data.threads || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load threads');
    } finally {
      setLoadingThreads(false);
    }
  };

  const fetchMessages = async (tid: string) => {
    try {
      const res = await api.get<{ thread: ChatThread; messages: ChatMessage[] }>(
        `/chat/v1/threads/${tid}/messages?limit=200`
      );
      setMessages(res.data.messages || []);
      setThread(res.data.thread || null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load messages');
    } finally {
      setLoadingMessages(false);
    }
  };

  useEffect(() => {
    fetchThreads();
    const i = setInterval(fetchThreads, THREADS_POLL_MS);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      setThread(null);
      return;
    }
    setLoadingMessages(true);
    fetchMessages(activeId);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => fetchMessages(activeId), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeId]);

  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleJoin = async () => {
    if (!activeId || joining) return;
    setJoining(true);
    try {
      const res = await api.post<{ thread: ChatThread; mutated: boolean }>(
        `/chat/v1/threads/${activeId}/support/join`
      );
      setThread(res.data.thread);
      // Refresh both panes — the join system message lands canonically.
      fetchMessages(activeId);
      fetchThreads();
    } catch (e: any) {
      setError(e?.message || 'Failed to join thread');
    } finally {
      setJoining(false);
    }
  };

  const handleSend = async () => {
    const t = reply.trim();
    if (!t || !activeId || sending) return;
    setSending(true);
    try {
      const res = await api.post<{ message: ChatMessage; thread: ChatThread }>(
        `/chat/v1/threads/${activeId}/messages`,
        { body: t }
      );
      setMessages((prev) => [...prev, res.data.message]);
      setThread(res.data.thread);
      setReply('');
      fetchThreads();
    } catch (e: any) {
      // Backend emits 409 when admin tries to send without join — surface
      // it as a clear "please join first" so the operator self-heals.
      const status = e?.status;
      if (status === 409) {
        setError('Сначала присоединитесь к чату (Join).');
      } else {
        setError(e?.message || 'Failed to send');
      }
    } finally {
      setSending(false);
    }
  };

  const filtered = useMemo(
    () =>
      threads.filter((t) => {
        const q = search.toLowerCase();
        if (!q) return true;
        return (
          t.title.toLowerCase().includes(q) ||
          participantSummary(t).toLowerCase().includes(q) ||
          (t.lastMessagePreview || '').toLowerCase().includes(q)
        );
      }),
    [threads, search]
  );

  const disputeCount = threads.filter((t) => t.disputeOpen).length;
  const activeThread = thread || threads.find((t) => t.id === activeId) || null;
  const canSend = !!activeThread?.adminJoined;

  return (
    <div className="p-6 space-y-4 h-full flex flex-col" data-testid="support-chat-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-gradient-to-br from-emerald-600/20 to-teal-600/20 rounded-xl border border-emerald-500/30">
            <Headphones size={28} className="text-emerald-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Admin Inbox</h1>
            <p className="text-slate-400 text-sm">
              {threads.length} threads · {disputeCount} disputes
            </p>
          </div>
        </div>
        <button
          onClick={fetchThreads}
          className="p-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition"
          data-testid="support-chat-refresh"
        >
          <RefreshCw size={18} className={loadingThreads ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div
          className="bg-red-500/10 border border-red-500/40 rounded-xl p-3 text-red-300 text-sm flex items-center justify-between"
          data-testid="support-chat-error"
        >
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-200 hover:text-white text-xs">
            закрыть
          </button>
        </div>
      )}

      <div className="flex flex-1 gap-4 min-h-0">
        {/* THREADS LIST */}
        <div className="w-80 bg-slate-800 rounded-xl border border-slate-700 flex flex-col">
          <div className="p-3 border-b border-slate-700">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск по участнику / тексту"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white outline-none focus:border-emerald-500"
                data-testid="support-chat-search"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto" data-testid="support-thread-list">
            {loadingThreads ? (
              <div className="p-6 text-center text-slate-500 text-sm">Loading...</div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-center text-slate-500 text-sm flex flex-col items-center gap-2">
                <MessageCircle size={32} />
                <span>Нет чатов в инбоксе</span>
              </div>
            ) : (
              filtered.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveId(t.id)}
                  className={`w-full text-left p-3 border-b border-slate-700/50 transition ${
                    activeId === t.id ? 'bg-emerald-500/10 border-l-4 border-l-emerald-500' : 'hover:bg-slate-700/30'
                  }`}
                  data-testid={`support-thread-${t.id}`}
                >
                  <div className="flex items-start gap-2">
                    <div className="w-9 h-9 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                      <UserIcon size={16} className="text-emerald-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-white truncate">
                          {participantSummary(t)}
                        </span>
                        <span className="text-[10px] text-slate-500 flex-shrink-0">{fmtTime(t.lastMessageAt)}</span>
                      </div>
                      <div className="flex items-center justify-between mt-0.5 gap-2">
                        <span className="text-xs text-slate-400 truncate flex-1">
                          {t.lastMessagePreview || '—'}
                        </span>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {t.disputeOpen && (
                            <span
                              className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-500/20 text-red-400 border border-red-500/40 flex items-center gap-0.5"
                              data-testid={`dispute-badge-${t.id}`}
                            >
                              <AlertTriangle size={9} /> DISPUTE
                            </span>
                          )}
                          {t.adminJoined && !t.disputeOpen && (
                            <span
                              className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                              data-testid={`joined-badge-${t.id}`}
                            >
                              joined
                            </span>
                          )}
                          {t.unreadByMe > 0 && (
                            <span className="ml-1 min-w-[16px] h-4 px-1 rounded-full bg-emerald-400 text-black text-[10px] font-bold flex items-center justify-center">
                              {t.unreadByMe}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* CHAT VIEW */}
        <div className="flex-1 bg-slate-800 rounded-xl border border-slate-700 flex flex-col">
          {!activeId ? (
            <div className="flex-1 flex items-center justify-center text-slate-500">
              <div className="text-center">
                <MessageCircle size={48} className="mx-auto mb-3 opacity-40" />
                <p>Выберите чат слева</p>
              </div>
            </div>
          ) : (
            <>
              <div className="p-4 border-b border-slate-700 flex items-center gap-3">
                <Shield size={18} className="text-emerald-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-white font-semibold truncate">
                    {activeThread ? participantSummary(activeThread) : '—'}
                  </div>
                  <div className="text-xs text-slate-400 flex items-center gap-2">
                    <span>{activeThread?.kind || 'support'} · ID {activeId.slice(0, 8)}</span>
                    {activeThread?.disputeOpen && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/40 flex items-center gap-1"
                        data-testid="dispute-header-badge"
                      >
                        <AlertTriangle size={10} /> DISPUTE
                      </span>
                    )}
                  </div>
                </div>
                {activeThread?.adminJoined ? (
                  <span
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-xs font-medium"
                    data-testid="support-joined-indicator"
                  >
                    <CheckCircle2 size={14} /> Joined
                  </span>
                ) : (
                  <button
                    onClick={handleJoin}
                    disabled={joining}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-black text-xs font-bold"
                    data-testid="support-join-button"
                  >
                    {joining ? <RefreshCw size={14} className="animate-spin" /> : <UserPlus size={14} />}
                    Join
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3" data-testid="support-message-list">
                {loadingMessages ? (
                  <div className="text-center text-slate-500 text-sm">Loading...</div>
                ) : messages.length === 0 ? (
                  <div className="text-center text-slate-500 text-sm">Нет сообщений</div>
                ) : (
                  messages.map((m) => {
                    if (m.type === 'system') {
                      const code = m.body as SystemCode;
                      return (
                        <div
                          key={m.id}
                          className="flex justify-center"
                          data-testid={`message-system-${m.id}`}
                        >
                          <div className="px-3 py-1 rounded-full bg-slate-700/40 border border-slate-600/40 text-[11px] text-slate-300">
                            {SYSTEM_COPY[code] || code}
                            <span className="ml-2 text-slate-500">{fmtTime(m.createdAt)}</span>
                          </div>
                        </div>
                      );
                    }
                    const isMine = m.isMine;
                    return (
                      <div
                        key={m.id}
                        className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}
                        data-testid={`message-${m.senderKind}-${m.id}`}
                      >
                        <div
                          className={`max-w-[70%] px-4 py-2 rounded-2xl ${
                            isMine
                              ? 'bg-emerald-500 text-black rounded-br-md'
                              : 'bg-slate-700 text-white rounded-bl-md'
                          }`}
                        >
                          {!isMine && (
                            <div className="text-[10px] font-semibold text-slate-400 mb-1">
                              {m.senderDisplayName || (m.senderKind === 'admin' ? 'Support' : m.senderKind)}
                            </div>
                          )}
                          {/* Sprint B4a — read-only attachment rendering for admin.
                              Admins can preview but the spec does NOT include
                              upload from admin in B4a (that arrives later). */}
                          {m.type === 'attachment' && m.attachment ? (
                            <AdminAttachmentView att={m.attachment} mine={isMine} msgId={m.id} />
                          ) : null}
                          {/* Sprint B4b — voice playback is intentionally not
                              implemented on admin (Phase 0 closure):
                              the `AdminVoiceView` component was never shipped,
                              referencing it crashed the page with a
                              ReferenceError. Voice messages render as a placeholder
                              line; admin still sees senderDisplayName + body. */}
                          {m.type === 'voice' && m.voice ? (
                            <div
                              className={`text-xs italic mb-1 ${isMine ? 'text-black/70' : 'text-slate-300'}`}
                              data-testid={`admin-voice-placeholder-${m.id}`}
                            >
                              🎙 голосовое сообщение ({Math.round((m.voice.durationMs || 0) / 1000)} с) — недоступно в admin
                            </div>
                          ) : null}
                          {m.body ? (
                            <div className="text-sm whitespace-pre-wrap">{m.body}</div>
                          ) : null}
                          {/* Sprint B4c — read-only reaction pills.
                              Admin doesn't moderate reactions in B4c per
                              spec line 8; we just surface them so support
                              has full context on user feedback. */}
                          {m.reactions && m.reactions.length > 0 && (
                            <div
                              className="flex flex-wrap gap-1 mt-2"
                              data-testid={`admin-msg-${m.id}-reactions`}
                            >
                              {m.reactions.map((r) => (
                                <span
                                  key={r.emoji}
                                  data-testid={`admin-msg-${m.id}-react-${r.emoji}`}
                                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] border ${
                                    isMine
                                      ? 'bg-black/15 border-black/25 text-black'
                                      : 'bg-slate-800 border-slate-600 text-slate-200'
                                  }`}
                                  title={r.reactedByMe ? 'Вы реагировали' : 'Реакция участника'}
                                >
                                  <span>{r.emoji}</span>
                                  {r.count > 1 && <span className="font-semibold">{r.count}</span>}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className={`text-[10px] mt-1 ${isMine ? 'text-black/60' : 'text-slate-400'}`}>
                            {fmtTime(m.createdAt)}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={msgEndRef} />
              </div>

              <div className="p-3 border-t border-slate-700">
                {!canSend && (
                  <div
                    className="mb-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2"
                    data-testid="support-join-required-hint"
                  >
                    <UserPlus size={14} />
                    Чтобы отвечать в этом чате, нажмите Join — это зафиксирует системное сообщение и привяжет вас как admin participant.
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder={
                      canSend
                        ? 'Ответить участнику... (Enter — отправить, Shift+Enter — новая строка)'
                        : 'Сначала Join, затем можно писать'
                    }
                    rows={2}
                    disabled={!canSend}
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-emerald-500 resize-none disabled:opacity-60 disabled:cursor-not-allowed"
                    data-testid="support-reply-input"
                  />
                  <button
                    onClick={handleSend}
                    disabled={!reply.trim() || sending || !canSend}
                    className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed text-black rounded-lg font-bold flex items-center gap-2 transition"
                    data-testid="support-reply-send"
                  >
                    {sending ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />}
                    Send
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────
// Sprint B4a — Read-only attachment rendering for admin inbox
// ─────────────────────────────────────────────────────────────────
//
// Admin attachment behaviour is intentionally narrower than mobile/web:
//   - admins can preview images inline (blob fetch via auth interceptor)
//   - admins can open pdf/file via query-token (server accepts `?token=`)
//   - admins CANNOT upload in B4a (spec: read-only). Upload from the
//     admin surface lands in a later sprint, alongside moderation tools.

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AdminAttachmentView({ att, mine, msgId }: { att: ChatAttachment; mine: boolean; msgId: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState<string | null>(null);

  useEffect(() => {
    if (att.kind !== 'image') return;
    let alive = true;
    let createdUrl: string | null = null;
    (async () => {
      try {
        const res = await api.get(att.url.replace(/^\/api/, ''), { responseType: 'blob' });
        if (!alive) return;
        createdUrl = URL.createObjectURL(res.data as Blob);
        setBlobUrl(createdUrl);
      } catch (e: any) {
        if (alive) setImgErr(e?.message || 'load failed');
      }
    })();
    return () => {
      alive = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [att.url, att.kind]);

  // Admin stores its JWT under `admin_token` (see /app/admin/src/services/api.ts).
  const tokenedHref = useMemo(() => {
    if (att.kind === 'image') return '';
    const t = (localStorage.getItem('admin_token') || '').trim();
    return t ? `${att.url}?token=${encodeURIComponent(t)}` : att.url;
  }, [att.kind, att.url]);

  if (att.kind === 'image') {
    if (imgErr) {
      return (
        <div className="text-xs italic text-red-300 py-1" data-testid={`admin-att-${msgId}-img-err`}>
          Не удалось загрузить изображение
        </div>
      );
    }
    if (!blobUrl) {
      return (
        <div className="w-48 h-32 rounded-lg bg-slate-600/40 flex items-center justify-center mb-1" data-testid={`admin-att-${msgId}-img-loading`}>
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        </div>
      );
    }
    return (
      <a href={blobUrl} target="_blank" rel="noopener noreferrer" data-testid={`admin-att-${msgId}-image`}>
        <img
          src={blobUrl}
          alt={att.filename}
          className="max-w-[280px] max-h-[300px] rounded-lg mb-1 object-cover"
        />
      </a>
    );
  }

  const Icon = att.kind === 'pdf' ? FileText : Paperclip;
  return (
    <a
      href={tokenedHref}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg mb-1 border ${
        mine ? 'border-black/20 bg-black/10 hover:bg-black/15' : 'border-slate-500/40 bg-slate-600/30 hover:bg-slate-600/50'
      }`}
      data-testid={`admin-att-${msgId}-${att.kind}`}
      download={att.kind === 'file' ? att.filename : undefined}
    >
      <Icon className={`w-5 h-5 shrink-0 ${mine ? 'text-black/70' : 'text-emerald-300'}`} />
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-semibold truncate ${mine ? 'text-black' : 'text-white'}`}>{att.filename}</p>
        <p className={`text-[10px] ${mine ? 'text-black/60' : 'text-slate-300'}`}>
          {att.kind.toUpperCase()} · {fmtBytes(att.sizeBytes)}
        </p>
      </div>
    </a>
  );
}

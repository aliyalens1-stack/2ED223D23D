/**
 * Web chat — Sprint B2 minimal canonical surface.
 *
 * Two pages share this file:
 *   - `<ChatListPage />`  — canonical thread list at `/account/messages`
 *   - `<ChatThreadPage />` — canonical thread view at `/account/messages/:id`
 *
 * Minimal by design (per B2 anti-scope): no attachments, voice, emoji,
 * disputes, admin-join. Just the canonical wire shape rendered correctly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, MessageSquare, HelpCircle, Construction, Search, Send, Paperclip, FileText, Image as ImageIcon, Loader2, Mic, Square, Plus, X as XIcon } from 'lucide-react';
import { useChatThreads } from '../../hooks/useChatThreads';
import { useChatMessages } from '../../hooks/useChatMessages';
import api from '../../services/api';
import type { ChatThread, ChatMessage, ChatAttachment, ChatVoice, ChatReaction, ChatReactionEmoji } from '@platform/domain/contracts/chat';

// Sprint B4c — must match `_REACTION_WHITELIST` in backend/app/chat/canonical.py.
const REACTION_EMOJIS: readonly ChatReactionEmoji[] = ['👍', '❤️', '😂', '😮', '😢', '👎'];

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 86_400_000) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (diff < 172_800_000) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
function threadTitle(t: ChatThread): string {
  if (t.kind === 'support') return 'AutoSearch Support';
  if (t.title) return t.title;
  const prov = t.participants.find((p) => p.kind === 'provider');
  return prov?.displayName || t.id;
}

// Voice recording surface limits — must match backend (canonical.py).
const _VOICE_MAX_MS = 120 * 1000;
const _VOICE_MIN_MS = 200;

// ─────────────────────────────────────────────────────────────────
// List page
// ─────────────────────────────────────────────────────────────────

export function ChatListPage() {
  const { threads, loading, error, refresh } = useChatThreads(true);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [supportErr, setSupportErr] = useState<string | null>(null);
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return threads;
    return threads.filter((t) =>
      threadTitle(t).toLowerCase().includes(s) ||
      (t.lastMessagePreview || '').toLowerCase().includes(s),
    );
  }, [threads, q]);

  const onContactSupport = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setSupportErr(null);
    try {
      // Legacy thread-creation path: B2 is client-migration only; thread-create
      // canonicalisation lands later. See sprint memo.
      const res = await api.post<{ thread: { id: string } }>('/chat/threads', { type: 'support' });
      navigate(`/account/messages/${res.data.thread.id}`);
    } catch {
      setSupportErr('Не удалось открыть чат поддержки');
    } finally {
      setCreating(false);
    }
  }, [creating, navigate]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6" data-testid="webapp-chat-list">
      <h1 className="text-xl md:text-2xl font-bold mb-4 flex items-center gap-2">
        <MessageSquare className="w-5 h-5" /> Сообщения
      </h1>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск чатов"
          data-testid="webapp-chat-search"
          className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:border-slate-400 outline-none"
        />
      </div>

      <button
        type="button"
        onClick={onContactSupport}
        disabled={creating}
        data-testid="webapp-chat-contact-support"
        className="w-full mb-4 inline-flex items-center justify-center gap-2 py-2.5 rounded-lg bg-yellow-400 text-black font-semibold hover:bg-yellow-300 disabled:opacity-50"
      >
        <HelpCircle className="w-4 h-4" /> {creating ? 'Открываю…' : 'Связаться с поддержкой'}
      </button>
      {supportErr && <p className="text-sm text-red-600 mb-3">{supportErr}</p>}

      {loading && threads.length === 0 ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-400 mx-auto" />
        </div>
      ) : error && threads.length === 0 ? (
        <div className="text-center py-12" data-testid="webapp-chat-error">
          <p className="text-slate-600 mb-3">Не удалось загрузить чаты</p>
          <button type="button" onClick={() => void refresh()} className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm">
            Повторить
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed border-slate-200 rounded-xl" data-testid="webapp-chat-empty">
          <MessageSquare className="w-10 h-10 text-slate-400 mx-auto mb-2" />
          <p className="text-slate-700 font-semibold">{q ? 'Ничего не найдено' : 'Пока нет сообщений'}</p>
          <p className="text-sm text-slate-500 mt-1">
            Откройте чат поддержки или напишите провайдеру со страницы заказа.
          </p>
        </div>
      ) : (
        <ul className="space-y-2" data-testid="webapp-chat-list-ul">
          {filtered.map((t) => {
            const unread = t.unreadByMe > 0;
            const Icon = t.kind === 'support' ? HelpCircle : t.kind === 'provider' ? Construction : MessageSquare;
            return (
              <li key={t.id}>
                <Link
                  to={`/account/messages/${t.id}`}
                  data-testid={`webapp-chat-thread-${t.id}`}
                  className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                    unread ? 'bg-yellow-50/60 border-yellow-200 hover:bg-yellow-50' : 'bg-white border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="w-11 h-11 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                    <Icon className="w-5 h-5 text-slate-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-slate-900 truncate">{threadTitle(t)}</p>
                      <span className="text-xs text-slate-500 shrink-0">{formatTime(t.lastMessageAt)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <p className={`text-sm truncate ${unread ? 'text-slate-900 font-medium' : 'text-slate-500'}`}>
                        {t.lastMessagePreview || 'Нет сообщений'}
                      </p>
                      {unread && (
                        <span
                          data-testid={`webapp-chat-thread-${t.id}-unread`}
                          className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-yellow-400 text-black text-xs font-bold"
                        >
                          {t.unreadByMe >= 100 ? '99+' : t.unreadByMe}
                        </span>
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Thread page
// ─────────────────────────────────────────────────────────────────

export function ChatThreadPage() {
  const { id } = useParams<{ id: string }>();
  const threadId = id || null;
  const { thread, messages, loading, sending, error, send, markRead, refresh } = useChatMessages(threadId, !!threadId);
  const [draft, setDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  // Sprint B4b — voice recording state. MediaRecorder API + tap-start/tap-stop.
  const [recording, setRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const recStartRef = useRef<number>(0);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastLenRef = useRef(0);

  useEffect(() => {
    if (!thread || thread.unreadByMe === 0) return;
    void markRead();
  }, [thread?.unreadByMe, markRead, thread]);

  useEffect(() => {
    if (messages.length > lastLenRef.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
    lastLenRef.current = messages.length;
  }, [messages.length]);

  const onSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const ok = await send(text);
    if (ok) setDraft('');
  };

  // Sprint B4c — reaction toggle. tap-existing OR pick-from-row both
  // route through here. POST/DELETE per current `reactedByMe` state.
  const onToggleReaction = useCallback(async (messageId: string, emoji: ChatReactionEmoji, reactedByMe: boolean) => {
    try {
      if (reactedByMe) {
        await api.delete(`/chat/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`);
      } else {
        await api.post(`/chat/v1/messages/${encodeURIComponent(messageId)}/reactions`, { emoji });
      }
      await refresh();
    } catch (err: any) {
      const s = err?.response?.status;
      if (s === 422) setUploadErr('Эта реакция не поддерживается.');
      else if (s === 403) setUploadErr('Нет доступа к этому чату.');
      // 404 silenced — refresh handles the stale state.
    }
  }, [refresh]);

  // Sprint B4b — start/stop recorder. MediaRecorder API; webm/opus is the
  // baseline supported codec on Chrome/Firefox/Edge. Safari produces mp4.
  // Backend accepts both, so we let the browser pick its native format.
  const startRecording = useCallback(async () => {
    if (recording || !threadId) return;
    setUploadErr(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setUploadErr('Браузер не поддерживает запись');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Prefer webm/opus when available; fall back to default mime so
      // Safari still works (it produces audio/mp4 natively).
      const mr = (window as any).MediaRecorder.isTypeSupported?.('audio/webm')
        ? new (window as any).MediaRecorder(stream, { mimeType: 'audio/webm' })
        : new (window as any).MediaRecorder(stream);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e: any) => { if (e.data?.size) chunks.push(e.data); };
      mr.onstop = async () => {
        // Stop the underlying tracks so the mic LED turns off promptly.
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        const durationMs = Math.max(_VOICE_MIN_MS, Date.now() - recStartRef.current);
        if (durationMs > _VOICE_MAX_MS) {
          setUploadErr(`Максимум 120 секунд. Запись была ${Math.round(durationMs / 1000)}с.`);
          return;
        }
        setUploading(true);
        try {
          const form = new FormData();
          const ext = (blob.type.includes('mp4') ? 'm4a' : 'webm');
          form.append('file', blob, `voice-${Date.now()}.${ext}`);
          form.append('duration_ms', String(durationMs));
          await api.post(`/chat/v1/threads/${encodeURIComponent(threadId)}/voice`, form, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
          await refresh();
        } catch (err: any) {
          const s = err?.response?.status;
          if (s === 413) setUploadErr('Запись слишком большая (макс 12 МБ).');
          else if (s === 415) setUploadErr('Неподдерживаемый аудиоформат.');
          else if (s === 422) setUploadErr('Длительность вне допустимого диапазона.');
          else if (s === 403) setUploadErr('Нет доступа к чату.');
          else setUploadErr(err?.message || 'Не удалось отправить запись.');
        } finally {
          setUploading(false);
        }
      };
      mediaRecRef.current = mr;
      recStartRef.current = Date.now();
      setRecElapsed(0);
      mr.start();
      setRecording(true);
      // Tick once per second so the user sees the timer move.
      recTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - recStartRef.current;
        setRecElapsed(elapsed);
        // Auto-stop at the 120s ceiling — saves the user from hitting it.
        if (elapsed >= _VOICE_MAX_MS) {
          try { mr.stop(); } catch { /* idempotent */ }
        }
      }, 200);
    } catch (e: any) {
      setUploadErr('Микрофон недоступен. Разрешите доступ в браузере.');
    }
  }, [recording, threadId, refresh]);

  const stopRecording = useCallback(() => {
    const mr = mediaRecRef.current;
    if (!mr) return;
    try { mr.stop(); } catch { /* idempotent */ }
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    setRecording(false);
    mediaRecRef.current = null;
  }, []);

  useEffect(() => () => {
    // Component teardown — make sure no zombie recorder remains.
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    try { mediaRecRef.current?.stop(); } catch { /* idempotent */ }
  }, []);

  // Sprint B4a — file upload from web. Uses a hidden <input type=file>
  // bound to the paperclip button. Accept attribute is advisory; the
  // server is the source of truth (415 on bad MIME, 413 on oversize).
  const onPickFile = () => {
    setUploadErr(null);
    fileInputRef.current?.click();
  };

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';  // reset so the same file can be picked twice
    if (!f || !threadId) return;
    // Surface-side guard mirrors the backend image cap (most restrictive)
    // — only as a UX nicety, the server still validates.
    if (f.size > 20 * 1024 * 1024) {
      setUploadErr('Файл слишком большой (макс 20 МБ для PDF, 8 МБ для фото).');
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', f);
      await api.post(`/chat/v1/threads/${encodeURIComponent(threadId)}/attachments`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      await refresh();
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 413) setUploadErr('Файл слишком большой.');
      else if (status === 415) setUploadErr(`Неподдерживаемый формат: ${f.type || 'неизвестный'}.`);
      else if (status === 403) setUploadErr('Нет доступа к этому чату.');
      else setUploadErr(err?.message || 'Не удалось загрузить файл.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-0 md:px-4 py-0 md:py-6 flex flex-col h-[calc(100vh-64px)]" data-testid="webapp-chat-thread">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 bg-white sticky top-0">
        <Link to="/account/messages" className="text-slate-500 hover:text-slate-900" data-testid="webapp-chat-back">
          <ChevronLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <p className="font-semibold truncate">{thread ? threadTitle(thread) : 'Чат'}</p>
          {thread?.kind === 'support' && <p className="text-xs text-slate-500">Обычно отвечают за 5 мин</p>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2 bg-slate-50">
        {loading && messages.length === 0 ? (
          <div className="text-center py-10"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-yellow-400 mx-auto" /></div>
        ) : error === 'forbidden' ? (
          <p className="text-center text-sm text-slate-500 py-10" data-testid="webapp-chat-forbidden">Нет доступа к чату</p>
        ) : error === 'not_found' ? (
          <p className="text-center text-sm text-slate-500 py-10" data-testid="webapp-chat-not-found">Чат не найден</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-sm text-slate-500 py-10" data-testid="webapp-chat-empty-msgs">Напишите первое сообщение</p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} m={m} onToggleReaction={onToggleReaction} />)
        )}
        <div ref={bottomRef} />
      </div>

      {uploadErr && (
        <div className="px-4 py-2 bg-red-50 text-red-700 text-xs border-t border-red-200" data-testid="webapp-chat-upload-err">
          {uploadErr}
        </div>
      )}

      <div className="border-t border-slate-200 bg-white p-3 flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,text/plain,application/zip,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={onFileChosen}
          data-testid="webapp-chat-file-input"
        />
        <button
          type="button"
          onClick={onPickFile}
          disabled={uploading || sending || recording}
          className="w-10 h-10 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 inline-flex items-center justify-center disabled:opacity-40"
          data-testid="webapp-chat-attach"
          aria-label="Прикрепить файл"
          title="Прикрепить фото / PDF / документ"
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
        </button>
        {/* Sprint B4b — mic button. Tap to start, tap (or auto at 120s) to stop. */}
        <button
          type="button"
          onClick={recording ? stopRecording : startRecording}
          disabled={uploading || sending}
          className={`w-10 h-10 rounded-full inline-flex items-center justify-center disabled:opacity-40 ${
            recording ? 'bg-red-500 hover:bg-red-600 text-white animate-pulse' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
          }`}
          data-testid="webapp-chat-mic"
          aria-label={recording ? `Остановить запись (${Math.round(recElapsed/1000)}с)` : 'Записать голосовое'}
          title={recording ? `Стоп — ${Math.round(recElapsed/1000)}с / 120` : 'Записать голосовое'}
        >
          {recording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
          placeholder="Сообщение…"
          maxLength={4000}
          rows={1}
          data-testid="webapp-chat-input"
          className="flex-1 resize-none border border-slate-200 rounded-2xl px-3 py-2 text-sm focus:border-slate-400 outline-none max-h-[120px]"
        />
        <button
          type="button"
          onClick={() => void onSend()}
          disabled={!draft.trim() || sending || uploading}
          data-testid="webapp-chat-send"
          className="w-10 h-10 rounded-full bg-yellow-400 hover:bg-yellow-300 text-black inline-flex items-center justify-center disabled:opacity-40"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ m, onToggleReaction }: { m: ChatMessage; onToggleReaction?: (id: string, e: ChatReactionEmoji, reactedByMe: boolean) => void }) {
  if (m.type === 'system') {
    return (
      <div className="text-center text-xs text-slate-400 italic py-1" data-testid={`webapp-chat-msg-${m.id}`}>
        {m.body}
      </div>
    );
  }
  const mine = m.isMine;
  const senderLabel = mine ? null : (m.senderDisplayName || (m.senderKind === 'admin' ? 'Поддержка' : m.senderKind === 'provider' ? 'Провайдер' : ''));
  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`} data-testid={`webapp-chat-msg-${m.id}`}>
      <div className={`max-w-[78%] rounded-2xl px-3 py-2 ${mine ? 'bg-yellow-400 text-black rounded-br-sm' : 'bg-white border border-slate-200 text-slate-900 rounded-bl-sm'}`}>
        {!mine && senderLabel && (
          <p className="text-[11px] font-semibold text-yellow-600 mb-0.5">{senderLabel}</p>
        )}
        {/* Sprint B4a — attachment renders above any caption body. */}
        {m.type === 'attachment' && m.attachment ? (
          <AttachmentView att={m.attachment} mine={mine} msgId={m.id} />
        ) : null}
        {/* Sprint B4b — voice playback. `<audio controls>` is enough per
            B4b spec; no waveform, no custom transport. */}
        {m.type === 'voice' && m.voice ? (
          <VoiceView voice={m.voice} mine={mine} msgId={m.id} />
        ) : null}
        {m.body ? (
          <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
        ) : null}
        <p className={`text-[10px] mt-1 text-right ${mine ? 'text-black/60' : 'text-slate-400'}`}>
          {formatTime(m.createdAt)}{mine && m.readAt ? '  ✓✓' : mine ? '  ✓' : ''}
        </p>
      </div>
      {/* Sprint B4c — reactions row, OUTSIDE the bubble. Decoration, not message. */}
      {onToggleReaction && (
        <ReactionsRow
          messageId={m.id}
          mine={mine}
          reactions={m.reactions || []}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sprint B4a — attachment rendering for the web surface
// ─────────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Authenticated attachment rendering.
 *
 * Browsers can't put `Authorization` headers on `<img src>`, so for
 * `image` we `fetch()` with the bearer token, blobify and use an
 * object URL. For `pdf` / `file` we pass the JWT through the `?token=`
 * fallback the server accepts — that produces a normal anchor that
 * the browser can navigate or download natively.
 */
function AttachmentView({ att, mine, msgId }: { att: ChatAttachment; mine: boolean; msgId: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState<string | null>(null);

  useEffect(() => {
    if (att.kind !== 'image') return;
    let alive = true;
    let createdUrl: string | null = null;
    (async () => {
      try {
        // `api` is preconfigured with Authorization header by the axios
        // interceptor — `responseType: 'blob'` keeps it binary.
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

  // Anchor for pdf/file — uses query-token transport so the OS can open it.
  const tokenedHref = useMemo(() => {
    if (att.kind === 'image') return '';
    // Web-app stores the JWT under `token` (vs mobile's `auth_token`)
    // — see /app/web-app/src/services/api.ts line ~9.
    const t = (localStorage.getItem('token') || '').trim();
    // The server-side path is `/api/chat/v1/attachments/{id}`. We render
    // it as same-origin (no `import.meta.env` plumbing needed — Vite
    // dev + prod both proxy `/api` to the FastAPI backend).
    const baseUrl = att.url;
    return t ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}` : baseUrl;
  }, [att.kind, att.url]);

  if (att.kind === 'image') {
    if (imgErr) {
      return (
        <div className="text-xs italic text-red-500 py-1" data-testid={`webapp-att-${msgId}-img-err`}>
          Не удалось загрузить изображение
        </div>
      );
    }
    if (!blobUrl) {
      return (
        <div className="w-44 h-32 rounded-lg bg-slate-200 flex items-center justify-center mb-1" data-testid={`webapp-att-${msgId}-img-loading`}>
          <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
        </div>
      );
    }
    return (
      <a href={blobUrl} target="_blank" rel="noopener noreferrer" data-testid={`webapp-att-${msgId}-image`}>
        <img
          src={blobUrl}
          alt={att.filename}
          className="max-w-[280px] max-h-[300px] rounded-lg mb-1 object-cover"
        />
      </a>
    );
  }

  // pdf / file row
  const Icon = att.kind === 'pdf' ? FileText : ImageIcon;
  return (
    <a
      href={tokenedHref}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg mb-1 border ${
        mine ? 'border-black/15 bg-black/5 hover:bg-black/10' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
      }`}
      data-testid={`webapp-att-${msgId}-${att.kind}`}
      download={att.kind === 'file' ? att.filename : undefined}
    >
      <Icon className={`w-5 h-5 shrink-0 ${mine ? 'text-black/70' : 'text-slate-600'}`} />
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-semibold truncate ${mine ? 'text-black' : 'text-slate-900'}`}>{att.filename}</p>
        <p className={`text-[10px] ${mine ? 'text-black/60' : 'text-slate-500'}`}>
          {att.kind.toUpperCase()} · {fmtBytes(att.sizeBytes)}
        </p>
      </div>
    </a>
  );
}


// ─────────────────────────────────────────────────────────────────
// Sprint B4b — voice rendering + recorder for the web surface
// ─────────────────────────────────────────────────────────────────

function VoiceView({ voice, mine, msgId }: { voice: ChatVoice; mine: boolean; msgId: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let createdUrl: string | null = null;
    (async () => {
      try {
        // Authenticated blob fetch — same pattern as image attachments.
        // `<audio src>` can't carry Authorization headers, so we fetch
        // via axios (interceptor adds Bearer) and use a blob URL.
        const res = await api.get(voice.audioUrl.replace(/^\/api/, ''), { responseType: 'blob' });
        if (!alive) return;
        createdUrl = URL.createObjectURL(res.data as Blob);
        setBlobUrl(createdUrl);
      } catch (e: any) {
        if (alive) setErr(e?.message || 'load failed');
      }
    })();
    return () => {
      alive = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [voice.audioUrl]);

  const totalSec = Math.max(0, Math.round(voice.durationMs / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const durationLabel = `${mins}:${secs.toString().padStart(2, '0')}`;

  if (err) {
    return (
      <div className="text-xs italic text-red-500 py-1" data-testid={`webapp-voice-${msgId}-err`}>
        Не удалось загрузить голосовое
      </div>
    );
  }
  if (!blobUrl) {
    return (
      <div
        className={`flex items-center gap-2 px-2 py-2 rounded-lg mb-1 ${mine ? 'bg-black/10' : 'bg-slate-100'}`}
        data-testid={`webapp-voice-${msgId}-loading`}
      >
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-xs">{durationLabel}</span>
      </div>
    );
  }
  return (
    <div className="mb-1" data-testid={`webapp-voice-${msgId}`}>
      {/* Native <audio controls> per B4b spec — no waveform, no custom UI. */}
      <audio controls preload="metadata" src={blobUrl} className="max-w-[260px]" />
      <p className={`text-[10px] mt-0.5 ${mine ? 'text-black/60' : 'text-slate-500'}`}>
        🎤 {durationLabel}
      </p>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────
// Sprint B4c — Reactions row (web)
// ─────────────────────────────────────────────────────────────────

interface ReactionsRowProps {
  messageId: string;
  mine: boolean;
  reactions: readonly ChatReaction[];
  onToggle: (mid: string, emoji: ChatReactionEmoji, reactedByMe: boolean) => void;
}

function ReactionsRow({ messageId, mine, reactions, onToggle }: ReactionsRowProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  if (reactions.length === 0 && !pickerOpen) {
    // Empty state — only the "+" affordance, kept low-contrast so it
    // doesn't pull focus from message content. Aligns to bubble side.
    return (
      <div className={`flex ${mine ? 'justify-end' : 'justify-start'} mt-0.5 px-1`}>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          data-testid={`webapp-msg-${messageId}-react-add`}
          className="text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full w-5 h-5 inline-flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100"
          aria-label="Добавить реакцию"
          title="Добавить реакцию"
        >
          <Plus className="w-3 h-3" />
        </button>
      </div>
    );
  }
  return (
    <div
      className={`flex flex-wrap items-center gap-1 mt-1 px-1 ${mine ? 'justify-end' : 'justify-start'}`}
      data-testid={`webapp-msg-${messageId}-reactions`}
    >
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => onToggle(messageId, r.emoji as ChatReactionEmoji, r.reactedByMe)}
          data-testid={`webapp-msg-${messageId}-react-${r.emoji}`}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-xs transition-colors ${
            r.reactedByMe
              ? 'bg-yellow-100 border-yellow-400 text-black'
              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
          }`}
          aria-pressed={r.reactedByMe}
          title={r.reactedByMe ? 'Убрать реакцию' : 'Добавить реакцию'}
        >
          <span>{r.emoji}</span>
          {r.count > 1 && <span className="font-semibold">{r.count}</span>}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setPickerOpen((x) => !x)}
        data-testid={`webapp-msg-${messageId}-react-add`}
        className="text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full w-5 h-5 inline-flex items-center justify-center"
        aria-label={pickerOpen ? 'Закрыть выбор' : 'Добавить реакцию'}
        title={pickerOpen ? 'Закрыть' : 'Добавить реакцию'}
      >
        {pickerOpen ? <XIcon className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
      </button>
      {pickerOpen && (
        <div
          className="inline-flex items-center gap-1 px-1.5 py-1 rounded-full bg-white border border-slate-200 shadow-sm"
          data-testid={`webapp-msg-${messageId}-react-picker`}
        >
          {REACTION_EMOJIS.map((emoji) => {
            const existing = reactions.find((r) => r.emoji === emoji);
            const reactedByMe = !!existing?.reactedByMe;
            return (
              <button
                key={emoji}
                type="button"
                onClick={() => onToggle(messageId, emoji, reactedByMe)}
                data-testid={`webapp-msg-${messageId}-react-pick-${emoji}`}
                className={`text-base leading-none p-1 rounded hover:bg-slate-100 ${reactedByMe ? 'bg-yellow-50' : ''}`}
                aria-pressed={reactedByMe}
              >
                {emoji}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


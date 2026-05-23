/**
 * Sprint 3 Step 2 — Admin Inbox (timeline-projected notifications).
 *
 * Separate page from /notifications (which is broadcast-template ops).
 * This page is the admin's user-facing inbox — exactly the same projection
 * the mobile inspector sees, but scoped to admin recipients (fan-out).
 *
 * Polling = 25s. Single source: `/api/notifications/since?after=…&limit=50`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Check, RefreshCcw, ExternalLink, ShieldCheck, AlertTriangle, FileText } from 'lucide-react';
import axios from 'axios';

const POLL_MS = 25_000;

const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use((cfg) => {
  const t = localStorage.getItem('admin_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

interface N {
  id: string;
  kind: string;
  type?: string;
  title: string;
  body: string;
  severity: 'info' | 'success' | 'warning' | 'critical';
  metadata?: any;
  isRead: boolean;
  createdAt: string;
  actionUrl?: string | null;
  actorLabel?: string | null;
  sourceTimelineId?: string;
}

const KIND_ICON: Record<string, any> = {
  verification_submitted: ShieldCheck,
  verification_approved:  ShieldCheck,
  verification_rejected:  ShieldCheck,
  report_submitted:       FileText,
  report_approved:        FileText,
  report_rejected:        FileText,
  customer_disputed:      AlertTriangle,
};

const TONE: Record<string, string> = {
  info:     'border-zinc-700 bg-zinc-900',
  success:  'border-emerald-700 bg-emerald-950/30',
  warning:  'border-amber-700 bg-amber-950/30',
  critical: 'border-rose-700 bg-rose-950/30',
};

export default function AdminInboxPage() {
  const [items, setItems] = useState<N[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useRef(true);

  const fetchSince = useCallback(async (afterIso?: string, reset = false) => {
    try {
      const res = await api.get('/notifications/since', {
        params: { ...(afterIso ? { after: afterIso } : {}), limit: 50 },
      });
      if (!isMounted.current) return;
      const fresh: N[] = res.data?.items || [];
      setUnread(res.data?.unread || 0);
      if (reset) {
        setItems(fresh);
      } else {
        setItems((cur) => {
          const seen = new Set(cur.map((x) => x.id));
          const additions = fresh.filter((x) => !seen.has(x.id));
          return additions.length ? [...additions, ...cur] : cur;
        });
      }
    } catch { /* polling is best-effort */ }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    fetchSince(undefined, true).then(() => setLoading(false));
    const tick = () => {
      // capture newest seen createdAt at tick-time
      setItems((cur) => {
        fetchSince(cur[0]?.createdAt);
        return cur;
      });
      pollTimer.current = setTimeout(tick, POLL_MS);
    };
    pollTimer.current = setTimeout(tick, POLL_MS);
    return () => {
      isMounted.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [fetchSince]);

  const markRead = async (n: N) => {
    setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
    setUnread((u) => Math.max(0, u - (n.isRead ? 0 : 1)));
    try { await api.post(`/notifications/${n.id}/read`); } catch { /* */ }
  };

  const markAll = async () => {
    setItems((cur) => cur.map((x) => ({ ...x, isRead: true })));
    setUnread(0);
    try { await api.post('/notifications/read-all'); } catch { /* */ }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto" data-testid="admin-inbox-page">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Bell className="w-7 h-7 text-amber-400" />
            Inbox {unread > 0 && (
              <span className="ml-1 px-2 py-0.5 bg-amber-500 text-black rounded-full text-xs font-black">
                {unread}
              </span>
            )}
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Проекция timeline-событий: новые проверки, отчёты, споры. Polling 25 с.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchSince(undefined, true)}
            className="flex items-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-sm text-zinc-200"
            data-testid="inbox-refresh"
          >
            <RefreshCcw className="w-4 h-4" /> Обновить
          </button>
          {unread > 0 && (
            <button
              onClick={markAll}
              className="flex items-center gap-2 px-3 py-2 bg-amber-500 hover:bg-amber-400 rounded text-sm text-black font-bold"
              data-testid="inbox-mark-all"
            >
              <Check className="w-4 h-4" /> Все прочитано
            </button>
          )}
        </div>
      </div>

      {loading && items.length === 0 ? (
        <div className="text-center text-zinc-500 py-12">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="text-center text-zinc-500 py-12 border border-dashed border-zinc-800 rounded-xl">
          Inbox пуст — пока нет событий, требующих вашего внимания.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((n) => {
            const Icon = KIND_ICON[n.kind] || Bell;
            return (
              <div
                key={n.id}
                className={`p-4 rounded-xl border ${TONE[n.severity] || TONE.info} ${!n.isRead ? 'ring-1 ring-amber-500/30' : ''}`}
                data-testid={`inbox-row-${n.id}`}
              >
                <div className="flex items-start gap-3">
                  <Icon className="w-5 h-5 text-zinc-400 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className={`text-zinc-100 ${!n.isRead ? 'font-bold' : 'font-semibold'}`}>
                        {n.title}
                      </div>
                      <div className="text-xs text-zinc-500 shrink-0">
                        {new Date(n.createdAt).toLocaleString('ru-RU')}
                      </div>
                    </div>
                    <div className="text-sm text-zinc-300 mt-1 break-words">{n.body}</div>
                    <div className="flex items-center gap-3 mt-3 text-xs">
                      {n.actionUrl ? (
                        <a
                          href={n.actionUrl.startsWith('/inspector/') ? '#' : n.actionUrl}
                          className="text-amber-400 hover:text-amber-300 flex items-center gap-1"
                          onClick={() => markRead(n)}
                        >
                          <ExternalLink className="w-3 h-3" /> {humanAction(n.actionUrl)}
                        </a>
                      ) : null}
                      {!n.isRead && (
                        <button
                          onClick={() => markRead(n)}
                          className="text-zinc-400 hover:text-zinc-200"
                          data-testid={`inbox-mark-${n.id}`}
                        >
                          Отметить прочитанным
                        </button>
                      )}
                      {n.actorLabel && (
                        <span className="text-zinc-500">от: {n.actorLabel}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function humanAction(url: string): string {
  if (url.startsWith('/inspector/verification')) return 'Открыть верификацию';
  if (url.startsWith('/inspector/job/'))         return 'Открыть задание';
  if (url.startsWith('/inspector/jobs'))         return 'Открыть задания';
  if (url.startsWith('/verification-queue'))     return 'Открыть очередь';
  return 'Перейти';
}

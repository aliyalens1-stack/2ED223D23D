/**
 * NotificationsPage (admin) — Sprint A4 canonical surface.
 *
 * Two tabs:
 *   1. Inbox       — admin's own notification timeline (canonical contract)
 *   2. Composer    — minimal broadcast (target: all | role | user)
 *
 * The composer respects the strict A1 contract:
 *   - target: 'all' | { role: NotificationRole[] } | { userId: string }
 *   - fields: title (1..120) + body (1..1000) + severity + optional deepLink
 *   - NOTHING ELSE: no geo, no providerSlug, no cluster, no bulk lists,
 *     no campaigns, no markdown, no attachments, no scheduling.
 *
 * Legacy admin notifications UI (templates / filters / channels) is
 * preserved at `NotificationsPageLegacy.tsx` for ops continuity; routes
 * may be added later if needed.
 */

import { useState, useCallback, useMemo } from 'react';
import {
  Bell, Send, Inbox as InboxIcon, AlertCircle, AlertTriangle, Megaphone, CheckCheck, ExternalLink,
} from 'lucide-react';
import { useNotifications } from '../hooks/useNotifications';
import api from '../services/api';
import type {
  Notification,
  NotificationSeverity,
  NotificationRole,
  AdminNotificationResponse,
} from '@platform/domain/contracts/notification';

type TargetMode = 'all' | 'role' | 'user';

const ROLE_OPTIONS: readonly { value: NotificationRole; label: string }[] = [
  { value: 'customer',  label: 'customer' },
  { value: 'inspector', label: 'inspector (inspector + provider_owner)' },
  { value: 'admin',     label: 'admin (admin + superadmin + operator)' },
];

const TITLE_MIN = 1, TITLE_MAX = 120;
const BODY_MIN = 1, BODY_MAX = 1000;

function relTime(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = Math.max(0, Date.now() - t);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function severityChip(s: NotificationSeverity) {
  if (s === 'critical') {
    return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-300 uppercase">crit</span>;
  }
  if (s === 'warning') {
    return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-500/20 text-yellow-300 uppercase">warn</span>;
  }
  return null;
}

export default function NotificationsPage() {
  const [tab, setTab] = useState<'inbox' | 'composer'>('inbox');

  return (
    <div className="p-6 bg-slate-900 min-h-screen text-white">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/20 rounded-lg">
            <Bell className="w-6 h-6 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Уведомления</h1>
            <p className="text-sm text-slate-400">Canonical inbox + минимальный composer (Sprint A4)</p>
          </div>
        </div>
      </div>

      <div className="flex gap-2 mb-6">
        <button
          type="button"
          onClick={() => setTab('inbox')}
          data-testid="admin-notif-tab-inbox"
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
            tab === 'inbox' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
        >
          <InboxIcon className="w-4 h-4" /> Inbox
        </button>
        <button
          type="button"
          onClick={() => setTab('composer')}
          data-testid="admin-notif-tab-composer"
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
            tab === 'composer' ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
        >
          <Send className="w-4 h-4" /> Composer
        </button>
      </div>

      {tab === 'inbox' ? <InboxPanel /> : <ComposerPanel />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Inbox — canonical reader
// ─────────────────────────────────────────────────────────────────────

function InboxPanel() {
  const { notifications, unreadCount, loading, error, refresh, markRead, markAllRead } =
    useNotifications(true);
  const [busy, setBusy] = useState(false);

  const onRefresh = useCallback(async () => {
    setBusy(true);
    try { await refresh(); } finally { setBusy(false); }
  }, [refresh]);

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
        <div className="text-sm text-slate-300">
          {loading && notifications.length === 0
            ? 'Загрузка…'
            : <>Всего: <strong className="text-white">{notifications.length}</strong> · непрочитано:{' '}
                <strong className="text-indigo-300">{unreadCount}</strong></>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? 'Обновляю…' : 'Обновить'}
          </button>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => { void markAllRead(); }}
              data-testid="admin-notif-mark-all"
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 inline-flex items-center gap-1"
            >
              <CheckCheck className="w-3 h-3" /> Все как прочитанные
            </button>
          )}
        </div>
      </div>

      {error && notifications.length === 0 && (
        <div className="p-6 text-center text-red-300 text-sm flex flex-col items-center gap-2">
          <AlertCircle className="w-6 h-6" /> {error === 'network' ? 'Нет соединения' : error}
        </div>
      )}

      {notifications.length === 0 && !error && !loading && (
        <div className="p-10 text-center text-slate-400">
          <Bell className="w-10 h-10 mx-auto mb-2 text-slate-600" />
          <p>Пока ничего не пришло</p>
        </div>
      )}

      <div className="divide-y divide-slate-700/60">
        {notifications.map((n) => (
          <InboxRow key={n.id} n={n} onMarkRead={markRead} />
        ))}
      </div>
    </div>
  );
}

function InboxRow({ n, onMarkRead }: { n: Notification; onMarkRead: (id: string) => Promise<void> }) {
  const onClick = async () => {
    if (!n.isRead) await onMarkRead(n.id);
    if (n.actionUrl && !n.actionUrl.startsWith('http')) {
      // Internal admin link — open in same tab via location for now.
      window.location.assign(n.actionUrl);
    } else if (n.actionUrl) {
      window.open(n.actionUrl, '_blank', 'noopener,noreferrer');
    }
  };
  return (
    <button
      type="button"
      onClick={() => { void onClick(); }}
      data-testid={`admin-notif-row-${n.id}`}
      className={`w-full text-left px-4 py-3 hover:bg-slate-700/50 transition-colors flex items-start gap-3 ${
        !n.isRead ? 'bg-slate-700/30' : ''
      }`}
    >
      {!n.isRead && (
        <span className="mt-2 inline-block h-2 w-2 rounded-full bg-indigo-400 shrink-0" />
      )}
      <div className={`flex-1 min-w-0 ${n.isRead ? 'pl-4' : ''}`}>
        <div className="flex items-center gap-2">
          <p className="font-semibold truncate">{n.title || '(без заголовка)'}</p>
          {severityChip(n.severity)}
          {n.kind === 'admin_broadcast' && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300 uppercase inline-flex items-center gap-1">
              <Megaphone className="w-2.5 h-2.5" /> broadcast
            </span>
          )}
        </div>
        {n.body && <p className="text-sm text-slate-400 mt-1 line-clamp-2">{n.body}</p>}
        <p className="text-xs text-slate-500 mt-1.5">{relTime(n.createdAt)}</p>
      </div>
      {n.actionUrl && <ExternalLink className="w-4 h-4 text-slate-500 shrink-0 mt-1" />}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Composer — minimal canonical send
// ─────────────────────────────────────────────────────────────────────

interface SendResult {
  ok: true;
  eventId: string;
  recipients: number;
  projected: number;
}

function ComposerPanel() {
  const [targetMode, setTargetMode] = useState<TargetMode>('all');
  const [selectedRoles, setSelectedRoles] = useState<Record<NotificationRole, boolean>>({
    customer: false,
    inspector: false,
    admin: false,
  });
  const [userId, setUserId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<NotificationSeverity>('info');
  const [deepLink, setDeepLink] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const titleLen = title.trim().length;
  const bodyLen = body.trim().length;
  const rolesArr: NotificationRole[] = useMemo(
    () => (Object.entries(selectedRoles) as [NotificationRole, boolean][])
      .filter(([, v]) => v).map(([k]) => k),
    [selectedRoles],
  );

  const titleValid = titleLen >= TITLE_MIN && titleLen <= TITLE_MAX;
  const bodyValid = bodyLen >= BODY_MIN && bodyLen <= BODY_MAX;
  const targetValid =
    targetMode === 'all'
      ? true
      : targetMode === 'role'
        ? rolesArr.length > 0
        : userId.trim().length > 0;
  const canSubmit = titleValid && bodyValid && targetValid && !submitting;

  const buildTarget = () => {
    if (targetMode === 'all') return { type: 'all' as const };
    if (targetMode === 'role') return { type: 'role' as const, roles: rolesArr };
    return { type: 'user' as const, userId: userId.trim() };
  };

  const handleSend = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);
    setErrorMsg(null);
    try {
      const payload: Record<string, unknown> = {
        target: buildTarget(),
        title: title.trim(),
        body: body.trim(),
        severity,
      };
      if (deepLink.trim()) payload.deepLink = deepLink.trim();
      const res = await api.post<AdminNotificationResponse>('/admin/notifications/send', payload);
      setResult({
        ok: true,
        eventId: res.data.eventId,
        recipients: res.data.recipients,
        projected: res.data.projected,
      });
      // Reset content; keep target choice for batch-sending.
      setTitle('');
      setBody('');
      setDeepLink('');
    } catch (e: any) {
      setErrorMsg(e?.message || e?.original?.response?.data?.message || 'Не удалось отправить');
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, targetMode, rolesArr, userId, title, body, severity, deepLink]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Composer */}
      <div className="lg:col-span-2 bg-slate-800 border border-slate-700 rounded-xl p-6 space-y-5">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Send className="w-5 h-5 text-indigo-400" /> Новый broadcast
        </h2>

        <div>
          <label className="block text-sm text-slate-400 mb-1">
            Заголовок ({titleLen}/{TITLE_MAX})
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX + 10))}
            data-testid="admin-notif-title"
            placeholder="Plat maintenance"
            className={`w-full bg-slate-700 border rounded-lg px-4 py-2 text-white placeholder-slate-500 ${
              title && !titleValid ? 'border-red-500' : 'border-slate-600'
            }`}
          />
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1">
            Сообщение ({bodyLen}/{BODY_MAX})
          </label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX + 50))}
            data-testid="admin-notif-body"
            placeholder="We will be redeploying at 02:00 UTC. Expect 60s downtime."
            rows={5}
            className={`w-full bg-slate-700 border rounded-lg px-4 py-2 text-white placeholder-slate-500 resize-none ${
              body && !bodyValid ? 'border-red-500' : 'border-slate-600'
            }`}
          />
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1">Severity</label>
          <div className="flex gap-2">
            {(['info', 'warning', 'critical'] as const).map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => setSeverity(s)}
                data-testid={`admin-notif-sev-${s}`}
                className={`flex-1 px-3 py-2 rounded-lg text-sm capitalize border ${
                  severity === s
                    ? s === 'critical' ? 'bg-red-500/20 border-red-500 text-red-200'
                      : s === 'warning' ? 'bg-yellow-500/20 border-yellow-500 text-yellow-200'
                      : 'bg-indigo-500/20 border-indigo-500 text-indigo-200'
                    : 'bg-slate-700 border-slate-600 text-slate-400 hover:text-white'
                }`}
              >
                {s === 'critical' && <AlertCircle className="inline w-3.5 h-3.5 mr-1" />}
                {s === 'warning' && <AlertTriangle className="inline w-3.5 h-3.5 mr-1" />}
                {s}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-1">
            Deep-link (опц.)
            <span className="text-xs text-slate-500 ml-1">— куда тапнуть открывает</span>
          </label>
          <input
            type="text"
            value={deepLink}
            onChange={(e) => setDeepLink(e.target.value)}
            placeholder="/status или /inspector/jobs/ij_123"
            data-testid="admin-notif-deeplink"
            className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white placeholder-slate-500"
          />
        </div>

        {errorMsg && (
          <div className="p-3 rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" /> {errorMsg}
          </div>
        )}
        {result && (
          <div className="p-3 rounded-lg bg-green-500/20 border border-green-500/40 text-green-300 text-sm" data-testid="admin-notif-result">
            ✓ eventId <span className="font-mono">{result.eventId}</span> · получателей: <strong>{result.recipients}</strong> · доставлено: <strong>{result.projected}</strong>
          </div>
        )}

        <button
          type="button"
          onClick={() => { void handleSend(); }}
          disabled={!canSubmit}
          data-testid="admin-notif-send"
          className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          {submitting ? (
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
          ) : (
            <>
              <Send className="w-4 h-4" /> Отправить
            </>
          )}
        </button>
      </div>

      {/* Targeting (right column) */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Target</h2>

        <div className="space-y-2 mb-4">
          {(['all', 'role', 'user'] as const).map((mode) => (
            <label
              key={mode}
              className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer border ${
                targetMode === mode ? 'bg-indigo-500/10 border-indigo-500/40' : 'border-transparent hover:bg-slate-700'
              }`}
            >
              <input
                type="radio"
                name="targetMode"
                value={mode}
                checked={targetMode === mode}
                onChange={() => setTargetMode(mode)}
                data-testid={`admin-notif-target-${mode}`}
                className="accent-indigo-500"
              />
              <span className="text-sm capitalize">{mode}</span>
              {mode === 'all' && <span className="text-xs text-slate-500">— все авторизованные</span>}
              {mode === 'role' && <span className="text-xs text-slate-500">— по ролям</span>}
              {mode === 'user' && <span className="text-xs text-slate-500">— один пользователь</span>}
            </label>
          ))}
        </div>

        {targetMode === 'role' && (
          <div className="space-y-1.5 mt-3">
            {ROLE_OPTIONS.map((r) => (
              <label key={r.value} className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedRoles[r.value]}
                  onChange={(e) => setSelectedRoles((prev) => ({ ...prev, [r.value]: e.target.checked }))}
                  data-testid={`admin-notif-role-${r.value}`}
                  className="mt-0.5 accent-indigo-500"
                />
                <span className="text-slate-300">{r.label}</span>
              </label>
            ))}
            {rolesArr.length === 0 && (
              <p className="text-xs text-red-400 mt-2">Выберите хотя бы одну роль</p>
            )}
          </div>
        )}

        {targetMode === 'user' && (
          <div className="mt-3">
            <label className="block text-xs text-slate-400 mb-1">userId (hex)</label>
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              data-testid="admin-notif-userid"
              placeholder="6a0...c18"
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm font-mono"
            />
          </div>
        )}

        <div className="mt-6 p-3 rounded-lg bg-slate-700/40 text-xs text-slate-400">
          <p className="font-semibold text-slate-300 mb-1">Что НЕ поддерживается:</p>
          <ul className="space-y-0.5 list-disc pl-4">
            <li>geo / cluster / providerSlug</li>
            <li>bulk lists / query builder</li>
            <li>markdown / attachments / scheduling</li>
            <li>чат / typing / disputes</li>
          </ul>
          <p className="mt-2 text-slate-500">Это операционный broadcast, не маркетинговая кампания.</p>
        </div>
      </div>
    </div>
  );
}

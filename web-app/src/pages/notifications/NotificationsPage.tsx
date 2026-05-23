/**
 * NotificationsPage (web-app) — Sprint A4.
 *
 * Full notifications list page. Same canonical wire shape, same polling
 * transport (`useNotifications()` from web-app hooks). Used by both the
 * Customer shell (`/account/notifications`) and the Operator shell
 * (`/provider/notifications`). Composition is identical — surfaces only
 * differ in how they're routed in.
 *
 * Explicitly NOT here (deferred):
 *   - composer / send UI — admin-only, lives in /admin-panel/notifications
 *   - filters / search / pagination beyond the 50-item cache cap
 *   - chat integration / threading
 */

import { useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bell, Check, ChevronLeft, AlertCircle, AlertTriangle, Megaphone, MessageSquare, CreditCard, Gift,
} from 'lucide-react';
import { useNotifications } from '../../hooks/useNotifications';
import type { Notification, NotificationSeverity } from '@platform/domain/contracts/notification';

function relTime(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = Math.max(0, Date.now() - t);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} дн назад`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function iconFor(kind: string, severity: NotificationSeverity) {
  if (severity === 'critical') return { Icon: AlertCircle, color: 'text-red-600 bg-red-50' };
  if (severity === 'warning') return { Icon: AlertTriangle, color: 'text-amber-600 bg-amber-50' };
  switch (kind) {
    case 'admin_broadcast': return { Icon: Megaphone, color: 'text-indigo-600 bg-indigo-50' };
    case 'support_reply':
    case 'support_message':
    case 'provider_reply': return { Icon: MessageSquare, color: 'text-blue-600 bg-blue-50' };
    case 'payment_paid':   return { Icon: CreditCard,    color: 'text-green-600 bg-green-50' };
    case 'promo':          return { Icon: Gift,          color: 'text-pink-600 bg-pink-50' };
    default:               return { Icon: Bell,          color: 'text-slate-600 bg-slate-100' };
  }
}

export default function NotificationsPage() {
  const navigate = useNavigate();
  const { notifications, unreadCount, loading, error, refresh, markRead, markAllRead } =
    useNotifications(true);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const onItemClick = useCallback(async (n: Notification) => {
    if (!n.isRead) {
      void markRead(n.id);
    }
    if (n.actionUrl) {
      if (n.actionUrl.startsWith('http')) {
        window.open(n.actionUrl, '_blank', 'noopener,noreferrer');
      } else {
        navigate(n.actionUrl);
      }
    }
  }, [markRead, navigate]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:py-8" data-testid="webapp-notifications-page">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Link
            to="/"
            data-testid="notifications-back"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg hover:bg-slate-100 text-slate-600"
            aria-label="Назад"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            Уведомления
            {unreadCount > 0 && (
              <span
                data-testid="notifications-unread-pill"
                className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-yellow-400 text-black text-xs font-bold"
              >
                {unreadCount >= 100 ? '99+' : unreadCount}
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            data-testid="notifications-refresh"
            className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
          >
            {refreshing ? 'Обновляю…' : 'Обновить'}
          </button>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => { void markAllRead(); }}
              data-testid="notifications-mark-all"
              className="text-sm px-3 py-1.5 rounded-lg bg-yellow-400 text-black font-semibold hover:bg-yellow-300 inline-flex items-center gap-1"
            >
              <Check className="w-4 h-4" /> Все как прочитанные
            </button>
          )}
        </div>
      </div>

      {loading && notifications.length === 0 ? (
        <div className="flex items-center justify-center py-16" data-testid="notifications-loading">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-400" />
        </div>
      ) : error && notifications.length === 0 ? (
        <div className="text-center py-16" data-testid="notifications-error">
          <AlertCircle className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <p className="text-slate-600 mb-3">
            {error === 'network' ? 'Нет соединения' : 'Не удалось загрузить уведомления'}
          </p>
          <button
            type="button"
            onClick={onRefresh}
            className="text-sm px-4 py-2 rounded-lg bg-slate-900 text-white"
          >
            Повторить
          </button>
        </div>
      ) : notifications.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed border-slate-200 rounded-2xl" data-testid="notifications-empty">
          <Bell className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <p className="text-slate-700 font-semibold">Пока ничего нет</p>
          <p className="text-sm text-slate-500 mt-1">
            Здесь появятся обновления заявок, ответы поддержки и важные оповещения.
          </p>
        </div>
      ) : (
        <ul className="space-y-2" data-testid="notifications-list">
          {notifications.map((n) => {
            const { Icon, color } = iconFor(n.kind || '', n.severity);
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => { void onItemClick(n); }}
                  data-testid={`notification-${n.id}`}
                  className={`w-full text-left flex items-start gap-3 p-4 rounded-xl border transition-colors ${
                    n.isRead
                      ? 'bg-white border-slate-200 hover:bg-slate-50'
                      : 'bg-yellow-50/60 border-yellow-200 hover:bg-yellow-50'
                  }`}
                >
                  <div className={`shrink-0 w-10 h-10 rounded-lg ${color} flex items-center justify-center`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-900 truncate">
                        {n.title || '(без заголовка)'}
                      </h3>
                      {n.severity === 'critical' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700 uppercase">
                          critical
                        </span>
                      )}
                      {n.severity === 'warning' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700 uppercase">
                          warn
                        </span>
                      )}
                      {!n.isRead && (
                        <span
                          className="inline-block h-2 w-2 rounded-full bg-yellow-500 shrink-0"
                          aria-label="непрочитано"
                        />
                      )}
                    </div>
                    {n.body && (
                      <p className="text-sm text-slate-600 mt-1 line-clamp-2">{n.body}</p>
                    )}
                    <p className="text-xs text-slate-400 mt-1.5">{relTime(n.createdAt)}</p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

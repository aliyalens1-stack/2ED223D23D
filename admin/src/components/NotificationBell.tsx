/**
 * NotificationBell — admin header bell + minimal dropdown (Sprint A3c).
 *
 * MINIMAL by design. Shows:
 *   - bell icon with unread badge
 *   - dropdown with latest 10 notifications
 *   - unread highlighting
 *   - open actionUrl on click (and mark-read)
 *   - "mark all read" link
 *
 * Explicitly NOT in scope (deferred per doctrine):
 *   - composer / filters / moderation / categories / chat integration
 *   - websocket / live toasts
 *   - full inbox page (that lands in A4 — `pages/NotificationsPage.tsx`)
 */

import { useEffect, useRef, useState } from 'react';
import { Bell, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../hooks/useNotifications';
import type { Notification } from '@platform/domain/contracts/notification';

/**
 * Badge format contract — IDENTICAL across mobile, web-app, admin:
 *   0       → no badge
 *   1..99   → exact number
 *   100+    → "99+"
 * Copied (not abstracted) per doctrine — three call sites, three tiny copies.
 */
function formatBadgeCount(n: number): string {
  if (n >= 100) return '99+';
  return String(n);
}

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

const DROPDOWN_LIMIT = 10;

interface Props {
  enabled?: boolean;
}

export default function NotificationBell({ enabled = true }: Props) {
  const { unreadCount, notifications, markRead, markAllRead, loading } =
    useNotifications(enabled);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  // Click outside / Escape closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onItemClick = async (n: Notification) => {
    setOpen(false);
    if (!n.isRead) {
      await markRead(n.id);
    }
    if (n.actionUrl) {
      // Internal admin routes — strip the /api/admin-panel prefix if it
      // accidentally arrived from a deepLink, so react-router can handle it.
      let target = n.actionUrl;
      if (target.startsWith('/api/admin-panel')) {
        target = target.slice('/api/admin-panel'.length) || '/';
      }
      if (target.startsWith('http')) {
        window.open(target, '_blank', 'noopener,noreferrer');
      } else {
        navigate(target);
      }
    }
  };

  if (!enabled) return null;

  const top = notifications.slice(0, DROPDOWN_LIMIT);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="admin-bell-btn"
        aria-label="Notifications"
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span
            data-testid="admin-bell-badge"
            className="absolute -top-1 -right-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white"
          >
            {formatBadgeCount(unreadCount)}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="admin-bell-dropdown"
          className="absolute right-0 mt-2 w-[360px] max-h-[440px] overflow-hidden rounded-xl border border-slate-700 bg-slate-800 shadow-2xl z-50 flex flex-col"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">Уведомления</span>
              {unreadCount > 0 && (
                <span className="text-xs text-slate-400">
                  ({unreadCount} непрочитан{unreadCount === 1 ? 'о' : (unreadCount < 5 ? 'ых' : 'ых')})
                </span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => { void markAllRead(); }}
                data-testid="admin-bell-mark-all-read"
                className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300"
              >
                <Check className="w-3 h-3" />
                Все как прочитанные
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading && top.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-slate-500">
                Загрузка...
              </div>
            )}
            {!loading && top.length === 0 && (
              <div className="px-4 py-8 text-center">
                <Bell className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                <p className="text-sm text-slate-400">Пока ничего нет</p>
              </div>
            )}
            {top.map((n) => (
              <button
                type="button"
                key={n.id}
                onClick={() => { void onItemClick(n); }}
                data-testid={`admin-bell-item-${n.id}`}
                className={`w-full text-left px-4 py-3 border-b border-slate-700/50 hover:bg-slate-700 transition-colors ${
                  !n.isRead ? 'bg-slate-700/40' : ''
                }`}
              >
                <div className="flex items-start gap-2">
                  {!n.isRead && (
                    <span
                      className="mt-1.5 inline-block h-2 w-2 rounded-full bg-indigo-400 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <div className={`flex-1 min-w-0 ${n.isRead ? 'pl-4' : ''}`}>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-white truncate">
                        {n.title || '(без заголовка)'}
                      </p>
                      {n.severity === 'critical' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/30 text-red-300 uppercase tracking-wide shrink-0">
                          crit
                        </span>
                      )}
                      {n.severity === 'warning' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-500/30 text-yellow-300 uppercase tracking-wide shrink-0">
                          warn
                        </span>
                      )}
                    </div>
                    {n.body && (
                      <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{n.body}</p>
                    )}
                    <p className="text-[11px] text-slate-500 mt-1">{relTime(n.createdAt)}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="border-t border-slate-700 px-4 py-2.5 text-center">
            <button
              type="button"
              onClick={() => { setOpen(false); navigate('/notifications'); }}
              data-testid="admin-bell-view-all"
              className="text-xs text-indigo-400 hover:text-indigo-300"
            >
              Открыть все уведомления →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

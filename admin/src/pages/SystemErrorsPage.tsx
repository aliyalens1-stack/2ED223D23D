import { useState, useEffect, useMemo } from 'react';
import {
  AlertOctagon,
  RefreshCw,
  TrendingUp,
  Clock,
  Search,
  Activity,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { systemAPI, type SystemErrorItem, type SystemErrorStats } from '../services/api';

export default function SystemErrorsPage() {
  const [stats, setStats] = useState<SystemErrorStats | null>(null);
  const [items, setItems] = useState<SystemErrorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [levelFilter, setLevelFilter] = useState<'' | 'error' | 'warn'>('');
  const [routeFilter, setRouteFilter] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [sRes, eRes] = await Promise.all([
        systemAPI.getErrorStats(),
        systemAPI.getErrors({
          level: levelFilter || undefined,
          route: routeFilter || undefined,
          limit: 100,
        }),
      ]);
      setStats(sRes.data);
      setItems(eRes.data.items || []);
    } catch (err: any) {
      console.error('Failed to load system errors:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [levelFilter]);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [autoRefresh, levelFilter, routeFilter]);

  const maxTimelineCount = useMemo(
    () => Math.max(1, ...(stats?.timeline || []).map((b) => b.count)),
    [stats],
  );

  return (
    <div className="p-6 bg-slate-900 min-h-screen" data-testid="system-errors-page">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-red-500/20 rounded-lg">
            <AlertOctagon className="w-6 h-6 text-red-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">System Errors</h1>
            <p className="text-sm text-slate-400">
              Sprint 6 — единый слой observability (fastapi + nestjs)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              data-testid="toggle-auto-refresh"
            />
            auto 15s
          </label>
          <button
            data-testid="refresh-errors"
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Обновить
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <KpiCard
          icon={<TrendingUp className="w-4 h-4" />}
          label="Errors / min (5m avg)"
          value={stats?.errorRate ?? 0}
          color="red"
          testId="kpi-error-rate"
        />
        <KpiCard
          icon={<AlertTriangle className="w-4 h-4" />}
          label="Errors (last 5 min)"
          value={stats?.errorsLast5Min ?? 0}
          color="amber"
          testId="kpi-errors-5min"
        />
        <KpiCard
          icon={<XCircle className="w-4 h-4" />}
          label="Total errors (live)"
          value={stats?.countersLive?.total ?? 0}
          color="rose"
          testId="kpi-errors-total"
        />
        <KpiCard
          icon={<Activity className="w-4 h-4" />}
          label="Unique codes"
          value={(stats?.topCodes || []).length}
          color="cyan"
          testId="kpi-error-codes"
        />
      </div>

      {/* Timeline */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-4 h-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-200">
            Error timeline — последние 60 минут (bucket 5 мин)
          </h2>
        </div>
        <div className="flex items-end gap-1 h-28" data-testid="error-timeline">
          {(stats?.timeline || []).map((b, i) => {
            const h = Math.round((b.count / maxTimelineCount) * 100);
            const color = b.count > 10 ? 'bg-red-500' : b.count > 2 ? 'bg-amber-500' : 'bg-emerald-500/70';
            return (
              <div key={i} className="flex-1 flex flex-col items-center group" title={`${b.count} errors`}>
                <div className="w-full rounded-t-sm bg-slate-700 flex items-end overflow-hidden" style={{ height: '100%' }}>
                  <div
                    className={`${color} w-full transition-all`}
                    style={{ height: `${Math.max(2, h)}%` }}
                  />
                </div>
                <span className="text-[10px] text-slate-500 mt-1">{b.count}</span>
              </div>
            );
          })}
          {!stats?.timeline?.length && (
            <div className="flex-1 text-center text-sm text-slate-500">нет данных</div>
          )}
        </div>
      </div>

      {/* Top tables */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <TopTable
          title="Top error codes (24h)"
          rows={(stats?.topCodes || []).map((c) => ({
            left: c.code,
            right: c.count,
            sub: c.lastMessage,
          }))}
          testId="top-codes"
        />
        <TopTable
          title="Top affected routes (24h)"
          rows={(stats?.topRoutes || []).map((r) => ({
            left: r.route,
            right: r.count,
          }))}
          testId="top-routes"
        />
      </div>

      {/* Raw logs */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-700 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-200 flex-1">Raw system_logs</h2>
          <select
            data-testid="filter-level"
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value as '' | 'error' | 'warn')}
            className="bg-slate-700 text-slate-100 text-sm rounded px-3 py-1.5 border border-slate-600"
          >
            <option value="">all (error+warn)</option>
            <option value="error">error only</option>
            <option value="warn">warn only</option>
          </select>
          <div className="flex items-center gap-1 bg-slate-700 rounded px-2 py-1 border border-slate-600">
            <Search className="w-4 h-4 text-slate-400" />
            <input
              data-testid="filter-route"
              value={routeFilter}
              onChange={(e) => setRouteFilter(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
              placeholder="route regex…"
              className="bg-transparent text-sm text-slate-100 outline-none w-40"
            />
          </div>
        </div>
        <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
          <table className="w-full text-sm" data-testid="errors-table">
            <thead className="bg-slate-900/80 text-slate-400 sticky top-0">
              <tr>
                <th className="p-2 text-left">time</th>
                <th className="p-2 text-left">lvl</th>
                <th className="p-2 text-left">code</th>
                <th className="p-2 text-left">route</th>
                <th className="p-2 text-left">status</th>
                <th className="p-2 text-left">duration</th>
                <th className="p-2 text-left">message</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t border-slate-700/60 hover:bg-slate-700/20">
                  <td className="p-2 text-slate-400 whitespace-nowrap">
                    {it.timestamp ? new Date(it.timestamp).toLocaleTimeString() : '—'}
                  </td>
                  <td className="p-2">
                    <LevelBadge level={it.level} />
                  </td>
                  <td className="p-2 font-mono text-xs text-amber-300">{it.errorCode || '—'}</td>
                  <td className="p-2 text-slate-300 font-mono text-xs">
                    <span className="text-slate-500">{it.method}</span> {it.route}
                  </td>
                  <td className="p-2 text-slate-300">{it.status ?? '—'}</td>
                  <td className="p-2 text-slate-400">{it.durationMs ? `${it.durationMs}ms` : '—'}</td>
                  <td className="p-2 text-slate-300 max-w-xl truncate" title={it.message}>
                    {it.message}
                  </td>
                </tr>
              ))}
              {!items.length && !loading && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-slate-500">
                    нет записей
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  color,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  color: 'red' | 'amber' | 'rose' | 'cyan';
  testId: string;
}) {
  const palette: Record<string, string> = {
    red: 'text-red-400 bg-red-500/10 border-red-500/30',
    amber: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    rose: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
    cyan: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  };
  return (
    <div className={`rounded-xl border p-4 ${palette[color]}`} data-testid={testId}>
      <div className="flex items-center gap-2 text-slate-300 mb-1">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <span className="text-3xl font-bold">{value}</span>
    </div>
  );
}

function TopTable({
  title,
  rows,
  testId,
}: {
  title: string;
  rows: Array<{ left: string; right: number; sub?: string }>;
  testId: string;
}) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden" data-testid={testId}>
      <div className="px-4 py-3 border-b border-slate-700">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      </div>
      <ul className="divide-y divide-slate-700/50">
        {rows.slice(0, 8).map((r, i) => (
          <li key={i} className="px-4 py-2 flex items-center gap-3 text-sm">
            <span className="text-slate-500 w-5">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="text-slate-200 font-mono text-xs truncate">{r.left}</div>
              {r.sub && <div className="text-slate-500 text-xs truncate">{r.sub}</div>}
            </div>
            <span className="text-amber-400 font-semibold">{r.right}</span>
          </li>
        ))}
        {!rows.length && (
          <li className="p-6 text-center text-slate-500 text-sm">нет данных</li>
        )}
      </ul>
    </div>
  );
}

function LevelBadge({ level }: { level?: string }) {
  const cls =
    level === 'error'
      ? 'bg-red-500/20 text-red-300'
      : level === 'warn'
      ? 'bg-amber-500/20 text-amber-300'
      : 'bg-slate-700/40 text-slate-300';
  return <span className={`px-2 py-0.5 text-[10px] rounded uppercase font-semibold ${cls}`}>{level || '—'}</span>;
}

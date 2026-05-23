// Service Marketplace Exchange — admin UI для единой биржи заявок.
// Backend endpoints из app/service_marketplace/router_admin.py:
//   GET   /api/admin/service-requests
//   GET   /api/admin/service-requests/stats
//   GET   /api/admin/service-requests/{id}
//   POST  /api/admin/service-requests/{id}/assign
//   POST  /api/admin/service-requests/{id}/status
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Briefcase, RefreshCw, X, Filter, Search, MapPin, Euro,
  CheckCircle2, AlertTriangle, Phone, Mail, Clock, User, Tag,
  ChevronRight, Loader2,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────
interface ServiceRequest {
  id: string;
  category: string;
  title: string;
  description?: string;
  city: string;
  status: string;
  urgency: string;
  bidsCount: number;
  createdAt: string;
  updatedAt?: string;
  customerId?: string | null;
  customerName?: string | null;
  contactPhone?: string | null;
  budget?: { min?: number; max?: number; currency: string } | null;
  location?: { lat: number; lng: number; address?: string } | null;
  acceptedBidId?: string | null;
  assignedProviderId?: string | null;
  commissionPct?: number;
  leadFee?: number;
  expiresAt?: string;
}

interface ServiceBid {
  id: string;
  requestId: string;
  providerId: string;
  providerName: string;
  providerRating?: number | null;
  providerPhone?: string | null;
  providerEmail?: string | null;
  price: number;
  currency: string;
  message: string;
  etaMinutes?: number | null;
  status: string;
  createdAt: string;
  adminAssigned?: boolean;
}

interface Stats {
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  total: number;
  categories: string[];
  gmv: number;
  acceptedBidsCount: number;
  avgCommissionPct: number;
  platformRevenue: number;
  currency: string;
}

// ── Constants ─────────────────────────────────────────────────────────────
const CATEGORIES = [
  { key: 'repair',        ru: 'Ремонт',          emoji: '🔧' },
  { key: 'tow',           ru: 'Эвакуатор',        emoji: '🚛' },
  { key: 'wash',          ru: 'Мойка',           emoji: '🚿' },
  { key: 'detailing',     ru: 'Детейлинг',        emoji: '✨' },
  { key: 'battery',       ru: 'Аккумулятор',      emoji: '🔋' },
  { key: 'parts',         ru: 'Запчасти',         emoji: '🔩' },
  { key: 'delivery',      ru: 'Пригон',          emoji: '🚚' },
  { key: 'inspection',    ru: 'Осмотр',          emoji: '🛡' },
  { key: 'car_selection', ru: 'Подбор',          emoji: '🎯' },
];

const STATUSES = [
  'open', 'bidding', 'assigned', 'in_progress', 'completed', 'cancelled', 'expired', 'disputed',
];

const STATUS_META: Record<string, { ru: string; cls: string }> = {
  open:        { ru: 'Открыта',           cls: 'bg-blue-500/15 text-blue-400 border-blue-500/40' },
  bidding:     { ru: 'В торгах',          cls: 'bg-amber-500/15 text-amber-400 border-amber-500/40' },
  assigned:    { ru: 'Назначен',          cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40' },
  in_progress: { ru: 'В работе',          cls: 'bg-sky-500/15 text-sky-400 border-sky-500/40' },
  completed:   { ru: 'Завершена',         cls: 'bg-teal-500/15 text-teal-400 border-teal-500/40' },
  cancelled:   { ru: 'Отменена',          cls: 'bg-slate-500/15 text-slate-400 border-slate-500/40' },
  expired:     { ru: 'Истекла',           cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/40' },
  disputed:    { ru: 'Спор',              cls: 'bg-rose-500/15 text-rose-400 border-rose-500/40' },
};

const URGENCY_META: Record<string, { ru: string; cls: string }> = {
  normal:    { ru: 'Обычная',   cls: 'text-slate-400' },
  urgent:    { ru: 'Срочная',   cls: 'text-amber-400' },
  emergency: { ru: 'Аварийная', cls: 'text-rose-400' },
};

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('admin_token') || '';
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function catLabel(key: string): string {
  return CATEGORIES.find((c) => c.key === key)?.ru || key;
}
function catEmoji(key: string): string {
  return CATEGORIES.find((c) => c.key === key)?.emoji || '📋';
}

// ── Page ──────────────────────────────────────────────────────────────────
export default function ServiceMarketplaceExchange() {
  const [items, setItems] = useState<ServiceRequest[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterCity, setFilterCity] = useState<string>('');
  const [filterHasBids, setFilterHasBids] = useState<string>(''); // '', 'true', 'false'
  const [search, setSearch] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ request: ServiceRequest; bids: ServiceBid[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [actionRunning, setActionRunning] = useState<string | null>(null);

  // Manual-assign form state
  const [assignProviderId, setAssignProviderId] = useState<string>('');
  const [assignNote, setAssignNote] = useState<string>('');

  // ── Load list + stats ───────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterCategory) params.set('category', filterCategory);
      if (filterStatus) params.set('status', filterStatus);
      if (filterCity) params.set('city', filterCity.trim().toLowerCase());
      if (filterHasBids) params.set('has_bids', filterHasBids);
      params.set('limit', '200');

      const [listRes, statsRes] = await Promise.all([
        fetch(`/api/admin/service-requests?${params.toString()}`, { headers: authHeaders() }),
        fetch('/api/admin/service-requests/stats', { headers: authHeaders() }),
      ]);
      if (!listRes.ok) throw new Error(`list HTTP ${listRes.status}`);
      const listData = await listRes.json();
      setItems(listData.requests || []);
      if (statsRes.ok) setStats(await statsRes.json());
    } catch (e: any) {
      setError(e?.message || 'load failed');
    } finally {
      setLoading(false);
    }
  }, [filterCategory, filterStatus, filterCity, filterHasBids]);

  useEffect(() => { load(); }, [load]);

  // ── Filtered (client-side search by title/description/id) ───────────────
  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter((r) =>
      r.id.toLowerCase().includes(q) ||
      (r.title || '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q) ||
      (r.city || '').toLowerCase().includes(q),
    );
  }, [items, search]);

  // ── Open detail panel ───────────────────────────────────────────────────
  const openDetail = async (id: string) => {
    setDetailLoading(true);
    setAssignProviderId('');
    setAssignNote('');
    try {
      const res = await fetch(`/api/admin/service-requests/${id}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`detail HTTP ${res.status}`);
      setDetail(await res.json());
    } catch (e: any) {
      setError(e?.message || 'detail failed');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => setDetail(null);

  // ── Mutations ───────────────────────────────────────────────────────────
  const changeStatus = async (newStatus: string) => {
    if (!detail) return;
    setActionRunning(`status:${newStatus}`);
    try {
      const res = await fetch(`/api/admin/service-requests/${detail.request.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ status: newStatus, note: `Admin set status → ${newStatus}` }),
      });
      if (!res.ok) throw new Error(`status HTTP ${res.status}`);
      await openDetail(detail.request.id);
      await load();
    } catch (e: any) {
      setError(e?.message || 'status failed');
    } finally {
      setActionRunning(null);
    }
  };

  const manualAssign = async () => {
    if (!detail || !assignProviderId.trim()) return;
    setActionRunning('assign');
    try {
      const res = await fetch(`/api/admin/service-requests/${detail.request.id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ providerId: assignProviderId.trim(), note: assignNote.trim() || undefined }),
      });
      if (!res.ok) throw new Error(`assign HTTP ${res.status}`);
      await openDetail(detail.request.id);
      await load();
    } catch (e: any) {
      setError(e?.message || 'assign failed');
    } finally {
      setActionRunning(null);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6" data-testid="service-marketplace-exchange-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center">
            <Briefcase className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Service Marketplace Exchange</h1>
            <p className="text-sm text-slate-400">Биржа всех заявок · 9 категорий · реальные bid'ы</p>
          </div>
        </div>
        <button
          data-testid="sme-refresh-btn"
          onClick={load}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span className="text-sm">Обновить</span>
        </button>
      </div>

      {/* Stats grid */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-6" data-testid="sme-stats-grid">
          <StatCard label="Всего" value={stats.total} testid="sme-stat-total" />
          <StatCard label="Открытые"   value={stats.byStatus.open || 0}        accent="text-blue-400"    testid="sme-stat-open" />
          <StatCard label="В торгах"   value={stats.byStatus.bidding || 0}     accent="text-amber-400"   testid="sme-stat-bidding" />
          <StatCard label="Назначены"  value={stats.byStatus.assigned || 0}    accent="text-emerald-400" testid="sme-stat-assigned" />
          <StatCard label="В работе"   value={stats.byStatus.in_progress || 0} accent="text-sky-400"     testid="sme-stat-in-progress" />
          <StatCard label="Завершены"  value={stats.byStatus.completed || 0}   accent="text-teal-400"    testid="sme-stat-completed" />
          <StatCard label="GMV (EUR)"  value={`€${stats.gmv}`}                  accent="text-yellow-300"  testid="sme-stat-gmv" />
          <StatCard label="Revenue"    value={`€${stats.platformRevenue}`}      accent="text-emerald-300"
                    sub={`avg ${stats.avgCommissionPct}%`}                       testid="sme-stat-revenue" />
        </div>
      )}

      {/* Filters */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4 mb-6">
        <div className="flex items-center gap-2 mb-3 text-slate-400 text-sm">
          <Filter className="w-4 h-4" />
          <span>Фильтры</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">Категория</label>
            <select
              data-testid="sme-filter-category"
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
            >
              <option value="">Все категории</option>
              {CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>{c.emoji} {c.ru}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Статус</label>
            <select
              data-testid="sme-filter-status"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
            >
              <option value="">Все статусы</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_META[s]?.ru || s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Город</label>
            <input
              data-testid="sme-filter-city"
              value={filterCity}
              onChange={(e) => setFilterCity(e.target.value)}
              placeholder="berlin"
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Отклики</label>
            <select
              data-testid="sme-filter-hasbids"
              value={filterHasBids}
              onChange={(e) => setFilterHasBids(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
            >
              <option value="">Все</option>
              <option value="true">С откликами</option>
              <option value="false">Без откликов</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Поиск (ID/заголовок/город)</label>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
              <input
                data-testid="sme-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/40 rounded-lg p-3 mb-4 flex items-start gap-2" data-testid="sme-error">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <span className="text-sm text-rose-300">{error}</span>
        </div>
      )}

      {/* Layout: table on the left, detail on the right */}
      <div className={`grid gap-4 ${detail ? 'grid-cols-1 xl:grid-cols-[1fr_480px]' : 'grid-cols-1'}`}>
        {/* Table */}
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-12 text-center text-slate-400 flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Загрузка…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center text-slate-500">
              Нет заявок по выбранным фильтрам
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="sme-table">
                <thead className="bg-slate-900/60 text-xs text-slate-400 uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold">ID</th>
                    <th className="text-left px-4 py-3 font-semibold">Категория</th>
                    <th className="text-left px-4 py-3 font-semibold">Город</th>
                    <th className="text-left px-4 py-3 font-semibold">Клиент</th>
                    <th className="text-left px-4 py-3 font-semibold">Статус</th>
                    <th className="text-left px-4 py-3 font-semibold">Бюджет</th>
                    <th className="text-left px-4 py-3 font-semibold">Отклики</th>
                    <th className="text-left px-4 py-3 font-semibold">Создано</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const sm = STATUS_META[r.status] || STATUS_META.open;
                    const isActive = detail?.request.id === r.id;
                    return (
                      <tr
                        key={r.id}
                        onClick={() => openDetail(r.id)}
                        className={`border-t border-slate-700/60 cursor-pointer hover:bg-slate-700/30 transition ${isActive ? 'bg-slate-700/40' : ''}`}
                        data-testid={`sme-row-${r.id}`}
                      >
                        <td className="px-4 py-3 font-mono text-xs text-slate-400">{r.id.slice(0, 8)}…</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-2">
                            <span>{catEmoji(r.category)}</span>
                            <span>{catLabel(r.category)}</span>
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-300">{r.city}</td>
                        <td className="px-4 py-3 text-slate-300">
                          {r.customerId ? <span className="text-xs font-mono">{r.customerId.slice(0, 8)}…</span> : <span className="text-slate-500 italic">guest</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${sm.cls}`}>{sm.ru}</span>
                        </td>
                        <td className="px-4 py-3">
                          {r.budget?.min || r.budget?.max ? (
                            <span className="text-amber-300 font-semibold">
                              €{r.budget.min ?? '?'}{r.budget.max ? `–${r.budget.max}` : '+'}
                            </span>
                          ) : <span className="text-slate-500">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`font-bold ${r.bidsCount > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>{r.bidsCount}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs">
                          {new Date(r.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                        </td>
                        <td className="px-4 py-3 text-slate-500">
                          <ChevronRight className="w-4 h-4" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="px-4 py-2 text-xs text-slate-500 border-t border-slate-700/60">
            Показано {filtered.length} из {items.length}{stats ? ` (в БД: ${stats.total})` : ''}
          </div>
        </div>

        {/* Detail panel */}
        {detail && (
          <DetailPanel
            data={detail}
            loading={detailLoading}
            actionRunning={actionRunning}
            assignProviderId={assignProviderId}
            assignNote={assignNote}
            onClose={closeDetail}
            onChangeStatus={changeStatus}
            onAssign={manualAssign}
            onAssignProviderIdChange={setAssignProviderId}
            onAssignNoteChange={setAssignNote}
          />
        )}
      </div>
    </div>
  );
}

// ── StatCard ─────────────────────────────────────────────────────────────
function StatCard({
  label, value, accent, testid, sub,
}: { label: string; value: string | number; accent?: string; testid?: string; sub?: string }) {
  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3" data-testid={testid}>
      <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">{label}</div>
      <div className={`text-xl font-bold ${accent || 'text-slate-100'}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

// ── DetailPanel ──────────────────────────────────────────────────────────
function DetailPanel({
  data, loading, actionRunning, assignProviderId, assignNote,
  onClose, onChangeStatus, onAssign, onAssignProviderIdChange, onAssignNoteChange,
}: {
  data: { request: ServiceRequest; bids: ServiceBid[] };
  loading: boolean;
  actionRunning: string | null;
  assignProviderId: string;
  assignNote: string;
  onClose: () => void;
  onChangeStatus: (s: string) => void;
  onAssign: () => void;
  onAssignProviderIdChange: (v: string) => void;
  onAssignNoteChange: (v: string) => void;
}) {
  const r = data.request;
  const sm = STATUS_META[r.status] || STATUS_META.open;
  const um = URGENCY_META[r.urgency] || URGENCY_META.normal;
  const acceptedBidId = r.acceptedBidId;

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5 sticky top-4 self-start max-h-[calc(100vh-2rem)] overflow-y-auto" data-testid="sme-detail-panel">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl">{catEmoji(r.category)}</span>
            <h2 className="text-lg font-bold">{r.title}</h2>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono">{r.id}</span>
          </div>
        </div>
        <button
          data-testid="sme-detail-close"
          onClick={onClose}
          className="p-1.5 rounded hover:bg-slate-700"
        ><X className="w-4 h-4" /></button>
      </div>

      {loading && (
        <div className="text-slate-400 text-sm flex items-center gap-2 mb-3">
          <Loader2 className="w-4 h-4 animate-spin" /> Обновление…
        </div>
      )}

      {/* Quick metadata */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <MetaRow icon={<Tag className="w-3.5 h-3.5" />} label="Категория" value={catLabel(r.category)} />
        <MetaRow icon={<MapPin className="w-3.5 h-3.5" />} label="Город" value={r.city} />
        <MetaRow icon={<Clock className="w-3.5 h-3.5" />} label="Срочность" value={um.ru} className={um.cls} />
        <MetaRow icon={<Euro className="w-3.5 h-3.5" />} label="Бюджет"
          value={r.budget?.min || r.budget?.max ? `€${r.budget?.min ?? '?'}${r.budget?.max ? `–${r.budget.max}` : '+'}` : '—'} />
        <MetaRow icon={<User className="w-3.5 h-3.5" />} label="Клиент"
          value={r.customerId ? <span className="font-mono text-xs">{r.customerId.slice(0, 12)}…</span> : <span className="italic text-slate-500">guest</span>} />
        <MetaRow icon={<Phone className="w-3.5 h-3.5" />} label="Контакт клиента"
          value={r.contactPhone || <span className="italic text-slate-500">—</span>} />
      </div>

      {/* Status badge */}
      <div className="mb-4">
        <span className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border ${sm.cls} text-sm font-semibold`}>
          {sm.ru}
          {r.assignedProviderId && (
            <span className="text-xs opacity-70">→ {r.assignedProviderId.slice(0, 8)}…</span>
          )}
        </span>
      </div>

      {/* Description */}
      {r.description && (
        <div className="mb-4">
          <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-1">Описание</div>
          <p className="text-sm text-slate-200 leading-relaxed whitespace-pre-wrap">{r.description}</p>
        </div>
      )}

      {/* Location */}
      {r.location && (
        <div className="mb-4">
          <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-1">Локация</div>
          <p className="text-sm text-slate-300">
            {r.location.address || `${r.location.lat.toFixed(4)}, ${r.location.lng.toFixed(4)}`}
          </p>
        </div>
      )}

      {/* Monetization */}
      <div className="mb-4 grid grid-cols-2 gap-2">
        <div className="bg-slate-900/50 border border-slate-700/60 rounded-lg px-3 py-2">
          <div className="text-[10px] uppercase text-slate-500">Комиссия</div>
          <div className="text-sm font-bold text-emerald-300">{r.commissionPct ?? 12}%</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-700/60 rounded-lg px-3 py-2">
          <div className="text-[10px] uppercase text-slate-500">Lead fee</div>
          <div className="text-sm font-bold text-yellow-300">€{r.leadFee ?? 0}</div>
        </div>
      </div>

      {/* Status controls */}
      <div className="mb-5">
        <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-2">Управление статусом</div>
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((s) => {
            const isCurrent = r.status === s;
            const meta = STATUS_META[s];
            const isRunning = actionRunning === `status:${s}`;
            return (
              <button
                key={s}
                data-testid={`sme-status-btn-${s}`}
                disabled={isCurrent || !!actionRunning}
                onClick={() => onChangeStatus(s)}
                className={`px-2.5 py-1 rounded-md text-xs font-semibold border transition ${
                  isCurrent ? meta.cls + ' opacity-60 cursor-not-allowed' : 'bg-slate-700/40 border-slate-600 hover:bg-slate-700'
                }`}
              >
                {isRunning ? <Loader2 className="w-3 h-3 animate-spin inline" /> : meta.ru}
              </button>
            );
          })}
        </div>
      </div>

      {/* Bids */}
      <div className="mb-5">
        <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-2">
          Отклики ({data.bids.length})
        </div>
        {data.bids.length === 0 ? (
          <div className="text-sm text-slate-500 italic py-3">Откликов пока нет</div>
        ) : (
          <div className="space-y-2">
            {data.bids.map((bid) => {
              const isAccepted = bid.status === 'accepted' || bid.id === acceptedBidId;
              const isMuted = bid.status === 'rejected' || bid.status === 'withdrawn' || bid.status === 'expired';
              return (
                <div
                  key={bid.id}
                  data-testid={`sme-bid-${bid.id}`}
                  className={`rounded-lg p-3 border ${
                    isAccepted ? 'bg-emerald-500/10 border-emerald-500/50'
                    : isMuted ? 'bg-slate-900/30 border-slate-700/40 opacity-50'
                    : 'bg-slate-900/50 border-slate-700/60'
                  }`}
                >
                  <div className="flex items-start justify-between mb-1.5">
                    <div>
                      <div className="text-sm font-semibold flex items-center gap-1.5">
                        {bid.providerName}
                        {isAccepted && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                        {bid.adminAssigned && <span className="text-[9px] bg-amber-500/30 text-amber-300 px-1.5 py-0.5 rounded">ADMIN</span>}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono">{bid.providerId.slice(0, 12)}…</div>
                    </div>
                    <div className="text-right">
                      <div className="text-base font-bold text-amber-300">€{bid.price}</div>
                      {bid.etaMinutes && <div className="text-[10px] text-slate-500">ETA {bid.etaMinutes} мин</div>}
                    </div>
                  </div>
                  {bid.message && <p className="text-xs text-slate-300 mb-1.5 leading-snug">{bid.message}</p>}
                  {/* Admin always sees contacts */}
                  {(bid.providerPhone || bid.providerEmail) && (
                    <div className="flex items-center gap-3 text-[11px] text-slate-400 pt-1.5 border-t border-slate-700/40 mt-1.5">
                      {bid.providerPhone && (
                        <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" /> {bid.providerPhone}</span>
                      )}
                      {bid.providerEmail && (
                        <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" /> {bid.providerEmail}</span>
                      )}
                    </div>
                  )}
                  <div className="text-[10px] text-slate-500 mt-1 flex justify-between">
                    <span>статус: <span className="font-semibold uppercase">{bid.status}</span></span>
                    <span>{new Date(bid.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Manual assign */}
      <div className="border-t border-slate-700/60 pt-4">
        <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-2">
          Ручное назначение исполнителя
        </div>
        <div className="space-y-2">
          <input
            data-testid="sme-assign-provider-id"
            value={assignProviderId}
            onChange={(e) => onAssignProviderIdChange(e.target.value)}
            placeholder="providerId (user_id или organization_id)"
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
          />
          <textarea
            data-testid="sme-assign-note"
            value={assignNote}
            onChange={(e) => onAssignNoteChange(e.target.value)}
            placeholder="Причина / комментарий (опционально)"
            rows={2}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-500"
          />
          <button
            data-testid="sme-assign-submit"
            disabled={!assignProviderId.trim() || !!actionRunning}
            onClick={onAssign}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-slate-900 font-semibold text-sm transition"
          >
            {actionRunning === 'assign' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Назначить
          </button>
        </div>
        <div className="text-[10px] text-slate-500 mt-2 leading-snug">
          Создаст accepted bid от имени админа и переведёт заявку в статус assigned.
        </div>
      </div>
    </div>
  );
}

function MetaRow({ icon, label, value, className }: { icon: React.ReactNode; label: string; value: React.ReactNode; className?: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-[10px] uppercase text-slate-500 font-semibold mb-0.5">
        {icon} {label}
      </div>
      <div className={`text-sm ${className || 'text-slate-200'}`}>{value}</div>
    </div>
  );
}

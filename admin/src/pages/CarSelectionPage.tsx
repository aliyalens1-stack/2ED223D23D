/**
 * Car-Selection-2 — Admin operations console for advisory "Подбор авто".
 *
 * Hard invariant: admin may transition lifecycle and assign workers,
 * but MUST NOT mutate the original customer description. The textarea
 * showing `description` is rendered read-only and visually marked
 * "frozen input from customer".
 *
 * Backend contract:
 *   GET    /api/admin/car-selection                     queue + counts
 *   GET    /api/admin/car-selection/{id}                detail
 *   POST   /api/admin/car-selection/{id}/assign         {providerId|adminId, note}
 *   POST   /api/admin/car-selection/{id}/status         {status, note}
 *
 * Locked lifecycle (see app/car_selection/lifecycle.py):
 *   submitted → reviewing | cancelled
 *   reviewing → assigned | cancelled
 *   assigned  → in_progress | waiting_customer | cancelled
 *   in_progress → waiting_customer | completed | cancelled
 *   waiting_customer → in_progress | completed | cancelled
 *   completed, cancelled — terminal.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search,
  RefreshCw,
  X,
  Briefcase,
  MapPin,
  Euro,
  Lock,
  Link2,
  UserCircle,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
  MessagesSquare,
  Send,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────

type ServiceType =
  | 'budget_search'
  | 'market_search'
  | 'negotiation_help'
  | 'listing_review';

type CSStatus =
  | 'submitted'
  | 'reviewing'
  | 'assigned'
  | 'in_progress'
  | 'waiting_customer'
  | 'completed'
  | 'cancelled';

interface BudgetExtras {
  budgetMin?: number;
  budgetMax?: number;
  brands?: string[];
  fuelTypes?: string[];
  transmission?: 'manual' | 'automatic';
  yearMin?: number;
  yearMax?: number;
}

interface TimelineEvent {
  type: string;
  at: string;
  actorId?: string | null;
  actorRole?: string | null;
  note?: string | null;
  data?: Record<string, unknown> | null;
}

interface CSRequest {
  id: string;
  customerId: string;
  serviceType: ServiceType;
  countryCode: string;
  cityId: string;
  description: string;
  sourceLink?: string | null;
  budget?: BudgetExtras | null;
  status: CSStatus;
  assignedAdminId?: string | null;
  assignedProviderId?: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineEvent[];
}

interface QueueResponse {
  items: CSRequest[];
  total: number;
  counts: Record<CSStatus, number>;
  filters: Record<string, unknown>;
}

// ── Lifecycle adjacency — MUST mirror backend lifecycle.py ────────────

const ALLOWED_TRANSITIONS: Record<CSStatus, CSStatus[]> = {
  submitted: ['reviewing', 'cancelled'],
  reviewing: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'waiting_customer', 'cancelled'],
  in_progress: ['waiting_customer', 'completed', 'cancelled'],
  waiting_customer: ['in_progress', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const SERVICE_TYPES: ServiceType[] = [
  'budget_search',
  'market_search',
  'negotiation_help',
  'listing_review',
];

const SERVICE_LABEL: Record<ServiceType, string> = {
  budget_search: 'Под бюджет',
  market_search: 'Поиск',
  negotiation_help: 'Торг',
  listing_review: 'Mobile.de',
};

const STATUS_LABEL: Record<CSStatus, string> = {
  submitted: 'Submitted',
  reviewing: 'Reviewing',
  assigned: 'Assigned',
  in_progress: 'In progress',
  waiting_customer: 'Waiting customer',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATUS_TONE: Record<CSStatus, string> = {
  submitted: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  reviewing: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  assigned: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  in_progress: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  waiting_customer: 'bg-pink-500/20 text-pink-300 border-pink-500/30',
  completed: 'bg-green-500/20 text-green-300 border-green-500/30',
  cancelled: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
};

// ── Auth helper (matches AutoRequestsPage pattern) ────────────────────

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('admin_token') || '';
  return t ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j?.detail?.message || j?.message || msg;
    } catch {/* ignore */}
    throw new Error(msg);
  }
  return res.json();
}

async function apiPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j?.detail?.message || j?.message || msg;
    } catch {/* ignore */}
    throw new Error(msg);
  }
  return res.json();
}

// ── Artifact helpers ──────────────────────────────────────────────────
//
// Caps mirrored from `app/car_selection_thread/artifacts.py`. We
// pre-check size client-side to avoid a 413 round-trip — but the
// server remains the source of truth.
type ArtifactKind = 'image' | 'pdf' | 'file';

const KIND_CAP: Record<ArtifactKind, number> = {
  image: 8 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  file: 10 * 1024 * 1024,
};

interface ArtifactOut {
  id: string;
  requestId: string;
  uploadedBy: string;
  uploadedByRole: 'customer' | 'provider' | 'admin';
  kind: ArtifactKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;            // backend-relative, e.g. /api/admin/car-selection/.../artifacts/...
  createdAt: string;
}

interface ArtifactStats {
  totalArtifacts: number;
  totalBytes: number;
  byKind: Record<ArtifactKind, { count: number; bytes: number }>;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function apiUpload(url: string, kind: ArtifactKind, file: File): Promise<ArtifactOut> {
  const form = new FormData();
  form.append('kind', kind);
  form.append('file', file);
  // NB: do not set Content-Type — the browser will set the
  // multipart boundary automatically.
  const t = localStorage.getItem('admin_token') || '';
  const res = await fetch(url, {
    method: 'POST',
    headers: t ? { Authorization: `Bearer ${t}` } : {},
    body: form,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j?.message || j?.detail?.message || msg;
    } catch {/* ignore */}
    throw new Error(msg);
  }
  return res.json();
}

async function fetchArtifactBlob(url: string): Promise<Blob> {
  const t = localStorage.getItem('admin_token') || '';
  const res = await fetch(url, {
    headers: t ? { Authorization: `Bearer ${t}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

async function downloadArtifact(a: ArtifactOut): Promise<void> {
  const blob = await fetchArtifactBlob(a.url);
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = a.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Defer revoke so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

// ── Component ─────────────────────────────────────────────────────────

export default function CarSelectionPage() {
  const [items, setItems] = useState<CSRequest[]>([]);
  const [counts, setCounts] = useState<Record<CSStatus, number>>({
    submitted: 0,
    reviewing: 0,
    assigned: 0,
    in_progress: 0,
    waiting_customer: 0,
    completed: 0,
    cancelled: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<CSStatus | ''>('');
  const [typeFilter, setTypeFilter] = useState<ServiceType | ''>('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (typeFilter) params.set('serviceType', typeFilter);
      params.set('limit', '200');
      const data = await apiGet<QueueResponse>(
        `/api/admin/car-selection?${params.toString()}`,
      );
      setItems(data.items || []);
      setCounts(data.counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => { load(); }, [load]);

  // Client-side description search (server has no full-text yet).
  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.trim().toLowerCase();
    return items.filter((r) =>
      r.description.toLowerCase().includes(q) ||
      r.cityId.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q) ||
      (r.sourceLink || '').toLowerCase().includes(q),
    );
  }, [items, query]);

  const selected = useMemo(
    () => items.find((r) => r.id === selectedId) || null,
    [items, selectedId],
  );

  const replaceItem = (next: CSRequest) => {
    setItems((prev) => prev.map((r) => (r.id === next.id ? next : r)));
    // counts may have changed → reload counts in background
    apiGet<QueueResponse>(`/api/admin/car-selection?limit=1`).then((d) => setCounts(d.counts)).catch(() => {/* noop */});
  };

  return (
    <div
      className="min-h-screen bg-slate-900 text-slate-100 p-6"
      data-testid="car-selection-page"
    >
      {/* Header */}
      <div className="mb-6 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-emerald-500/20 text-emerald-400 inline-flex items-center justify-center">
            <Briefcase size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold" data-testid="cs-title">
              Подбор авто · Operations
            </h1>
            <p className="text-sm text-slate-400">
              Advisory workflow — отдельно от inspection. Customer brief is frozen.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ArtifactStatsCard tick={items.length /* refreshes when queue reloads */} />
          <button
            onClick={load}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-2 text-sm font-bold"
            data-testid="cs-refresh-btn"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* Status count chips */}
      <div className="mb-4 grid grid-cols-3 md:grid-cols-7 gap-2" data-testid="cs-counts-row">
        {(Object.keys(STATUS_LABEL) as CSStatus[]).map((s) => {
          const active = statusFilter === s;
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(active ? '' : s)}
              className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                active
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-slate-700 bg-slate-800 hover:bg-slate-700/60'
              }`}
              data-testid={`cs-count-${s}`}
            >
              <div className="text-2xl font-extrabold">{counts[s] ?? 0}</div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {STATUS_LABEL[s]}
              </div>
            </button>
          );
        })}
      </div>

      {/* Filter row — service type + search + clear */}
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="cs-filters-row">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-500 mr-2">
          Type:
        </span>
        <button
          onClick={() => setTypeFilter('')}
          className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${
            typeFilter === ''
              ? 'bg-emerald-500 text-black'
              : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
          data-testid="cs-type-all"
        >
          All
        </button>
        {SERVICE_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setTypeFilter(typeFilter === t ? '' : t)}
            className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${
              typeFilter === t
                ? 'bg-emerald-500 text-black'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
            data-testid={`cs-type-${t}`}
          >
            {SERVICE_LABEL[t]}
          </button>
        ))}

        <div className="flex-1" />

        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search description / city / id…"
            className="rounded-lg bg-slate-800 border border-slate-700 pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-emerald-500 w-72"
            data-testid="cs-search-input"
          />
        </div>

        {(statusFilter || typeFilter || query) && (
          <button
            onClick={() => {
              setStatusFilter('');
              setTypeFilter('');
              setQuery('');
            }}
            className="inline-flex items-center gap-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-2 text-xs font-bold"
            data-testid="cs-filters-clear"
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {error && (
        <div
          className="rounded-xl border border-red-500/50 bg-red-500/10 text-red-300 px-4 py-3 text-sm mb-4"
          data-testid="cs-error"
        >
          <AlertCircle size={14} className="inline mr-2" />
          {error}
        </div>
      )}

      {/* Two-column: queue + detail */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Queue table */}
        <div
          className="lg:col-span-3 overflow-hidden rounded-2xl border border-slate-700 bg-slate-800"
          data-testid="cs-queue-table"
        >
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-left text-xs uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">City</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Assigned</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400" data-testid="cs-loading">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400" data-testid="cs-empty">
                    No selection requests for the current filters.
                  </td>
                </tr>
              )}
              {!loading && filtered.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`border-t border-slate-700 cursor-pointer transition-colors ${
                    selectedId === r.id ? 'bg-emerald-500/10' : 'hover:bg-slate-700/40'
                  }`}
                  data-testid={`cs-row-${r.id}`}
                >
                  <td className="px-4 py-3">
                    <div className="font-bold text-emerald-300">
                      {SERVICE_LABEL[r.serviceType]}
                    </div>
                    <div className="text-[11px] text-slate-500">{r.serviceType}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-300 text-xs">
                    <span className="inline-flex items-center gap-1">
                      <UserCircle size={12} /> {r.customerId.substring(0, 10)}…
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 text-slate-300">
                      <MapPin size={13} /> {r.countryCode}/{r.cityId}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {r.assignedProviderId ? (
                      <div>P: {r.assignedProviderId.substring(0, 10)}…</div>
                    ) : null}
                    {r.assignedAdminId ? (
                      <div>A: {r.assignedAdminId.substring(0, 10)}…</div>
                    ) : null}
                    {!r.assignedProviderId && !r.assignedAdminId && (
                      <span className="text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-xs">
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-2" data-testid="cs-detail-panel">
          {selected ? (
            <DetailPanel
              request={selected}
              onClose={() => setSelectedId(null)}
              onUpdated={replaceItem}
            />
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-800/30 p-8 text-center text-slate-500" data-testid="cs-detail-empty">
              <Briefcase size={32} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm">Select a request to open the operations panel.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────

function DetailPanel({
  request,
  onClose,
  onUpdated,
}: {
  request: CSRequest;
  onClose: () => void;
  onUpdated: (r: CSRequest) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [providerId, setProviderId] = useState('');
  const [adminId, setAdminId] = useState('');
  const [assignNote, setAssignNote] = useState('');
  const [statusNote, setStatusNote] = useState('');

  // Lifecycle-allowed next targets, computed from local mirror.
  const nextTargets = ALLOWED_TRANSITIONS[request.status] || [];
  const isTerminal = nextTargets.length === 0;
  const canAssign = !isTerminal && request.status !== 'assigned';

  const callAssign = async () => {
    setErr(null);
    if (!providerId.trim() && !adminId.trim()) {
      setErr('Provide at least one of providerId / adminId.');
      return;
    }
    setBusy('assign');
    try {
      const updated = await apiPost<CSRequest>(
        `/api/admin/car-selection/${request.id}/assign`,
        {
          providerId: providerId.trim() || null,
          adminId: adminId.trim() || null,
          note: assignNote.trim() || null,
        },
      );
      onUpdated(updated);
      setProviderId('');
      setAdminId('');
      setAssignNote('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'assign failed');
    } finally {
      setBusy(null);
    }
  };

  const callStatus = async (target: CSStatus) => {
    setErr(null);
    setBusy(`status:${target}`);
    try {
      const updated = await apiPost<CSRequest>(
        `/api/admin/car-selection/${request.id}/status`,
        { status: target, note: statusNote.trim() || null },
      );
      onUpdated(updated);
      setStatusNote('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'status change failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-800 overflow-hidden flex flex-col" data-testid="cs-detail">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-5 pt-5 pb-3 border-b border-slate-700">
        <div className="min-w-0">
          <div className="text-xs font-bold uppercase tracking-wider text-emerald-400 mb-1">
            {SERVICE_LABEL[request.serviceType]} · {request.countryCode}/{request.cityId}
          </div>
          <div className="text-sm text-slate-400 truncate" data-testid="cs-detail-id">
            id: {request.id}
          </div>
          <div className="mt-2"><StatusPill status={request.status} large /></div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="close" data-testid="cs-detail-close">
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
        {/* FROZEN customer description */}
        <div data-testid="cs-detail-description-block">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
            <Lock size={11} /> Customer brief · frozen input
          </div>
          <div
            className="rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-200 whitespace-pre-wrap select-text"
            data-testid="cs-detail-description"
          >
            {request.description}
          </div>
          <div className="mt-1 text-[10px] text-slate-600">
            Admin may transition lifecycle / assign — never edit this text.
          </div>
        </div>

        {/* Customer + source link + budget */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <Kvp icon={<UserCircle size={12} />} label="Customer">
            <span className="font-mono text-slate-300">
              {request.customerId.substring(0, 16)}…
            </span>
          </Kvp>
          <Kvp icon={<Clock size={12} />} label="Created">
            {new Date(request.createdAt).toLocaleString()}
          </Kvp>
          {request.sourceLink && (
            <div className="col-span-2">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                <Link2 size={11} /> Source link
              </div>
              <a
                href={request.sourceLink}
                target="_blank"
                rel="noreferrer"
                className="text-emerald-400 hover:underline break-all text-xs"
                data-testid="cs-detail-source-link"
              >
                {request.sourceLink}
              </a>
            </div>
          )}
        </div>

        {/* Budget extras */}
        {request.budget && (
          <div data-testid="cs-detail-budget">
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
              <Euro size={11} /> Budget extras
            </div>
            <BudgetTable b={request.budget} />
          </div>
        )}

        {/* Assignment status */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <Kvp label="Assigned admin">
            {request.assignedAdminId
              ? <span className="font-mono text-slate-300">{request.assignedAdminId.substring(0, 16)}…</span>
              : <span className="text-slate-600">—</span>}
          </Kvp>
          <Kvp label="Assigned provider">
            {request.assignedProviderId
              ? <span className="font-mono text-slate-300">{request.assignedProviderId.substring(0, 16)}…</span>
              : <span className="text-slate-600">—</span>}
          </Kvp>
        </div>

        {/* Error banner local to actions */}
        {err && (
          <div className="rounded-lg border border-red-500/50 bg-red-500/10 text-red-300 px-3 py-2 text-xs" data-testid="cs-action-error">
            <AlertCircle size={12} className="inline mr-1.5" />
            {err}
          </div>
        )}

        {/* Assign block */}
        {canAssign && (
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-3" data-testid="cs-assign-block">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
              Assign worker
            </div>
            <input
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              placeholder="providerId (optional)"
              className="w-full mb-2 rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-xs focus:outline-none focus:border-emerald-500"
              data-testid="cs-assign-provider-input"
            />
            <input
              value={adminId}
              onChange={(e) => setAdminId(e.target.value)}
              placeholder="adminId (optional)"
              className="w-full mb-2 rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-xs focus:outline-none focus:border-emerald-500"
              data-testid="cs-assign-admin-input"
            />
            <input
              value={assignNote}
              onChange={(e) => setAssignNote(e.target.value)}
              placeholder="note (optional, ≤500 chars)"
              maxLength={500}
              className="w-full mb-2 rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-xs focus:outline-none focus:border-emerald-500"
              data-testid="cs-assign-note-input"
            />
            <button
              onClick={callAssign}
              disabled={busy === 'assign' || (!providerId.trim() && !adminId.trim())}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-500 text-black font-bold px-3 py-2 text-xs"
              data-testid="cs-assign-submit"
            >
              {busy === 'assign' ? 'Assigning…' : 'Assign → status:assigned'}
            </button>
            <div className="mt-1.5 text-[10px] text-slate-500">
              At least one of providerId / adminId is required. Submitted requests auto-lift through reviewing.
            </div>
          </div>
        )}

        {/* Status transition block */}
        {!isTerminal && (
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-3" data-testid="cs-status-block">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
              Move status
            </div>
            <input
              value={statusNote}
              onChange={(e) => setStatusNote(e.target.value)}
              placeholder="note (optional, attached to timeline)"
              maxLength={500}
              className="w-full mb-2 rounded-lg bg-slate-800 border border-slate-700 px-3 py-1.5 text-xs focus:outline-none focus:border-emerald-500"
              data-testid="cs-status-note-input"
            />
            <div className="flex flex-wrap gap-1.5">
              {nextTargets.map((t) => (
                <button
                  key={t}
                  onClick={() => callStatus(t)}
                  disabled={busy === `status:${t}`}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold border transition-colors disabled:opacity-50 ${
                    t === 'cancelled'
                      ? 'border-red-500/40 text-red-300 hover:bg-red-500/10'
                      : t === 'completed'
                        ? 'border-green-500/40 text-green-300 hover:bg-green-500/10'
                        : 'border-slate-700 text-slate-200 hover:bg-slate-700'
                  }`}
                  data-testid={`cs-status-btn-${t}`}
                >
                  {busy === `status:${t}` ? '…' : `→ ${STATUS_LABEL[t]}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {isTerminal && (
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-3 text-center text-xs text-slate-400 flex items-center justify-center gap-2" data-testid="cs-terminal-notice">
            {request.status === 'completed'
              ? <><CheckCircle2 size={14} className="text-green-400" /> Completed — terminal state. No further transitions.</>
              : <><XCircle size={14} className="text-slate-400" /> Cancelled — terminal state. No further transitions.</>}
          </div>
        )}

        {/* Thread (Car-Selection-4) */}
        <CSThreadBlock
          requestId={request.id}
          surface="admin"
        />

        {/* Timeline rail */}
        <div data-testid="cs-timeline">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">
            Timeline · {request.timeline.length}
          </div>
          <ol className="space-y-2.5 border-l-2 border-slate-700 ml-2 pl-4">
            {request.timeline.slice().reverse().map((ev, i) => (
              <li key={i} className="relative" data-testid={`cs-timeline-event-${request.timeline.length - 1 - i}`}>
                <span className="absolute -left-[22px] top-1 inline-block h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-slate-800" />
                <div className="text-xs font-bold text-slate-200">{ev.type}</div>
                <div className="text-[10px] text-slate-500">
                  {new Date(ev.at).toLocaleString()}
                  {ev.actorRole ? ` · ${ev.actorRole}` : ''}
                  {ev.actorId ? ` · ${ev.actorId.substring(0, 8)}…` : ''}
                </div>
                {ev.note && (
                  <div className="mt-1 text-[11px] text-slate-300 italic">“{ev.note}”</div>
                )}
                {ev.data && Object.keys(ev.data).length > 0 && (
                  <div className="mt-1 text-[10px] font-mono text-slate-500 break-all">
                    {JSON.stringify(ev.data)}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────

function StatusPill({ status, large }: { status: CSStatus; large?: boolean }) {
  const cls = STATUS_TONE[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border ${cls} ${
        large ? 'px-3 py-1 text-xs' : 'px-2 py-0.5 text-[10px]'
      } font-bold uppercase tracking-wider`}
      data-testid={`cs-status-pill-${status}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function Kvp({
  icon, label, children,
}: { icon?: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">
        {icon}{label}
      </div>
      <div className="text-xs text-slate-200">{children}</div>
    </div>
  );
}

function BudgetTable({ b }: { b: BudgetExtras }) {
  const rows: Array<[string, React.ReactNode]> = [];
  if (b.budgetMin != null || b.budgetMax != null) {
    rows.push([
      'Range',
      <span key="r">
        {b.budgetMin?.toLocaleString('de-DE') ?? '—'} – {b.budgetMax?.toLocaleString('de-DE') ?? '—'} €
      </span>,
    ]);
  }
  if (b.brands?.length) rows.push(['Brands', b.brands.join(' · ')]);
  if (b.fuelTypes?.length) rows.push(['Fuel', b.fuelTypes.join(' · ')]);
  if (b.transmission) rows.push(['Gearbox', b.transmission]);
  if (b.yearMin != null || b.yearMax != null) {
    rows.push(['Year', `${b.yearMin ?? '—'} – ${b.yearMax ?? '—'}`]);
  }
  if (!rows.length) return null;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 overflow-hidden">
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t border-slate-800 first:border-t-0">
              <td className="px-3 py-1.5 text-slate-500 w-24">{k}</td>
              <td className="px-3 py-1.5 text-slate-200">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────
// Car-Selection-4/5 — Thread block (append-only) + attachments
// ─────────────────────────────────────────────────────────────────────
//
// Self-contained block that the admin detail panel embeds beneath the
// status actions and above the lifecycle timeline. Three role surfaces
// share the same shape — admin uses `/api/admin/car-selection/{id}/thread`.
//
// Invariants visible in the UI:
//   - messages are append-only (no edit/delete affordance on rendered rows)
//   - timeline ≠ thread → these are two clearly separated blocks
//   - the input field posts a NEW message; it cannot edit or quote-mutate
//     prior ones
//   - artifact upload runs as its own operation (does NOT post a message
//     and does NOT mutate lifecycle). To attach evidence to a message,
//     upload first → file lands in `staged` → press Send to commit a
//     new message that REFERENCES the artifact ids
//   - admin upload only APPENDS evidence — never overwrites, never
//     mutates prior messages or attachments

interface CSMessage {
  id: string;
  requestId: string;
  authorId: string;
  authorRole: 'customer' | 'admin' | 'provider';
  body: string;
  attachments?: ArtifactOut[];
  visibility: 'shared' | 'admin_internal';
  createdAt: string;
}

const ROLE_TONE: Record<CSMessage['authorRole'], string> = {
  customer: 'bg-blue-500/15 border-blue-500/40 text-blue-200',
  provider: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
  admin:    'bg-amber-500/15 border-amber-500/40 text-amber-200',
};

const ROLE_LABEL: Record<CSMessage['authorRole'], string> = {
  customer: 'Customer',
  provider: 'Provider',
  admin:    'Admin',
};

function endpointFor(surface: 'admin' | 'provider' | 'customer', requestId: string): string {
  if (surface === 'admin')    return `/api/admin/car-selection/${requestId}/thread`;
  if (surface === 'provider') return `/api/provider/car-selection/${requestId}/thread`;
  return `/api/car-selection/requests/${requestId}/thread`;
}

function artifactsBaseFor(surface: 'admin' | 'provider' | 'customer', requestId: string): string {
  if (surface === 'admin')    return `/api/admin/car-selection/${requestId}/artifacts`;
  if (surface === 'provider') return `/api/provider/car-selection/${requestId}/artifacts`;
  return `/api/car-selection/requests/${requestId}/artifacts`;
}

const KIND_ACCEPT: Record<ArtifactKind, string> = {
  image: 'image/png,image/jpeg,image/jpg,image/webp,image/gif',
  pdf: 'application/pdf',
  file: '*/*',
};

// ─── ImageThumb ────────────────────────────────────────────────────────
//
// Admin-only inline thumbnail (120 × 80) for image artifacts. Fetches
// the bytes with the admin Bearer token, makes a blob URL, releases on
// unmount. Tap → full download/open via downloadArtifact (which uses
// the SAME authed fetch — no `<img src=>` would work because the
// endpoint requires Bearer auth).
//
// This is the ONLY "richer preview" in the subsystem. No carousel, no
// lightbox, no gallery — a single tap surfaces the file via the OS.
function ImageThumb({ artifact }: { artifact: ArtifactOut }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let revoked = false;
    let createdHref: string | null = null;
    (async () => {
      try {
        const blob = await fetchArtifactBlob(artifact.url);
        if (revoked) return;
        const href = URL.createObjectURL(blob);
        createdHref = href;
        setSrc(href);
      } catch {
        setErr(true);
      }
    })();
    return () => {
      revoked = true;
      if (createdHref) URL.revokeObjectURL(createdHref);
    };
  }, [artifact.url]);

  if (err) {
    return (
      <div
        className="h-20 w-[120px] rounded-md border border-slate-700 bg-slate-800/60 grid place-items-center text-[10px] text-slate-500"
        data-testid={`cs-thread-thumb-err-${artifact.id}`}
      >
        preview failed
      </div>
    );
  }
  if (!src) {
    return (
      <div
        className="h-20 w-[120px] rounded-md border border-slate-700 bg-slate-800/60 animate-pulse"
        data-testid={`cs-thread-thumb-loading-${artifact.id}`}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => downloadArtifact(artifact).catch(() => {/* surfaces in row error */})}
      className="block h-20 w-[120px] rounded-md border border-slate-700 hover:border-emerald-500 overflow-hidden bg-slate-900"
      data-testid={`cs-thread-thumb-${artifact.id}`}
      title={`${artifact.filename} · ${fmtBytes(artifact.sizeBytes)}`}
    >
      <img
        src={src}
        alt={artifact.filename}
        className="h-full w-full object-cover"
      />
    </button>
  );
}

// ─── AttachmentChip ────────────────────────────────────────────────────
//
// Compact chip for pdf / file. Image kind renders an ImageThumb instead
// (admin only). All chips → click → authed download.
function AttachmentChip({ artifact }: { artifact: ArtifactOut }) {
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const Icon = artifact.kind === 'pdf' ? '📄' : '📎';

  const onClick = async () => {
    if (downloading) return;
    setDownloading(true);
    setErr(null);
    try {
      await downloadArtifact(artifact);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'download failed');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 max-w-[260px] rounded-md border border-slate-700 hover:border-emerald-500 bg-slate-900/60 px-2 py-1 text-[11px] text-slate-200 disabled:opacity-50"
      disabled={downloading}
      data-testid={`cs-thread-attach-${artifact.id}`}
      title={`${artifact.filename} · ${fmtBytes(artifact.sizeBytes)}`}
    >
      <span aria-hidden>{Icon}</span>
      <span className="truncate">{artifact.filename}</span>
      <span className="text-slate-500 font-mono">{fmtBytes(artifact.sizeBytes)}</span>
      {downloading ? (
        <span className="ml-1 text-slate-500">…</span>
      ) : (
        <span className="ml-1 text-slate-500" aria-hidden>↓</span>
      )}
      {err ? (
        <span className="ml-1 text-red-400" data-testid={`cs-thread-attach-err-${artifact.id}`}>
          {err}
        </span>
      ) : null}
    </button>
  );
}

// ─── ArtifactStatsCard ─────────────────────────────────────────────────
//
// Top-right observability widget. Reads `/api/admin/car-selection/
// artifacts/stats`. Auto-refresh on parent's load() trigger via the
// `tick` prop — when the parent reloads the queue, the card refreshes
// too. The shape is locked: every declared kind is always present
// (even zero-counted) so we never have to special-case empty buckets.
function ArtifactStatsCard({ tick }: { tick: number }) {
  const [stats, setStats] = useState<ArtifactStats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await apiGet<ArtifactStats>('/api/admin/car-selection/artifacts/stats');
        if (alive) { setStats(data); setErr(null); }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : 'stats failed');
      }
    })();
    return () => { alive = false; };
  }, [tick]);

  if (err) {
    return (
      <div
        className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-200"
        data-testid="cs-artifact-stats-error"
      >
        Artifacts stats: {err}
      </div>
    );
  }
  if (!stats) {
    return (
      <div
        className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-[11px] text-slate-400 animate-pulse"
        data-testid="cs-artifact-stats-loading"
      >
        Loading artifacts…
      </div>
    );
  }
  const { totalArtifacts, totalBytes, byKind } = stats;
  return (
    <div
      className="rounded-xl border border-slate-700 bg-slate-800/80 px-3 py-2 min-w-[210px]"
      data-testid="cs-artifact-stats"
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-0.5">
        Artifacts
      </div>
      <div className="text-sm font-extrabold text-slate-100">
        <span data-testid="cs-artifact-stats-total">{totalArtifacts}</span>
        <span className="text-slate-500 font-normal"> · </span>
        <span className="text-slate-300 font-semibold" data-testid="cs-artifact-stats-bytes">
          {fmtBytes(totalBytes)}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-1 text-[10px]">
        <div className="text-slate-400 flex items-center gap-1" data-testid="cs-artifact-stats-image">
          <span aria-hidden>🖼</span>
          <span className="font-semibold text-slate-200">{byKind.image.count}</span>
        </div>
        <div className="text-slate-400 flex items-center gap-1" data-testid="cs-artifact-stats-pdf">
          <span aria-hidden>📄</span>
          <span className="font-semibold text-slate-200">{byKind.pdf.count}</span>
        </div>
        <div className="text-slate-400 flex items-center gap-1" data-testid="cs-artifact-stats-file">
          <span aria-hidden>📎</span>
          <span className="font-semibold text-slate-200">{byKind.file.count}</span>
        </div>
      </div>
    </div>
  );
}

// ─── CSThreadBlock ─────────────────────────────────────────────────────
function CSThreadBlock({
  requestId, surface,
}: { requestId: string; surface: 'admin' | 'provider' | 'customer' }) {
  const [items, setItems] = useState<CSMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  // Staging area — local-only until the user presses Send.
  const [staged, setStaged] = useState<ArtifactOut[]>([]);
  const [uploading, setUploading] = useState<ArtifactKind | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const threadUrl = endpointFor(surface, requestId);
  const artifactsUrl = artifactsBaseFor(surface, requestId);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ items: CSMessage[]; total: number }>(threadUrl);
      setItems(data.items || []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, [threadUrl]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const onPick = (kind: ArtifactKind) => async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    // Reset the input so re-picking the SAME file fires onChange again.
    ev.target.value = '';
    if (!file) return;
    if (file.size > KIND_CAP[kind]) {
      setUploadErr(
        `${kind.toUpperCase()} exceeds ${(KIND_CAP[kind] / (1024 * 1024)).toFixed(0)} MB limit`,
      );
      setPickerOpen(false);
      return;
    }
    setUploadErr(null);
    setUploading(kind);
    setPickerOpen(false);
    try {
      const out = await apiUpload(artifactsUrl, kind, file);
      setStaged((prev) => [...prev, out]);
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setUploading(null);
    }
  };

  const removeStaged = (id: string) =>
    setStaged((prev) => prev.filter((a) => a.id !== id));

  const submit = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setErr(null);
    try {
      const payload: { body: string; attachmentIds?: string[] } = { body };
      if (staged.length) payload.attachmentIds = staged.map((s) => s.id);
      const created = await apiPost<CSMessage>(threadUrl, payload);
      setItems((prev) => [...prev, created]);
      setDraft('');
      setStaged([]);
      setUploadErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'send failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-testid="cs-thread-block">
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">
        <MessagesSquare size={11} /> Thread · {items.length}
        <span className="ml-2 text-[10px] normal-case font-normal text-slate-600 tracking-normal">
          append-only · shared with customer & provider
        </span>
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-3 space-y-2 max-h-72 overflow-y-auto" data-testid="cs-thread-list">
        {loading && <div className="text-xs text-slate-500" data-testid="cs-thread-loading">Loading…</div>}
        {!loading && items.length === 0 && (
          <div className="text-xs text-slate-500 italic" data-testid="cs-thread-empty">
            No messages yet. Be the first to write a note — it will reach customer &amp; provider.
          </div>
        )}
        {!loading && items.map((m) => {
          const images = (m.attachments || []).filter((a) => a.kind === 'image');
          const others = (m.attachments || []).filter((a) => a.kind !== 'image');
          return (
            <div
              key={m.id}
              className={`rounded-lg border px-2.5 py-1.5 ${ROLE_TONE[m.authorRole]}`}
              data-testid={`cs-thread-msg-${m.id}`}
            >
              <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider opacity-80">
                <span>{ROLE_LABEL[m.authorRole]}</span>
                <span className="font-mono normal-case font-normal text-[10px] opacity-70">
                  {new Date(m.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="text-xs text-slate-100 mt-1 whitespace-pre-wrap break-words">
                {m.body}
              </div>
              {(images.length > 0 || others.length > 0) && (
                <div className="mt-2 flex flex-wrap items-start gap-2" data-testid={`cs-thread-msg-attachments-${m.id}`}>
                  {images.map((a) => <ImageThumb key={a.id} artifact={a} />)}
                  {others.map((a) => <AttachmentChip key={a.id} artifact={a} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {err && (
        <div className="mt-2 rounded-lg border border-red-500/50 bg-red-500/10 text-red-300 px-2.5 py-1.5 text-[11px]" data-testid="cs-thread-error">
          <AlertCircle size={11} className="inline mr-1" />
          {err}
        </div>
      )}

      {/* Staged chips — local only until Send. */}
      {staged.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="cs-thread-staged">
          {staged.map((a) => (
            <div
              key={a.id}
              className="inline-flex items-center gap-1.5 max-w-[260px] rounded-md border border-emerald-500/70 bg-emerald-500/10 px-2 py-1 text-[11px] text-slate-100"
              data-testid={`cs-thread-staged-${a.id}`}
            >
              <span aria-hidden>{a.kind === 'image' ? '🖼' : a.kind === 'pdf' ? '📄' : '📎'}</span>
              <span className="truncate">{a.filename}</span>
              <span className="text-slate-400 font-mono">{fmtBytes(a.sizeBytes)}</span>
              <button
                type="button"
                onClick={() => removeStaged(a.id)}
                className="ml-1 text-slate-400 hover:text-slate-100"
                data-testid={`cs-thread-staged-remove-${a.id}`}
                aria-label="Remove attachment"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {uploadErr && (
        <div className="mt-2 rounded-lg border border-red-500/50 bg-red-500/10 text-red-300 px-2.5 py-1.5 text-[11px]" data-testid="cs-thread-upload-error">
          <AlertCircle size={11} className="inline mr-1" />
          {uploadErr}
        </div>
      )}

      {/* Inline picker — appears when paperclip is toggled. */}
      {pickerOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="cs-thread-picker">
          <label
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/60 bg-slate-900 hover:bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold cursor-pointer"
            data-testid="cs-thread-pick-image"
          >
            🖼 Photo
            <input
              type="file"
              accept={KIND_ACCEPT.image}
              className="hidden"
              onChange={onPick('image')}
              disabled={uploading !== null}
            />
          </label>
          <label
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/60 bg-slate-900 hover:bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold cursor-pointer"
            data-testid="cs-thread-pick-pdf"
          >
            📄 PDF
            <input
              type="file"
              accept={KIND_ACCEPT.pdf}
              className="hidden"
              onChange={onPick('pdf')}
              disabled={uploading !== null}
            />
          </label>
          <label
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/60 bg-slate-900 hover:bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold cursor-pointer"
            data-testid="cs-thread-pick-file"
          >
            📎 File
            <input
              type="file"
              accept={KIND_ACCEPT.file}
              className="hidden"
              onChange={onPick('file')}
              disabled={uploading !== null}
            />
          </label>
          <button
            type="button"
            onClick={() => setPickerOpen(false)}
            className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-2 py-1.5 text-[11px]"
            data-testid="cs-thread-pick-cancel"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="mt-2 flex gap-2 items-end">
        <button
          type="button"
          onClick={() => { setUploadErr(null); setPickerOpen((v) => !v); }}
          disabled={uploading !== null}
          className="inline-flex items-center justify-center h-[68px] w-10 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:opacity-50"
          data-testid="cs-thread-paperclip"
          title="Attach artifact"
          aria-label="Attach artifact"
        >
          {uploading ? <span className="text-[11px] text-slate-400">…</span> : <span aria-hidden>📎</span>}
        </button>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Append a message — visible to all parties on this request"
          maxLength={4000}
          rows={2}
          className="flex-1 rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs focus:outline-none focus:border-emerald-500 resize-none"
          data-testid="cs-thread-input"
        />
        <button
          onClick={submit}
          disabled={!draft.trim() || sending || uploading !== null}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-500 text-black font-bold px-3 py-2 text-xs whitespace-nowrap"
          data-testid="cs-thread-send"
        >
          <Send size={12} />
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

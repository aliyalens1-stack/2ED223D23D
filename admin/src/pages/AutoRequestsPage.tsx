// Sprint 2 — Auto Requests admin table (reads real backend /api/admin/requests).
import { useEffect, useState, useCallback } from 'react';
import { ClipboardCheck, MapPin, Euro, RefreshCw, Eye, X } from 'lucide-react';

interface CarReq {
  id: string;
  brand: string;
  model: string;
  budget: number;
  cities: string[];
  status: string;
  jobsTotal: number;
  jobsClaimed: number;
  jobsDone: number;
  createdAt: string;
  userId: string | null;
  links: string[];
}

interface Job {
  id: string;
  requestId: string;
  city: string;
  status: string;
  inspectorId: string | null;
  brand: string;
  model: string;
  budget: number;
  createdAt: string;
}

interface Stats {
  requests: { total: number; open: number; in_progress: number };
  jobs: { open: number; claimed: number };
}

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('admin_token') || '';
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export default function AutoRequestsPage() {
  const [items, setItems] = useState<CarReq[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ request: CarReq; jobs: Job[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reqRes, statRes] = await Promise.all([
        fetch(`/api/admin/requests${status ? `?status=${status}` : ''}`, { headers: authHeaders() }),
        fetch('/api/admin/requests/stats', { headers: authHeaders() }),
      ]);
      if (!reqRes.ok) throw new Error(`requests HTTP ${reqRes.status}`);
      const reqData = await reqRes.json();
      setItems(reqData.items || []);
      if (statRes.ok) setStats(await statRes.json());
    } catch (e: any) {
      setError(e?.message || 'load failed');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/requests/${id}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail(await res.json());
    } catch (e) { /* noop */ }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6" data-testid="auto-requests-page">
      <div className="mb-6 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-amber-500/20 text-amber-400 inline-flex items-center justify-center">
            <ClipboardCheck size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold">Auto Requests</h1>
            <p className="text-sm text-slate-400">Car selection requests (Auto 2.0 core) · 1 request → N jobs</p>
          </div>
        </div>
        <button onClick={load} className="inline-flex items-center gap-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-2 text-sm font-bold" data-testid="ar-refresh">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* stats */}
      {stats && (
        <div className="mb-6 grid grid-cols-2 md:grid-cols-5 gap-3" data-testid="ar-stats">
          <StatCard label="Total requests" value={stats.requests.total} />
          <StatCard label="Open" value={stats.requests.open} tone="blue" />
          <StatCard label="In progress" value={stats.requests.in_progress} tone="amber" />
          <StatCard label="Jobs open" value={stats.jobs.open} />
          <StatCard label="Jobs claimed" value={stats.jobs.claimed} tone="green" />
        </div>
      )}

      {/* filters */}
      <div className="mb-4 flex flex-wrap gap-2" data-testid="ar-filters">
        {['', 'open', 'in_progress', 'completed'].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider ${
              status === s ? 'bg-amber-500 text-black' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
            data-testid={`ar-filter-${s || 'all'}`}
          >
            {s || 'all'}
          </button>
        ))}
      </div>

      {error && <div className="rounded-xl border border-red-500/50 bg-red-500/10 text-red-300 px-4 py-3 text-sm mb-4">{error}</div>}

      {/* table */}
      <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-left text-xs uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-3">Request</th>
              <th className="px-4 py-3">Cities</th>
              <th className="px-4 py-3">Budget</th>
              <th className="px-4 py-3">Jobs</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">Loading…</td></tr>
            )}
            {!loading && items.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">No requests for this filter.</td></tr>
            )}
            {!loading && items.map((r) => (
              <tr key={r.id} className="border-t border-slate-700 hover:bg-slate-700/40" data-testid={`ar-row-${r.id}`}>
                <td className="px-4 py-3">
                  <div className="font-extrabold">{r.brand} {r.model}</div>
                  <div className="text-xs text-slate-500">id: {r.id.substring(0, 8)}…</div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1 text-slate-300"><MapPin size={13} /> {r.cities.join(' · ')}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1 font-bold"><Euro size={13} /> {Number(r.budget).toLocaleString('de-DE')}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-md bg-slate-900 border border-slate-700 px-2 py-0.5 text-xs font-bold">
                    {r.jobsClaimed + r.jobsDone}/{r.jobsTotal}
                  </span>
                </td>
                <td className="px-4 py-3"><StatusPill status={r.status} /></td>
                <td className="px-4 py-3 text-slate-400 text-xs">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => openDetail(r.id)} className="inline-flex items-center gap-1 rounded-lg bg-slate-900 hover:bg-slate-950 border border-slate-700 px-3 py-1.5 text-xs font-bold" data-testid={`ar-view-${r.id}`}>
                    <Eye size={13} /> View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* detail modal */}
      {detail && <DetailModal detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: 'bg-blue-500/20 text-blue-300',
    in_progress: 'bg-amber-500/20 text-amber-300',
    completed: 'bg-green-500/20 text-green-300',
  };
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider ${map[status] || map.open}`}>{status}</span>;
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'blue' | 'amber' | 'green' }) {
  const toneMap: Record<string, string> = {
    blue: 'text-blue-300',
    amber: 'text-amber-300',
    green: 'text-green-300',
  };
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 p-3.5">
      <div className={`text-2xl font-extrabold ${tone ? toneMap[tone] : 'text-slate-100'}`}>{value}</div>
      <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}

function DetailModal({ detail, onClose }: { detail: { request: CarReq; jobs: Job[] }; onClose: () => void }) {
  const { request: r, jobs } = detail;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose} data-testid="ar-detail-modal">
      <div className="w-full max-w-3xl rounded-2xl border border-slate-700 bg-slate-900 p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-2xl font-extrabold">{r.brand} {r.model}</h2>
            <div className="mt-1 flex flex-wrap gap-3 text-sm text-slate-400">
              <span className="inline-flex items-center gap-1"><Euro size={13} /> {Number(r.budget).toLocaleString('de-DE')} €</span>
              <span className="inline-flex items-center gap-1"><MapPin size={13} /> {r.cities.join(' · ')}</span>
              <StatusPill status={r.status} />
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="close" data-testid="ar-detail-close">
            <X size={18} />
          </button>
        </div>

        {r.links && r.links.length > 0 && (
          <div className="mb-5">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">Listing URLs</div>
            <ul className="text-sm space-y-1">
              {r.links.map((l, i) => (
                <li key={i}><a href={l} target="_blank" rel="noreferrer" className="text-amber-400 hover:underline break-all">{l}</a></li>
              ))}
            </ul>
          </div>
        )}

        <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
          Inspection jobs ({jobs.length})
        </div>
        <div className="overflow-hidden rounded-xl border border-slate-700">
          <table className="w-full text-sm">
            <thead className="bg-slate-800 text-left text-xs uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-3 py-2">City</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Inspector</th>
                <th className="px-3 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-slate-700" data-testid={`ar-detail-job-${j.id}`}>
                  <td className="px-3 py-2 font-bold">{j.city}</td>
                  <td className="px-3 py-2"><StatusPill status={j.status} /></td>
                  <td className="px-3 py-2 text-slate-400 text-xs">{j.inspectorId ? j.inspectorId.substring(0, 12) + '…' : '—'}</td>
                  <td className="px-3 py-2 text-slate-500 text-xs">{new Date(j.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

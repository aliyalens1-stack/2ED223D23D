/**
 * Sprint 3 Step 4 — Admin Live Assignments dashboard.
 *
 * Capabilities:
 *   - manual create (jobId + inspectorId + priority + earnings + TTL + manualOverride)
 *   - list filtered by status
 *   - cancel offered rows
 *   - inspector ranking details inline (score breakdown)
 *
 * Read-mostly. Auto-refresh every 10s while the page is open.
 */
import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Radio, Zap, XCircle, Plus, RefreshCcw, Lock } from 'lucide-react';

const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use((cfg) => {
  const t = localStorage.getItem('admin_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

interface Assignment {
  id: string;
  jobId: string;
  inspectorId: string;
  customerId?: string | null;
  status: string;
  priority: 'normal' | 'urgent' | 'premium';
  expiresAt: string;
  ttlSeconds: number;
  distanceKm?: number | null;
  estimatedEarnings?: number | null;
  currency: string;
  score: number;
  ranking: {
    reputationScore: number;
    distanceScore: number;
    availabilityScore: number;
    verificationScore: number;
  };
  createdAt: string;
  acceptedAt?: string | null;
  declinedAt?: string | null;
  manualOverride?: boolean;
}

interface ListResponse {
  items: Assignment[];
  count: number;
  statusCounts: Record<string, number>;
}

const STATUS_COLOR: Record<string, string> = {
  offered:   'text-amber-300',
  accepted:  'text-emerald-300',
  declined:  'text-zinc-400',
  expired:   'text-rose-400',
  cancelled: 'text-zinc-500',
};

const PRIORITY_COLOR: Record<string, string> = {
  normal:  'bg-blue-500/15 text-blue-300 border-blue-500/40',
  urgent:  'bg-rose-500/15 text-rose-300 border-rose-500/40',
  premium: 'bg-purple-500/15 text-purple-300 border-purple-500/40',
};

export default function AdminAssignmentsPage() {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/admin/assignments', { params: { status: status || undefined, limit: 50 } });
      setData(r.data || null);
    } catch { /* noop */ }
  }, [status]);

  useEffect(() => {
    (async () => { setLoading(true); await load(); setLoading(false); })();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const cancel = async (id: string) => {
    setBusyId(id);
    try { await api.post(`/admin/assignments/${id}/cancel`); await load(); }
    catch (e: any) { alert(e?.response?.data?.detail || 'Не удалось отменить'); }
    finally { setBusyId(null); }
  };

  if (loading) return <div className="p-6 text-zinc-400">Загрузка…</div>;
  if (!data) return <div className="p-6 text-rose-400">Не удалось загрузить.</div>;

  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="admin-assignments-page">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Radio className="w-7 h-7 text-amber-400" />
            Live Assignments
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Reputation-aware dispatch. Idempotent state machine. Lazy expiration.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowCreate(true)} className="flex items-center gap-2 px-3 py-2 bg-amber-500 text-zinc-900 hover:bg-amber-400 rounded text-sm font-semibold" data-testid="open-create-modal">
            <Plus className="w-4 h-4" /> Создать
          </button>
          <button onClick={load} className="flex items-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-sm text-zinc-200" data-testid="assignments-refresh">
            <RefreshCcw className="w-4 h-4" /> Обновить
          </button>
        </div>
      </div>

      {/* Status counts */}
      <div className="grid grid-cols-5 gap-3 mb-6">
        {(['offered', 'accepted', 'declined', 'expired', 'cancelled'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(status === s ? '' : s)}
            className={`p-4 rounded-xl text-left transition border ${status === s ? 'border-amber-400 bg-zinc-800' : 'border-zinc-800 bg-zinc-900 hover:bg-zinc-800'}`}
            data-testid={`status-card-${s}`}
          >
            <div className={`text-xs uppercase tracking-wide font-black ${STATUS_COLOR[s]}`}>{s}</div>
            <div className="text-3xl font-black text-white mt-2">{data.statusCounts[s] || 0}</div>
          </button>
        ))}
      </div>

      {/* Table */}
      {data.items.length === 0 ? (
        <div className="text-zinc-500 text-sm border border-dashed border-zinc-800 rounded-xl p-6 text-center">
          Нет назначений для выбранного фильтра.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-xs uppercase tracking-wide">
                <th className="text-left pb-2">ID</th>
                <th className="text-left pb-2">Job</th>
                <th className="text-left pb-2">Inspector</th>
                <th className="text-right pb-2">Score</th>
                <th className="text-left pb-2">Ranking</th>
                <th className="text-right pb-2">Status</th>
                <th className="text-right pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id} className="border-t border-zinc-800" data-testid={`assignment-row-${a.id}`}>
                  <td className="py-3 font-mono text-zinc-400 text-xs">{a.id.slice(-12)}</td>
                  <td className="py-3 text-zinc-200 font-mono text-xs">
                    <div>{a.jobId.slice(-10)}</div>
                    <span className={`inline-block mt-1 px-1.5 py-0.5 border rounded text-[10px] font-bold ${PRIORITY_COLOR[a.priority]}`}>{a.priority.toUpperCase()}</span>
                    {a.manualOverride && <Zap className="inline w-3 h-3 ml-1 text-amber-400" titleAccess="manual override" />}
                  </td>
                  <td className="py-3 text-zinc-200 font-mono text-xs">{a.inspectorId.slice(-12)}</td>
                  <td className="py-3 text-right text-white font-bold">{a.score}</td>
                  <td className="py-3 text-zinc-400 text-xs">
                    R{a.ranking.reputationScore} · D{a.ranking.distanceScore} · A{a.ranking.availabilityScore} · V{a.ranking.verificationScore}
                  </td>
                  <td className="py-3 text-right">
                    <span className={`text-xs font-black uppercase ${STATUS_COLOR[a.status]}`}>{a.status}</span>
                  </td>
                  <td className="py-3 text-right">
                    {a.status === 'offered' && (
                      <button
                        onClick={() => cancel(a.id)}
                        disabled={busyId === a.id}
                        className="text-xs px-2 py-1 bg-zinc-800 hover:bg-rose-800 disabled:opacity-50 rounded text-zinc-200 inline-flex items-center gap-1"
                        data-testid={`cancel-${a.id}`}
                      >
                        <XCircle className="w-3 h-3" /> {busyId === a.id ? '…' : 'Отмена'}
                      </button>
                    )}
                    {a.status === 'accepted' && <Lock className="inline w-3 h-3 text-emerald-400" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && <CreateAssignmentModal onClose={() => setShowCreate(false)} onDone={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreateAssignmentModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    jobId: '', inspectorId: '', priority: 'normal',
    estimatedEarnings: '', ttlSeconds: '', manualOverride: false,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/admin/assignments/create', {
        jobId: form.jobId,
        inspectorId: form.inspectorId,
        priority: form.priority,
        estimatedEarnings: form.estimatedEarnings ? Number(form.estimatedEarnings) : undefined,
        ttlSeconds: form.ttlSeconds ? Number(form.ttlSeconds) : undefined,
        manualOverride: form.manualOverride,
      });
      onDone();
    } catch (e: any) {
      setErr(e?.response?.data?.detail || 'Не удалось создать');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" data-testid="create-modal">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-bold text-white mb-4">Новое назначение</h2>
        <div className="space-y-3">
          <Field label="Job ID" value={form.jobId} onChange={(v) => setForm({ ...form, jobId: v })} testId="field-jobid" />
          <Field label="Inspector ID" value={form.inspectorId} onChange={(v) => setForm({ ...form, inspectorId: v })} testId="field-inspectorid" />
          <div>
            <label className="text-xs text-zinc-400 uppercase block mb-1">Priority</label>
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-100 text-sm" data-testid="field-priority">
              <option value="normal">normal</option>
              <option value="urgent">urgent</option>
              <option value="premium">premium</option>
            </select>
          </div>
          <Field label="Earnings (EUR)" value={form.estimatedEarnings} onChange={(v) => setForm({ ...form, estimatedEarnings: v })} placeholder="149" testId="field-earnings" />
          <Field label="TTL seconds (15–3600)" value={form.ttlSeconds} onChange={(v) => setForm({ ...form, ttlSeconds: v })} placeholder="120" testId="field-ttl" />
          <label className="flex items-center gap-2 text-sm text-zinc-300 select-none">
            <input type="checkbox" checked={form.manualOverride} onChange={(e) => setForm({ ...form, manualOverride: e.target.checked })} data-testid="field-override" />
            <span>Manual override (обходит hardFloor)</span>
          </label>
          {err && <div className="text-rose-400 text-xs">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-sm text-zinc-200">Отмена</button>
          <button onClick={submit} disabled={busy || !form.jobId || !form.inspectorId} className="px-3 py-2 bg-amber-500 text-zinc-900 hover:bg-amber-400 disabled:opacity-50 rounded text-sm font-semibold" data-testid="submit-create">
            {busy ? '…' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, testId }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; testId?: string }) {
  return (
    <div>
      <label className="text-xs text-zinc-400 uppercase block mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-100 text-sm font-mono"
        data-testid={testId}
      />
    </div>
  );
}

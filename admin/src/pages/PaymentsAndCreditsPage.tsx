// Sprint 3 — Admin payments + manual credit adjustment.
import { useEffect, useState, useCallback } from 'react';
import { Euro, RefreshCw, Plus, Minus, CreditCard, Wallet } from 'lucide-react';

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('admin_token') || '';
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export default function PaymentsAndCreditsPage() {
  const [payments, setPayments] = useState<any[]>([]);
  const [totalPaid, setTotalPaid] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const [uid, setUid] = useState('');
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [adjustResult, setAdjustResult] = useState<any | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/admin/payments${filter ? `?status=${filter}` : ''}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPayments(data.items || []);
      setTotalPaid(data.totalPaidAmount || 0);
    } catch (e: any) { setError(e?.message || 'load failed'); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const adjust = async (sign: 1 | -1) => {
    setAdjustResult(null); setError(null);
    const n = parseInt(delta, 10);
    if (!Number.isFinite(n) || n <= 0 || !uid.trim()) { setError('userId and positive delta required'); return; }
    try {
      const res = await fetch('/api/admin/credits/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ userId: uid.trim(), delta: n * sign, note: note || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAdjustResult(await res.json());
      load();
    } catch (e: any) { setError(e?.message || 'adjust failed'); }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6" data-testid="payments-page">
      <div className="mb-6 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-green-500/20 text-green-400 inline-flex items-center justify-center">
            <CreditCard size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold">Payments & Credits</h1>
            <p className="text-sm text-slate-400">Package payments (Stripe + PayPal mock) · manual credit adjustments</p>
          </div>
        </div>
        <button onClick={load} className="inline-flex items-center gap-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-2 text-sm font-bold">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Payments total" value={payments.length} />
        <Metric label="Paid" value={payments.filter((p) => p.status === 'paid').length} tone="green" />
        <Metric label="Pending" value={payments.filter((p) => p.status === 'pending').length} tone="amber" />
        <Metric label="Revenue (paid, €)" value={totalPaid} tone="green" big />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {['', 'pending', 'paid', 'failed', 'canceled'].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setFilter(s)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider ${
              filter === s ? 'bg-amber-500 text-black' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
            data-testid={`pay-filter-${s || 'all'}`}
          >
            {s || 'all'}
          </button>
        ))}
      </div>

      {error && <div className="rounded-xl border border-red-500/50 bg-red-500/10 text-red-300 px-4 py-3 text-sm mb-4">{error}</div>}

      <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 mb-8">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-left text-xs uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-3">Payment</th>
              <th className="px-4 py-3">Package</th>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">Loading…</td></tr>}
            {!loading && payments.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">No payments yet.</td></tr>
            )}
            {!loading && payments.map((p) => (
              <tr key={p.id} className="border-t border-slate-700" data-testid={`pay-row-${p.id}`}>
                <td className="px-4 py-3 font-mono text-xs text-slate-400">{p.id.substring(0, 12)}…</td>
                <td className="px-4 py-3 font-bold">{p.packageId} <span className="text-xs text-slate-500">({p.credits}x)</span></td>
                <td className="px-4 py-3 text-slate-400 text-xs">{p.userId ? p.userId.substring(0, 12) + '…' : '—'}</td>
                <td className="px-4 py-3 font-bold"><span className="inline-flex items-center gap-1"><Euro size={13} /> {p.amount}</span></td>
                <td className="px-4 py-3 uppercase text-xs font-bold">{p.provider}</td>
                <td className="px-4 py-3"><StatusPill status={p.status} /></td>
                <td className="px-4 py-3 text-slate-500 text-xs">{p.createdAt ? new Date(p.createdAt).toLocaleString() : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Manual adjust */}
      <div className="rounded-2xl border border-slate-700 bg-slate-800 p-6" data-testid="credits-adjust">
        <div className="flex items-center gap-3 mb-4">
          <div className="h-10 w-10 rounded-xl bg-amber-500/20 text-amber-400 inline-flex items-center justify-center">
            <Wallet size={20} />
          </div>
          <div>
            <h2 className="text-xl font-extrabold">Manual credit adjust</h2>
            <p className="text-sm text-slate-400">Add or remove inspection credits for a user. Every change is logged in ledger.</p>
          </div>
        </div>
        <div className="grid md:grid-cols-3 gap-3 mb-3">
          <input value={uid} onChange={(e) => setUid(e.target.value)} placeholder="User ID" className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2.5 text-sm" data-testid="adj-uid" />
          <input value={delta} onChange={(e) => setDelta(e.target.value.replace(/[^0-9]/g, ''))} placeholder="Amount (positive)" className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2.5 text-sm" data-testid="adj-delta" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2.5 text-sm" data-testid="adj-note" />
        </div>
        <div className="flex gap-2">
          <button onClick={() => adjust(1)} className="inline-flex items-center gap-1 rounded-lg bg-green-500/20 hover:bg-green-500/30 text-green-300 border border-green-500/40 px-4 py-2 text-sm font-bold" data-testid="adj-add">
            <Plus size={14} /> Add credits
          </button>
          <button onClick={() => adjust(-1)} className="inline-flex items-center gap-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 px-4 py-2 text-sm font-bold" data-testid="adj-remove">
            <Minus size={14} /> Remove credits
          </button>
        </div>
        {adjustResult && (
          <div className="mt-4 rounded-lg bg-slate-900 border border-slate-700 p-3 text-xs font-mono text-slate-300" data-testid="adj-result">
            balance={adjustResult.balance} · reserved={adjustResult.reserved} · used={adjustResult.used} · available={adjustResult.available}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'bg-amber-500/20 text-amber-300',
    paid: 'bg-green-500/20 text-green-300',
    failed: 'bg-red-500/20 text-red-300',
    canceled: 'bg-slate-500/20 text-slate-300',
  };
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider ${map[status] || map.pending}`}>{status}</span>;
}

function Metric({ label, value, tone, big }: { label: string; value: any; tone?: string; big?: boolean }) {
  const toneMap: Record<string, string> = { green: 'text-green-300', amber: 'text-amber-300' };
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 p-3.5">
      <div className={`${big ? 'text-3xl' : 'text-2xl'} font-extrabold ${tone ? toneMap[tone] : 'text-slate-100'}`}>{value}</div>
      <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}

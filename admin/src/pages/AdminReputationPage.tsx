/**
 * Sprint 3 Step 3 — Admin reputation overview.
 *
 * Control-tower style: top inspectors / risky inspectors / tier
 * distribution / flagged total. Force recompute action per row.
 *
 * Read-only otherwise. No tuning of weights from this page — V1 keeps
 * the engine's named constants as the only source of truth.
 */
import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { ShieldCheck, AlertTriangle, RefreshCcw, Award, Lock } from 'lucide-react';

const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use((cfg) => {
  const t = localStorage.getItem('admin_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

interface UserRep {
  userId: string;
  name?: string;
  email?: string;
  reputation: {
    score: number;
    tier: string;
    hardFloor?: boolean;
    hardFloorReason?: string | null;
    inspectionQuality: number;
    evidenceCompleteness: number;
    customerAcceptance: number;
    disputeRate: number;
    aiAlignment: number;
    responseDiscipline: number;
    verificationScore: number;
    updatedAt?: string;
  };
}

interface Overview {
  top: UserRep[];
  risky: UserRep[];
  tierCounts: Record<string, number>;
  flaggedTotal: number;
}

const TIER_COLOR: Record<string, string> = {
  bronze:   'text-amber-400',
  silver:   'text-zinc-300',
  gold:     'text-yellow-400',
  platinum: 'text-sky-400',
};

export default function AdminReputationPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/admin/reputation', { params: { top_limit: 10, risky_limit: 10 } });
      setData(r.data || null);
    } catch { /* noop */ }
  }, []);

  useEffect(() => { (async () => { setLoading(true); await load(); setLoading(false); })(); }, [load]);

  const forceRecompute = async (userId: string) => {
    setBusyId(userId);
    try { await api.post(`/admin/reputation/recompute/${userId}`); await load(); }
    finally { setBusyId(null); }
  };

  if (loading) return <div className="p-6 text-zinc-400">Загрузка…</div>;
  if (!data) return <div className="p-6 text-rose-400">Не удалось загрузить данные.</div>;

  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="admin-reputation-page">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Award className="w-7 h-7 text-amber-400" />
            Reputation Control Tower
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Durable trust layer: timeline + reports + disputes + overrides + verification → tier.
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-sm text-zinc-200" data-testid="reputation-refresh">
          <RefreshCcw className="w-4 h-4" /> Обновить
        </button>
      </div>

      {/* Tier distribution */}
      <div className="grid grid-cols-5 gap-3 mb-6">
        {(['bronze', 'silver', 'gold', 'platinum'] as const).map((t) => (
          <div key={t} className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl" data-testid={`tier-card-${t}`}>
            <div className={`text-xs uppercase tracking-wide font-black ${TIER_COLOR[t]}`}>{t}</div>
            <div className="text-3xl font-black text-white mt-2">{data.tierCounts[t] || 0}</div>
            <div className="text-xs text-zinc-500 mt-1">inspectors</div>
          </div>
        ))}
        <div className="p-4 bg-rose-950/30 border border-rose-900 rounded-xl" data-testid="flagged-card">
          <div className="text-xs uppercase tracking-wide font-black text-rose-300 flex items-center gap-1">
            <Lock className="w-3 h-3" /> Hard floor
          </div>
          <div className="text-3xl font-black text-rose-200 mt-2">{data.flaggedTotal}</div>
          <div className="text-xs text-rose-400 mt-1">open disputes</div>
        </div>
      </div>

      {/* Top */}
      <Section title="Top inspectors" icon={<ShieldCheck className="w-5 h-5 text-emerald-400" />} tone="emerald">
        <RepTable rows={data.top} onRecompute={forceRecompute} busyId={busyId} testIdPrefix="top" />
      </Section>

      {/* Risky */}
      <Section title="Risky inspectors" icon={<AlertTriangle className="w-5 h-5 text-rose-400" />} tone="rose">
        <RepTable rows={data.risky} onRecompute={forceRecompute} busyId={busyId} testIdPrefix="risky" />
      </Section>
    </div>
  );
}

function Section({ title, icon, children, tone }: { title: string; icon: any; children: any; tone: 'emerald' | 'rose' }) {
  return (
    <div className="mb-8">
      <h2 className={`text-lg font-bold text-white flex items-center gap-2 mb-3 ${tone === 'rose' ? 'text-rose-200' : 'text-emerald-200'}`}>
        {icon} {title}
      </h2>
      {children}
    </div>
  );
}

function RepTable({ rows, onRecompute, busyId, testIdPrefix }: { rows: UserRep[]; onRecompute: (id: string) => void; busyId: string | null; testIdPrefix: string }) {
  if (rows.length === 0) {
    return <div className="text-zinc-500 text-sm border border-dashed border-zinc-800 rounded-xl p-6 text-center">Нет данных.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-500 text-xs uppercase tracking-wide">
            <th className="text-left pb-2">Inspector</th>
            <th className="text-right pb-2">Score</th>
            <th className="text-right pb-2">Tier</th>
            <th className="text-right pb-2">Quality</th>
            <th className="text-right pb-2">Accept</th>
            <th className="text-right pb-2">AI align</th>
            <th className="text-right pb-2">Disc</th>
            <th className="text-right pb-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => {
            const r = u.reputation;
            return (
              <tr key={u.userId} className="border-t border-zinc-800" data-testid={`${testIdPrefix}-row-${u.userId}`}>
                <td className="py-2 text-zinc-200">
                  <div className="font-semibold">{u.name || u.email || u.userId}</div>
                  <div className="text-xs text-zinc-500">{u.userId}</div>
                </td>
                <td className="text-right text-white font-bold">{r.score}</td>
                <td className="text-right">
                  <span className={`text-xs font-black uppercase ${TIER_COLOR[r.tier] || 'text-zinc-300'}`}>
                    {r.tier}
                  </span>
                  {r.hardFloor && <Lock className="inline w-3 h-3 ml-1 text-rose-400" />}
                </td>
                <td className="text-right text-zinc-300">{r.inspectionQuality}</td>
                <td className="text-right text-zinc-300">{r.customerAcceptance}</td>
                <td className="text-right text-zinc-300">{r.aiAlignment}</td>
                <td className="text-right text-zinc-300">{r.responseDiscipline}</td>
                <td className="text-right">
                  <button
                    onClick={() => onRecompute(u.userId)}
                    disabled={busyId === u.userId}
                    className="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded text-zinc-200"
                    data-testid={`recompute-${u.userId}`}
                  >
                    {busyId === u.userId ? '…' : 'Recompute'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

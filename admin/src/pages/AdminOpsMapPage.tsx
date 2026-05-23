/**
 * Sprint 3 Step 5 — Ops Map (admin).
 *
 * Read-only operational dashboard. Polls /api/admin/ops-map/snapshot
 * every 15s. No external map SDK — uses grid/board to visualise the
 * state until a real map provider is wired in a later sprint.
 */
import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Map as MapIcon, Users, Briefcase, Radio, AlertTriangle,
  RefreshCcw, Activity, Flame, Lock,
} from 'lucide-react';

const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use((cfg) => {
  const t = localStorage.getItem('admin_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

interface Zone {
  id: string;
  label: string;
  city?: string;
  center?: { lat: number; lng: number };
  demand: number;
  supply: number;
  busy: number;
  ratio: number;
  pressure: 'low' | 'medium' | 'high' | 'critical';
}
interface Inspector {
  id: string;
  name?: string;
  status: 'online' | 'offline' | 'busy' | 'blocked';
  tier: string;
  score: number;
  zone?: string | null;
  activeJobs: number;
  excludedFromSupply?: string;
  hardFloor?: boolean;
  location?: { lat: number; lng: number } | null;
}
interface Assignment {
  id: string;
  jobId: string;
  status: string;
  priority: string;
  score: number;
  expiresAt: string;
  distanceKm: number | null;
  zone?: string | null;
}
interface Job {
  id: string;
  vehicle: string;
  status: string;
  inspectorId?: string | null;
  customerZone?: string | null;
  slaRisk: 'ok' | 'watch' | 'late';
}
interface Snapshot {
  generatedAt: string;
  zones: Zone[];
  inspectors: Inspector[];
  assignments: Assignment[];
  jobs: Job[];
  summary: {
    totalZones: number; totalInspectors: number;
    onlineInspectors: number; busyInspectors: number; blockedInspectors: number;
    activeJobs: number; lateJobs: number; watchJobs: number;
    liveOffers: number; claimedAssignments: number;
    criticalZones: number; highPressureZones: number;
  };
}

const PRESSURE_COLOR: Record<string, string> = {
  low:      'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
  medium:   'bg-amber-500/15  border-amber-500/40  text-amber-300',
  high:     'bg-orange-500/15 border-orange-500/40 text-orange-300',
  critical: 'bg-rose-500/15   border-rose-500/40   text-rose-300',
};
const STATUS_COLOR: Record<string, string> = {
  online:  'text-emerald-400',
  busy:    'text-amber-400',
  blocked: 'text-rose-400',
  offline: 'text-zinc-500',
};
const TIER_COLOR: Record<string, string> = {
  bronze: 'text-amber-400', silver: 'text-zinc-300',
  gold:   'text-yellow-400', platinum: 'text-sky-400',
};
const SLA_COLOR: Record<string, string> = {
  ok:    'text-emerald-300', watch: 'text-amber-300', late: 'text-rose-400',
};

export default function AdminOpsMapPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/admin/ops-map/snapshot');
      setSnap(r.data || null);
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(); setLoading(false); })();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <div className="p-6 text-zinc-400">Загрузка…</div>;
  if (!snap)   return <div className="p-6 text-rose-400">Не удалось загрузить snapshot.</div>;

  const filteredInspectors = selectedZone ? snap.inspectors.filter((i) => i.zone === selectedZone) : snap.inspectors;
  const filteredAssignments = selectedZone ? snap.assignments.filter((a) => a.zone === selectedZone) : snap.assignments;
  const filteredJobs = selectedZone ? snap.jobs.filter((j) => j.customerZone === selectedZone) : snap.jobs;

  return (
    <div className="p-6 max-w-7xl mx-auto" data-testid="admin-ops-map-page">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <MapIcon className="w-7 h-7 text-amber-400" />
            Ops Map
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Operational projection · pressure = demand / max(supply, 1) · generated {new Date(snap.generatedAt).toLocaleTimeString('ru-RU')}
          </p>
        </div>
        <button onClick={load} className="flex items-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded text-sm text-zinc-200" data-testid="opsmap-refresh">
          <RefreshCcw className="w-4 h-4" /> Обновить
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-6 gap-3 mb-6">
        <Stat label="Zones" value={snap.summary.totalZones} icon={<MapIcon className="w-4 h-4 text-zinc-400" />} testId="stat-zones" />
        <Stat label="Online" value={snap.summary.onlineInspectors} icon={<Activity className="w-4 h-4 text-emerald-400" />} tone="emerald" testId="stat-online" />
        <Stat label="Busy" value={snap.summary.busyInspectors} icon={<Users className="w-4 h-4 text-amber-400" />} tone="amber" testId="stat-busy" />
        <Stat label="Active jobs" value={snap.summary.activeJobs} icon={<Briefcase className="w-4 h-4 text-sky-400" />} tone="sky" testId="stat-jobs" />
        <Stat label="Live offers" value={snap.summary.liveOffers} icon={<Radio className="w-4 h-4 text-purple-400" />} tone="purple" testId="stat-offers" />
        <Stat label="Late SLA" value={snap.summary.lateJobs} icon={<AlertTriangle className="w-4 h-4 text-rose-400" />} tone="rose" testId="stat-late" />
      </div>

      {/* Zone pressure board */}
      <h2 className="text-sm uppercase tracking-wider font-bold text-zinc-400 mb-3 flex items-center gap-2">
        <Flame className="w-4 h-4 text-amber-400" /> Zone pressure
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        {snap.zones.length === 0 ? (
          <div className="col-span-4 text-zinc-500 text-sm border border-dashed border-zinc-800 rounded-xl p-6 text-center">
            Нет зарегистрированных зон.
          </div>
        ) : snap.zones.map((z) => (
          <button
            key={z.id}
            onClick={() => setSelectedZone(selectedZone === z.id ? null : z.id)}
            className={`text-left p-4 rounded-xl border transition ${PRESSURE_COLOR[z.pressure]} ${selectedZone === z.id ? 'ring-2 ring-amber-400' : ''}`}
            data-testid={`zone-card-${z.id}`}
          >
            <div className="text-xs uppercase tracking-wide font-black">{z.pressure}</div>
            <div className="text-lg font-bold text-white mt-1">{z.label}</div>
            <div className="text-xs opacity-70 mt-1">{z.city}</div>
            <div className="flex items-center gap-3 mt-3 text-xs">
              <span title="demand">D <b className="text-white">{z.demand}</b></span>
              <span title="supply (online & free)">S <b className="text-white">{z.supply}</b></span>
              <span title="busy">B <b className="text-white">{z.busy}</b></span>
              <span title="ratio = demand / max(supply, 1)" className="ml-auto">×{z.ratio}</span>
            </div>
          </button>
        ))}
      </div>

      {selectedZone && (
        <div className="mb-4 text-sm text-amber-300">
          Фильтр: <b>{selectedZone}</b>{' '}
          <button onClick={() => setSelectedZone(null)} className="underline ml-2 text-zinc-400" data-testid="clear-zone-filter">сбросить</button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Inspectors */}
        <Panel title="Inspectors" icon={<Users className="w-4 h-4" />} testId="panel-inspectors">
          {filteredInspectors.length === 0 ? <Empty text="Нет инспекторов." /> : (
            <table className="w-full text-xs">
              <thead><tr className="text-zinc-500"><th className="text-left pb-1">Name</th><th className="text-left pb-1">Status</th><th className="text-right pb-1">Tier</th><th className="text-right pb-1">Score</th><th className="text-right pb-1">Jobs</th></tr></thead>
              <tbody>
                {filteredInspectors.slice(0, 20).map((i) => (
                  <tr key={i.id} className="border-t border-zinc-800/60" data-testid={`insp-${i.id}`}>
                    <td className="py-1.5 text-zinc-200">
                      {i.name || i.id.slice(-10)}
                      {i.hardFloor && <Lock className="inline w-3 h-3 ml-1 text-rose-400" />}
                    </td>
                    <td className={`py-1.5 font-bold ${STATUS_COLOR[i.status] || 'text-zinc-400'}`}>{i.status}</td>
                    <td className={`py-1.5 text-right font-bold ${TIER_COLOR[i.tier] || 'text-zinc-400'}`}>{i.tier}</td>
                    <td className="py-1.5 text-right text-white">{i.score}</td>
                    <td className="py-1.5 text-right text-zinc-300">{i.activeJobs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {/* Assignments */}
        <Panel title="Live assignments" icon={<Radio className="w-4 h-4" />} testId="panel-assignments">
          {filteredAssignments.length === 0 ? <Empty text="Нет активных предложений." /> : (
            <table className="w-full text-xs">
              <thead><tr className="text-zinc-500"><th className="text-left pb-1">ID</th><th className="text-left pb-1">Status</th><th className="text-left pb-1">Priority</th><th className="text-right pb-1">Score</th><th className="text-right pb-1">Dist</th></tr></thead>
              <tbody>
                {filteredAssignments.slice(0, 20).map((a) => (
                  <tr key={a.id} className="border-t border-zinc-800/60" data-testid={`asg-${a.id}`}>
                    <td className="py-1.5 font-mono text-zinc-400">{a.id.slice(-10)}</td>
                    <td className="py-1.5 text-zinc-200">{a.status}</td>
                    <td className="py-1.5 text-zinc-200">{a.priority}</td>
                    <td className="py-1.5 text-right text-white font-bold">{a.score}</td>
                    <td className="py-1.5 text-right text-zinc-300">{a.distanceKm ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {/* Active jobs */}
        <Panel title="Active jobs" icon={<Briefcase className="w-4 h-4" />} className="md:col-span-2" testId="panel-jobs">
          {filteredJobs.length === 0 ? <Empty text="Нет активных проверок." /> : (
            <table className="w-full text-xs">
              <thead><tr className="text-zinc-500"><th className="text-left pb-1">ID</th><th className="text-left pb-1">Vehicle</th><th className="text-left pb-1">Status</th><th className="text-left pb-1">Zone</th><th className="text-right pb-1">SLA</th></tr></thead>
              <tbody>
                {filteredJobs.slice(0, 30).map((j) => (
                  <tr key={j.id} className="border-t border-zinc-800/60" data-testid={`job-${j.id}`}>
                    <td className="py-1.5 font-mono text-zinc-400">{j.id.slice(-10)}</td>
                    <td className="py-1.5 text-zinc-200">{j.vehicle}</td>
                    <td className="py-1.5 text-zinc-200">{j.status}</td>
                    <td className="py-1.5 text-zinc-400">{j.customerZone || '—'}</td>
                    <td className={`py-1.5 text-right font-bold ${SLA_COLOR[j.slaRisk] || 'text-zinc-400'}`}>{j.slaRisk}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, value, icon, tone, testId }: { label: string; value: number; icon: any; tone?: string; testId?: string }) {
  const bg = tone === 'emerald' ? 'border-emerald-700/40 bg-emerald-950/30'
    : tone === 'amber' ? 'border-amber-700/40 bg-amber-950/30'
    : tone === 'sky' ? 'border-sky-700/40 bg-sky-950/30'
    : tone === 'purple' ? 'border-purple-700/40 bg-purple-950/30'
    : tone === 'rose' ? 'border-rose-700/40 bg-rose-950/30'
    : 'border-zinc-800 bg-zinc-900';
  return (
    <div className={`p-3 rounded-xl border ${bg}`} data-testid={testId}>
      <div className="flex items-center gap-2 text-xs text-zinc-400 uppercase tracking-wider">{icon}{label}</div>
      <div className="text-3xl font-black text-white mt-1">{value}</div>
    </div>
  );
}

function Panel({ title, icon, children, className = '', testId }: any) {
  return (
    <div className={`bg-zinc-900 border border-zinc-800 rounded-xl p-4 ${className}`} data-testid={testId}>
      <h3 className="text-sm font-bold text-zinc-300 mb-3 flex items-center gap-2">{icon}{title}</h3>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-zinc-500 text-sm border border-dashed border-zinc-800 rounded-lg p-6 text-center">{text}</div>;
}

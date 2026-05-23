import { useEffect, useState, useCallback } from 'react';
import {
  Gauge,
  Lock,
  Unlock,
  Zap,
  Sliders,
  Activity,
  AlertOctagon,
  Banknote,
  RefreshCw,
  PlayCircle,
  XCircle,
} from 'lucide-react';
import api from '../services/api';

// ─── Types ─────────────────────────────────────────────────────────────────
interface Zone {
  id: string;
  name: string;
  status: string;
  ratio: number;
  surgeMultiplier: number;
  demandScore: number;
  supplyScore: number;
  avgEta: number;
  matchRate: number;
  color: string;
  overrideMode?: string;
  overriddenUntil?: string;
}
interface Strategy {
  zoneId: string;
  auto: boolean;
  locked: boolean;
  minWeight: number;
  maxWeight: number;
  weights: Record<string, number>;
}
interface TimelineItem {
  time: string;
  action: string;
  source: string;
  reason?: string;
  impact?: Record<string, number | string>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}
interface AlertItem {
  id: string;
  level: 'critical' | 'warning';
  type: string;
  title: string;
  message: string;
  zone?: string;
  zoneId?: string;
  impact: { lostRevenuePerHour?: number; missedBookings?: number };
  recommendedAction: string;
}

const MODES = ['FORCE_BALANCED', 'FORCE_BUSY', 'FORCE_SURGE', 'FORCE_CRITICAL'] as const;

export default function ZoneControlPage() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertsSummary, setAlertsSummary] = useState<{
    totalLostRevenuePerHour: number;
    totalMissedBookings: number;
    criticalCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string>('');

  const [overrideMode, setOverrideMode] = useState<typeof MODES[number]>('FORCE_SURGE');
  const [fanout, setFanout] = useState(4);
  const [priorityOnly, setPriorityOnly] = useState(false);
  const [ttlSeconds, setTtlSeconds] = useState(600);

  const loadZones = useCallback(async () => {
    const res = await api.get<{ zones: Zone[] }>('/zones');
    setZones(res.data.zones || []);
    if (!selectedId && res.data.zones?.[0]) setSelectedId(res.data.zones[0].id);
  }, [selectedId]);

  const loadAlerts = useCallback(async () => {
    const res = await api.get('/admin/alerts/enhanced');
    setAlerts(res.data.alerts || []);
    setAlertsSummary(res.data.summary || null);
  }, []);

  const loadZoneDetails = useCallback(async (zid: string) => {
    if (!zid) return;
    try {
      const [tl, st] = await Promise.all([
        api.get<{ timeline: TimelineItem[] }>(`/admin/zones/${zid}/timeline?hours=6`),
        api.get<Strategy>(`/admin/strategy/${zid}`).catch(() => ({ data: null as any })),
      ]);
      setTimeline(tl.data.timeline || []);
      setStrategy(st.data);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    loadZones();
    loadAlerts();
  }, [loadZones, loadAlerts]);

  useEffect(() => {
    if (selectedId) loadZoneDetails(selectedId);
    const t = setInterval(() => {
      loadZones();
      loadAlerts();
      if (selectedId) loadZoneDetails(selectedId);
    }, 10000);
    return () => clearInterval(t);
  }, [selectedId, loadZoneDetails, loadZones, loadAlerts]);

  const selectedZone = zones.find((z) => z.id === selectedId);

  const applyOverride = async () => {
    if (!selectedId) return;
    setLoading(true);
    try {
      await api.post(`/admin/zones/${selectedId}/override`, {
        mode: overrideMode,
        fanout,
        priorityOnly,
        ttlSeconds,
      });
      setMsg(`✓ Override applied: ${overrideMode}`);
      await loadZones();
      await loadZoneDetails(selectedId);
    } catch (e: any) {
      setMsg(`✗ ${e.message || 'Failed'}`);
    }
    setLoading(false);
    setTimeout(() => setMsg(''), 4000);
  };

  const clearOverride = async () => {
    if (!selectedId) return;
    setLoading(true);
    try {
      await api.delete(`/admin/zones/${selectedId}/override`);
      setMsg(`✓ Override cleared`);
      await loadZones();
      await loadZoneDetails(selectedId);
    } catch (e: any) {
      setMsg(`✗ ${e.message || 'Failed'}`);
    }
    setLoading(false);
    setTimeout(() => setMsg(''), 4000);
  };

  const saveStrategy = async () => {
    if (!strategy) return;
    setLoading(true);
    try {
      await api.post(`/admin/strategy/${strategy.zoneId}`, {
        auto: strategy.auto,
        locked: strategy.locked,
        minWeight: strategy.minWeight,
        maxWeight: strategy.maxWeight,
        weights: strategy.weights,
      });
      setMsg(`✓ Strategy saved`);
    } catch (e: any) {
      setMsg(`✗ ${e.message || 'Failed'}`);
    }
    setLoading(false);
    setTimeout(() => setMsg(''), 4000);
  };

  const updateWeight = (action: string, value: number) => {
    if (!strategy) return;
    setStrategy({ ...strategy, weights: { ...strategy.weights, [action]: value } });
  };

  return (
    <div className="p-6 bg-slate-900 min-h-screen" data-testid="zone-control-page">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-orange-500/20 rounded-lg">
            <Gauge className="w-6 h-6 text-orange-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Zone Control Center</h1>
            <p className="text-sm text-slate-400">
              Sprint 9 — override / strategy / business impact
            </p>
          </div>
        </div>
        {msg && <div className="px-4 py-2 bg-slate-800 text-slate-200 rounded-lg text-sm">{msg}</div>}
      </div>

      <div className="grid grid-cols-3 gap-4 mb-5">
        <KpiCard
          label="Lost revenue / hour"
          value={`${alertsSummary?.totalLostRevenuePerHour || 0} ₴`}
          color="rose"
          icon={<Banknote className="w-4 h-4" />}
        />
        <KpiCard
          label="Missed bookings"
          value={alertsSummary?.totalMissedBookings || 0}
          color="amber"
          icon={<AlertOctagon className="w-4 h-4" />}
        />
        <KpiCard
          label="Critical alerts"
          value={alertsSummary?.criticalCount || 0}
          color="red"
          icon={<Zap className="w-4 h-4" />}
        />
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-5 bg-slate-800 rounded-xl p-4 border border-slate-700">
          <h2 className="text-white font-semibold mb-3 flex items-center gap-2">
            <Activity className="w-4 h-4" /> Zones
          </h2>
          <div className="grid grid-cols-1 gap-2 max-h-[500px] overflow-y-auto">
            {zones.map((z) => (
              <button
                key={z.id}
                data-testid={`zone-${z.id}`}
                onClick={() => setSelectedId(z.id)}
                className={`text-left p-3 rounded-lg border transition ${
                  selectedId === z.id
                    ? 'border-orange-400 bg-orange-500/10'
                    : 'border-slate-700 bg-slate-900 hover:border-slate-500'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: z.color }} />
                    <span className="text-white font-medium">{z.name}</span>
                    {z.overrideMode && (
                      <span
                        className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 uppercase"
                        title={`Until ${z.overriddenUntil?.slice(11, 19)}`}
                      >
                        OVR
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-slate-400">
                    {z.status} · ×{z.surgeMultiplier}
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  demand {z.demandScore} / supply {z.supplyScore} · ratio{' '}
                  <span className="text-slate-300">{z.ratio}</span> · ETA {z.avgEta}m
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="col-span-7 space-y-4">
          {selectedZone && (
            <>
              <div className="bg-slate-800 rounded-xl p-4 border border-slate-700">
                <h2 className="text-white font-semibold mb-3 flex items-center gap-2">
                  <Zap className="w-4 h-4" /> Override — {selectedZone.name}
                </h2>
                {selectedZone.overrideMode && (
                  <div className="mb-3 p-3 bg-purple-500/10 border border-purple-500/30 rounded text-sm text-purple-200 flex items-center justify-between">
                    <div>
                      <b>Active:</b> {selectedZone.overrideMode} until{' '}
                      {selectedZone.overriddenUntil?.slice(11, 19)}
                    </div>
                    <button
                      data-testid="clear-override-btn"
                      onClick={clearOverride}
                      disabled={loading}
                      className="px-3 py-1 bg-red-600/30 hover:bg-red-600/50 text-red-100 rounded text-xs flex items-center gap-1"
                    >
                      <XCircle className="w-3 h-3" /> Clear
                    </button>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Mode</label>
                    <select
                      data-testid="override-mode"
                      value={overrideMode}
                      onChange={(e) => setOverrideMode(e.target.value as typeof MODES[number])}
                      className="w-full bg-slate-900 border border-slate-600 text-white rounded px-3 py-2 text-sm"
                    >
                      {MODES.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      Fanout <span className="text-orange-400">({fanout})</span>
                    </label>
                    <input
                      data-testid="override-fanout"
                      type="range"
                      min={1}
                      max={10}
                      value={fanout}
                      onChange={(e) => setFanout(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      data-testid="override-priority-only"
                      id="po"
                      type="checkbox"
                      checked={priorityOnly}
                      onChange={(e) => setPriorityOnly(e.target.checked)}
                    />
                    <label htmlFor="po" className="text-sm text-slate-300">
                      Priority-only (VIP)
                    </label>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">
                      TTL <span className="text-orange-400">({ttlSeconds}s)</span>
                    </label>
                    <input
                      data-testid="override-ttl"
                      type="range"
                      min={60}
                      max={3600}
                      step={60}
                      value={ttlSeconds}
                      onChange={(e) => setTtlSeconds(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>
                </div>
                <button
                  data-testid="apply-override-btn"
                  onClick={applyOverride}
                  disabled={loading}
                  className="mt-3 w-full bg-orange-500 hover:bg-orange-600 text-white font-medium py-2 rounded flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  <PlayCircle className="w-4 h-4" /> Apply override
                </button>
              </div>

              {strategy && (
                <div className="bg-slate-800 rounded-xl p-4 border border-slate-700" data-testid="strategy-panel">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-white font-semibold flex items-center gap-2">
                      <Sliders className="w-4 h-4" /> Strategy — {strategy.zoneId}
                    </h2>
                    <div className="flex items-center gap-3 text-xs">
                      <label className="flex items-center gap-1 text-slate-300">
                        <input
                          data-testid="strategy-auto"
                          type="checkbox"
                          checked={strategy.auto}
                          onChange={(e) => setStrategy({ ...strategy, auto: e.target.checked })}
                        />
                        auto-learn
                      </label>
                      <label className="flex items-center gap-1 text-slate-300">
                        <input
                          data-testid="strategy-locked"
                          type="checkbox"
                          checked={strategy.locked}
                          onChange={(e) => setStrategy({ ...strategy, locked: e.target.checked })}
                        />
                        locked {strategy.locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                      </label>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <NumInput label="Min weight" value={strategy.minWeight} onChange={(v) => setStrategy({ ...strategy, minWeight: v })} testId="strategy-min" />
                    <NumInput label="Max weight" value={strategy.maxWeight} onChange={(v) => setStrategy({ ...strategy, maxWeight: v })} testId="strategy-max" />
                  </div>
                  <div className="space-y-2 max-h-44 overflow-y-auto">
                    {Object.entries(strategy.weights || {}).map(([k, v]) => (
                      <div key={k} className="grid grid-cols-[1fr_auto_80px] gap-2 items-center">
                        <span className="text-xs font-mono text-slate-300">{k}</span>
                        <input
                          type="range"
                          min={strategy.minWeight}
                          max={strategy.maxWeight}
                          step={0.01}
                          value={v}
                          onChange={(e) => updateWeight(k, Number(e.target.value))}
                          className="w-full"
                        />
                        <span className="text-xs text-orange-300 text-right font-mono">
                          {v.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <button
                    data-testid="save-strategy-btn"
                    onClick={saveStrategy}
                    disabled={loading}
                    className="mt-3 w-full bg-blue-500 hover:bg-blue-600 text-white font-medium py-2 rounded text-sm"
                  >
                    Save strategy
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 mt-4">
        <div className="col-span-7 bg-slate-800 rounded-xl p-4 border border-slate-700">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <RefreshCw className="w-4 h-4" /> Timeline — {selectedZone?.name || '—'}
            </h2>
            <span className="text-xs text-slate-500">{timeline.length} events (6h)</span>
          </div>
          <div className="space-y-2 max-h-[340px] overflow-y-auto">
            {timeline.map((t, i) => (
              <div key={i} className="p-2 bg-slate-900 border border-slate-700 rounded text-xs" data-testid={`timeline-item-${i}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-slate-400 font-mono">{t.time?.slice(11, 19)}</span>
                  <span className="text-orange-300 font-semibold">{t.action}</span>
                  <span className="text-slate-500">{t.source}</span>
                </div>
                {t.reason && <div className="text-slate-300 mb-1">{t.reason}</div>}
                {t.impact && Object.keys(t.impact).length > 0 && (
                  <div className="flex flex-wrap gap-2 text-[10px]">
                    {Object.entries(t.impact).map(([k, v]) => (
                      <span key={k} className="px-2 py-0.5 rounded bg-slate-700 text-slate-200 font-mono">
                        {k}={String(v)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {!timeline.length && (
              <div className="text-center text-slate-500 text-sm p-6">нет событий за 6 часов</div>
            )}
          </div>
        </div>

        <div className="col-span-5 bg-slate-800 rounded-xl p-4 border border-slate-700">
          <h2 className="text-white font-semibold mb-3 flex items-center gap-2">
            <AlertOctagon className="w-4 h-4 text-red-400" /> Alerts with impact
          </h2>
          <div className="space-y-2 max-h-[340px] overflow-y-auto">
            {alerts.map((a) => (
              <div
                key={a.id}
                data-testid={`alert-${a.id}`}
                className={`p-3 border rounded-lg text-xs ${
                  a.level === 'critical'
                    ? 'border-red-500/40 bg-red-500/5'
                    : 'border-amber-500/40 bg-amber-500/5'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-slate-200">{a.title}</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded uppercase ${
                    a.level === 'critical' ? 'bg-red-500/30 text-red-200' : 'bg-amber-500/30 text-amber-200'
                  }`}>
                    {a.level}
                  </span>
                </div>
                <div className="text-slate-400 mb-2">{a.message}</div>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-rose-300">−{a.impact?.lostRevenuePerHour || 0} ₴/h</span>
                  <span className="font-mono text-amber-300">{a.impact?.missedBookings || 0} missed</span>
                  <span className="ml-auto text-blue-300 font-semibold">→ {a.recommendedAction}</span>
                </div>
              </div>
            ))}
            {!alerts.length && (
              <div className="text-center text-slate-500 text-sm p-6">нет алёртов 🎉</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  icon, label, value, color,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  color: 'red' | 'amber' | 'rose';
}) {
  const palette: Record<string, string> = {
    red: 'text-red-400 bg-red-500/10 border-red-500/30',
    amber: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    rose: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
  };
  return (
    <div className={`rounded-xl border p-4 ${palette[color]}`}>
      <div className="flex items-center gap-2 text-slate-300 mb-1 text-xs">
        {icon} {label}
      </div>
      <span className="text-2xl font-bold">{value}</span>
    </div>
  );
}

function NumInput({
  label, value, onChange, testId,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  testId: string;
}) {
  return (
    <div>
      <label className="text-xs text-slate-400 block mb-1">{label}</label>
      <input
        data-testid={testId}
        type="number"
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full bg-slate-900 border border-slate-600 text-white rounded px-3 py-2 text-sm"
      />
    </div>
  );
}

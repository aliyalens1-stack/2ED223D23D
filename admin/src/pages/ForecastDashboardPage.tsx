import { useEffect, useState } from 'react';
import axios from 'axios';
import { Brain, RefreshCw, Activity, TrendingUp, Cpu } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Legend, CartesianGrid, ErrorBar
} from 'recharts';

const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

interface ForecastZone {
  name: string;
  mae?: number;
  prediction?: { p10: number; p50: number; p90: number; residualStd: number } | null;
  ewmaBaseline?: number;
  predictionSource: 'ml' | 'ewma';
  status?: string;
}

interface LiveZone {
  id: string;
  name: string;
  status: string;
  demandScore: number;
  supplyScore: number;
  ratio: number;
  surgeMultiplier: number;
  onlineProviders: number;
  forecast?: {
    p10?: number; p50?: number; p90?: number; mae?: number; source?: string;
  } | null;
}

const STATUS_COLOR: Record<string, string> = {
  BALANCED: 'text-green-400 bg-green-500/10',
  BUSY: 'text-yellow-400 bg-yellow-500/10',
  SURGE: 'text-orange-400 bg-orange-500/10',
  CRITICAL: 'text-red-400 bg-red-500/10',
};

export default function ForecastDashboardPage() {
  const [forecast, setForecast] = useState<Record<string, ForecastZone> | null>(null);
  const [forecastMeta, setForecastMeta] = useState<{ trainerLastRunAt?: string; minSamples?: number; lag?: number; status?: string } | null>(null);
  const [zonesLive, setZonesLive] = useState<LiveZone[]>([]);
  const [loading, setLoading] = useState(true);
  const [retraining, setRetraining] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchAll = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [fr, lr] = await Promise.all([
        api.get('/admin/forecast/status'),
        api.get('/zones/live-state'),
      ]);
      setForecast(fr.data?.zones || {});
      setForecastMeta({
        trainerLastRunAt: fr.data?.trainerLastRunAt,
        minSamples: fr.data?.minSamples,
        lag: fr.data?.lag,
        status: fr.data?.status,
      });
      setZonesLive(lr.data?.zones || []);
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || 'Failed to load forecast');
    } finally {
      setLoading(false);
    }
  };

  const retrain = async () => {
    setRetraining(true);
    try {
      await api.post('/admin/forecast/retrain');
      await fetchAll();
    } catch (e: any) {
      setErr(e?.response?.data?.message || 'Retrain failed');
    } finally {
      setRetraining(false);
    }
  };

  useEffect(() => {
    fetchAll();
    const t = setInterval(fetchAll, 15000); // simple polling, no streaming
    return () => clearInterval(t);
  }, []);

  // JOIN forecast + live data per zone
  const rows = zonesLive.map((z) => {
    const fc = forecast?.[z.id] || ({} as ForecastZone);
    const pred = fc.prediction;
    const p50 = pred?.p50 ?? z.forecast?.p50 ?? null;
    const p90 = pred?.p90 ?? z.forecast?.p90 ?? null;
    const p10 = pred?.p10 ?? z.forecast?.p10 ?? null;
    const mae = fc.mae ?? z.forecast?.mae ?? null;
    const supply = z.supplyScore ?? 0;
    const pressure = p90 != null && supply > 0 ? p90 / supply : null;
    return {
      id: z.id,
      name: z.name,
      status: z.status,
      surge: z.surgeMultiplier,
      supply,
      online: z.onlineProviders,
      demandNow: z.demandScore,
      p10, p50, p90, mae,
      pressure,
      source: fc.predictionSource || z.forecast?.source || '—',
    };
  });

  const chartData = rows.map((r) => ({
    name: r.name,
    p50: r.p50 ?? 0,
    supply: r.supply,
    errorLow: r.p50 != null && r.p10 != null ? r.p50 - r.p10 : 0,
    errorHigh: r.p50 != null && r.p90 != null ? r.p90 - r.p50 : 0,
  }));

  return (
    <div className="p-6" data-testid="forecast-dashboard-page">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-slate-700 rounded-lg">
            <Brain size={24} className="text-purple-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Demand Forecast (ML)</h1>
            <p className="text-slate-400 text-sm">Прогноз спроса по зонам — Sprint 19+20 DemandPredictor</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchAll}
            className="p-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg"
            data-testid="forecast-refresh-btn"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={retrain}
            disabled={retraining}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg disabled:opacity-50"
            data-testid="forecast-retrain-btn"
          >
            <Cpu size={16} className={retraining ? 'animate-spin' : ''} />
            {retraining ? 'Переобучение...' : 'Переобучить модели'}
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">{err}</div>
      )}

      {/* Summary bar */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <SummaryCard icon={<Activity size={18} className="text-purple-400" />} label="ML Status" value={forecastMeta?.status === 'ok' ? 'Active' : forecastMeta?.status || '—'} sub={`Lag ${forecastMeta?.lag ?? '—'}`} />
        <SummaryCard icon={<TrendingUp size={18} className="text-green-400" />} label="Min samples" value={String(forecastMeta?.minSamples ?? '—')} sub="для тренировки" />
        <SummaryCard icon={<Brain size={18} className="text-blue-400" />} label="Last training" value={forecastMeta?.trainerLastRunAt ? new Date(forecastMeta.trainerLastRunAt).toLocaleTimeString('ru-RU') : '—'} sub="auto each 5 min" />
        <SummaryCard icon={<Cpu size={18} className="text-amber-400" />} label="Zones tracked" value={String(rows.length)} sub="6 Kyiv zones" />
      </div>

      {/* Chart */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 mb-6">
        <h3 className="text-white font-semibold mb-4">Прогноз vs Supply (P50 ± P10/P90)</h3>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis dataKey="name" stroke="#94a3b8" fontSize={12} />
            <YAxis stroke="#94a3b8" fontSize={12} />
            <Tooltip
              contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
              labelStyle={{ color: '#e2e8f0' }}
            />
            <Legend wrapperStyle={{ paddingTop: 10 }} />
            <Bar dataKey="p50" fill="#a855f7" name="Прогноз спроса P50">
              <ErrorBar dataKey="errorHigh" width={6} stroke="#fbbf24" />
              <ErrorBar dataKey="errorLow" width={6} stroke="#fbbf24" />
            </Bar>
            <Bar dataKey="supply" fill="#10b981" name="Supply (мастеров)" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-700 flex items-center justify-between">
          <h3 className="text-white font-semibold">Зоны (6)</h3>
          <span className="text-xs text-slate-500">Polling 15 сек</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-900/50 text-slate-400">
            <tr>
              <th className="px-4 py-2 text-left">Зона</th>
              <th className="px-4 py-2 text-left">Статус</th>
              <th className="px-4 py-2 text-right">Demand сейчас</th>
              <th className="px-4 py-2 text-right">P50 (прогноз)</th>
              <th className="px-4 py-2 text-right">P90</th>
              <th className="px-4 py-2 text-right">Supply</th>
              <th className="px-4 py-2 text-right">Pressure (P90/supply)</th>
              <th className="px-4 py-2 text-right">MAE</th>
              <th className="px-4 py-2 text-right">Surge</th>
              <th className="px-4 py-2 text-center">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-700/30 transition-colors" data-testid={`forecast-row-${r.id}`}>
                <td className="px-4 py-3 text-white font-medium">{r.name}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLOR[r.status] || 'text-slate-400 bg-slate-700/30'}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-slate-300">{r.demandNow?.toFixed(1) ?? '—'}</td>
                <td className="px-4 py-3 text-right text-purple-300 font-semibold">{r.p50?.toFixed(2) ?? '—'}</td>
                <td className="px-4 py-3 text-right text-amber-300">{r.p90?.toFixed(2) ?? '—'}</td>
                <td className="px-4 py-3 text-right text-green-300">{r.supply?.toFixed(0)} <span className="text-xs text-slate-500">({r.online} online)</span></td>
                <td className="px-4 py-3 text-right">
                  <span className={r.pressure != null && r.pressure > 2 ? 'text-red-400 font-semibold' : 'text-slate-300'}>
                    {r.pressure != null ? r.pressure.toFixed(2) + '×' : '—'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right text-slate-400">{r.mae?.toFixed(2) ?? '—'}</td>
                <td className="px-4 py-3 text-right text-orange-300">{r.surge?.toFixed(1)}×</td>
                <td className="px-4 py-3 text-center">
                  <span className={`px-2 py-0.5 rounded text-xs ${r.source === 'ml' ? 'bg-purple-500/20 text-purple-300' : 'bg-slate-700 text-slate-400'}`}>
                    {r.source}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-500">Нет данных</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-slate-500">
        ⓘ <strong>Pressure</strong> = P90 / supply. Значение &gt; 2× — высокая вероятность нехватки мастеров. ML переобучается каждые 5 минут.
      </p>
    </div>
  );
}

function SummaryCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <div className="bg-slate-800 rounded-xl border border-slate-700 p-4">
      <div className="flex items-center gap-2 mb-1">{icon}<span className="text-xs text-slate-400 uppercase tracking-wide">{label}</span></div>
      <div className="text-xl font-bold text-white">{value}</div>
      <div className="text-xs text-slate-500 mt-1">{sub}</div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { Activity, Clock, AlertTriangle, TrendingDown, RefreshCw, CheckCircle, XCircle, Gauge } from 'lucide-react';
import { adminAPI } from '../services/api';

interface HealthData {
  latency: { avg: number; p95: number; p99: number };
  failureRate: number;
  matchRate: number;
  queueDelays: { avg: number; max: number };
  dropRate: number;
  activeDisputes: number;
  totalBookingsToday: number;
  completedBookingsToday: number;
  totalProviders: number;
  uptime: number;
}

export default function SystemHealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getSystemHealth();
      setData(res.data);
    } catch (err) {
      console.error('Failed to load system health:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) {
    return (
      <div className="p-6 bg-slate-900 min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!data) return null;

  const getStatusColor = (value: number, thresholds: [number, number]) => {
    if (value <= thresholds[0]) return 'text-green-400';
    if (value <= thresholds[1]) return 'text-yellow-400';
    return 'text-red-400';
  };

  const getStatusBg = (value: number, thresholds: [number, number]) => {
    if (value <= thresholds[0]) return 'bg-green-500/10 border-green-500/30';
    if (value <= thresholds[1]) return 'bg-yellow-500/10 border-yellow-500/30';
    return 'bg-red-500/10 border-red-500/30';
  };

  return (
    <div className="p-6 bg-slate-900 min-h-screen" data-testid="system-health-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-500/20 rounded-lg">
            <Activity className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">System Health</h1>
            <p className="text-sm text-slate-400">Техническая стабильность платформы</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
            data.uptime > 99.5 ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'
          }`}>
            Uptime: {data.uptime.toFixed(2)}%
          </span>
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg"
            data-testid="refresh-health"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Main Metrics */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className={`rounded-xl p-4 border ${getStatusBg(data.latency.avg, [80, 150])}`}>
          <div className="flex items-center gap-2 text-slate-400 mb-1">
            <Clock className="w-4 h-4" />
            <span className="text-sm">Avg Latency</span>
          </div>
          <span className={`text-2xl font-bold ${getStatusColor(data.latency.avg, [80, 150])}`}>
            {data.latency.avg}ms
          </span>
        </div>

        <div className={`rounded-xl p-4 border ${getStatusBg(data.failureRate, [5, 15])}`}>
          <div className="flex items-center gap-2 text-slate-400 mb-1">
            <XCircle className="w-4 h-4" />
            <span className="text-sm">Failure Rate</span>
          </div>
          <span className={`text-2xl font-bold ${getStatusColor(data.failureRate, [5, 15])}`}>
            {data.failureRate}%
          </span>
        </div>

        <div className={`rounded-xl p-4 border ${getStatusBg(100 - data.matchRate, [30, 60])}`}>
          <div className="flex items-center gap-2 text-slate-400 mb-1">
            <CheckCircle className="w-4 h-4" />
            <span className="text-sm">Match Rate</span>
          </div>
          <span className={`text-2xl font-bold ${data.matchRate > 60 ? 'text-green-400' : data.matchRate > 30 ? 'text-yellow-400' : 'text-red-400'}`}>
            {data.matchRate}%
          </span>
        </div>

        <div className={`rounded-xl p-4 border ${getStatusBg(data.dropRate, [10, 25])}`}>
          <div className="flex items-center gap-2 text-slate-400 mb-1">
            <TrendingDown className="w-4 h-4" />
            <span className="text-sm">Drop Rate</span>
          </div>
          <span className={`text-2xl font-bold ${getStatusColor(data.dropRate, [10, 25])}`}>
            {data.dropRate}%
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Latency Details */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <Gauge className="w-5 h-5 text-cyan-400" />
            <h2 className="text-lg font-semibold text-white">Latency Breakdown</h2>
          </div>
          <div className="space-y-4">
            {[
              { label: 'Average', value: data.latency.avg, unit: 'ms', thresholds: [80, 150] as [number, number] },
              { label: 'P95', value: data.latency.p95, unit: 'ms', thresholds: [150, 250] as [number, number] },
              { label: 'P99', value: data.latency.p99, unit: 'ms', thresholds: [250, 400] as [number, number] },
            ].map(item => (
              <div key={item.label}>
                <div className="flex justify-between mb-1">
                  <span className="text-slate-300">{item.label}</span>
                  <span className={`font-bold ${getStatusColor(item.value, item.thresholds)}`}>
                    {item.value}{item.unit}
                  </span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      item.value <= item.thresholds[0] ? 'bg-green-500' :
                      item.value <= item.thresholds[1] ? 'bg-yellow-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${Math.min(100, (item.value / 500) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Queue & Capacity */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-5 h-5 text-amber-400" />
            <h2 className="text-lg font-semibold text-white">Operations</h2>
          </div>
          <div className="space-y-4">
            <div className="flex justify-between p-3 bg-slate-700/50 rounded-lg">
              <span className="text-slate-300">Queue Delay (avg)</span>
              <span className="text-white font-medium">{data.queueDelays.avg}s</span>
            </div>
            <div className="flex justify-between p-3 bg-slate-700/50 rounded-lg">
              <span className="text-slate-300">Queue Delay (max)</span>
              <span className={`font-medium ${data.queueDelays.max > 15 ? 'text-red-400' : 'text-white'}`}>{data.queueDelays.max}s</span>
            </div>
            <div className="flex justify-between p-3 bg-slate-700/50 rounded-lg">
              <span className="text-slate-300">Active Disputes</span>
              <span className={`font-medium ${data.activeDisputes > 3 ? 'text-orange-400' : 'text-white'}`}>{data.activeDisputes}</span>
            </div>
            <div className="flex justify-between p-3 bg-slate-700/50 rounded-lg">
              <span className="text-slate-300">Bookings Today</span>
              <span className="text-white font-medium">{data.completedBookingsToday}/{data.totalBookingsToday}</span>
            </div>
            <div className="flex justify-between p-3 bg-slate-700/50 rounded-lg">
              <span className="text-slate-300">Total Providers</span>
              <span className="text-white font-medium">{data.totalProviders}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

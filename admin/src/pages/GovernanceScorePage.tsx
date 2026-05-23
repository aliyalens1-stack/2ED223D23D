import { useState, useEffect } from 'react';
import { Gauge, RefreshCw, TrendingUp, TrendingDown, MapPin, Clock, AlertTriangle, CheckCircle2, Activity } from 'lucide-react';
import { adminAPI } from '../services/api';

const statusConfig: Record<string, { color: string; bg: string; label: string }> = {
  healthy: { color: 'text-green-400', bg: 'bg-green-500/20', label: 'Healthy' },
  stressed: { color: 'text-yellow-400', bg: 'bg-yellow-500/20', label: 'Stressed' },
  critical: { color: 'text-red-400', bg: 'bg-red-500/20', label: 'Critical' },
};

const componentLabels: Record<string, string> = {
  demandSupply: 'Demand/Supply', eta: 'ETA', matchSuccess: 'Match Success',
  providerResponse: 'Provider Response', failRate: 'Fail Rate', incidents: 'Incidents', automationStability: 'Automation',
};

export default function GovernanceScorePage() {
  const [score, setScore] = useState<any>(null);
  const [zones, setZones] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const [scoreRes, zonesRes, histRes] = await Promise.all([
        adminAPI.getGovernanceScore(),
        adminAPI.getGovernanceScoreZones(),
        adminAPI.getGovernanceScoreHistory(),
      ]);
      setScore(scoreRes.data);
      setZones(zonesRes.data.zones || []);
      setHistory(histRes.data.history || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); const iv = setInterval(loadData, 30000); return () => clearInterval(iv); }, []);

  const st = statusConfig[score?.status] || statusConfig.stressed;
  const scoreColor = (s: number) => s >= 75 ? 'text-green-400' : s >= 55 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2"><Gauge className="h-6 w-6 text-cyan-400" /> Governance Score</h1>
          <p className="text-slate-400 mt-1">Единая метрика здоровья рынка</p>
        </div>
        <button onClick={loadData} className="flex items-center gap-2 px-4 py-2 bg-slate-700 rounded-lg hover:bg-slate-600 text-sm text-white">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Обновить
        </button>
      </div>

      {score && (
        <>
          {/* Main Score */}
          <div className={`rounded-2xl p-8 border ${st.bg} border-opacity-30 text-center`}>
            <div className={`text-7xl font-black ${st.color}`}>{score.score}</div>
            <div className={`text-lg font-semibold mt-2 ${st.color}`}>{st.label}</div>
            <div className="text-slate-400 text-sm mt-1">из 100</div>
          </div>

          {/* Components */}
          <div className="grid grid-cols-7 gap-3">
            {Object.entries(score.components || {}).map(([key, val]: [string, any]) => (
              <div key={key} className="bg-slate-800/50 rounded-xl p-3 border border-slate-700/50 text-center">
                <div className={`text-xl font-bold ${scoreColor(val)}`}>{val}</div>
                <div className="text-slate-400 text-[10px] mt-1">{componentLabels[key] || key}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Zone Scores */}
      <div className="bg-slate-800/50 rounded-xl p-5 border border-slate-700/50">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2"><MapPin className="h-4 w-4 text-blue-400" /> По зонам</h3>
        <div className="space-y-2">
          {zones.map(z => {
            const zst = statusConfig[z.status] || statusConfig.stressed;
            return (
              <div key={z.zoneId} className="flex items-center justify-between bg-slate-700/30 rounded-lg p-3">
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${zst.bg.replace('/20', '')}`} />
                  <span className="text-white font-medium text-sm">{z.zoneName}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ${zst.bg} ${zst.color}`}>{zst.label}</span>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-400">
                  <span>D/S: {z.demandSupply}</span>
                  <span>ETA: {z.eta}</span>
                  <span>Match: {z.matchSuccess}</span>
                  <span className={`text-lg font-bold ${scoreColor(z.score)}`}>{z.score}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* History Sparkline (simplified as text) */}
      <div className="bg-slate-800/50 rounded-xl p-5 border border-slate-700/50">
        <h3 className="text-white font-semibold mb-4 flex items-center gap-2"><Activity className="h-4 w-4 text-purple-400" /> Тренд 24ч</h3>
        <div className="flex gap-1 items-end h-16">
          {history.map((h, i) => {
            const height = Math.max(10, (h.score / 100) * 64);
            const color = h.score >= 75 ? 'bg-green-500' : h.score >= 55 ? 'bg-yellow-500' : 'bg-red-500';
            return <div key={i} className={`flex-1 rounded-t ${color} opacity-70`} style={{ height: `${height}px` }} title={`${h.score} - ${h.status}`} />;
          })}
        </div>
        <div className="flex justify-between text-[10px] text-slate-500 mt-1">
          <span>-24ч</span><span>-12ч</span><span>Сейчас</span>
        </div>
      </div>
    </div>
  );
}

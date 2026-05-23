import { useState, useEffect } from 'react';
import { Workflow, RefreshCw, Settings, TrendingUp, Timer, BarChart3, AlertCircle, CheckCircle2 } from 'lucide-react';
import { adminAPI } from '../services/api';

interface FlowConfig {
  providersPerRequest: number;
  ttlSeconds: number;
  retryCount: number;
  escalationEnabled: boolean;
  autoDistribute: boolean;
  maxRadius: number;
  minProviderScore: number;
  priorityWeights: Record<string, number>;
}

interface FlowMetrics {
  avgMatchTime: number;
  failRate: number;
  reassignRate: number;
  avgDistributionCount: number;
  ttlHitRate: number;
  avgProviderResponseTime: number;
  conversionRate: number;
  totalRequestsToday: number;
  matchedToday: number;
  failedToday: number;
}

export default function RequestFlowPage() {
  const [config, setConfig] = useState<FlowConfig | null>(null);
  const [metrics, setMetrics] = useState<FlowMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editConfig, setEditConfig] = useState<FlowConfig | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [configRes, metricsRes] = await Promise.all([
        adminAPI.getFlowConfig(),
        adminAPI.getFlowMetrics(),
      ]);
      setConfig(configRes.data);
      setEditConfig(configRes.data);
      setMetrics(metricsRes.data);
    } catch (err) {
      console.error('Failed to load flow data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleSave = async () => {
    if (!editConfig) return;
    setSaving(true);
    try {
      await adminAPI.updateFlowConfig(editConfig);
      setConfig(editConfig);
    } catch (err) {
      console.error('Failed to save config:', err);
    } finally {
      setSaving(false);
    }
  };

  const updateField = (field: string, value: any) => {
    if (!editConfig) return;
    setEditConfig({ ...editConfig, [field]: value });
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-slate-400">Загрузка...</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Workflow className="h-6 w-6 text-purple-400" /> Request Flow Control
          </h1>
          <p className="text-slate-400 mt-1">Управление скоростью и параметрами рынка</p>
        </div>
        <div className="flex gap-2">
          <button onClick={loadData} className="flex items-center gap-2 px-4 py-2 bg-slate-700 rounded-lg hover:bg-slate-600 text-sm text-white">
            <RefreshCw className="h-4 w-4" /> Обновить
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 rounded-lg hover:bg-blue-600 text-sm text-white disabled:opacity-50">
            <Settings className="h-4 w-4" /> {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </div>

      {/* Metrics */}
      {metrics && (
        <div className="grid grid-cols-5 gap-4">
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
            <div className="flex items-center gap-2 text-slate-400 text-xs mb-1"><Timer className="h-3.5 w-3.5" /> Время матча</div>
            <div className="text-2xl font-bold text-white">{metrics.avgMatchTime}с</div>
          </div>
          <div className={`rounded-xl p-4 border ${metrics.failRate > 15 ? 'bg-red-500/10 border-red-500/20' : 'bg-slate-800/50 border-slate-700/50'}`}>
            <div className="flex items-center gap-2 text-slate-400 text-xs mb-1"><AlertCircle className="h-3.5 w-3.5" /> Fail Rate</div>
            <div className={`text-2xl font-bold ${metrics.failRate > 15 ? 'text-red-400' : 'text-white'}`}>{metrics.failRate}%</div>
          </div>
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
            <div className="flex items-center gap-2 text-slate-400 text-xs mb-1"><TrendingUp className="h-3.5 w-3.5" /> Конверсия</div>
            <div className="text-2xl font-bold text-green-400">{metrics.conversionRate}%</div>
          </div>
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
            <div className="flex items-center gap-2 text-slate-400 text-xs mb-1"><BarChart3 className="h-3.5 w-3.5" /> Сегодня</div>
            <div className="text-2xl font-bold text-white">{metrics.matchedToday}/{metrics.totalRequestsToday}</div>
          </div>
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
            <div className="flex items-center gap-2 text-slate-400 text-xs mb-1"><CheckCircle2 className="h-3.5 w-3.5" /> Ответ мастера</div>
            <div className="text-2xl font-bold text-white">{metrics.avgProviderResponseTime}с</div>
          </div>
        </div>
      )}

      {/* Configuration */}
      {editConfig && (
        <div className="grid grid-cols-2 gap-6">
          {/* Distribution Settings */}
          <div className="bg-slate-800/50 rounded-xl p-5 border border-slate-700/50">
            <h3 className="text-white font-semibold mb-4">Distribution Settings</h3>
            <div className="space-y-4">
              <div>
                <label className="text-slate-400 text-sm">Мастеров на заявку</label>
                <input type="number" value={editConfig.providersPerRequest}
                  onChange={e => updateField('providersPerRequest', Number(e.target.value))}
                  className="w-full mt-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
              </div>
              <div>
                <label className="text-slate-400 text-sm">TTL (секунды)</label>
                <input type="number" value={editConfig.ttlSeconds}
                  onChange={e => updateField('ttlSeconds', Number(e.target.value))}
                  className="w-full mt-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
              </div>
              <div>
                <label className="text-slate-400 text-sm">Кол-во повторов</label>
                <input type="number" value={editConfig.retryCount}
                  onChange={e => updateField('retryCount', Number(e.target.value))}
                  className="w-full mt-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
              </div>
              <div>
                <label className="text-slate-400 text-sm">Макс. радиус (км)</label>
                <input type="number" value={editConfig.maxRadius}
                  onChange={e => updateField('maxRadius', Number(e.target.value))}
                  className="w-full mt-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
              </div>
            </div>
          </div>

          {/* Quality & Automation */}
          <div className="bg-slate-800/50 rounded-xl p-5 border border-slate-700/50">
            <h3 className="text-white font-semibold mb-4">Quality & Automation</h3>
            <div className="space-y-4">
              <div>
                <label className="text-slate-400 text-sm">Мин. скор мастера</label>
                <input type="number" value={editConfig.minProviderScore}
                  onChange={e => updateField('minProviderScore', Number(e.target.value))}
                  className="w-full mt-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400 text-sm">Auto-distribute</span>
                <button onClick={() => updateField('autoDistribute', !editConfig.autoDistribute)}
                  className={`w-12 h-6 rounded-full transition ${editConfig.autoDistribute ? 'bg-green-500' : 'bg-slate-600'}`}>
                  <div className={`w-5 h-5 bg-white rounded-full transform transition ${editConfig.autoDistribute ? 'translate-x-6' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400 text-sm">Escalation</span>
                <button onClick={() => updateField('escalationEnabled', !editConfig.escalationEnabled)}
                  className={`w-12 h-6 rounded-full transition ${editConfig.escalationEnabled ? 'bg-green-500' : 'bg-slate-600'}`}>
                  <div className={`w-5 h-5 bg-white rounded-full transform transition ${editConfig.escalationEnabled ? 'translate-x-6' : 'translate-x-0.5'}`} />
                </button>
              </div>
              {/* Priority Weights */}
              <div className="pt-2 border-t border-slate-700">
                <label className="text-slate-400 text-sm mb-2 block">Priority Weights</label>
                {editConfig.priorityWeights && Object.entries(editConfig.priorityWeights).map(([key, val]) => (
                  <div key={key} className="flex items-center gap-2 mb-2">
                    <span className="text-slate-300 text-xs w-24 capitalize">{key}</span>
                    <input type="range" min="0" max="1" step="0.1" value={val}
                      onChange={e => updateField('priorityWeights', { ...editConfig.priorityWeights, [key]: Number(e.target.value) })}
                      className="flex-1" />
                    <span className="text-white text-xs w-8">{val}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

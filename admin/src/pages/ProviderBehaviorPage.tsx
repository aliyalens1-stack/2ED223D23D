import { useState, useEffect } from 'react';
import { Users, AlertTriangle, TrendingUp, TrendingDown, Eye, EyeOff, Send, Shield, Zap, RefreshCw, ChevronDown } from 'lucide-react';
import { adminAPI } from '../services/api';

interface ProviderBehavior {
  providerId: string;
  name: string;
  score: number;
  tier: string;
  acceptanceRate: number;
  responseTimeAvg: number;
  completionRate: number;
  missedRequests: number;
  lostRevenue: number;
  flags: string[];
  rating: number;
  visibility: number;
}

interface BehaviorStats {
  total: number;
  risky: number;
  top: number;
  slow: number;
  avgScore: number;
}

interface Recommendation {
  action: string;
  target: string;
  impact: string;
}

const tierColors: Record<string, string> = {
  Platinum: 'bg-slate-300/20 text-slate-300',
  Gold: 'bg-yellow-500/20 text-yellow-400',
  Silver: 'bg-gray-400/20 text-gray-400',
  Bronze: 'bg-orange-600/20 text-orange-400',
};

const flagLabels: Record<string, { label: string; color: string }> = {
  low_score: { label: 'Низкий скор', color: 'bg-red-500/20 text-red-400' },
  slow_response: { label: 'Медленный ответ', color: 'bg-orange-500/20 text-orange-400' },
  low_acceptance: { label: 'Низкий accept', color: 'bg-yellow-500/20 text-yellow-400' },
};

export default function ProviderBehaviorPage() {
  const [providers, setProviders] = useState<ProviderBehavior[]>([]);
  const [stats, setStats] = useState<BehaviorStats>({ total: 0, risky: 0, top: 0, slow: 0, avgScore: 0 });
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'risky' | 'top' | 'slow'>('all');
  const [actionLoading, setActionLoading] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getProviderBehavior();
      setProviders(res.data.providers || []);
      setStats(res.data.stats || { total: 0, risky: 0, top: 0, slow: 0, avgScore: 0 });
      setRecommendations(res.data.recommendations || []);
    } catch (err) {
      console.error('Failed to load behavior data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleBulkAction = async (action: string, filterCriteria: any) => {
    setActionLoading(true);
    try {
      await adminAPI.providerBehaviorBulkAction({ action, filter: filterCriteria });
      loadData();
    } catch (err) {
      console.error('Bulk action failed:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const filteredProviders = providers.filter(p => {
    if (filter === 'risky') return p.score < 40;
    if (filter === 'top') return p.score >= 80;
    if (filter === 'slow') return p.flags.includes('slow_response');
    return true;
  });

  const scoreColor = (score: number) => score >= 80 ? 'text-green-400' : score >= 50 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Users className="h-6 w-6 text-blue-400" /> Управление поведением мастеров
          </h1>
          <p className="text-slate-400 mt-1">Market behavior control system</p>
        </div>
        <button onClick={loadData} className="flex items-center gap-2 px-4 py-2 bg-slate-700 rounded-lg hover:bg-slate-600 text-sm text-white">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Обновить
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4">
        <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
          <div className="text-2xl font-bold text-white">{stats.total}</div>
          <div className="text-slate-400 text-sm">Всего</div>
        </div>
        <div className="bg-red-500/10 rounded-xl p-4 border border-red-500/20">
          <div className="text-2xl font-bold text-red-400">{stats.risky}</div>
          <div className="text-slate-400 text-sm">Проблемные</div>
        </div>
        <div className="bg-green-500/10 rounded-xl p-4 border border-green-500/20">
          <div className="text-2xl font-bold text-green-400">{stats.top}</div>
          <div className="text-slate-400 text-sm">Топ</div>
        </div>
        <div className="bg-orange-500/10 rounded-xl p-4 border border-orange-500/20">
          <div className="text-2xl font-bold text-orange-400">{stats.slow}</div>
          <div className="text-slate-400 text-sm">Медленные</div>
        </div>
        <div className="bg-blue-500/10 rounded-xl p-4 border border-blue-500/20">
          <div className="text-2xl font-bold text-blue-400">{stats.avgScore}</div>
          <div className="text-slate-400 text-sm">Средний скор</div>
        </div>
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
          <h3 className="text-white font-semibold mb-3 flex items-center gap-2"><Zap className="h-4 w-4 text-yellow-400" /> Рекомендации системы</h3>
          <div className="space-y-2">
            {recommendations.map((rec, i) => (
              <div key={i} className="flex items-center justify-between bg-slate-700/30 rounded-lg p-3">
                <div>
                  <span className="text-white text-sm font-medium">{rec.target}</span>
                  <span className="text-slate-400 text-xs ml-2">→ {rec.impact}</span>
                </div>
                <button
                  onClick={() => handleBulkAction(rec.action, {})}
                  disabled={actionLoading}
                  className="px-3 py-1.5 bg-blue-500/20 text-blue-400 rounded-lg text-xs font-medium hover:bg-blue-500/30"
                >
                  {rec.action === 'limit_visibility' ? 'Ограничить' : rec.action === 'send_warning' ? 'Предупредить' : 'Boost'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bulk Actions */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => handleBulkAction('limit_visibility', { score: '<40' })} disabled={actionLoading}
          className="flex items-center gap-1.5 px-3 py-2 bg-red-500/15 text-red-400 rounded-lg text-sm hover:bg-red-500/25">
          <EyeOff className="h-4 w-4" /> Ограничить показы (score {'<'} 40)
        </button>
        <button onClick={() => handleBulkAction('send_warning', { response_time: '>30' })} disabled={actionLoading}
          className="flex items-center gap-1.5 px-3 py-2 bg-orange-500/15 text-orange-400 rounded-lg text-sm hover:bg-orange-500/25">
          <Send className="h-4 w-4" /> Предупреждение медленным
        </button>
        <button onClick={() => handleBulkAction('boost_visibility', { score: '>80' })} disabled={actionLoading}
          className="flex items-center gap-1.5 px-3 py-2 bg-green-500/15 text-green-400 rounded-lg text-sm hover:bg-green-500/25">
          <Eye className="h-4 w-4" /> Boost топ мастерам
        </button>
        <button onClick={() => handleBulkAction('send_training', { score: '<60' })} disabled={actionLoading}
          className="flex items-center gap-1.5 px-3 py-2 bg-blue-500/15 text-blue-400 rounded-lg text-sm hover:bg-blue-500/25">
          <Shield className="h-4 w-4" /> Обучающий push
        </button>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2">
        {(['all', 'risky', 'top', 'slow'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${filter === f ? 'bg-blue-500 text-white' : 'bg-slate-700/50 text-slate-400 hover:bg-slate-700'}`}>
            {f === 'all' ? `Все (${stats.total})` : f === 'risky' ? `Проблемные (${stats.risky})` : f === 'top' ? `Топ (${stats.top})` : `Медленные (${stats.slow})`}
          </button>
        ))}
      </div>

      {/* Provider List */}
      <div className="space-y-2">
        {loading ? (
          <div className="text-center py-8 text-slate-400">Загрузка...</div>
        ) : filteredProviders.length === 0 ? (
          <div className="text-center py-8 text-slate-400">Нет мастеров в этой категории</div>
        ) : (
          filteredProviders.map(p => (
            <div key={p.providerId} className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50 flex items-center gap-4">
              {/* Score */}
              <div className="text-center min-w-[60px]">
                <div className={`text-2xl font-bold ${scoreColor(p.score)}`}>{p.score}</div>
                <div className={`text-xs px-2 py-0.5 rounded ${tierColors[p.tier] || tierColors.Bronze}`}>{p.tier}</div>
              </div>
              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-white font-medium truncate">{p.name}</span>
                  <span className="text-yellow-400 text-xs">★ {p.rating}</span>
                </div>
                <div className="flex gap-3 mt-1 text-xs text-slate-400">
                  <span>Accept: {p.acceptanceRate}%</span>
                  <span>Ответ: {p.responseTimeAvg} мин</span>
                  <span>Completion: {p.completionRate}%</span>
                  <span>Пропущено: {p.missedRequests}</span>
                </div>
                {/* Flags */}
                {p.flags.length > 0 && (
                  <div className="flex gap-1 mt-1.5">
                    {p.flags.map(f => (
                      <span key={f} className={`text-[10px] px-1.5 py-0.5 rounded ${flagLabels[f]?.color || 'bg-slate-600 text-slate-300'}`}>
                        {flagLabels[f]?.label || f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {/* Lost Revenue */}
              {p.lostRevenue > 0 && (
                <div className="text-right">
                  <div className="text-red-400 text-sm font-bold">-{p.lostRevenue} грн</div>
                  <div className="text-slate-500 text-xs">потеряно</div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

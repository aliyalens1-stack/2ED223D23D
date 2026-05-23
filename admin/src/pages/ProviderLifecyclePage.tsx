import { useState, useEffect } from 'react';
import { Users, ArrowRight, Zap, AlertTriangle, XCircle, RefreshCw, ChevronRight, Shield, Star, UserPlus, UserCheck, UserX } from 'lucide-react';
import { adminAPI } from '../services/api';

interface ProviderLC {
  id: string;
  name: string;
  status: string;
  lifecycle: string;
  bookingsCount: number;
  completedBookingsCount: number;
  rating: number;
  createdAt: string;
  lastActiveAt: string;
  visibilityState: string;
}

const lifecycleStages = [
  { key: 'new', label: 'New', icon: UserPlus, color: 'bg-blue-500/20 text-blue-400 border-blue-500/30', bgColor: 'bg-blue-500' },
  { key: 'onboarding', label: 'Onboarding', icon: ArrowRight, color: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30', bgColor: 'bg-cyan-500' },
  { key: 'active', label: 'Active', icon: UserCheck, color: 'bg-green-500/20 text-green-400 border-green-500/30', bgColor: 'bg-green-500' },
  { key: 'risky', label: 'Risky', icon: AlertTriangle, color: 'bg-orange-500/20 text-orange-400 border-orange-500/30', bgColor: 'bg-orange-500' },
  { key: 'banned', label: 'Banned', icon: UserX, color: 'bg-red-500/20 text-red-400 border-red-500/30', bgColor: 'bg-red-500' },
];

export default function ProviderLifecyclePage() {
  const [providers, setProviders] = useState<ProviderLC[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getProviderLifecycle();
      setProviders(res.data.providers || []);
      setStats(res.data.stats || {});
    } catch (err) {
      console.error('Failed to load lifecycle data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleAction = async (providerId: string, action: string) => {
    setActionLoading(`${providerId}-${action}`);
    try {
      await adminAPI.executeLifecycleAction(providerId, action);
      loadData();
    } catch (err) {
      console.error('Action failed:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const filtered = selectedStage
    ? providers.filter(p => p.lifecycle === selectedStage)
    : providers;

  return (
    <div className="p-6 bg-slate-900 min-h-screen" data-testid="provider-lifecycle-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/20 rounded-lg">
            <Users className="w-6 h-6 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Provider Lifecycle</h1>
            <p className="text-sm text-slate-400">Жизненный цикл мастеров: new &rarr; active &rarr; banned</p>
          </div>
        </div>
        <button
          onClick={loadData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Lifecycle Pipeline */}
      <div className="flex items-center gap-2 mb-6">
        {lifecycleStages.map((stage, i) => {
          const Icon = stage.icon;
          const count = stats[stage.key] || 0;
          const isSelected = selectedStage === stage.key;
          return (
            <div key={stage.key} className="flex items-center gap-2 flex-1">
              <button
                onClick={() => setSelectedStage(isSelected ? null : stage.key)}
                className={`flex-1 p-4 rounded-xl border transition-all ${
                  isSelected ? stage.color : 'bg-slate-800 border-slate-700 hover:border-slate-600'
                }`}
                data-testid={`lifecycle-stage-${stage.key}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Icon className={`w-4 h-4 ${isSelected ? '' : 'text-slate-400'}`} />
                  <span className={`text-sm font-medium ${isSelected ? '' : 'text-slate-300'}`}>{stage.label}</span>
                </div>
                <span className="text-xl font-bold text-white">{count}</span>
              </button>
              {i < lifecycleStages.length - 1 && (
                <ChevronRight className="w-5 h-5 text-slate-600 flex-shrink-0" />
              )}
            </div>
          );
        })}
      </div>

      {/* Table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-700/50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Мастер</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Stage</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Bookings</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Rating</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Visibility</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Загрузка...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Нет мастеров</td></tr>
            ) : (
              filtered.map(p => {
                const stage = lifecycleStages.find(s => s.key === p.lifecycle) || lifecycleStages[0];
                return (
                  <tr key={p.id} className="hover:bg-slate-750">
                    <td className="px-4 py-3">
                      <span className="text-white font-medium">{p.name}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium border ${stage.color}`}>
                        {stage.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-white">
                      {p.completedBookingsCount}/{p.bookingsCount}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Star className="w-3 h-3 text-yellow-400" />
                        <span className="text-white">{p.rating.toFixed(1)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        p.visibilityState === 'BOOSTED' ? 'bg-green-500/20 text-green-400' :
                        p.visibilityState === 'LIMITED' ? 'bg-orange-500/20 text-orange-400' :
                        p.visibilityState === 'SUSPENDED' ? 'bg-red-500/20 text-red-400' :
                        'bg-slate-600/50 text-slate-300'
                      }`}>
                        {p.visibilityState}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {p.lifecycle !== 'banned' && (
                          <button
                            onClick={() => handleAction(p.id, 'promote')}
                            disabled={actionLoading !== null}
                            className="p-1.5 hover:bg-green-500/20 rounded text-green-400"
                            title="Promote"
                          >
                            <Zap size={14} />
                          </button>
                        )}
                        {p.lifecycle !== 'banned' && (
                          <button
                            onClick={() => handleAction(p.id, 'limit')}
                            disabled={actionLoading !== null}
                            className="p-1.5 hover:bg-orange-500/20 rounded text-orange-400"
                            title="Limit"
                          >
                            <AlertTriangle size={14} />
                          </button>
                        )}
                        {p.lifecycle !== 'banned' ? (
                          <button
                            onClick={() => handleAction(p.id, 'deactivate')}
                            disabled={actionLoading !== null}
                            className="p-1.5 hover:bg-red-500/20 rounded text-red-400"
                            title="Deactivate"
                          >
                            <XCircle size={14} />
                          </button>
                        ) : (
                          <button
                            onClick={() => handleAction(p.id, 'reactivate')}
                            disabled={actionLoading !== null}
                            className="p-1.5 hover:bg-green-500/20 rounded text-green-400"
                            title="Reactivate"
                          >
                            <Shield size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

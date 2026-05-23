import { useState, useEffect } from 'react';
import { AlertTriangle, Zap, Send, RotateCcw, UserCheck, ArrowUpRight, RefreshCw, Shield, Clock } from 'lucide-react';
import { adminAPI } from '../services/api';

interface Incident {
  id: string;
  type: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  affectedEntity: string;
  createdAt: string;
  status: string;
  actions: string[];
}

const severityConfig = {
  critical: { color: 'bg-red-500/20 text-red-400 border-red-500/30', badge: 'bg-red-500' },
  warning: { color: 'bg-orange-500/20 text-orange-400 border-orange-500/30', badge: 'bg-orange-500' },
  info: { color: 'bg-blue-500/20 text-blue-400 border-blue-500/30', badge: 'bg-blue-500' },
};

const actionLabels: Record<string, { label: string; icon: any; color: string }> = {
  boost_supply: { label: 'Boost Supply', icon: Zap, color: 'bg-green-500/20 text-green-400 hover:bg-green-500/30' },
  send_push: { label: 'Send Push', icon: Send, color: 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30' },
  increase_surge: { label: '+Surge', icon: ArrowUpRight, color: 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30' },
  force_redistribute: { label: 'Redistribute', icon: RotateCcw, color: 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30' },
  force_distribute: { label: 'Force Distribute', icon: RotateCcw, color: 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30' },
  assign_operator: { label: 'Assign Operator', icon: UserCheck, color: 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30' },
  escalate: { label: 'Escalate', icon: ArrowUpRight, color: 'bg-red-500/20 text-red-400 hover:bg-red-500/30' },
  adjust_pricing: { label: 'Adjust Pricing', icon: Shield, color: 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30' },
};

export default function IncidentControlPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadIncidents = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getIncidents();
      setIncidents(res.data.incidents || []);
    } catch (err) {
      console.error('Failed to load incidents:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadIncidents();
    const interval = setInterval(loadIncidents, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleAction = async (incidentId: string, action: string) => {
    setActionLoading(`${incidentId}-${action}`);
    try {
      await adminAPI.executeIncidentAction(incidentId, action);
      loadIncidents();
    } catch (err) {
      console.error('Incident action failed:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const criticalCount = incidents.filter(i => i.severity === 'critical').length;
  const warningCount = incidents.filter(i => i.severity === 'warning').length;

  return (
    <div className="p-6 bg-slate-900 min-h-screen" data-testid="incident-control-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${criticalCount > 0 ? 'bg-red-500/20' : 'bg-orange-500/20'}`}>
            <AlertTriangle className={`w-6 h-6 ${criticalCount > 0 ? 'text-red-400' : 'text-orange-400'}`} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Incident Control</h1>
            <p className="text-sm text-slate-400">Аварийная система — критические события</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {criticalCount > 0 && (
            <span className="px-3 py-1.5 bg-red-500/20 text-red-400 rounded-lg text-sm font-medium animate-pulse">
              {criticalCount} CRITICAL
            </span>
          )}
          {warningCount > 0 && (
            <span className="px-3 py-1.5 bg-orange-500/20 text-orange-400 rounded-lg text-sm font-medium">
              {warningCount} WARNING
            </span>
          )}
          <button
            onClick={loadIncidents}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg"
            data-testid="refresh-incidents"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Обновить
          </button>
        </div>
      </div>

      {/* Incidents List */}
      {loading && incidents.length === 0 ? (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-12 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500 mx-auto"></div>
          <p className="text-slate-400 mt-3">Анализ системы...</p>
        </div>
      ) : incidents.length === 0 ? (
        <div className="bg-slate-800 border border-green-500/30 rounded-xl p-12 text-center">
          <Shield className="w-16 h-16 text-green-400 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-white mb-2">Система стабильна</h3>
          <p className="text-slate-400">Активных инцидентов не обнаружено</p>
        </div>
      ) : (
        <div className="space-y-4">
          {incidents.map((incident) => {
            const sev = severityConfig[incident.severity];
            return (
              <div
                key={incident.id}
                className={`border rounded-xl p-5 ${sev.color}`}
                data-testid={`incident-${incident.id}`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 mt-0.5" />
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-white font-semibold">{incident.title}</h3>
                        <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${sev.badge} text-white`}>
                          {incident.severity}
                        </span>
                      </div>
                      <p className="text-sm text-slate-300 mt-1">{incident.description}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(incident.createdAt).toLocaleTimeString()}
                        </span>
                        <span>Type: {incident.type}</span>
                        <span>Entity: {incident.affectedEntity}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 mt-3">
                  {incident.actions.map((action) => {
                    const ac = actionLabels[action] || { label: action, icon: Zap, color: 'bg-slate-600 text-slate-300' };
                    const Icon = ac.icon;
                    const isLoading = actionLoading === `${incident.id}-${action}`;
                    return (
                      <button
                        key={action}
                        onClick={() => handleAction(incident.id, action)}
                        disabled={actionLoading !== null}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${ac.color}`}
                        data-testid={`incident-action-${action}`}
                      >
                        <Icon className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                        {ac.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

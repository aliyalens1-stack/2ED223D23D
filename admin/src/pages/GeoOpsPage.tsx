import { useEffect, useState, useCallback } from 'react';
import { adminAPI } from '../services/api';
import { 
  MapPin, Globe, AlertTriangle, TrendingUp, TrendingDown,
  Users, FileText, Zap, RefreshCw, Settings, Eye,
  ChevronRight, Activity, Target, Radio, Maximize,
  Volume2, DollarSign, BarChart3, Layers, X, Check
} from 'lucide-react';

interface Zone {
  _id: string;
  name: string;
  code: string;
  center: { coordinates: [number, number] };
  radiusKm: number;
  zoneType: string;
  status: string;
  config: {
    baseSurge: number;
    maxSurge: number;
    autoMode: boolean;
    priority: number;
  };
  metrics?: ZoneMetrics;
}

interface ZoneMetrics {
  totalProviders: number;
  onlineProviders: number;
  availableProviders: number;
  busyProviders: number;
  activeRequests: number;
  pendingRequests: number;
  urgentRequests: number;
  ratio: number;
  surgeMultiplier: number;
  state: 'surplus' | 'balanced' | 'busy' | 'surge' | 'critical' | 'dead';
  avgResponseTime: number;
  completionRate: number;
  strongProviders: number;
  weakProviders: number;
}

interface CityKPIs {
  totalZones: number;
  healthyZones: number;
  criticalZones: number;
  totalProviders: number;
  totalRequests: number;
  avgRatio: number;
  avgSurge: number;
  avgResponseTime: number;
  avgETA: number;
  cityHealth: number;
}

const STATE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  surplus: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/50' },
  balanced: { bg: 'bg-green-500/20', text: 'text-green-400', border: 'border-green-500/50' },
  busy: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500/50' },
  surge: { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500/50' },
  critical: { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/50' },
  dead: { bg: 'bg-slate-500/20', text: 'text-slate-400', border: 'border-slate-500/50' },
};

const STATE_LABELS: Record<string, string> = {
  surplus: 'Избыток',
  balanced: 'Баланс',
  busy: 'Нагрузка',
  surge: 'Surge',
  critical: 'Критично',
  dead: 'Мёртвая',
};

export default function GeoOpsPage() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [kpis, setKpis] = useState<CityKPIs | null>(null);
  const [selectedZone, setSelectedZone] = useState<Zone | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [showActionPanel, setShowActionPanel] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [zonesRes, kpisRes] = await Promise.all([
        adminAPI.getZones(),
        adminAPI.getZoneKPIs(),
      ]);
      setZones(zonesRes.data || []);
      setKpis(kpisRes.data || null);
    } catch (err) {
      console.error('Failed to fetch zones:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleZoneAction = async (action: string, data: any) => {
    if (!selectedZone) return;
    setActionLoading(true);
    try {
      await adminAPI.performZoneAction(selectedZone._id, action, data);
      fetchData();
    } catch (err) {
      console.error('Zone action failed:', err);
    } finally {
      setActionLoading(false);
    }
  };

  // Group zones by state
  const zonesByState = {
    critical: zones.filter(z => z.metrics?.state === 'critical'),
    surge: zones.filter(z => z.metrics?.state === 'surge'),
    busy: zones.filter(z => z.metrics?.state === 'busy'),
    balanced: zones.filter(z => z.metrics?.state === 'balanced'),
    surplus: zones.filter(z => z.metrics?.state === 'surplus'),
    dead: zones.filter(z => z.metrics?.state === 'dead'),
  };

  return (
    <div className="p-6 h-full flex flex-col" data-testid="geo-ops-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-cyan-500/20 to-blue-500/20 rounded-xl">
            <Globe size={28} className="text-cyan-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">City-Level Control</h1>
            <p className="text-slate-400 text-sm">Управление городом как системой</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/20 border border-green-500/50 rounded-lg">
            <Radio size={14} className="text-green-400 animate-pulse" />
            <span className="text-green-400 text-sm">Live • 5s</span>
          </div>
          <button
            onClick={fetchData}
            className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg"
            data-testid="refresh-btn"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Обновить
          </button>
        </div>
      </div>

      {/* City KPIs */}
      {kpis && (
        <div className="grid grid-cols-6 gap-4 mb-6">
          <KPICard
            icon={<Globe className="text-cyan-400" />}
            label="Зоны"
            value={kpis.totalZones}
            sublabel={`${kpis.healthyZones} здоровых`}
            color="cyan"
          />
          <KPICard
            icon={<Users className="text-green-400" />}
            label="Мастера онлайн"
            value={kpis.totalProviders}
            color="green"
          />
          <KPICard
            icon={<FileText className="text-blue-400" />}
            label="Активных заявок"
            value={kpis.totalRequests}
            color="blue"
          />
          <KPICard
            icon={<TrendingUp className="text-orange-400" />}
            label="Avg Ratio"
            value={kpis.avgRatio.toFixed(2)}
            sublabel={kpis.avgRatio > 2 ? 'Высокий!' : 'Норма'}
            color={kpis.avgRatio > 2 ? 'orange' : 'slate'}
          />
          <KPICard
            icon={<DollarSign className="text-yellow-400" />}
            label="Avg Surge"
            value={`${kpis.avgSurge.toFixed(2)}x`}
            color={kpis.avgSurge > 1.5 ? 'yellow' : 'slate'}
          />
          <KPICard
            icon={<Activity className="text-purple-400" />}
            label="City Health"
            value={`${Math.round(kpis.cityHealth)}%`}
            color={kpis.cityHealth > 70 ? 'green' : kpis.cityHealth > 40 ? 'yellow' : 'red'}
          />
        </div>
      )}

      {/* Critical Alerts */}
      {(zonesByState.critical.length > 0 || zonesByState.dead.length > 0) && (
        <div className="bg-red-500/10 border border-red-500/50 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="text-red-400" size={20} />
            <h3 className="text-red-400 font-semibold">Требует вмешательства</h3>
          </div>
          <div className="flex flex-wrap gap-3">
            {[...zonesByState.critical, ...zonesByState.dead].map(zone => (
              <button
                key={zone._id}
                onClick={() => { setSelectedZone(zone); setShowActionPanel(true); }}
                className="flex items-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/50 rounded-lg transition-colors"
              >
                <span className="text-white font-medium">{zone.name}</span>
                <span className={`px-2 py-0.5 rounded text-xs ${
                  zone.metrics?.state === 'dead' 
                    ? 'bg-slate-500/30 text-slate-300' 
                    : 'bg-red-500/30 text-red-400'
                }`}>
                  {STATE_LABELS[zone.metrics?.state || 'balanced']}
                </span>
                {zone.metrics && (
                  <span className="text-red-400 text-sm">
                    {zone.metrics.activeRequests} заявок / {zone.metrics.availableProviders} мастеров
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex gap-6 flex-1 min-h-0">
        {/* Zone Grid */}
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-3 gap-4">
            {zones.map(zone => (
              <ZoneCard
                key={zone._id}
                zone={zone}
                isSelected={selectedZone?._id === zone._id}
                onClick={() => { setSelectedZone(zone); setShowActionPanel(true); }}
              />
            ))}
          </div>

          {zones.length === 0 && !loading && (
            <div className="text-center py-12">
              <Globe size={48} className="text-slate-600 mx-auto mb-4" />
              <p className="text-slate-400">Нет активных зон</p>
              <p className="text-slate-500 text-sm mt-1">Создайте зоны для управления городом</p>
            </div>
          )}
        </div>

        {/* Action Panel */}
        {showActionPanel && selectedZone && (
          <ZoneActionPanel
            zone={selectedZone}
            onClose={() => { setShowActionPanel(false); setSelectedZone(null); }}
            onAction={handleZoneAction}
            loading={actionLoading}
          />
        )}
      </div>

      {/* State Legend */}
      <div className="flex items-center justify-center gap-6 mt-6 py-3 border-t border-slate-700">
        {Object.entries(STATE_LABELS).map(([state, label]) => (
          <div key={state} className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${STATE_COLORS[state].bg} border ${STATE_COLORS[state].border}`} />
            <span className={`text-sm ${STATE_COLORS[state].text}`}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// KPI Card Component
function KPICard({ 
  icon, label, value, sublabel, color 
}: { 
  icon: React.ReactNode; 
  label: string; 
  value: string | number; 
  sublabel?: string;
  color: string;
}) {
  return (
    <div className={`bg-slate-800 rounded-xl border border-slate-700 p-4`}>
      <div className="flex items-center gap-3">
        <div className={`p-2 bg-${color}-500/20 rounded-lg`}>
          {icon}
        </div>
        <div>
          <p className="text-2xl font-bold text-white">{value}</p>
          <p className="text-slate-400 text-xs">{label}</p>
          {sublabel && (
            <p className={`text-xs text-${color}-400`}>{sublabel}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// Zone Card Component
function ZoneCard({ 
  zone, 
  isSelected, 
  onClick 
}: { 
  zone: Zone; 
  isSelected: boolean;
  onClick: () => void;
}) {
  const state = zone.metrics?.state || 'balanced';
  const colors = STATE_COLORS[state];
  const metrics = zone.metrics;

  return (
    <div
      onClick={onClick}
      className={`p-4 rounded-xl cursor-pointer transition-all ${
        isSelected 
          ? `${colors.bg} border-2 ${colors.border}` 
          : 'bg-slate-800 border border-slate-700 hover:border-slate-600'
      }`}
      data-testid={`zone-card-${zone.code}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-white font-semibold">{zone.name}</h3>
          <p className="text-slate-400 text-xs">{zone.code}</p>
        </div>
        <span className={`px-2 py-1 rounded text-xs font-medium ${colors.bg} ${colors.text}`}>
          {STATE_LABELS[state]}
        </span>
      </div>

      {/* Metrics */}
      {metrics && (
        <>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <p className="text-slate-400 text-xs">Заявки</p>
              <p className="text-xl font-bold text-white">{metrics.activeRequests}</p>
            </div>
            <div>
              <p className="text-slate-400 text-xs">Мастера</p>
              <p className="text-xl font-bold text-white">{metrics.availableProviders}</p>
            </div>
          </div>

          {/* Ratio bar */}
          <div className="mb-3">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-slate-400">Ratio</span>
              <span className={colors.text}>{metrics.ratio.toFixed(2)}</span>
            </div>
            <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
              <div 
                className={`h-full ${state === 'critical' ? 'bg-red-500' : state === 'surge' ? 'bg-orange-500' : state === 'busy' ? 'bg-yellow-500' : 'bg-green-500'} transition-all`}
                style={{ width: `${Math.min(metrics.ratio / 4 * 100, 100)}%` }}
              />
            </div>
          </div>

          {/* Quick stats */}
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Surge: {metrics.surgeMultiplier}x</span>
            <span>{metrics.urgentRequests > 0 && <span className="text-red-400">{metrics.urgentRequests} срочных</span>}</span>
          </div>
        </>
      )}

      {/* Auto mode indicator */}
      {zone.config?.autoMode && (
        <div className="flex items-center gap-1 mt-2 text-cyan-400 text-xs">
          <Zap size={12} />
          <span>Auto</span>
        </div>
      )}
    </div>
  );
}

// Zone Action Panel Component
function ZoneActionPanel({ 
  zone, 
  onClose, 
  onAction,
  loading 
}: { 
  zone: Zone;
  onClose: () => void;
  onAction: (action: string, data: any) => void;
  loading: boolean;
}) {
  const [surgeValue, setSurgeValue] = useState(zone.config?.baseSurge || 1.0);
  const state = zone.metrics?.state || 'balanced';
  const colors = STATE_COLORS[state];

  return (
    <div className="w-96 bg-slate-800 rounded-xl border border-slate-700 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">{zone.name}</h2>
            <p className="text-slate-400 text-xs">{zone.code}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1">
            <X size={20} />
          </button>
        </div>
        <div className={`mt-3 p-3 rounded-lg ${colors.bg} border ${colors.border}`}>
          <div className="flex items-center justify-between">
            <span className={colors.text}>{STATE_LABELS[state]}</span>
            <span className="text-white font-bold">Ratio: {zone.metrics?.ratio.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="p-4 border-b border-slate-700">
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-slate-700/50 rounded-lg p-3">
            <p className="text-slate-400 text-xs">Заявки</p>
            <p className="text-2xl font-bold text-white">{zone.metrics?.activeRequests || 0}</p>
            <p className="text-red-400 text-xs">{zone.metrics?.urgentRequests || 0} срочных</p>
          </div>
          <div className="bg-slate-700/50 rounded-lg p-3">
            <p className="text-slate-400 text-xs">Мастера</p>
            <p className="text-2xl font-bold text-white">{zone.metrics?.availableProviders || 0}</p>
            <p className="text-slate-400 text-xs">из {zone.metrics?.onlineProviders || 0} онлайн</p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="p-4 flex-1 overflow-auto">
        <h3 className="text-white font-medium mb-3">Действия</h3>
        
        {/* Surge Control */}
        <div className="bg-slate-700/50 rounded-lg p-3 mb-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-slate-300 text-sm flex items-center gap-2">
              <DollarSign size={14} />
              Surge цена
            </span>
            <span className="text-yellow-400 font-bold">{surgeValue.toFixed(2)}x</span>
          </div>
          <input
            type="range"
            min="1"
            max="2.5"
            step="0.1"
            value={surgeValue}
            onChange={(e) => setSurgeValue(parseFloat(e.target.value))}
            className="w-full"
          />
          <button
            onClick={() => onAction('surge_adjust', { 
              previousValue: zone.config?.baseSurge, 
              newValue: surgeValue,
              reason: 'Manual surge adjustment'
            })}
            disabled={loading || surgeValue === zone.config?.baseSurge}
            className="w-full mt-2 py-2 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 rounded-lg text-sm disabled:opacity-50"
          >
            Применить Surge
          </button>
        </div>

        {/* Quick Actions */}
        <div className="space-y-2">
          <ActionButton
            icon={<TrendingUp size={16} />}
            label="Boost Supply"
            sublabel="Повысить visibility мастерам"
            onClick={() => onAction('supply_boost', { 
              reason: 'Manual supply boost',
              newValue: { boostFactor: 1.5 }
            })}
            disabled={loading}
            color="green"
          />
          
          <ActionButton
            icon={<Maximize size={16} />}
            label="Расширить радиус"
            sublabel="Подтянуть из соседних зон"
            onClick={() => onAction('radius_expand', { 
              previousValue: zone.radiusKm,
              newValue: zone.radiusKm * 1.5,
              reason: 'Manual radius expansion'
            })}
            disabled={loading}
            color="cyan"
          />
          
          <ActionButton
            icon={<Volume2 size={16} />}
            label="Push мастерам"
            sublabel="Отправить уведомление"
            onClick={() => onAction('push_notification', { 
              newValue: { message: `Высокий спрос в ${zone.name}!` },
              reason: 'Manual push notification'
            })}
            disabled={loading}
            color="purple"
          />

          <div className="pt-2 border-t border-slate-600 mt-4">
            <div className="flex items-center justify-between">
              <span className="text-slate-300 text-sm flex items-center gap-2">
                <Zap size={14} />
                Auto режим
              </span>
              <button
                onClick={() => onAction('auto_mode_toggle', { 
                  previousValue: zone.config?.autoMode,
                  newValue: !zone.config?.autoMode,
                  reason: 'Manual auto mode toggle'
                })}
                disabled={loading}
                className={`px-3 py-1 rounded-lg text-sm ${
                  zone.config?.autoMode 
                    ? 'bg-cyan-500/20 text-cyan-400' 
                    : 'bg-slate-600 text-slate-400'
                }`}
              >
                {zone.config?.autoMode ? 'Вкл' : 'Выкл'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionButton({ 
  icon, 
  label, 
  sublabel, 
  onClick, 
  disabled, 
  color 
}: { 
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  onClick: () => void;
  disabled: boolean;
  color: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 p-3 bg-${color}-500/10 hover:bg-${color}-500/20 border border-${color}-500/30 rounded-lg text-left transition-colors disabled:opacity-50`}
    >
      <div className={`p-2 bg-${color}-500/20 rounded-lg text-${color}-400`}>
        {icon}
      </div>
      <div>
        <p className="text-white text-sm font-medium">{label}</p>
        <p className="text-slate-400 text-xs">{sublabel}</p>
      </div>
    </button>
  );
}

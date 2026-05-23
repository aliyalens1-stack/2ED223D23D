import { useEffect, useState, useCallback } from 'react';
import { adminAPI } from '../services/api';
import { 
  Inbox, Clock, DollarSign, TrendingUp, AlertCircle, 
  Check, X, RefreshCw, MapPin, Star, Zap, Award,
  ChevronRight, Timer, Activity, Target, User
} from 'lucide-react';

interface InboxItem {
  distributionId: string;
  requestId: string;
  serviceName: string;
  description: string;
  urgency: string;
  distanceKm: number;
  etaMinutes: number;
  matchingScore: number;
  estimatedPrice: number;
  reasons: string[];
  expiresInSeconds: number;
  status: string;
  customerName?: string;
  location?: { lat: number; lng: number };
  createdAt: string;
}

interface PressureSummary {
  missedToday: number;
  lostRevenueToday: number;
  behavioralScore: number;
  tier: string;
  onlineState: string;
  acceptedToday: number;
  responseRate: number;
  avgResponseTime: number;
  tips: string[];
}

const URGENCY_COLORS: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  normal: 'bg-blue-500',
  low: 'bg-slate-500',
};

const URGENCY_LABELS: Record<string, string> = {
  critical: 'Критично',
  high: 'Срочно',
  normal: 'Обычный',
  low: 'Не срочно',
};

const TIER_COLORS: Record<string, string> = {
  Platinum: 'text-purple-400',
  Gold: 'text-yellow-400',
  Silver: 'text-slate-300',
  Bronze: 'text-orange-400',
};

export default function ProviderInboxPage() {
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [pressure, setPressure] = useState<PressureSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [inboxRes, pressureRes] = await Promise.all([
        adminAPI.getProviderInbox(),
        adminAPI.getProviderPressureSummary(),
      ]);
      setInbox(inboxRes.data || []);
      setPressure(pressureRes.data || null);
      setIsOnline(pressureRes.data?.onlineState === 'online');
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Auto-refresh every 5 seconds
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Update timers every second
  useEffect(() => {
    const interval = setInterval(() => {
      setInbox(prev => prev.map(item => ({
        ...item,
        expiresInSeconds: Math.max(0, item.expiresInSeconds - 1),
      })));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleAccept = async (distributionId: string) => {
    setAccepting(distributionId);
    try {
      const res = await adminAPI.providerAcceptRequest(distributionId);
      if (res.data?.success) {
        // Remove from inbox
        setInbox(prev => prev.filter(i => i.distributionId !== distributionId));
        // Update pressure
        if (pressure) {
          setPressure({
            ...pressure,
            acceptedToday: pressure.acceptedToday + 1,
          });
        }
      }
    } catch (err: any) {
      alert(err.response?.data?.message || 'Ошибка принятия заявки');
    } finally {
      setAccepting(null);
    }
  };

  const handleReject = async (distributionId: string) => {
    try {
      await adminAPI.providerRejectRequest(distributionId);
      setInbox(prev => prev.filter(i => i.distributionId !== distributionId));
      if (pressure) {
        setPressure({
          ...pressure,
          missedToday: pressure.missedToday + 1,
          lostRevenueToday: pressure.lostRevenueToday + 1500,
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  const toggleOnline = async () => {
    try {
      await adminAPI.updateProviderPresence(!isOnline);
      setIsOnline(!isOnline);
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  const urgentCount = inbox.filter(i => i.urgency === 'critical' || i.urgency === 'high').length;

  return (
    <div className="p-6 h-full flex flex-col" data-testid="provider-inbox-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/20 rounded-lg">
            <Inbox size={24} className="text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Provider Inbox</h1>
            <p className="text-slate-400 text-sm">Входящие заявки • Как Uber Driver</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Online toggle */}
          <button
            onClick={toggleOnline}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
              isOnline 
                ? 'bg-green-500/20 text-green-400 border border-green-500/50' 
                : 'bg-slate-700 text-slate-400 border border-slate-600'
            }`}
          >
            <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500 animate-pulse' : 'bg-slate-500'}`} />
            {isOnline ? 'Онлайн' : 'Оффлайн'}
          </button>
          <button
            onClick={fetchData}
            className="p-2 bg-slate-700 hover:bg-slate-600 rounded-lg"
          >
            <RefreshCw size={18} className="text-slate-300" />
          </button>
        </div>
      </div>

      {/* Pressure Summary Bar */}
      {pressure && (
        <div className="grid grid-cols-5 gap-4 mb-6">
          {/* Tier & Score */}
          <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Award size={18} className={TIER_COLORS[pressure.tier] || 'text-slate-400'} />
              <span className={`font-bold ${TIER_COLORS[pressure.tier] || 'text-slate-400'}`}>
                {pressure.tier}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-slate-700 rounded-full h-2">
                <div 
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{ width: `${pressure.behavioralScore}%` }}
                />
              </div>
              <span className="text-white text-sm font-medium">{pressure.behavioralScore}</span>
            </div>
          </div>

          {/* Accepted Today */}
          <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
            <div className="flex items-center gap-2 text-green-400 mb-1">
              <Check size={16} />
              <span className="text-xs">Принято сегодня</span>
            </div>
            <p className="text-2xl font-bold text-white">{pressure.acceptedToday}</p>
          </div>

          {/* Missed Today */}
          <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
            <div className="flex items-center gap-2 text-red-400 mb-1">
              <X size={16} />
              <span className="text-xs">Пропущено</span>
            </div>
            <p className="text-2xl font-bold text-white">{pressure.missedToday}</p>
          </div>

          {/* Lost Revenue */}
          <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
            <div className="flex items-center gap-2 text-orange-400 mb-1">
              <DollarSign size={16} />
              <span className="text-xs">Потеряно (грн)</span>
            </div>
            <p className="text-2xl font-bold text-white">~{pressure.lostRevenueToday.toLocaleString()}</p>
          </div>

          {/* Response Rate */}
          <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
            <div className="flex items-center gap-2 text-blue-400 mb-1">
              <Activity size={16} />
              <span className="text-xs">Response Rate</span>
            </div>
            <p className="text-2xl font-bold text-white">{Math.round(pressure.responseRate * 100)}%</p>
          </div>
        </div>
      )}

      {/* Tips Banner */}
      {pressure && pressure.tips.length > 0 && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 mb-6 flex items-center gap-3">
          <Zap size={18} className="text-blue-400 flex-shrink-0" />
          <p className="text-blue-300 text-sm">{pressure.tips.join(' • ')}</p>
        </div>
      )}

      <div className="flex gap-6 flex-1 min-h-0">
        {/* Inbox Queue */}
        <div className="flex-1 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              Очередь заявок
              {inbox.length > 0 && (
                <span className="px-2 py-0.5 bg-primary/20 text-primary text-sm rounded">{inbox.length}</span>
              )}
              {urgentCount > 0 && (
                <span className="px-2 py-0.5 bg-red-500/20 text-red-400 text-sm rounded">{urgentCount} срочных!</span>
              )}
            </h2>
          </div>

          <div className="flex-1 overflow-auto space-y-4">
            {inbox.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-12">
                <Inbox size={48} className="text-slate-600 mb-4" />
                <p className="text-slate-400 text-lg">Нет новых заявок</p>
                {isOnline ? (
                  <p className="text-green-400 text-sm mt-2 flex items-center gap-2">
                    <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                    Ожидание заявок...
                  </p>
                ) : (
                  <p className="text-slate-500 text-sm mt-2">Включите режим "Онлайн" для получения заявок</p>
                )}
              </div>
            ) : (
              inbox.map((item, idx) => (
                <RequestCard
                  key={item.distributionId}
                  item={item}
                  isFirst={idx === 0}
                  accepting={accepting === item.distributionId}
                  onAccept={() => handleAccept(item.distributionId)}
                  onReject={() => handleReject(item.distributionId)}
                />
              ))
            )}
          </div>
        </div>

        {/* Stats Sidebar */}
        <div className="w-80 bg-slate-800 rounded-xl border border-slate-700 p-4">
          <h3 className="text-lg font-semibold text-white mb-4">Статистика</h3>
          
          {/* Today's earnings estimate */}
          <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 mb-4">
            <p className="text-green-400 text-sm mb-1">Потенциальный доход сегодня</p>
            <p className="text-2xl font-bold text-white">
              ~{((pressure?.acceptedToday || 0) * 1500).toLocaleString()} грн
            </p>
          </div>

          {/* Quick stats */}
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg">
              <span className="text-slate-400 text-sm">Заявок рядом</span>
              <span className="text-white font-medium">{inbox.length}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg">
              <span className="text-slate-400 text-sm">Средний чек</span>
              <span className="text-white font-medium">~1500 грн</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg">
              <span className="text-slate-400 text-sm">Время ответа</span>
              <span className="text-white font-medium">{pressure?.avgResponseTime || 25} сек</span>
            </div>
          </div>

          {/* Level progress */}
          <div className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-slate-400 text-sm">До следующего уровня</span>
              <span className={`font-medium ${TIER_COLORS[pressure?.tier || 'Silver']}`}>
                {pressure?.tier}
              </span>
            </div>
            <div className="bg-slate-700 rounded-full h-3">
              <div 
                className="bg-gradient-to-r from-primary to-purple-500 h-3 rounded-full transition-all"
                style={{ width: `${pressure?.behavioralScore || 50}%` }}
              />
            </div>
            <p className="text-slate-500 text-xs mt-1">
              {pressure?.behavioralScore || 50}/100 баллов
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// Request Card Component
function RequestCard({ 
  item, 
  isFirst, 
  accepting, 
  onAccept, 
  onReject 
}: { 
  item: InboxItem; 
  isFirst: boolean;
  accepting: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const isUrgent = item.urgency === 'critical' || item.urgency === 'high';
  const isExpiring = item.expiresInSeconds < 10;
  const isExpired = item.expiresInSeconds <= 0;

  return (
    <div 
      className={`rounded-xl border p-4 transition-all ${
        isFirst 
          ? 'bg-gradient-to-r from-primary/10 to-purple-500/10 border-primary/50' 
          : isUrgent 
            ? 'bg-red-500/5 border-red-500/30' 
            : 'bg-slate-800 border-slate-700'
      } ${isExpiring && !isExpired ? 'animate-pulse' : ''}`}
      data-testid={`inbox-item-${item.distributionId}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-white font-semibold">{item.serviceName}</span>
            {isFirst && (
              <span className="px-2 py-0.5 bg-primary/30 text-primary text-xs rounded">Лучшая для вас</span>
            )}
            <span className={`px-2 py-0.5 ${URGENCY_COLORS[item.urgency]}/30 text-xs rounded ${
              item.urgency === 'critical' ? 'text-red-400' : 
              item.urgency === 'high' ? 'text-orange-400' : 'text-slate-300'
            }`}>
              {URGENCY_LABELS[item.urgency]}
            </span>
          </div>
          <p className="text-slate-400 text-sm line-clamp-1">{item.description}</p>
        </div>
        
        {/* Timer */}
        <div className={`flex items-center gap-1 px-3 py-1.5 rounded-lg ${
          isExpired 
            ? 'bg-slate-700 text-slate-500'
            : isExpiring 
              ? 'bg-red-500/20 text-red-400' 
              : 'bg-slate-700 text-slate-300'
        }`}>
          <Timer size={14} />
          <span className="font-mono text-sm">
            {isExpired ? 'Истекло' : `00:${item.expiresInSeconds.toString().padStart(2, '0')}`}
          </span>
        </div>
      </div>

      {/* Stats Row */}
      <div className="flex items-center gap-4 mb-3 text-sm">
        <div className="flex items-center gap-1 text-slate-400">
          <MapPin size={14} />
          <span>{item.distanceKm.toFixed(1)} км</span>
        </div>
        <div className="flex items-center gap-1 text-slate-400">
          <Clock size={14} />
          <span>~{item.etaMinutes} мин</span>
        </div>
        <div className="flex items-center gap-1 text-green-400">
          <DollarSign size={14} />
          <span>~{item.estimatedPrice.toLocaleString()} грн</span>
        </div>
        <div className="flex items-center gap-1 text-primary">
          <Target size={14} />
          <span>Score: {item.matchingScore}</span>
        </div>
      </div>

      {/* Reasons */}
      {item.reasons.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {item.reasons.map((reason, i) => (
            <span key={i} className="px-2 py-0.5 bg-slate-700 text-slate-300 text-xs rounded">
              {reason}
            </span>
          ))}
        </div>
      )}

      {/* Customer */}
      <div className="flex items-center gap-2 mb-4 text-sm text-slate-400">
        <User size={14} />
        <span>{item.customerName}</span>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={onAccept}
          disabled={accepting || isExpired}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-medium transition-all ${
            isFirst 
              ? 'bg-green-500 hover:bg-green-600 text-white' 
              : 'bg-primary hover:bg-primary/90 text-white'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {accepting ? (
            <RefreshCw size={18} className="animate-spin" />
          ) : (
            <>
              <Check size={18} />
              Принять
            </>
          )}
        </button>
        <button
          onClick={onReject}
          disabled={accepting}
          className="px-4 py-3 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg font-medium transition-colors disabled:opacity-50"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
}

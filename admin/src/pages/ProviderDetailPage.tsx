import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { adminAPI } from '../services/api';
import { 
  Building2, ArrowLeft, Star, Shield, MapPin, Phone, Mail,
  Clock, TrendingUp, TrendingDown, DollarSign, AlertTriangle,
  CheckCircle, XCircle, Zap, Eye, EyeOff, Settings, FileText,
  Activity, CreditCard, Map, Package, Users, BarChart3, Lightbulb,
  Target, AlertCircle, ChevronRight
} from 'lucide-react';

interface ProviderDetail {
  _id: string;
  name: string;
  type: string;
  email?: string;
  phone?: string;
  city?: string;
  district?: string;
  about?: string;
  isVerified?: boolean;
  isOnline?: boolean;
  rating?: number;
  reviewsCount?: number;
  score?: number;
  tier?: string;
  status?: string;
  visibilityState?: string;
  completedBookings?: number;
  missedRequests?: number;
  responseTimeAvg?: number;
  acceptanceRate?: number;
  completionRate?: number;
  disputeRate?: number;
  earnings?: number;
  pendingPayout?: number;
  commission?: number;
  serviceRadius?: number;
  isMobile?: boolean;
  createdAt?: string;
  lastOnline?: string;
  currentJob?: boolean;
}

interface Insight {
  type: 'warning' | 'success' | 'info' | 'danger';
  title: string;
  description: string;
  lostRevenue?: number;
  action?: string;
  actionLabel?: string;
}

const TIER_CONFIG: Record<string, { label: string; color: string; bgColor: string; commission: number }> = {
  bronze: { label: 'Bronze', color: 'text-orange-700', bgColor: 'bg-orange-500/20', commission: 15 },
  silver: { label: 'Silver', color: 'text-slate-300', bgColor: 'bg-slate-500/20', commission: 12 },
  gold: { label: 'Gold', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20', commission: 10 },
  platinum: { label: 'Platinum', color: 'text-cyan-400', bgColor: 'bg-cyan-500/20', commission: 8 },
};

const STATUS_OPTIONS = [
  { value: 'active', label: 'Активен', color: 'bg-green-500' },
  { value: 'paused', label: 'Пауза', color: 'bg-yellow-500' },
  { value: 'limited', label: 'Ограничен', color: 'bg-orange-500' },
  { value: 'suspended', label: 'Заблокирован', color: 'bg-red-500' },
];

const VISIBILITY_OPTIONS = [
  { value: 'normal', label: 'Обычная', icon: Eye },
  { value: 'boosted', label: 'Буст', icon: Zap },
  { value: 'limited', label: 'Ограничена', icon: TrendingDown },
  { value: 'shadow_limited', label: 'Shadow Limit', icon: EyeOff },
];

export default function ProviderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [provider, setProvider] = useState<ProviderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [insights, setInsights] = useState<Insight[]>([]);
  const [lostRevenue, setLostRevenue] = useState({ total: 0, missed: 0, slow: 0, rejected: 0 });

  useEffect(() => {
    fetchProvider();
  }, [id]);

  const fetchProvider = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getOrganization(id!);
      const org = res.data;
      
      // Transform to provider detail
      const detail: ProviderDetail = {
        _id: org._id,
        name: org.name,
        type: org.type || 'sto',
        email: org.email,
        phone: org.phone,
        city: org.cityId || 'Киев',
        district: org.district,
        about: org.about,
        isVerified: org.isVerified || false,
        isOnline: org.isOnline || false,
        rating: org.rating || 0,
        reviewsCount: org.reviewsCount || 0,
        score: org.score || 0,
        tier: org.tier || 'bronze',
        status: org.status || 'active',
        visibilityState: org.visibilityState || 'normal',
        completedBookings: org.completedBookings || 0,
        missedRequests: org.missedRequests || 0,
        responseTimeAvg: org.responseTimeAvg || 0,
        acceptanceRate: org.acceptanceRate || 0,
        completionRate: org.completionRate || 0,
        disputeRate: org.disputeRate || 0,
        earnings: org.earnings || 0,
        pendingPayout: org.pendingPayout || 0,
        commission: org.commission || 15,
        serviceRadius: org.serviceRadius || 5,
        isMobile: org.isMobile || false,
        createdAt: org.createdAt,
        lastOnline: org.lastOnline || org.updatedAt || org.createdAt,
        currentJob: org.currentJob || false,
      };
      
      setProvider(detail);
      generateInsights(detail);
      calculateLostRevenue(detail);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const generateInsights = (p: ProviderDetail) => {
    const ins: Insight[] = [];
    
    if ((p.responseTimeAvg || 0) > 120) {
      ins.push({
        type: 'warning',
        title: 'Медленный ответ',
        description: `Вы отвечаете за ${Math.round((p.responseTimeAvg || 0) / 60)} мин. 35% заявок уходят другим мастерам.`,
        lostRevenue: 800,
        action: 'enable_quick_mode',
        actionLabel: 'Включить быстрый режим',
      });
    }
    
    if ((p.acceptanceRate || 0) < 0.7) {
      ins.push({
        type: 'danger',
        title: 'Низкое принятие заявок',
        description: `Acceptance rate ${Math.round((p.acceptanceRate || 0) * 100)}%. Вы теряете поток заявок.`,
        lostRevenue: 1200,
        action: 'expand_services',
        actionLabel: 'Расширить услуги',
      });
    }
    
    if ((p.missedRequests || 0) > 10) {
      ins.push({
        type: 'danger',
        title: 'Много пропущенных заявок',
        description: `${p.missedRequests} пропущенных заявок. Это снижает ваш рейтинг.`,
        lostRevenue: 2100,
        action: 'enable_notifications',
        actionLabel: 'Настроить уведомления',
      });
    }
    
    if ((p.completionRate || 0) > 0.95) {
      ins.push({
        type: 'success',
        title: 'Отличное завершение',
        description: `Completion rate ${Math.round((p.completionRate || 0) * 100)}%. Это повышает ваш рейтинг.`,
      });
    }
    
    if ((p.score || 0) >= 80) {
      ins.push({
        type: 'info',
        title: 'Готовы к повышению',
        description: 'Ваш score достаточен для перехода на следующий уровень.',
        action: 'request_upgrade',
        actionLabel: 'Запросить апгрейд',
      });
    }
    
    setInsights(ins);
  };

  const calculateLostRevenue = (p: ProviderDetail) => {
    const avgOrder = 1500;
    const missed = (p.missedRequests || 0) * avgOrder * 0.3;
    const slow = (p.responseTimeAvg || 0) > 120 ? 800 : 0;
    const rejected = (1 - (p.acceptanceRate || 1)) * 10 * avgOrder * 0.2;
    
    setLostRevenue({
      total: Math.round(missed + slow + rejected),
      missed: Math.round(missed),
      slow: Math.round(slow),
      rejected: Math.round(rejected),
    });
  };

  const handleStatusChange = async (newStatus: string) => {
    if (!provider) return;
    try {
      // In real app, call API
      setProvider({ ...provider, status: newStatus });
    } catch (err) {
      console.error(err);
    }
  };

  const handleVisibilityChange = async (newVis: string) => {
    if (!provider) return;
    try {
      setProvider({ ...provider, visibilityState: newVis });
    } catch (err) {
      console.error(err);
    }
  };

  const handleCommissionChange = async (newCommission: number) => {
    if (!provider) return;
    try {
      setProvider({ ...provider, commission: newCommission });
    } catch (err) {
      console.error(err);
    }
  };

  if (loading || !provider) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <div className="text-slate-400">Загрузка...</div>
      </div>
    );
  }

  const tier = TIER_CONFIG[provider.tier || 'bronze'];
  const scoreColor = (provider.score || 0) >= 80 ? 'text-green-400' : 
                     (provider.score || 0) >= 60 ? 'text-yellow-400' : 
                     (provider.score || 0) >= 40 ? 'text-orange-400' : 'text-red-400';

  const tabs = [
    { id: 'overview', label: 'Обзор', icon: BarChart3 },
    { id: 'verification', label: 'Верификация', icon: Shield },
    { id: 'performance', label: 'Performance', icon: Activity },
    { id: 'intelligence', label: 'Intelligence', icon: Lightbulb },
    { id: 'services', label: 'Услуги', icon: Package },
    { id: 'coverage', label: 'Покрытие', icon: Map },
    { id: 'visibility', label: 'Visibility', icon: Eye },
    { id: 'finance', label: 'Финансы', icon: CreditCard },
  ];

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <button 
          onClick={() => navigate('/providers')}
          className="p-2 hover:bg-slate-700 rounded-lg text-slate-400"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-4 flex-1">
          <div className="relative">
            <div className="w-16 h-16 bg-gradient-to-br from-purple-500 to-pink-600 rounded-xl flex items-center justify-center">
              <Building2 size={32} className="text-white" />
            </div>
            {provider.isOnline && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-slate-900" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-white">{provider.name}</h1>
              {provider.isVerified && <Shield size={20} className="text-blue-400" />}
              <span className={`px-2 py-1 rounded text-xs font-medium ${tier.bgColor} ${tier.color}`}>
                {tier.label}
              </span>
            </div>
            <div className="flex items-center gap-4 mt-1 text-sm text-slate-400">
              <span className="flex items-center gap-1">
                <MapPin size={14} /> {provider.city}
              </span>
              {provider.phone && (
                <span className="flex items-center gap-1">
                  <Phone size={14} /> {provider.phone}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Star size={14} className="text-yellow-400" /> {provider.rating} ({provider.reviewsCount})
              </span>
            </div>
          </div>
        </div>
        
        {/* Quick Stats */}
        <div className="flex items-center gap-6">
          <div className="text-center">
            <p className={`text-3xl font-bold ${scoreColor}`}>{provider.score}</p>
            <p className="text-xs text-slate-500">Score</p>
          </div>
          <div className="text-center">
            <p className="text-3xl font-bold text-white">₴{(provider.earnings || 0).toLocaleString()}</p>
            <p className="text-xs text-slate-500">Доход</p>
          </div>
          <div className="text-center">
            <p className="text-3xl font-bold text-white">{provider.completedBookings}</p>
            <p className="text-xs text-slate-500">Заказов</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-slate-800 p-1 rounded-lg overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.id 
                ? 'bg-primary text-white' 
                : 'text-slate-400 hover:text-white hover:bg-slate-700'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="space-y-6">
        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-3 gap-6">
            {/* Left Column - Info */}
            <div className="space-y-6">
              <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
                <h3 className="text-white font-medium mb-4">Информация</h3>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Тип</span>
                    <span className="text-white">{provider.type}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Email</span>
                    <span className="text-white">{provider.email || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Телефон</span>
                    <span className="text-white">{provider.phone || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Мобильный выезд</span>
                    <span className="text-white">{provider.isMobile ? 'Да' : 'Нет'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Радиус</span>
                    <span className="text-white">{provider.serviceRadius} км</span>
                  </div>
                </div>
              </div>

              <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
                <h3 className="text-white font-medium mb-4">Активность</h3>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Статус</span>
                    <span className={provider.isOnline ? 'text-green-400' : 'text-slate-500'}>
                      {provider.isOnline ? 'Онлайн' : 'Оффлайн'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Текущий заказ</span>
                    <span className={provider.currentJob ? 'text-orange-400' : 'text-slate-400'}>
                      {provider.currentJob ? 'Да' : 'Нет'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Последний онлайн</span>
                    <span className="text-white">2 мин назад</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Middle Column - Metrics */}
            <div className="space-y-6">
              <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
                <h3 className="text-white font-medium mb-4">Метрики</h3>
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-400">Acceptance Rate</span>
                      <span className="text-white">{Math.round((provider.acceptanceRate || 0) * 100)}%</span>
                    </div>
                    <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full ${(provider.acceptanceRate || 0) >= 0.7 ? 'bg-green-500' : 'bg-orange-500'}`}
                        style={{ width: `${(provider.acceptanceRate || 0) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-400">Completion Rate</span>
                      <span className="text-white">{Math.round((provider.completionRate || 0) * 100)}%</span>
                    </div>
                    <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-green-500 rounded-full"
                        style={{ width: `${(provider.completionRate || 0) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-400">Response Time</span>
                      <span className="text-white">{Math.round((provider.responseTimeAvg || 0) / 60)} мин</span>
                    </div>
                    <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full ${(provider.responseTimeAvg || 0) <= 120 ? 'bg-green-500' : 'bg-orange-500'}`}
                        style={{ width: `${Math.min(100, 100 - (provider.responseTimeAvg || 0) / 3)}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-400">Dispute Rate</span>
                      <span className="text-white">{Math.round((provider.disputeRate || 0) * 100)}%</span>
                    </div>
                    <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full ${(provider.disputeRate || 0) <= 0.05 ? 'bg-green-500' : 'bg-red-500'}`}
                        style={{ width: `${(provider.disputeRate || 0) * 100 * 10}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
                <h3 className="text-white font-medium mb-4">Статистика</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-700/50 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-green-400">{provider.completedBookings}</p>
                    <p className="text-xs text-slate-400">Завершено</p>
                  </div>
                  <div className="bg-slate-700/50 rounded-lg p-3 text-center">
                    <p className="text-2xl font-bold text-red-400">{provider.missedRequests}</p>
                    <p className="text-xs text-slate-400">Пропущено</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column - Quick Actions */}
            <div className="space-y-6">
              <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
                <h3 className="text-white font-medium mb-4">Быстрые действия</h3>
                <div className="space-y-3">
                  <button className="w-full flex items-center justify-between p-3 bg-green-500/10 hover:bg-green-500/20 border border-green-500/30 rounded-lg text-left">
                    <div className="flex items-center gap-2">
                      <Zap size={18} className="text-green-400" />
                      <span className="text-green-400 font-medium">Boost</span>
                    </div>
                    <ChevronRight size={16} className="text-green-400" />
                  </button>
                  <button className="w-full flex items-center justify-between p-3 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/30 rounded-lg text-left">
                    <div className="flex items-center gap-2">
                      <TrendingDown size={18} className="text-orange-400" />
                      <span className="text-orange-400 font-medium">Limit</span>
                    </div>
                    <ChevronRight size={16} className="text-orange-400" />
                  </button>
                  <button className="w-full flex items-center justify-between p-3 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg text-left">
                    <div className="flex items-center gap-2">
                      <XCircle size={18} className="text-red-400" />
                      <span className="text-red-400 font-medium">Suspend</span>
                    </div>
                    <ChevronRight size={16} className="text-red-400" />
                  </button>
                </div>
              </div>

              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-6">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle size={20} className="text-red-400" />
                  <h3 className="text-red-400 font-medium">Lost Revenue</h3>
                </div>
                <p className="text-3xl font-bold text-white mb-2">₴{lostRevenue.total.toLocaleString()}</p>
                <p className="text-slate-400 text-sm">за последние 7 дней</p>
              </div>
            </div>
          </div>
        )}

        {/* Intelligence Tab */}
        {activeTab === 'intelligence' && (
          <div className="grid grid-cols-2 gap-6">
            {/* Health Score */}
            <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
              <h3 className="text-white font-medium mb-4 flex items-center gap-2">
                <Target size={18} className="text-primary" />
                Health Score
              </h3>
              <div className="flex items-center gap-6 mb-6">
                <div className="relative w-32 h-32">
                  <svg className="w-32 h-32 transform -rotate-90">
                    <circle cx="64" cy="64" r="56" fill="none" stroke="#334155" strokeWidth="12" />
                    <circle 
                      cx="64" cy="64" r="56" fill="none" 
                      stroke={`${(provider.score || 0) >= 80 ? '#22c55e' : (provider.score || 0) >= 60 ? '#eab308' : (provider.score || 0) >= 40 ? '#f97316' : '#ef4444'}`}
                      strokeWidth="12"
                      strokeDasharray={`${(provider.score || 0) * 3.52} 352`}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className={`text-4xl font-bold ${scoreColor}`}>{provider.score}</span>
                  </div>
                </div>
                <div className="flex-1 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Response</span>
                    <span className={`font-medium ${(provider.responseTimeAvg || 0) <= 120 ? 'text-green-400' : 'text-orange-400'}`}>
                      {(provider.responseTimeAvg || 0) <= 120 ? 'Хорошо' : 'Медленно'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Acceptance</span>
                    <span className={`font-medium ${(provider.acceptanceRate || 0) >= 0.7 ? 'text-green-400' : 'text-orange-400'}`}>
                      {Math.round((provider.acceptanceRate || 0) * 100)}%
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Completion</span>
                    <span className="font-medium text-green-400">
                      {Math.round((provider.completionRate || 0) * 100)}%
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Trust</span>
                    <span className={`font-medium ${(provider.disputeRate || 0) <= 0.05 ? 'text-green-400' : 'text-red-400'}`}>
                      {(provider.disputeRate || 0) <= 0.05 ? 'Высокий' : 'Низкий'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Lost Revenue Breakdown */}
            <div className="bg-slate-800 rounded-xl border border-red-500/30 p-6">
              <h3 className="text-white font-medium mb-4 flex items-center gap-2">
                <DollarSign size={18} className="text-red-400" />
                Lost Revenue (7 дней)
              </h3>
              <p className="text-4xl font-bold text-red-400 mb-4">₴{lostRevenue.total.toLocaleString()}</p>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg">
                  <span className="text-slate-300">Пропущенные заявки</span>
                  <span className="text-white font-medium">₴{lostRevenue.missed.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg">
                  <span className="text-slate-300">Медленный ответ</span>
                  <span className="text-white font-medium">₴{lostRevenue.slow.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg">
                  <span className="text-slate-300">Отказы</span>
                  <span className="text-white font-medium">₴{lostRevenue.rejected.toLocaleString()}</span>
                </div>
              </div>
            </div>

            {/* Actionable Insights */}
            <div className="col-span-2">
              <h3 className="text-white font-medium mb-4 flex items-center gap-2">
                <Lightbulb size={18} className="text-yellow-400" />
                Actionable Insights
              </h3>
              <div className="grid grid-cols-2 gap-4">
                {insights.map((insight, idx) => (
                  <div 
                    key={idx}
                    className={`rounded-xl border p-4 ${
                      insight.type === 'danger' ? 'bg-red-500/10 border-red-500/30' :
                      insight.type === 'warning' ? 'bg-orange-500/10 border-orange-500/30' :
                      insight.type === 'success' ? 'bg-green-500/10 border-green-500/30' :
                      'bg-blue-500/10 border-blue-500/30'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {insight.type === 'danger' && <AlertCircle size={18} className="text-red-400" />}
                        {insight.type === 'warning' && <AlertTriangle size={18} className="text-orange-400" />}
                        {insight.type === 'success' && <CheckCircle size={18} className="text-green-400" />}
                        {insight.type === 'info' && <Lightbulb size={18} className="text-blue-400" />}
                        <h4 className={`font-medium ${
                          insight.type === 'danger' ? 'text-red-400' :
                          insight.type === 'warning' ? 'text-orange-400' :
                          insight.type === 'success' ? 'text-green-400' :
                          'text-blue-400'
                        }`}>{insight.title}</h4>
                      </div>
                      {insight.lostRevenue && (
                        <span className="text-red-400 font-medium">-₴{insight.lostRevenue}/нед</span>
                      )}
                    </div>
                    <p className="text-slate-300 text-sm mt-2">{insight.description}</p>
                    {insight.actionLabel && (
                      <button className="mt-3 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-medium">
                        {insight.actionLabel}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Visibility Tab */}
        {activeTab === 'visibility' && (
          <div className="grid grid-cols-2 gap-6">
            <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
              <h3 className="text-white font-medium mb-4">Visibility State</h3>
              <div className="space-y-3">
                {VISIBILITY_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  const isActive = provider.visibilityState === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => handleVisibilityChange(opt.value)}
                      className={`w-full flex items-center justify-between p-4 rounded-lg border transition-colors ${
                        isActive 
                          ? 'bg-primary/20 border-primary' 
                          : 'bg-slate-700/50 border-slate-600 hover:border-slate-500'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Icon size={20} className={isActive ? 'text-primary' : 'text-slate-400'} />
                        <span className={isActive ? 'text-white font-medium' : 'text-slate-300'}>{opt.label}</span>
                      </div>
                      {isActive && <CheckCircle size={18} className="text-primary" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
              <h3 className="text-white font-medium mb-4">Status</h3>
              <div className="space-y-3">
                {STATUS_OPTIONS.map((opt) => {
                  const isActive = provider.status === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => handleStatusChange(opt.value)}
                      className={`w-full flex items-center justify-between p-4 rounded-lg border transition-colors ${
                        isActive 
                          ? 'bg-primary/20 border-primary' 
                          : 'bg-slate-700/50 border-slate-600 hover:border-slate-500'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span className={`w-3 h-3 rounded-full ${opt.color}`} />
                        <span className={isActive ? 'text-white font-medium' : 'text-slate-300'}>{opt.label}</span>
                      </div>
                      {isActive && <CheckCircle size={18} className="text-primary" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Finance Tab */}
        {activeTab === 'finance' && (
          <div className="grid grid-cols-3 gap-6">
            <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
              <h3 className="text-slate-400 text-sm mb-2">Общий доход</h3>
              <p className="text-3xl font-bold text-white">₴{(provider.earnings || 0).toLocaleString()}</p>
            </div>
            <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
              <h3 className="text-slate-400 text-sm mb-2">Ожидает выплаты</h3>
              <p className="text-3xl font-bold text-yellow-400">₴{(provider.pendingPayout || 0).toLocaleString()}</p>
            </div>
            <div className="bg-slate-800 rounded-xl border border-slate-700 p-6">
              <h3 className="text-slate-400 text-sm mb-2">Комиссия платформы</h3>
              <p className="text-3xl font-bold text-white">{provider.commission}%</p>
            </div>

            <div className="col-span-3 bg-slate-800 rounded-xl border border-slate-700 p-6">
              <h3 className="text-white font-medium mb-4">Commission Override</h3>
              <div className="flex items-center gap-4">
                {[8, 10, 12, 15, 18, 20].map((rate) => (
                  <button
                    key={rate}
                    onClick={() => handleCommissionChange(rate)}
                    className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                      provider.commission === rate 
                        ? 'bg-primary text-white' 
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {rate}%
                  </button>
                ))}
              </div>
              <p className="text-slate-500 text-sm mt-3">
                Стандартная комиссия для уровня {tier.label}: {tier.commission}%
              </p>
            </div>
          </div>
        )}

        {/* Other tabs - simplified placeholders */}
        {['verification', 'performance', 'services', 'coverage'].includes(activeTab) && (
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-12 text-center">
            <Settings size={48} className="text-slate-600 mx-auto mb-4" />
            <p className="text-slate-400">Раздел {activeTab} в разработке</p>
          </div>
        )}
      </div>
    </div>
  );
}

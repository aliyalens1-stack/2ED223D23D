import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminAPI } from '../services/api';
import { 
  Building2, Search, Star, TrendingUp, TrendingDown, 
  MapPin, Clock, DollarSign, AlertTriangle, CheckCircle,
  Eye, EyeOff, Zap, Shield, Filter, ChevronDown, Send, MoreHorizontal, Power
} from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

interface Provider {
  _id: string;
  name: string;
  type: 'sto' | 'private_master' | 'mobile_service' | 'detailing' | 'towing' | 'tire_service';
  email?: string;
  phone?: string;
  city?: string;
  isVerified?: boolean;
  isOnline?: boolean;
  rating?: number;
  reviewsCount?: number;
  score?: number;
  tier?: 'bronze' | 'silver' | 'gold' | 'platinum';
  status?: 'active' | 'paused' | 'limited' | 'suspended';
  visibilityState?: 'normal' | 'boosted' | 'limited' | 'shadow_limited';
  completedBookings?: number;
  missedRequests?: number;
  responseTimeAvg?: number;
  acceptanceRate?: number;
  earnings?: number;
  commission?: number;
  createdAt?: string;
}

const TYPE_LABELS: Record<string, string> = {
  sto: 'СТО',
  private_master: 'Частный мастер',
  mobile_service: 'Мобильный сервис',
  detailing: 'Детейлинг',
  towing: 'Эвакуатор',
  tire_service: 'Шиномонтаж',
};

const TIER_CONFIG: Record<string, { label: string; color: string; bgColor: string }> = {
  bronze: { label: 'Bronze', color: 'text-orange-700', bgColor: 'bg-orange-500/20' },
  silver: { label: 'Silver', color: 'text-slate-300', bgColor: 'bg-slate-500/20' },
  gold: { label: 'Gold', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
  platinum: { label: 'Platinum', color: 'text-cyan-400', bgColor: 'bg-cyan-500/20' },
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bgColor: string }> = {
  active: { label: 'Активен', color: 'text-green-400', bgColor: 'bg-green-500/20' },
  paused: { label: 'Пауза', color: 'text-yellow-400', bgColor: 'bg-yellow-500/20' },
  limited: { label: 'Ограничен', color: 'text-orange-400', bgColor: 'bg-orange-500/20' },
  suspended: { label: 'Заблокирован', color: 'text-red-400', bgColor: 'bg-red-500/20' },
};

const VISIBILITY_CONFIG: Record<string, { label: string; icon: any; color: string }> = {
  normal: { label: 'Обычная', icon: Eye, color: 'text-slate-400' },
  boosted: { label: 'Буст', icon: Zap, color: 'text-green-400' },
  limited: { label: 'Ограничена', icon: TrendingDown, color: 'text-orange-400' },
  shadow_limited: { label: 'Shadow', icon: EyeOff, color: 'text-red-400' },
};

export default function ProvidersPage() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState({
    status: '',
    tier: '',
    verified: '',
    online: '',
    problemsOnly: false,
  });
  const [showFilters, setShowFilters] = useState(false);
  const [stats, setStats] = useState({
    total: 0,
    active: 0,
    online: 0,
    problems: 0,
  });
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const limit = 20;

  const fetchProviders = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getOrganizations({
        search: search || undefined,
        limit,
        skip: page * limit,
      });
      
      // Transform organizations to providers format — real data only
      const orgs = res.data.organizations || [];
      const transformed: Provider[] = orgs.map((org: any) => ({
        _id: org._id,
        name: org.name,
        type: org.type || 'sto',
        email: org.email,
        phone: org.phone,
        city: org.cityId,
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
        earnings: org.earnings || 0,
        commission: org.commission || 15,
        createdAt: org.createdAt,
      }));
      
      setProviders(transformed);
      setTotal(res.data.total || transformed.length);
      
      // Calculate stats
      setStats({
        total: transformed.length,
        active: transformed.filter(p => p.status === 'active').length,
        online: transformed.filter(p => p.isOnline).length,
        problems: transformed.filter(p => (p.score || 0) < 50).length,
      });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProviders();
  }, [page]);

  const handleSearch = () => {
    setPage(0);
    fetchProviders();
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return 'text-green-400';
    if (score >= 60) return 'text-yellow-400';
    if (score >= 40) return 'text-orange-400';
    return 'text-red-400';
  };

  const filteredProviders = providers.filter(p => {
    if (filters.status && p.status !== filters.status) return false;
    if (filters.tier && p.tier !== filters.tier) return false;
    if (filters.verified === 'yes' && !p.isVerified) return false;
    if (filters.verified === 'no' && p.isVerified) return false;
    if (filters.online === 'yes' && !p.isOnline) return false;
    if (filters.online === 'no' && p.isOnline) return false;
    if (filters.problemsOnly && (p.score || 0) >= 50) return false;
    return true;
  });

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-500/20 rounded-lg">
            <Building2 size={24} className="text-purple-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Provider Control Center</h1>
            <p className="text-slate-400 text-sm">Управление supply рынка</p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-4">
          <p className="text-slate-400 text-sm">Всего мастеров</p>
          <p className="text-3xl font-bold text-white mt-1">{stats.total}</p>
        </div>
        <div className="bg-slate-800 rounded-xl border border-green-500/30 p-4">
          <p className="text-green-400 text-sm flex items-center gap-1">
            <CheckCircle size={14} /> Активных
          </p>
          <p className="text-3xl font-bold text-green-400 mt-1">{stats.active}</p>
        </div>
        <div className="bg-slate-800 rounded-xl border border-blue-500/30 p-4">
          <p className="text-blue-400 text-sm flex items-center gap-1">
            <Zap size={14} /> Онлайн
          </p>
          <p className="text-3xl font-bold text-blue-400 mt-1">{stats.online}</p>
        </div>
        <div className="bg-slate-800 rounded-xl border border-red-500/30 p-4">
          <p className="text-red-400 text-sm flex items-center gap-1">
            <AlertTriangle size={14} /> Проблемные
          </p>
          <p className="text-3xl font-bold text-red-400 mt-1">{stats.problems}</p>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="flex gap-4 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Поиск по имени, email, телефону..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg border ${
            showFilters ? 'bg-primary border-primary text-white' : 'bg-slate-800 border-slate-700 text-slate-300'
          }`}
        >
          <Filter size={18} />
          Фильтры
          <ChevronDown size={16} className={showFilters ? 'rotate-180' : ''} />
        </button>
        <button onClick={handleSearch} className="bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-lg">
          Поиск
        </button>
      </div>

      {/* Expanded Filters */}
      {showFilters && (
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-4 mb-6">
          <div className="grid grid-cols-5 gap-4">
            <div>
              <label className="text-slate-400 text-sm mb-1 block">Статус</label>
              <select
                value={filters.status}
                onChange={(e) => setFilters(f => ({ ...f, status: e.target.value }))}
                className="w-full bg-slate-700 border-0 rounded-lg py-2 px-3 text-white"
              >
                <option value="">Все</option>
                <option value="active">Активен</option>
                <option value="paused">Пауза</option>
                <option value="limited">Ограничен</option>
                <option value="suspended">Заблокирован</option>
              </select>
            </div>
            <div>
              <label className="text-slate-400 text-sm mb-1 block">Уровень</label>
              <select
                value={filters.tier}
                onChange={(e) => setFilters(f => ({ ...f, tier: e.target.value }))}
                className="w-full bg-slate-700 border-0 rounded-lg py-2 px-3 text-white"
              >
                <option value="">Все</option>
                <option value="bronze">Bronze</option>
                <option value="silver">Silver</option>
                <option value="gold">Gold</option>
                <option value="platinum">Platinum</option>
              </select>
            </div>
            <div>
              <label className="text-slate-400 text-sm mb-1 block">Верификация</label>
              <select
                value={filters.verified}
                onChange={(e) => setFilters(f => ({ ...f, verified: e.target.value }))}
                className="w-full bg-slate-700 border-0 rounded-lg py-2 px-3 text-white"
              >
                <option value="">Все</option>
                <option value="yes">Верифицированы</option>
                <option value="no">Не верифицированы</option>
              </select>
            </div>
            <div>
              <label className="text-slate-400 text-sm mb-1 block">Онлайн</label>
              <select
                value={filters.online}
                onChange={(e) => setFilters(f => ({ ...f, online: e.target.value }))}
                className="w-full bg-slate-700 border-0 rounded-lg py-2 px-3 text-white"
              >
                <option value="">Все</option>
                <option value="yes">Онлайн</option>
                <option value="no">Оффлайн</option>
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.problemsOnly}
                  onChange={(e) => setFilters(f => ({ ...f, problemsOnly: e.target.checked }))}
                  className="rounded bg-slate-700 border-slate-600 text-primary focus:ring-primary"
                />
                <span className="text-slate-300">Только проблемные (score &lt; 50)</span>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Actions Bar */}
      {selectedProviders.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-600 rounded-xl px-4 py-3 shadow-xl flex items-center gap-4 z-50">
          <span className="text-white font-medium">{selectedProviders.length} выбрано</span>
          <div className="h-6 w-px bg-slate-600" />
          <button
            onClick={async () => {
              setActionLoading('boost');
              for (const id of selectedProviders) {
                try {
                  await adminAPI.updateProviderVisibility(id, 'boosted');
                } catch {}
              }
              setActionLoading(null);
              setSelectedProviders([]);
              fetchProviders();
            }}
            disabled={actionLoading === 'boost'}
            className="flex items-center gap-2 px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg text-sm"
          >
            <Zap className="w-4 h-4" />
            Boost All
          </button>
          <button
            onClick={async () => {
              setActionLoading('limit');
              for (const id of selectedProviders) {
                try {
                  await adminAPI.updateProviderVisibility(id, 'limited');
                } catch {}
              }
              setActionLoading(null);
              setSelectedProviders([]);
              fetchProviders();
            }}
            disabled={actionLoading === 'limit'}
            className="flex items-center gap-2 px-3 py-1.5 bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 rounded-lg text-sm"
          >
            <EyeOff className="w-4 h-4" />
            Limit All
          </button>
          <button
            onClick={() => navigate(`/notifications?providers=${selectedProviders.join(',')}`)}
            className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 rounded-lg text-sm"
          >
            <Send className="w-4 h-4" />
            Send Push
          </button>
          <button
            onClick={() => setSelectedProviders([])}
            className="text-slate-400 hover:text-white text-sm"
          >
            Отмена
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-700/50">
            <tr>
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={selectedProviders.length === filteredProviders.length && filteredProviders.length > 0}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedProviders(filteredProviders.map(p => p._id));
                    } else {
                      setSelectedProviders([]);
                    }
                  }}
                  className="rounded bg-slate-700 border-slate-600 text-primary"
                />
              </th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Мастер</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Тип</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Рейтинг</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Score</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Tier</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Статус</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Visibility</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Доход</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Загрузка...</td></tr>
            ) : filteredProviders.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-12 text-center">
                  <Building2 size={48} className="text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">Мастера не найдены</p>
                </td>
              </tr>
            ) : (
              filteredProviders.map((provider) => {
                const tier = TIER_CONFIG[provider.tier || 'bronze'];
                const status = STATUS_CONFIG[provider.status || 'active'];
                const visibility = VISIBILITY_CONFIG[provider.visibilityState || 'normal'];
                const VisIcon = visibility.icon;
                
                return (
                  <tr 
                    key={provider._id} 
                    className={`hover:bg-slate-700/30 cursor-pointer ${selectedProviders.includes(provider._id) ? 'bg-slate-700/50' : ''}`}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedProviders.includes(provider._id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedProviders([...selectedProviders, provider._id]);
                          } else {
                            setSelectedProviders(selectedProviders.filter(id => id !== provider._id));
                          }
                        }}
                        className="rounded bg-slate-700 border-slate-600 text-primary"
                      />
                    </td>
                    <td className="px-4 py-3" onClick={() => navigate(`/providers/${provider._id}`)}>
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-pink-600 rounded-lg flex items-center justify-center">
                            <Building2 size={20} className="text-white" />
                          </div>
                          {provider.isOnline && (
                            <span className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-slate-800" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-white font-medium">{provider.name}</p>
                            {provider.isVerified && (
                              <Shield size={14} className="text-blue-400" />
                            )}
                          </div>
                          <p className="text-slate-500 text-xs">{provider.city || 'Киев'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-slate-300 text-sm">{TYPE_LABELS[provider.type] || provider.type}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Star size={14} className="text-yellow-400 fill-yellow-400" />
                        <span className="text-white font-medium">{provider.rating}</span>
                        <span className="text-slate-500 text-xs">({provider.reviewsCount})</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`font-bold ${getScoreColor(provider.score || 0)}`}>
                        {provider.score}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${tier.bgColor} ${tier.color}`}>
                        {tier.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${status.bgColor} ${status.color}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`flex items-center gap-1 text-sm ${visibility.color}`}>
                        <VisIcon size={14} />
                        {visibility.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <span className="text-white font-medium">₴{(provider.earnings || 0).toLocaleString()}</span>
                        <p className="text-slate-500 text-xs">{provider.commission}% комиссия</p>
                      </div>
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            adminAPI.updateProviderVisibility(provider._id, 'boosted').then(() => fetchProviders());
                          }}
                          className="p-1.5 hover:bg-green-500/20 rounded text-green-400"
                          title="Boost"
                        >
                          <Zap size={14} />
                        </button>
                        <button
                          onClick={() => {
                            adminAPI.updateProviderVisibility(provider._id, 'limited').then(() => fetchProviders());
                          }}
                          className="p-1.5 hover:bg-orange-500/20 rounded text-orange-400"
                          title="Limit"
                        >
                          <EyeOff size={14} />
                        </button>
                        <button
                          onClick={() => navigate(`/notifications?provider=${provider._id}`)}
                          className="p-1.5 hover:bg-indigo-500/20 rounded text-indigo-400"
                          title="Send Push"
                        >
                          <Send size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-slate-400 text-sm">
            Показано {page * limit + 1}-{Math.min((page + 1) * limit, total)} из {total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg disabled:opacity-50"
            >
              Назад
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={(page + 1) * limit >= total}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg disabled:opacity-50"
            >
              Вперёд
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

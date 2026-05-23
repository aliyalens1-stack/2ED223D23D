import { useEffect, useState } from 'react';
import { adminAPI } from '../services/api';
import { 
  Building2, Search, MapPin, CheckCircle, XCircle, Star, Ban, Check, 
  ShieldCheck, AlertCircle, Eye, Calendar, DollarSign, TrendingUp,
  Clock, Users, FileText, Settings, BarChart3, Zap, Target
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { ru } from 'date-fns/locale';

interface Organization {
  _id: string;
  name: string;
  slug?: string;
  status: string;
  type?: string;
  description?: string;
  lat?: number;
  lng?: number;
  address?: string;
  locationSource?: 'self' | 'admin' | 'auto';
  isLocationVerified?: boolean;
  ratingAvg?: number;
  reviewsCount?: number;
  isVerified?: boolean;
  specializations?: string[];
  responseTime?: number;
  acceptanceRate?: number;
  completionRate?: number;
  cancellationRate?: number;
  visibilityScore?: number;
  commissionTier?: string;
  isBoosted?: boolean;
  totalBookings?: number;
  totalRevenue?: number;
  createdAt: string;
}

const TYPES = [
  { value: '', label: 'Все типы' },
  { value: 'sto', label: 'СТО' },
  { value: 'private', label: 'Частный мастер' },
  { value: 'mobile', label: 'Выездной' },
  { value: 'detailing', label: 'Детейлинг' },
  { value: 'towing', label: 'Эвакуатор' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'Все статусы' },
  { value: 'active', label: 'Активные' },
  { value: 'pending_verification', label: 'На проверке' },
  { value: 'draft', label: 'Черновики' },
  { value: 'suspended', label: 'Приостановлены' },
];

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500/20 text-green-400 border-green-500/50',
  pending_verification: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
  draft: 'bg-slate-500/20 text-slate-400 border-slate-500/50',
  suspended: 'bg-red-500/20 text-red-400 border-red-500/50',
  blocked: 'bg-red-500/20 text-red-400 border-red-500/50',
};

const COMMISSION_TIERS: Record<string, { label: string; rate: string; color: string }> = {
  new: { label: 'Новичок', rate: '15%', color: 'bg-slate-500/20 text-slate-400' },
  active: { label: 'Активный', rate: '12%', color: 'bg-blue-500/20 text-blue-400' },
  established: { label: 'Проверенный', rate: '10%', color: 'bg-green-500/20 text-green-400' },
  premium: { label: 'Премиум', rate: '8%', color: 'bg-purple-500/20 text-purple-400' },
};

interface ProviderDetailProps {
  org: Organization;
  onClose: () => void;
  onUpdate: () => void;
}

const ProviderDetail = ({ org, onClose, onUpdate }: ProviderDetailProps) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'performance' | 'services' | 'bookings' | 'settings'>('overview');
  const [locationForm, setLocationForm] = useState({ lat: org.lat?.toString() || '', lng: org.lng?.toString() || '', address: org.address || '' });
  const [commissionTier, setCommissionTier] = useState(org.commissionTier || 'new');

  const handleSaveLocation = async () => {
    try {
      await adminAPI.setOrgLocation(org._id, {
        lat: parseFloat(locationForm.lat),
        lng: parseFloat(locationForm.lng),
        address: locationForm.address,
      });
      onUpdate();
    } catch (err) {
      console.error(err);
    }
  };

  const handleVerifyLocation = async () => {
    try {
      await adminAPI.verifyLocation(org._id);
      onUpdate();
    } catch (err) {
      console.error(err);
    }
  };

  const handleToggleStatus = async () => {
    try {
      if (org.status === 'active') {
        await adminAPI.disableOrg(org._id);
      } else {
        await adminAPI.enableOrg(org._id);
      }
      onUpdate();
      onClose();
    } catch (err) {
      console.error(err);
    }
  };

  const handleToggleBoost = async () => {
    try {
      await adminAPI.setOrgBoost(org._id, !org.isBoosted);
      onUpdate();
    } catch (err) {
      console.error(err);
    }
  };

  const tier = COMMISSION_TIERS[org.commissionTier || 'new'];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-slate-700 rounded-xl flex items-center justify-center">
                <Building2 size={28} className="text-slate-300" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-white">{org.name}</h2>
                  {org.isVerified && <CheckCircle size={18} className="text-green-400" />}
                  {org.isBoosted && <Zap size={18} className="text-yellow-400" />}
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs border ${STATUS_COLORS[org.status]}`}>
                    {STATUS_OPTIONS.find(s => s.value === org.status)?.label || org.status}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-xs ${tier.color}`}>
                    {tier.label} ({tier.rate})
                  </span>
                  {org.ratingAvg && (
                    <span className="flex items-center gap-1 text-yellow-400 text-sm">
                      <Star size={14} className="fill-yellow-400" />
                      {org.ratingAvg.toFixed(1)} ({org.reviewsCount})
                    </span>
                  )}
                </div>
              </div>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-lg text-slate-400">
              <XCircle size={20} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-700">
          {['overview', 'performance', 'services', 'bookings', 'settings'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as any)}
              className={`px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab ? 'text-primary border-b-2 border-primary' : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab === 'overview' && 'Обзор'}
              {tab === 'performance' && 'Показатели'}
              {tab === 'services' && 'Услуги'}
              {tab === 'bookings' && 'Бронирования'}
              {tab === 'settings' && 'Настройки'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {activeTab === 'overview' && (
            <div className="grid grid-cols-2 gap-6">
              {/* Stats */}
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-700/50 rounded-lg p-4">
                    <p className="text-slate-400 text-xs">Время ответа</p>
                    <p className="text-2xl font-bold text-white">{org.responseTime || 0} мин</p>
                  </div>
                  <div className="bg-slate-700/50 rounded-lg p-4">
                    <p className="text-slate-400 text-xs">Принятие заявок</p>
                    <p className="text-2xl font-bold text-white">{org.acceptanceRate || 0}%</p>
                  </div>
                  <div className="bg-slate-700/50 rounded-lg p-4">
                    <p className="text-slate-400 text-xs">Завершение</p>
                    <p className="text-2xl font-bold text-white">{org.completionRate || 0}%</p>
                  </div>
                  <div className="bg-slate-700/50 rounded-lg p-4">
                    <p className="text-slate-400 text-xs">Отмены</p>
                    <p className="text-2xl font-bold text-red-400">{org.cancellationRate || 0}%</p>
                  </div>
                </div>

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <BarChart3 size={16} /> Статистика
                  </h3>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Всего бронирований</span>
                      <span className="text-white font-medium">{org.totalBookings || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Общий доход</span>
                      <span className="text-white font-medium">₴{(org.totalRevenue || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Visibility Score</span>
                      <span className="text-white font-medium">{org.visibilityScore || 0}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Location */}
              <div className="space-y-4">
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <MapPin size={16} /> Локация
                    {org.isLocationVerified && <CheckCircle size={14} className="text-green-400" />}
                  </h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-slate-400 text-xs">Широта</label>
                      <input
                        type="text"
                        value={locationForm.lat}
                        onChange={(e) => setLocationForm(f => ({ ...f, lat: e.target.value }))}
                        className="w-full mt-1 bg-slate-600 border border-slate-500 rounded px-3 py-2 text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-slate-400 text-xs">Долгота</label>
                      <input
                        type="text"
                        value={locationForm.lng}
                        onChange={(e) => setLocationForm(f => ({ ...f, lng: e.target.value }))}
                        className="w-full mt-1 bg-slate-600 border border-slate-500 rounded px-3 py-2 text-white text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-slate-400 text-xs">Адрес</label>
                      <input
                        type="text"
                        value={locationForm.address}
                        onChange={(e) => setLocationForm(f => ({ ...f, address: e.target.value }))}
                        className="w-full mt-1 bg-slate-600 border border-slate-500 rounded px-3 py-2 text-white text-sm"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={handleSaveLocation}
                        className="px-3 py-2 bg-primary hover:bg-primary/90 text-white rounded text-sm"
                      >
                        Сохранить
                      </button>
                      {!org.isLocationVerified && (
                        <button
                          onClick={handleVerifyLocation}
                          className="px-3 py-2 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded text-sm"
                        >
                          Подтвердить
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3">Специализации</h3>
                  <div className="flex flex-wrap gap-2">
                    {org.specializations?.map((spec, idx) => (
                      <span key={idx} className="px-2 py-1 bg-slate-600 text-slate-300 rounded text-sm">
                        {spec}
                      </span>
                    )) || <span className="text-slate-500">Не указаны</span>}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'performance' && (
            <div className="space-y-6">
              <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4">
                <h3 className="text-orange-400 font-medium mb-3 flex items-center gap-2">
                  <Target size={16} /> Performance & Pressure
                </h3>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-slate-400 text-sm">Заявок получено</p>
                    <p className="text-2xl font-bold text-white">0</p>
                  </div>
                  <div>
                    <p className="text-slate-400 text-sm">Заявок пропущено</p>
                    <p className="text-2xl font-bold text-red-400">0</p>
                  </div>
                  <div>
                    <p className="text-slate-400 text-sm">Потерянный доход</p>
                    <p className="text-2xl font-bold text-red-400">₴0</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3">Качество ответов</h3>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 text-sm">Скорость ответа</span>
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-2 bg-slate-600 rounded-full overflow-hidden">
                          <div className="h-full bg-green-500 rounded-full" style={{ width: '80%' }} />
                        </div>
                        <span className="text-white text-sm">80%</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 text-sm">Конверсия ответов</span>
                      <div className="flex items-center gap-2">
                        <div className="w-24 h-2 bg-slate-600 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: '45%' }} />
                        </div>
                        <span className="text-white text-sm">45%</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3">Что улучшить</h3>
                  <ul className="space-y-2 text-sm">
                    <li className="flex items-center gap-2 text-yellow-400">
                      <AlertCircle size={14} />
                      Увеличить скорость ответа до 5 мин
                    </li>
                    <li className="flex items-center gap-2 text-slate-400">
                      <CheckCircle size={14} className="text-green-400" />
                      Рейтинг в норме
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'services' && (
            <OrgServicesTab orgId={org._id} />
          )}

          {activeTab === 'bookings' && (
            <OrgBookingsTab orgId={org._id} />
          )}

          {activeTab === 'settings' && (
            <div className="space-y-6">
              <div className="bg-slate-700/50 rounded-lg p-4">
                <h3 className="text-white font-medium mb-3">Комиссия</h3>
                <div className="grid grid-cols-4 gap-2">
                  {Object.entries(COMMISSION_TIERS).map(([key, val]) => (
                    <button
                      key={key}
                      onClick={() => setCommissionTier(key)}
                      className={`p-3 rounded-lg border transition-colors ${
                        commissionTier === key 
                          ? 'border-primary bg-primary/10' 
                          : 'border-slate-600 hover:border-slate-500'
                      }`}
                    >
                      <p className="text-white font-medium">{val.label}</p>
                      <p className="text-slate-400 text-sm">{val.rate}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-slate-700/50 rounded-lg p-4">
                <h3 className="text-white font-medium mb-3">Boost</h3>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-slate-300">Повышенная видимость</p>
                    <p className="text-slate-500 text-sm">Мастер будет показываться выше в результатах</p>
                  </div>
                  <button
                    onClick={handleToggleBoost}
                    className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                      org.isBoosted
                        ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
                        : 'bg-slate-600 text-slate-300 hover:bg-slate-500'
                    }`}
                  >
                    {org.isBoosted ? 'Отключить Boost' : 'Включить Boost'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700 flex items-center justify-between">
          <div className="flex gap-2">
            <button
              onClick={handleToggleStatus}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium ${
                org.status === 'active'
                  ? 'bg-red-500/20 hover:bg-red-500/30 text-red-400'
                  : 'bg-green-500/20 hover:bg-green-500/30 text-green-400'
              }`}
            >
              {org.status === 'active' ? <Ban size={16} /> : <Check size={16} />}
              {org.status === 'active' ? 'Приостановить' : 'Активировать'}
            </button>
            {!org.isVerified && (
              <button className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg">
                <ShieldCheck size={16} /> Верифицировать
              </button>
            )}
          </div>
          <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg">
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};

export default function OrganizationsPage() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(0);
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const limit = 20;

  const fetchOrgs = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getOrganizations({
        status: status || undefined,
        type: type || undefined,
        search: search || undefined,
        limit,
        skip: page * limit,
      });
      setOrgs(res.data.organizations || []);
      setTotal(res.data.total || 0);
    } catch (err) {
      console.error(err);
      setOrgs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrgs();
  }, [status, type, page]);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-green-500/20 rounded-lg">
            <Building2 size={24} className="text-green-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Supply Management</h1>
            <p className="text-slate-400 text-sm">Управление мастерами и СТО</p>
          </div>
        </div>
        <span className="text-slate-400">Всего: {total}</span>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <div className="flex-1 min-w-[200px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchOrgs()}
            placeholder="Поиск по названию..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-10 pr-4 py-2 text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(0); }}
          className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => { setType(e.target.value); setPage(0); }}
          className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm"
        >
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <button
          onClick={fetchOrgs}
          className="bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-lg transition-colors"
        >
          Поиск
        </button>
      </div>

      {/* Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-700/50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Мастер</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Рейтинг</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Ответ</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Конверсия</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Комиссия</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Статус</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-slate-300">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Загрузка...</td></tr>
            ) : orgs.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center">
                  <Building2 size={48} className="text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">Мастера не найдены</p>
                </td>
              </tr>
            ) : (
              orgs.map((org) => {
                const tier = COMMISSION_TIERS[org.commissionTier || 'new'];
                return (
                  <tr 
                    key={org._id} 
                    className="hover:bg-slate-700/30 cursor-pointer"
                    onClick={() => setSelectedOrg(org)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-slate-700 rounded-lg flex items-center justify-center">
                          <Building2 size={20} className="text-slate-400" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-white font-medium">{org.name}</p>
                            {org.isVerified && <CheckCircle size={14} className="text-green-400" />}
                            {org.isBoosted && <Zap size={14} className="text-yellow-400" />}
                          </div>
                          <p className="text-slate-500 text-xs">{org.address || 'Адрес не указан'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {org.ratingAvg ? (
                        <div className="flex items-center gap-1">
                          <Star size={14} className="text-yellow-400 fill-yellow-400" />
                          <span className="text-white">{org.ratingAvg.toFixed(1)}</span>
                          <span className="text-slate-500 text-sm">({org.reviewsCount})</span>
                        </div>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-sm ${(org.responseTime || 0) <= 5 ? 'text-green-400' : (org.responseTime || 0) <= 15 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {org.responseTime || 0} мин
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-white">{org.completionRate || 0}%</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs ${tier.color}`}>
                        {tier.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs border ${STATUS_COLORS[org.status]}`}>
                        {STATUS_OPTIONS.find(s => s.value === org.status)?.label || org.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button 
                        className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white"
                        onClick={(e) => { e.stopPropagation(); setSelectedOrg(org); }}
                      >
                        <Eye size={16} />
                      </button>
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

      {/* Provider Detail Modal */}
      {selectedOrg && (
        <ProviderDetail
          org={selectedOrg}
          onClose={() => setSelectedOrg(null)}
          onUpdate={fetchOrgs}
        />
      )}
    </div>
  );
}


// Org Services Tab - loads real services for this organization
function OrgServicesTab({ orgId }: { orgId: string }) {
  const [services, setServices] = useState<any[]>([]);
  const [allServices, setAllServices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [orgSvcRes, allSvcRes] = await Promise.all([
          adminAPI.getOrgServices(orgId).catch(() => ({ data: [] })),
          adminAPI.getServicesList().catch(() => ({ data: [] })),
        ]);
        setServices(orgSvcRes.data || []);
        setAllServices(allSvcRes.data || []);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    };
    load();
  }, [orgId]);

  if (loading) return <div className="text-center py-8 text-slate-400">Загрузка услуг...</div>;

  return (
    <div className="space-y-4" data-testid="org-services-tab">
      <div className="flex items-center justify-between">
        <h3 className="text-white font-medium">Услуги организации ({services.length})</h3>
      </div>
      {services.length === 0 ? (
        <div className="text-center py-8">
          <Settings size={36} className="text-slate-600 mx-auto mb-2" />
          <p className="text-slate-400">У организации пока нет добавленных услуг</p>
          <p className="text-slate-500 text-sm mt-1">Доступно {allServices.length} услуг на платформе</p>
        </div>
      ) : (
        <div className="space-y-2">
          {services.map((svc: any) => {
            const platformService = allServices.find((s: any) => s._id === svc.serviceId);
            return (
              <div key={svc._id} className="bg-slate-700/50 rounded-lg p-4 flex items-center justify-between" data-testid={`org-svc-${svc._id}`}>
                <div>
                  <p className="text-white font-medium">{platformService?.name || svc.serviceId}</p>
                  <p className="text-slate-500 text-xs">{svc.isActive ? 'Активна' : 'Неактивна'}</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-white font-medium">{svc.customPrice ? `₴${svc.customPrice}` : 'Базовая'}</p>
                    <p className="text-slate-500 text-xs">{svc.customDuration ? `${svc.customDuration} мин` : 'Станд.'}</p>
                  </div>
                  <span className={`w-2 h-2 rounded-full ${svc.isActive ? 'bg-green-400' : 'bg-slate-500'}`} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Org Bookings Tab - loads real bookings for this organization
function OrgBookingsTab({ orgId }: { orgId: string }) {
  const [bookings, setBookings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await adminAPI.getBookings({ limit: 20 });
        const orgBookings = (res.data.bookings || []).filter(
          (b: any) => b.organizationId === orgId || b.providerId === orgId
        );
        setBookings(orgBookings);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    };
    load();
  }, [orgId]);

  if (loading) return <div className="text-center py-8 text-slate-400">Загрузка бронирований...</div>;

  const statusColors: Record<string, string> = {
    completed: 'bg-green-500/20 text-green-400',
    confirmed: 'bg-blue-500/20 text-blue-400',
    pending: 'bg-yellow-500/20 text-yellow-400',
    cancelled: 'bg-red-500/20 text-red-400',
    in_progress: 'bg-purple-500/20 text-purple-400',
  };

  return (
    <div className="space-y-4" data-testid="org-bookings-tab">
      <h3 className="text-white font-medium">Бронирования ({bookings.length})</h3>
      {bookings.length === 0 ? (
        <div className="text-center py-8">
          <Calendar size={36} className="text-slate-600 mx-auto mb-2" />
          <p className="text-slate-400">Нет бронирований</p>
        </div>
      ) : (
        <div className="space-y-2">
          {bookings.map((b: any) => (
            <div key={b._id} className="bg-slate-700/50 rounded-lg p-4 flex items-center justify-between" data-testid={`org-booking-${b._id}`}>
              <div>
                <p className="text-white font-medium">{b.serviceType || 'Услуга'}</p>
                <p className="text-slate-500 text-xs">{b.createdAt ? format(new Date(b.createdAt), 'dd.MM.yyyy HH:mm', { locale: ru }) : '-'}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-white">₴{b.totalPrice || 0}</span>
                <span className={`px-2 py-1 rounded text-xs ${statusColors[b.status] || 'bg-slate-600 text-slate-300'}`}>
                  {b.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

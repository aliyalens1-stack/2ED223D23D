import { useEffect, useState } from 'react';
import { adminAPI } from '../services/api';
import { 
  FileText, Clock, CheckCircle, XCircle, Send, User, MapPin,
  AlertCircle, Eye, ChevronRight, Timer, Filter, Building2,
  MessageSquare, Zap, RefreshCw, Plus, Phone, Car, Search, ShieldCheck, Star
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { ru } from 'date-fns/locale';

interface Quote {
  _id: string;
  status: string;
  description?: string;
  urgency?: 'normal' | 'urgent' | 'emergency';
  requestedServiceId?: { name?: string; slug?: string };
  customerId?: { _id: string; firstName?: string; lastName?: string; email?: string; phone?: string };
  vehicleId?: { make?: string; model?: string; year?: number; licensePlate?: string };
  city?: { name?: string; nameLocal?: string };
  location?: { coordinates?: number[] };
  address?: string;
  responsesCount?: number;
  providersNotified?: number;
  bestMatch?: { organizationId?: { name?: string }; price?: number; responseTime?: number };
  operatorId?: { firstName?: string; email?: string };
  isOperatorAssisted?: boolean;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface QuoteResponse {
  _id: string;
  providerId?: { _id: string; name?: string };
  branchId?: { name?: string; address?: string };
  price: number;
  message?: string;
  responseTime?: number;
  isSelected?: boolean;
  createdAt: string;
}

const STATUSES = [
  { value: '', label: 'Все статусы' },
  { value: 'new', label: 'Новые' },
  { value: 'distributed', label: 'Распределены' },
  { value: 'awaiting_responses', label: 'Ожидают ответов' },
  { value: 'responded', label: 'Есть ответы' },
  { value: 'selected', label: 'Выбран мастер' },
  { value: 'converted', label: 'Конвертированы' },
  { value: 'expired', label: 'Истекли' },
  { value: 'cancelled', label: 'Отменены' },
];

const STATUS_COLORS: Record<string, string> = {
  new: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
  distributed: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/50',
  awaiting_responses: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
  responded: 'bg-green-500/20 text-green-400 border-green-500/50',
  selected: 'bg-purple-500/20 text-purple-400 border-purple-500/50',
  converted: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50',
  expired: 'bg-slate-500/20 text-slate-400 border-slate-500/50',
  cancelled: 'bg-red-500/20 text-red-400 border-red-500/50',
};

const URGENCY_COLORS: Record<string, string> = {
  normal: 'text-slate-400',
  urgent: 'text-orange-400',
  emergency: 'text-red-400',
};

interface QuoteDetailProps {
  quote: Quote;
  onClose: () => void;
  onUpdate: () => void;
}

const QuoteDetail = ({ quote, onClose, onUpdate }: QuoteDetailProps) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'responses' | 'distribution' | 'timeline'>('overview');
  const [responses, setResponses] = useState<QuoteResponse[]>([]);
  const [loadingResponses, setLoadingResponses] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (activeTab === 'responses') {
      loadResponses();
    }
  }, [activeTab]);

  const loadResponses = async () => {
    setLoadingResponses(true);
    try {
      const res = await adminAPI.getQuoteResponses(quote._id);
      setResponses(res.data.responses || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingResponses(false);
    }
  };

  const handleDistribute = async () => {
    // Handled by the distribution tab UI
    setActiveTab('distribution');
  };

  const handleDistributeToProviders = async (providerIds: string[]) => {
    try {
      await adminAPI.distributeQuote(quote._id, providerIds);
      onUpdate();
    } catch (err) {
      console.error(err);
    }
  };

  const handleClose = async (reason: string) => {
    try {
      await adminAPI.closeQuote(quote._id, { reason });
      onUpdate();
      onClose();
    } catch (err) {
      console.error(err);
    }
  };

  const handleConvert = async (responseId: string) => {
    try {
      const response = responses.find(r => r._id === responseId);
      if (response) {
        await adminAPI.closeQuote(quote._id, {
          organizationId: response.providerId?._id,
          price: response.price,
          notes: 'Converted by operator',
        });
        onUpdate();
        onClose();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const slaTimeLeft = quote.expiresAt 
    ? new Date(quote.expiresAt).getTime() - Date.now() 
    : null;
  const isOverdue = slaTimeLeft !== null && slaTimeLeft < 0;
  const isUrgent = slaTimeLeft !== null && slaTimeLeft < 600000; // 10 min

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${quote.urgency === 'emergency' ? 'bg-red-500/20' : quote.urgency === 'urgent' ? 'bg-orange-500/20' : 'bg-blue-500/20'}`}>
                <FileText size={20} className={URGENCY_COLORS[quote.urgency || 'normal']} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-white font-semibold">Заявка #{quote._id.slice(-8)}</h2>
                  {quote.isOperatorAssisted && (
                    <span className="px-2 py-0.5 bg-purple-500/20 text-purple-400 text-xs rounded">Operator Mode</span>
                  )}
                </div>
                <p className="text-slate-400 text-sm">
                  {quote.requestedServiceId?.name || 'Не указана услуга'} • 
                  Создана {format(new Date(quote.createdAt), 'dd.MM.yyyy HH:mm')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {quote.expiresAt && (
                <div className={`flex items-center gap-1 px-3 py-1.5 rounded-lg ${isOverdue ? 'bg-red-500/20 text-red-400' : isUrgent ? 'bg-orange-500/20 text-orange-400' : 'bg-slate-700 text-slate-300'}`}>
                  <Timer size={16} />
                  <span className="text-sm font-medium">
                    {isOverdue ? 'Просрочена' : formatDistanceToNow(new Date(quote.expiresAt), { locale: ru })}
                  </span>
                </div>
              )}
              <span className={`px-3 py-1.5 rounded-full text-sm border ${STATUS_COLORS[quote.status]}`}>
                {STATUSES.find(s => s.value === quote.status)?.label || quote.status}
              </span>
              <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-lg text-slate-400">
                <XCircle size={20} />
              </button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-700">
          {['overview', 'responses', 'distribution', 'timeline'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as any)}
              className={`px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab ? 'text-primary border-b-2 border-primary' : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab === 'overview' && 'Обзор'}
              {tab === 'responses' && `Ответы (${quote.responsesCount || 0})`}
              {tab === 'distribution' && 'Распределение'}
              {tab === 'timeline' && 'История'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {activeTab === 'overview' && (
            <div className="grid grid-cols-2 gap-6">
              {/* Left - Customer & Vehicle */}
              <div className="space-y-4">
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <User size={16} /> Клиент
                  </h3>
                  <div className="space-y-2">
                    <p className="text-white">{quote.customerId?.firstName} {quote.customerId?.lastName}</p>
                    <p className="text-slate-400 text-sm">{quote.customerId?.email}</p>
                    {quote.customerId?.phone && (
                      <p className="text-slate-400 text-sm flex items-center gap-1">
                        <Phone size={12} /> {quote.customerId.phone}
                      </p>
                    )}
                  </div>
                </div>

                {quote.vehicleId && (
                  <div className="bg-slate-700/50 rounded-lg p-4">
                    <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                      <Car size={16} /> Автомобиль
                    </h3>
                    <div className="space-y-1">
                      <p className="text-white">
                        {quote.vehicleId.make} {quote.vehicleId.model} {quote.vehicleId.year}
                      </p>
                      {quote.vehicleId.licensePlate && (
                        <p className="text-slate-400 text-sm">{quote.vehicleId.licensePlate}</p>
                      )}
                    </div>
                  </div>
                )}

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <FileText size={16} /> Описание
                  </h3>
                  <p className="text-slate-300 text-sm whitespace-pre-wrap">
                    {quote.description || 'Описание не указано'}
                  </p>
                </div>
              </div>

              {/* Right - Location & Stats */}
              <div className="space-y-4">
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <MapPin size={16} /> Локация
                  </h3>
                  <p className="text-white">{quote.city?.nameLocal || quote.city?.name || 'Не указан'}</p>
                  {quote.address && <p className="text-slate-400 text-sm mt-1">{quote.address}</p>}
                  {quote.location?.coordinates && (
                    <p className="text-slate-500 text-xs mt-2">
                      {quote.location.coordinates[1].toFixed(4)}, {quote.location.coordinates[0].toFixed(4)}
                    </p>
                  )}
                </div>

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <Zap size={16} /> Статистика
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-slate-400 text-xs">Уведомлено мастеров</p>
                      <p className="text-xl font-bold text-white">{quote.providersNotified || 0}</p>
                    </div>
                    <div>
                      <p className="text-slate-400 text-xs">Ответов</p>
                      <p className="text-xl font-bold text-green-400">{quote.responsesCount || 0}</p>
                    </div>
                  </div>
                </div>

                {quote.bestMatch && (
                  <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                    <h3 className="text-green-400 font-medium mb-2 flex items-center gap-2">
                      <CheckCircle size={16} /> Лучшее предложение
                    </h3>
                    <p className="text-white font-medium">{quote.bestMatch.organizationId?.name}</p>
                    <p className="text-2xl font-bold text-white mt-1">₴{quote.bestMatch.price?.toLocaleString()}</p>
                    {quote.bestMatch.responseTime && (
                      <p className="text-slate-400 text-sm mt-1">
                        Ответ за {Math.round(quote.bestMatch.responseTime / 60)} мин
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'responses' && (
            <div className="space-y-3">
              {loadingResponses ? (
                <div className="text-center py-8">
                  <RefreshCw size={24} className="text-slate-400 animate-spin mx-auto" />
                </div>
              ) : responses.length === 0 ? (
                <div className="text-center py-12">
                  <MessageSquare size={48} className="text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">Пока нет ответов от мастеров</p>
                </div>
              ) : (
                responses.map((resp, idx) => (
                  <div 
                    key={resp._id} 
                    className={`p-4 rounded-lg border ${resp.isSelected ? 'bg-green-500/10 border-green-500/50' : 'bg-slate-700/50 border-slate-600'}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 bg-slate-600 rounded-full flex items-center justify-center">
                          <Building2 size={20} className="text-slate-300" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-white font-medium">{resp.providerId?.name || 'Мастер'}</p>
                            {resp.isSelected && (
                              <span className="px-2 py-0.5 bg-green-500/20 text-green-400 text-xs rounded">Выбран</span>
                            )}
                            {idx === 0 && !resp.isSelected && (
                              <span className="px-2 py-0.5 bg-blue-500/20 text-blue-400 text-xs rounded">Лучшая цена</span>
                            )}
                          </div>
                          {resp.branchId?.address && (
                            <p className="text-slate-400 text-sm">{resp.branchId.address}</p>
                          )}
                          {resp.message && (
                            <p className="text-slate-300 text-sm mt-2">{resp.message}</p>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-2xl font-bold text-white">₴{resp.price.toLocaleString()}</p>
                        <p className="text-slate-400 text-xs">
                          {format(new Date(resp.createdAt), 'HH:mm dd.MM')}
                        </p>
                        {!resp.isSelected && quote.status !== 'converted' && (
                          <button
                            onClick={() => handleConvert(resp._id)}
                            className="mt-2 px-3 py-1 bg-primary hover:bg-primary/90 text-white text-sm rounded"
                          >
                            Выбрать
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'distribution' && (
            <QuoteDistributionPanel quoteId={quote._id} onDistribute={handleDistributeToProviders} />
          )}

          {activeTab === 'timeline' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 pb-4 border-b border-slate-700">
                <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                  <Plus size={16} className="text-blue-400" />
                </div>
                <div>
                  <p className="text-white">Заявка создана</p>
                  <p className="text-slate-400 text-sm">{format(new Date(quote.createdAt), 'dd.MM.yyyy HH:mm')}</p>
                </div>
              </div>
              {quote.providersNotified && quote.providersNotified > 0 && (
                <div className="flex items-start gap-3 pb-4 border-b border-slate-700">
                  <div className="w-8 h-8 rounded-full bg-cyan-500/20 flex items-center justify-center">
                    <Send size={16} className="text-cyan-400" />
                  </div>
                  <div>
                    <p className="text-white">Распределена {quote.providersNotified} мастерам</p>
                  </div>
                </div>
              )}
              {quote.responsesCount && quote.responsesCount > 0 && (
                <div className="flex items-start gap-3 pb-4 border-b border-slate-700">
                  <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                    <MessageSquare size={16} className="text-green-400" />
                  </div>
                  <div>
                    <p className="text-white">Получено {quote.responsesCount} ответов</p>
                  </div>
                </div>
              )}
              {quote.status === 'converted' && (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <CheckCircle size={16} className="text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-white">Конвертирована в бронирование</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-slate-700 flex items-center justify-between">
          <div className="flex gap-2">
            <button
              onClick={handleDistribute}
              className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg"
            >
              <Send size={16} /> Распределить
            </button>
            <button className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg">
              <AlertCircle size={16} /> Эскалировать
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleClose('expired')}
              className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg"
            >
              Закрыть заявку
            </button>
            <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg">
              Отмена
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default function QuotesPage() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [noResponse, setNoResponse] = useState(false);
  const [urgent, setUrgent] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedQuote, setSelectedQuote] = useState<Quote | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const limit = 20;

  // Stats
  const [stats, setStats] = useState({ new: 0, noResponse: 0, responded: 0 });

  const fetchQuotes = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    
    try {
      const res = await adminAPI.getQuotes({
        status: status || undefined,
        noResponse: noResponse || undefined,
        urgent: urgent || undefined,
        limit,
        page,
      });
      setQuotes(res.data.quotes || []);
      setTotal(res.data.total || 0);
      
      // Mock stats
      setStats({
        new: res.data.quotes?.filter((q: Quote) => q.status === 'new').length || 0,
        noResponse: res.data.quotes?.filter((q: Quote) => (q.responsesCount || 0) === 0 && q.status !== 'new').length || 0,
        responded: res.data.quotes?.filter((q: Quote) => (q.responsesCount || 0) > 0).length || 0,
      });
    } catch (err) {
      console.error(err);
      setQuotes([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchQuotes();
  }, [status, noResponse, urgent, page]);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-orange-500/20 rounded-lg">
            <FileText size={24} className="text-orange-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Центр заявок</h1>
            <p className="text-slate-400 text-sm">Операторный режим управления спросом</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-500/20 rounded-lg">
            <span className="text-blue-400 font-medium">{stats.new}</span>
            <span className="text-slate-400 text-sm">новых</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/20 rounded-lg">
            <span className="text-red-400 font-medium">{stats.noResponse}</span>
            <span className="text-slate-400 text-sm">без ответа</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/20 rounded-lg">
            <span className="text-green-400 font-medium">{stats.responded}</span>
            <span className="text-slate-400 text-sm">с ответами</span>
          </div>
          <button
            onClick={() => fetchQuotes(true)}
            disabled={refreshing}
            className="p-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-white disabled:opacity-50"
          >
            <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm"
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg cursor-pointer">
          <input
            type="checkbox"
            checked={noResponse}
            onChange={(e) => { setNoResponse(e.target.checked); setPage(1); }}
            className="rounded"
          />
          <span className="text-white text-sm">Без ответов</span>
        </label>
        <label className="flex items-center gap-2 px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg cursor-pointer">
          <input
            type="checkbox"
            checked={urgent}
            onChange={(e) => { setUrgent(e.target.checked); setPage(1); }}
            className="rounded"
          />
          <span className="text-white text-sm">Срочные</span>
        </label>
      </div>

      {/* Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-700/50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Заявка</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Клиент</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Услуга</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Локация</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Мастера</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">SLA</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Статус</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-slate-300">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Загрузка...</td></tr>
            ) : quotes.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <FileText size={48} className="text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">Заявок не найдено</p>
                </td>
              </tr>
            ) : (
              quotes.map((q) => {
                const slaTimeLeft = q.expiresAt ? new Date(q.expiresAt).getTime() - Date.now() : null;
                const isOverdue = slaTimeLeft !== null && slaTimeLeft < 0;
                const isUrgentSla = slaTimeLeft !== null && slaTimeLeft < 600000;
                
                return (
                  <tr 
                    key={q._id} 
                    className="hover:bg-slate-700/30 cursor-pointer" 
                    onClick={() => setSelectedQuote(q)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${
                          q.urgency === 'emergency' ? 'bg-red-500' :
                          q.urgency === 'urgent' ? 'bg-orange-500' : 'bg-slate-500'
                        }`} />
                        <div>
                          <p className="text-white text-sm font-mono">#{q._id.slice(-8)}</p>
                          <p className="text-slate-500 text-xs">
                            {formatDistanceToNow(new Date(q.createdAt), { addSuffix: true, locale: ru })}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <User size={14} className="text-slate-400" />
                        <span className="text-slate-300 text-sm">
                          {q.customerId?.firstName || q.customerId?.email?.split('@')[0] || '—'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-white text-sm">{q.requestedServiceId?.name || '—'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 text-slate-400">
                        <MapPin size={14} />
                        <span className="text-sm">{q.city?.nameLocal || q.city?.name || '—'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-400 text-sm">{q.providersNotified || 0} уведом.</span>
                        <span className={`font-medium ${(q.responsesCount || 0) > 0 ? 'text-green-400' : 'text-slate-500'}`}>
                          {q.responsesCount || 0} отв.
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {q.expiresAt ? (
                        <div className={`flex items-center gap-1 ${isOverdue ? 'text-red-400' : isUrgentSla ? 'text-orange-400' : 'text-slate-400'}`}>
                          <Timer size={14} />
                          <span className="text-sm">
                            {isOverdue ? 'Просрочена' : formatDistanceToNow(new Date(q.expiresAt), { locale: ru })}
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-500 text-sm">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs border ${STATUS_COLORS[q.status]}`}>
                        {STATUSES.find(s => s.value === q.status)?.label || q.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button 
                          className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white"
                          onClick={(e) => { e.stopPropagation(); setSelectedQuote(q); }}
                        >
                          <Eye size={16} />
                        </button>
                        <button 
                          className="p-2 hover:bg-primary/20 rounded-lg text-primary"
                          onClick={(e) => { e.stopPropagation(); /* distribute */ }}
                        >
                          <Send size={16} />
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
            Показано {(page - 1) * limit + 1}-{Math.min(page * limit, total)} из {total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg disabled:opacity-50"
            >
              Назад
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page * limit >= total}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg disabled:opacity-50"
            >
              Вперёд
            </button>
          </div>
        </div>
      )}

      {/* Quote Detail Modal */}
      {selectedQuote && (
        <QuoteDetail
          quote={selectedQuote}
          onClose={() => setSelectedQuote(null)}
          onUpdate={fetchQuotes}
        />
      )}
    </div>
  );
}


// Distribution Panel — real provider selection for manual quote distribution
function QuoteDistributionPanel({ quoteId, onDistribute }: { quoteId: string; onDistribute: (ids: string[]) => void }) {
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [distributing, setDistributing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await adminAPI.getOrganizations({ limit: 50 });
        const orgs = (res.data.organizations || []).filter((o: any) => o.status === 'active');
        setProviders(orgs);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    };
    load();
  }, []);

  const toggle = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === filteredProviders.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredProviders.map(p => p._id)));
    }
  };

  const handleSend = async () => {
    if (selectedIds.size === 0) return;
    setDistributing(true);
    try {
      await onDistribute(Array.from(selectedIds));
    } finally {
      setDistributing(false);
    }
  };

  const filteredProviders = providers.filter(p => {
    if (!searchQuery) return true;
    return p.name?.toLowerCase().includes(searchQuery.toLowerCase());
  });

  if (loading) return <div className="text-center py-8 text-slate-400">Загрузка мастеров...</div>;

  return (
    <div className="space-y-4" data-testid="quote-distribution-panel">
      {/* Search + select all */}
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search size={16} className="absolute left-3 top-3 text-slate-500" />
          <input
            type="text"
            placeholder="Поиск мастера..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-10 pr-4 py-2 text-white text-sm"
            data-testid="distribution-search"
          />
        </div>
        <button onClick={selectAll} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-sm text-slate-300 rounded-lg">
          {selectedIds.size === filteredProviders.length ? 'Снять все' : 'Выбрать все'}
        </button>
      </div>

      {/* Provider list */}
      <div className="max-h-80 overflow-y-auto space-y-2">
        {filteredProviders.map((p) => {
          const isSelected = selectedIds.has(p._id);
          return (
            <div
              key={p._id}
              onClick={() => toggle(p._id)}
              data-testid={`dist-provider-${p._id}`}
              className={`p-3 rounded-lg border cursor-pointer transition-all flex items-center gap-3 ${
                isSelected ? 'border-primary bg-primary/10' : 'border-slate-600 bg-slate-700/50 hover:border-slate-500'
              }`}
            >
              <div className={`w-5 h-5 rounded border flex items-center justify-center ${isSelected ? 'bg-primary border-primary' : 'border-slate-500'}`}>
                {isSelected && <CheckCircle size={14} className="text-white" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-white font-medium">{p.name}</p>
                  {p.isVerified && <ShieldCheck size={14} className="text-blue-400" />}
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-500 mt-0.5">
                  {p.ratingAvg > 0 && <span className="flex items-center gap-1"><Star size={11} className="text-yellow-400" />{p.ratingAvg.toFixed(1)}</span>}
                  {p.address && <span><MapPin size={11} className="inline" /> {p.address}</span>}
                  <span>Score: {p.score || 0}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-slate-700">
        <p className="text-slate-400 text-sm">Выбрано: <span className="text-white font-medium">{selectedIds.size}</span> мастеров</p>
        <button
          onClick={handleSend}
          disabled={selectedIds.size === 0 || distributing}
          className="flex items-center gap-2 px-6 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg disabled:opacity-50"
          data-testid="send-distribution-btn"
        >
          <Send size={16} />
          {distributing ? 'Отправка...' : `Распределить (${selectedIds.size})`}
        </button>
      </div>
    </div>
  );
}

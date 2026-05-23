import { useState, useEffect } from 'react';
import { History, Search, Filter, User, Settings, Calendar, Clock, ChevronLeft, ChevronRight } from 'lucide-react';
import { adminAPI } from '../services/api';

interface AuditLogEntry {
  id: string;
  actor: string;
  actorEmail?: string;
  action: string;
  entityType: string;
  entityId?: string;
  description?: string;
  oldValue?: any;
  newValue?: any;
  metadata?: any;
  createdAt: string;
}

const actorColors: Record<string, string> = {
  ADMIN: 'bg-purple-500/20 text-purple-400',
  SYSTEM: 'bg-blue-500/20 text-blue-400',
  PROVIDER: 'bg-green-500/20 text-green-400',
  CUSTOMER: 'bg-orange-500/20 text-orange-400',
};

const entityColors: Record<string, string> = {
  provider: 'bg-emerald-500/20 text-emerald-400',
  booking: 'bg-cyan-500/20 text-cyan-400',
  rule: 'bg-violet-500/20 text-violet-400',
  zone: 'bg-amber-500/20 text-amber-400',
  quote: 'bg-pink-500/20 text-pink-400',
  notification: 'bg-indigo-500/20 text-indigo-400',
  user: 'bg-rose-500/20 text-rose-400',
};

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  
  // Filters
  const [filters, setFilters] = useState({
    actor: '',
    entityType: '',
    action: '',
    dateFrom: '',
    dateTo: '',
  });
  const [showFilters, setShowFilters] = useState(false);

  const limit = 20;

  const loadLogs = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getAuditLog({
        ...filters,
        limit,
        skip: (page - 1) * limit,
      });
      setLogs(res.data.logs || []);
      setTotal(res.data.total || 0);
    } catch (err) {
      console.error('Failed to load audit logs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
  }, [page, filters]);

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatAction = (action: string) => {
    return action
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="p-6 bg-slate-900 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-violet-500/20 rounded-lg">
            <History className="w-6 h-6 text-violet-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Audit Log</h1>
            <p className="text-sm text-slate-400">История всех действий в системе</p>
          </div>
        </div>
        
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
            showFilters ? 'bg-violet-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
        >
          <Filter className="w-4 h-4" />
          Фильтры
        </button>
      </div>

      {/* Filters Panel */}
      {showFilters && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-6">
          <div className="grid grid-cols-5 gap-4">
            <div>
              <label className="block text-sm text-slate-400 mb-1">Актор</label>
              <select
                value={filters.actor}
                onChange={(e) => setFilters({ ...filters, actor: e.target.value })}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white"
              >
                <option value="">Все</option>
                <option value="ADMIN">Admin</option>
                <option value="SYSTEM">System</option>
                <option value="PROVIDER">Provider</option>
                <option value="CUSTOMER">Customer</option>
              </select>
            </div>
            
            <div>
              <label className="block text-sm text-slate-400 mb-1">Тип сущности</label>
              <select
                value={filters.entityType}
                onChange={(e) => setFilters({ ...filters, entityType: e.target.value })}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white"
              >
                <option value="">Все</option>
                <option value="provider">Provider</option>
                <option value="booking">Booking</option>
                <option value="quote">Quote</option>
                <option value="rule">Rule</option>
                <option value="zone">Zone</option>
                <option value="notification">Notification</option>
                <option value="user">User</option>
              </select>
            </div>
            
            <div>
              <label className="block text-sm text-slate-400 mb-1">Действие</label>
              <input
                type="text"
                placeholder="Поиск по действию..."
                value={filters.action}
                onChange={(e) => setFilters({ ...filters, action: e.target.value })}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500"
              />
            </div>
            
            <div>
              <label className="block text-sm text-slate-400 mb-1">Дата от</label>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white"
              />
            </div>
            
            <div>
              <label className="block text-sm text-slate-400 mb-1">Дата до</label>
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white"
              />
            </div>
          </div>
          
          <div className="flex justify-end mt-4">
            <button
              onClick={() => {
                setFilters({ actor: '', entityType: '', action: '', dateFrom: '', dateTo: '' });
                setPage(1);
              }}
              className="px-4 py-2 text-slate-400 hover:text-white transition-colors"
            >
              Сбросить
            </button>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="flex items-center gap-4 mb-6">
        <div className="bg-slate-800 rounded-lg px-4 py-2">
          <span className="text-slate-400 text-sm">Всего записей:</span>
          <span className="text-white font-bold ml-2">{total}</span>
        </div>
      </div>

      {/* Log List */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-violet-500 mx-auto"></div>
            <p className="text-slate-400 mt-2">Загрузка...</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center">
            <History className="w-12 h-12 text-slate-600 mx-auto mb-2" />
            <p className="text-slate-400">Нет записей в журнале</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-700">
            {logs.map((log) => (
              <div key={log.id} className="hover:bg-slate-750">
                <div
                  className="p-4 cursor-pointer"
                  onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                      {/* Time */}
                      <div className="flex items-center gap-1 text-slate-500 text-sm min-w-[140px]">
                        <Clock className="w-3 h-3" />
                        {formatTime(log.createdAt)}
                      </div>
                      
                      {/* Actor Badge */}
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${actorColors[log.actor] || 'bg-slate-600 text-slate-300'}`}>
                        {log.actor}
                      </span>
                      
                      {/* Action */}
                      <span className="text-white font-medium">
                        {formatAction(log.action)}
                      </span>
                      
                      {/* Entity Type */}
                      <span className={`px-2 py-0.5 rounded text-xs ${entityColors[log.entityType] || 'bg-slate-600 text-slate-300'}`}>
                        {log.entityType}
                      </span>
                      
                      {/* Entity ID */}
                      {log.entityId && (
                        <span className="text-slate-400 text-sm font-mono">
                          #{log.entityId.slice(-6)}
                        </span>
                      )}
                    </div>
                    
                    {/* Actor Email */}
                    {log.actorEmail && (
                      <span className="text-slate-500 text-sm">{log.actorEmail}</span>
                    )}
                  </div>
                  
                  {/* Description */}
                  {log.description && (
                    <p className="text-slate-400 text-sm mt-2 ml-[156px]">{log.description}</p>
                  )}
                </div>
                
                {/* Expanded Details */}
                {expandedLog === log.id && (log.oldValue || log.newValue || log.metadata) && (
                  <div className="px-4 pb-4 ml-[156px]">
                    <div className="bg-slate-900 rounded-lg p-4 grid grid-cols-2 gap-4">
                      {log.oldValue && (
                        <div>
                          <h4 className="text-red-400 text-xs font-medium mb-2">Старое значение:</h4>
                          <pre className="text-xs text-slate-400 bg-slate-950 p-2 rounded overflow-auto max-h-32">
                            {JSON.stringify(log.oldValue, null, 2)}
                          </pre>
                        </div>
                      )}
                      {log.newValue && (
                        <div>
                          <h4 className="text-green-400 text-xs font-medium mb-2">Новое значение:</h4>
                          <pre className="text-xs text-slate-400 bg-slate-950 p-2 rounded overflow-auto max-h-32">
                            {JSON.stringify(log.newValue, null, 2)}
                          </pre>
                        </div>
                      )}
                      {log.metadata && (
                        <div className="col-span-2">
                          <h4 className="text-blue-400 text-xs font-medium mb-2">Метаданные:</h4>
                          <pre className="text-xs text-slate-400 bg-slate-950 p-2 rounded overflow-auto max-h-32">
                            {JSON.stringify(log.metadata, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-slate-400 text-sm">
            Страница {page} из {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="p-2 bg-slate-700 rounded-lg text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-600 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages}
              className="p-2 bg-slate-700 rounded-lg text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-600 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

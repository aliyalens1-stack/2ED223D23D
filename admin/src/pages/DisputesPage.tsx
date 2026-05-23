import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminAPI } from '../services/api';
import { 
  MessageSquare, AlertTriangle, Clock, User, Building2, DollarSign,
  CheckCircle, XCircle, Eye, Filter, ChevronRight, Shield, FileText,
  AlertCircle, Timer, Flag, Send, Lock, Unlock, Activity
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { ru } from 'date-fns/locale';

interface Dispute {
  _id: string;
  bookingId?: { _id: string; totalPrice?: number };
  customerId?: { _id: string; firstName?: string; lastName?: string; email?: string };
  providerId?: { _id: string; name?: string };
  category: string;
  status: string;
  priority: string;
  amountAtRisk?: number;
  description?: string;
  resolution?: string;
  ownerId?: { firstName?: string; email?: string };
  slaDeadline?: string;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES = [
  { value: '', label: 'Все категории' },
  { value: 'no_show', label: 'Неявка' },
  { value: 'quality', label: 'Качество услуги' },
  { value: 'overcharge', label: 'Переплата' },
  { value: 'fake_completion', label: 'Фейковое завершение' },
  { value: 'abuse', label: 'Нарушение' },
  { value: 'fraud', label: 'Мошенничество' },
  { value: 'payment', label: 'Проблема с оплатой' },
  { value: 'other', label: 'Другое' },
];

const STATUSES = [
  { value: '', label: 'Все статусы' },
  { value: 'open', label: 'Открытые' },
  { value: 'in_review', label: 'На рассмотрении' },
  { value: 'evidence_requested', label: 'Ожидает доказательств' },
  { value: 'escalated', label: 'Эскалировано' },
  { value: 'resolved', label: 'Решено' },
  { value: 'closed', label: 'Закрыто' },
];

const PRIORITIES = [
  { value: '', label: 'Все приоритеты' },
  { value: 'urgent', label: 'Срочный' },
  { value: 'high', label: 'Высокий' },
  { value: 'medium', label: 'Средний' },
  { value: 'low', label: 'Низкий' },
];

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
  in_review: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
  evidence_requested: 'bg-purple-500/20 text-purple-400 border-purple-500/50',
  escalated: 'bg-red-500/20 text-red-400 border-red-500/50',
  resolved: 'bg-green-500/20 text-green-400 border-green-500/50',
  closed: 'bg-slate-500/20 text-slate-400 border-slate-500/50',
};

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'bg-red-500/20 text-red-400',
  high: 'bg-orange-500/20 text-orange-400',
  medium: 'bg-yellow-500/20 text-yellow-400',
  low: 'bg-slate-500/20 text-slate-400',
};

const CATEGORY_LABELS: Record<string, string> = {
  no_show: 'Неявка',
  quality: 'Качество',
  overcharge: 'Переплата',
  fake_completion: 'Фейк',
  abuse: 'Нарушение',
  fraud: 'Мошенничество',
  payment: 'Оплата',
  other: 'Другое',
};

interface DisputeDetailProps {
  dispute: Dispute;
  onClose: () => void;
  onUpdate: () => void;
}

const DisputeDetail = ({ dispute, onClose, onUpdate }: DisputeDetailProps) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'evidence' | 'timeline' | 'resolution'>('overview');
  const [resolutionNote, setResolutionNote] = useState('');
  const [refundAmount, setRefundAmount] = useState(dispute.amountAtRisk?.toString() || '0');
  
  const handleResolve = async (decision: string) => {
    try {
      await adminAPI.resolveDispute(dispute._id, {
        decision,
        refundAmount: decision === 'refund' ? parseFloat(refundAmount) : undefined,
        notes: resolutionNote,
      });
      onUpdate();
      onClose();
    } catch (err) {
      console.error(err);
    }
  };
  
  const handleFreezePayout = async () => {
    try {
      await adminAPI.freezePayout(dispute._id);
      onUpdate();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${PRIORITY_COLORS[dispute.priority]}`}>
              <AlertTriangle size={20} />
            </div>
            <div>
              <h2 className="text-white font-semibold">Спор #{dispute._id.slice(-8)}</h2>
              <p className="text-slate-400 text-sm">
                {CATEGORY_LABELS[dispute.category] || dispute.category} • 
                Создан {format(new Date(dispute.createdAt), 'dd.MM.yyyy HH:mm')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`px-3 py-1 rounded-full text-sm border ${STATUS_COLORS[dispute.status]}`}>
              {STATUSES.find(s => s.value === dispute.status)?.label || dispute.status}
            </span>
            <button onClick={onClose} className="p-2 hover:bg-slate-700 rounded-lg text-slate-400">
              <XCircle size={20} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-700">
          {['overview', 'evidence', 'timeline', 'resolution'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as any)}
              className={`px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab ? 'text-primary border-b-2 border-primary' : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab === 'overview' && 'Обзор'}
              {tab === 'evidence' && 'Доказательства'}
              {tab === 'timeline' && 'История'}
              {tab === 'resolution' && 'Решение'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {activeTab === 'overview' && (
            <div className="grid grid-cols-2 gap-6">
              {/* Left Column - Parties */}
              <div className="space-y-4">
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <User size={16} /> Клиент
                  </h3>
                  <p className="text-white">
                    {dispute.customerId?.firstName} {dispute.customerId?.lastName}
                  </p>
                  <p className="text-slate-400 text-sm">{dispute.customerId?.email}</p>
                </div>

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <Building2 size={16} /> Мастер
                  </h3>
                  <p className="text-white">{dispute.providerId?.name || '—'}</p>
                </div>

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <FileText size={16} /> Описание
                  </h3>
                  <p className="text-slate-300 text-sm">{dispute.description || 'Описание не указано'}</p>
                </div>
              </div>

              {/* Right Column - Details */}
              <div className="space-y-4">
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <DollarSign size={16} /> Сумма спора
                  </h3>
                  <p className="text-2xl font-bold text-white">₴{dispute.amountAtRisk?.toLocaleString() || 0}</p>
                </div>

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <Timer size={16} /> SLA
                  </h3>
                  {dispute.slaDeadline ? (
                    <div>
                      <p className="text-white">{format(new Date(dispute.slaDeadline), 'dd.MM.yyyy HH:mm')}</p>
                      <p className="text-sm text-slate-400">
                        {formatDistanceToNow(new Date(dispute.slaDeadline), { addSuffix: true, locale: ru })}
                      </p>
                    </div>
                  ) : (
                    <p className="text-slate-400">Не установлен</p>
                  )}
                </div>

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <Shield size={16} /> Ответственный
                  </h3>
                  <p className="text-white">
                    {dispute.ownerId?.firstName || dispute.ownerId?.email || 'Не назначен'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'evidence' && (
            <div className="text-center py-12">
              <FileText size={48} className="text-slate-600 mx-auto mb-4" />
              <p className="text-slate-400">Доказательства будут здесь</p>
              <button className="mt-4 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90">
                Запросить доказательства
              </button>
            </div>
          )}

          {activeTab === 'timeline' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 pb-4 border-b border-slate-700">
                <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                  <AlertCircle size={16} className="text-blue-400" />
                </div>
                <div>
                  <p className="text-white">Спор создан</p>
                  <p className="text-slate-400 text-sm">{format(new Date(dispute.createdAt), 'dd.MM.yyyy HH:mm')}</p>
                </div>
              </div>
              {dispute.updatedAt !== dispute.createdAt && (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center">
                    <Clock size={16} className="text-yellow-400" />
                  </div>
                  <div>
                    <p className="text-white">Последнее обновление</p>
                    <p className="text-slate-400 text-sm">{format(new Date(dispute.updatedAt), 'dd.MM.yyyy HH:mm')}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'resolution' && (
            <div className="space-y-4">
              <div className="bg-slate-700/50 rounded-lg p-4">
                <h3 className="text-white font-medium mb-3">Сумма возврата</h3>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">₴</span>
                  <input
                    type="number"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                    className="bg-slate-600 border border-slate-500 rounded px-3 py-2 text-white w-32"
                  />
                  <span className="text-slate-400 text-sm">из ₴{dispute.amountAtRisk?.toLocaleString() || 0}</span>
                </div>
              </div>

              <div className="bg-slate-700/50 rounded-lg p-4">
                <h3 className="text-white font-medium mb-3">Заметка к решению</h3>
                <textarea
                  value={resolutionNote}
                  onChange={(e) => setResolutionNote(e.target.value)}
                  rows={3}
                  placeholder="Описание решения..."
                  className="w-full bg-slate-600 border border-slate-500 rounded px-3 py-2 text-white placeholder-slate-400"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <button
                  onClick={() => handleResolve('refund')}
                  className="px-4 py-3 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg font-medium transition-colors"
                >
                  Возврат клиенту
                </button>
                <button
                  onClick={() => handleResolve('favor_provider')}
                  className="px-4 py-3 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg font-medium transition-colors"
                >
                  В пользу мастера
                </button>
                <button
                  onClick={() => handleResolve('split')}
                  className="px-4 py-3 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 rounded-lg font-medium transition-colors"
                >
                  Разделить
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-slate-700 flex items-center justify-between">
          <div className="flex gap-2">
            <button
              onClick={handleFreezePayout}
              className="flex items-center gap-2 px-3 py-2 bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 rounded-lg text-sm"
            >
              <Lock size={16} /> Заморозить выплату
            </button>
            <button className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-sm">
              <Flag size={16} /> Предупредить
            </button>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};

export default function DisputesPage() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState('');
  const [page, setPage] = useState(0);
  const [selectedDispute, setSelectedDispute] = useState<Dispute | null>(null);
  const limit = 20;

  // Stats for header
  const [stats, setStats] = useState({ open: 0, urgent: 0, overdue: 0 });

  const fetchDisputes = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getDisputes({
        status: status || undefined,
        category: category || undefined,
        priority: priority || undefined,
        limit,
        skip: page * limit,
      });
      setDisputes(res.data.disputes || []);
      setTotal(res.data.total || 0);
      
      // Calculate stats
      const allDisputes = res.data.disputes || [];
      setStats({
        open: allDisputes.filter((d: Dispute) => d.status === 'open').length,
        urgent: allDisputes.filter((d: Dispute) => d.priority === 'urgent').length,
        overdue: allDisputes.filter((d: Dispute) => d.slaDeadline && new Date(d.slaDeadline) < new Date()).length,
      });
    } catch (err) {
      console.error(err);
      setDisputes([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDisputes();
  }, [status, category, priority, page]);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-red-500/20 rounded-lg">
            <Shield size={24} className="text-red-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Trust Center</h1>
            <p className="text-slate-400 text-sm">Управление спорами и доверием</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-500/20 rounded-lg">
            <span className="text-blue-400 font-medium">{stats.open}</span>
            <span className="text-slate-400 text-sm">открытых</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/20 rounded-lg">
            <span className="text-red-400 font-medium">{stats.urgent}</span>
            <span className="text-slate-400 text-sm">срочных</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-500/20 rounded-lg">
            <span className="text-orange-400 font-medium">{stats.overdue}</span>
            <span className="text-slate-400 text-sm">просроченных</span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(0); }}
          className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm"
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <select
          value={category}
          onChange={(e) => { setCategory(e.target.value); setPage(0); }}
          className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <select
          value={priority}
          onChange={(e) => { setPriority(e.target.value); setPage(0); }}
          className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm"
        >
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-700/50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">ID / Категория</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Клиент</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Мастер</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Сумма</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">SLA</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Приоритет</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Статус</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-slate-300">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Загрузка...</td></tr>
            ) : disputes.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <Shield size={48} className="text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">Споров не найдено</p>
                  <p className="text-slate-500 text-sm mt-1">Все хорошо! Нет открытых споров.</p>
                </td>
              </tr>
            ) : (
              disputes.map((d) => {
                const isOverdue = d.slaDeadline && new Date(d.slaDeadline) < new Date();
                return (
                  <tr key={d._id} className="hover:bg-slate-700/30 cursor-pointer" onClick={() => setSelectedDispute(d)}>
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-white text-sm font-mono">#{d._id.slice(-8)}</p>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          d.category === 'fraud' ? 'bg-red-500/20 text-red-400' :
                          d.category === 'abuse' ? 'bg-orange-500/20 text-orange-400' :
                          'bg-slate-600 text-slate-300'
                        }`}>
                          {CATEGORY_LABELS[d.category] || d.category}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <User size={14} className="text-slate-400" />
                        <span className="text-slate-300 text-sm">
                          {d.customerId?.firstName || d.customerId?.email?.split('@')[0] || '—'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Building2 size={14} className="text-slate-400" />
                        <span className="text-slate-300 text-sm">{d.providerId?.name || '—'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-white font-medium">₴{d.amountAtRisk?.toLocaleString() || 0}</span>
                    </td>
                    <td className="px-4 py-3">
                      {d.slaDeadline ? (
                        <div className={`flex items-center gap-1 ${isOverdue ? 'text-red-400' : 'text-slate-400'}`}>
                          <Timer size={14} />
                          <span className="text-sm">
                            {formatDistanceToNow(new Date(d.slaDeadline), { addSuffix: true, locale: ru })}
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-500 text-sm">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${PRIORITY_COLORS[d.priority]}`}>
                        {PRIORITIES.find(p => p.value === d.priority)?.label || d.priority}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded-full text-xs border ${STATUS_COLORS[d.status]}`}>
                        {STATUSES.find(s => s.value === d.status)?.label || d.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          to={`/forensic/dispute/${d._id}`}
                          className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-blue-300"
                          title="Forensic graph"
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`dispute-forensic-link-${d._id}`}
                        >
                          <Activity size={16} />
                        </Link>
                        <button 
                          className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white"
                          onClick={(e) => { e.stopPropagation(); setSelectedDispute(d); }}
                        >
                          <Eye size={16} />
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

      {/* Dispute Detail Modal */}
      {selectedDispute && (
        <DisputeDetail
          dispute={selectedDispute}
          onClose={() => setSelectedDispute(null)}
          onUpdate={fetchDisputes}
        />
      )}
    </div>
  );
}

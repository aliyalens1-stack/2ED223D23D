import { useEffect, useState } from 'react';
import { adminAPI } from '../services/api';
import { 
  Calendar, User, Building2, DollarSign, Clock, Eye, XCircle,
  CheckCircle, RefreshCw, MapPin, Phone, FileText, MessageSquare,
  AlertTriangle, Star, ArrowRight
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { ru } from 'date-fns/locale';

interface Booking {
  _id: string;
  status: string;
  customerId?: { _id: string; firstName?: string; lastName?: string; email?: string; phone?: string };
  organizationId?: { _id: string; name?: string };
  branchId?: { name?: string; address?: string };
  serviceId?: { name?: string };
  totalPrice?: number;
  platformFee?: number;
  paymentStatus?: string;
  scheduledDate?: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  hasReview?: boolean;
  hasDispute?: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

const STATUSES = [
  { value: '', label: 'Все статусы' },
  { value: 'pending', label: 'Ожидают' },
  { value: 'confirmed', label: 'Подтверждены' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'completed', label: 'Завершены' },
  { value: 'cancelled', label: 'Отменены' },
];

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
  confirmed: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
  in_progress: 'bg-purple-500/20 text-purple-400 border-purple-500/50',
  completed: 'bg-green-500/20 text-green-400 border-green-500/50',
  cancelled: 'bg-red-500/20 text-red-400 border-red-500/50',
};

const PAYMENT_COLORS: Record<string, string> = {
  pending: 'text-yellow-400',
  completed: 'text-green-400',
  failed: 'text-red-400',
  refunded: 'text-purple-400',
};

interface BookingDetailProps {
  booking: Booking;
  onClose: () => void;
  onUpdate: () => void;
}

const BookingDetail = ({ booking, onClose, onUpdate }: BookingDetailProps) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'timeline' | 'payment' | 'actions'>('overview');
  const [refundAmount, setRefundAmount] = useState(booking.totalPrice?.toString() || '0');
  const [actionNote, setActionNote] = useState('');

  const handleStatusChange = async (newStatus: string) => {
    try {
      await adminAPI.updateBookingStatus(booking._id, newStatus, actionNote);
      onUpdate();
      onClose();
    } catch (err) {
      console.error(err);
    }
  };

  const handleRefund = async () => {
    try {
      await adminAPI.refundBooking(booking._id, parseFloat(refundAmount), actionNote);
      onUpdate();
      onClose();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-500/20 rounded-lg">
                <Calendar size={20} className="text-purple-400" />
              </div>
              <div>
                <h2 className="text-white font-semibold">Бронирование #{booking._id.slice(-8)}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs border ${STATUS_COLORS[booking.status]}`}>
                    {STATUSES.find(s => s.value === booking.status)?.label || booking.status}
                  </span>
                  {booking.hasDispute && (
                    <span className="px-2 py-0.5 bg-red-500/20 text-red-400 text-xs rounded">Есть спор</span>
                  )}
                  {booking.hasReview && (
                    <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-400 text-xs rounded flex items-center gap-1">
                      <Star size={10} /> Отзыв
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
          {['overview', 'timeline', 'payment', 'actions'].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab as any)}
              className={`px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab ? 'text-primary border-b-2 border-primary' : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab === 'overview' && 'Обзор'}
              {tab === 'timeline' && 'История'}
              {tab === 'payment' && 'Оплата'}
              {tab === 'actions' && 'Действия'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {activeTab === 'overview' && (
            <div className="grid grid-cols-2 gap-6">
              {/* Customer */}
              <div className="space-y-4">
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <User size={16} /> Клиент
                  </h3>
                  <div className="space-y-2">
                    <p className="text-white">{booking.customerId?.firstName} {booking.customerId?.lastName}</p>
                    <p className="text-slate-400 text-sm">{booking.customerId?.email}</p>
                    {booking.customerId?.phone && (
                      <p className="text-slate-400 text-sm flex items-center gap-1">
                        <Phone size={12} /> {booking.customerId.phone}
                      </p>
                    )}
                  </div>
                </div>

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <Building2 size={16} /> Мастер
                  </h3>
                  <div className="space-y-2">
                    <p className="text-white">{booking.organizationId?.name || '—'}</p>
                    {booking.branchId?.address && (
                      <p className="text-slate-400 text-sm flex items-center gap-1">
                        <MapPin size={12} /> {booking.branchId.address}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Service & Schedule */}
              <div className="space-y-4">
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <FileText size={16} /> Услуга
                  </h3>
                  <p className="text-white">{booking.serviceId?.name || 'Не указана'}</p>
                </div>

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <Clock size={16} /> Расписание
                  </h3>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Запланировано</span>
                      <span className="text-white">
                        {booking.scheduledDate 
                          ? format(new Date(booking.scheduledDate), 'dd.MM.yyyy HH:mm')
                          : '—'}
                      </span>
                    </div>
                    {booking.startedAt && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Начато</span>
                        <span className="text-white">
                          {format(new Date(booking.startedAt), 'HH:mm')}
                        </span>
                      </div>
                    )}
                    {booking.completedAt && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Завершено</span>
                        <span className="text-green-400">
                          {format(new Date(booking.completedAt), 'HH:mm')}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3 flex items-center gap-2">
                    <DollarSign size={16} /> Стоимость
                  </h3>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Итого</span>
                      <span className="text-2xl font-bold text-white">₴{booking.totalPrice?.toLocaleString() || 0}</span>
                    </div>
                    {booking.platformFee && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Комиссия</span>
                        <span className="text-green-400">₴{booking.platformFee}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-slate-400">Оплата</span>
                      <span className={PAYMENT_COLORS[booking.paymentStatus || 'pending']}>
                        {booking.paymentStatus || 'pending'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'timeline' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 pb-4 border-b border-slate-700">
                <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                  <Calendar size={16} className="text-blue-400" />
                </div>
                <div>
                  <p className="text-white">Бронирование создано</p>
                  <p className="text-slate-400 text-sm">{format(new Date(booking.createdAt), 'dd.MM.yyyy HH:mm')}</p>
                </div>
              </div>
              
              {booking.status === 'confirmed' && (
                <div className="flex items-start gap-3 pb-4 border-b border-slate-700">
                  <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                    <CheckCircle size={16} className="text-green-400" />
                  </div>
                  <div>
                    <p className="text-white">Подтверждено мастером</p>
                  </div>
                </div>
              )}

              {booking.startedAt && (
                <div className="flex items-start gap-3 pb-4 border-b border-slate-700">
                  <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center">
                    <ArrowRight size={16} className="text-purple-400" />
                  </div>
                  <div>
                    <p className="text-white">Работа начата</p>
                    <p className="text-slate-400 text-sm">{format(new Date(booking.startedAt), 'dd.MM.yyyy HH:mm')}</p>
                  </div>
                </div>
              )}

              {booking.completedAt && (
                <div className="flex items-start gap-3 pb-4 border-b border-slate-700">
                  <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <CheckCircle size={16} className="text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-white">Завершено</p>
                    <p className="text-slate-400 text-sm">{format(new Date(booking.completedAt), 'dd.MM.yyyy HH:mm')}</p>
                  </div>
                </div>
              )}

              {booking.cancelledAt && (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center">
                    <XCircle size={16} className="text-red-400" />
                  </div>
                  <div>
                    <p className="text-white">Отменено</p>
                    <p className="text-slate-400 text-sm">{format(new Date(booking.cancelledAt), 'dd.MM.yyyy HH:mm')}</p>
                    {booking.cancelReason && (
                      <p className="text-red-400 text-sm mt-1">{booking.cancelReason}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'payment' && (
            <div className="space-y-4">
              <div className="bg-slate-700/50 rounded-lg p-4">
                <h3 className="text-white font-medium mb-3">Детали платежа</h3>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Сумма</span>
                    <span className="text-white">₴{booking.totalPrice?.toLocaleString() || 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Комиссия платформы</span>
                    <span className="text-green-400">₴{booking.platformFee || 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Мастеру</span>
                    <span className="text-white">₴{((booking.totalPrice || 0) - (booking.platformFee || 0)).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-slate-600">
                    <span className="text-slate-400">Статус</span>
                    <span className={`font-medium ${PAYMENT_COLORS[booking.paymentStatus || 'pending']}`}>
                      {booking.paymentStatus || 'pending'}
                    </span>
                  </div>
                </div>
              </div>

              {booking.status === 'completed' && booking.paymentStatus === 'completed' && (
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <h3 className="text-white font-medium mb-3">Возврат</h3>
                  <div className="space-y-3">
                    <div>
                      <label className="text-slate-400 text-sm">Сумма возврата</label>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-slate-400">₴</span>
                        <input
                          type="number"
                          value={refundAmount}
                          onChange={(e) => setRefundAmount(e.target.value)}
                          max={booking.totalPrice}
                          className="bg-slate-600 border border-slate-500 rounded px-3 py-2 text-white w-32"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-slate-400 text-sm">Причина</label>
                      <input
                        type="text"
                        value={actionNote}
                        onChange={(e) => setActionNote(e.target.value)}
                        placeholder="Причина возврата..."
                        className="w-full mt-1 bg-slate-600 border border-slate-500 rounded px-3 py-2 text-white"
                      />
                    </div>
                    <button
                      onClick={handleRefund}
                      className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg"
                    >
                      Сделать возврат
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'actions' && (
            <div className="space-y-4">
              <div className="bg-slate-700/50 rounded-lg p-4">
                <h3 className="text-white font-medium mb-3">Заметка к действию</h3>
                <textarea
                  value={actionNote}
                  onChange={(e) => setActionNote(e.target.value)}
                  rows={2}
                  placeholder="Заметка админа..."
                  className="w-full bg-slate-600 border border-slate-500 rounded px-3 py-2 text-white placeholder-slate-400"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                {booking.status === 'pending' && (
                  <>
                    <button
                      onClick={() => handleStatusChange('confirmed')}
                      className="p-3 bg-green-500/20 hover:bg-green-500/30 text-green-400 rounded-lg font-medium"
                    >
                      Подтвердить
                    </button>
                    <button
                      onClick={() => handleStatusChange('cancelled')}
                      className="p-3 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg font-medium"
                    >
                      Отменить
                    </button>
                  </>
                )}
                
                {booking.status === 'confirmed' && (
                  <>
                    <button
                      onClick={() => handleStatusChange('in_progress')}
                      className="p-3 bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 rounded-lg font-medium"
                    >
                      Начать работу
                    </button>
                    <button
                      onClick={() => handleStatusChange('cancelled')}
                      className="p-3 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg font-medium"
                    >
                      Отменить
                    </button>
                  </>
                )}

                {booking.status === 'in_progress' && (
                  <button
                    onClick={() => handleStatusChange('completed')}
                    className="col-span-2 p-3 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-lg font-medium"
                  >
                    Завершить
                  </button>
                )}

                {!booking.hasDispute && booking.status !== 'cancelled' && (
                  <button className="col-span-2 p-3 bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 rounded-lg font-medium">
                    Открыть спор
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg">
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};

export default function BookingsPage() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const limit = 20;

  const fetchBookings = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getBookings({
        status: status || undefined,
        limit,
        skip: page * limit,
      });
      setBookings(res.data.bookings || []);
      setTotal(res.data.total || 0);
    } catch (err) {
      console.error(err);
      setBookings([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBookings();
  }, [status, page]);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-500/20 rounded-lg">
            <Calendar size={24} className="text-purple-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Execution Layer</h1>
            <p className="text-slate-400 text-sm">Управление бронированиями</p>
          </div>
        </div>
        <span className="text-slate-400">Всего: {total}</span>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6">
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(0); }}
          className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white"
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <button
          onClick={fetchBookings}
          className="p-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-white"
        >
          <RefreshCw size={18} />
        </button>
      </div>

      {/* Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-700/50">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">ID / Клиент</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Мастер</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Услуга</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Дата</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Сумма</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Оплата</th>
              <th className="text-left px-4 py-3 text-sm font-medium text-slate-300">Статус</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-slate-300">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Загрузка...</td></tr>
            ) : bookings.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <Calendar size={48} className="text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">Бронирований не найдено</p>
                </td>
              </tr>
            ) : (
              bookings.map((b) => (
                <tr 
                  key={b._id} 
                  className="hover:bg-slate-700/30 cursor-pointer"
                  onClick={() => setSelectedBooking(b)}
                >
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-white text-sm font-mono">#{b._id.slice(-8)}</p>
                      <p className="text-slate-400 text-xs flex items-center gap-1">
                        <User size={12} />
                        {b.customerId?.firstName || b.customerId?.email?.split('@')[0] || '—'}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Building2 size={14} className="text-slate-400" />
                      <span className="text-white text-sm">{b.organizationId?.name || '—'}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-slate-300 text-sm">{b.serviceId?.name || '—'}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 text-slate-400">
                      <Clock size={14} />
                      <span className="text-sm">
                        {b.scheduledDate ? format(new Date(b.scheduledDate), 'dd.MM.yy HH:mm') : '—'}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-white font-medium">₴{b.totalPrice?.toLocaleString() || 0}</p>
                      {b.platformFee && (
                        <p className="text-green-400 text-xs">+₴{b.platformFee}</p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-sm ${PAYMENT_COLORS[b.paymentStatus || 'pending']}`}>
                      {b.paymentStatus || 'pending'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-1 rounded-full text-xs border ${STATUS_COLORS[b.status]}`}>
                        {STATUSES.find(s => s.value === b.status)?.label || b.status}
                      </span>
                      {b.hasDispute && <AlertTriangle size={14} className="text-red-400" />}
                      {b.hasReview && <Star size={14} className="text-yellow-400" />}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button 
                      className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white"
                      onClick={(e) => { e.stopPropagation(); setSelectedBooking(b); }}
                    >
                      <Eye size={16} />
                    </button>
                  </td>
                </tr>
              ))
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

      {/* Booking Detail Modal */}
      {selectedBooking && (
        <BookingDetail
          booking={selectedBooking}
          onClose={() => setSelectedBooking(null)}
          onUpdate={fetchBookings}
        />
      )}
    </div>
  );
}

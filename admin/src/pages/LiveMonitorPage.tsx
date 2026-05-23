import { useEffect, useState, useRef } from 'react';
import { adminAPI } from '../services/api';
import { useRealtimeEvents, useRealtimeStatus } from '../hooks/useRealtimeSocket';
import { 
  Radio, MapPin, Clock, User, Building2, Phone, Navigation,
  AlertCircle, CheckCircle, Truck, Play, Pause, RefreshCw,
  ChevronRight, Eye, Zap, Wifi, WifiOff
} from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

interface LiveBooking {
  _id: string;
  status: 'pending' | 'confirmed' | 'on_route' | 'arrived' | 'in_progress' | 'completed' | 'cancelled';
  customer: {
    _id: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
  };
  provider?: {
    _id: string;
    name: string;
    phone?: string;
  };
  service?: {
    name: string;
  };
  customerLocation?: {
    lat: number;
    lng: number;
    address?: string;
  };
  providerLocation?: {
    lat: number;
    lng: number;
  };
  etaMinutes?: number;
  distanceKm?: number;
  isAlmostThere?: boolean;
  isStuck?: boolean;
  createdAt: string;
  totalPrice?: number;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bgColor: string }> = {
  pending: { label: 'Ожидание', color: 'text-gray-400', bgColor: 'bg-gray-500/20' },
  confirmed: { label: 'Подтверждён', color: 'text-blue-400', bgColor: 'bg-blue-500/20' },
  on_route: { label: 'В пути', color: 'text-orange-400', bgColor: 'bg-orange-500/20' },
  arrived: { label: 'Прибыл', color: 'text-green-400', bgColor: 'bg-green-500/20' },
  in_progress: { label: 'Выполняется', color: 'text-purple-400', bgColor: 'bg-purple-500/20' },
  completed: { label: 'Завершён', color: 'text-green-400', bgColor: 'bg-green-500/20' },
  cancelled: { label: 'Отменён', color: 'text-red-400', bgColor: 'bg-red-500/20' },
};

export default function LiveMonitorPage() {
  const [bookings, setBookings] = useState<LiveBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPolling, setIsPolling] = useState(true);
  const [selectedBooking, setSelectedBooking] = useState<LiveBooking | null>(null);
  const [filter, setFilter] = useState<string>('active');
  const [stats, setStats] = useState({
    total: 0,
    onRoute: 0,
    inProgress: 0,
    stuck: 0,
  });
  const pollingRef = useRef<NodeJS.Timer | null>(null);

  const fetchBookings = async () => {
    try {
      const statusFilter = filter === 'active' 
        ? undefined 
        : filter === 'on_route' 
          ? 'on_route' 
          : filter;
          
      const res = await adminAPI.getBookings({ 
        status: statusFilter,
        limit: 50 
      });
      
      const allBookings = res.data.bookings || [];
      
      // Filter for active bookings if needed
      const filtered = filter === 'active'
        ? allBookings.filter((b: LiveBooking) => 
            ['confirmed', 'on_route', 'arrived', 'in_progress'].includes(b.status)
          )
        : allBookings;
      
      setBookings(filtered);
      
      // Calculate stats
      setStats({
        total: filtered.length,
        onRoute: filtered.filter((b: LiveBooking) => b.status === 'on_route').length,
        inProgress: filtered.filter((b: LiveBooking) => b.status === 'in_progress').length,
        stuck: filtered.filter((b: LiveBooking) => b.isStuck).length,
      });
      
      setLoading(false);
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBookings();
    
    if (isPolling) {
      pollingRef.current = setInterval(fetchBookings, 5000);
    }
    
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [isPolling, filter]);

  // Sprint 4: instant refresh on realtime booking + orchestrator events
  const rtStatus = useRealtimeStatus();
  useRealtimeEvents({
    'booking:created':          () => fetchBookings(),
    'booking:status_changed':   () => fetchBookings(),
    'booking:provider_location':() => fetchBookings(),
    'booking.created':          () => fetchBookings(),   // EventBusService name variant
    'booking.confirmed':        () => fetchBookings(),
    'booking.started':          () => fetchBookings(),
    'booking.completed':        () => fetchBookings(),
    'booking.cancelled':        () => fetchBookings(),
    'provider.location.updated':() => fetchBookings(),
  }, [filter]);

  const togglePolling = () => {
    setIsPolling(!isPolling);
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  };

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-red-500/20 rounded-lg relative">
            <Radio size={24} className="text-red-400" />
            {isPolling && (
              <span className="absolute top-0 right-0 w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
            )}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Live Monitor</h1>
            <p className="text-slate-400 text-sm">Отслеживание активных заказов в реальном времени</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium ${
              rtStatus === 'connected'
                ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                : rtStatus === 'connecting'
                ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                : 'bg-slate-600/20 text-slate-400 border border-slate-500/30'
            }`}
            title={`Realtime: ${rtStatus}`}
            data-testid="live-monitor-ws-status"
          >
            {rtStatus === 'connected' ? <Wifi size={13} /> : <WifiOff size={13} />}
            {rtStatus === 'connected' ? 'Live WS' : rtStatus === 'connecting' ? '…' : 'Fallback poll'}
          </div>
          <button
            onClick={fetchBookings}
            className="p-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-300"
            title="Обновить"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={togglePolling}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium ${
              isPolling
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                : 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
            }`}
          >
            {isPolling ? <Pause size={16} /> : <Play size={16} />}
            {isPolling ? 'Остановить' : 'Запустить'}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-4">
          <p className="text-slate-400 text-sm">Всего активных</p>
          <p className="text-3xl font-bold text-white mt-1">{stats.total}</p>
        </div>
        <div className="bg-slate-800 rounded-xl border border-orange-500/30 p-4">
          <p className="text-orange-400 text-sm flex items-center gap-1">
            <Truck size={14} /> В пути
          </p>
          <p className="text-3xl font-bold text-orange-400 mt-1">{stats.onRoute}</p>
        </div>
        <div className="bg-slate-800 rounded-xl border border-purple-500/30 p-4">
          <p className="text-purple-400 text-sm flex items-center gap-1">
            <Navigation size={14} /> Выполняется
          </p>
          <p className="text-3xl font-bold text-purple-400 mt-1">{stats.inProgress}</p>
        </div>
        <div className="bg-slate-800 rounded-xl border border-red-500/30 p-4">
          <p className="text-red-400 text-sm flex items-center gap-1">
            <AlertCircle size={14} /> Проблемы
          </p>
          <p className="text-3xl font-bold text-red-400 mt-1">{stats.stuck}</p>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 mb-4">
        {[
          { id: 'active', label: 'Активные' },
          { id: 'on_route', label: 'В пути' },
          { id: 'in_progress', label: 'Выполняются' },
          { id: 'completed', label: 'Завершённые' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setFilter(tab.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filter === tab.id
                ? 'bg-primary text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Main Content - Split View */}
      <div className="flex-1 flex gap-6 min-h-0">
        {/* Bookings List */}
        <div className="w-1/2 bg-slate-800 rounded-xl border border-slate-700 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-slate-700">
            <h2 className="text-white font-medium">Заказы ({bookings.length})</h2>
          </div>
          
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="p-8 text-center text-slate-400">Загрузка...</div>
            ) : bookings.length === 0 ? (
              <div className="p-8 text-center">
                <Radio size={48} className="text-slate-600 mx-auto mb-4" />
                <p className="text-slate-400">Нет активных заказов</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-700">
                {bookings.map((booking) => {
                  const status = STATUS_CONFIG[booking.status] || STATUS_CONFIG.pending;
                  return (
                    <div
                      key={booking._id}
                      onClick={() => setSelectedBooking(booking)}
                      className={`p-4 cursor-pointer transition-colors hover:bg-slate-700/30 ${
                        selectedBooking?._id === booking._id ? 'bg-slate-700/50' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${status.bgColor} ${status.color}`}>
                              {status.label}
                            </span>
                            {booking.isStuck && (
                              <span className="px-2 py-0.5 rounded text-xs bg-red-500/20 text-red-400">
                                Задержка
                              </span>
                            )}
                            {booking.isAlmostThere && (
                              <span className="px-2 py-0.5 rounded text-xs bg-green-500/20 text-green-400">
                                Почти приехал
                              </span>
                            )}
                          </div>
                          
                          <div className="mt-2">
                            <p className="text-white font-medium">
                              {booking.service?.name || 'Услуга'}
                            </p>
                            <p className="text-slate-400 text-sm flex items-center gap-1 mt-1">
                              <User size={12} />
                              {booking.customer?.firstName || 'Клиент'} {booking.customer?.lastName || ''}
                            </p>
                            {booking.provider && (
                              <p className="text-slate-500 text-sm flex items-center gap-1">
                                <Building2 size={12} />
                                {booking.provider.name}
                              </p>
                            )}
                          </div>
                        </div>
                        
                        <div className="text-right">
                          {booking.etaMinutes !== undefined && booking.status === 'on_route' && (
                            <div className="text-right">
                              <p className="text-2xl font-bold text-orange-400">{booking.etaMinutes}</p>
                              <p className="text-xs text-slate-500">мин</p>
                            </div>
                          )}
                          {booking.totalPrice && (
                            <p className="text-white font-medium mt-2">
                              ₴{booking.totalPrice}
                            </p>
                          )}
                        </div>
                      </div>
                      
                      {booking.customerLocation?.address && (
                        <p className="text-slate-500 text-xs mt-2 flex items-center gap-1">
                          <MapPin size={10} />
                          {booking.customerLocation.address}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Booking Detail / Map */}
        <div className="w-1/2 bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
          {selectedBooking ? (
            <div className="h-full flex flex-col">
              {/* Detail Header */}
              <div className="p-4 border-b border-slate-700">
                <div className="flex items-center justify-between">
                  <h2 className="text-white font-medium">Детали заказа</h2>
                  <span className="text-slate-500 text-sm">#{selectedBooking._id.slice(-8)}</span>
                </div>
              </div>
              
              {/* Map Placeholder */}
              <div className="h-64 bg-slate-900 relative">
                <div 
                  className="absolute inset-0 opacity-30"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg width='40' height='40' viewBox='0 0 40 40' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M20 20.5V18H0v-2h20v-2h2v2h18v2H22v2.5h18v2H22v2h-2v-2H0v-2h20z' fill='%234B5563' fill-opacity='0.3' fill-rule='evenodd'/%3E%3C/svg%3E")`,
                  }}
                />
                
                {/* Customer marker */}
                {selectedBooking.customerLocation && (
                  <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                    <div className="relative">
                      <div className="w-4 h-4 bg-blue-500 rounded-full border-2 border-white shadow-lg" />
                      <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-slate-800 px-2 py-1 rounded text-xs text-white whitespace-nowrap">
                        Клиент
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Provider marker */}
                {selectedBooking.providerLocation && selectedBooking.status === 'on_route' && (
                  <div className="absolute left-1/3 top-1/3">
                    <div className="relative">
                      <div className="w-6 h-6 bg-orange-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center">
                        <Truck size={12} className="text-white" />
                      </div>
                      <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-slate-800 px-2 py-1 rounded text-xs text-white whitespace-nowrap">
                        Мастер
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Route line */}
                {selectedBooking.providerLocation && selectedBooking.customerLocation && (
                  <svg className="absolute inset-0 w-full h-full pointer-events-none">
                    <line
                      x1="33%"
                      y1="33%"
                      x2="50%"
                      y2="50%"
                      stroke="#f97316"
                      strokeWidth="3"
                      strokeDasharray="8,8"
                    />
                  </svg>
                )}
              </div>
              
              {/* Detail Info */}
              <div className="flex-1 overflow-auto p-4 space-y-4">
                {/* Status */}
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-slate-400 text-sm">Статус</p>
                      <p className={`text-lg font-medium ${STATUS_CONFIG[selectedBooking.status]?.color}`}>
                        {STATUS_CONFIG[selectedBooking.status]?.label}
                      </p>
                    </div>
                    {selectedBooking.etaMinutes !== undefined && selectedBooking.status === 'on_route' && (
                      <div className="text-right">
                        <p className="text-slate-400 text-sm">ETA</p>
                        <p className="text-3xl font-bold text-orange-400">{selectedBooking.etaMinutes} мин</p>
                      </div>
                    )}
                  </div>
                  
                  {selectedBooking.distanceKm !== undefined && (
                    <p className="text-slate-500 text-sm mt-2">
                      Расстояние: {selectedBooking.distanceKm.toFixed(1)} км
                    </p>
                  )}
                </div>
                
                {/* Customer */}
                <div className="bg-slate-700/50 rounded-lg p-4">
                  <p className="text-slate-400 text-sm mb-2">Клиент</p>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-white font-medium">
                        {selectedBooking.customer?.firstName} {selectedBooking.customer?.lastName}
                      </p>
                      {selectedBooking.customer?.phone && (
                        <p className="text-slate-500 text-sm flex items-center gap-1">
                          <Phone size={12} /> {selectedBooking.customer.phone}
                        </p>
                      )}
                    </div>
                    {selectedBooking.customer?.phone && (
                      <a 
                        href={`tel:${selectedBooking.customer.phone}`}
                        className="p-2 bg-green-500/20 hover:bg-green-500/30 rounded-lg text-green-400"
                      >
                        <Phone size={16} />
                      </a>
                    )}
                  </div>
                </div>
                
                {/* Provider */}
                {selectedBooking.provider && (
                  <div className="bg-slate-700/50 rounded-lg p-4">
                    <p className="text-slate-400 text-sm mb-2">Мастер</p>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white font-medium">{selectedBooking.provider.name}</p>
                        {selectedBooking.provider?.phone && (
                          <p className="text-slate-500 text-sm flex items-center gap-1">
                            <Phone size={12} /> {selectedBooking.provider.phone}
                          </p>
                        )}
                      </div>
                      {selectedBooking.provider?.phone && (
                        <a 
                          href={`tel:${selectedBooking.provider.phone}`}
                          className="p-2 bg-green-500/20 hover:bg-green-500/30 rounded-lg text-green-400"
                        >
                          <Phone size={16} />
                        </a>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Alerts */}
                {selectedBooking.isStuck && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                    <div className="flex items-center gap-2 text-red-400">
                      <AlertCircle size={18} />
                      <span className="font-medium">Мастер застрял или задерживается</span>
                    </div>
                    <p className="text-slate-400 text-sm mt-1">
                      Позиция не обновлялась или движение в противоположном направлении
                    </p>
                  </div>
                )}
                
                {selectedBooking.isAlmostThere && (
                  <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                    <div className="flex items-center gap-2 text-green-400">
                      <Zap size={18} />
                      <span className="font-medium">Мастер почти приехал!</span>
                    </div>
                    <p className="text-slate-400 text-sm mt-1">
                      Расстояние менее 200 метров
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <Eye size={48} className="text-slate-600 mx-auto mb-4" />
                <p className="text-slate-400">Выберите заказ для просмотра деталей</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

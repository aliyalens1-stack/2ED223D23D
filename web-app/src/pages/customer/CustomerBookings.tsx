import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, Clock, MapPin, RotateCcw, Star, ArrowRight, Filter } from 'lucide-react';
import { bookingsAPI, marketplaceAPI } from '../../services/api';

type Tab = 'all' | 'active' | 'completed' | 'cancelled';

const ACTIVE_STATUSES = ['pending', 'confirmed', 'on_route', 'arrived', 'in_progress'];
const STATUS_LABEL: Record<string, string> = {
  pending: 'В ожидании',
  confirmed: 'Подтверждён',
  on_route: 'Мастер в пути',
  arrived: 'Мастер прибыл',
  in_progress: 'В работе',
  completed: 'Завершён',
  cancelled: 'Отменён',
};
const STATUS_COLOR: Record<string, string> = {
  pending: 'var(--warning)',
  confirmed: 'var(--success)',
  on_route: 'var(--warning)',
  arrived: 'var(--warning)',
  in_progress: 'var(--warning)',
  completed: 'var(--success)',
  cancelled: 'var(--text-3)',
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'active', label: 'Активные' },
  { id: 'completed', label: 'Завершённые' },
  { id: 'cancelled', label: 'Отменённые' },
];

export default function CustomerBookings() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('all');

  useEffect(() => {
    bookingsAPI.getMy()
      .then(r => setItems(Array.isArray(r.data) ? r.data : (r.data?.items || [])))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (tab === 'all') return items;
    if (tab === 'active') return items.filter(b => ACTIVE_STATUSES.includes(b.status));
    if (tab === 'completed') return items.filter(b => b.status === 'completed');
    return items.filter(b => b.status === 'cancelled');
  }, [items, tab]);

  const counts = useMemo(() => ({
    all: items.length,
    active: items.filter(b => ACTIVE_STATUSES.includes(b.status)).length,
    completed: items.filter(b => b.status === 'completed').length,
    cancelled: items.filter(b => b.status === 'cancelled').length,
  }), [items]);

  const repeat = async (b: any) => {
    try {
      const r = await marketplaceAPI.quickRequest({
        serviceType: b.serviceName || 'maintenance',
        lat: b.location?.coordinates?.[1] ?? 50.4501,
        lng: b.location?.coordinates?.[0] ?? 30.5234,
        urgent: false,
      });
      const id = r.data?.bookingId || r.data?._id || r.data?.quote?._id;
      if (id) window.location.href = `/api/web-app/booking/${id}`;
    } catch (e) {
      alert('Не удалось повторить заказ. Попробуйте позже.');
    }
  };

  return (
    <div className="max-w-[1200px] mx-auto px-4 lg:px-8 py-8" data-testid="customer-bookings">
      <div className="slash-label mb-2">КАБИНЕТ КЛИЕНТА</div>
      <h1 className="font-display tracking-bebas text-4xl md:text-5xl mb-6">
        МОИ <span className="text-amber">ЗАКАЗЫ</span>
      </h1>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-6" data-testid="bookings-tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`tab-pill ${tab === t.id ? 'active' : ''}`}
            data-testid={`tab-${t.id}`}
          >
            {t.label} <span className="ml-1.5 text-amber font-bold">{counts[t.id]}</span>
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1.5 text-2xs uppercase tracking-widest text-amber font-bold">
          <Filter size={12} /> ФИЛЬТР
        </span>
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: 'var(--text-soft)' }}>Загрузка…</p>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-16">
          <Calendar size={36} className="text-amber mx-auto mb-3" />
          <h3 className="font-display tracking-bebas text-2xl mb-1">ЗАКАЗОВ ПОКА НЕТ</h3>
          <p className="mb-5" style={{ color: 'var(--text-soft)' }}>Они появятся здесь после первого запроса</p>
          <Link to="/search" className="btn-primary">Найти мастера</Link>
        </div>
      ) : (
        <div className="space-y-3" data-testid="bookings-list">
          {filtered.map(b => <BookingRow key={b._id || b.id} b={b} onRepeat={() => repeat(b)} />)}
        </div>
      )}
    </div>
  );
}

function BookingRow({ b, onRepeat }: { b: any; onRepeat: () => void }) {
  const status = b.status || 'pending';
  const isActive = ACTIVE_STATUSES.includes(status);
  const isCompleted = status === 'completed';
  const dt = b.scheduledAt ? new Date(b.scheduledAt) : (b.createdAt ? new Date(b.createdAt) : null);
  const dateStr = dt ? dt.toLocaleString('ru-UA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <div className="provider-card p-5 flex flex-col md:flex-row gap-4" data-testid={`booking-${b._id || b.id}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-2xs uppercase tracking-widest" style={{ color: 'var(--text-soft)' }}>
              {b.bookingNumber || `#${(b._id || b.id || '').slice(-6)}`} · {b.source || 'direct'}
            </div>
            <h3 className="font-display tracking-bebas text-2xl mt-0.5">{b.serviceName || 'Услуга'}</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-soft)' }}>{b.orgName || 'СТО'}</p>
          </div>
          <span
            className="badge"
            style={{ borderColor: STATUS_COLOR[status], color: STATUS_COLOR[status] }}
            data-testid={`booking-status-${b._id || b.id}`}
          >
            {STATUS_LABEL[status] || status}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs" style={{ color: 'var(--text-soft)' }}>
          <span className="flex items-center gap-1"><Calendar size={12} className="text-amber" />{dateStr}</span>
          {b.address && <span className="flex items-center gap-1"><MapPin size={12} className="text-amber" />{b.address}</span>}
          {b.completedAt && <span className="flex items-center gap-1"><Clock size={12} className="text-amber" />Завершён</span>}
        </div>
      </div>

      <div className="flex md:flex-col items-end justify-between gap-3 md:min-w-[180px]">
        <div className="text-right">
          <div className="text-2xs uppercase tracking-widest" style={{ color: 'var(--text-soft)' }}>{isCompleted ? 'итого' : 'оценка'}</div>
          <div className="font-display tracking-bebas text-3xl text-amber leading-none">
            {b.finalPrice || b.priceEstimate || '—'} ₴
          </div>
        </div>
        <div className="flex md:flex-col gap-2 w-full md:w-auto">
          {isActive && (
            <Link to={`/booking/${b._id || b.id}`} className="btn-primary btn-sm" data-testid={`booking-track-${b._id || b.id}`}>
              Отследить <ArrowRight size={12} />
            </Link>
          )}
          {isCompleted && (
            <>
              <button onClick={onRepeat} className="btn-primary btn-sm" data-testid={`booking-repeat-${b._id || b.id}`}>
                <RotateCcw size={12} /> Повторить
              </button>
              <Link to={`/booking/${b._id || b.id}`} className="btn-secondary btn-sm">
                <Star size={12} /> Оценить
              </Link>
            </>
          )}
          {!isActive && !isCompleted && (
            <Link to={`/booking/${b._id || b.id}`} className="btn-secondary btn-sm">
              Подробнее <ArrowRight size={12} />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

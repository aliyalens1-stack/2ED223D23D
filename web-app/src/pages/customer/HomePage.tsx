import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Zap, Activity, RefreshCw, Heart, Star, MapPin, Clock, ArrowRight, Car, FileText, ChevronRight,
} from 'lucide-react';
import { customerIntelligenceAPI, bookingsAPI, vehiclesAPI } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import QuickRequestModal from '../../components/QuickRequestModal';

export default function CustomerHomePage() {
  const { user } = useAuthStore();
  const [activeBooking, setActive] = useState<any>(null);
  const [recommendations, setRec]  = useState<any[]>([]);
  const [favorites, setFav]        = useState<any[]>([]);
  const [repeat, setRepeat]        = useState<any[]>([]);
  const [vehicles, setVehicles]    = useState<any[]>([]);
  const [history, setHistory]      = useState<any>(null);
  const [quickOpen, setQuickOpen]  = useState(false);

  useEffect(() => {
    bookingsAPI.getMy().then(r => {
      const all = r.data?.bookings || r.data || [];
      const live = all.find((b: any) => ['enRoute', 'inProgress', 'confirmed', 'matched'].includes(b.status));
      setActive(live || null);
    }).catch(() => {});
    customerIntelligenceAPI.getRecommendations().then(r => setRec(r.data?.recommendations || r.data?.items || [])).catch(() => {});
    customerIntelligenceAPI.getFavorites().then(r => setFav(r.data?.favorites || [])).catch(() => {});
    customerIntelligenceAPI.getRepeatOptions().then(r => setRepeat(r.data?.options || r.data?.items || [])).catch(() => {});
    customerIntelligenceAPI.getHistorySummary().then(r => setHistory(r.data)).catch(() => {});
    vehiclesAPI.getMy().then(r => setVehicles(r.data?.vehicles || r.data || [])).catch(() => {});
  }, []);

  return (
    <div className="max-w-[1400px] mx-auto px-4 lg:px-8 py-8 space-y-6">
      <div>
        <div className="slash-label mb-2">КАБИНЕТ КЛИЕНТА</div>
        <h1 className="font-display tracking-bebas text-4xl md:text-5xl">
          ДОБРЫЙ ДЕНЬ, <span className="text-amber">{(user?.firstName || 'ДРУГ').toUpperCase()}</span>
        </h1>
      </div>

      {/* Active booking */}
      {activeBooking ? (
        <div className="card-elevated" data-testid="active-booking">
          <div className="flex items-center justify-between mb-3">
            <div className="slash-label">АКТИВНЫЙ ЗАКАЗ</div>
            <span className="flex items-center gap-1.5 text-2xs uppercase tracking-widest text-amber font-bold">
              <span className="live-dot" /> LIVE
            </span>
          </div>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <div className="font-display tracking-bebas text-2xl">{activeBooking.providerName || activeBooking.provider?.name || 'Мастер в пути'}</div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-soft)' }}>{activeBooking.service || activeBooking.serviceLabel}</div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-center">
                <div className="text-2xs uppercase tracking-widest" style={{ color: 'var(--text-soft)' }}>ETA</div>
                <div className="font-display tracking-bebas text-2xl text-amber">{activeBooking.etaMinutes ?? activeBooking.eta ?? '6'} мин</div>
              </div>
              <Link to={`/booking/${activeBooking.id}`} className="btn-primary" data-testid="track-booking">
                Отследить <ChevronRight size={14} />
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="card-elevated flex items-center justify-between gap-4 flex-wrap" data-testid="no-active">
          <div>
            <div className="slash-label mb-1">ГОТОВЫ ЕХАТЬ?</div>
            <h3 className="font-display tracking-bebas text-2xl">НОВЫЙ ЗАПРОС</h3>
            <p className="text-xs mt-1" style={{ color: 'var(--text-soft)' }}>Опишите проблему — найдём мастера за минуту</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setQuickOpen(true)} className="btn-primary"><Zap size={14} fill="currentColor" /> Быстрый запрос</button>
            <Link to="/search" className="btn-secondary">Каталог</Link>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        {/* Left column */}
        <div className="space-y-6">
          {/* Repeat orders */}
          <Section title="ПОВТОРИТЬ ЗАКАЗ" kicker="ОДНИМ КЛИКОМ" icon={RefreshCw}>
            {(repeat.length ? repeat : DEMO_REPEAT).slice(0, 3).map((r: any, i: number) => (
              <div key={i} className="provider-card !p-4 flex items-center justify-between gap-3" data-testid={`repeat-${i}`}>
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{r.serviceName || r.service || 'Замена масла'}</div>
                  <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-soft)' }}>{r.providerName || r.provider || 'СТО Формула'} · {r.lastDate || '2 недели назад'}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-display tracking-bebas text-amber text-xl">{r.priceFrom ?? r.price ?? 800} ₴</span>
                  <button className="btn-primary btn-sm" data-testid={`repeat-btn-${i}`}>Повторить</button>
                </div>
              </div>
            ))}
          </Section>

          {/* Recommendations */}
          <Section title="РЕКОМЕНДАЦИИ" kicker="ДЛЯ ВАШЕГО АВТО" icon={Activity}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(recommendations.length ? recommendations : DEMO_RECS).slice(0, 4).map((r: any, i: number) => (
                <div key={i} className="provider-card !p-4 flex flex-col gap-2" data-testid={`rec-${i}`}>
                  <div className="font-semibold text-sm">{r.serviceName || r.title || 'Диагностика подвески'}</div>
                  <p className="text-xs" style={{ color: 'var(--text-soft)' }}>{r.reason || r.description || 'По вашему пробегу рекомендуется проверка'}</p>
                  <div className="hairline-t pt-2 mt-auto flex items-center justify-between">
                    <span className="font-display tracking-bebas text-amber text-lg">{r.priceFrom ?? r.price ?? 600} ₴</span>
                    <button className="btn-primary btn-sm" onClick={() => setQuickOpen(true)}>Записаться</button>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* Favorites */}
          <Section title="ИЗБРАННЫЕ МАСТЕРА" kicker="БЫСТРЫЙ ДОСТУП" icon={Heart} more={{ to: '/account/favorites', label: 'Все' }}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {(favorites.length ? favorites : DEMO_FAVS).slice(0, 4).map((p: any, i: number) => (
                <Link key={i} to={`/provider/${p.slug || p.id}`} className="provider-card !p-4 flex items-center gap-3" data-testid={`fav-${i}`}>
                  <div className="w-12 h-12 surface-chip flex items-center justify-center font-display text-xl text-amber" style={{ borderRadius: 8 }}>
                    {(p.name || 'A').charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">{p.name}</div>
                    <div className="flex items-center gap-2 text-xs mt-0.5" style={{ color: 'var(--text-soft)' }}>
                      <span className="flex items-center gap-1"><Star size={10} className="text-amber" fill="currentColor" />{p.ratingAvg ?? 4.7}</span>
                      <span className="flex items-center gap-1"><MapPin size={10} className="text-amber" />{p.distanceKm ?? '—'} км</span>
                    </div>
                  </div>
                  <ArrowRight size={14} className="text-amber" />
                </Link>
              ))}
            </div>
          </Section>
        </div>

        {/* Right column */}
        <aside className="space-y-4">
          {/* Garage */}
          <div className="card-elevated">
            <div className="flex items-center justify-between mb-3">
              <div className="slash-label">МОЙ ГАРАЖ</div>
              <Link to="/account/garage" className="text-xs text-amber hover:underline">Все</Link>
            </div>
            {(vehicles.length ? vehicles : DEMO_VEHICLES).slice(0, 2).map((v: any, i: number) => (
              <div key={i} className="surface-chip !p-3 mb-2 last:mb-0 flex items-center gap-3" data-testid={`vehicle-${i}`}>
                <span className="icon-badge-soft !w-9 !h-9"><Car size={14} /></span>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm truncate">{v.brand || v.make} {v.model}</div>
                  <div className="text-2xs uppercase tracking-widest" style={{ color: 'var(--text-soft)' }}>{v.year} · {v.plate || v.regNumber || '—'}</div>
                </div>
              </div>
            ))}
            <Link to="/account/garage" className="btn-secondary w-full mt-3 btn-sm">Добавить машину</Link>
          </div>

          {/* History */}
          <div className="card-elevated">
            <div className="slash-label mb-3">ИСТОРИЯ</div>
            <div className="space-y-2">
              <Row label="Всего заказов"  value={`${history?.totalBookings ?? 14}`} />
              <Row label="Средний чек"    value={`${history?.avgCheck ?? 980} ₴`} />
              <Row label="Любимый мастер" value={`${history?.topProvider ?? 'СТО Формула'}`} />
              <Row label="Рейтинг отзывов" value={`${history?.myRating ?? 4.9}★`} />
            </div>
            <Link to="/account/bookings" className="btn-secondary w-full mt-4 btn-sm">
              <FileText size={12} /> Все заказы
            </Link>
          </div>
        </aside>
      </div>

      <QuickRequestModal isOpen={quickOpen} onClose={() => setQuickOpen(false)} />
    </div>
  );
}

function Section({ title, kicker, icon: Icon, more, children }: any) {
  return (
    <div>
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="slash-label flex items-center gap-2">
            <Icon size={12} className="text-amber" />
            {kicker}
          </div>
          <h2 className="font-display tracking-bebas text-2xl mt-1">{title}</h2>
        </div>
        {more && <Link to={more.to} className="text-xs uppercase tracking-widest text-amber hover:underline font-semibold">{more.label} <ChevronRight size={12} className="inline" /></Link>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-2xs uppercase tracking-widest" style={{ color: 'var(--text-soft)' }}>{label}</span>
      <span className="font-semibold text-white truncate ml-2">{value}</span>
    </div>
  );
}

const DEMO_REPEAT  = [{ serviceName: 'Замена масла', providerName: 'СТО Формула', priceFrom: 800, lastDate: '2 недели назад' }];
const DEMO_RECS    = [{ serviceName: 'Диагностика подвески', reason: 'По пробегу 60 000 км', priceFrom: 600 }, { serviceName: 'Замена тормозных колодок', reason: 'Прошло 12 мес.', priceFrom: 1200 }];
const DEMO_FAVS    = [{ name: 'СТО Формула', ratingAvg: 4.9, distanceKm: 1.2, slug: 'sto-formula' }, { name: 'АвтоМастер Pro', ratingAvg: 4.8, distanceKm: 2.4, slug: 'avto-master-pro' }];
const DEMO_VEHICLES = [{ brand: 'Toyota', model: 'Corolla', year: 2018, plate: 'AA 1234 KK' }];

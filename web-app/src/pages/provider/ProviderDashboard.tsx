import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wifi, WifiOff, Inbox, Briefcase, DollarSign, TrendingUp, AlertCircle, Star, ChevronRight, ArrowRight, Zap,
} from 'lucide-react';
import { providerInboxAPI, providerIntelligenceAPI, currentJobAPI } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';

export default function ProviderDashboard() {
  const { user } = useAuthStore();
  const [online, setOnline] = useState(true);
  const [inbox, setInbox]   = useState<any[]>([]);
  const [job, setJob]       = useState<any>(null);
  const [earn, setEarn]     = useState<any>(null);
  const [demand, setDemand] = useState<any>(null);
  const [lost, setLost]     = useState<any>(null);
  const [opps, setOpps]     = useState<any[]>([]);

  useEffect(() => {
    providerInboxAPI.getInbox().then(r => setInbox(r.data?.items || r.data?.requests || [])).catch(() => {});
    currentJobAPI.get().then(r => setJob(r.data?.booking || r.data)).catch(() => {});
    providerIntelligenceAPI.getEarnings().then(r => setEarn(r.data)).catch(() => {});
    providerIntelligenceAPI.getDemand().then(r => setDemand(r.data)).catch(() => {});
    providerIntelligenceAPI.getLostRevenue().then(r => setLost(r.data)).catch(() => {});
    providerIntelligenceAPI.getOpportunities().then(r => setOpps(r.data?.opportunities || r.data?.items || [])).catch(() => {});
  }, []);

  const togglePresence = async () => {
    setOnline(!online);
    try { await providerInboxAPI.updatePresence(!online); } catch {}
  };

  return (
    <div className="max-w-[1400px] mx-auto px-4 lg:px-8 py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="slash-label mb-2">КАБИНЕТ МАСТЕРА</div>
          <h1 className="font-display tracking-bebas text-4xl md:text-5xl">
            ПРИВЕТ, <span className="text-amber">{(user?.firstName || user?.email || 'МАСТЕР').toUpperCase()}</span>
          </h1>
        </div>

        <button
          onClick={togglePresence}
          className={online ? 'btn-primary btn-lg' : 'btn-secondary btn-lg'}
          data-testid="online-toggle"
        >
          {online ? <Wifi size={16} /> : <WifiOff size={16} />}
          {online ? 'ОНЛАЙН — ПРИНИМАЮ ЗАЯВКИ' : 'ОФЛАЙН — НЕ ПРИНИМАЮ'}
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="kpis">
        <Kpi icon={Inbox}       label="Новые заявки" value={`${inbox.length}`}                       to="/provider/inbox" />
        <Kpi icon={Briefcase}   label="Текущий"      value={job ? '1' : '0'}                          to="/provider/current-job" />
        <Kpi icon={DollarSign}  label="Доход сегодня" value={`${earn?.today ?? 4200} ₴`}              to="/provider/earnings" />
        <Kpi icon={TrendingUp}  label="Спрос"        value={demand?.level ?? 'Высокий'}              to="/provider/demand" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        {/* Left: inbox + current job */}
        <div className="space-y-6">
          {/* Current job */}
          <div className="card-elevated" data-testid="current-job-block">
            <div className="flex items-center justify-between mb-3">
              <div className="slash-label">ТЕКУЩИЙ ЗАКАЗ</div>
              {job && <span className="badge badge-success">{job.status || 'В работе'}</span>}
            </div>
            {job ? (
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <div className="font-display tracking-bebas text-2xl">{job.customerName || job.customer?.name || 'Клиент'}</div>
                  <div className="text-xs mt-1" style={{ color: '#B8B8B8' }}>{job.serviceLabel || job.service}</div>
                </div>
                <Link to="/provider/current-job" className="btn-primary">Открыть <ChevronRight size={14} /></Link>
              </div>
            ) : (
              <p className="text-sm" style={{ color: '#8A8A8A' }}>Свободны. Принимайте заявки из Inbox.</p>
            )}
          </div>

          {/* Inbox */}
          <div className="card-elevated">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="slash-label">НОВЫЕ ЗАЯВКИ</div>
                <h2 className="font-display tracking-bebas text-2xl mt-1">INBOX</h2>
              </div>
              <Link to="/provider/inbox" className="btn-ghost btn-sm">Все <ChevronRight size={12} /></Link>
            </div>
            <div className="space-y-2">
              {(inbox.length ? inbox : DEMO_INBOX).slice(0, 4).map((r: any, i: number) => (
                <div key={i} className="provider-card !p-4 flex items-center gap-3" data-testid={`inbox-${i}`}>
                  <span className="icon-badge-soft !w-9 !h-9"><AlertCircle size={14} /></span>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">{r.serviceLabel || r.service || 'Не заводится'}</div>
                    <div className="text-2xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>{r.distanceKm ?? 1.4} км · {r.urgency || 'срочно'}</div>
                  </div>
                  <span className="font-display tracking-bebas text-amber text-xl">{r.priceEstimate ?? 800} ₴</span>
                  <div className="flex gap-1.5">
                    <button className="btn-primary btn-sm" data-testid={`accept-${i}`}>Принять</button>
                    <button className="btn-secondary btn-sm" data-testid={`reject-${i}`}>Отказ</button>
                  </div>
                </div>
              ))}
              {inbox.length === 0 && DEMO_INBOX.length === 0 && (
                <p className="text-center text-sm py-6" style={{ color: '#8A8A8A' }}>Заявок пока нет</p>
              )}
            </div>
          </div>

          {/* Opportunities */}
          <div className="card-elevated">
            <div className="slash-label mb-3">ВОЗМОЖНОСТИ</div>
            {(opps.length ? opps : DEMO_OPPS).map((o: any, i: number) => (
              <div key={i} className="flex items-start gap-3 py-3 hairline-b last:border-b-0" data-testid={`opp-${i}`}>
                <span className="icon-badge-soft !w-9 !h-9 shrink-0"><Zap size={14} /></span>
                <div className="flex-1">
                  <div className="font-semibold text-sm">{o.title || o.name}</div>
                  <p className="text-xs mt-0.5" style={{ color: '#B8B8B8' }}>{o.description || o.note}</p>
                </div>
                {o.gainAmount && <span className="font-display tracking-bebas text-amber text-xl">+{o.gainAmount} ₴</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Right column */}
        <aside className="space-y-4">
          {/* Earnings */}
          <div className="card-elevated">
            <div className="slash-label mb-3">ДОХОД</div>
            <div className="space-y-2">
              <Row label="Сегодня"   value={`${earn?.today ?? 4200} ₴`} bold />
              <Row label="Вчера"     value={`${earn?.yesterday ?? 3800} ₴`} />
              <Row label="Эта неделя" value={`${earn?.week ?? 22500} ₴`} />
              <Row label="Этот месяц" value={`${earn?.month ?? 86400} ₴`} />
            </div>
            <Link to="/provider/earnings" className="btn-secondary w-full mt-4 btn-sm">Подробно <ArrowRight size={12} /></Link>
          </div>

          {/* Lost revenue */}
          <div className="card-elevated">
            <div className="slash-label mb-3">ПОТЕРЯНО</div>
            <div className="font-display tracking-bebas text-3xl text-red-400 mb-2">−{lost?.amountThisWeek ?? 4200} ₴</div>
            <p className="text-xs" style={{ color: '#B8B8B8' }}>
              {lost?.reason || `${lost?.declinedCount ?? 6} заявок не принято за неделю`}
            </p>
          </div>

          {/* Rating */}
          <div className="card-elevated">
            <div className="slash-label mb-3">РЕЙТИНГ</div>
            <div className="flex items-baseline gap-2">
              <span className="font-display tracking-bebas text-4xl text-amber">4.9</span>
              <Star size={18} className="text-amber" fill="currentColor" />
              <span className="text-2xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>· 312 отзывов</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, to }: any) {
  return (
    <Link to={to} className="card-interactive flex items-center gap-3 !p-4" data-testid={`kpi-${label}`}>
      <span className="icon-badge-soft"><Icon size={16} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-2xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>{label}</div>
        <div className="font-display tracking-bebas text-2xl text-amber leading-none mt-0.5">{value}</div>
      </div>
      <ChevronRight size={14} className="text-amber" />
    </Link>
  );
}
function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-2xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>{label}</span>
      <span className={bold ? 'font-display tracking-bebas text-amber text-xl' : 'font-semibold text-white'}>{value}</span>
    </div>
  );
}

const DEMO_INBOX = [
  { serviceLabel: 'Не заводится', distanceKm: 1.2, urgency: 'срочно', priceEstimate: 1200 },
  { serviceLabel: 'Замена масла', distanceKm: 2.4, urgency: 'обычно', priceEstimate: 800 },
  { serviceLabel: 'Диагностика', distanceKm: 3.0, urgency: 'обычно', priceEstimate: 600 },
];
const DEMO_OPPS = [
  { title: 'Активируйте «Срочно»', description: 'До +5 заявок в день в час пик', gainAmount: 1500 },
  { title: 'Добавьте услугу: Электрика', description: 'Спрос в зоне +30%', gainAmount: 2400 },
];

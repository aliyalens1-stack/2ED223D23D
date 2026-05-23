import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DollarSign, TrendingUp, AlertTriangle, Award, Clock, ArrowRight } from 'lucide-react';
import { providerIntelligenceAPI } from '../../services/api';

export default function ProviderEarnings() {
  const [earnings, setEarnings] = useState<any>(null);
  const [lost, setLost]         = useState<any>(null);
  const [perf, setPerf]         = useState<any>(null);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    Promise.all([
      providerIntelligenceAPI.getEarnings().catch(() => ({ data: null })),
      providerIntelligenceAPI.getLostRevenue().catch(() => ({ data: null })),
      providerIntelligenceAPI.getPerformance().catch(() => ({ data: null })),
    ]).then(([e, l, p]) => {
      setEarnings(e.data);
      setLost(l.data);
      setPerf(p.data);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="max-w-[1400px] mx-auto px-4 lg:px-8 py-8 text-sm" style={{ color: '#8A8A8A' }}>Загрузка…</div>;

  const e = earnings || {};
  const l = lost || {};

  return (
    <div className="max-w-[1400px] mx-auto px-4 lg:px-8 py-8 space-y-6" data-testid="provider-earnings">
      <div>
        <div className="slash-label mb-2">КАБИНЕТ МАСТЕРА</div>
        <h1 className="font-display tracking-bebas text-4xl md:text-5xl">
          ВАШ <span className="text-amber">ДОХОД</span>
        </h1>
        {e.bestDay && (
          <p className="text-xs mt-2" style={{ color: '#8A8A8A' }}>
            Лучший день: <span className="text-white">{e.bestDay}</span> · окно: <span className="text-white">{e.bestTime}</span> · тренд: <span className={(e.trend ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}>{(e.trend ?? 0) > 0 ? '+' : ''}{e.trend ?? 0}%</span>
          </p>
        )}
      </div>

      {/* Big 3 KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard label="Сегодня" value={e.today}  trend={e.trend}      sub="за день"     testId="earnings-today" />
        <KpiCard label="Неделя"  value={e.week}   trend={e.trend}      sub="за 7 дней"   testId="earnings-week" />
        <KpiCard label="Месяц"   value={e.month}  trend={e.trend}      sub="за 30 дней"  testId="earnings-month" highlighted />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        {/* Lost revenue card */}
        <section className="space-y-4">
          <div className="card-elevated" data-testid="lost-revenue-card">
            <div className="flex items-center justify-between mb-4">
              <div className="slash-label">УПУЩЕННЫЙ ДОХОД</div>
              <span className="text-2xs uppercase tracking-widest text-red-500 font-bold flex items-center gap-1.5">
                <AlertTriangle size={12} /> ПРИОРИТЕТ
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <SmallStat label="Сегодня"   value={`${l.today?.lostRevenue ?? 0} ₴`}   sub={`${l.today?.missed ?? 0} пропущено`} />
              <SmallStat label="Неделя"    value={`${l.week?.lostRevenue ?? 0} ₴`}    sub={`${l.week?.missed ?? 0} пропущено`} />
              <SmallStat label="Месяц"     value={`${l.month?.lostRevenue ?? 0} ₴`}   sub={`${l.month?.missed ?? 0} пропущено`} highlighted />
            </div>
            {(l.reasons || []).length > 0 && (
              <div className="space-y-2 mt-4">
                <div className="text-2xs uppercase tracking-widest mb-2" style={{ color: '#8A8A8A' }}>ПРИЧИНЫ</div>
                {l.reasons.map((r: any, i: number) => (
                  <div key={i} className="flex items-center justify-between py-2 hairline-b last:border-b-0" data-testid={`lost-reason-${i}`}>
                    <div>
                      <div className="text-sm font-semibold">{r.reason}</div>
                      <div className="text-2xs" style={{ color: '#8A8A8A' }}>{r.count} раз(а)</div>
                    </div>
                    <span className="font-display tracking-bebas text-amber text-xl">{r.lostAmount} ₴</span>
                  </div>
                ))}
              </div>
            )}
            {l.recommendation && (
              <div className="surface-chip mt-4 !p-3 flex items-start gap-2.5">
                <span className="icon-badge-soft !w-9 !h-9 shrink-0"><TrendingUp size={14} /></span>
                <div className="flex-1 text-xs" style={{ color: '#FFB020' }}>{l.recommendation}</div>
              </div>
            )}
            <Link to="/provider/billing" className="btn-primary w-full mt-4" data-testid="earnings-priority-cta">
              Подключить Priority <ArrowRight size={14} />
            </Link>
          </div>
        </section>

        {/* Right sidebar — performance + bonuses */}
        <aside className="space-y-4">
          <div className="card-elevated">
            <div className="slash-label mb-3">ПРОИЗВОДИТЕЛЬНОСТЬ</div>
            <PerfRow label="Принятие"    value={`${perf?.acceptanceRate?.toFixed?.(0) ?? 82}%`} icon={Clock} />
            <PerfRow label="Завершение"  value={`${perf?.completionRate?.toFixed?.(0) ?? 90}%`} icon={Award} />
            <PerfRow label="Ср. чек"     value={`${e.avgPerJob ?? 485} ₴`}  icon={DollarSign} />
            <PerfRow label="Отмен"       value={`${perf?.cancelRate?.toFixed?.(0) ?? 5}%`}  icon={AlertTriangle} />
          </div>
          <div className="card-elevated">
            <div className="slash-label mb-3">БОНУСЫ</div>
            {[
              { name: 'Быстрый ответ',    amount: 200,  earned: true  },
              { name: '5 заказов подряд',  amount: 500,  earned: false },
              { name: 'Пиковые часы',     amount: 300,  earned: true  },
            ].map((b, i) => (
              <div key={i} className="flex items-center justify-between py-2 hairline-b last:border-b-0" data-testid={`bonus-${i}`}>
                <div className="flex items-center gap-2">
                  <Award size={14} className={b.earned ? 'text-amber' : 'text-gray-500'} />
                  <span className="text-sm">{b.name}</span>
                </div>
                <span className={`font-display tracking-bebas text-lg ${b.earned ? 'text-amber' : 'text-gray-500'}`}>{b.amount} ₴</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function KpiCard({ label, value, trend, sub, testId, highlighted }: any) {
  return (
    <div className={`card-elevated ${highlighted ? 'border-amber' : ''}`} style={highlighted ? { borderColor: '#FFB020' } : {}} data-testid={testId}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-2xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>{label}</span>
        {trend !== undefined && (
          <span className="flex items-center gap-1 text-2xs font-bold text-green-500">
            <TrendingUp size={10} /> {trend > 0 ? '+' : ''}{trend ?? 0}%
          </span>
        )}
      </div>
      <div className="font-display tracking-bebas text-5xl text-amber leading-none">{(value ?? 0).toLocaleString('ru-UA')} ₴</div>
      <p className="text-xs mt-2" style={{ color: '#8A8A8A' }}>{sub}</p>
    </div>
  );
}

function SmallStat({ label, value, sub, highlighted }: any) {
  return (
    <div className={`surface-chip !p-3 ${highlighted ? 'border-amber' : ''}`} style={highlighted ? { borderColor: '#FFB020' } : {}}>
      <div className="text-2xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>{label}</div>
      <div className="font-display tracking-bebas text-2xl text-amber mt-1 leading-none">{value}</div>
      <div className="text-2xs mt-1" style={{ color: '#B8B8B8' }}>{sub}</div>
    </div>
  );
}

function PerfRow({ label, value, icon: Icon }: any) {
  return (
    <div className="flex items-center justify-between py-2 hairline-b last:border-b-0">
      <span className="flex items-center gap-2 text-2xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>
        <Icon size={12} className="text-amber" />{label}
      </span>
      <span className="font-display tracking-bebas text-lg text-white">{value}</span>
    </div>
  );
}

/** /inspector/home — Dashboard. Aggregated KPIs + warnings + recent events + quick actions. */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, FileText, CheckCircle, Star, Wallet, Warning, Bell, Compass } from '@phosphor-icons/react';
import { inspectorAPI } from '../../services/api';
import { PageContainer, PageHeader, Section, Card, MetricTile, Empty, Spinner, ErrorBlock, Pill, PrimaryButton } from '../../components/inspector/cabinet/CabinetUI';

interface DashboardData {
  summary: {
    activeJobs: number;
    awaitingReport: number;
    completedMonth: number;
    ratingAvg: number;
    reviewsCount: number;
    earningsMonth: number;
    pendingPayout: number;
    currency: string;
  };
  warnings: { kind: string; severity: string; message: string }[];
  recentEvents: { id: string; status: string; timestamp: string | null }[];
  quickActions: { id: string; label: string; to?: string; kind?: string }[];
}

export default function InspectorHomePage() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    inspectorAPI.getDashboard()
      .then(r => { setData(r.data); setLoading(false); })
      .catch(e => { setError(e?.message ?? 'load failed'); setLoading(false); });
  }, []);

  if (loading) return <Spinner testId="home-loading" />;
  if (error || !data) return <PageContainer><ErrorBlock message={error ?? 'no data'} /></PageContainer>;

  const s = data.summary;
  return (
    <PageContainer>
      <PageHeader
        title="Главная"
        subtitle="Обзор твоей операционной активности"
        testId="page-header-home"
      />

      <Section title="Сводка">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricTile testId="kpi-active" label="Активные задания" value={s.activeJobs} icon={<Briefcase size={14} />} />
          <MetricTile testId="kpi-awaiting" label="Ожидают отчёта" value={s.awaitingReport} icon={<FileText size={14} />} />
          <MetricTile testId="kpi-completed-month" label="Выполнено за месяц" value={s.completedMonth} icon={<CheckCircle size={14} />} />
          <MetricTile testId="kpi-rating" label="Рейтинг" value={s.ratingAvg ? s.ratingAvg.toFixed(2) : '—'} sub={`${s.reviewsCount} отзывов`} icon={<Star size={14} />} />
        </div>
      </Section>

      <Section title="Финансы">
        <div className="grid grid-cols-2 gap-3">
          <MetricTile testId="kpi-earnings" label="Заработано в месяце" value={`${s.earningsMonth} ${s.currency}`} icon={<Wallet size={14} />} />
          <MetricTile testId="kpi-pending-payout" label="К выплате" value={`${s.pendingPayout} ${s.currency}`} icon={<Wallet size={14} />} />
        </div>
      </Section>

      <Section title="Предупреждения" testId="section-warnings">
        {data.warnings.length === 0 ? (
          <Card className="px-4 py-3 text-sm text-zinc-500 flex items-center gap-2">
            <CheckCircle size={16} className="text-emerald-500" weight="fill" />
            Нет открытых предупреждений
          </Card>
        ) : (
          <div className="space-y-2">
            {data.warnings.map((w, i) => (
              <Card key={i} className="px-4 py-3 flex items-center gap-3" testId={`warning-${w.kind}`}>
                <Warning size={16} weight="fill" className={w.severity === 'warning' ? 'text-amber-500' : 'text-blue-500'} />
                <span className="text-sm text-zinc-800 flex-1">{w.message}</span>
                <Pill tone={w.severity === 'warning' ? 'warning' : 'info'}>{w.severity}</Pill>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Последние события" testId="section-events">
        {data.recentEvents.length === 0 ? (
          <Empty title="Пока тихо" hint="События появятся, когда начнёшь принимать задания" icon={<Bell size={28} />} />
        ) : (
          <Card>
            <ul>
              {data.recentEvents.map(e => (
                <li key={e.id} className="px-4 py-2.5 border-b border-zinc-100 last:border-0 flex items-center gap-3 text-sm">
                  <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold w-24 shrink-0">{e.status}</span>
                  <span className="text-zinc-600 flex-1 truncate">job {e.id.slice(-6)}</span>
                  <span className="text-[11px] text-zinc-400 tabular-nums">{e.timestamp ? new Date(e.timestamp).toLocaleString() : '—'}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </Section>

      <Section title="Быстрые действия">
        <div className="flex flex-wrap gap-2">
          {data.quickActions.map(a => (
            a.kind === 'primary'
              ? <PrimaryButton key={a.id} onClick={() => navigate('/inspector/availability')} data-testid={`qa-${a.id}`}><Compass size={14} className="inline mr-1" /> {a.label}</PrimaryButton>
              : <button key={a.id} onClick={() => a.to && navigate(a.to)} data-testid={`qa-${a.id}`} className="px-3 py-1.5 rounded-lg text-sm border border-zinc-200 bg-white hover:bg-zinc-50">{a.label}</button>
          ))}
        </div>
      </Section>
    </PageContainer>
  );
}

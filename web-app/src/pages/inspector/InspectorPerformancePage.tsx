/** /inspector/performance — reputation & quality. */
import { useEffect, useState } from 'react';
import { Star, CheckCircle, Clock, Briefcase, XCircle, Warning } from '@phosphor-icons/react';
import { inspectorAPI } from '../../services/api';
import { PageContainer, PageHeader, Section, Card, MetricTile, Spinner, ErrorBlock, Pill } from '../../components/inspector/cabinet/CabinetUI';

interface Perf {
  ratingAvg: number; reviewsCount: number; approvalRate: number; customerAcceptanceRate: number;
  avgResponseMinutes: number; rejectedReports: number; disputesReopened: number; completedTotal: number;
  strongestBrands: { brand: string; count: number }[];
  weakSpots: { kind: string; count: number }[];
}

export default function InspectorPerformancePage() {
  const [d, setD] = useState<Perf | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inspectorAPI.getPerformance().then(r => { setD(r.data); setLoading(false); }).catch(e => { setError(e?.message ?? 'fail'); setLoading(false); });
  }, []);

  if (loading) return <Spinner testId="perf-loading" />;
  if (!d) return <PageContainer><ErrorBlock message={error ?? 'no data'} /></PageContainer>;

  return (
    <PageContainer>
      <PageHeader title="Эффективность" subtitle="Репутация, качество, скорость отклика" testId="page-header-performance" />

      <Section title="Ключевые метрики">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricTile testId="perf-rating" label="Рейтинг" value={d.ratingAvg ? d.ratingAvg.toFixed(2) : '—'} sub={`${d.reviewsCount} отзывов`} icon={<Star size={14} weight="fill" />} />
          <MetricTile testId="perf-completed" label="Проверок выполнено" value={d.completedTotal} icon={<CheckCircle size={14} weight="fill" />} />
          <MetricTile testId="perf-approval" label="Одобрено отчётов" value={`${Math.round(d.approvalRate * 100)}%`} icon={<Briefcase size={14} />} />
          <MetricTile testId="perf-customer-acceptance" label="Принято клиентом" value={`${Math.round(d.customerAcceptanceRate * 100)}%`} icon={<CheckCircle size={14} />} />
        </div>
      </Section>

      <Section title="Скорость и проблемы">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricTile testId="perf-response" label="Среднее время отклика" value={d.avgResponseMinutes > 0 ? `${Math.round(d.avgResponseMinutes)} мин` : '—'} icon={<Clock size={14} />} />
          <MetricTile testId="perf-rejected" label="Отклонённых отчётов" value={d.rejectedReports} icon={<XCircle size={14} />} />
          <MetricTile testId="perf-disputes" label="Открытых споров" value={d.disputesReopened} icon={<Warning size={14} />} />
        </div>
      </Section>

      <Section title="Сильные стороны" subtitle="Бренды, по которым больше всего опыта">
        {d.strongestBrands.length === 0 ? (
          <Card className="px-4 py-3 text-sm text-zinc-500" testId="perf-brands-empty">Ещё не накоплена статистика по брендам</Card>
        ) : (
          <Card className="p-4 flex flex-wrap gap-2" testId="perf-brands">
            {d.strongestBrands.map(b => (
              <Pill key={b.brand} tone="info">{b.brand} · {b.count}</Pill>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Слабые места">
        {d.weakSpots.length === 0 ? (
          <Card className="px-4 py-3 text-sm text-emerald-600 flex items-center gap-2" testId="perf-weak-empty">
            <CheckCircle size={16} weight="fill" /> Нет открытых проблем
          </Card>
        ) : (
          <Card className="p-4 flex flex-wrap gap-2" testId="perf-weak">
            {d.weakSpots.map((w, i) => (
              <Pill key={i} tone="warning">{w.kind} · {w.count}</Pill>
            ))}
          </Card>
        )}
      </Section>
    </PageContainer>
  );
}

/** /inspector/inspections — Archive with filters. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArrowRight } from '@phosphor-icons/react';
import { inspectorAPI } from '../../services/api';
import { PageContainer, PageHeader, Card, Empty, Spinner, ErrorBlock, Pill } from '../../components/inspector/cabinet/CabinetUI';

const FILTERS = [
  { key: 'all', label: 'Все' },
  { key: 'active', label: 'Активные' },
  { key: 'submitted', label: 'Отправлены' },
  { key: 'approved', label: 'Одобрены' },
  { key: 'rejected', label: 'Отклонены' },
  { key: 'customer_accepted', label: 'Приняты клиентом' },
  { key: 'disputed', label: 'Споры' },
];

interface Insp {
  id: string; status: string; createdAt: string | null; completedAt: string | null;
  verdict: string | null; score: number | null; customerAccepted: boolean;
  amount: number | null; currency: string;
  vehicle: { brand: string | null; model: string | null; year: number | null };
  reportUrl: string | null;
}

function verdictTone(v: string | null) {
  if (!v) return 'neutral';
  if (v.toLowerCase().includes('good') || v === 'pass') return 'success';
  if (v.toLowerCase().includes('major') || v === 'fail') return 'danger';
  return 'warning';
}

export default function InspectorInspectionsPage() {
  const [items, setItems] = useState<Insp[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = (f: string) => {
    setLoading(true); setError(null);
    inspectorAPI.getInspections(f, 50, 0)
      .then(r => { setItems(r.data.items); setTotal(r.data.total); setLoading(false); })
      .catch(e => { setError(e?.message ?? 'load failed'); setLoading(false); });
  };
  useEffect(() => { load(filter); }, [filter]);

  return (
    <PageContainer>
      <PageHeader title="Архив проверок" subtitle={`Всего: ${total}`} testId="page-header-inspections" />

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            data-testid={`filter-${f.key}`}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
              filter === f.key
                ? 'bg-zinc-900 text-white border-zinc-900'
                : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? <Spinner testId="inspections-loading" /> : error ? <ErrorBlock message={error} /> : (
        items.length === 0 ? (
          <Empty title="Нет проверок" hint="Когда выполнишь первую проверку — она появится здесь" icon={<Archive size={32} />} testId="inspections-empty" />
        ) : (
          <div className="space-y-2" data-testid="inspections-list">
            {items.map(it => (
              <Card key={it.id} className="px-4 py-3 hover:shadow-sm transition" testId={`inspection-${it.id}`}>
                <div className="flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-zinc-900 truncate">
                      {it.vehicle.brand || '—'} {it.vehicle.model || ''} {it.vehicle.year ? `· ${it.vehicle.year}` : ''}
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      {it.completedAt ? new Date(it.completedAt).toLocaleString() : (it.createdAt ? new Date(it.createdAt).toLocaleString() : '—')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {it.verdict && <Pill tone={verdictTone(it.verdict) as 'success' | 'warning' | 'danger' | 'neutral'}>{it.verdict}</Pill>}
                    {it.score != null && <Pill tone="info">{it.score} / 100</Pill>}
                    {it.customerAccepted && <Pill tone="success">принято</Pill>}
                    <Pill>{it.status}</Pill>
                    {it.amount != null && <span className="text-sm font-bold tabular-nums text-zinc-900">{it.amount} {it.currency}</span>}
                    {it.reportUrl && (
                      <Link to={it.reportUrl} className="text-amber-600 hover:text-amber-700 flex items-center text-xs font-semibold gap-0.5">
                        Отчёт <ArrowRight size={12} />
                      </Link>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )
      )}
    </PageContainer>
  );
}

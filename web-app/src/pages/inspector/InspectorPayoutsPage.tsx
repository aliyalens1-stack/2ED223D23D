/** /inspector/payouts — financial cabinet. */
import { useEffect, useState } from 'react';
import { Wallet, ClockCounterClockwise, FileText, Bank } from '@phosphor-icons/react';
import { inspectorAPI } from '../../services/api';
import { PageContainer, PageHeader, Section, Card, MetricTile, Spinner, ErrorBlock, Pill, Field, TextInput, GhostButton } from '../../components/inspector/cabinet/CabinetUI';

interface Payouts {
  summary: { earningsMonth: number; pendingPayout: number; paidTotal: number; pendingReports: number; currency: string };
  history: { id: string; amount: number; currency: string; status: string; createdAt: string | null; paidAt: string | null; method: string }[];
  bank: { iban: string | null; bic: string | null; holderName: string | null; country: string | null };
  note: string;
}

function tone(s: string): 'success' | 'warning' | 'neutral' {
  if (s === 'paid') return 'success';
  if (s === 'pending' || s === 'scheduled') return 'warning';
  return 'neutral';
}

export default function InspectorPayoutsPage() {
  const [d, setD] = useState<Payouts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inspectorAPI.getPayouts().then(r => { setD(r.data); setLoading(false); }).catch(e => { setError(e?.message ?? 'fail'); setLoading(false); });
  }, []);

  if (loading) return <Spinner testId="payouts-loading" />;
  if (!d) return <PageContainer><ErrorBlock message={error ?? 'no data'} /></PageContainer>;

  const s = d.summary;
  return (
    <PageContainer>
      <PageHeader title="Выплаты" subtitle="Заработок и история переводов" testId="page-header-payouts" />

      <Section title="Обзор">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricTile testId="pay-earnings" label="Заработано в месяце" value={`${s.earningsMonth} ${s.currency}`} icon={<Wallet size={14} />} />
          <MetricTile testId="pay-pending" label="Ожидает выплаты" value={`${s.pendingPayout} ${s.currency}`} icon={<ClockCounterClockwise size={14} />} />
          <MetricTile testId="pay-paid-total" label="Всего выплачено" value={`${s.paidTotal} ${s.currency}`} icon={<Wallet size={14} />} />
          <MetricTile testId="pay-pending-reports" label="Отчётов без выплат" value={s.pendingReports} icon={<FileText size={14} />} />
        </div>
      </Section>

      <Section title="История выплат">
        {d.history.length === 0 ? (
          <Card className="px-4 py-6 text-center text-sm text-zinc-500" testId="payouts-history-empty">
            Выплат ещё не было. Они появятся, когда отчёты пройдут QA и клиент примет проверку.
          </Card>
        ) : (
          <Card>
            <ul>
              {d.history.map(p => (
                <li key={p.id} className="px-4 py-3 border-b border-zinc-100 last:border-0 flex items-center gap-4 text-sm" data-testid={`payout-${p.id}`}>
                  <span className="font-bold tabular-nums">{p.amount} {p.currency}</span>
                  <Pill tone={tone(p.status)}>{p.status}</Pill>
                  <span className="text-xs text-zinc-500 flex-1">{p.method}</span>
                  <span className="text-[11px] text-zinc-400 tabular-nums">{(p.paidAt || p.createdAt) ? new Date((p.paidAt || p.createdAt)!).toLocaleString() : '—'}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </Section>

      <Section title="Банковский счёт" subtitle={d.note}>
        <Card className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4" testId="payouts-bank">
          <Field label="IBAN"><TextInput defaultValue={d.bank.iban ?? ''} placeholder="DE00 0000 0000 0000 0000 00" disabled /></Field>
          <Field label="BIC"><TextInput defaultValue={d.bank.bic ?? ''} placeholder="—" disabled /></Field>
          <Field label="Имя владельца"><TextInput defaultValue={d.bank.holderName ?? ''} placeholder="—" disabled /></Field>
          <Field label="Страна"><TextInput defaultValue={d.bank.country ?? ''} placeholder="DE" disabled /></Field>
          <div className="md:col-span-2 flex items-center gap-2">
            <Bank size={16} className="text-zinc-400" />
            <span className="text-xs text-zinc-500">Подключение реального банка появится позже</span>
            <span className="flex-1" />
            <GhostButton disabled data-testid="payouts-link-bank">Привязать банк (скоро)</GhostButton>
          </div>
        </Card>
      </Section>
    </PageContainer>
  );
}

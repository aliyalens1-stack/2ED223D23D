import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Phone, MapPin, User, CheckCircle, Spinner } from '@phosphor-icons/react';
import type { InspectionJob, InspectionJobTimelineEvent } from '@platform/domain/contracts/inspection-job';
import { inspectionJobViewModel } from '@platform/domain/state-machines/inspection-job';
import { formatCurrency, formatRelative, formatDateTime } from '@platform/domain/formatters';
import { inspectorAPI } from '../../services/api';
import StatusToolbar from './StatusToolbar';
import TimelineRail from './TimelineRail';

interface Props {
  job: InspectionJob | null;
  loading: boolean;
  onChanged: () => void;
}

/**
 * ActiveJobPanel — right pane, light theme.
 * Pure presentational + action delegation.
 */
export default function ActiveJobPanel({ job, loading, onChanged }: Props) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language === 'ru' ? 'ru-RU' : i18n.language === 'de' ? 'de-DE' : 'en-US') as any;

  const [timeline, setTimeline] = useState<InspectionJobTimelineEvent[]>([]);
  const [actionInFlight, setActionInFlight] = useState(false);

  const fetchTimeline = useCallback(async (jobId: string) => {
    try {
      const { data } = await inspectorAPI.getJobTimeline(jobId);
      setTimeline(data?.events ?? []);
    } catch {
      setTimeline([]);
    }
  }, []);

  useEffect(() => {
    if (!job?.id) { setTimeline([]); return; }
    fetchTimeline(job.id);
  }, [job?.id, fetchTimeline]);

  if (loading && !job) {
    return (
      <div className="p-12 flex items-center justify-center h-full">
        <Spinner size={32} className="animate-spin" style={{ color: '#FFB020' }} />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="p-8 text-zinc-500 text-sm" data-testid="active-job-not-found">
        {t('inspector.detail.not_found', { defaultValue: 'Задание не найдено.' })}
      </div>
    );
  }

  const vm = inspectionJobViewModel(job);

  const runAction = async (fn: () => Promise<unknown>) => {
    setActionInFlight(true);
    try {
      await fn();
      await Promise.all([
        onChanged(),
        fetchTimeline(job.id),
      ]);
    } finally {
      setActionInFlight(false);
    }
  };

  return (
    <div data-testid="active-job-panel">
      {/* Brief header — dense, no marketing padding. */}
      <div className="px-8 py-6" style={{ background: '#ffffff', borderBottom: '1px solid #ececec' }}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] font-bold text-zinc-500 mb-2">
              <span style={{ color: '#b45309' }}>{t(vm.statusI18nKey, { defaultValue: vm.statusFallback })}</span>
              <span className="text-zinc-300">·</span>
              <span>{t('inspector.detail.updated', { defaultValue: 'обновлено' })} {formatRelative(job.updatedAt, locale)}</span>
            </div>
            <h1 className="text-3xl font-black text-zinc-900 truncate" style={{ letterSpacing: '-0.02em' }}>
              {job.brief.vehicleSummary}
            </h1>
            <p className="text-sm text-zinc-500 mt-1.5">{job.brief.serviceLabel}</p>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-zinc-500">
              {t('inspector.detail.fee', { defaultValue: 'Гонорар инспектора' })}
            </div>
            <div className="text-3xl font-black tabular-nums mt-1" style={{ color: '#b45309' }} data-testid="job-fee">
              {formatCurrency(job.brief.feeEur, 'EUR', locale)}
            </div>
          </div>
        </div>
      </div>

      {/* Status toolbar. */}
      <StatusToolbar vm={vm} job={job} disabled={actionInFlight} runAction={runAction} />

      {/* Body: main info | timeline rail. */}
      <div className="grid grid-cols-12 gap-0" style={{ background: '#fafafa' }}>
        <div className="col-span-12 lg:col-span-8 p-8 space-y-6">
          <Block label={t('inspector.detail.location', { defaultValue: 'Местоположение' })} icon={<MapPin size={14} />}>
            <div className="text-sm text-zinc-900 font-medium">{job.brief.cityLabel}</div>
            {job.brief.address && <div className="text-xs text-zinc-500 mt-0.5">{job.brief.address}</div>}
          </Block>

          <Block label={t('inspector.detail.customer', { defaultValue: 'Клиент' })} icon={<User size={14} />}>
            <div className="text-sm text-zinc-900 font-medium">
              {job.brief.customerName ??
                t('inspector.detail.customer_masked', {
                  defaultValue: 'Клиент подтверждён',
                })}
            </div>
            {job.brief.customerPhone ? (
              <a
                href={`tel:${job.brief.customerPhone}`}
                className="text-xs mt-1 inline-flex items-center gap-1 font-medium hover:underline"
                style={{ color: '#b45309' }}
              >
                <Phone size={12} /> {job.brief.customerPhone}
              </a>
            ) : (
              <div className="text-[11px] text-zinc-500 mt-1">
                {t('inspector.detail.customer_contact_after_arrive', {
                  defaultValue: 'Контакт откроется после выезда',
                })}
              </div>
            )}
          </Block>

          <Block label={t('inspector.detail.lifecycle', { defaultValue: 'История' })} icon={<CheckCircle size={14} />}>
            <div className="text-xs text-zinc-500">
              {t('inspector.detail.claimed_at', { defaultValue: 'Принято в работу' })}:{' '}
              <span className="text-zinc-900 font-medium tabular-nums">{formatDateTime(job.claimedAt, locale)}</span>
            </div>
            {job.cancelReason && (
              <div className="mt-1 text-xs text-red-600">
                {t('inspector.detail.cancel_reason', { defaultValue: 'Отменено' })}: {job.cancelReason}
              </div>
            )}
          </Block>
        </div>

        <aside
          className="col-span-12 lg:col-span-4 p-8"
          style={{ background: '#ffffff', borderLeft: '1px solid #ececec' }}
        >
          <TimelineRail events={timeline} locale={locale} />
        </aside>
      </div>
    </div>
  );
}

function Block({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-4" style={{ background: '#ffffff', border: '1px solid #ececec' }}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] font-bold text-zinc-500 mb-2">
        <span style={{ color: '#FFB020' }}>{icon}</span>
        {label}
      </div>
      {children}
    </div>
  );
}

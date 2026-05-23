import { useTranslation } from 'react-i18next';
import { Clock, MapPin, Wrench, CheckCircle, XCircle, ChartBar, Lightning } from '@phosphor-icons/react';
import type { InspectionJob, InspectorExposure, InspectionJobStatus } from '@platform/domain/contracts/inspection-job';
import { canClaim } from '@platform/domain/state-machines/inspection-job';
import { formatRelative, formatCurrency } from '@platform/domain/formatters';

interface Props {
  jobs: InspectionJob[];
  exposures: InspectorExposure[];
  activeId: string | null;
  loading: boolean;
  onSelectJob: (id: string) => void;
  onClaimExposure: (exposureId: string) => void;
}

const STATUS_DOT: Record<InspectionJobStatus, string> = {
  claimed:      'bg-amber-500',
  on_route:     'bg-violet-500',
  arrived:      'bg-emerald-500',
  inspecting:   'bg-blue-500',
  report_ready: 'bg-cyan-500',
  completed:    'bg-zinc-400',
  cancelled:    'bg-red-500',
};

/**
 * JobsRail — left pane. Light theme, dense rows, amber-accent on hover/active.
 */
export default function JobsRail({ jobs, exposures, activeId, loading, onSelectJob, onClaimExposure }: Props) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.language === 'ru' ? 'ru-RU' : i18n.language === 'de' ? 'de-DE' : 'en-US') as any;

  const openExposures = exposures.filter(e => e.status === 'open');
  const activeJobs    = jobs.filter(j => j.status !== 'completed' && j.status !== 'cancelled');
  const archivedJobs  = jobs.filter(j => j.status === 'completed' || j.status === 'cancelled');

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {[0,1,2,3].map(i => <div key={i} className="h-14 rounded animate-pulse" style={{ background: '#f4f4f5' }} />)}
      </div>
    );
  }

  const hasAnything = openExposures.length + activeJobs.length + archivedJobs.length > 0;
  if (!hasAnything) {
    return (
      <div className="p-6 text-center" data-testid="rail-empty">
        <div
          className="inline-flex w-12 h-12 rounded-xl items-center justify-center mb-3"
          style={{ background: 'rgba(255,176,32,0.14)', color: '#b45309' }}
        >
          <Lightning size={22} weight="fill" />
        </div>
        <p className="text-sm font-bold text-zinc-900">
          {t('inspector.rail.empty_title', { defaultValue: 'Пока нет заданий' })}
        </p>
        <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">
          {t('inspector.rail.empty_hint', { defaultValue: 'Новые предложения появятся здесь автоматически.' })}
        </p>
      </div>
    );
  }

  return (
    <div className="py-2" data-testid="rail-content">
      {openExposures.length > 0 && (
        <Section
          title={t('inspector.rail.section_offers', { defaultValue: 'Открытые предложения' })}
          count={openExposures.length}
          icon={<Lightning size={12} weight="fill" style={{ color: '#FFB020' }} />}
        >
          {openExposures.map(exp => (
            <button
              key={exp.id}
              onClick={() => onClaimExposure(exp.id)}
              className="w-full text-left px-4 py-3 hover:bg-amber-50/60 transition flex flex-col gap-1 border-l-2 disabled:opacity-50"
              style={{ borderLeftColor: '#FFB020' }}
              data-testid={`exposure-row-${exp.id}`}
              disabled={!canClaim(exp)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-zinc-900 truncate">
                  {exp.preview.vehicleSummary || exp.preview.serviceLabel}
                </span>
                {exp.preview.budgetEur != null && (
                  <span className="text-sm font-black tabular-nums" style={{ color: '#b45309' }}>
                    {formatCurrency(exp.preview.budgetEur, 'EUR', locale)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                <MapPin size={11} /> {exp.preview.cityLabel || '—'}
                <span className="text-zinc-300">·</span>
                <Clock size={11} /> {formatRelative(exp.expiresAt, locale)}
                {exp.score > 0 && (<><span className="text-zinc-300">·</span><ChartBar size={11} /> {(exp.score * 100).toFixed(0)}</>)}
              </div>
            </button>
          ))}
        </Section>
      )}

      {activeJobs.length > 0 && (
        <Section
          title={t('inspector.rail.section_active', { defaultValue: 'Активные задания' })}
          count={activeJobs.length}
          icon={<Wrench size={12} weight="fill" className="text-emerald-600" />}
        >
          {activeJobs.map(job => (
            <JobRow key={job.id} job={job} active={job.id === activeId} onClick={() => onSelectJob(job.id)} />
          ))}
        </Section>
      )}

      {archivedJobs.length > 0 && (
        <Section
          title={t('inspector.rail.section_archive', { defaultValue: 'Архив' })}
          count={archivedJobs.length}
          icon={<CheckCircle size={12} weight="fill" className="text-zinc-400" />}
          muted
        >
          {archivedJobs.slice(0, 10).map(job => (
            <JobRow key={job.id} job={job} active={job.id === activeId} onClick={() => onSelectJob(job.id)} muted />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, count, icon, muted, children }: { title: string; count: number; icon: React.ReactNode; muted?: boolean; children: React.ReactNode }) {
  return (
    <div className={muted ? 'opacity-70' : ''}>
      <div
        className="px-4 py-2 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] font-bold text-zinc-500 sticky top-0 backdrop-blur z-10"
        style={{ background: 'rgba(255,255,255,0.92)', borderBottom: '1px solid #f4f4f5' }}
      >
        {icon}
        <span>{title}</span>
        <span className="text-zinc-300">·</span>
        <span className="tabular-nums">{count}</span>
      </div>
      <div>{children}</div>
    </div>
  );
}

function JobRow({ job, active, onClick, muted }: { job: InspectionJob; active: boolean; onClick: () => void; muted?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 transition border-l-2 flex flex-col gap-1 ${
        active ? 'bg-amber-50' : 'border-transparent hover:bg-zinc-50'
      }`}
      style={active ? { borderLeftColor: '#FFB020' } : { borderLeftColor: 'transparent' }}
      data-testid={`job-row-${job.id}`}
      aria-current={active ? 'true' : undefined}
    >
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${STATUS_DOT[job.status]}`} aria-hidden />
        <span
          className={`text-sm font-bold truncate ${muted ? 'text-zinc-500' : 'text-zinc-900'}`}
        >
          {job.brief.vehicleSummary}
        </span>
        {job.status === 'cancelled' && <XCircle size={13} className="text-red-500 ml-auto flex-shrink-0" />}
      </div>
      <div className="text-[11px] text-zinc-500 truncate flex items-center gap-1.5 pl-4">
        <MapPin size={10} /> {job.brief.cityLabel} <span className="text-zinc-300">·</span> {job.brief.serviceLabel}
      </div>
    </button>
  );
}

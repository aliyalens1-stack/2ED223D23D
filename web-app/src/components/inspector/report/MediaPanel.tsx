import { useTranslation } from 'react-i18next';
import { Image as ImageIcon, FileText, MapPin, Wrench } from '@phosphor-icons/react';
import type { InspectionJob } from '@platform/domain/contracts/inspection-job';

interface Props { job: InspectionJob; }

/**
 * MediaPanel — right rail, light theme high-contrast.
 * Pre-submit: dashed empty-state. Post-submit (1.1B.2): media grid.
 */
export default function MediaPanel({ job }: Props) {
  const { t } = useTranslation();

  return (
    <div className="p-5" data-testid="media-panel-content">
      <div className="text-[11px] uppercase tracking-[0.18em] font-black text-zinc-900 mb-3 flex items-center gap-1.5">
        <ImageIcon size={14} weight="fill" style={{ color: '#FFB020' }} />
        {t('inspector.report.media_title', { defaultValue: 'Медиа' })}
      </div>

      <div
        className="rounded-xl p-5 text-center"
        style={{ background: '#fafafa', border: '1px dashed #d4d4d8' }}
      >
        <div
          className="inline-flex w-12 h-12 rounded-xl items-center justify-center mb-3"
          style={{ background: 'rgba(255,176,32,0.14)', color: '#b45309' }}
        >
          <FileText size={22} weight="duotone" />
        </div>
        <p className="text-[13px] font-bold text-zinc-900 leading-snug">
          {t('inspector.report.media_post_submit_only', {
            defaultValue: 'Фото и видео появятся после отправки отчёта',
          })}
        </p>
        <p className="text-[11px] text-zinc-600 mt-1.5 leading-relaxed">
          {t('inspector.report.media_hint', {
            defaultValue:
              'Снимайте на месте через мобильное приложение. После отправки здесь появится полная сетка для просмотра.',
          })}
        </p>
      </div>

      {/* Job context — persistent reference, high-contrast. */}
      <div className="mt-5 pt-5" style={{ borderTop: '1px solid #e5e5e5' }}>
        <div className="text-[11px] uppercase tracking-[0.18em] font-black text-zinc-900 mb-2.5">
          {t('inspector.report.job_brief', { defaultValue: 'Контекст задания' })}
        </div>
        <div className="space-y-2">
          <div className="text-[15px] font-black text-zinc-900" style={{ letterSpacing: '-0.01em' }}>
            {job.brief.vehicleSummary}
          </div>
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-700">
            <Wrench size={12} style={{ color: '#FFB020' }} weight="fill" />
            {job.brief.serviceLabel}
          </div>
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-700">
            <MapPin size={12} style={{ color: '#FFB020' }} weight="fill" />
            {job.brief.cityLabel}
          </div>
          {job.brief.address && (
            <div className="text-[11px] text-zinc-500 leading-relaxed pl-4">{job.brief.address}</div>
          )}
        </div>
      </div>
    </div>
  );
}

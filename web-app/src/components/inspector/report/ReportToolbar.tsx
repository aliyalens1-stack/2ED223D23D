import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowUUpLeft, FileText, Spinner, CheckCircle, FloppyDisk, WifiX, Warning } from '@phosphor-icons/react';
import type { InspectionJob } from '@platform/domain/contracts/inspection-job';
import type { DraftSaveState } from '@platform/domain/contracts/inspection-report';
import type { ValidationResult } from '@platform/domain/state-machines/inspection-report';
import { formatRelative } from '@platform/domain/formatters';

interface Props {
  job: InspectionJob;
  saveState: DraftSaveState;
  savedAt: string | null;
  validation: ValidationResult | null;
  editable: boolean;
  submitting: boolean;
  onSubmit: () => void;
  connectionError: boolean;
}

/**
 * ReportToolbar — light theme persistent header.
 * High-contrast: black text, white bg, red/amber/emerald accents.
 */
export default function ReportToolbar({
  job, saveState, savedAt, validation, editable, submitting, onSubmit, connectionError,
}: Props) {
  const { t } = useTranslation();
  const canSubmitNow = editable && !submitting && validation?.valid;

  return (
    <div style={{ background: '#ffffff', borderBottom: '1px solid #e5e5e5' }} data-testid="report-toolbar">
      <div className="px-5 h-14 flex items-center gap-4">
        <Link
          to={`/inspector/jobs/${job.id}`}
          className="flex items-center gap-1.5 text-xs font-bold text-zinc-900 hover:bg-zinc-100 px-2.5 py-1.5 rounded-lg transition"
          data-testid="back-to-job"
        >
          <ArrowUUpLeft size={14} weight="bold" />
          {t('inspector.report.back_to_detail', { defaultValue: 'К заданию' })}
        </Link>

        <div className="h-6 w-px" style={{ background: '#e5e5e5' }} aria-hidden />

        <div className="flex items-center gap-2 min-w-0">
          <FileText size={16} weight="fill" style={{ color: '#FFB020' }} className="flex-shrink-0" />
          <span className="text-sm font-bold text-zinc-900 truncate" data-testid="report-job-title">
            {t('inspector.report.title_for', { defaultValue: 'Отчёт' })}
            <span className="text-zinc-300 mx-1.5">·</span>
            <span className="text-zinc-700">{job.brief.vehicleSummary}</span>
          </span>
        </div>

        <div className="flex-1" />

        {/* Autosave indicator. */}
        <div className="text-[12px] flex items-center gap-1.5 tabular-nums font-medium" data-testid="autosave-indicator">
          {saveState === 'saving' && (
            <>
              <Spinner size={12} className="animate-spin" style={{ color: '#FFB020' }} />
              <span style={{ color: '#b45309' }}>{t('inspector.report.saving', { defaultValue: 'Сохранение…' })}</span>
            </>
          )}
          {saveState === 'saved' && savedAt && (
            <>
              <FloppyDisk size={12} weight="fill" className="text-emerald-700" />
              <span className="text-emerald-700">
                {t('inspector.report.saved', { defaultValue: 'Сохранено' })} · {formatRelative(savedAt)}
              </span>
            </>
          )}
          {saveState === 'idle' && (
            <span className="text-zinc-600">{t('inspector.report.draft', { defaultValue: 'Черновик' })}</span>
          )}
          {saveState === 'error' && (
            <>
              <Warning size={12} weight="fill" className="text-red-700" />
              <span className="text-red-700">{t('inspector.report.save_failed', { defaultValue: 'Не сохранилось' })}</span>
            </>
          )}
        </div>

        {connectionError && (
          <span
            className="flex items-center gap-1 text-[12px] font-bold px-2 py-1 rounded"
            style={{ background: '#fef3c7', color: '#b45309' }}
            data-testid="report-connection-warning"
          >
            <WifiX size={12} /> {t('inspector.report.offline', { defaultValue: 'Офлайн' })}
          </span>
        )}

        <div className="h-6 w-px" style={{ background: '#e5e5e5' }} aria-hidden />

        <div className="flex items-center gap-2">
          {validation && !validation.valid && validation.reasons.length > 0 && (
            <span
              className="text-[11px] text-zinc-600 max-w-[260px] truncate font-medium"
              title={validation.reasons.join(', ')}
              data-testid="validation-hint"
            >
              {t('inspector.report.cannot_submit_yet', { defaultValue: 'Ещё не готово' })}
              {validation.uncheckedCount > 0 && ` · ${validation.uncheckedCount} ${t('inspector.report.unchecked', { defaultValue: 'не проверено' })}`}
            </span>
          )}
          <button
            onClick={onSubmit}
            disabled={!canSubmitNow}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-black rounded-lg transition disabled:cursor-not-allowed hover:brightness-95"
            style={{
              background: canSubmitNow ? '#FFB020' : '#fde68a',
              color: canSubmitNow ? '#0a0a0a' : '#a16207',
              opacity: canSubmitNow ? 1 : 0.7,
            }}
            data-testid="submit-report-btn"
          >
            {submitting ? <Spinner size={12} className="animate-spin" /> : <CheckCircle size={12} weight="fill" />}
            {t('inspector.report.submit', { defaultValue: 'Отправить отчёт' })}
          </button>
        </div>
      </div>
    </div>
  );
}

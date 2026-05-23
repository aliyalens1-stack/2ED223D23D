import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Car, MapPin, CheckCircle, FileText, Prohibit, ArrowRight, Spinner } from '@phosphor-icons/react';
import type { InspectionJob } from '@platform/domain/contracts/inspection-job';
import type { InspectionJobViewModel } from '@platform/domain/state-machines/inspection-job';
import { inspectorAPI } from '../../services/api';

type VM = InspectionJobViewModel & { status: InspectionJob['status'] };

interface Props {
  vm: VM;
  job: InspectionJob;
  disabled: boolean;
  runAction: (fn: () => Promise<unknown>) => Promise<void>;
}

/**
 * StatusToolbar — light theme. Every state-changing verb the inspector
 * can perform on the active job. Capabilities flow in, actions flow out.
 */
export default function StatusToolbar({ vm, job, disabled, runAction }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const noActions =
    !vm.canStartRoute &&
    !vm.canMarkArrived &&
    !vm.canStartInspection &&
    !vm.canSubmitReport &&
    !vm.canCancel;

  if (noActions) {
    return (
      <div
        className="px-8 py-4 text-xs text-zinc-500"
        style={{ background: '#fafafa', borderBottom: '1px solid #ececec' }}
        data-testid="status-toolbar-empty"
      >
        {vm.isTerminal
          ? t('inspector.toolbar.terminal', { defaultValue: 'Действий больше нет — задание закрыто.' })
          : t('inspector.toolbar.waiting', { defaultValue: 'Ожидание действия клиента или системы.' })}
      </div>
    );
  }

  return (
    <div
      className="px-8 py-4 flex flex-wrap items-center gap-2"
      style={{ background: '#fafafa', borderBottom: '1px solid #ececec' }}
      data-testid="status-toolbar"
    >
      {disabled && <Spinner size={14} className="animate-spin mr-1" style={{ color: '#FFB020' }} />}

      {vm.canStartRoute && (
        <PrimaryBtn
          icon={<Car size={14} weight="bold" />}
          label={t('inspector.toolbar.on_route', { defaultValue: 'Выехать' })}
          disabled={disabled}
          onClick={() => runAction(() => inspectorAPI.markOnRoute(job.id))}
          testId="action-on-route"
        />
      )}

      {vm.canMarkArrived && (
        <PrimaryBtn
          icon={<MapPin size={14} weight="bold" />}
          label={t('inspector.toolbar.arrived', { defaultValue: 'На месте' })}
          disabled={disabled}
          onClick={() => runAction(() => inspectorAPI.markArrived(job.id))}
          testId="action-arrived"
        />
      )}

      {vm.canStartInspection && (
        <PrimaryBtn
          icon={<CheckCircle size={14} weight="bold" />}
          label={t('inspector.toolbar.start_inspection', { defaultValue: 'Начать проверку' })}
          disabled={disabled}
          onClick={() => runAction(() => inspectorAPI.startInspection(job.id))}
          testId="action-start-inspection"
        />
      )}

      {vm.canSubmitReport && (
        <PrimaryBtn
          icon={<FileText size={14} weight="bold" />}
          label={t('inspector.toolbar.open_report', { defaultValue: 'Открыть отчёт' })}
          disabled={disabled}
          onClick={() => navigate(`/inspector/jobs/${job.id}/report`)}
          testId="open-report-workstation"
        />
      )}

      <div className="flex-1" />

      {vm.canCancel && (
        <button
          disabled={disabled}
          onClick={() => {
            if (window.confirm(t('inspector.toolbar.cancel_confirm', { defaultValue: 'Отменить эту проверку? Клиент получит уведомление.' }))) {
              runAction(() => inspectorAPI.cancelJob(job.id));
            }
          }}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg transition disabled:opacity-50 hover:bg-red-100"
          style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }}
          data-testid="action-cancel"
        >
          <Prohibit size={14} weight="bold" /> {t('inspector.toolbar.cancel', { defaultValue: 'Отменить' })}
        </button>
      )}
    </div>
  );
}

function PrimaryBtn({ icon, label, onClick, disabled, testId }: { icon: React.ReactNode; label: string; onClick: () => void; disabled: boolean; testId: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-black rounded-lg transition disabled:opacity-50 hover:brightness-95"
      style={{ background: '#FFB020', color: '#0a0a0a' }}
    >
      {icon} {label} <ArrowRight size={12} className="opacity-60" />
    </button>
  );
}

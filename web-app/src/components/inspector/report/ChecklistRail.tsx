import { useTranslation } from 'react-i18next';
import { CheckCircle, Warning, XCircle, Circle } from '@phosphor-icons/react';
import {
  CHECKLIST_GROUPS_ORDER,
  type ReportDraft,
} from '@platform/domain/contracts/inspection-report';
import { groupCompletion } from '@platform/domain/state-machines/inspection-report';

interface Props {
  draft: ReportDraft;
  activeGroup: string;
  onGroupClick: (group: string) => void;
}

/**
 * ChecklistRail — left rail, light theme high-contrast.
 */
export default function ChecklistRail({ draft, activeGroup, onGroupClick }: Props) {
  const { t } = useTranslation();

  return (
    <div className="py-3" data-testid="checklist-rail-content">
      <div className="px-4 py-2 text-[10px] uppercase tracking-[0.18em] font-bold text-zinc-600">
        {t('inspector.report.checklist_title', { defaultValue: 'Чек-лист' })}
      </div>
      {CHECKLIST_GROUPS_ORDER.filter(g => groupCompletion(draft, g).total > 0).map(group => {
        const c = groupCompletion(draft, group);
        const active = group === activeGroup;
        const allOk = c.checked === c.total && c.problemCount === 0 && c.warningCount === 0;
        return (
          <button
            key={group}
            onClick={() => onGroupClick(group)}
            className={`w-full text-left px-4 py-3 transition border-l-2 ${
              active ? 'bg-amber-50' : 'border-transparent hover:bg-zinc-100'
            }`}
            style={active ? { borderLeftColor: '#FFB020' } : { borderLeftColor: 'transparent' }}
            data-testid={`checklist-group-${group}`}
            aria-current={active ? 'true' : undefined}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className="text-[12px] font-black uppercase tracking-wide truncate"
                style={{ color: active ? '#0a0a0a' : '#27272a', letterSpacing: '0.04em' }}
              >
                {t(`inspector.checklist.group.${group}`, { defaultValue: group.replace(/_/g, ' ') })}
              </span>
              <span
                className="text-[11px] tabular-nums font-bold flex-shrink-0"
                style={{ color: active ? '#b45309' : '#52525b' }}
              >
                {c.checked}/{c.total}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1.5 text-[11px] font-bold">
              {allOk ? (
                <span className="flex items-center gap-1 text-emerald-700">
                  <CheckCircle size={12} weight="fill" />
                  {t('inspector.report.all_ok', { defaultValue: 'Всё ОК' })}
                </span>
              ) : (
                <>
                  {c.okCount > 0 && (
                    <span className="flex items-center gap-0.5 text-emerald-700">
                      <CheckCircle size={11} weight="fill" /> {c.okCount}
                    </span>
                  )}
                  {c.warningCount > 0 && (
                    <span className="flex items-center gap-0.5" style={{ color: '#b45309' }}>
                      <Warning size={11} weight="fill" /> {c.warningCount}
                    </span>
                  )}
                  {c.problemCount > 0 && (
                    <span className="flex items-center gap-0.5 text-red-700">
                      <XCircle size={11} weight="fill" /> {c.problemCount}
                    </span>
                  )}
                  {c.checked < c.total && (
                    <span className="flex items-center gap-0.5 text-zinc-500">
                      <Circle size={11} /> {c.total - c.checked}
                    </span>
                  )}
                </>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { CheckCircle, Warning, XCircle, Circle, Plus, X } from '@phosphor-icons/react';
import {
  CHECKLIST_TEMPLATE,
  REPORT_VERDICTS,
  ISSUE_SEVERITIES,
  CHECKLIST_ITEM_STATUSES,
  type ReportDraft,
  type ChecklistItemStatus,
  type ReportVerdict,
  type ReportIssue,
  type IssueSeverity,
} from '@platform/domain/contracts/inspection-report';

interface Props {
  draft: ReportDraft;
  editable: boolean;
  activeGroup: string;
  onChange: (next: ReportDraft) => void;
}

/**
 * Status visuals — light theme, high contrast.
 * OK = emerald (success), WARN = amber, ISSUE = red (German-flag red).
 */
const STATUS_VISUAL: Record<ChecklistItemStatus, { icon: any; bg: string; border: string; color: string; label: string }> = {
  ok:          { icon: CheckCircle, bg: '#d1fae5', border: '#10b981', color: '#065f46', label: 'OK' },
  warning:     { icon: Warning,     bg: '#fef3c7', border: '#FFB020', color: '#92400e', label: 'WARN' },
  problem:     { icon: XCircle,     bg: '#fee2e2', border: '#DD0000', color: '#991b1b', label: 'ISSUE' },
  not_checked: { icon: Circle,      bg: '#ffffff', border: '#d4d4d8', color: '#52525b', label: '—' },
};

const VERDICT_VISUAL: Record<ReportVerdict, { bg: string; border: string; color: string }> = {
  recommended:      { bg: '#d1fae5', border: '#10b981', color: '#065f46' },
  risky:            { bg: '#fef3c7', border: '#FFB020', color: '#92400e' },
  not_recommended:  { bg: '#fee2e2', border: '#DD0000', color: '#991b1b' },
};

const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  low: 'Низкая', medium: 'Средняя', high: 'Высокая',
};

/** Friendly RU labels for checklist items — fallback if i18n missing. */
const ITEM_LABEL_RU: Record<string, string> = {
  vin: 'VIN-номер',
  service_history: 'История обслуживания',
  ownership_count: 'Количество владельцев',
  registration: 'Регистрация',
  tuv_hu: 'ТО / TÜV (HU)',
  exterior_panels: 'Внешние панели кузова',
  paint_uniform: 'Равномерность ЛКП',
  paint_thickness: 'Толщина ЛКП',
  paint_overspray: 'Перекрашенные элементы',
  body_alignment: 'Геометрия кузова',
  rust: 'Коррозия',
  engine_idle: 'Работа на холостых',
  engine_oil: 'Моторное масло',
  engine_leaks: 'Подтёки',
  engine_smoke: 'Выхлоп / дым',
  engine_sounds: 'Посторонние звуки',
  engine_belts: 'Ремни / приводы',
  drive_test: 'Тест-драйв',
  brakes: 'Тормоза',
  steering: 'Рулевое управление',
};

/**
 * ReportEditor — center column, light theme high-contrast.
 * Black text on white inputs, German-flag accent palette.
 */
export default function ReportEditor({ draft, editable, activeGroup, onChange }: Props) {
  const { t } = useTranslation();

  const setStatus = (key: string, status: ChecklistItemStatus) => {
    onChange({ ...draft, checklist: draft.checklist.map(c => (c.key === key ? { ...c, status } : c)) });
  };
  const setComment = (key: string, comment: string) => {
    onChange({ ...draft, checklist: draft.checklist.map(c => (c.key === key ? { ...c, comment: comment || null } : c)) });
  };
  const setVerdict = (verdict: ReportVerdict) => onChange({ ...draft, verdict });
  const setScore = (score: number) => onChange({ ...draft, score });
  const setSummary = (summary: string) => onChange({ ...draft, summary });
  const setRepairMin = (v: number | null) => onChange({ ...draft, repairEstimateMin: v });
  const setRepairMax = (v: number | null) => onChange({ ...draft, repairEstimateMax: v });
  const addIssue = () => onChange({ ...draft, issues: [...draft.issues, { severity: 'medium', title: '', description: null }] });
  const updateIssue = (idx: number, patch: Partial<ReportIssue>) => onChange({
    ...draft,
    issues: draft.issues.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
  });
  const removeIssue = (idx: number) => onChange({ ...draft, issues: draft.issues.filter((_, i) => i !== idx) });

  const groupItems = CHECKLIST_TEMPLATE.filter(t => t.group === activeGroup);
  const sectionTitle = (key: string) => t(`inspector.checklist.item.${key}`, { defaultValue: ITEM_LABEL_RU[key] ?? key.replace(/_/g, ' ') });

  return (
    <div className="px-8 py-7 max-w-3xl mx-auto" data-testid="report-editor-content">
      {/* Header — score / verdict. */}
      <section className="space-y-4 pb-7" style={{ borderBottom: '1px solid #e5e5e5' }} data-testid="editor-overall">
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-black text-zinc-900">
          {t('inspector.report.overall', { defaultValue: 'Общая оценка' })}
        </h2>
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-4">
            <label className="block text-[11px] font-bold text-zinc-700 mb-2">
              {t('inspector.report.score', { defaultValue: 'Оценка (1–10)' })}
            </label>
            <input
              type="number" step={0.5} min={1} max={10}
              value={draft.score ?? ''}
              disabled={!editable}
              onChange={e => setScore(Number(e.target.value))}
              placeholder="—"
              className="w-full h-14 px-4 rounded-lg text-2xl font-black tabular-nums outline-none transition focus:ring-2 focus:ring-amber-200 disabled:opacity-50"
              style={{ background: '#ffffff', border: '2px solid #d4d4d8', color: '#0a0a0a' }}
              data-testid="editor-score"
            />
          </div>
          <div className="col-span-8">
            <label className="block text-[11px] font-bold text-zinc-700 mb-2">
              {t('inspector.report.verdict', { defaultValue: 'Вердикт' })}
            </label>
            <div className="flex gap-2">
              {REPORT_VERDICTS.map(v => {
                const vv = VERDICT_VISUAL[v];
                const active = draft.verdict === v;
                return (
                  <button
                    key={v}
                    disabled={!editable}
                    onClick={() => setVerdict(v)}
                    className="flex-1 h-14 px-3 text-[11px] font-black uppercase tracking-wider rounded-lg transition disabled:opacity-50 hover:brightness-95"
                    style={{
                      background: active ? vv.bg : '#ffffff',
                      border: active ? `2px solid ${vv.border}` : '2px solid #d4d4d8',
                      color: active ? vv.color : '#52525b',
                    }}
                    data-testid={`editor-verdict-${v}`}
                  >
                    {t(`inspector.report.verdict_${v}`, {
                      defaultValue:
                        v === 'recommended' ? 'Рекомендую' :
                        v === 'risky' ? 'С риском' :
                        'Не рекомендую',
                    })}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Active group items. */}
      <section className="py-7" style={{ borderBottom: '1px solid #e5e5e5' }} data-testid={`editor-group-${activeGroup}`}>
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-black text-zinc-900 mb-4">
          {t(`inspector.checklist.group.${activeGroup}`, { defaultValue: activeGroup.replace(/_/g, ' ') })}
        </h2>
        <div className="space-y-3">
          {groupItems.map(item => {
            const value = draft.checklist.find(c => c.key === item.key);
            const status = (value?.status ?? 'not_checked') as ChecklistItemStatus;
            return (
              <div
                key={item.key}
                className="rounded-xl p-4"
                style={{ background: '#ffffff', border: '1px solid #e5e5e5' }}
                data-testid={`item-${item.key}`}
              >
                <div className="flex items-center justify-between gap-3 mb-2">
                  <span className="text-[14px] font-bold text-zinc-900">{sectionTitle(item.key)}</span>
                  <div className="flex gap-1.5 flex-shrink-0">
                    {CHECKLIST_ITEM_STATUSES.filter(s => s !== 'not_checked').map(s => {
                      const v = STATUS_VISUAL[s];
                      const Icon = v.icon;
                      const active = status === s;
                      return (
                        <button
                          key={s}
                          disabled={!editable}
                          onClick={() => setStatus(item.key, s)}
                          className="px-3 py-1.5 text-[11px] font-black uppercase tracking-wider rounded-lg transition flex items-center gap-1 disabled:opacity-50 hover:brightness-95"
                          style={{
                            background: active ? v.bg : '#ffffff',
                            border: active ? `2px solid ${v.border}` : '1px solid #d4d4d8',
                            color: active ? v.color : '#52525b',
                          }}
                          data-testid={`item-${item.key}-${s}`}
                        >
                          <Icon size={12} weight={active ? 'fill' : 'regular'} /> {v.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {(status === 'warning' || status === 'problem' || (value?.comment ?? '').length > 0) && (
                  <input
                    type="text"
                    placeholder={t('inspector.report.comment_placeholder', { defaultValue: 'Комментарий (необязательно)' })}
                    value={value?.comment ?? ''}
                    disabled={!editable}
                    onChange={e => setComment(item.key, e.target.value)}
                    className="w-full h-10 px-3 rounded-lg text-sm outline-none transition focus:ring-2 focus:ring-amber-200 disabled:opacity-50"
                    style={{ background: '#fafafa', border: '1px solid #d4d4d8', color: '#0a0a0a' }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Issues list. */}
      <section className="py-7" style={{ borderBottom: '1px solid #e5e5e5' }} data-testid="editor-issues">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[11px] uppercase tracking-[0.18em] font-black text-zinc-900">
            {t('inspector.report.issues', { defaultValue: 'Найденные проблемы' })}
          </h2>
          <button
            disabled={!editable}
            onClick={addIssue}
            className="text-[12px] font-black flex items-center gap-1 px-2.5 py-1.5 rounded-lg hover:bg-amber-50 transition disabled:opacity-50"
            style={{ color: '#b45309' }}
            data-testid="add-issue"
          >
            <Plus size={14} weight="bold" /> {t('inspector.report.add_issue', { defaultValue: 'Добавить' })}
          </button>
        </div>
        {draft.issues.length === 0 ? (
          <p className="text-sm text-zinc-500">
            {t('inspector.report.no_issues', { defaultValue: 'Пока проблем не зафиксировано.' })}
          </p>
        ) : (
          <div className="space-y-2">
            {draft.issues.map((issue, idx) => (
              <div
                key={idx}
                className="rounded-xl p-3"
                style={{ background: '#ffffff', border: '1px solid #e5e5e5' }}
                data-testid={`issue-${idx}`}
              >
                <div className="flex gap-2 items-start">
                  <select
                    value={issue.severity}
                    disabled={!editable}
                    onChange={e => updateIssue(idx, { severity: e.target.value as IssueSeverity })}
                    className="h-9 px-2 rounded-lg text-sm font-bold outline-none disabled:opacity-50"
                    style={{ background: '#fafafa', border: '1px solid #d4d4d8', color: '#0a0a0a' }}
                  >
                    {ISSUE_SEVERITIES.map(s => (
                      <option key={s} value={s}>
                        {t(`inspector.report.severity_${s}`, { defaultValue: SEVERITY_LABEL[s] ?? s })}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    placeholder={t('inspector.report.issue_title', { defaultValue: 'Заголовок' })}
                    value={issue.title}
                    disabled={!editable}
                    onChange={e => updateIssue(idx, { title: e.target.value })}
                    className="flex-1 h-9 px-3 rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-200 disabled:opacity-50"
                    style={{ background: '#fafafa', border: '1px solid #d4d4d8', color: '#0a0a0a' }}
                  />
                  <button
                    disabled={!editable}
                    onClick={() => removeIssue(idx)}
                    className="w-9 h-9 flex items-center justify-center rounded-lg text-zinc-500 hover:text-red-700 hover:bg-red-50 transition disabled:opacity-50"
                    data-testid={`remove-issue-${idx}`}
                  >
                    <X size={16} weight="bold" />
                  </button>
                </div>
                <input
                  type="text"
                  placeholder={t('inspector.report.issue_desc', { defaultValue: 'Описание (необязательно)' })}
                  value={issue.description ?? ''}
                  disabled={!editable}
                  onChange={e => updateIssue(idx, { description: e.target.value || null })}
                  className="w-full mt-2 px-3 py-1.5 text-sm bg-transparent outline-none disabled:opacity-50 text-zinc-700"
                  style={{ borderBottom: '1px dashed #e5e5e5' }}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Repair estimate + summary. */}
      <section className="py-7" data-testid="editor-summary">
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-black text-zinc-900 mb-4">
          {t('inspector.report.summary_title', { defaultValue: 'Итог и оценка ремонта' })}
        </h2>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <input
            type="number" min={0}
            placeholder={t('inspector.report.repair_min', { defaultValue: 'Мин. € (необязательно)' })}
            value={draft.repairEstimateMin ?? ''}
            disabled={!editable}
            onChange={e => setRepairMin(e.target.value ? Number(e.target.value) : null)}
            className="h-11 px-4 rounded-lg text-sm font-bold tabular-nums outline-none focus:ring-2 focus:ring-amber-200 disabled:opacity-50"
            style={{ background: '#ffffff', border: '1px solid #d4d4d8', color: '#0a0a0a' }}
            data-testid="repair-min"
          />
          <input
            type="number" min={0}
            placeholder={t('inspector.report.repair_max', { defaultValue: 'Макс. € (необязательно)' })}
            value={draft.repairEstimateMax ?? ''}
            disabled={!editable}
            onChange={e => setRepairMax(e.target.value ? Number(e.target.value) : null)}
            className="h-11 px-4 rounded-lg text-sm font-bold tabular-nums outline-none focus:ring-2 focus:ring-amber-200 disabled:opacity-50"
            style={{ background: '#ffffff', border: '1px solid #d4d4d8', color: '#0a0a0a' }}
            data-testid="repair-max"
          />
        </div>
        <textarea
          rows={6}
          placeholder={t('inspector.report.summary_placeholder', {
            defaultValue: 'Итог проверки — минимум 10 символов. Опишите что нашли, что вызвало вопросы, что в хорошем состоянии.',
          })}
          value={draft.summary ?? ''}
          disabled={!editable}
          onChange={e => setSummary(e.target.value)}
          className="w-full px-4 py-3 rounded-lg text-sm outline-none focus:ring-2 focus:ring-amber-200 disabled:opacity-50 resize-none"
          style={{ background: '#ffffff', border: '1px solid #d4d4d8', color: '#0a0a0a' }}
          data-testid="editor-summary-text"
        />
        <div className="text-[11px] text-zinc-500 mt-1.5 text-right tabular-nums font-medium">
          {(draft.summary ?? '').length} / 4000
        </div>
      </section>
    </div>
  );
}

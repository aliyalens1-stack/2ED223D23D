import { useTranslation } from 'react-i18next';
import { Clock } from '@phosphor-icons/react';
import type { InspectionJobTimelineEvent } from '@platform/domain/contracts/inspection-job';
import { formatDateTime, type Locale } from '@platform/domain/formatters';

interface Props {
  events: InspectionJobTimelineEvent[];
  locale: Locale;
}

/**
 * TimelineRail — light theme read-only operational confidence primitive.
 */
export default function TimelineRail({ events, locale }: Props) {
  const { t } = useTranslation();

  if (events.length === 0) {
    return (
      <div data-testid="timeline-empty">
        <h3 className="text-[10px] uppercase tracking-[0.18em] font-bold text-zinc-500 mb-3">
          {t('inspector.timeline.title', { defaultValue: 'История событий' })}
        </h3>
        <p className="text-xs text-zinc-500">
          {t('inspector.timeline.empty', { defaultValue: 'Событий пока нет.' })}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="timeline-rail">
      <h3 className="text-[10px] uppercase tracking-[0.18em] font-bold text-zinc-500 mb-3">
        {t('inspector.timeline.title', { defaultValue: 'История событий' })}
      </h3>
      <ol className="space-y-3 relative before:absolute before:left-[5px] before:top-1.5 before:bottom-1.5 before:w-px before:bg-zinc-200">
        {events.map((ev, idx) => (
          <li key={`${ev.at}-${idx}`} className="relative pl-5" data-testid={`timeline-event-${idx}`}>
            <span
              className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full"
              style={{ background: '#FFB020', border: '2px solid #ffffff', boxShadow: '0 0 0 1px #ececec' }}
              aria-hidden
            />
            <div className="text-xs font-bold text-zinc-900">
              {t(ev.i18nKey, { defaultValue: ev.kind })}
            </div>
            <div className="flex items-center gap-1 text-[10px] text-zinc-500 mt-0.5 tabular-nums">
              <Clock size={10} /> {formatDateTime(ev.at, locale)}
              {ev.actor && <span className="ml-1">· {ev.actor}</span>}
            </div>
            {ev.note && <div className="text-[11px] text-zinc-600 mt-1 italic">{ev.note}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

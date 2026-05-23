// Customer Inspection Timeline — web port (Sprint Customer-Web-1).
//
// Sister surface to mobile `app/customer/inspection/[jobId]/timeline.tsx`.
//
// Doctrine (POLICY.md):
//   • Web is a transport surface for the customer narrative — it imports
//     `projectTimeline` and `getCopy` from the canonical customer-grammar
//     module. It re-implements NEITHER projection logic NOR translation.
//   • Web has no opportunity to: re-translate, re-allowlist, drop a
//     different set of events, or render a forbidden token. Those
//     invariants are enforced by:
//        - shared `projectTimeline()`  (parity invariant),
//        - shared copy tables           (lexicon firewall),
//        - committed checksum baseline  (semantic drift detector).
//   • Layout: typography + spacing only. No icons-as-grammar, no severity
//     chips, no relative-time chips, no live polling, no progress bars.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  getCopy,
  projectTimeline,
  fillDate,
  type RawTimelineEvent,
  type ProjectedRow,
} from '@customer-grammar/narrative';

type TimelineResponse = { events: RawTimelineEvent[] };

export default function InspectionTimelinePage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { i18n } = useTranslation();
  const copy = getCopy(i18n.language).ui;

  const [events, setEvents] = useState<RawTimelineEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);

  async function load() {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch(`/api/inspections/${jobId}/timeline`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 404) {
        setError(copy['timeline.error.notAvailable']);
        setEvents(null);
      } else if (res.status === 401 || res.status === 403) {
        setError(copy['timeline.error.auth']);
        setEvents(null);
      } else if (!res.ok) {
        setError(copy['timeline.error.load']);
        setEvents(null);
      } else {
        const json = (await res.json()) as TimelineResponse;
        setEvents(json.events || []);
        setLastReadAt(new Date().toISOString());
      }
    } catch {
      setError(copy['timeline.error.load']);
      setEvents(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // The single point of customer narrative for the event stream. Web
  // NEVER touches `events` directly — it asks the shared projection
  // kernel what is customer-safe to show, in the active locale.
  const projected: ProjectedRow[] = events
    ? projectTimeline(events, i18n.language).rendered
    : [];

  return (
    <div
      className="mx-auto max-w-2xl px-4 md:px-6 py-12"
      data-testid="inspection-timeline-page"
    >
      <Link
        to="/dashboard/requests"
        className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-8"
        data-testid="timeline-back-link"
      >
        <ArrowLeft size={16} /> {copy['common.back']}
      </Link>

      <header className="mb-10">
        <p
          className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-soft)] mb-3"
          data-testid="timeline-kicker"
        >
          {copy['timeline.kicker']}
        </p>
        <h1
          className="text-3xl font-extrabold tracking-tight"
          data-testid="timeline-title"
        >
          {copy['timeline.title']}
        </h1>
      </header>

      <MetaStrip
        lastReadAt={lastReadAt}
        loading={loading}
        onRefresh={load}
        copy={copy}
      />

      {/* Cross-nav row — mirror of the mobile triangle.
          Both buttons replace the current screen so back-stack stays one
          deep. Same restraint: ghost border, no urgency, no count. */}
      {jobId && (
        <CrossNavRow jobId={jobId} copy={copy} />
      )}

      {error && (
        <p
          className="mt-8 text-sm text-[var(--text-2)] leading-relaxed"
          data-testid="timeline-error"
        >
          {error}
        </p>
      )}

      {!error && !loading && projected.length === 0 && (
        <p
          className="mt-8 text-sm text-[var(--text-2)] leading-relaxed"
          data-testid="timeline-empty"
        >
          {copy['timeline.empty']}
        </p>
      )}

      {projected.length > 0 && (
        <ol
          className="mt-8 space-y-6 border-l border-[var(--border)] pl-6"
          data-testid="timeline-rail"
        >
          {projected.map((row, i) => (
            <li
              key={row.id}
              data-testid={`timeline-row-${i}`}
              data-source-event-type={row.sourceEventType}
            >
              <p className="text-[15px] font-extrabold leading-snug">
                {row.title}
              </p>
              <p className="mt-1.5 text-[11px] uppercase tracking-wider text-[var(--text-soft)]">
                {formatAbsolute(row.at)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function MetaStrip({
  lastReadAt,
  loading,
  onRefresh,
  copy,
}: {
  lastReadAt: string | null;
  loading: boolean;
  onRefresh: () => void;
  copy: ReturnType<typeof getCopy>['ui'];
}) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--border)] pb-3 mb-6">
      <p
        className="text-[11px] uppercase tracking-wider text-[var(--text-soft)]"
        data-testid="timeline-meta"
      >
        {lastReadAt
          ? fillDate(copy['common.lastRead'], formatAbsolute(lastReadAt))
          : loading
          ? copy['common.reading']
          : copy['common.dash']}
      </p>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)] disabled:opacity-40"
        data-testid="timeline-refresh"
      >
        <RefreshCw size={12} /> {copy['common.refresh']}
      </button>
    </div>
  );
}

function CrossNavRow({
  jobId,
  copy,
}: {
  jobId: string;
  copy: ReturnType<typeof getCopy>['ui'];
}) {
  return (
    <div className="flex flex-wrap gap-3 mb-2">
      <Link
        to={`/dashboard/inspection/${jobId}/continuity`}
        replace
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)] border border-[var(--border)] rounded-full px-3 py-1.5"
        data-testid="timeline-to-continuity"
      >
        {copy['timeline.crossToContinuity']}
      </Link>
      <Link
        to={`/dashboard/inspection/${jobId}/report-cognition`}
        replace
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)] border border-[var(--border)] rounded-full px-3 py-1.5"
        data-testid="timeline-to-report"
      >
        {copy['timeline.crossToReport']}
      </Link>
    </div>
  );
}

// Absolute, language-neutral date. Mirrors mobile's formatAbsolute.
// Customer-grammar does NOT own date formatting — locales/timezones are
// platform concerns, not narrative concerns.
function formatAbsolute(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

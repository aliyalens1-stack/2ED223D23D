// Customer Inspection Continuity — web port (Sprint Customer-Web-1).
//
// Sister surface to mobile `app/customer/inspection/[jobId]/continuity.tsx`.
//
// All customer-narrative strings (kicker, title, section eyebrows,
// maturity labels, error lines, refresh, empty states, cross-nav) come
// from the canonical customer-grammar module. Backend-owned strings
// (continuity event `title` + `text`, the interpretation paragraph) are
// rendered verbatim — those belong to the cognition pipeline.
//
// Web introduces NO grammar of its own. See:
//   frontend/src/customer-grammar/POLICY.md
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCopy, fillDate } from '@customer-grammar/narrative';

type Maturity = 'forming' | 'accumulating' | 'established' | 'delivered';

const MATURITY_KEY: Record<
  Maturity,
  'continuity.maturity.forming'
  | 'continuity.maturity.accumulating'
  | 'continuity.maturity.established'
  | 'continuity.maturity.delivered'
> = {
  forming: 'continuity.maturity.forming',
  accumulating: 'continuity.maturity.accumulating',
  established: 'continuity.maturity.established',
  delivered: 'continuity.maturity.delivered',
};

type ContinuityEvent = {
  kind: 'inspection_continuity';
  title: string;
  text: string;
  timestamp: string;
};

type ContinuityOk = {
  ok: true;
  maturity: Maturity;
  interpretation: string;
  events: ContinuityEvent[];
};

type ContinuityEmpty = { ok: false; reason: string };

type ContinuityResponse = ContinuityOk | ContinuityEmpty;

export default function InspectionContinuityPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { i18n } = useTranslation();
  const copy = getCopy(i18n.language).ui;

  const [data, setData] = useState<ContinuityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);

  async function load() {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch(`/api/customer/inspection/${jobId}/continuity`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 404) {
        setError(copy['continuity.error.notAvailable']);
        setData(null);
      } else if (res.status === 401 || res.status === 403) {
        setError(copy['continuity.error.auth']);
        setData(null);
      } else if (!res.ok) {
        setError(copy['continuity.error.load']);
        setData(null);
      } else {
        const json = (await res.json()) as ContinuityResponse;
        setData(json);
        setLastReadAt(new Date().toISOString());
      }
    } catch {
      setError(copy['continuity.error.load']);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  return (
    <div
      className="mx-auto max-w-2xl px-4 md:px-6 py-12"
      data-testid="inspection-continuity-page"
    >
      <Link
        to="/dashboard/requests"
        className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-8"
        data-testid="continuity-back-link"
      >
        <ArrowLeft size={16} /> {copy['common.back']}
      </Link>

      <header className="mb-10">
        <p
          className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-soft)] mb-3"
          data-testid="continuity-kicker"
        >
          {copy['continuity.kicker']}
        </p>
        <h1
          className="text-3xl font-extrabold tracking-tight"
          data-testid="continuity-title"
        >
          {copy['continuity.title']}
        </h1>
      </header>

      <MetaStrip
        lastReadAt={lastReadAt}
        loading={loading}
        onRefresh={load}
        copy={copy}
        testId="continuity-meta"
      />

      {loading && !data && (
        <p
          className="text-sm text-[var(--text-2)]"
          data-testid="continuity-loading"
        >
          {copy['common.reading']}
        </p>
      )}

      {!loading && error && (
        <p
          className="mt-6 text-base text-[var(--text-2)] leading-relaxed"
          data-testid="continuity-error"
        >
          {error}
        </p>
      )}

      {!loading && !error && data && data.ok === false && (
        <p
          className="mt-6 text-base text-[var(--text-2)] leading-relaxed"
          data-testid="continuity-insufficient"
        >
          {copy['continuity.insufficient']}
        </p>
      )}

      {!loading && !error && data && data.ok === true && (
        <Readout data={data} jobId={jobId!} copy={copy} />
      )}
    </div>
  );
}

function Readout({
  data,
  jobId,
  copy,
}: {
  data: ContinuityOk;
  jobId: string;
  copy: ReturnType<typeof getCopy>['ui'];
}) {
  return (
    <article className="space-y-12 mt-2" data-testid="continuity-readout">
      <Section
        eyebrow={copy['continuity.section.state']}
        body={copy[MATURITY_KEY[data.maturity]]}
        testId="continuity-state"
      />

      <Section
        eyebrow={copy['continuity.section.interpretation']}
        body={data.interpretation}
        testId="continuity-interpretation"
      />

      <section data-testid="continuity-events-section">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-soft)] mb-4">
          {copy['continuity.section.events']}
        </p>
        {data.events.length === 0 ? (
          <p
            className="text-sm text-[var(--text-2)]"
            data-testid="continuity-events-empty"
          >
            {copy['continuity.events.empty']}
          </p>
        ) : (
          <ol
            className="space-y-6 border-l border-[var(--border)] pl-6"
            data-testid="continuity-events-list"
          >
            {data.events.map((e, i) => (
              <li key={`${e.timestamp}-${i}`} data-testid={`continuity-event-${i}`}>
                <p className="text-[15px] font-extrabold leading-snug">
                  {e.title}
                </p>
                <p className="mt-1 text-[14px] text-[var(--text-2)] leading-relaxed">
                  {e.text}
                </p>
                <p className="mt-1.5 text-[11px] uppercase tracking-wider text-[var(--text-soft)]">
                  {formatAbsolute(e.timestamp)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Nav glue — open the chronological process history. */}
      <div className="pt-2">
        <Link
          to={`/dashboard/inspection/${jobId}/timeline`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)] border border-[var(--border)] rounded-full px-3 py-1.5"
          data-testid="continuity-view-history-btn"
        >
          {copy['continuity.navToHistory']}
        </Link>
      </div>
    </article>
  );
}

function MetaStrip({
  lastReadAt,
  loading,
  onRefresh,
  copy,
  testId,
}: {
  lastReadAt: string | null;
  loading: boolean;
  onRefresh: () => void;
  copy: ReturnType<typeof getCopy>['ui'];
  testId: string;
}) {
  return (
    <div
      className="flex items-center justify-between border-b border-[var(--border)] pb-3 mb-6"
      data-testid={testId}
    >
      <p className="text-[11px] uppercase tracking-wider text-[var(--text-soft)]">
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
        data-testid="continuity-refresh-btn"
      >
        <RefreshCw size={12} /> {copy['common.refresh']}
      </button>
    </div>
  );
}

function Section({
  eyebrow,
  body,
  testId,
}: {
  eyebrow: string;
  body: string;
  testId: string;
}) {
  return (
    <section data-testid={testId}>
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-soft)] mb-3">
        {eyebrow}
      </p>
      <p
        className="text-[17px] leading-relaxed text-[var(--text)]"
        data-testid={`${testId}-body`}
      >
        {body}
      </p>
    </section>
  );
}

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

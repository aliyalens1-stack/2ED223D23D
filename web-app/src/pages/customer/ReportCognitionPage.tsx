// Customer Report Cognition — web port (Sprint Customer-Web-1).
//
// Sister surface to mobile `app/customer/inspection/[jobId]/report-cognition.tsx`.
//
// Chrome strings (kicker, title, loading, refresh, error lines,
// lastInterpreted, nav-to-history) come from customer-grammar.
//
// Section bodies are backend-owned and rendered verbatim — the backend
// mapper is the single owner of WHAT the customer reads inside each
// section. The four section eyebrows below are this surface's
// backend-mirror constants; they are NOT part of customer-grammar
// because they describe the BACKEND's section taxonomy, not the
// customer's narrative vocabulary. Changing them is a backend-protocol
// change, not a grammar change.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCopy, fillDate } from '@customer-grammar/narrative';

type CognitionOk = {
  ok: true;
  sections: {
    structurally_matters: string;
    remains_uncertain: string;
    supports_interpretation: string;
    may_require_review: string;
  };
  lastInterpretedAt: string | null;
};

type CognitionForming = { ok: false; reason: 'forming'; interpretation: string };

type CognitionResponse = CognitionOk | CognitionForming;

// Backend-mirror section eyebrows. See file header — these mirror the
// backend mapper's section taxonomy, not the customer-grammar firewall.
// If the backend renames a section, this constant moves with it.
const SECTION_ORDER: Array<{
  eyebrow: string;
  key: keyof CognitionOk['sections'];
  testId: string;
}> = [
  { eyebrow: 'What structurally matters',         key: 'structurally_matters',     testId: 'cognition-structurally-matters' },
  { eyebrow: 'What remains uncertain',            key: 'remains_uncertain',        testId: 'cognition-remains-uncertain' },
  { eyebrow: 'What supports the interpretation',  key: 'supports_interpretation',  testId: 'cognition-supports-interpretation' },
  { eyebrow: 'What may require further review',   key: 'may_require_review',       testId: 'cognition-may-require-review' },
];

export default function ReportCognitionPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { i18n } = useTranslation();
  const copy = getCopy(i18n.language).ui;

  const [data, setData] = useState<CognitionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch(`/api/customer/inspection/${jobId}/report-cognition`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 404) {
        setError(copy['cognition.error.notAvailable']);
        setData(null);
      } else if (res.status === 401 || res.status === 403) {
        setError(copy['cognition.error.auth']);
        setData(null);
      } else if (!res.ok) {
        setError(copy['cognition.error.load']);
        setData(null);
      } else {
        const json = (await res.json()) as CognitionResponse;
        setData(json);
      }
    } catch {
      setError(copy['cognition.error.load']);
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
      className="mx-auto max-w-2xl px-4 md:px-6 py-14"
      data-testid="report-cognition-page"
    >
      <Link
        to="/dashboard/requests"
        className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-10"
        data-testid="cognition-back-link"
      >
        <ArrowLeft size={16} /> {copy['common.back']}
      </Link>

      <header className="mb-12">
        <h1
          className="text-3xl font-extrabold tracking-tight leading-tight"
          data-testid="cognition-title"
        >
          {copy['cognition.title']}
        </h1>
      </header>

      {loading && (
        <p
          className="text-sm text-[var(--text-2)]"
          data-testid="cognition-loading"
        >
          {copy['cognition.loading']}
        </p>
      )}

      {!loading && error && (
        <FormingOrError
          line={error}
          onRefresh={load}
          testId="cognition-error-state"
          refreshLabel={copy['cognition.refresh']}
        />
      )}

      {!loading && !error && data && data.ok === false && (
        <FormingOrError
          line={data.interpretation}
          onRefresh={load}
          testId="cognition-forming-state"
          refreshLabel={copy['cognition.refresh']}
        />
      )}

      {!loading && !error && data && data.ok === true && (
        <Document data={data} onRefresh={load} jobId={jobId!} copy={copy} />
      )}
    </div>
  );
}

function Document({
  data,
  onRefresh,
  jobId,
  copy,
}: {
  data: CognitionOk;
  onRefresh: () => void;
  jobId: string;
  copy: ReturnType<typeof getCopy>['ui'];
}) {
  return (
    <article className="space-y-14" data-testid="cognition-document">
      {SECTION_ORDER.map((s, i) => (
        <CognitionSection
          key={s.key}
          eyebrow={s.eyebrow}
          body={data.sections[s.key]}
          testId={s.testId}
          showSeparatorAbove={i > 0}
        />
      ))}

      {data.lastInterpretedAt && (
        <footer
          className="pt-10 border-t border-[var(--border)]"
          data-testid="cognition-meta"
        >
          <p
            className="text-[14px] text-[var(--text-2)]"
            data-testid="cognition-last-interpreted-at"
          >
            {fillDate(
              copy['cognition.lastInterpreted'],
              formatAbsolute(data.lastInterpretedAt),
            )}
          </p>
        </footer>
      )}

      <div className="pt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)]"
          data-testid="cognition-refresh-btn"
        >
          <RefreshCw size={12} /> {copy['cognition.refresh']}
        </button>

        <Link
          to={`/dashboard/inspection/${jobId}/timeline`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)] border border-[var(--border)] rounded-full px-3 py-1.5"
          data-testid="cognition-view-history-btn"
        >
          {copy['cognition.navToHistory']}
        </Link>
      </div>
    </article>
  );
}

function CognitionSection({
  eyebrow,
  body,
  testId,
  showSeparatorAbove,
}: {
  eyebrow: string;
  body: string;
  testId: string;
  showSeparatorAbove: boolean;
}) {
  return (
    <section data-testid={testId} className={showSeparatorAbove ? 'pt-2' : ''}>
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-soft)] mb-4">
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

function FormingOrError({
  line,
  onRefresh,
  testId,
  refreshLabel,
}: {
  line: string;
  onRefresh: () => void;
  testId: string;
  refreshLabel: string;
}) {
  return (
    <div className="space-y-8" data-testid={testId}>
      <p
        className="text-[17px] leading-relaxed text-[var(--text)]"
        data-testid={`${testId}-line`}
      >
        {line}
      </p>
      <button
        type="button"
        onClick={onRefresh}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-2)] hover:text-[var(--text)]"
        data-testid="cognition-forming-refresh-btn"
      >
        <RefreshCw size={12} /> {refreshLabel}
      </button>
    </div>
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

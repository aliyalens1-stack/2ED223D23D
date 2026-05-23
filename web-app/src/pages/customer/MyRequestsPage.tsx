// Sprint 2 — My Requests list + detail.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MapPin, Euro, Package, ShieldCheck, Clock, CheckCircle2 } from 'lucide-react';

// ──────────────────────────────────────────────────────────────────────
// My Requests list
// ──────────────────────────────────────────────────────────────────────

export function MyRequestsListPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    const token = localStorage.getItem('token') || '';
    if (!token) { setError('login required'); setItems([]); return; }
    try {
      const res = await fetch('/api/customer/requests/my', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setItems(await res.json());
    } catch (e: any) { setError(e?.message || 'failed'); setItems([]); }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 md:px-6 py-10" data-testid="my-requests-page">
      <Link to="/" className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-6">
        <ArrowLeft size={16} /> {t('common.back')}
      </Link>

      <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-3xl font-extrabold">{t('my_requests.title')}</h1>
          <p className="mt-1 text-[var(--text-2)]">{t('my_requests.subtitle')}</p>
        </div>
        <Link to="/dashboard/request/new" className="text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] underline decoration-[var(--border)] underline-offset-4" data-testid="my-requests-new-btn">
          + {t('my_requests.new')}
        </Link>
      </div>

      {error && <div className="rounded-xl border border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)] px-4 py-3 text-sm font-bold mb-4">{error}</div>}
      {items === null && <div className="text-sm text-[var(--text-2)]">{t('common.loading')}</div>}
      {items && items.length === 0 && !error && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-10 text-center">
          <Package size={32} className="mx-auto text-[var(--text-soft)] mb-3" />
          <h3 className="text-lg font-extrabold mb-1">{t('my_requests.empty_title')}</h3>
          <p className="text-sm text-[var(--text-2)] mb-5">{t('my_requests.empty_subtitle')}</p>
          <Link to="/dashboard/request/new" className="text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] underline decoration-[var(--border)] underline-offset-4" data-testid="my-requests-empty-cta">
            {t('my_requests.empty_cta')}
          </Link>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="grid gap-3" data-testid="my-requests-list">
          {items.map((r) => (
            <Link
              key={r.id}
              to={`/dashboard/requests/${r.id}`}
              className="block rounded-2xl border border-[var(--border)] bg-white p-5 hover:border-[var(--primary)] shadow-[var(--shadow-card)]"
              data-testid={`my-request-item-${r.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-extrabold">{r.brand} {r.model}</div>
                  <div className="mt-1 flex flex-wrap gap-3 text-sm text-[var(--text-2)]">
                    <span className="inline-flex items-center gap-1"><MapPin size={14} /> {r.cities.join(' · ')}</span>
                    <span className="inline-flex items-center gap-1"><Euro size={14} /> до {Number(r.budget).toLocaleString('de-DE')}</span>
                    <span className="inline-flex items-center gap-1"><Package size={14} /> {r.jobsTotal} {t('my_requests.jobs')}</span>
                  </div>
                </div>
                <StatusBadge status={r.status} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Request detail
// ──────────────────────────────────────────────────────────────────────

export function MyRequestDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { load(); }, [id]);

  async function load() {
    try {
      const res = await fetch(`/api/customer/requests/${id}/jobs`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e: any) { setError(e?.message || 'failed'); }
  }

  if (error) return <div className="mx-auto max-w-4xl p-8 text-[var(--danger)]" data-testid="my-request-error">{error}</div>;
  if (!data) return <div className="mx-auto max-w-4xl p-8 text-[var(--text-2)]">{t('common.loading')}</div>;

  const { request: r, jobs } = data;

  return (
    <div className="mx-auto max-w-5xl px-4 md:px-6 py-10" data-testid="my-request-detail">
      <Link to="/dashboard/requests" className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-6">
        <ArrowLeft size={16} /> {t('my_requests.title')}
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-extrabold">{r.brand} {r.model}</h1>
          <div className="mt-2 flex flex-wrap gap-3 text-sm text-[var(--text-2)]">
            <span className="inline-flex items-center gap-1"><Euro size={14} /> до {Number(r.budget).toLocaleString('de-DE')} €</span>
            <span className="inline-flex items-center gap-1"><MapPin size={14} /> {r.cities.join(' · ')}</span>
          </div>
        </div>
        <StatusBadge status={r.status} />
      </div>

      {/*
        Restrained establishment re-entry.
        Quiet document-reference link to the calm "context established"
        surface. Pure plumbing — no celebration, no progress indicator,
        no CTA emphasis.
      */}
      <div className="mt-3" data-testid="request-establishment-reentry">
        <Link
          to={`/dashboard/request/${r.id}/establishment`}
          className="text-sm text-[var(--text-2)] hover:text-[var(--text)] underline decoration-[var(--border)] underline-offset-4"
          data-testid="request-establishment-reentry-link"
        >
          View inspection context
        </Link>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3 max-w-md">
        <Metric label={t('my_requests.jobs_total')} value={r.jobsTotal} />
        <Metric label={t('my_requests.jobs_claimed')} value={r.jobsClaimed} accent />
        <Metric label={t('my_requests.jobs_done')} value={r.jobsDone} />
      </div>

      {r.links && r.links.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-bold uppercase tracking-wider text-[var(--text-soft)] mb-2">{t('my_requests.links')}</h3>
          <ul className="space-y-1.5">
            {r.links.map((l: string, i: number) => (
              <li key={i} className="text-sm">
                <a href={l} target="_blank" rel="noreferrer" className="text-[var(--primary-h)] hover:underline break-all">{l}</a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8">
        <h2 className="text-xl font-extrabold mb-3">{t('my_requests.inspection_jobs')}</h2>
        <div className="grid gap-3" data-testid="my-request-jobs">
          {jobs.map((j: any) => (
            <div key={j.id} className="rounded-2xl border border-[var(--border)] bg-white p-4" data-testid={`job-row-${j.id}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-[var(--primary-soft)] text-[var(--primary-h)] inline-flex items-center justify-center">
                    <MapPin size={18} />
                  </div>
                  <div>
                    <div className="font-extrabold">{j.city}</div>
                    <div className="text-xs text-[var(--text-soft)]">
                      {j.inspectorId ? `Inspector: ${j.inspectorId.substring(0, 10)}…` : t('my_requests.waiting_inspector')}
                    </div>
                  </div>
                </div>
                <JobStatusPill status={j.status} />
              </div>
              <JobInterpretiveReferences jobId={j.id} status={j.status} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  // Stage transitions expressed through semantic tier intensity (not chroma drift):
  //   open        → neutral substrate          (low intensity, awaiting motion)
  //   in_progress → warning-soft / warning     (medium intensity, active state)
  //   completed   → success-soft / success     (terminal intensity, approved)
  // Icon + uppercase tracking preserve readability of the chronology axis.
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    open: { label: 'Open', cls: 'bg-[var(--surface-soft)] text-[var(--text-2)]', icon: <Clock size={13} /> },
    in_progress: { label: 'In progress', cls: 'bg-[var(--warning-soft)] text-[var(--warning)]', icon: <ShieldCheck size={13} /> },
    completed: { label: 'Completed', cls: 'bg-[var(--success-soft)] text-[var(--success)]', icon: <CheckCircle2 size={13} /> },
  };
  const s = map[status] || map.open;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${s.cls}`}>
      {s.icon} {s.label}
    </span>
  );
}

function JobStatusPill({ status }: { status: string }) {
  // Job-level pill mirrors StatusBadge tier ladder (open → claimed → done)
  // so a customer scanning a request page reads a single, coherent
  // approval/progress intensity scale across the deliverable hierarchy.
  const map: Record<string, string> = {
    open: 'bg-[var(--surface-soft)] text-[var(--text-2)]',
    claimed: 'bg-[var(--warning-soft)] text-[var(--warning)]',
    done: 'bg-[var(--success-soft)] text-[var(--success)]',
  };
  return <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${map[status] || map.open}`}>{status}</span>;
}

// ──────────────────────────────────────────────────────────────────────
// Pass C — restrained navigation plumbing.
//
// This component renders quiet document-references under a job row. It is
// NOT a CTA, NOT a card, NOT a colored action. It does not generate any
// interpretive copy of its own — only fixed reference labels and links.
//
// Forbidden in this surface: icons, arrows, badges, pills, notification
// dots, the words "AI" / "score" / "analysis" / "confidence" / "unlock".
//
// "View interpretation" link appears only when the job is delivered.
// No disabled state, no "coming soon" — pre-delivery the link is
// structurally absent from the DOM.
// ──────────────────────────────────────────────────────────────────────

const DELIVERED_JOB_STATUSES = new Set(['delivered', 'completed', 'report_delivered', 'done']);

function isJobDelivered(status: string | undefined | null): boolean {
  return DELIVERED_JOB_STATUSES.has((status || '').toLowerCase());
}

function JobInterpretiveReferences({ jobId, status }: { jobId: string; status: string }) {
  const delivered = isJobDelivered(status);
  return (
    <div
      className="mt-3 pt-3 border-t border-[var(--border)] flex flex-wrap items-center gap-x-3 text-[13px] text-[var(--text-2)]"
      data-testid={`job-references-${jobId}`}
    >
      <Link
        to={`/dashboard/inspection/${jobId}/continuity`}
        className="hover:text-[var(--text)] underline decoration-[var(--border)] underline-offset-4"
        data-testid={`job-continuity-link-${jobId}`}
      >
        View continuity
      </Link>
      {delivered && (
        <>
          <span className="text-[var(--text-soft)]" aria-hidden>·</span>
          <Link
            to={`/dashboard/inspection/${jobId}/report-cognition`}
            className="hover:text-[var(--text)] underline decoration-[var(--border)] underline-offset-4"
            data-testid={`job-interpretation-link-${jobId}`}
          >
            View interpretation
          </Link>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-3.5 ${accent ? 'border-[var(--primary)] bg-[var(--primary-soft)]' : 'border-[var(--border)] bg-white'}`}>
      <div className="text-2xl font-extrabold">{value}</div>
      <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-soft)]">{label}</div>
    </div>
  );
}

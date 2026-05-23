/**
 * InspectionReportPage — customer-facing extended inspection report v2.
 *
 * Mirrors the mobile `inspection-report/[jobId].tsx` screen.
 * Backed by:
 *   GET  /api/inspections/{jobId}/customer-view → section-based report
 *   GET  /api/inspections/{jobId}/timeline      → timeline rail
 *   GET  /api/inspections/{jobId}/report.pdf    → downloadable PDF
 *   GET  /api/inspections/{jobId}/correlations  → cross-section findings
 *   GET  /api/inspections/{jobId}/evidence-gaps → missing-evidence flags
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, FileText, Download, Camera, AlertTriangle, CheckCircle2, Clock, Image as ImageIcon } from 'lucide-react';

interface ReportItem {
  id: string;
  label: string;
  status?: 'ok' | 'warn' | 'fail' | 'n/a';
  note?: string;
  mediaUrls?: string[];
}
interface ReportSection {
  id: string;
  title: string;
  items: ReportItem[];
  summary?: string;
}
interface CustomerView {
  jobId: string;
  vehicle?: { make?: string; model?: string; year?: number; vin?: string };
  inspector?: { name?: string; rating?: number };
  status?: string;
  submittedAt?: string;
  sections: ReportSection[];
  overall?: { rating?: number; recommendation?: string };
}

const STATUS_COLOR: Record<string, string> = {
  ok:    'var(--success)',
  warn:  'var(--warning)',
  fail:  'var(--danger)',
  'n/a': 'var(--text-soft)',
};

export default function InspectionReportPage() {
  const { t } = useTranslation();
  const { jobId = '' } = useParams<{ jobId: string }>();
  const [report, setReport] = useState<CustomerView | null>(null);
  const [gaps, setGaps] = useState<any[]>([]);
  const [correlations, setCorrelations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    const token = localStorage.getItem('token') || '';
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    setLoading(true);
    Promise.all([
      fetch(`/api/inspections/${jobId}/customer-view`, { headers }).then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/inspections/${jobId}/evidence-gaps`, { headers }).then((r) => r.ok ? r.json() : { gaps: [] }).catch(() => ({ gaps: [] })),
      fetch(`/api/inspections/${jobId}/correlations`, { headers }).then((r) => r.ok ? r.json() : { correlations: [] }).catch(() => ({ correlations: [] })),
    ])
      .then(([r, g, c]) => {
        if (cancel) return;
        if (!r) { setError('Report not available yet'); return; }
        setReport(r);
        setGaps(Array.isArray(g) ? g : (g.gaps || []));
        setCorrelations(Array.isArray(c) ? c : (c.correlations || []));
      })
      .catch((e) => !cancel && setError(String(e)))
      .finally(() => !cancel && setLoading(false));
    return () => { cancel = true; };
  }, [jobId]);

  const downloadPdf = () => {
    const token = localStorage.getItem('token') || '';
    const url = `/api/inspections/${jobId}/report.pdf${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    window.open(url, '_blank');
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-12 text-center text-[var(--text-soft)]" data-testid="report-loading">
        {t('report.loading')}
      </div>
    );
  }
  if (error || !report) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-12" data-testid="report-error">
        <Link to="/dashboard/requests" className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-6">
          <ArrowLeft size={16} /> {t('report.back')}
        </Link>
        <div className="rounded-2xl border border-[var(--border)] bg-white p-8 text-center">
          <Clock size={32} className="mx-auto text-[var(--text-soft)] mb-3" />
          <div className="text-lg font-bold">{t('report.not_ready')}</div>
          <p className="text-sm text-[var(--text-2)] mt-1">{error || t('report.not_ready_hint')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 md:px-6 py-8" data-testid="inspection-report-page">
      <Link to="/dashboard/requests" className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-6">
        <ArrowLeft size={16} /> {t('report.back')}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--primary-h)] mb-2">{t('report.label')}</p>
          <h1 className="text-3xl md:text-4xl font-extrabold leading-tight">
            {report.vehicle?.year} {report.vehicle?.make} {report.vehicle?.model}
          </h1>
          {report.vehicle?.vin && (
            <p className="mt-1 text-xs text-[var(--text-soft)] font-mono">VIN · {report.vehicle.vin}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            {report.inspector?.name && (
              <span className="rounded-full bg-[var(--surface-soft)] px-3 py-1 font-semibold">
                {t('report.inspector')}: <span className="font-bold">{report.inspector.name}</span>
                {report.inspector.rating != null && ` · ${report.inspector.rating.toFixed(1)}★`}
              </span>
            )}
            {report.submittedAt && (
              <span className="rounded-full bg-[var(--surface-soft)] px-3 py-1 font-semibold">
                {t('report.submitted', { date: new Date(report.submittedAt).toLocaleDateString() })}
              </span>
            )}
            <Link
              to={`/dashboard/inspection/${jobId}/timeline`}
              className="rounded-full bg-[var(--surface-soft)] px-3 py-1 font-semibold hover:bg-[var(--primary-soft)]"
              data-testid="report-timeline-link"
            >
              {t('report.timeline')} →
            </Link>
          </div>
        </div>
        <button
          onClick={downloadPdf}
          data-testid="report-download-pdf"
          className="btn-primary inline-flex items-center gap-2"
        >
          <Download size={16} /> {t('report.download_pdf')}
        </button>
      </div>

      {/* Overall card */}
      {report.overall && (
        <div className="mt-6 rounded-2xl border border-[var(--border)] bg-white p-6" data-testid="report-overall">
          <div className="text-xs font-bold uppercase tracking-wider text-[var(--text-soft)]">{t('report.overall')}</div>
          <div className="mt-2 flex items-baseline gap-3">
            {report.overall.rating != null && (
              <span className="text-4xl font-extrabold">{report.overall.rating.toFixed(1)}<span className="text-lg text-[var(--text-soft)]">/10</span></span>
            )}
            {report.overall.recommendation && (
              <span className="text-base font-bold text-[var(--text-2)]">{report.overall.recommendation}</span>
            )}
          </div>
        </div>
      )}

      {/* Evidence gaps banner */}
      {gaps.length > 0 && (
        <div className="mt-6 rounded-2xl border border-[var(--warning)] bg-[var(--warning-soft)] p-4" data-testid="report-gaps">
          <div className="flex items-start gap-2">
            <AlertTriangle size={18} className="text-[var(--warning)] mt-0.5 shrink-0" />
            <div>
              <div className="text-sm font-bold text-[var(--warning)]">{t('report.evidence_gaps', { count: gaps.length })}</div>
              <ul className="mt-1 text-xs text-[var(--text-2)] space-y-0.5">
                {gaps.slice(0, 5).map((g: any, i: number) => (
                  <li key={i}>• {g.label || g.sectionId || JSON.stringify(g).slice(0, 80)}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Sections */}
      <div className="mt-6 space-y-6" data-testid="report-sections">
        {report.sections.map((sec) => (
          <section key={sec.id} className="rounded-2xl border border-[var(--border)] bg-white overflow-hidden" data-testid={`section-${sec.id}`}>
            <header className="border-b border-[var(--border)] bg-[var(--surface-soft)] px-5 py-3 flex items-center justify-between">
              <h2 className="font-extrabold flex items-center gap-2">
                <FileText size={16} /> {sec.title}
              </h2>
              <span className="text-xs text-[var(--text-soft)] font-semibold">{t('report.items_count', { count: sec.items.length })}</span>
            </header>
            <div className="divide-y divide-[var(--border)]">
              {sec.items.map((it) => {
                const status = it.status || 'n/a';
                const badgeLabel = status === 'ok'   ? t('report.status_ok')
                                  : status === 'warn' ? t('report.status_warn')
                                  : status === 'fail' ? t('report.status_fail')
                                  : t('report.status_na');
                return (
                  <div key={it.id} className="px-5 py-3.5" data-testid={`item-${it.id}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 font-semibold text-sm">
                        {it.status === 'ok'   && <CheckCircle2 size={16} className="text-[var(--success)]" />}
                        {it.status === 'warn' && <AlertTriangle size={16} className="text-[var(--warning)]" />}
                        {it.status === 'fail' && <AlertTriangle size={16} className="text-[var(--danger)]" />}
                        {it.label}
                      </div>
                      <span
                        className="rounded-full px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider"
                        style={{ color: 'var(--white,#fff)', backgroundColor: STATUS_COLOR[status] }}
                      >
                        {badgeLabel}
                      </span>
                    </div>
                    {it.note && <div className="mt-1.5 text-xs text-[var(--text-2)]">{it.note}</div>}
                    {it.mediaUrls && it.mediaUrls.length > 0 && (
                      <div className="mt-2.5 flex gap-2 flex-wrap">
                        {it.mediaUrls.slice(0, 6).map((m, mi) => (
                          <a key={mi} href={m} target="_blank" rel="noreferrer"
                             className="block h-16 w-16 rounded-lg overflow-hidden bg-[var(--surface-soft)] border border-[var(--border)] hover:border-[var(--primary)]">
                            <img src={m} className="h-full w-full object-cover" loading="lazy" alt="" />
                          </a>
                        ))}
                        {it.mediaUrls.length > 6 && (
                          <div className="flex items-center justify-center h-16 w-16 rounded-lg bg-[var(--surface-soft)] text-xs font-bold text-[var(--text-soft)]">
                            +{it.mediaUrls.length - 6}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {sec.summary && (
              <footer className="border-t border-[var(--border)] px-5 py-3 bg-[var(--surface-soft)] text-xs italic text-[var(--text-2)]">
                {sec.summary}
              </footer>
            )}
          </section>
        ))}
      </div>

      {/* Correlations */}
      {correlations.length > 0 && (
        <div className="mt-8 rounded-2xl border border-[var(--border)] bg-white p-6" data-testid="report-correlations">
          <div className="text-xs font-bold uppercase tracking-wider text-[var(--text-soft)] mb-3">{t('report.cross_findings')}</div>
          <ul className="space-y-2 text-sm">
            {correlations.map((c: any, i: number) => (
              <li key={i} className="flex items-start gap-2">
                <span className="text-[var(--warning)] mt-0.5">•</span>
                <div>
                  <div className="font-semibold">{c.title || c.label || `${t('report.cross_findings')} ${i + 1}`}</div>
                  {c.detail && <div className="text-xs text-[var(--text-2)] mt-0.5">{c.detail}</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8 text-xs text-[var(--text-soft)] flex items-center gap-2">
        <Camera size={12} /> {t('report.photos_note')}
        <ImageIcon size={12} className="ml-3" /> {t('report.retention_note')}
      </div>
    </div>
  );
}

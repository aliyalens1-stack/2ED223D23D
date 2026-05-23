/**
 * P4.2 — Admin Reconciliation Page
 *
 * Consumes /api/admin/reconciliation/{report,taxonomy} (mounted in P3.3).
 *
 * Doctrine (per P4 brief):
 *   "Не dashboard. Минимальная страница."
 *
 *   - Show latest report.
 *   - Show severity (divergence codes + counts).
 *   - Download JSON / MD.
 *   - "Run manually" — endpoint is already safe (read-only), so allowed.
 *   - No auto-fix.
 *   - Divergence rows link to forensic graph for the related entity.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  RefreshCw, Download, AlertCircle, CheckCircle, AlertTriangle,
  ChevronRight, ExternalLink, Database, Activity,
} from 'lucide-react';
import { adminAPI } from '../services/api';

interface BucketEntry {
  statuses?: string[];
  count: number;
  gross_by_currency?: Record<string, number>;
  payout_by_currency?: Record<string, number>;
  refund_by_currency?: Record<string, number>;
}
interface Divergence {
  paymentId?: string;
  bookingId?: string;
  code: string;
  status?: string;
  detail?: string;
}
interface TopRow {
  groupKey: string;
  count: number;
  total: number;
  currency: string;
}
interface ReconciliationReport {
  generatedAt: string;
  scope: string;
  totalDocs: number;
  limit?: number | null;
  buckets: Record<string, BucketEntry>;
  divergenceCountsByCode: Record<string, number>;
  divergences: Divergence[];
  topProvidersOutstanding: TopRow[];
  topCustomersOutstanding: TopRow[];
}

const SEVERITY_BY_CODE: Record<string, 'high' | 'medium' | 'low'> = {
  // High = money correctness threats
  payout_exceeds_gross:       'high',
  refund_exceeds_gross:       'high',
  payout_and_refund_present:  'high',
  // Medium = inconsistent but recoverable
  partial_payout_without_payment: 'medium',
  released_without_payout:        'medium',
  refunded_without_refund_amount: 'medium',
  // Default = low
};

const SEVERITY_COLOR: Record<string, string> = {
  high:   'bg-red-500/20 text-red-300 border-red-500/40',
  medium: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  low:    'bg-slate-500/20 text-slate-300 border-slate-500/40',
};

const BUCKET_LABEL: Record<string, { label: string; tone: string }> = {
  outstanding_escrow:    { label: 'Outstanding escrow',    tone: 'text-amber-300' },
  settled_to_provider:   { label: 'Settled to provider',   tone: 'text-emerald-300' },
  refunded_to_customer:  { label: 'Refunded to customer',  tone: 'text-blue-300' },
  terminal_failure:      { label: 'Terminal failure',      tone: 'text-red-300' },
  pre_escrow:            { label: 'Pre-escrow',            tone: 'text-slate-300' },
  unknown:               { label: 'Unknown status',        tone: 'text-violet-300' },
};

function severityOf(code: string): 'high' | 'medium' | 'low' {
  return SEVERITY_BY_CODE[code] ?? 'low';
}

function formatCurrency(amount: number, ccy: string): string {
  if (amount === 0) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style:    'currency',
      currency: (ccy || 'EUR').toUpperCase(),
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${ccy}`;
  }
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function reportToMarkdown(r: ReconciliationReport): string {
  const lines: string[] = [];
  lines.push(`# Reconciliation Report — ${r.generatedAt}`);
  lines.push(``);
  lines.push(`**Scope:** ${r.scope}`);
  lines.push(`**Total docs:** ${r.totalDocs}`);
  if (r.limit != null) lines.push(`**Limit:** ${r.limit}`);
  lines.push(``);
  lines.push(`## Buckets`);
  for (const [k, v] of Object.entries(r.buckets)) {
    lines.push(`- **${k}** — ${v.count} doc(s)`);
  }
  lines.push(``);
  lines.push(`## Divergence counts by code`);
  if (Object.keys(r.divergenceCountsByCode).length === 0) {
    lines.push(`_None._`);
  } else {
    for (const [code, n] of Object.entries(r.divergenceCountsByCode)) {
      lines.push(`- \`${code}\` × ${n}`);
    }
  }
  lines.push(``);
  lines.push(`## Divergences (${r.divergences.length})`);
  for (const d of r.divergences) {
    lines.push(`- \`${d.code}\`${d.paymentId ? ` payment=${d.paymentId}` : ''}${d.bookingId ? ` booking=${d.bookingId}` : ''}${d.detail ? ` — ${d.detail}` : ''}`);
  }
  return lines.join('\n');
}

export default function ReconciliationPage() {
  const [report, setReport]   = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [tick, setTick]       = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    (adminAPI as any).reconciliation.report()
      .then((res: { data: ReconciliationReport }) => setReport(res.data))
      .catch((err: { response?: { data?: { detail?: string } }; message?: string }) => {
        const detail = err?.response?.data?.detail || err?.message || 'unknown error';
        setError(typeof detail === 'string' ? detail : JSON.stringify(detail));
      })
      .finally(() => setLoading(false));
  }, [tick]);

  const divergenceCount = report
    ? Object.values(report.divergenceCountsByCode).reduce((a, b) => a + b, 0)
    : 0;
  const isHealthy = !!report && divergenceCount === 0;

  return (
    <div data-testid="reconciliation-page" className="p-6 min-h-screen bg-slate-950 text-slate-100">
      {/* ─── Header ────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Reconciliation</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Cross-truth divergence detector over <code className="text-slate-300">service_payments</code>.
            <span className="ml-2 text-slate-500">READ-ONLY. No auto-fix.</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            data-testid="reconciliation-refresh-btn"
            onClick={() => setTick(t => t + 1)}
            className="px-3 py-1.5 rounded border border-slate-700 hover:bg-slate-800 text-xs inline-flex items-center gap-1.5"
            disabled={loading}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Run again
          </button>
          {report && (
            <>
              <button
                data-testid="reconciliation-download-json-btn"
                onClick={() => downloadFile(
                  JSON.stringify(report, null, 2),
                  `reconciliation-${report.generatedAt}.json`,
                  'application/json',
                )}
                className="px-3 py-1.5 rounded border border-slate-700 hover:bg-slate-800 text-xs inline-flex items-center gap-1.5"
              >
                <Download size={12} /> JSON
              </button>
              <button
                data-testid="reconciliation-download-md-btn"
                onClick={() => downloadFile(
                  reportToMarkdown(report),
                  `reconciliation-${report.generatedAt}.md`,
                  'text/markdown',
                )}
                className="px-3 py-1.5 rounded border border-slate-700 hover:bg-slate-800 text-xs inline-flex items-center gap-1.5"
              >
                <Download size={12} /> Markdown
              </button>
            </>
          )}
        </div>
      </div>

      {/* ─── Loading / Error ───────────────────────────────────── */}
      {loading && (
        <div data-testid="reconciliation-loading" className="text-slate-400 text-sm">Loading report...</div>
      )}
      {error && !loading && (
        <div
          data-testid="reconciliation-error"
          className="rounded border border-red-700/60 bg-red-900/20 text-red-200 px-4 py-3 inline-flex items-center gap-2 text-sm"
        >
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {/* ─── Report ────────────────────────────────────────────── */}
      {report && !loading && !error && (
        <div className="space-y-6">
          {/* Severity banner */}
          <div
            data-testid="reconciliation-severity-banner"
            className={`rounded-lg border px-4 py-3 inline-flex items-center gap-3 ${
              isHealthy
                ? 'border-emerald-700/60 bg-emerald-900/20 text-emerald-200'
                : 'border-amber-700/60 bg-amber-900/20 text-amber-200'
            }`}
          >
            {isHealthy ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
            <div>
              <div className="text-sm font-semibold">
                {isHealthy ? 'No divergences detected' : `${divergenceCount} divergence(s) detected`}
              </div>
              <div className="text-xs opacity-80 mt-0.5">
                Generated <span data-testid="reconciliation-generated-at">{report.generatedAt}</span>
                {' · '}
                <span data-testid="reconciliation-total-docs">{report.totalDocs}</span> docs scanned
              </div>
            </div>
          </div>

          {/* Buckets */}
          <section data-testid="reconciliation-buckets-section" className="bg-slate-900/60 border border-slate-700/60 rounded-lg p-4">
            <h2 className="text-sm font-semibold tracking-wide text-slate-300 uppercase mb-3">
              Buckets
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.entries(report.buckets).map(([bucket, entry]) => {
                const meta = BUCKET_LABEL[bucket] ?? { label: bucket, tone: 'text-slate-300' };
                return (
                  <div
                    key={bucket}
                    data-testid={`reconciliation-bucket-${bucket}`}
                    className="rounded border border-slate-800 bg-slate-950/60 px-3 py-3"
                  >
                    <div className={`text-xs uppercase tracking-wide ${meta.tone}`}>{meta.label}</div>
                    <div className="text-2xl font-mono mt-1">{entry.count}</div>
                    {entry.gross_by_currency && Object.entries(entry.gross_by_currency).map(([ccy, amount]) => (
                      <div key={ccy} className="text-xs font-mono text-slate-400 mt-1">
                        gross: {formatCurrency(amount, ccy)}
                      </div>
                    ))}
                    {entry.payout_by_currency && Object.entries(entry.payout_by_currency).map(([ccy, amount]) => (
                      <div key={ccy} className="text-xs font-mono text-slate-400">
                        payout: {formatCurrency(amount, ccy)}
                      </div>
                    ))}
                    {entry.refund_by_currency && Object.entries(entry.refund_by_currency).map(([ccy, amount]) => (
                      <div key={ccy} className="text-xs font-mono text-slate-400">
                        refund: {formatCurrency(amount, ccy)}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </section>

          {/* Divergence codes */}
          <section data-testid="reconciliation-codes-section" className="bg-slate-900/60 border border-slate-700/60 rounded-lg p-4">
            <h2 className="text-sm font-semibold tracking-wide text-slate-300 uppercase mb-3">
              Divergence codes
            </h2>
            {Object.keys(report.divergenceCountsByCode).length === 0 ? (
              <div data-testid="reconciliation-codes-empty" className="text-xs text-slate-500">No divergence codes.</div>
            ) : (
              <ul className="space-y-1">
                {Object.entries(report.divergenceCountsByCode).map(([code, n]) => {
                  const sev = severityOf(code);
                  return (
                    <li
                      key={code}
                      data-testid={`reconciliation-code-${code}`}
                      className="flex items-center justify-between px-3 py-2 rounded border border-slate-800"
                    >
                      <div className="flex items-center gap-3">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-mono ${SEVERITY_COLOR[sev]}`}>
                          {sev}
                        </span>
                        <code className="text-sm text-slate-300">{code}</code>
                      </div>
                      <span className="font-mono text-sm text-slate-400">× {n}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Divergences list with forensic deep-links */}
          <section data-testid="reconciliation-divergences-section" className="bg-slate-900/60 border border-slate-700/60 rounded-lg p-4">
            <h2 className="text-sm font-semibold tracking-wide text-slate-300 uppercase mb-3">
              Divergences  <span className="text-slate-500 normal-case font-mono">({report.divergences.length})</span>
            </h2>
            {report.divergences.length === 0 ? (
              <div data-testid="reconciliation-divergences-empty" className="text-xs text-slate-500">No divergence rows. Books balance.</div>
            ) : (
              <ul className="divide-y divide-slate-800">
                {report.divergences.map((d, idx) => {
                  const sev = severityOf(d.code);
                  // Prefer payment forensic link; fallback to booking.
                  const forensicHref = d.paymentId
                    ? `/forensic/payment/${d.paymentId}`
                    : d.bookingId
                    ? `/forensic/booking/${d.bookingId}`
                    : null;
                  return (
                    <li
                      key={`${d.code}-${idx}`}
                      data-testid={`reconciliation-divergence-row-${idx}`}
                      className="py-3 flex items-start gap-3"
                    >
                      <span className={`flex-shrink-0 mt-0.5 inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-mono ${SEVERITY_COLOR[sev]}`}>
                        {sev}
                      </span>
                      <div className="flex-1 min-w-0">
                        <code className="text-sm text-slate-200">{d.code}</code>
                        {d.detail && <div className="text-xs text-slate-400 mt-0.5">{d.detail}</div>}
                        <div className="text-xs font-mono text-slate-500 mt-1 truncate">
                          {d.paymentId && <span>payment: {d.paymentId}</span>}
                          {d.bookingId && <span className="ml-3">booking: {d.bookingId}</span>}
                          {d.status && <span className="ml-3">status: {d.status}</span>}
                        </div>
                      </div>
                      {forensicHref && (
                        <Link
                          data-testid={`reconciliation-divergence-forensic-${idx}`}
                          to={forensicHref}
                          className="flex-shrink-0 text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
                        >
                          forensic <ChevronRight size={12} />
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Top outstanding */}
          {(report.topProvidersOutstanding?.length > 0 || report.topCustomersOutstanding?.length > 0) && (
            <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div data-testid="reconciliation-top-providers" className="bg-slate-900/60 border border-slate-700/60 rounded-lg p-4">
                <h2 className="text-sm font-semibold tracking-wide text-slate-300 uppercase mb-3">Top outstanding — providers</h2>
                <ul className="space-y-1">
                  {report.topProvidersOutstanding.map((r, idx) => (
                    <li key={r.groupKey + idx} className="flex items-center justify-between px-3 py-2 rounded border border-slate-800 text-xs font-mono">
                      <span className="text-slate-300 truncate">{r.groupKey}</span>
                      <span className="text-slate-400">{r.count} · {formatCurrency(r.total, r.currency)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div data-testid="reconciliation-top-customers" className="bg-slate-900/60 border border-slate-700/60 rounded-lg p-4">
                <h2 className="text-sm font-semibold tracking-wide text-slate-300 uppercase mb-3">Top outstanding — customers</h2>
                <ul className="space-y-1">
                  {report.topCustomersOutstanding.map((r, idx) => (
                    <li key={r.groupKey + idx} className="flex items-center justify-between px-3 py-2 rounded border border-slate-800 text-xs font-mono">
                      <span className="text-slate-300 truncate">{r.groupKey}</span>
                      <span className="text-slate-400">{r.count} · {formatCurrency(r.total, r.currency)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <div className="text-xs text-slate-500 font-mono">
            <Database size={12} className="inline mr-1" />
            source: <code className="text-slate-400">GET /api/admin/reconciliation/report</code>
            <span className="mx-2">·</span>
            <Activity size={12} className="inline mr-1" />
            taxonomy: <a
              href="/api/admin/reconciliation/taxonomy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-400 hover:text-slate-200 inline-flex items-center gap-1"
            >GET /api/admin/reconciliation/taxonomy <ExternalLink size={10} /></a>
          </div>
        </div>
      )}
    </div>
  );
}

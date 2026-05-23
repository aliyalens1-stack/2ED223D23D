// Sprint 0B / E3 — Customer quote selection on a marketplace request.
//
// First consumer of `@platform/domain/state-machines/quote`. Reads
// the canonical `request_quotes` collection via
// `GET /api/requests/{requestId}/quotes`, projects each quote into
// the customer-perception domain, and exposes the accept action
// gated by `canAcceptQuote`.
//
// HARD ARCHITECTURAL GUARDRAIL — the consumer NEVER branches on raw
// `quote.status` strings. Every UI state derives from
// `customerPerceptionFor(quote, ctx)`. Race conditions across
// out-of-order polls are handled by `mergeMonotonic`.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Clock, CheckCircle2, Star, ShieldCheck, XCircle, Loader2 } from 'lucide-react';
import {
  customerPerceptionFor,
  competitivenessFor,
  effectiveStatus,
  canAcceptQuote,
  mergeMonotonic,
} from '@platform/domain/state-machines/quote';
import type {
  QuoteDoc,
  QuoteStatus,
  AccountLike,
} from '@platform/domain/contracts/quote';

interface QuotesEnvelope {
  request: { id: string; status: string; serviceKey?: string; city?: string } & Record<string, unknown>;
  quotes: QuoteDoc[];
}

const POLL_MS = 4000;

export default function CustomerQuotesPage() {
  const { id: requestId } = useParams<{ id: string }>();
  const [data, setData] = useState<QuotesEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
  // Per-quote canonical operational status, post `mergeMonotonic`.
  // Indexed by quote id. Refuses silent downgrades from out-of-order polls.
  const [statusMap, setStatusMap] = useState<Record<string, QuoteStatus | null>>({});

  // Customer account pulled from local storage. The shared module only
  // needs `kind` for permissions; consumers may ship a richer Account.
  const account: AccountLike = useMemo(() => ({
    kind: 'customer',
    userId: localStorage.getItem('userId') ?? undefined,
  }), []);

  const load = useCallback(async () => {
    if (!requestId) return;
    try {
      const res = await fetch(`/api/requests/${requestId}/quotes`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const env = await res.json() as QuotesEnvelope;
      setData(env);
      setStatusMap(prev => {
        const next = { ...prev };
        for (const q of env.quotes ?? []) {
          // Use `effectiveStatus` so a backend-still-pending quote whose
          // clock has run out is already treated as expired by the merge.
          const live = effectiveStatus(q);
          next[q.id] = mergeMonotonic(prev[q.id], live);
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    }
  }, [requestId]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const accept = useCallback(async (quote: QuoteDoc) => {
    // Pre-flight gate matches backend rule. Backend re-validates.
    if (!canAcceptQuote(quote, account)) return;
    setAccepting(quote.id);
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch(`/api/quotes/${quote.id}/accept`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setAccepting(null);
    }
  }, [account, load]);

  if (!requestId) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 md:px-6 py-10" data-testid="customer-quotes-page">
      <Link to="/dashboard/requests" className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-6">
        <ArrowLeft size={16} /> Back to my requests
      </Link>

      <h1 className="text-3xl font-extrabold mb-2" data-testid="quotes-title">Provider quotes</h1>
      <p className="text-sm text-[var(--text-2)] mb-6">
        Select a provider to confirm the booking. Quotes expire automatically.
      </p>

      {error && (
        <div className="rounded-xl border border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)] px-4 py-3 text-sm font-bold mb-4" data-testid="quotes-error">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-10 text-center" data-testid="quotes-loading">
          <Loader2 size={28} className="mx-auto animate-spin mb-3 text-[var(--primary-h)]" />
          <p className="text-sm text-[var(--text-2)]">Loading quotes…</p>
        </div>
      )}

      {data && (data.quotes ?? []).length === 0 && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-10 text-center" data-testid="quotes-empty">
          <h3 className="text-lg font-extrabold mb-1">No quotes yet</h3>
          <p className="text-sm text-[var(--text-2)]">Providers in your city are reviewing the request.</p>
        </div>
      )}

      <div className="grid gap-3" data-testid="quotes-list">
        {(data?.quotes ?? []).map(q => {
          // Build a synthesised doc with our merged operational status so
          // perception/permissions agree with the canonical view.
          const merged: QuoteDoc = { ...q, status: statusMap[q.id] ?? q.status };
          const perception = customerPerceptionFor(merged);
          const competitiveness = competitivenessFor(merged);
          const acceptable = canAcceptQuote(merged, account);
          const isSelected = perception === 'selected';
          return (
            <article
              key={q.id}
              className={`rounded-2xl border p-5 bg-white shadow-[var(--shadow-card)] transition ${
                isSelected
                  ? 'border-[var(--success)]'
                  : perception === 'unavailable'
                  ? 'border-[var(--border)] opacity-60'
                  : 'border-[var(--border)] hover:border-[var(--primary)]'
              }`}
              data-testid={`quote-card-${q.id}`}
              data-perception={perception}
              data-competitiveness={competitiveness}
            >
              <header className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="text-lg font-extrabold flex items-center gap-2" data-testid={`quote-provider-name-${q.id}`}>
                    {q.provider?.name ?? q.providerSlug}
                    {q.provider?.tuvVerified && (
                      <span title="TÜV verified" className="inline-flex items-center text-[var(--primary-h)]">
                        <ShieldCheck size={16} />
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-sm text-[var(--text-2)]">
                    {typeof q.provider?.rating === 'number' && (
                      <span className="inline-flex items-center gap-1">
                        <Star size={13} /> {q.provider.rating.toFixed(1)}
                        {q.provider?.reviews ? <span className="text-xs">({q.provider.reviews})</span> : null}
                      </span>
                    )}
                    {q.responseTime && (
                      <span className="inline-flex items-center gap-1">
                        <Clock size={13} /> {q.responseTime}
                      </span>
                    )}
                  </div>
                </div>
                <PerceptionBadge perception={perception} testId={`quote-status-${q.id}`} />
              </header>

              {q.message && (
                <p className="text-sm text-[var(--text-2)] mb-3">{q.message}</p>
              )}

              <footer className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-2xs uppercase tracking-widest text-[var(--text-soft)]">Price from</div>
                  <div className="text-2xl font-extrabold" data-testid={`quote-price-${q.id}`}>
                    €{q.priceFrom}
                  </div>
                </div>
                {acceptable ? (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={accepting === q.id}
                    onClick={() => accept(merged)}
                    data-testid={`quote-accept-btn-${q.id}`}
                  >
                    {accepting === q.id ? 'Accepting…' : 'Select this provider'}
                  </button>
                ) : isSelected ? (
                  <span className="inline-flex items-center gap-1 text-sm font-bold text-[var(--success)]" data-testid={`quote-selected-mark-${q.id}`}>
                    <CheckCircle2 size={16} /> Selected
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-sm text-[var(--text-soft)]" data-testid={`quote-unavailable-mark-${q.id}`}>
                    <XCircle size={14} /> Unavailable
                  </span>
                )}
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function PerceptionBadge({ perception, testId }: { perception: string; testId: string }) {
  // Approval-vs-revision distinction expressed through semantic tier intensity:
  //   pending     → warning  (medium intensity, awaiting action)
  //   available   → primary  (brand-actionable, draws customer attention)
  //   selected    → success  (terminal approval, highest intensity)
  //   unavailable → neutral  (lowest intensity, structurally present but inert)
  // Intensity ladder preserves the customer's read of approval state without
  // resorting to chroma drift outside the substrate.
  const styles: Record<string, string> = {
    pending: 'bg-[var(--warning-soft)] text-[var(--warning)] border-[var(--warning)]',
    available: 'bg-[var(--primary-soft)] text-[var(--primary-p)] border-[var(--primary)]',
    selected: 'bg-[var(--success-soft)] text-[var(--success)] border-[var(--success)]',
    unavailable: 'bg-[var(--surface-soft)] text-[var(--text-soft)] border-[var(--border)]',
  };
  const cls = styles[perception] ?? styles.unavailable;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-0.5 text-xs font-bold uppercase tracking-wider ${cls}`}
      data-testid={testId}
    >
      {perception}
    </span>
  );
}

/**
 * P4.1 — Admin Forensic Graph Page
 *
 * Consumes /api/admin/forensic-graph/{entity_type}/{entity_id}
 * (mounted in P3.4) and renders the navigation graph as a DENSE
 * EVIDENCE MAP — not a force-directed graph, not React Flow.
 *
 * Doctrine (per P4 brief):
 *   "compose existing truth into operator navigation"
 *
 *   - No graph library.
 *   - No analytics dashboard.
 *   - No auto-remediation.
 *   - No AI summary.
 *   - No new backend facts.
 *
 * What it does:
 *   1. Show root node with its raw fields (expandable JSON).
 *   2. List every connected node (kind/id/data) with deeplink.
 *   3. List every edge (rel/target/deeplink) clickable.
 *   4. Allow operator to jump to another forensic root (booking <-> payment <-> dispute).
 *   5. Surface chronology / timeline deeplinks as one-click follow.
 */
import { useEffect, useState, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ChevronRight, ExternalLink, Copy, ArrowLeft, RefreshCw,
  AlertCircle, Receipt, Calendar, MessageSquare, Star,
  User, Building2, CreditCard, FileText, Activity,
} from 'lucide-react';
import { adminAPI } from '../services/api';

type EntityType = 'booking' | 'payment' | 'dispute';

interface GraphNode {
  kind: string;
  id: string | null;
  data: Record<string, unknown> | null;
}
interface GraphEdge {
  rel: string;
  kind: string;
  id: string;
  deeplink: string;
}
interface ForensicGraph {
  root: string;
  rootId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const KIND_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  booking:  Calendar,
  payment:  CreditCard,
  dispute:  MessageSquare,
  review:   Star,
  user:     User,
  organization: Building2,
  stripe:   ExternalLink,
};

const KIND_COLOR: Record<string, string> = {
  booking:  'bg-blue-500/20 text-blue-300 border-blue-500/40',
  payment:  'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  dispute:  'bg-amber-500/20 text-amber-300 border-amber-500/40',
  review:   'bg-purple-500/20 text-purple-300 border-purple-500/40',
  user:     'bg-slate-500/20 text-slate-300 border-slate-500/40',
  organization: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  stripe:   'bg-violet-500/20 text-violet-300 border-violet-500/40',
};

const REL_LABEL: Record<string, string> = {
  payment_for:           'Payment for',
  chronology_of:         'Chronology of',
  dispute_of:            'Dispute on',
  review_of:             'Review of',
  booking_of:            'Booking of',
  booking_for:           'Booking for',
  timeline_of:           'Timeline of',
  customer_of:           'Customer',
  provider_of:           'Provider',
  stripe_payment_intent: 'Stripe PI',
  stripe_transfer:       'Stripe Transfer',
};

function KindBadge({ kind }: { kind: string }) {
  const Icon = KIND_ICON[kind] || FileText;
  const cls  = KIND_COLOR[kind] || 'bg-slate-500/20 text-slate-300 border-slate-500/40';
  return (
    <span
      data-testid={`forensic-kind-badge-${kind}`}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-xs font-mono uppercase ${cls}`}
    >
      <Icon size={12} />
      {kind}
    </span>
  );
}

function JsonExpand({ data, testid }: { data: unknown; testid: string }) {
  const [open, setOpen] = useState(false);
  if (data === null || data === undefined) return <span className="text-slate-500 text-xs">—</span>;
  return (
    <div data-testid={testid} className="mt-2">
      <button
        data-testid={`${testid}-toggle`}
        onClick={() => setOpen(!open)}
        className="text-xs text-slate-400 hover:text-slate-200 inline-flex items-center gap-1"
      >
        <ChevronRight size={12} className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
        Raw JSON
      </button>
      {open && (
        <pre
          data-testid={`${testid}-content`}
          className="mt-2 text-xs font-mono bg-slate-900/80 border border-slate-700/60 rounded p-3 overflow-auto max-h-72 text-slate-300"
        >
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function copyToClipboard(text: string) {
  void navigator.clipboard?.writeText(text);
}

/**
 * Map an internal deeplink (`/api/admin/payments/xxx/chronology`) to a route
 * the operator can follow inside this SPA. External URLs (Stripe) pass through.
 */
function mapDeeplinkToRoute(deeplink: string, edge: GraphEdge): { internal: boolean; href: string; label: string } {
  // External (Stripe etc.)
  if (deeplink.startsWith('http')) {
    return { internal: false, href: deeplink, label: 'open external' };
  }

  // Forensic chronology → still a backend GET. Surface as raw fetch.
  if (deeplink.includes('/chronology')) {
    return { internal: false, href: deeplink, label: 'chronology JSON' };
  }
  if (deeplink.includes('/timeline')) {
    return { internal: false, href: deeplink, label: 'timeline JSON' };
  }

  // Cross-jumps between forensic roots
  if (deeplink.startsWith('/api/admin/payments/')) {
    const id = deeplink.split('/')[4];
    return { internal: true, href: `/forensic/payment/${id}`, label: 'jump to payment forensic' };
  }
  if (deeplink.startsWith('/api/admin/bookings/')) {
    const id = deeplink.split('/')[4];
    return { internal: true, href: `/forensic/booking/${id}`, label: 'jump to booking forensic' };
  }
  if (deeplink.startsWith('/api/admin/disputes/')) {
    const id = deeplink.split('/')[4];
    return { internal: true, href: `/forensic/dispute/${id}`, label: 'jump to dispute forensic' };
  }

  // Default: surface raw URL.
  return { internal: false, href: deeplink, label: 'open URL' };
}

export default function ForensicGraphPage() {
  const { entityType, entityId } = useParams<{ entityType: EntityType; entityId: string }>();
  const navigate = useNavigate();

  const [graph, setGraph]       = useState<ForensicGraph | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [refreshTick, setTick]  = useState(0);

  useEffect(() => {
    if (!entityType || !entityId) return;
    if (!['booking', 'payment', 'dispute'].includes(entityType)) {
      setError(`Unsupported entity type: ${entityType}`);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const fetcher = (adminAPI as any).forensicGraph[entityType] as (id: string) => Promise<{ data: ForensicGraph }>;
    fetcher(entityId)
      .then(res => setGraph(res.data))
      .catch(err => {
        const detail = err?.response?.data?.detail || err?.message || 'unknown error';
        setError(typeof detail === 'string' ? detail : JSON.stringify(detail));
      })
      .finally(() => setLoading(false));
  }, [entityType, entityId, refreshTick]);

  const rootNode = useMemo(() => graph?.nodes.find(n => n.kind === entityType), [graph, entityType]);
  const relatedNodes = useMemo(() => graph?.nodes.filter(n => n.kind !== entityType) ?? [], [graph, entityType]);

  return (
    <div data-testid="forensic-graph-page" className="p-6 min-h-screen bg-slate-950 text-slate-100">
      {/* ─── Header ────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            data-testid="forensic-back-btn"
            onClick={() => navigate(-1)}
            className="p-2 rounded hover:bg-slate-800 transition"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-xl font-semibold tracking-tight" data-testid="forensic-title">
              Forensic Graph
            </h1>
            <p className="text-xs text-slate-400 mt-0.5 font-mono">
              <KindBadge kind={entityType ?? '?'} /> <span className="ml-2">{entityId}</span>
            </p>
          </div>
        </div>
        <button
          data-testid="forensic-refresh-btn"
          onClick={() => setTick(t => t + 1)}
          className="px-3 py-1.5 rounded border border-slate-700 hover:bg-slate-800 text-xs inline-flex items-center gap-1.5"
        >
          <RefreshCw size={12} /> Reload
        </button>
      </div>

      {/* ─── Loading / Error ───────────────────────────────────── */}
      {loading && (
        <div data-testid="forensic-loading" className="text-slate-400 text-sm">Loading forensic graph...</div>
      )}
      {error && !loading && (
        <div
          data-testid="forensic-error"
          className="rounded border border-red-700/60 bg-red-900/20 text-red-200 px-4 py-3 inline-flex items-center gap-2 text-sm"
        >
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {/* ─── Graph body ────────────────────────────────────────── */}
      {graph && !loading && !error && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Root + raw JSON */}
          <section
            data-testid="forensic-root-section"
            className="lg:col-span-1 bg-slate-900/60 border border-slate-700/60 rounded-lg p-4"
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold tracking-wide text-slate-300 uppercase">
                Root
              </h2>
              <button
                data-testid="forensic-copy-root-id"
                onClick={() => copyToClipboard(graph.rootId)}
                className="text-xs text-slate-500 hover:text-slate-300 inline-flex items-center gap-1"
                title="Copy root id"
              >
                <Copy size={12} /> id
              </button>
            </div>
            <KindBadge kind={graph.root} />
            <div className="mt-2 text-xs font-mono text-slate-400 break-all">{graph.rootId}</div>
            <JsonExpand data={rootNode?.data} testid="forensic-root-json" />
          </section>

          {/* Related nodes + edges */}
          <section
            data-testid="forensic-related-section"
            className="lg:col-span-2 space-y-4"
          >
            <div className="bg-slate-900/60 border border-slate-700/60 rounded-lg p-4">
              <h2 className="text-sm font-semibold tracking-wide text-slate-300 uppercase mb-3">
                Related entities  <span className="text-slate-500 normal-case font-mono">({relatedNodes.length})</span>
              </h2>
              {relatedNodes.length === 0 ? (
                <div data-testid="forensic-no-related" className="text-xs text-slate-500">No connected entities found.</div>
              ) : (
                <ul className="divide-y divide-slate-800">
                  {relatedNodes.map((n, idx) => (
                    <li
                      key={`${n.kind}-${n.id ?? idx}`}
                      data-testid={`forensic-related-node-${idx}`}
                      className="py-3 flex items-start gap-3"
                    >
                      <div className="flex-shrink-0 mt-0.5">
                        <KindBadge kind={n.kind} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-mono text-slate-300 break-all">{n.id ?? '—'}</div>
                        <JsonExpand data={n.data} testid={`forensic-related-json-${idx}`} />
                      </div>
                      {/* Cross-jump if this kind is a forensic root */}
                      {['booking', 'payment', 'dispute'].includes(n.kind) && n.id && (
                        <Link
                          data-testid={`forensic-jump-${n.kind}-${idx}`}
                          to={`/forensic/${n.kind}/${n.id}`}
                          className="flex-shrink-0 text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
                        >
                          forensic <ChevronRight size={12} />
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-slate-900/60 border border-slate-700/60 rounded-lg p-4">
              <h2 className="text-sm font-semibold tracking-wide text-slate-300 uppercase mb-3">
                Edges  <span className="text-slate-500 normal-case font-mono">({graph.edges.length})</span>
              </h2>
              {graph.edges.length === 0 ? (
                <div data-testid="forensic-no-edges" className="text-xs text-slate-500">No edges.</div>
              ) : (
                <ul className="space-y-2">
                  {graph.edges.map((e, idx) => {
                    const link = mapDeeplinkToRoute(e.deeplink, e);
                    return (
                      <li
                        key={`${e.rel}-${e.id}-${idx}`}
                        data-testid={`forensic-edge-${idx}`}
                        className="flex items-center gap-3 px-3 py-2 rounded border border-slate-800 bg-slate-900/40 hover:bg-slate-900/80 transition"
                      >
                        <span className="text-xs font-mono uppercase tracking-wide text-slate-400 min-w-[10rem]">
                          {REL_LABEL[e.rel] ?? e.rel}
                        </span>
                        <KindBadge kind={e.kind} />
                        <span className="text-xs font-mono text-slate-400 truncate flex-1">{e.id}</span>
                        {link.internal ? (
                          <Link
                            data-testid={`forensic-edge-internal-${idx}`}
                            to={link.href}
                            className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1 flex-shrink-0"
                          >
                            {link.label} <ChevronRight size={12} />
                          </Link>
                        ) : (
                          <a
                            data-testid={`forensic-edge-external-${idx}`}
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1 flex-shrink-0"
                          >
                            {link.label} <ExternalLink size={12} />
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="text-xs text-slate-500 font-mono">
              <Activity size={12} className="inline mr-1" />
              source: <code className="text-slate-400">GET /api/admin/forensic-graph/{entityType}/{entityId}</code>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ShieldCheck,
  Inbox,
  Activity,
  MapPin,
  Bell,
  Shield,
  CreditCard,
  MessageSquare,
  TrendingUp,
  Headphones,
  Key,
  ClipboardCheck,
  Briefcase,
  Sparkles,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import api from '../services/api';

// ─────────────────────────────────────────────────────────────────────
// Phase 1.2 — Dashboard restored as governance entry shell.
//
// Doctrine:
//   visible == operational
//
// No KPIs, no charts, no ML promises, no automation cards.
// Just a discovery + health view of the operationally-alive domains.
// Each card pings its endpoint once on mount; the result is a single
// dot:  ●green / ●amber / ●red.
//
// This page deliberately does NOT call `adminAPI.getDashboard()` or
// `getMarketMetrics()` — those backends are gone with the rest of the
// dead admin civilization. If/when reconciliation, payouts, or trust
// projections grow real numeric surfaces, those become *separate*
// pages, linked from here. The Dashboard itself never aggregates.
// ─────────────────────────────────────────────────────────────────────

type Status = 'ok' | 'degraded' | 'down' | 'pending';

interface Card {
  to: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  hint: string;
  probe: string;   // /api/... endpoint to fetch (HEAD-ish — we do GET)
  expects?: number[]; // any of these status codes = ok
}

const OPERATIONAL_DOMAINS: { group: string; cards: Card[] }[] = [
  {
    group: 'Governance',
    cards: [
      {
        to: '/governance-score',
        icon: Shield,
        label: 'Governance Score',
        hint: 'Aggregate policy posture',
        probe: '/admin/governance/score',
        expects: [200],
      },
      {
        to: '/verification-queue',
        icon: ShieldCheck,
        label: 'Verification Queue',
        hint: 'Pending operator review',
        probe: '/admin/verification-queue',
        expects: [200, 401, 403],
      },
      {
        to: '/system/errors',
        icon: AlertTriangle,
        label: 'System Errors',
        hint: 'Telemetry stream',
        probe: '/system/errors',
        expects: [200, 401, 403],
      },
    ],
  },
  {
    group: 'Money & disputes',
    cards: [
      {
        to: '/payments',
        icon: CreditCard,
        label: 'Payments',
        hint: 'Payment lifecycle + forensic',
        probe: '/admin/payments',
        expects: [200],
      },
      {
        to: '/disputes',
        icon: MessageSquare,
        label: 'Disputes',
        hint: 'Arbitration + resolution',
        probe: '/admin/disputes',
        expects: [200],
      },
      {
        to: '/billing/stripe',
        icon: CreditCard,
        label: 'Stripe Payments',
        hint: 'Connect + checkout state',
        probe: '/admin/stripe/config',
        expects: [200],
      },
      {
        to: '/billing/stripe-settings',
        icon: Key,
        label: 'Stripe Settings',
        hint: 'Connect onboarding + keys',
        probe: '/admin/stripe/config',
        expects: [200],
      },
      {
        to: '/billing/support-chat',
        icon: Headphones,
        label: 'Support Chat',
        hint: 'Customer ↔ ops thread',
        probe: '/chat/v1/admin/threads',
        expects: [200, 401, 403],
      },
      {
        to: '/revenue',
        icon: TrendingUp,
        label: 'Revenue Dashboard',
        hint: 'Realized revenue rollup',
        probe: '/admin/revenue/dashboard',
        expects: [200],
      },
    ],
  },
  {
    group: 'Operations',
    cards: [
      {
        to: '/inbox',
        icon: Inbox,
        label: 'Admin Inbox',
        hint: 'Customer ↔ ops threads',
        probe: '/chat/v1/admin/threads',
        expects: [200, 401, 403],
      },
      {
        to: '/assignments',
        icon: Activity,
        label: 'Assignments',
        hint: 'Operator allocation',
        probe: '/admin/assignments',
        expects: [200],
      },
      {
        to: '/ops-map',
        icon: MapPin,
        label: 'Ops Map',
        hint: 'Field operator topology',
        probe: '/admin/operations/map',
        expects: [200, 401, 403],
      },
      {
        to: '/notifications',
        icon: Bell,
        label: 'Notifications',
        hint: 'System notification log',
        probe: '/admin/notifications/templates',
        expects: [200, 401, 403],
      },
    ],
  },
  {
    group: 'Marketplace',
    cards: [
      {
        to: '/auto-requests',
        icon: ClipboardCheck,
        label: 'Auto Requests',
        hint: 'Inbound service requests',
        probe: '/admin/auto-requests/active',
        expects: [200, 401, 403],
      },
      {
        to: '/service-marketplace',
        icon: Briefcase,
        label: 'Service Marketplace',
        hint: 'Provider supply layer',
        probe: '/marketplace/providers',
        expects: [200],
      },
      {
        to: '/car-selection',
        icon: Sparkles,
        label: 'Car Selection',
        hint: 'Advisory workflow ops',
        probe: '/admin/car-selection',
        expects: [200],
      },
    ],
  },
];

function StatusDot({ status }: { status: Status }) {
  const map: Record<Status, { cls: string; icon: React.ReactNode; label: string }> = {
    ok:       { cls: 'bg-green-500',  icon: <CheckCircle2 size={12} />, label: 'OK' },
    degraded: { cls: 'bg-amber-500',  icon: <AlertTriangle size={12} />, label: 'DEGRADED' },
    down:     { cls: 'bg-red-500',    icon: <XCircle size={12} />,      label: 'DOWN' },
    pending:  { cls: 'bg-slate-500',  icon: <Loader2 size={12} className="animate-spin" />, label: '…' },
  };
  const m = map[status];
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={m.label}
      data-testid={`status-${status}`}
    >
      <span className={`w-2 h-2 rounded-full ${m.cls}`} />
    </span>
  );
}

function DomainCard({ card, status }: { card: Card; status: Status }) {
  const Icon = card.icon;
  return (
    <Link
      to={card.to}
      className="block bg-slate-800 hover:bg-slate-750 border border-slate-700 hover:border-slate-600 rounded-xl p-5 transition-colors group"
      data-testid={`dashboard-card-${card.to.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="p-2 rounded-lg bg-slate-700 group-hover:bg-slate-600 transition-colors">
          <Icon size={18} className="text-slate-200" />
        </div>
        <StatusDot status={status} />
      </div>
      <h3 className="text-white font-medium leading-snug">{card.label}</h3>
      <p className="text-slate-400 text-xs mt-1">{card.hint}</p>
    </Link>
  );
}

export default function DashboardPage() {
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const probeAll = useCallback(async () => {
    setRefreshing(true);
    const cards = OPERATIONAL_DOMAINS.flatMap((g) => g.cards);
    const next: Record<string, Status> = {};
    await Promise.all(
      cards.map(async (c) => {
        try {
          const r = await api.get(c.probe, { validateStatus: () => true, timeout: 5000 });
          const ok = (c.expects ?? [200]).includes(r.status);
          // 401/403 in expects means: the endpoint exists and the gate is
          // working. That's "operational" from a topology standpoint.
          next[c.to] = ok ? 'ok' : r.status >= 500 ? 'down' : 'degraded';
        } catch {
          next[c.to] = 'down';
        }
      }),
    );
    setStatuses(next);
    setLastChecked(new Date());
    setRefreshing(false);
  }, []);

  useEffect(() => {
    probeAll();
  }, [probeAll]);

  return (
    <div className="p-6 space-y-6" data-testid="admin-dashboard">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Operational Console</h1>
          <p className="text-slate-400 text-sm">
            Governance + financial operations entry shell.{' '}
            {lastChecked && (
              <span className="text-slate-500">
                Probes refreshed{' '}
                {lastChecked.toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
            )}
          </p>
        </div>
        <button
          onClick={probeAll}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors disabled:opacity-50"
          data-testid="dashboard-refresh-btn"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {OPERATIONAL_DOMAINS.map((group) => (
        <section key={group.group} data-testid={`dashboard-group-${group.group.toLowerCase().replace(/\s+/g, '-')}`}>
          <h2 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-3">
            {group.group}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {group.cards.map((card) => (
              <DomainCard
                key={card.to}
                card={card}
                status={statuses[card.to] ?? 'pending'}
              />
            ))}
          </div>
        </section>
      ))}

      <footer className="pt-6 border-t border-slate-800 text-slate-500 text-xs">
        Frozen domains (Users / Providers / Bookings / Quotes / Reviews / Map / GeoOps /
        FeatureFlags / Audit Log / Inspection Forensics / Live Monitor / System Health /
        Incidents / Request Flow) are intentionally hidden until their FastAPI surfaces land.
        Direct URLs redirect to this page.
      </footer>
    </div>
  );
}

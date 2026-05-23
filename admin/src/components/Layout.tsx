import { useState, useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard, CreditCard, MessageSquare, LogOut, MapPin, Inbox,
  Bell, Search, Zap, AlertTriangle, Wifi, WifiOff, Shield,
  Activity, TrendingUp, Sparkles, Headphones, ClipboardCheck,
  ShieldCheck, Briefcase, Key, Brain, Star, Plug, Scale,
} from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import GlobalSearchModal from './GlobalSearchModal';
import QuickActionsPanel from './QuickActionsPanel';
import NotificationBell from './NotificationBell';
import { useRealtimeConnection, useAlerts } from '../hooks/useRealtime';

// ─────────────────────────────────────────────────────────────────────
// Phase 1.2 — surface compression.
//
// This nav contains ONLY operational, working routes. Frozen domains
// (Users / Providers / Bookings / Quotes / Reviews / Map / GeoOps / etc.)
// remain on disk as page files but are no longer visible.
//
// Invariant going forward:
//   "visible == operational"
//
// Any new entry in this list must hit a working FastAPI endpoint.
// Adding a route here without a live backend is the topology drift
// we just spent the sprint correcting. Don't reintroduce it.
// ─────────────────────────────────────────────────────────────────────

const navGroups = [
  {
    label: 'CORE',
    items: [
      { to: '/',                  icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/verification-queue',icon: ShieldCheck,     label: 'Verification Queue' },
      { to: '/inbox',             icon: Inbox,           label: 'Inbox' },
      { to: '/assignments',       icon: Activity,        label: 'Assignments' },
      { to: '/ops-map',           icon: MapPin,          label: 'Ops Map' },
      { to: '/notifications',     icon: Bell,            label: 'Notifications' },
    ],
  },
  {
    label: 'GOVERNANCE',
    items: [
      { to: '/governance-score',  icon: Shield,          label: 'Governance Score' },
      { to: '/forecast',          icon: Brain,           label: 'Forecast' },
      { to: '/reputation',        icon: Star,            label: 'Reputation' },
      { to: '/zone-control',      icon: MapPin,          label: 'Zone Control' },
      { to: '/integrations',      icon: Plug,            label: 'Integrations' },
      { to: '/system/errors',     icon: AlertTriangle,   label: 'System Errors' },
      { to: '/reconciliation',    icon: Scale,           label: 'Reconciliation' },
    ],
  },
  {
    label: 'MARKETPLACE',
    items: [
      { to: '/auto-requests',           icon: ClipboardCheck, label: 'Auto Requests' },
      { to: '/service-marketplace',     icon: Briefcase,      label: 'Service Marketplace' },
      { to: '/service-marketplace/map', icon: MapPin,         label: 'Marketplace Map' },
      { to: '/car-selection',           icon: Sparkles,       label: 'Car Selection' },
      { to: '/auto-payments',           icon: CreditCard,     label: 'Payments & Credits' },
    ],
  },
  {
    label: 'NOTIFY',
    items: [
      { to: '/customer-notify',           icon: Bell, label: 'Customer Notify' },
      { to: '/customer-notify/lifecycle', icon: Bell, label: 'Delivery Lifecycle' },
    ],
  },
  {
    label: 'FINANCE',
    items: [
      { to: '/payments',                 icon: CreditCard,   label: 'Payments' },
      { to: '/disputes',                 icon: MessageSquare,label: 'Disputes' },
      { to: '/billing/stripe',           icon: CreditCard,   label: 'Stripe Setup' },
      { to: '/billing/stripe-settings',  icon: Key,          label: 'Stripe Settings' },
      { to: '/billing/support-chat',     icon: Headphones,   label: 'Support Chat' },
      { to: '/revenue',                  icon: TrendingUp,   label: 'Revenue' },
    ],
  },
];

export default function Layout() {
  const { user, logout } = useAuthStore();
  const [searchOpen, setSearchOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const { isConnected } = useRealtimeConnection();
  const { alerts } = useAlerts();

  const criticalAlerts = alerts.filter((a) => a.type === 'critical').length;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        setActionsOpen(false);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        setActionsOpen(true);
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex h-screen bg-slate-900">
      <aside className="w-64 bg-slate-800 border-r border-slate-700 flex flex-col">
        <div className="p-4 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <img
                src="/api/admin-panel/logo.png"
                alt="A | Search Experts"
                style={{ height: 40, width: 'auto', objectFit: 'contain' }}
              />
              <span className="text-[10px] font-bold text-slate-500 tracking-widest">
                CONTROL CENTER
              </span>
            </div>
            <div className="flex items-center gap-2">
              <NotificationBell enabled={!!user} />
              <div
                className={`p-1.5 rounded-full ${
                  isConnected ? 'bg-green-500/20' : 'bg-red-500/20'
                }`}
                data-testid="realtime-indicator"
              >
                {isConnected ? (
                  <Wifi className="w-4 h-4 text-green-400" />
                ) : (
                  <WifiOff className="w-4 h-4 text-red-400" />
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="p-3 space-y-2">
          <button
            onClick={() => setSearchOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-slate-400 transition-colors"
            data-testid="admin-search-btn"
          >
            <Search className="w-4 h-4" />
            <span className="flex-1 text-left text-sm">Search...</span>
            <kbd className="px-1.5 py-0.5 bg-slate-600 rounded text-xs">⌘K</kbd>
          </button>
          <button
            onClick={() => setActionsOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-amber-500/20 hover:bg-amber-500/30 rounded-lg text-amber-400 transition-colors"
            data-testid="admin-quick-actions-btn"
          >
            <Zap className="w-4 h-4" />
            <span className="flex-1 text-left text-sm font-medium">Quick Actions</span>
            <kbd className="px-1.5 py-0.5 bg-amber-500/20 rounded text-xs">⌘J</kbd>
          </button>
        </div>

        {criticalAlerts > 0 && (
          <div className="mx-3 mb-2 px-3 py-2 bg-red-500/20 border border-red-500/30 rounded-lg">
            <div className="flex items-center gap-2 text-red-400">
              <AlertTriangle className="w-4 h-4" />
              <span className="text-sm font-medium">{criticalAlerts} Critical Alerts</span>
            </div>
          </div>
        )}

        <nav className="flex-1 p-2 space-y-4 overflow-auto">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="px-3 py-1 text-xs font-medium text-slate-500 uppercase tracking-wider">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-sm ${
                        isActive
                          ? 'bg-primary text-white'
                          : 'text-slate-300 hover:bg-slate-700'
                      }`
                    }
                    data-testid={`nav-link-${item.to.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}`}
                  >
                    <item.icon size={18} />
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-slate-700">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-primary rounded-full flex items-center justify-center">
              <span className="text-white font-medium">
                {user?.firstName?.[0] || user?.email?.[0]?.toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {user?.firstName || user?.email}
              </p>
              <p className="text-xs text-slate-400">Operator</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-2 w-full px-3 py-2 text-slate-300 hover:bg-slate-700 rounded-lg transition-colors"
            data-testid="admin-logout-btn"
          >
            <LogOut size={18} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>

      <GlobalSearchModal isOpen={searchOpen} onClose={() => setSearchOpen(false)} />
      <QuickActionsPanel isOpen={actionsOpen} onClose={() => setActionsOpen(false)} />
    </div>
  );
}

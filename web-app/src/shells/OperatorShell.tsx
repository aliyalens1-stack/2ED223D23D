/**
 * Shell Split α — OperatorShell.
 *
 * Rendered for routes inside the operator workspace (currently `/provider/*`).
 *
 *   Operator principal during α =
 *       activeAccount.kind === 'inspector'
 *     OR legacy role === 'provider_owner' / 'provider_manager' / 'admin'.
 *   Union is intentional during the transitional ontology window —
 *   quarantine has not yet collapsed `provider_*` into `inspector`.
 *   Migration to pure `kind === 'inspector'` is a post-quarantine operation,
 *   out of α scope.
 *
 * The route guard enforces this principal; the shell itself is not a guard.
 *
 * Inspector workspace (`/inspector/*`) keeps its own self-contained shell
 * (`InspectorWorkspace`) — α does not migrate it, see canonical_surface_map §4.
 *
 * Navigation: operator-only tabs (Workbench · Inbox · Current Job · Earnings ·
 * Demand · Profile · Billing). No customer cabinet links. No marketing footer.
 */
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { Bell, LogOut, Menu, X, Inbox, Briefcase, DollarSign, TrendingUp, User as UserIcon } from 'lucide-react';
import { useState, useEffect, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { notificationsAPI } from '../services/api';
import Logo from '../components/Logo';
import LanguageSwitcher from '../components/LanguageSwitcher';
import AccountSwitcher from './AccountSwitcher';

export default function OperatorShell() {
  const { user, token, logout } = useAuthStore();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!token) return;
    notificationsAPI.getUnreadCount().then(r => setUnread(r.data?.count ?? 0)).catch(() => {});
  }, [token]);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex flex-col" data-testid="shell-operator">
      <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 md:px-6">
          <Link to="/" className="flex items-center shrink-0" data-testid="brand-link">
            <Logo height={32} />
          </Link>

          <nav className="ml-auto hidden md:flex items-center gap-1">
            <NavItem to="/provider/workbench" testId="nav-op-workbench">{t('nav.dashboard')}</NavItem>
            <NavItem to="/provider/inbox" testId="nav-op-inbox">{t('nav.requests')}</NavItem>
            <NavItem to="/provider/current-job" testId="nav-op-current">{t('nav.current_job')}</NavItem>
            <NavItem to="/provider/earnings" testId="nav-op-earn">{t('nav.earnings')}</NavItem>
            <NavItem to="/provider/demand" testId="nav-op-demand">{t('nav.demand')}</NavItem>
            <NavItem to="/provider/profile" testId="nav-op-profile">{t('nav.profile')}</NavItem>
            <NavItem to="/provider/billing" testId="nav-op-billing">{t('nav.billing') || 'Billing'}</NavItem>
            <LanguageSwitcher compact />
            <AccountSwitcher />
            <UserMenu user={user} unread={unread} onLogout={() => { logout(); navigate('/'); }} />
          </nav>

          <button
            onClick={() => setMobileOpen(true)}
            className="md:hidden ml-auto inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-white h-10 w-10"
            data-testid="header-burger"
            aria-label={t('common.open_menu')}
          >
            <Menu size={18} />
          </button>
        </div>
      </header>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" data-testid="mobile-drawer">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute right-0 top-0 h-full w-80 max-w-[88vw] bg-white border-l border-[var(--border)] flex flex-col">
            <div className="h-16 flex items-center justify-between px-5 border-b border-[var(--border)]">
              <span className="font-bold">{t('common.menu')}</span>
              <button onClick={() => setMobileOpen(false)} className="h-9 w-9 rounded-lg hover:bg-[var(--surface-soft)] flex items-center justify-center" aria-label={t('common.close_menu')}><X size={18} /></button>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 py-4 space-y-0.5">
              <DrawerItem to="/provider/workbench" onClick={() => setMobileOpen(false)} icon={<Briefcase size={16} />}>{t('nav.dashboard')}</DrawerItem>
              <DrawerItem to="/provider/inbox" onClick={() => setMobileOpen(false)} icon={<Inbox size={16} />}>{t('nav.requests')}</DrawerItem>
              <DrawerItem to="/provider/current-job" onClick={() => setMobileOpen(false)} icon={<Briefcase size={16} />}>{t('nav.current_job')}</DrawerItem>
              <DrawerItem to="/provider/earnings" onClick={() => setMobileOpen(false)} icon={<DollarSign size={16} />}>{t('nav.earnings')}</DrawerItem>
              <DrawerItem to="/provider/demand" onClick={() => setMobileOpen(false)} icon={<TrendingUp size={16} />}>{t('nav.demand')}</DrawerItem>
              <DrawerItem to="/provider/profile" onClick={() => setMobileOpen(false)} icon={<UserIcon size={16} />}>{t('nav.profile')}</DrawerItem>
              <DrawerItem to="/provider/billing" onClick={() => setMobileOpen(false)} icon={<DollarSign size={16} />}>{t('nav.billing') || 'Billing'}</DrawerItem>
            </nav>
            <div className="border-t border-[var(--border)] p-4 space-y-3">
              <LanguageSwitcher />
              <button
                onClick={() => { logout(); setMobileOpen(false); navigate('/'); }}
                className="btn-secondary w-full inline-flex items-center justify-center gap-2"
                data-testid="drawer-logout"
              >
                <LogOut size={16} /> {t('nav.log_out')}
              </button>
            </div>
          </aside>
        </div>
      )}

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}

function NavItem({ to, children, testId }: { to: string; children: ReactNode; testId?: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        [
          'rounded-xl px-3 py-2 text-sm font-semibold transition',
          isActive
            ? 'bg-[var(--primary-soft)] text-[var(--text)]'
            : 'text-[var(--text-2)] hover:bg-[var(--surface-soft)] hover:text-[var(--text)]',
        ].join(' ')
      }
      data-testid={testId}
    >
      {children}
    </NavLink>
  );
}

function DrawerItem({ to, children, icon, onClick }: { to: string; children: ReactNode; icon?: ReactNode; onClick?: () => void }) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) =>
        [
          'flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-semibold',
          isActive
            ? 'bg-[var(--primary-soft)] text-[var(--text)]'
            : 'text-[var(--text-2)] hover:bg-[var(--surface-soft)] hover:text-[var(--text)]',
        ].join(' ')
      }
    >
      {icon}
      {children}
    </NavLink>
  );
}

function UserMenu({ user, unread, onLogout }: { user: any; unread: number; onLogout: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const initials = (user?.firstName?.[0] || user?.email?.[0] || 'U').toUpperCase();
  return (
    <div className="relative ml-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-2 py-1.5 hover:bg-[var(--surface-soft)]"
        data-testid="user-menu-button"
      >
        <div className="h-7 w-7 rounded-lg bg-[var(--primary)] text-black font-bold flex items-center justify-center text-sm">{initials}</div>
        {unread > 0 && <span className="text-xs bg-[var(--danger)] text-white rounded-full px-1.5 py-0.5 font-bold">{unread}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-56 rounded-2xl border border-[var(--border)] bg-white p-2 shadow-[var(--shadow-float)] z-20">
            <div className="px-3 py-2 border-b border-[var(--border)] mb-1">
              <div className="text-sm font-semibold truncate">{user?.firstName || user?.email}</div>
              <div className="text-xs text-[var(--text-soft)] truncate">{user?.email}</div>
            </div>
            <Link to="/provider/profile" className="flex px-3 py-2 rounded-lg text-sm hover:bg-[var(--surface-soft)]" onClick={() => setOpen(false)}>{t('nav.profile')}</Link>
            <Link to="/provider" className="flex px-3 py-2 rounded-lg text-sm hover:bg-[var(--surface-soft)]" onClick={() => setOpen(false)}>{t('nav.dashboard')}</Link>
            <button onClick={onLogout} className="w-full text-left px-3 py-2 rounded-lg text-sm text-[var(--danger)] hover:bg-[var(--danger-soft)] flex items-center gap-2" data-testid="user-menu-logout"><LogOut size={14} /> {t('nav.log_out')}</button>
          </div>
        </>
      )}
    </div>
  );
}

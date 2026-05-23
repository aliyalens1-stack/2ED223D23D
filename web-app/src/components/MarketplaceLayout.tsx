import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { Search, Bell, LogOut, Menu, X, MapPin, Heart, Briefcase, Inbox, DollarSign, TrendingUp, Car, FileText, MessageCircle } from 'lucide-react';
import { useState, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotifications } from '../hooks/useNotifications';
import { useChatUnread } from '../hooks/useChatUnread';
import QuickRequestFloating from './QuickRequestFloating';
import Logo from './Logo';
import LanguageSwitcher from './LanguageSwitcher';

/**
 * Sprint 14 — Light AppShell · i18n DE/EN/RU
 *
 * Sprint A3b — header bell + chat badges wired to the canonical polling
 * transport (`useNotifications` / `useChatUnread`). Replaced the previous
 * inline `notificationsAPI.getUnreadCount` with the hook because:
 *   (a) it was reading the wrong field (`r.data?.count` — backend returns
 *       `{unread: N}`), so the counter was silently always 0;
 *   (b) the hook ships polling + cache + focus-invalidation for free;
 *   (c) mobile and web now share the SAME transport contract.
 */

/**
 * Badge format contract — IDENTICAL across mobile (`additional.tsx`),
 * web-app (here), and admin (`admin/src/components/Layout.tsx`):
 *   0       → no badge
 *   1..99   → exact number
 *   100+    → "99+"
 * If you change this anywhere, change it everywhere — there is no
 * abstraction here on purpose. Three call sites, three tiny copies.
 */
function formatBadgeCount(n: number): string {
  if (n >= 100) return '99+';
  return String(n);
}

export default function MarketplaceLayout() {
  const { user, token, logout } = useAuthStore();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { unreadCount: notifUnread } = useNotifications(!!token);
  const { unreadCount: chatUnread } = useChatUnread(!!token);

  const role = user?.role;
  const isCustomer = role === 'customer';
  const isProvider = role === 'provider_owner' || role === 'provider_manager';
  const isGuest = !user;

  const onSearchSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = (e.currentTarget.elements.namedItem('q') as HTMLInputElement)?.value || '';
    navigate(`/search${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      {/* ─── HEADER ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 md:px-6">
          <Link to="/" className="flex items-center shrink-0" data-testid="brand-link">
            <Logo height={32} />
          </Link>

          {/* Search inline (desktop) */}
          <form onSubmit={onSearchSubmit} className="hidden md:flex flex-1 max-w-lg">
            <div className="flex items-center w-full rounded-xl border border-[var(--border)] bg-[var(--surface-soft)] px-4 h-10 focus-within:border-[var(--primary)] focus-within:bg-white">
              <Search size={16} className="text-[var(--text-soft)] shrink-0" />
              <input
                name="q"
                placeholder={t('nav.search_placeholder')}
                className="ml-2 w-full bg-transparent text-sm outline-none placeholder:text-[var(--text-soft)]"
                data-testid="header-search-input"
              />
            </div>
          </form>

          {/* Nav (desktop) */}
          <nav className="ml-auto hidden md:flex items-center gap-1">
            <NavItem to="/search" testId="nav-search">{t('nav.search')}</NavItem>
            <NavItem to="/search?view=map" testId="nav-map">{t('nav.map')}</NavItem>

            {isCustomer && (
              <>
                <NavItem to="/account/bookings" testId="nav-bookings">{t('nav.my_bookings')}</NavItem>
                <NavItem to="/account/garage" testId="nav-garage">{t('nav.garage')}</NavItem>
              </>
            )}

            {isProvider && (
              <>
                <NavItem to="/provider/inbox" testId="nav-prov-inbox">{t('nav.requests')}</NavItem>
                <NavItem to="/provider/current-job" testId="nav-prov-current">{t('nav.current_job')}</NavItem>
                <NavItem to="/provider/earnings" testId="nav-prov-earn">{t('nav.earnings')}</NavItem>
              </>
            )}

            {/* Sprint A3b — header icon rail (bell + chat). Authed users
                only; guests don't have a user-scoped notification stream. */}
            {!isGuest && (
              <div className="flex items-center gap-1 ml-1 mr-1 shrink-0">
                <Link
                  to="/account/notifications"
                  data-testid="nav-bell-btn"
                  aria-label="Notifications"
                  className="relative inline-flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text)] hover:bg-[var(--surface-soft)]"
                >
                  <Bell size={18} />
                  {notifUnread > 0 && (
                    <span
                      data-testid="nav-bell-badge"
                      className="absolute -top-0.5 -right-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--primary)] px-1 text-[10px] font-bold leading-none text-black"
                    >
                      {formatBadgeCount(notifUnread)}
                    </span>
                  )}
                </Link>
                <Link
                  to="/account/messages"
                  data-testid="nav-chat-btn"
                  aria-label="Messages"
                  className="relative inline-flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text)] hover:bg-[var(--surface-soft)]"
                >
                  <MessageCircle size={18} />
                  {chatUnread > 0 && (
                    <span
                      data-testid="nav-chat-badge"
                      className="absolute -top-0.5 -right-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--primary)] px-1 text-[10px] font-bold leading-none text-black"
                    >
                      {formatBadgeCount(chatUnread)}
                    </span>
                  )}
                </Link>
              </div>
            )}

            <LanguageSwitcher compact />

            {isGuest ? (
              <>
                <Link to="/login" className="nav-link ml-2" data-testid="nav-login">{t('nav.log_in')}</Link>
                <Link
                  to="/provider/onboarding"
                  className="ml-2 inline-flex items-center rounded-xl bg-[#111] px-4 py-2 text-sm font-bold text-white hover:bg-[#1f2937]"
                  data-testid="nav-become-provider"
                >
                  {t('nav.become_provider')}
                </Link>
              </>
            ) : (
              <UserMenu user={user} unread={notifUnread} onLogout={() => { logout(); navigate('/'); }} />
            )}
          </nav>

          {/* Mobile burger */}
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

      {/* ─── MOBILE DRAWER ─────────────────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" data-testid="mobile-drawer">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute right-0 top-0 h-full w-80 max-w-[88vw] bg-white border-l border-[var(--border)] flex flex-col">
            <div className="h-16 flex items-center justify-between px-5 border-b border-[var(--border)]">
              <span className="font-bold">{t('common.menu')}</span>
              <button onClick={() => setMobileOpen(false)} className="h-9 w-9 rounded-lg hover:bg-[var(--surface-soft)] flex items-center justify-center" aria-label={t('common.close_menu')}><X size={18} /></button>
            </div>
            <form onSubmit={onSearchSubmit} className="px-4 pt-4">
              <div className="input-shell">
                <Search size={16} className="text-[var(--text-soft)]" />
                <input name="q" placeholder={t('nav.search_placeholder')} />
              </div>
            </form>
            <nav className="flex-1 overflow-y-auto px-2 py-4 space-y-0.5">
              <DrawerItem to="/search" onClick={() => setMobileOpen(false)} icon={<Search size={16} />}>{t('nav.search')}</DrawerItem>
              <DrawerItem to="/search?view=map" onClick={() => setMobileOpen(false)} icon={<MapPin size={16} />}>{t('nav.map')}</DrawerItem>
              {isCustomer && <>
                <DrawerItem to="/account/bookings" onClick={() => setMobileOpen(false)} icon={<FileText size={16} />}>{t('nav.my_bookings')}</DrawerItem>
                <DrawerItem to="/account/garage" onClick={() => setMobileOpen(false)} icon={<Car size={16} />}>{t('nav.garage')}</DrawerItem>
                <DrawerItem to="/account/favorites" onClick={() => setMobileOpen(false)} icon={<Heart size={16} />}>{t('nav.favorites')}</DrawerItem>
                <DrawerItem to="/account/profile" onClick={() => setMobileOpen(false)} icon={<Bell size={16} />}>{t('nav.profile')} {unread > 0 && <span className="ml-auto text-xs bg-[var(--primary)] text-black rounded-full px-2 py-0.5 font-bold">{unread}</span>}</DrawerItem>
              </>}
              {isProvider && <>
                <DrawerItem to="/provider/inbox" onClick={() => setMobileOpen(false)} icon={<Inbox size={16} />}>{t('nav.requests')}</DrawerItem>
                <DrawerItem to="/provider/current-job" onClick={() => setMobileOpen(false)} icon={<Briefcase size={16} />}>{t('nav.current_job')}</DrawerItem>
                <DrawerItem to="/provider/earnings" onClick={() => setMobileOpen(false)} icon={<DollarSign size={16} />}>{t('nav.earnings')}</DrawerItem>
                <DrawerItem to="/provider/demand" onClick={() => setMobileOpen(false)} icon={<TrendingUp size={16} />}>{t('nav.demand')}</DrawerItem>
              </>}
            </nav>
            <div className="border-t border-[var(--border)] p-4 space-y-3">
              <LanguageSwitcher />
              {isGuest ? (
                <div className="space-y-2">
                  <Link to="/login" onClick={() => setMobileOpen(false)} className="btn-secondary w-full" data-testid="drawer-login">{t('nav.log_in')}</Link>
                  <Link to="/provider/onboarding" onClick={() => setMobileOpen(false)} className="btn-dark w-full" data-testid="drawer-become-provider">{t('nav.become_provider')}</Link>
                </div>
              ) : (
                <button
                  onClick={() => { logout(); setMobileOpen(false); navigate('/'); }}
                  className="btn-secondary w-full inline-flex items-center justify-center gap-2"
                  data-testid="drawer-logout"
                >
                  <LogOut size={16} /> {t('nav.log_out')}
                </button>
              )}
            </div>
          </aside>
        </div>
      )}

      <main>
        <Outlet />
      </main>

      <QuickRequestFloating />

      {/* ─── FOOTER ─────────────────────────────────────────────── */}
      <footer className="border-t border-[var(--border)] bg-white mt-16">
        <div className="mx-auto max-w-7xl px-4 py-10 grid gap-8 md:grid-cols-4 text-sm">
          <div>
            <div className="flex items-center gap-2.5 mb-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--primary)] text-black font-black">A</div>
              <span className="font-extrabold">AutoSearch</span>
            </div>
            <p className="text-[var(--text-2)] max-w-xs">{t('footer.tagline')}</p>
          </div>
          <FooterCol title={t('footer.for_customers')} links={[[t('footer.search'), '/search'], [t('footer.how_it_works'), '#'], [t('footer.pricing'), '#']]} />
          <FooterCol title={t('footer.for_providers')} links={[[t('nav.become_provider'), '/provider/onboarding'], [t('footer.pricing'), '#'], [t('footer.help'), '#']]} />
          <FooterCol title={t('footer.company')} links={[[t('footer.about'), '#'], [t('footer.contact'), '#'], [t('footer.legal'), '#']]} />
        </div>
        <div className="border-t border-[var(--border)]">
          <div className="mx-auto max-w-7xl px-4 py-4 text-xs text-[var(--text-soft)] flex flex-wrap items-center justify-between gap-2">
            <span>© {new Date().getFullYear()} AutoSearch. {t('footer.rights')}</span>
            <span>{t('footer.made_for')}</span>
          </div>
        </div>
      </footer>
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
            <Link to="/account/profile" className="flex px-3 py-2 rounded-lg text-sm hover:bg-[var(--surface-soft)]" onClick={() => setOpen(false)}>{t('nav.profile')}</Link>
            {user?.role === 'customer' && <Link to="/account/bookings" className="flex px-3 py-2 rounded-lg text-sm hover:bg-[var(--surface-soft)]" onClick={() => setOpen(false)}>{t('nav.my_bookings')}</Link>}
            {(user?.role === 'provider_owner' || user?.role === 'provider_manager') && <Link to="/provider" className="flex px-3 py-2 rounded-lg text-sm hover:bg-[var(--surface-soft)]" onClick={() => setOpen(false)}>{t('nav.dashboard')}</Link>}
            <button onClick={onLogout} className="w-full text-left px-3 py-2 rounded-lg text-sm text-[var(--danger)] hover:bg-[var(--danger-soft)] flex items-center gap-2" data-testid="user-menu-logout"><LogOut size={14} /> {t('nav.log_out')}</button>
          </div>
        </>
      )}
    </div>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <div className="font-bold mb-3">{title}</div>
      <ul className="space-y-2 text-[var(--text-2)]">
        {links.map(([label, href]) => (
          <li key={label}><Link to={href} className="hover:text-[var(--text)]">{label}</Link></li>
        ))}
      </ul>
    </div>
  );
}

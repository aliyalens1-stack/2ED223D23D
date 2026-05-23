/**
 * PublicShell — public web platform chrome.
 *
 * Audience: guests + any logged-in user visiting public surfaces.
 * Style: white background, black/yellow premium utility.
 *
 * Nav (4 entry points): Проверить · Подобрать · Отчёты · Специалисты.
 * Master-search and zones-map were removed from the public surface
 * along with the dispatch/repair vertical.
 */
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Menu, X, LogOut, ShieldCheck, Scale, FileText, Users } from 'lucide-react';
import { useState, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../stores/authStore';
import Logo from '../components/Logo';
import LanguageSwitcher from '../components/LanguageSwitcher';
import AccountSwitcher from './AccountSwitcher';

const NAV_LINKS: { to: string; key: string; fallback: string; icon: ReactNode; testid: string }[] = [
  { to: '/inspect',            key: 'nav.inspect',     fallback: 'Проверить авто', icon: <ShieldCheck size={15} />, testid: 'nav-inspect' },
  { to: '/selection-request',  key: 'nav.selection',   fallback: 'Подобрать авто', icon: <Scale size={15} />,       testid: 'nav-selection' },
  { to: '/reports',            key: 'nav.reports',     fallback: 'Отчёты',         icon: <FileText size={15} />,    testid: 'nav-reports' },
  { to: '/specialists',        key: 'nav.specialists', fallback: 'Специалисты',    icon: <Users size={15} />,       testid: 'nav-specialists' },
];

export default function PublicShell() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-white text-[var(--text)] flex flex-col" data-testid="shell-public">
      <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 md:px-6">
          <Link to="/" className="flex items-center shrink-0" data-testid="brand-link">
            <Logo height={30} />
          </Link>

          <nav className="ml-2 hidden md:flex items-center gap-0.5">
            {NAV_LINKS.map(l => (
              <NavItem key={l.to} to={l.to} testId={l.testid}>{t(l.key, { defaultValue: l.fallback })}</NavItem>
            ))}
          </nav>

          <div className="ml-auto hidden md:flex items-center gap-2">
            <LanguageSwitcher compact />
            {user ? (
              <>
                <AccountSwitcher />
                <Link
                  to="/app"
                  className="inline-flex items-center rounded-lg bg-black px-4 h-10 text-sm font-bold text-white hover:bg-[#1f2937]"
                  data-testid="nav-go-cabinet"
                >
                  {t('nav.cabinet', { defaultValue: 'Кабинет' })}
                </Link>
              </>
            ) : (
              <>
                <Link to="/login" className="inline-flex items-center rounded-lg px-3 h-10 text-sm font-bold text-[var(--text)] hover:bg-[var(--surface-soft)]" data-testid="nav-login">
                  {t('nav.log_in', { defaultValue: 'Войти' })}
                </Link>
                <Link
                  to="/inspect"
                  className="inline-flex items-center rounded-lg bg-[var(--primary)] hover:bg-[#facc15] px-4 h-10 text-sm font-bold text-black"
                  data-testid="nav-cta-inspect"
                >
                  {t('nav.cta_inspect', { defaultValue: 'Проверить авто' })}
                </Link>
              </>
            )}
          </div>

          <button
            onClick={() => setMobileOpen(true)}
            className="md:hidden ml-auto inline-flex items-center justify-center rounded-lg border border-[var(--border)] bg-white h-10 w-10"
            data-testid="header-burger"
            aria-label={t('common.open_menu', { defaultValue: 'Open menu' })}
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
              <span className="font-bold">{t('common.menu', { defaultValue: 'Меню' })}</span>
              <button onClick={() => setMobileOpen(false)} className="h-9 w-9 rounded-lg hover:bg-[var(--surface-soft)] flex items-center justify-center" aria-label={t('common.close_menu', { defaultValue: 'Close menu' })}><X size={18} /></button>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 py-4 space-y-0.5">
              {NAV_LINKS.map(l => (
                <DrawerItem key={l.to} to={l.to} icon={l.icon} onClick={() => setMobileOpen(false)}>
                  {t(l.key, { defaultValue: l.fallback })}
                </DrawerItem>
              ))}
            </nav>
            <div className="border-t border-[var(--border)] p-4 space-y-3">
              <LanguageSwitcher />
              {user ? (
                <button
                  onClick={() => { logout(); setMobileOpen(false); navigate('/'); }}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--border)] h-11 text-sm font-bold hover:bg-[var(--surface-soft)]"
                  data-testid="drawer-logout"
                >
                  <LogOut size={16} /> {t('nav.log_out', { defaultValue: 'Выйти' })}
                </button>
              ) : (
                <div className="space-y-2">
                  <Link to="/login" onClick={() => setMobileOpen(false)} className="w-full inline-flex items-center justify-center rounded-lg border border-[var(--border)] h-11 text-sm font-bold hover:bg-[var(--surface-soft)]" data-testid="drawer-login">{t('nav.log_in', { defaultValue: 'Войти' })}</Link>
                  <Link to="/inspect" onClick={() => setMobileOpen(false)} className="w-full inline-flex items-center justify-center rounded-lg bg-[var(--primary)] h-11 text-sm font-bold text-black" data-testid="drawer-cta-inspect">{t('nav.cta_inspect', { defaultValue: 'Проверить авто' })}</Link>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      <main className="flex-1">
        <Outlet />
      </main>

      {/* ── FOOTER ─── */}
      <footer className="bg-[#0b0b0d] text-white">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-14 grid gap-10 md:grid-cols-4">
          <div className="md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--primary)] text-black font-black">A</div>
              <span className="font-extrabold text-lg">Auto Search</span>
            </div>
            <p className="text-sm text-white/60 max-w-xs">{t('footer.tagline', { defaultValue: 'Проверка и подбор авто перед покупкой в Германии и ЕС.' })}</p>
          </div>

          <FooterCol title={t('footer.platform', { defaultValue: 'Платформа' })} links={[
            [t('nav.inspect',     { defaultValue: 'Проверить авто' }), '/inspect'],
            [t('nav.selection',   { defaultValue: 'Подобрать авто' }), '/selection-request'],
            [t('nav.reports',     { defaultValue: 'Отчёты' }),         '/reports'],
            [t('nav.specialists', { defaultValue: 'Специалисты' }),    '/specialists'],
            [t('footer.pricing',  { defaultValue: 'Тарифы' }),         '/packages'],
          ]} />

          <FooterCol title={t('footer.for_inspectors', { defaultValue: 'Инспекторам' })} links={[
            [t('footer.become_inspector', { defaultValue: 'Стать инспектором' }), '/provider/onboarding'],
            [t('footer.cabinet',          { defaultValue: 'Кабинет' }),           '/app'],
          ]} />

          <FooterCol title={t('footer.company', { defaultValue: 'Компания' })} links={[
            [t('footer.about',   { defaultValue: 'О нас' }),     '#'],
            [t('footer.contact', { defaultValue: 'Контакты' }),  '#'],
            [t('footer.legal',   { defaultValue: 'Документы' }), '#'],
          ]} />
        </div>
        <div className="border-t border-white/10">
          <div className="mx-auto max-w-7xl px-4 md:px-6 py-5 text-xs text-white/50 flex flex-wrap items-center justify-between gap-2">
            <span>© {new Date().getFullYear()} Auto Search. {t('footer.rights', { defaultValue: 'Все права защищены.' })}</span>
            <span>{t('footer.made_for', { defaultValue: 'Сделано для покупателей авто в Германии' })}</span>
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
          'rounded-lg px-3 py-2 text-sm font-bold transition-colors',
          isActive
            ? 'text-[var(--text)] bg-[var(--primary-soft)]'
            : 'text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--surface-soft)]',
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
          'flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-bold',
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

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <div className="font-bold mb-4 text-sm uppercase tracking-wider text-white/80">{title}</div>
      <ul className="space-y-2.5 text-sm text-white/60">
        {links.map(([label, href]) => (
          <li key={label}>
            <Link to={href} className="hover:text-[var(--primary)]">{label}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

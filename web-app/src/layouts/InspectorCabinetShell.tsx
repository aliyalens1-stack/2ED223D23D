/**
 * InspectorCabinetShell — единый layout для всего /inspector/*.
 *
 * Структура:
 *   ┌─────────────────────────────────────────────┐
 *   │  Topbar:  Logo · breadcrumb · user-menu     │
 *   ├──────────┬──────────────────────────────────┤
 *   │ Sidebar  │  <Outlet/>                       │
 *   │ • home   │                                  │
 *   │ • jobs   │                                  │
 *   │ • ...    │                                  │
 *   └──────────┴──────────────────────────────────┘
 *
 * Desktop-first. На < 1024px sidebar collapses в icon-rail (без подписей).
 * Каждый раздел — отдельная страница, мигрировано из старого split-pane
 * (только `/inspector/jobs/*` сохраняет внутренний split JobsRail | detail).
 */
import { ReactNode, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  House,
  Briefcase,
  Archive,
  User,
  CalendarBlank,
  Wallet,
  ChartLine,
  IdentificationCard,
  ShieldCheck,
  Gear,
  Wrench,
  List as ListIcon,
} from '@phosphor-icons/react';
import InspectorUserMenu from '../components/inspector/InspectorUserMenu';

interface NavItem {
  to: string;
  icon: ReactNode;
  label: string;
  end?: boolean;
}

export default function InspectorCabinetShell() {
  const { t } = useTranslation();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const items: NavItem[] = [
    { to: '/inspector/home', icon: <House size={18} />, label: t('inspector.nav.home', { defaultValue: 'Главная' }) },
    { to: '/inspector/jobs', icon: <Briefcase size={18} />, label: t('inspector.nav.jobs', { defaultValue: 'Задания' }) },
    { to: '/inspector/inspections', icon: <Archive size={18} />, label: t('inspector.nav.inspections', { defaultValue: 'Архив проверок' }) },
    { to: '/inspector/profile', icon: <User size={18} />, label: t('inspector.nav.profile', { defaultValue: 'Профиль' }) },
    { to: '/inspector/availability', icon: <CalendarBlank size={18} />, label: t('inspector.nav.availability', { defaultValue: 'Доступность' }) },
    { to: '/inspector/payouts', icon: <Wallet size={18} />, label: t('inspector.nav.payouts', { defaultValue: 'Выплаты' }) },
    { to: '/inspector/performance', icon: <ChartLine size={18} />, label: t('inspector.nav.performance', { defaultValue: 'Эффективность' }) },
    { to: '/inspector/verification', icon: <IdentificationCard size={18} />, label: t('inspector.nav.verification', { defaultValue: 'Верификация' }) },
    { to: '/inspector/security', icon: <ShieldCheck size={18} />, label: t('inspector.nav.security', { defaultValue: 'Безопасность' }) },
    { to: '/inspector/settings', icon: <Gear size={18} />, label: t('inspector.nav.settings', { defaultValue: 'Настройки' }) },
  ];

  // Breadcrumb label (по первому сегменту после /inspector/)
  const seg = location.pathname.split('/').filter(Boolean)[1] || 'home';
  const current = items.find(i => i.to.endsWith(seg))?.label ?? '';

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 text-zinc-900" data-testid="inspector-cabinet-shell">
      {/* ── Topbar ───────────────────────────────────────── */}
      <header className="bg-white border-b border-zinc-200 sticky top-0 z-20">
        <div className="h-14 px-3 sm:px-5 flex items-center gap-3">
          <button
            onClick={() => setCollapsed(c => !c)}
            className="lg:hidden p-1.5 rounded-md hover:bg-zinc-100"
            aria-label="Toggle navigation"
            data-testid="sidebar-toggle"
          >
            <ListIcon size={18} />
          </button>

          <div className="flex items-center gap-2">
            <Wrench size={18} weight="bold" className="text-amber-600" />
            <span className="font-bold text-sm tracking-tight hidden sm:inline">
              {t('inspector.cabinet.brand', { defaultValue: 'Кабинет инспектора' })}
            </span>
          </div>

          {current && (
            <>
              <span className="text-zinc-300 mx-1 hidden sm:inline">/</span>
              <span className="text-sm text-zinc-600 hidden sm:inline" data-testid="cabinet-breadcrumb-current">
                {current}
              </span>
            </>
          )}

          <div className="flex-1" />
          <InspectorUserMenu />
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* ── Sidebar ────────────────────────────────────── */}
        <aside
          className={`bg-white border-r border-zinc-200 transition-all ${
            collapsed ? 'w-14' : 'w-60'
          } shrink-0 hidden lg:flex flex-col py-3`}
          data-testid="inspector-sidebar"
        >
          <button
            onClick={() => setCollapsed(c => !c)}
            className="self-end mr-2 p-1 rounded hover:bg-zinc-100 mb-2"
            aria-label="Collapse sidebar"
          >
            <ListIcon size={14} className="text-zinc-400" />
          </button>
          <nav className="flex flex-col gap-0.5 px-2">
            {items.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition group ${
                    isActive
                      ? 'bg-amber-50 text-amber-900 font-semibold'
                      : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                  }`
                }
                data-testid={`nav-${item.to.split('/').pop()}`}
              >
                <span className="shrink-0">{item.icon}</span>
                {!collapsed && <span className="truncate">{item.label}</span>}
              </NavLink>
            ))}
          </nav>
        </aside>

        {/* ── Main content ───────────────────────────────── */}
        <main className="flex-1 min-w-0 overflow-x-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

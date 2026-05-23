import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { House, FileText, Car, User, SignOut } from '@phosphor-icons/react';
import Logo from './Logo';
import WorkModeSwitcher from './WorkModeSwitcher';

export default function CustomerLayout() {
  const { user, logout } = useAuthStore();
  const nav = useNavigate();
  const handleLogout = () => { logout(); nav('/login'); };
  const link = (to: string, Icon: any, label: string) => (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `flex items-center gap-3 px-4 py-3 text-sm font-bold uppercase tracking-wide transition-colors border-l-2 ${
          isActive ? 'border-amber text-amber bg-amber/5' : 'border-transparent text-gray-400 hover:text-amber hover:bg-ink-100'
        }`
      }
      data-testid={`nav-${label.toLowerCase()}`}
    >
      <Icon size={16} weight="bold" />
      <span>{label}</span>
    </NavLink>
  );
  return (
    <div className="min-h-screen bg-black text-white flex font-body" data-testid="customer-layout">
      <aside className="w-64 bg-ink-50 border-r border-ink-300 flex flex-col sticky top-0 h-screen">
        <div className="flex items-center gap-3 px-5 h-[72px] border-b border-ink-300">
          <Logo height={28} />
          <div className="text-[9px] uppercase tracking-[0.3em] text-gray-500">Кабинет клиента</div>
        </div>

        <nav className="flex-1 py-4 space-y-1">
          {link('/account/home', House, 'Главная')}
          {link('/account/bookings', FileText, 'Заказы')}
          {link('/account/garage', Car, 'Гараж')}
          {link('/account/profile', User, 'Профиль')}
        </nav>

        <div className="p-4 border-t border-ink-300 space-y-3">
          <WorkModeSwitcher />
          <div className="text-[10px] uppercase tracking-widest text-gray-600 truncate">{user?.firstName} {user?.lastName}</div>
          <button
            onClick={handleLogout}
            className="btn-ghost w-full !py-2 text-xs hover:!border-red-500 hover:!text-red-400"
            data-testid="logout-btn"
          >
            <SignOut size={14} weight="bold" /> Выйти
          </button>
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-auto bg-black"><Outlet /></main>
    </div>
  );
}

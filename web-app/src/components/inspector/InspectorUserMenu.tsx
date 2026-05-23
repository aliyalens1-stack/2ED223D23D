/**
 * InspectorUserMenu — operating identity surface for the inspector workspace.
 *
 * Layer 1 of the Inspector Operating Identity stack (Phase 1):
 *   • avatar (initials fallback)
 *   • displayName + city + verified badge
 *   • rating + completed inspections (live from /api/inspector/profile)
 *   • dropdown: Profile, My Inspections, Earnings, Settings (placeholders),
 *     Logout (real)
 *
 * Why a dedicated component:
 *   The inspector workspace runs in a SELF-CONTAINED shell
 *   (`InspectorWorkspace.tsx`), not OperatorShell — that is enforced by
 *   canonical_surface_map §4. So we cannot reuse OperatorShell's UserMenu.
 *
 * Read-only. Edit-flow / 2FA / email verification are explicitly out of
 * Phase 1 scope.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  SignOut,
  User,
  ChartLine,
  Wallet,
  IdentificationCard,
  Gear,
  CaretDown,
  ShieldCheck,
  Star,
} from '@phosphor-icons/react';
import { useAuthStore } from '../../stores/authStore';
import { inspectorAPI } from '../../services/api';

interface ProfileSummary {
  displayName: string;
  city: string | null;
  verified: boolean;
  ratingAvg: number;
  reviewsCount: number;
  completedTotal: number;
  status: string;
  avatar: string | null;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0]?.toUpperCase() ?? '')
    .join('') || 'I';
}

export default function InspectorUserMenu() {
  const { user, activeAccount, logout } = useAuthStore();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<ProfileSummary | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Fetch once on mount; the menu is global and lightweight (~1 KB payload).
  useEffect(() => {
    let cancelled = false;
    inspectorAPI
      .getProfile()
      .then(r => {
        if (cancelled) return;
        const d = r.data || {};
        const id = d.identity || {};
        const trust = d.trust || {};
        setProfile({
          displayName: id.displayName || activeAccount?.displayName || user?.firstName || user?.email || 'Inspector',
          city: id.city || null,
          verified: Boolean(trust.verified),
          ratingAvg: Number(trust.ratingAvg || 0),
          reviewsCount: Number(trust.reviewsCount || 0),
          completedTotal: Number(trust.completedTotal || 0),
          status: String(trust.status || 'pending'),
          avatar: id.avatar || null,
        });
      })
      .catch(() => {
        // Fallback to whatever the auth-store already knows about the user —
        // never block the menu on a network failure.
        setProfile({
          displayName: activeAccount?.displayName || user?.firstName || user?.email || 'Inspector',
          city: null,
          verified: false,
          ratingAvg: 0,
          reviewsCount: 0,
          completedTotal: 0,
          status: 'unknown',
          avatar: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [activeAccount?.displayName, user?.email, user?.firstName]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const display = profile?.displayName ?? 'Inspector';
  const initials = initialsOf(display);
  const subtitle = [
    profile?.city,
    profile?.verified ? t('inspector.menu.verified', { defaultValue: 'Verified' }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const handleLogout = () => {
    setOpen(false);
    logout();
    navigate('/login');
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-100 transition group"
        data-testid="inspector-user-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {/* Avatar — initials with verified ring */}
        <div
          className={`relative h-8 w-8 rounded-full flex items-center justify-center font-bold text-xs ${
            profile?.verified ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-200 text-zinc-700'
          }`}
        >
          {profile?.avatar ? (
            <img src={profile.avatar} alt="" className="h-full w-full rounded-full object-cover" />
          ) : (
            initials
          )}
          {profile?.verified && (
            <span
              className="absolute -bottom-0.5 -right-0.5 bg-emerald-500 rounded-full border border-white"
              style={{ width: 10, height: 10 }}
              title={t('inspector.menu.verified', { defaultValue: 'Verified inspector' }) as string}
            />
          )}
        </div>

        {/* Name + subtitle (hidden < md) */}
        <div className="hidden md:flex flex-col items-start leading-tight">
          <span
            className="text-xs font-semibold text-zinc-900 max-w-[160px] truncate"
            data-testid="inspector-menu-display-name"
          >
            {display}
          </span>
          {subtitle && (
            <span className="text-[10px] text-zinc-500 max-w-[160px] truncate">{subtitle}</span>
          )}
        </div>

        <CaretDown size={12} className="text-zinc-400 group-hover:text-zinc-600 transition" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-72 rounded-2xl border border-zinc-200 bg-white shadow-lg z-50 overflow-hidden"
          data-testid="inspector-user-menu-panel"
        >
          {/* Identity header */}
          <div className="p-4 border-b border-zinc-100 bg-gradient-to-b from-white to-zinc-50">
            <div className="flex items-center gap-3">
              <div
                className={`h-12 w-12 rounded-full flex items-center justify-center font-bold text-base ${
                  profile?.verified ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-200 text-zinc-700'
                }`}
              >
                {profile?.avatar ? (
                  <img src={profile.avatar} alt="" className="h-full w-full rounded-full object-cover" />
                ) : (
                  initials
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-zinc-900 truncate">{display}</div>
                <div className="text-[11px] text-zinc-500 truncate">
                  {profile?.city ?? t('inspector.menu.no_city', { defaultValue: 'City not set' })}
                  {profile?.verified && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5 text-emerald-600 font-semibold">
                      <ShieldCheck size={11} weight="fill" />
                      {t('inspector.menu.verified', { defaultValue: 'Verified' })}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Trust strip */}
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <Stat
                label={t('inspector.menu.rating', { defaultValue: 'Rating' })}
                value={profile?.ratingAvg ? profile.ratingAvg.toFixed(1) : '—'}
                icon={<Star size={11} weight="fill" className="text-amber-500" />}
              />
              <Stat
                label={t('inspector.menu.reviews', { defaultValue: 'Reviews' })}
                value={String(profile?.reviewsCount ?? 0)}
              />
              <Stat
                label={t('inspector.menu.completed', { defaultValue: 'Inspections' })}
                value={String(profile?.completedTotal ?? 0)}
              />
            </div>
          </div>

          {/* Menu items */}
          <nav className="py-1.5">
            <MenuLink
              to="/inspector/profile"
              icon={<User size={14} />}
              onClose={() => setOpen(false)}
              testId="inspector-menu-profile"
            >
              {t('inspector.menu.profile', { defaultValue: 'Профиль' })}
            </MenuLink>
            <MenuLink
              to="/inspector/jobs"
              icon={<ChartLine size={14} />}
              onClose={() => setOpen(false)}
              testId="inspector-menu-my-inspections"
            >
              {t('inspector.menu.my_inspections', { defaultValue: 'Мои проверки' })}
            </MenuLink>
            <MenuLink
              to="/inspector/profile#payouts"
              icon={<Wallet size={14} />}
              onClose={() => setOpen(false)}
              testId="inspector-menu-payouts"
            >
              {t('inspector.menu.payouts', { defaultValue: 'Выплаты' })}
            </MenuLink>
            <MenuLink
              to="/inspector/profile#documents"
              icon={<IdentificationCard size={14} />}
              onClose={() => setOpen(false)}
              testId="inspector-menu-documents"
            >
              {t('inspector.menu.documents', { defaultValue: 'Документы' })}
            </MenuLink>
            <MenuItemDisabled icon={<Gear size={14} />}>
              {t('inspector.menu.settings', { defaultValue: 'Настройки' })}
              <span className="ml-auto text-[10px] uppercase tracking-wider text-zinc-400">
                {t('inspector.menu.soon', { defaultValue: 'Скоро' })}
              </span>
            </MenuItemDisabled>
          </nav>

          <div className="border-t border-zinc-100">
            <button
              type="button"
              onClick={handleLogout}
              className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-2 text-rose-600 hover:bg-rose-50 transition"
              data-testid="inspector-menu-logout"
            >
              <SignOut size={14} />
              {t('inspector.menu.logout', { defaultValue: 'Выйти' })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-zinc-200 px-1.5 py-1.5">
      <div className="text-[14px] font-bold text-zinc-900 tabular-nums flex items-center justify-center gap-0.5">
        {icon}
        {value}
      </div>
      <div className="text-[9px] uppercase tracking-wider text-zinc-500 mt-0.5">{label}</div>
    </div>
  );
}

function MenuLink({
  to,
  icon,
  children,
  onClose,
  testId,
}: {
  to: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  testId?: string;
}) {
  return (
    <Link
      to={to}
      onClick={onClose}
      className="flex items-center gap-2 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 transition"
      data-testid={testId}
    >
      <span className="text-zinc-400">{icon}</span>
      {children}
    </Link>
  );
}

function MenuItemDisabled({
  icon,
  children,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm text-zinc-400 cursor-not-allowed">
      <span>{icon}</span>
      <span className="flex-1 flex items-center gap-2">{children}</span>
    </div>
  );
}

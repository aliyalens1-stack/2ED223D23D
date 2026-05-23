import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, AccountView } from '../stores/authStore';
import { CaretDown, Check, ArrowsCounterClockwise } from '@phosphor-icons/react';

/**
 * Sprint 1E — Work-mode switcher for the web shell.
 *
 * Compact pill in the sidebar showing the currently active account.kind.
 * Clicks open a dropdown of all accounts owned by the user. Selecting a
 * different one fires POST /api/auth/switch-account, replaces the JWT,
 * updates the store, and navigates to the home of that mode.
 *
 * Hidden when the user has only one account (legacy single-persona users).
 * Strings are i18n: workMode.title / workMode.kind.* (shared with mobile).
 */
export default function WorkModeSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { accounts, activeAccount, switchAccount } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (!activeAccount || accounts.length < 2) return null;

  const handlePick = async (acc: AccountView) => {
    if (acc.id === activeAccount.id) {
      setOpen(false);
      return;
    }
    setBusy(acc.id);
    try {
      const next = await switchAccount(acc.id);
      setOpen(false);
      if (next) {
        // Land on the right home for the chosen kind.
        if (next.kind === 'customer') nav('/account/home');
        else if (next.kind === 'admin') nav('/');
        else nav('/provider'); // inspector / service_provider / dealer / transport
      }
    } finally {
      setBusy(null);
    }
  };

  const label = t(`workMode.kind.${activeAccount.kind}`);

  return (
    <div className="relative" data-testid="work-mode-switcher">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 w-full ${compact ? 'px-2 py-1.5 text-[11px]' : 'px-3 py-2 text-xs'} font-bold uppercase tracking-wide bg-ink-100 hover:bg-ink-200 border border-ink-300 hover:border-amber/60 rounded transition`}
        data-testid="work-mode-switcher-trigger"
      >
        <ArrowsCounterClockwise size={14} weight="bold" className="text-amber" />
        <span className="flex-1 text-left text-amber truncate">{label}</span>
        <CaretDown size={12} weight="bold" className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className="absolute bottom-full left-0 mb-2 w-full bg-ink-50 border border-ink-300 rounded shadow-lg z-50 overflow-hidden"
          data-testid="work-mode-switcher-list"
        >
          <div className="px-3 py-2 border-b border-ink-300">
            <div className="text-[10px] uppercase tracking-widest text-gray-500">{t('workMode.title')}</div>
            <div className="text-[10px] text-gray-600 mt-0.5">{t('workMode.subtitle')}</div>
          </div>
          {accounts.map((acc) => {
            const isActive = acc.id === activeAccount.id;
            const isBusy = busy === acc.id;
            return (
              <button
                key={acc.id}
                onClick={() => handlePick(acc)}
                disabled={!!busy}
                className={`w-full flex items-center gap-2 px-3 py-2.5 text-xs text-left transition ${
                  isActive ? 'bg-amber/10 text-amber font-bold' : 'text-gray-300 hover:bg-ink-200'
                }`}
                data-testid={`work-mode-option-${acc.kind}`}
              >
                <span className="flex-1 truncate">
                  {t(`workMode.kind.${acc.kind}`)}
                  <span className="ml-2 text-[10px] text-gray-500 normal-case font-normal">{acc.displayName}</span>
                </span>
                {isBusy ? (
                  <span className="text-[10px] text-gray-500">…</span>
                ) : isActive ? (
                  <Check size={14} weight="bold" />
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Shell Split α — AccountSwitcher (transport primitive only).
 *
 * Pure, read-only display of the current actor + navigation hint to the
 * canonical entry of any other account the user holds.
 *
 *   Does NOT mutate `activeAccount`.
 *   Does NOT call any auth API.
 *   Does NOT introduce a new auth flow.
 *   Does NOT know about org membership.
 *   Does NOT solve identity quarantine.
 *
 * Identity consolidation is a post-quarantine operation. Until then this
 * primitive only narrates: "you are here, your other account lives there".
 */
import { Link } from 'react-router-dom';
import { useAuthStore, type AccountView } from '../stores/authStore';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

const KIND_LABEL: Record<string, string> = {
  customer: 'Customer',
  inspector: 'Inspector',
  provider_owner: 'Provider',
  provider_manager: 'Provider',
  service_provider: 'Provider',
  dealer: 'Dealer',
  transport: 'Transport',
  admin: 'Admin',
};

const KIND_ENTRY: Record<string, string> = {
  customer: '/account/home',
  inspector: '/inspector/jobs',
  provider_owner: '/provider',
  provider_manager: '/provider',
  service_provider: '/provider',
  dealer: '/account/home',
  transport: '/account/home',
  admin: '/provider',
};

function actorLabel(account: AccountView | null, fallback: string): string {
  if (!account) return fallback;
  const k = (account.kind || '').toString();
  return KIND_LABEL[k] || k || fallback;
}

export default function AccountSwitcher() {
  const { user, accounts, activeAccount } = useAuthStore();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  const currentLabel = actorLabel(activeAccount, user.role || 'Account');
  const otherAccounts = (accounts || []).filter(a => a && a.id !== activeAccount?.id);

  // Single-account user — show static badge, no dropdown.
  if (otherAccounts.length === 0) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-white px-2.5 py-1 text-xs font-semibold text-[var(--text-2)]"
        data-testid="account-switcher-static"
        title={user.email || ''}
      >
        {currentLabel}
      </span>
    );
  }

  return (
    <div className="relative" data-testid="account-switcher">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-white px-2.5 py-1 text-xs font-semibold text-[var(--text-2)] hover:bg-[var(--surface-soft)]"
        data-testid="account-switcher-trigger"
      >
        {currentLabel}
        <ChevronDown size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full mt-1 w-56 rounded-xl border border-[var(--border)] bg-white p-2 shadow-[var(--shadow-float)] z-20"
            data-testid="account-switcher-menu"
          >
            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--text-soft)]">
              Active
            </div>
            <div className="px-2 py-1.5 text-xs font-semibold rounded-md bg-[var(--primary-soft)] text-[var(--text)]">
              {currentLabel}
              <span className="ml-1 text-[var(--text-soft)] font-normal">· {user.email}</span>
            </div>
            <div className="mt-2 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--text-soft)]">
              Other accounts
            </div>
            {otherAccounts.map(acc => {
              const k = (acc.kind || '').toString();
              const target = KIND_ENTRY[k] || '/';
              return (
                <Link
                  key={acc.id}
                  to={target}
                  onClick={() => setOpen(false)}
                  className="flex items-center justify-between px-2 py-1.5 rounded-md text-xs font-semibold text-[var(--text-2)] hover:bg-[var(--surface-soft)]"
                  data-testid={`account-switcher-link-${k}`}
                >
                  <span>{KIND_LABEL[k] || k || 'Account'}</span>
                  <span className="text-[var(--text-soft)] font-normal">→</span>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

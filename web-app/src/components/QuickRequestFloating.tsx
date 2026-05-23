import { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import QuickRequestModal from './QuickRequestModal';

/**
 * Sprint 14.5 — Floating Quick-Request entrypoint
 * Sticky FAB visible on every page. Click → opens single-input modal.
 * The button hides itself when the modal is open.
 */
export default function QuickRequestFloating() {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  // Hide on auth/onboarding routes; show everywhere else.
  useEffect(() => {
    const path = window.location.pathname;
    setHidden(path.includes('/login') || path.includes('/register') || path.includes('/onboarding'));
    const onPop = () => {
      const p = window.location.pathname;
      setHidden(p.includes('/login') || p.includes('/register') || p.includes('/onboarding'));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (hidden) return null;

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed z-40 inline-flex items-center gap-2 rounded-full bg-[var(--primary)] hover:bg-[var(--primary-h)] active:scale-95 transition px-5 h-14 font-extrabold text-[#111] shadow-[0_8px_24px_rgba(245,184,0,0.35)] bottom-6 right-6 md:bottom-8 md:right-8"
          data-testid="qr-fab"
          aria-label="Quick request"
        >
          <Zap size={18} fill="#111" />
          <span>Solve problem</span>
        </button>
      )}
      <QuickRequestModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}

import { useState } from 'react';
import { setAppLanguage, getCurrentLanguage, SUPPORTED_LANGS, type AppLang } from '../i18n';
import { Globe, Check } from 'lucide-react';

const LABEL: Record<AppLang, string> = {
  de: 'DE',
  en: 'EN',
  ru: 'RU',
};
const FULL: Record<AppLang, string> = {
  de: 'Deutsch',
  en: 'English',
  ru: 'Русский',
};

/**
 * LanguageSwitcher — header chip dropdown for DE/EN/RU.
 * Persists to localStorage and reloads to ensure all components re-render
 * with the new language (avoids partial-translation flicker).
 */
export default function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const cur = getCurrentLanguage();

  const change = (lang: AppLang) => {
    if (lang === cur) { setOpen(false); return; }
    setAppLanguage(lang);
    setOpen(false);
    // Hard reload — guarantees every component picks up the new locale.
    window.location.reload();
  };

  return (
    <div className="relative" data-testid="lang-switcher">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={
          'inline-flex items-center gap-1.5 rounded-xl border border-[var(--border)] bg-white hover:bg-[var(--surface-soft)] font-bold ' +
          (compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm')
        }
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="lang-switcher-button"
      >
        <Globe size={compact ? 12 : 14} className="text-[var(--text-soft)]" />
        {LABEL[cur]}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-44 rounded-2xl border border-[var(--border)] bg-white p-1 shadow-[var(--shadow-float)] z-50" role="menu">
            {SUPPORTED_LANGS.map((l) => (
              <button
                key={l}
                onClick={() => change(l)}
                className={
                  'w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-semibold ' +
                  (l === cur ? 'bg-[var(--primary-soft)] text-[var(--text)]' : 'text-[var(--text-2)] hover:bg-[var(--surface-soft)]')
                }
                data-testid={`lang-option-${l}`}
              >
                <span>{FULL[l]}</span>
                {l === cur && <Check size={14} className="text-[var(--primary-h)]" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

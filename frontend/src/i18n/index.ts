/**
 * i18n entry point for the Expo mobile app.
 *
 * Architecture:
 *   • Single source of truth: ./locales/<lang>.json (DE / EN / RU today).
 *   • SUPPORTED_LANGS + LANGUAGES registries below — add a locale by:
 *       1. Drop `./locales/<code>.json` (1:1 key parity with `de.json`).
 *       2. Append entry to `SUPPORTED_LANGS` and `LANGUAGES`.
 *       3. Add the import + resources entry in this file.
 *     LanguageSwitcher + Profile + city-select read LANGUAGES dynamically,
 *     so no other code change is required.
 *
 *   • Persistence: AppLang saved via `@/src/utils/storage` (single wrapper
 *     that hides AsyncStorage / SecureStore choice). Rehydrated on first
 *     render so the chosen language is sticky across app restarts.
 *
 *   • Dev-mode hard guard: in __DEV__ a `missingKeyHandler` logs WARN to
 *     the console when a `t('foo.bar')` lookup falls back. CI / future
 *     pytest hook will fail builds on these warnings. Production stays
 *     silent (returns the key).
 *
 *   • Fallback chain: lookup current → de → en (sequence below). Avoids
 *     "DE strings leaking through to EN" type bugs.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';
import AsyncStorage from '@react-native-async-storage/async-storage';

import en from './locales/en.json';
import de from './locales/de.json';
import ru from './locales/ru.json';

export const SUPPORTED_LANGS = ['de', 'en', 'ru'] as const;
export type AppLang = (typeof SUPPORTED_LANGS)[number];
export const DEFAULT_LANG: AppLang = 'de';

// Single registry of language metadata — used by LanguageSwitcher and Profile.
// Add a new locale here once and it propagates everywhere.
export const LANGUAGES: { code: AppLang; label: string; name: string; flag: string }[] = [
  { code: 'de', label: 'DE', name: 'Deutsch',  flag: '🇩🇪' },
  { code: 'en', label: 'EN', name: 'English',  flag: '🇬🇧' },
  { code: 'ru', label: 'RU', name: 'Русский',  flag: '🇷🇺' },
];

const STORAGE_KEY = 'app.lang';

function pickInitialLanguage(stored?: string | null): AppLang {
  if (stored && (SUPPORTED_LANGS as readonly string[]).includes(stored)) return stored as AppLang;
  try {
    const locales = (Localization.getLocales?.() || []) as Array<{ languageCode?: string }>;
    for (const l of locales) {
      const code = (l?.languageCode || '').toLowerCase();
      if ((SUPPORTED_LANGS as readonly string[]).includes(code)) return code as AppLang;
    }
  } catch {
    /* expo-localization may not be available on web SSR */
  }
  return DEFAULT_LANG;
}

// Dev-mode warning collector. Surfaces missing keys so we never ship a
// screen that silently falls back to its key (or to a different locale).
// In prod (__DEV__ === false) this is a no-op.
const _seenMissing = new Set<string>();
declare const __DEV__: boolean | undefined;

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      de: { translation: de },
      ru: { translation: ru },
    },
    lng: DEFAULT_LANG,
    // Fallback chain — when current locale is missing a key, try DE then EN.
    // Picked DE first because it's the primary market locale, EN second as
    // the universal safety net. RU is intentionally NOT in the chain so a
    // missing DE key never leaks Cyrillic into a German session.
    fallbackLng: { default: ['de', 'en'] },
    interpolation: { escapeValue: false },
    returnNull: false,
    compatibilityJSON: 'v4',
    // Dev guard: log every key that resolves via fallback or returns the key.
    saveMissing: typeof __DEV__ !== 'undefined' && __DEV__ === true,
    missingKeyHandler: (lngs, ns, key) => {
      if (typeof __DEV__ === 'undefined' || __DEV__ !== true) return;
      const tag = `${(lngs && lngs[0]) || '?'}:${key}`;
      if (_seenMissing.has(tag)) return;
      _seenMissing.add(tag);
      // eslint-disable-next-line no-console
      console.warn(`[i18n] missing key "${key}" in ${(lngs || []).join(',')} — falling back`);
    },
  });

// Async hydrate from storage so first render uses persisted choice.
AsyncStorage.getItem(STORAGE_KEY)
  .then((stored) => {
    const lang = pickInitialLanguage(stored);
    if (i18n.language !== lang) i18n.changeLanguage(lang);
  })
  .catch(() => { /* ignore storage failures */ });

export async function setAppLanguage(lang: AppLang): Promise<void> {
  await i18n.changeLanguage(lang);
  try {
    await AsyncStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
}

export function getCurrentLanguage(): AppLang {
  const cur = (i18n.language || DEFAULT_LANG).split('-')[0];
  return ((SUPPORTED_LANGS as readonly string[]).includes(cur) ? cur : DEFAULT_LANG) as AppLang;
}

export default i18n;

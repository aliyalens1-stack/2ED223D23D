/**
 * i18n entry point for the web SPA.
 * Loads RU/EN/DE, persists choice in localStorage, falls back to navigator
 * language and finally `de` (Berlin launch default).
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import ru from './locales/ru.json';
import en from './locales/en.json';
import de from './locales/de.json';

export const SUPPORTED_LANGS = ['de', 'en', 'ru'] as const;
export type AppLang = (typeof SUPPORTED_LANGS)[number];
export const DEFAULT_LANG: AppLang = 'de';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      ru: { translation: ru },
      en: { translation: en },
      de: { translation: de },
    },
    fallbackLng: DEFAULT_LANG,
    supportedLngs: SUPPORTED_LANGS as unknown as string[],
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'app.lang',
    },
    returnNull: false,
  });

export function setAppLanguage(lang: AppLang): void {
  i18n.changeLanguage(lang);
  try {
    localStorage.setItem('app.lang', lang);
  } catch { /* ignore */ }
}

export function getCurrentLanguage(): AppLang {
  const cur = (i18n.language || DEFAULT_LANG).split('-')[0];
  return ((SUPPORTED_LANGS as readonly string[]).includes(cur) ? cur : DEFAULT_LANG) as AppLang;
}

export default i18n;

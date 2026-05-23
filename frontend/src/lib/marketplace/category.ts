/**
 * Helper for service-marketplace screens — picks the localized category
 * title from the backend `categoryMeta` object based on current i18n
 * language. Backend ships `titleRu`, `titleEn`, `titleDe`; we pick by
 * locale with EN as the safe fallback.
 */
import { getCurrentLanguage } from '../../i18n';

export type CategoryMeta = {
  titleRu?: string | null;
  titleEn?: string | null;
  titleDe?: string | null;
  emoji?: string | null;
  minBudget?: number | null;
};

export function pickCategoryTitle(meta: CategoryMeta | null | undefined, fallback = ''): string {
  if (!meta) return fallback;
  const lang = getCurrentLanguage();
  if (lang === 'ru' && meta.titleRu) return meta.titleRu;
  if (lang === 'de' && meta.titleDe) return meta.titleDe;
  if (meta.titleEn) return meta.titleEn;
  return meta.titleRu || meta.titleDe || fallback;
}

/** Same picker over the categories endpoint shape (titleRu/En/De). */
export function pickCategoryListTitle(
  cat: { titleRu?: string; titleEn?: string; titleDe?: string },
  fallback = '',
): string {
  return pickCategoryTitle(cat, fallback);
}

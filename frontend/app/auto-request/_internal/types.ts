/**
 * auto-request — shared types.
 *
 * Pulled out of `create.tsx` during the modular refactor so every
 * subcomponent (forms, modals, link preview, value-prop) speaks the
 * same shape vocabulary without re-declaring it locally.
 */

export type FlowType = 'inspection' | 'selection';

export type City = {
  code: string;
  name: string;
  country: string;
  providersCount?: number;
  aliases?: string[];
};

/**
 * Geo-1 sprint: canonical country payload from `/api/geo/countries`.
 * Frontend never hardcodes display names — they come from the geo namespace.
 */
export type Country = {
  code: string;
  name: string;
  flag: string;
  currency: string;
  locale: string;
  cityCount: number;
};

/**
 * Minimal contract for the theme colors object we read in subcomponents.
 * Avoids `any` proliferation while staying lenient enough to accept the
 * full theme without listing every optional accent token.
 */
export type ColorsLike = {
  background: string;
  card: string;
  text: string;
  textSecondary: string;
  border: string;
  primary: string;
  // Optional accents — present in the runtime theme but not required for compile.
  brand?: string;
  brandSoft?: string;
  [key: string]: string | undefined;
};

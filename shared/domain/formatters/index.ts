/**
 * Formatters — currency, dates, mileage, plates.
 *
 * Locale-aware but framework-free. Surfaces pass the user's locale
 * (e.g. `'ru-RU'`, `'de-DE'`, `'en-US'`) — this module decides nothing
 * about *which* locale to use; that is the surface's i18n stack
 * problem.
 *
 * Ban list: no `react-intl`, no `dayjs`, no `moment`. Native
 * `Intl.NumberFormat` and `Intl.DateTimeFormat` cover every case we
 * have. If a future case requires more — add a single targeted helper,
 * not a library.
 */

export type Locale = 'ru-RU' | 'de-DE' | 'en-US' | (string & {});

// ─────────────────────────────────────────────────────────────────────
// Currency
// ─────────────────────────────────────────────────────────────────────

/**
 * Format an amount in the given currency, locale-aware.
 *
 * Backend stores prices as **whole-currency floats** (e.g. 149.0 for
 * €149) — we do NOT divide by 100 here. If a future endpoint returns
 * cents, convert at the surface boundary, not here.
 */
export function formatCurrency(
  amount: number,
  currency: string,
  locale: Locale = 'en-US',
  opts: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    ...opts,
  }).format(amount);
}

/**
 * Format a numeric range as `"€149 – €299"`. Used by package pricing.
 */
export function formatCurrencyRange(
  min: number,
  max: number,
  currency: string,
  locale: Locale = 'en-US',
): string {
  if (min === max) return formatCurrency(min, currency, locale);
  return `${formatCurrency(min, currency, locale)} – ${formatCurrency(max, currency, locale)}`;
}

// ─────────────────────────────────────────────────────────────────────
// Date / time
// ─────────────────────────────────────────────────────────────────────

/**
 * Format an ISO-8601 string (or `Date`) in the given locale.
 * Returns `''` for null/undefined/invalid inputs — never throws.
 */
export function formatDate(
  iso: string | Date | null | undefined,
  locale: Locale = 'en-US',
  opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' },
): string {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

/** Format date+time. `formatDate` for date-only. */
export function formatDateTime(
  iso: string | Date | null | undefined,
  locale: Locale = 'en-US',
): string {
  return formatDate(iso, locale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Returns `"in 3h"` / `"5m ago"` style relative strings.
 * Falls back to absolute date for periods longer than 7 days.
 */
export function formatRelative(
  iso: string | Date | null | undefined,
  locale: Locale = 'en-US',
  now: Date = new Date(),
): string {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const diffMs = d.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  const diffHour = Math.round(diffMs / 3_600_000);
  const diffDay = Math.round(diffMs / 86_400_000);

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
  if (Math.abs(diffHour) < 24) return rtf.format(diffHour, 'hour');
  if (Math.abs(diffDay) <= 7) return rtf.format(diffDay, 'day');
  return formatDate(d, locale);
}

// ─────────────────────────────────────────────────────────────────────
// Vehicle data
// ─────────────────────────────────────────────────────────────────────

/**
 * Format mileage with thousands separators.
 * `formatMileage(123456, 'de-DE')` → `'123.456 km'`.
 */
export function formatMileage(km: number, locale: Locale = 'en-US'): string {
  return `${new Intl.NumberFormat(locale).format(km)} km`;
}

/**
 * Normalize a German license plate: uppercases and inserts hyphens
 * around the digit run.
 *
 * Best-effort only — accurate splitting between region code and
 * letter group requires the official Kfz-Kennzeichen registry
 * (`B`/`M`/`HH`/…). That dictionary belongs in `validators/` once we
 * have a real consumer; this helper handles the common case where
 * the input *already* has a separator between groups.
 *
 * Does NOT validate — that belongs in `validators/`.
 *
 * `'B AB 1234'` → `'B-AB-1234'`
 * `'M-A-9999'`  → `'M-A-9999'`
 */
export function normalizePlateDE(raw: string): string {
  const upper = raw.toUpperCase().trim();
  // If the input has any spaces or hyphens, treat them as group separators.
  const groups = upper.split(/[\s-]+/).filter(Boolean);
  if (groups.length === 3) return groups.join('-');
  // Fallback: just strip whitespace, do not guess region split.
  return upper.replace(/\s+/g, '');
}

/**
 * Format a VIN with conventional grouping for readability.
 * VINs are 17 chars; we split as 3-6-8.
 */
export function formatVIN(vin: string): string {
  const cleaned = vin.replace(/\s+/g, '').toUpperCase();
  if (cleaned.length !== 17) return cleaned;
  return `${cleaned.slice(0, 3)} ${cleaned.slice(3, 9)} ${cleaned.slice(9)}`;
}

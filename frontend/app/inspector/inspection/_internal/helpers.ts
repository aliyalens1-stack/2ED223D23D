/**
 * Inspector inspection workflow — pure helpers.
 *
 * All functions are pure (no React state, no closures over component
 * scope). Callers pass in what they need (`colors`, current timestamp,
 * i18n shim) as explicit arguments. This makes each helper trivially
 * unit-testable.
 */
import { MEDIA_CONTEXT_LABEL } from './constants';
import type { TLEvent } from './types';

/** Translator shim used by `prettifyEvent` — matches `t(key, { defaultValue: fb })`. */
export type T = (key: string, fallback: string) => string;

/** Minimal colors contract that the helpers actually read. */
export type ToneColors = {
  success?: string;
  warning?: string;
  danger?: string;
  textMuted?: string;
  textSecondary?: string;
  primary?: string;
};

/**
 * Map a semantic tone (`ok`/`warning`/`critical`/`na`) to a runtime theme
 * hex. Falls back to TailwindCSS-style defaults if the theme doesn't
 * provide one of the named accents.
 */
export function toneOf(colors: ToneColors, tone: 'ok' | 'warning' | 'critical' | 'na'): string {
  if (tone === 'ok')       return colors.success || '#16a34a';
  if (tone === 'warning')  return colors.warning || '#f59e0b';
  if (tone === 'critical') return colors.danger  || '#dc2626';
  return colors.textMuted || '#9ca3af';
}

/**
 * Relative time string ("just now", "5m", "2h", "yesterday", "3d").
 *
 * Intentionally lightweight — no `Intl.RelativeTimeFormat` dependency.
 * Caller passes `now` (a tick state updated every 60s) so the rail
 * re-renders without coupling this helper to React.
 */
export function relTime(now: number, iso: string, t: T): string {
  const at = Date.parse(iso);
  if (!at || isNaN(at)) return '';
  const secs = Math.max(0, Math.floor((now - at) / 1000));
  if (secs < 45) return t('insp.tl.now', 'just now');
  if (secs < 90) return '1m';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 7200) return '1h';
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 172800) return t('insp.tl.yesterday', 'yesterday');
  return `${Math.floor(secs / 86400)}d`;
}

/**
 * Projected event card payload for the inspector TimelineRail.
 *
 * Returns `{ icon, tone, title }` for a known event type, or a neutral
 * fallback. Suspicion / provenance / geo are admin-only — we deliberately
 * never surface them through this projector.
 */
export function prettifyEvent(
  ev: TLEvent,
  colors: ToneColors,
  t: T,
): { icon: any; tone: string; title: string } {
  const type = ev.eventType || '';
  const p = ev.payload || {};

  if (type === 'inspection.started') {
    return { icon: 'play-circle', tone: colors.success || '#16a34a',
      title: t('insp.tl.started', 'Inspection started') };
  }
  if (type === 'report.submitted') {
    return { icon: 'checkmark-done-circle', tone: colors.success || '#16a34a',
      title: t('insp.tl.submitted', 'Report submitted') };
  }
  if (type === 'evidence.gaps_overridden') {
    const n = p.softCount || (p.items?.length ?? 0);
    return { icon: 'hand-left', tone: '#f59e0b',
      title: t('insp.tl.override', `Acknowledged ${n} soft gap${n === 1 ? '' : 's'}`) };
  }
  if (type.startsWith('media.uploaded')) {
    const ctx = type.split('.')[2] || p.context || 'photo';
    const human = MEDIA_CONTEXT_LABEL[ctx] || ctx;
    return { icon: 'camera', tone: colors.primary || '#facc15',
      title: t('insp.tl.media', `Captured ${human}`) };
  }
  if (type === 'item.flagged_critical') {
    return { icon: 'close-circle', tone: toneOf(colors, 'critical'),
      title: t('insp.tl.critical', `Critical: ${p.label || p.itemId || 'item'}`) };
  }
  if (type === 'item.flagged_warning') {
    return { icon: 'warning', tone: toneOf(colors, 'warning'),
      title: t('insp.tl.warning', `Warning: ${p.label || p.itemId || 'item'}`) };
  }
  // OCR-1 — vision-assisted capture events.
  if (type === 'ocr.vin_detected') {
    const c = String(p.candidate || '');
    return { icon: 'scan', tone: colors.primary || '#facc15',
      title: t('insp.tl.ocr_vin', `VIN detected: ${c}`) };
  }
  if (type === 'ocr.odometer_detected') {
    const c = String(p.candidate || '');
    const pretty = c && !isNaN(Number(c)) ? Number(c).toLocaleString('en-US') : c;
    return { icon: 'scan', tone: colors.primary || '#facc15',
      title: t('insp.tl.ocr_odo', `Odometer detected: ${pretty} km`) };
  }
  if (type === 'ocr.corrected') {
    return { icon: 'create', tone: '#f59e0b',
      title: t('insp.tl.ocr_corr', `Corrected ${p.kind || 'value'}: ${p.from || '?'} → ${p.to || '?'}`) };
  }
  // Unknown — neutral fallback, no leakage of internal event taxonomy.
  return { icon: 'ellipse', tone: colors.textSecondary || '#9ca3af', title: type.replace(/[._]/g, ' ') };
}

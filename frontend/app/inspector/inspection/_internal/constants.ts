/**
 * Inspector inspection workflow — module-level constants.
 *
 * Pure data only (no React, no theme). Display tones map to runtime theme
 * colors via `toneOf()` in `helpers.ts`.
 */
import type { StatusOption } from './types';

/**
 * Per-item status picker options. The order is intentional —
 * positive → warning → blocking → not-applicable mirrors the order an
 * inspector visually scans the section detail view.
 */
export const STATUS_OPTS: StatusOption[] = [
  { id: 'ok',       label: 'OK',       icon: 'checkmark-circle', tone: 'ok' },
  { id: 'warning',  label: 'Warning',  icon: 'warning',          tone: 'warning' },
  { id: 'critical', label: 'Critical', icon: 'alert-circle',     tone: 'critical' },
  { id: 'na',       label: 'N/A',      icon: 'remove-circle',    tone: 'na' },
];

/**
 * UX-4D — humanised media capture context labels used by the timeline
 * projector (`prettifyEvent` in `helpers.ts`).
 */
export const MEDIA_CONTEXT_LABEL: Record<string, string> = {
  vin: 'VIN',
  odometer: 'odometer',
  damage: 'damage',
  registration: 'registration',
  engine: 'engine',
  interior: 'interior',
  general: 'photo',
};

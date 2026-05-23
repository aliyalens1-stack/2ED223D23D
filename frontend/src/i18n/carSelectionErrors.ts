/**
 * Car-Selection — restrained error mapping (Phase 5 · i18n freeze).
 *
 * Maps the backend unified-envelope `code` (canonical, never localized)
 * onto an explicit, restrained localized phrase. NEVER echo a raw backend
 * `message` to the user without going through this function first.
 *
 * Discipline encoded here:
 *   • Codes (ARTIFACT_TOO_LARGE, INVALID_TRANSITION, …) are CANONICAL and
 *     never translated — they only key into `car_selection.error.*`.
 *   • Per-kind copy is EXPLICIT (no `${kind} exceeds ${cap}` interpolation).
 *     For ARTIFACT_TOO_LARGE we resolve `car_selection.error.ARTIFACT_TOO_LARGE.{kind}`
 *     and fall back to `.default` if kind is unknown.
 *   • If the code is unknown, return the backend `message` field (already
 *     restrained operational tone in this codebase) and finally the generic
 *     fallback.
 *
 * Shape of the unified envelope (server.py):
 *   { error: true, code: "ARTIFACT_TOO_LARGE", message: "...", details: {...} }
 * — may also arrive as { detail: { code, message, details } } from
 * Starlette's HTTPException(detail=...) path.
 */
import type { TFunction } from 'i18next';
import i18n from '../../src/i18n';

export type ArtifactKind = 'image' | 'pdf' | 'file';

interface ApiErrorBody {
  error?: boolean;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  detail?: ApiErrorBody | string;
}

export interface ExtractedError {
  code: string | null;
  message: string | null;
}

/**
 * Pull `{code, message}` out of an axios-style error in a unified way.
 * Accepts both `data.{code,message}` and `data.detail.{code,message}` shapes.
 */
export function extractApiError(err: unknown): ExtractedError {
  const anyErr = err as { response?: { data?: ApiErrorBody }; message?: string };
  const d = anyErr?.response?.data;
  if (d && typeof d === 'object') {
    if (d.code || d.message) {
      return { code: d.code ?? null, message: d.message ?? null };
    }
    if (d.detail && typeof d.detail === 'object') {
      return {
        code: d.detail.code ?? null,
        message: d.detail.message ?? null,
      };
    }
    if (typeof d.detail === 'string') {
      return { code: null, message: d.detail };
    }
  }
  return { code: null, message: anyErr?.message ?? null };
}

/**
 * Resolve a localized Car-Selection error phrase.
 *
 *   mapCarSelectionError(t, err)               → for generic errors
 *   mapCarSelectionError(t, err, 'image')      → so ARTIFACT_TOO_LARGE picks
 *                                                 the per-kind explicit copy
 *
 * Fallback chain (top wins):
 *   1. car_selection.error.<CODE>          (or .<CODE>.<kind> for ARTIFACT_TOO_LARGE)
 *   2. backend `message` (raw — already restrained server-side)
 *   3. car_selection.error.generic
 */
export function mapCarSelectionError(
  t: TFunction,
  err: unknown,
  kindForSize?: ArtifactKind,
): string {
  const { code, message } = extractApiError(err);

  if (code === 'ARTIFACT_TOO_LARGE') {
    const key = kindForSize
      ? `car_selection.error.ARTIFACT_TOO_LARGE.${kindForSize}`
      : 'car_selection.error.ARTIFACT_TOO_LARGE.default';
    const fallbackKey = 'car_selection.error.ARTIFACT_TOO_LARGE.default';
    const v = i18n.t(key, { defaultValue: '' });
    if (v) return v;
    const v2 = i18n.t(fallbackKey, { defaultValue: '' });
    if (v2) return v2;
  }

  if (code) {
    const v = i18n.t(`car_selection.error.${code}`, { defaultValue: '' });
    if (v) return v;
  }

  if (message) return message;
  return t('car_selection.error.generic', { defaultValue: 'Error' });
}

/**
 * Same fallback chain but starting from an explicit code (no axios error).
 * Useful when the client itself detects an over-cap upload before round-trip.
 */
export function carSelectionErrorByCode(
  t: TFunction,
  code: string,
  kindForSize?: ArtifactKind,
): string {
  if (code === 'ARTIFACT_TOO_LARGE') {
    const key = kindForSize
      ? `car_selection.error.ARTIFACT_TOO_LARGE.${kindForSize}`
      : 'car_selection.error.ARTIFACT_TOO_LARGE.default';
    return t(key, { defaultValue: t('car_selection.error.ARTIFACT_TOO_LARGE.default') });
  }
  const v = i18n.t(`car_selection.error.${code}`, { defaultValue: '' });
  if (v) return v;
  return t('car_selection.error.generic', { defaultValue: 'Error' });
}

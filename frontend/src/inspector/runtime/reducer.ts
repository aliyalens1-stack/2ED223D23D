/**
 * Inspector Runtime — pure reducer.
 *
 * Why a reducer (not useState scattered): every section/item interaction
 * needs to be replayable from AsyncStorage. Each action is a discrete
 * transition; the runtime state is whatever you get after replaying them.
 *
 * No side effects in this file. AsyncStorage flush + media upload happen
 * upstream (in the screen component); the reducer only computes the next
 * pure state.
 */

import {
  BODY_PAINT_SECTION,
  ItemSeverity,
  autoSeverityForPaintDepth,
  BodyPaintItem,
} from './bodyPaintTemplate';

// ── State shape ──────────────────────────────────────────────────────

/** One item's runtime result. Lives alongside the template (which is static). */
export interface ItemResult {
  /** Numeric value for paint_depth items (µm). */
  numericValue?: number;
  /** Severity (manual OR auto-derived from numericValue). */
  severity: ItemSeverity;
  /** Was severity set by auto-rule (vs manually picked)? Inspector overrides win. */
  severityAuto: boolean;
  /** Optional free-form note. */
  note?: string;
  /** Local URIs of attached photos (base64-able via expo-image-picker). */
  photoUris: string[];
  /** Last-touched timestamp — for sync ordering. */
  updatedAt?: string;
}

export interface RuntimeState {
  /** Job id from URL. Stable identity for persistence key. */
  jobId: string;
  /** Vehicle metadata snapshot — shown in header. */
  vehicle: { brand: string; model: string; city: string };
  /** Which section the inspector is currently working in. R1: always body_paint. */
  sectionKey: string;
  /** Index inside the current section's items array. */
  currentItemIdx: number;
  /** Per-item results, keyed by item.key. */
  items: Record<string, ItemResult>;
  /** Bootstrapped from AsyncStorage? UI hides controls until true to avoid flash. */
  hydrated: boolean;
  /** Set to true after server submit. UI flips to "done" mode. */
  submitted: boolean;
}

// ── Actions ──────────────────────────────────────────────────────────

export type RuntimeAction =
  | { type: 'HYDRATE'; payload: Partial<RuntimeState> }
  | { type: 'INIT'; jobId: string; vehicle: RuntimeState['vehicle'] }
  | { type: 'GOTO_ITEM'; idx: number }
  | { type: 'NEXT_ITEM' }
  | { type: 'PREV_ITEM' }
  | { type: 'SET_NUMERIC'; itemKey: string; value: number | undefined }
  | { type: 'SET_SEVERITY'; itemKey: string; severity: ItemSeverity }
  | { type: 'SET_NOTE'; itemKey: string; note: string }
  | { type: 'ADD_PHOTO'; itemKey: string; uri: string }
  | { type: 'REMOVE_PHOTO'; itemKey: string; uri: string }
  | { type: 'MARK_SUBMITTED' };

// ── Helpers ──────────────────────────────────────────────────────────

const SECTION = BODY_PAINT_SECTION;
const ITEMS = SECTION.items;
const ITEMS_LEN = ITEMS.length;

function emptyResult(): ItemResult {
  return {
    numericValue: undefined,
    severity: 'not_checked',
    severityAuto: false,
    note: undefined,
    photoUris: [],
  };
}

function findTemplateItem(itemKey: string): BodyPaintItem | undefined {
  return ITEMS.find((i) => i.key === itemKey) as BodyPaintItem | undefined;
}

function clampItemIdx(idx: number): number {
  if (idx < 0) return 0;
  if (idx >= ITEMS_LEN) return ITEMS_LEN - 1;
  return idx;
}

function touch(state: RuntimeState, itemKey: string, patch: Partial<ItemResult>): RuntimeState {
  const prev = state.items[itemKey] ?? emptyResult();
  const next: ItemResult = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  return {
    ...state,
    items: { ...state.items, [itemKey]: next },
  };
}

// ── Initial state ────────────────────────────────────────────────────

export function initialState(jobId: string): RuntimeState {
  // Pre-populate every template item with an empty result so UI never
  // has to nil-check while iterating. `not_checked` is the canonical
  // "untouched" marker (mirrors backend ITEM_STATUSES).
  const items: Record<string, ItemResult> = {};
  for (const it of ITEMS) items[it.key] = emptyResult();

  return {
    jobId,
    vehicle: { brand: '', model: '', city: '' },
    sectionKey: SECTION.key,
    currentItemIdx: 0,
    items,
    hydrated: false,
    submitted: false,
  };
}

// ── Reducer ──────────────────────────────────────────────────────────

export function runtimeReducer(state: RuntimeState, action: RuntimeAction): RuntimeState {
  switch (action.type) {
    case 'HYDRATE': {
      // Merge persisted shape over current. items[] is per-key merged so
      // adding a new template item later doesn't lose existing data.
      const merged = { ...state, ...action.payload, hydrated: true };
      if (action.payload.items) {
        merged.items = { ...state.items, ...action.payload.items };
      }
      return merged;
    }

    case 'INIT':
      return { ...state, jobId: action.jobId, vehicle: action.vehicle };

    case 'GOTO_ITEM':
      return { ...state, currentItemIdx: clampItemIdx(action.idx) };

    case 'NEXT_ITEM':
      return { ...state, currentItemIdx: clampItemIdx(state.currentItemIdx + 1) };

    case 'PREV_ITEM':
      return { ...state, currentItemIdx: clampItemIdx(state.currentItemIdx - 1) };

    case 'SET_NUMERIC': {
      const tmpl = findTemplateItem(action.itemKey);
      if (!tmpl) return state;
      // Apply auto-severity if rule exists AND inspector hasn't manually
      // overridden it before. Manual override sticks even if number changes.
      const prev = state.items[action.itemKey];
      const auto = autoSeverityForPaintDepth(tmpl, action.value);
      const shouldAutoApply = auto && (!prev || prev.severityAuto || prev.severity === 'not_checked');
      return touch(state, action.itemKey, {
        numericValue: action.value,
        severity: shouldAutoApply ? auto : prev?.severity ?? 'not_checked',
        severityAuto: !!shouldAutoApply,
      });
    }

    case 'SET_SEVERITY':
      return touch(state, action.itemKey, {
        severity: action.severity,
        severityAuto: false, // explicit human choice — auto no longer applies
      });

    case 'SET_NOTE':
      return touch(state, action.itemKey, { note: action.note });

    case 'ADD_PHOTO': {
      const prev = state.items[action.itemKey];
      const existing = prev?.photoUris ?? [];
      if (existing.includes(action.uri)) return state;
      return touch(state, action.itemKey, { photoUris: [...existing, action.uri] });
    }

    case 'REMOVE_PHOTO': {
      const prev = state.items[action.itemKey];
      const next = (prev?.photoUris ?? []).filter((u) => u !== action.uri);
      return touch(state, action.itemKey, { photoUris: next });
    }

    case 'MARK_SUBMITTED':
      return { ...state, submitted: true };

    default:
      return state;
  }
}

// ── Selectors ────────────────────────────────────────────────────────

/** Items that have been touched (severity ≠ not_checked). */
export function checkedCount(state: RuntimeState): number {
  let n = 0;
  for (const it of ITEMS) {
    if (state.items[it.key]?.severity && state.items[it.key].severity !== 'not_checked') n++;
  }
  return n;
}

/** Items requiring a photo (warning/critical severity + photoRequiredIfWarning template flag)
 *  that don't actually have one yet. Used for soft-warn before exit. */
export function itemsMissingPhoto(state: RuntimeState): string[] {
  const out: string[] = [];
  for (const it of ITEMS) {
    if (!it.photoRequiredIfWarning) continue;
    const r = state.items[it.key];
    if (!r) continue;
    const needsPhoto = r.severity === 'warning' || r.severity === 'critical';
    if (needsPhoto && r.photoUris.length === 0) out.push(it.key);
  }
  return out;
}

/** Completion percent — touched items / total. */
export function progressPct(state: RuntimeState): number {
  return Math.round((checkedCount(state) / ITEMS_LEN) * 100);
}

/** Confidence label for the section. Soft, not binary. */
export function sectionConfidence(state: RuntimeState): {
  level: 'empty' | 'partial' | 'complete' | 'complete_with_warnings';
  reasons: string[];
} {
  const checked = checkedCount(state);
  const missingPhotos = itemsMissingPhoto(state);
  const reasons: string[] = [];

  if (checked === 0) return { level: 'empty', reasons: [] };
  if (checked < ITEMS_LEN) {
    reasons.push(`Не отмечено ${ITEMS_LEN - checked} из ${ITEMS_LEN} пунктов`);
    return { level: 'partial', reasons };
  }
  if (missingPhotos.length > 0) {
    reasons.push(`${missingPhotos.length} фото отсутствует на проблемных пунктах`);
    return { level: 'complete_with_warnings', reasons };
  }
  return { level: 'complete', reasons: [] };
}

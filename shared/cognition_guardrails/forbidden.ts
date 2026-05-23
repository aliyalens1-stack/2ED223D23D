// cognition_guardrails/forbidden.ts
//
// Single source of truth for forbidden lexicon. The actual lists live in
// `guardrails.json` so both TS (web + Expo) AND Python (CI / DOM scan)
// consume the SAME data — no drift possible.
//
// DO NOT add inline strings here. Edit `guardrails.json` instead.

// eslint-disable-next-line @typescript-eslint/no-var-requires
import guardrails from './guardrails.json';

export type ForbiddenGroup =
  | 'cognition_noise'
  | 'operational_leak'
  | 'urgency_theatre'
  | 'form_thinking'
  | 'rejection_punitive'
  | 'celebration';

const F = (guardrails as any).forbidden_lexicon as Record<ForbiddenGroup, string[]>;

export const FORBIDDEN_LEXICON: Record<ForbiddenGroup, readonly string[]> = {
  cognition_noise: Object.freeze([...F.cognition_noise]),
  operational_leak: Object.freeze([...F.operational_leak]),
  urgency_theatre: Object.freeze([...F.urgency_theatre]),
  form_thinking: Object.freeze([...F.form_thinking]),
  rejection_punitive: Object.freeze([...F.rejection_punitive]),
  celebration: Object.freeze([...F.celebration]),
} as const;

/**
 * Flattened union of every forbidden phrase across every group.
 * Used by runtime DOM scan when no surface-specific override applies.
 */
export const ALL_FORBIDDEN: readonly string[] = Object.freeze(
  ([] as string[]).concat(
    F.cognition_noise,
    F.operational_leak,
    F.urgency_theatre,
    F.form_thinking,
    F.rejection_punitive,
    F.celebration,
  ),
);

/**
 * Hex literals and Tailwind class fragments that must not appear in
 * customer-facing source after the Step 3 verification cleanup.
 */
export const FORBIDDEN_COLORS: {
  readonly red_rejection: readonly string[];
  readonly red_class_fragments: readonly string[];
} = Object.freeze({
  red_rejection: Object.freeze([...(guardrails as any).forbidden_colors.red_rejection]),
  red_class_fragments: Object.freeze([...(guardrails as any).forbidden_colors.red_class_fragments]),
});

/**
 * Predicate: returns the first forbidden phrase found in `text`,
 * or null when the text is clean. Case-insensitive substring match.
 * Pure — no allocations beyond the lowercased haystack.
 */
export function findForbidden(
  text: string,
  groups: readonly ForbiddenGroup[] = [
    'cognition_noise',
    'operational_leak',
    'urgency_theatre',
    'form_thinking',
    'rejection_punitive',
    'celebration',
  ],
): string | null {
  const hay = text.toLowerCase();
  for (const g of groups) {
    for (const phrase of FORBIDDEN_LEXICON[g]) {
      if (hay.includes(phrase.toLowerCase())) return phrase;
    }
  }
  return null;
}

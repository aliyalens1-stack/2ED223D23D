// cognition_guardrails/required.ts
//
// Required vocabulary per surface. Reads from the JSON single source.

// eslint-disable-next-line @typescript-eslint/no-var-requires
import guardrails from './guardrails.json';

export type RequiredSurface =
  | 'intake'
  | 'establishment'
  | 'continuity'
  | 'cognition';

const R = (guardrails as any).required_vocabulary as Record<RequiredSurface, string[]>;

export const REQUIRED_VOCABULARY: Record<RequiredSurface, readonly string[]> = {
  intake: Object.freeze([...R.intake]),
  establishment: Object.freeze([...R.establishment]),
  continuity: Object.freeze([...R.continuity]),
  cognition: Object.freeze([...R.cognition]),
} as const;

/**
 * Returns required phrases that are MISSING from `text`. Empty array
 * means the surface speaks the expected vocabulary. Case-insensitive.
 */
export function missingRequired(text: string, surface: RequiredSurface): string[] {
  const hay = text.toLowerCase();
  return REQUIRED_VOCABULARY[surface].filter((p) => !hay.includes(p.toLowerCase()));
}

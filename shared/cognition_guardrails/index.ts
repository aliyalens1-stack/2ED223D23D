// cognition_guardrails — barrel.
//
// Centralised export of the three guardrail layers consumed by web,
// mobile, and CI scanners.

export { FORBIDDEN_LEXICON, ALL_FORBIDDEN, FORBIDDEN_COLORS, findForbidden } from './forbidden';
export type { ForbiddenGroup } from './forbidden';
export { REQUIRED_VOCABULARY, missingRequired } from './required';
export type { RequiredSurface } from './required';
export { STRUCTURAL_ASSERTIONS } from './structural';
export type { StructuralAssertion } from './structural';

// eslint-disable-next-line @typescript-eslint/no-var-requires
import guardrails from './guardrails.json';

/** Surface → source file mapping (used by the static scanner). */
export const SURFACE_SOURCE_PATHS = (guardrails as any).surface_source_paths as Record<
  string,
  { files: string[]; forbidden_groups: string[]; required_group: string }
>;

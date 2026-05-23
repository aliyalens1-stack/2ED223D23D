// cognition_guardrails/structural.ts
//
// Declarative structural assertions per surface state. The runner reads
// these and verifies DOM presence / absence with no surface-specific
// code paths.

// eslint-disable-next-line @typescript-eslint/no-var-requires
import guardrails from './guardrails.json';

export interface StructuralAssertion {
  readonly url_pattern: string;
  readonly state?: string;
  readonly present: readonly string[];
  readonly absent: readonly string[];
}

const S = (guardrails as any).structural_invariants as Record<string, any>;

function freeze(a: any): StructuralAssertion {
  return Object.freeze({
    url_pattern: a.url_pattern,
    state: a.state,
    present: Object.freeze([...(a.present || [])]),
    absent: Object.freeze([...(a.absent || [])]),
  });
}

export const STRUCTURAL_ASSERTIONS = Object.freeze({
  intake_initial: freeze(S.intake_initial),
  establishment_pre_engagement: freeze(S.establishment_pre_engagement),
  cognition_forming: freeze(S.cognition_forming),
  continuity_forming: freeze(S.continuity_forming),
}) as Record<
  | 'intake_initial'
  | 'establishment_pre_engagement'
  | 'cognition_forming'
  | 'continuity_forming',
  StructuralAssertion
>;

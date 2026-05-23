/**
 * InspectionReport — state machine + draft semantics.
 *
 * Boring, explicit predicates. No factory, no classes.
 * Backend reference: `app/auto_requests/reports.py::submit_report`,
 * `schemas.py::SubmitReportRequest` validators.
 *
 * Used by:
 *   - web-app/src/pages/inspector/ReportWorkspace.tsx
 *   - (Expo workstation to follow in Phase 1.2)
 */
import {
  CHECKLIST_TEMPLATE,
  type ReportDraft,
  type ChecklistItemValue,
  type SubmitReportPayload,
  type ReportVerdict,
  type InspectionReport,
} from '../contracts/inspection-report';
import type { InspectionJobStatus } from '../contracts/inspection-job';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** Debounce window for autosave. 1500ms — Linear/Notion baseline. */
export const AUTOSAVE_DEBOUNCE_MS = 1500;

/** localStorage key for the draft of a given job. */
export function draftStorageKey(jobId: string): string {
  return `inspector:report-draft:${jobId}`;
}

// ─────────────────────────────────────────────────────────────────────
// Lifecycle predicates
// ─────────────────────────────────────────────────────────────────────

/**
 * Inspector can edit the report only while the job is in the
 * `inspecting` state. Outside that, the workstation is read-only.
 */
export function canEdit(jobStatus: InspectionJobStatus): boolean {
  return jobStatus === 'inspecting';
}

/**
 * Inspector can submit only if the job is editable AND the draft
 * passes minimum-completeness validation. Backend re-validates.
 */
export function canSubmit(
  draft: ReportDraft,
  jobStatus: InspectionJobStatus,
): boolean {
  return canEdit(jobStatus) && validateForSubmit(draft).valid;
}

// ─────────────────────────────────────────────────────────────────────
// Draft construction
// ─────────────────────────────────────────────────────────────────────

/**
 * Build a fresh draft for a job. Pre-fills checklist with all template
 * keys at status `'not_checked'` so the UI never sees a missing key.
 */
export function emptyDraft(jobId: string): ReportDraft {
  return {
    jobId,
    score: null,
    verdict: null,
    checklist: CHECKLIST_TEMPLATE.map<ChecklistItemValue>(t => ({
      key: t.key,
      status: 'not_checked',
      comment: null,
    })),
    issues: [],
    summary: '',
    repairEstimateMin: null,
    repairEstimateMax: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Heal a stored draft against the current template — adds any newly
 * introduced template keys (status `not_checked`), drops removed ones.
 * Idempotent. Does NOT mutate timestamps unless something changed.
 */
export function reconcileDraft(stored: ReportDraft): ReportDraft {
  const templateKeys = new Set(CHECKLIST_TEMPLATE.map(t => t.key));
  const storedByKey = new Map(stored.checklist.map(c => [c.key, c]));

  const reconciled: ChecklistItemValue[] = CHECKLIST_TEMPLATE.map(t => {
    const existing = storedByKey.get(t.key);
    return existing ?? { key: t.key, status: 'not_checked', comment: null };
  });

  const droppedSomething =
    stored.checklist.some(c => !templateKeys.has(c.key)) ||
    reconciled.length !== stored.checklist.length;

  if (!droppedSomething) return stored;
  return { ...stored, checklist: reconciled };
}

// ─────────────────────────────────────────────────────────────────────
// Validation — explicit, no schema lib
// ─────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  /** Human-readable issues for the toolbar's "Cannot submit because…" hint. */
  reasons: string[];
  /** Number of checklist items still at `not_checked`. */
  uncheckedCount: number;
}

export function validateForSubmit(draft: ReportDraft): ValidationResult {
  const reasons: string[] = [];

  if (draft.score == null || draft.score < 1 || draft.score > 10) {
    reasons.push('score_required_1_to_10');
  }
  if (!draft.verdict) {
    reasons.push('verdict_required');
  }
  const summary = (draft.summary ?? '').trim();
  if (summary.length < 10) {
    reasons.push('summary_too_short_min_10');
  }
  if (summary.length > 4000) {
    reasons.push('summary_too_long_max_4000');
  }

  const uncheckedCount = draft.checklist.filter(c => c.status === 'not_checked').length;
  // Allow up to 30% unchecked — inspectors may legitimately skip some
  // items (e.g. spare tire missing). Backend has no such limit; this
  // is a UI-side soft rule that prevents blank submissions only.
  const totalItems = draft.checklist.length || 1;
  if (uncheckedCount / totalItems > 0.3) {
    reasons.push('too_many_unchecked_items');
  }

  if (
    draft.repairEstimateMin != null &&
    draft.repairEstimateMax != null &&
    draft.repairEstimateMin > draft.repairEstimateMax
  ) {
    reasons.push('repair_estimate_min_gt_max');
  }

  return {
    valid: reasons.length === 0,
    reasons,
    uncheckedCount,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Conversion — draft → submit payload
// ─────────────────────────────────────────────────────────────────────

/**
 * Project a draft into the exact backend payload shape. Throws a
 * descriptive Error if the draft is incomplete — callers should call
 * `validateForSubmit` first and gate the submit button.
 */
export function draftToSubmitPayload(draft: ReportDraft): SubmitReportPayload {
  if (draft.score == null) throw new Error('score is required');
  if (!draft.verdict) throw new Error('verdict is required');
  return {
    score: draft.score,
    verdict: draft.verdict as ReportVerdict,
    checklist: draft.checklist,
    issues: draft.issues,
    summary: (draft.summary ?? '').trim(),
    repairEstimateMin: draft.repairEstimateMin ?? null,
    repairEstimateMax: draft.repairEstimateMax ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Completion math — for the checklist rail's progress dots
// ─────────────────────────────────────────────────────────────────────

export interface GroupCompletion {
  total: number;
  checked: number;
  okCount: number;
  warningCount: number;
  problemCount: number;
}

export function groupCompletion(
  draft: ReportDraft,
  group: string,
): GroupCompletion {
  const keys = new Set(
    CHECKLIST_TEMPLATE.filter(t => t.group === group).map(t => t.key),
  );
  let total = 0, checked = 0, ok = 0, warn = 0, prob = 0;
  for (const item of draft.checklist) {
    if (!keys.has(item.key)) continue;
    total += 1;
    if (item.status !== 'not_checked') checked += 1;
    if (item.status === 'ok') ok += 1;
    if (item.status === 'warning') warn += 1;
    if (item.status === 'problem') prob += 1;
  }
  return { total, checked, okCount: ok, warningCount: warn, problemCount: prob };
}

// ─────────────────────────────────────────────────────────────────────
// E1 — Server-side report lifecycle (admin moderation + customer view).
//
// MIRRORS backend `app/auto_requests/reports.py::admin_set_report_status`
// and `router_admin.py` /reports/{id}/approve · /reports/{id}/reject.
//
// Shared owns the rules; backend owns the data. Surfaces import these
// helpers instead of hardcoding "approved"/"rejected" string literals
// or per-screen visibility ladders.
// ─────────────────────────────────────────────────────────────────────

/**
 * Server-side report status. Lives on `inspection_reports.status`.
 *
 *   draft     — local-only artifact, never persisted server-side in 1.1B.
 *               Listed for completeness; the canonical "report exists"
 *               state on the server is `submitted`.
 *   submitted — inspector finished work, awaits admin moderation.
 *   approved  — admin signed off, customer can fully see it.
 *   rejected  — admin sent it back; inspector must re-submit.
 */
export type ReportLifecycleStatus =
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected';

export const REPORT_LIFECYCLE_STATUSES: readonly ReportLifecycleStatus[] = [
  'draft', 'submitted', 'approved', 'rejected',
] as const;

/**
 * What a CUSTOMER sees about a report at a given lifecycle position.
 *
 *   unavailable — report does not exist or has been rejected; the UI
 *                 must NOT leak any inspection content (rejected reports
 *                 may contain raw notes the customer paid for but didn't
 *                 receive — those re-emerge after the next submit).
 *   preview     — report submitted, awaiting admin sign-off; the UI may
 *                 show "report is being reviewed" + score/verdict only.
 *                 No checklist body, no issues body, no media. This is a
 *                 product-policy choice mirroring backend
 *                 `customer_router::get_report_for_customer`.
 *   available   — report approved; customer sees full body.
 */
export type CustomerReportVisibility = 'unavailable' | 'preview' | 'available';

/**
 * Lifecycle ordering: higher = more "settled". Used by `mergeMonotonic`
 * to refuse downgrades ("approved → submitted" cannot happen via API
 * eventual-consistency; only an explicit admin action can).
 *
 *   draft (0) < submitted (1) < approved (2)
 *   rejected is OFF the main ladder and is handled separately.
 */
const LIFECYCLE_ORDER: Readonly<Record<ReportLifecycleStatus, number>> = {
  draft: 0,
  submitted: 1,
  approved: 2,
  rejected: -1, // sentinel — not on the forward ladder
} as const;

/**
 * What admin transitions are legal from a given current status. Mirrors
 * `app/auto_requests/router_admin.py`:
 *   submitted → approved | rejected
 *   rejected  → submitted (inspector resubmits — surfaces should not
 *                          allow admin to drive this transition; only
 *                          inspector workspace re-submits)
 *   approved  → ∅ (terminal)
 *   draft     → ∅ (server doesn't see drafts)
 */
export function allowedAdminTransitions(
  current: ReportLifecycleStatus,
): readonly ReportLifecycleStatus[] {
  switch (current) {
    case 'submitted':
      return ['approved', 'rejected'] as const;
    case 'rejected':
      // Admin re-approval after rejection is intentionally unsupported.
      // The flow expects the inspector to resubmit; admin moderates
      // the new submission, not the old rejected payload.
      return [] as const;
    case 'approved':
    case 'draft':
    default:
      return [] as const;
  }
}

/**
 * Project a report status into the slice a CUSTOMER is allowed to see.
 *
 * Caller (UI) is responsible for stripping body fields when the result
 * is `'unavailable'` or `'preview'`. This function only encodes the
 * rule, not the data scrubbing.
 */
export function projectForCustomer(
  status: ReportLifecycleStatus | null | undefined,
): CustomerReportVisibility {
  if (status === 'approved') return 'available';
  if (status === 'submitted') return 'preview';
  // draft, rejected, missing → customer sees nothing
  return 'unavailable';
}

/**
 * What an INSPECTOR is allowed to see about their own report. Inspectors
 * always see their own work (no privacy gate against the author), but
 * the workstation remains read-only after submission until rejection
 * unlocks it again.
 */
export function inspectorCanReopen(
  status: ReportLifecycleStatus | null | undefined,
): boolean {
  // Only rejected reports can be edited again — mirrors backend
  // `submit_report` which only accepts a new submission when the
  // job is back in `inspecting` state (rejection puts it there).
  return status === 'rejected';
}

/**
 * Merge two snapshots of the same report status, preferring the more
 * settled (higher) state. Refuses silent downgrades that could come
 * from out-of-order webhook deliveries or stale polls.
 *
 * Rules:
 *   - `null/undefined` is treated as the very bottom (any state wins).
 *   - `rejected` is its own branch — it CAN replace `submitted` (admin
 *     just rejected) but MUST NOT replace `approved` (a stale rejection
 *     event arriving after approval is a bug; we keep `approved`).
 *   - `approved` is terminal — it always wins against incoming
 *     non-`approved` values.
 *   - On exact equality the previous value is returned (ref-stable).
 */
export function mergeMonotonic(
  prev: ReportLifecycleStatus | null | undefined,
  next: ReportLifecycleStatus | null | undefined,
): ReportLifecycleStatus | null {
  if (!prev && !next) return null;
  if (!prev) return next ?? null;
  if (!next) return prev;
  if (prev === next) return prev;

  // Approved is sticky — a stale "submitted"/"rejected" never wins.
  if (prev === 'approved') return 'approved';
  if (next === 'approved') return 'approved';

  // Rejected can supersede submitted/draft (admin just rejected) but
  // not the inverse — once you're rejected, "submitted" coming in
  // means the inspector resubmitted; that's a forward step.
  if (prev === 'rejected' && next === 'submitted') return 'submitted';
  if (next === 'rejected' && (prev === 'submitted' || prev === 'draft')) {
    return 'rejected';
  }

  // Otherwise pick the higher rank on the forward ladder.
  return LIFECYCLE_ORDER[next] > LIFECYCLE_ORDER[prev] ? next : prev;
}

/**
 * Strip body fields a customer must NOT see at a given visibility level.
 * Pure projection — does not mutate the input.
 *
 * - `available` → returns the report as-is.
 * - `preview`   → keeps id/jobId/score/verdict/submittedAt; drops
 *                 checklist/issues/summary/repair-estimate/media.
 * - `unavailable` → returns null (caller renders an empty state).
 */
export function projectReportBody<R extends Partial<InspectionReport> & { id?: string; jobId?: string }>(
  report: R | null | undefined,
  status: ReportLifecycleStatus | null | undefined,
): R | { id: string; jobId: string; score?: number; verdict?: ReportVerdict; submittedAt?: string } | null {
  const visibility = projectForCustomer(status);
  if (visibility === 'unavailable' || !report) return null;
  if (visibility === 'available') return report;
  // preview — minimal slice only
  return {
    id: String(report.id ?? ''),
    jobId: String(report.jobId ?? ''),
    score: report.score,
    verdict: report.verdict,
    submittedAt: report.submittedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Self-test invariants — runtime-callable, framework-free.
//
// No vitest/jest yet on the repo; we ship a plain function that throws
// on inconsistency. Surfaces or CI can opt-in by calling
// `assertInspectionReportInvariants()` once on boot.
// ─────────────────────────────────────────────────────────────────────

export function assertInspectionReportInvariants(): void {
  const eq = <T>(a: T, b: T, label: string) => {
    if (a !== b) throw new Error(`inspection-report invariant failed: ${label} (got=${String(a)} want=${String(b)})`);
  };

  // Customer visibility ladder
  eq(projectForCustomer('approved'), 'available', 'approved → available');
  eq(projectForCustomer('submitted'), 'preview', 'submitted → preview');
  eq(projectForCustomer('rejected'), 'unavailable', 'rejected → unavailable');
  eq(projectForCustomer('draft'), 'unavailable', 'draft → unavailable');
  eq(projectForCustomer(null), 'unavailable', 'null → unavailable');

  // Admin transitions
  const t1 = allowedAdminTransitions('submitted');
  eq(t1.length, 2, 'submitted has 2 transitions');
  eq(t1.includes('approved'), true, 'submitted → approved allowed');
  eq(t1.includes('rejected'), true, 'submitted → rejected allowed');
  eq(allowedAdminTransitions('approved').length, 0, 'approved is terminal for admin');
  eq(allowedAdminTransitions('rejected').length, 0, 'rejected is terminal for admin (inspector resubmits)');
  eq(allowedAdminTransitions('draft').length, 0, 'draft has no admin transitions');

  // Inspector reopen
  eq(inspectorCanReopen('rejected'), true, 'inspector can reopen rejected');
  eq(inspectorCanReopen('submitted'), false, 'inspector cannot reopen submitted');
  eq(inspectorCanReopen('approved'), false, 'inspector cannot reopen approved');

  // Monotonic merge — downgrade prevention
  eq(mergeMonotonic('approved', 'submitted'), 'approved', 'approved sticks vs submitted');
  eq(mergeMonotonic('approved', 'rejected'), 'approved', 'approved sticks vs rejected');
  eq(mergeMonotonic('approved', 'draft'), 'approved', 'approved sticks vs draft');
  eq(mergeMonotonic('submitted', 'approved'), 'approved', 'submitted upgrades to approved');
  eq(mergeMonotonic('submitted', 'rejected'), 'rejected', 'submitted goes to rejected (admin rejection)');
  eq(mergeMonotonic('rejected', 'submitted'), 'submitted', 'rejected → submitted (inspector resubmit)');
  eq(mergeMonotonic('draft', 'submitted'), 'submitted', 'draft → submitted forward step');
  eq(mergeMonotonic(null, 'submitted'), 'submitted', 'null is the bottom of the ladder');
  eq(mergeMonotonic('submitted', null), 'submitted', 'null does not erase a known status');
  eq(mergeMonotonic('approved', 'approved'), 'approved', 'idempotent on equality');

  // Body projection — unavailable strips everything
  const fakeReport = {
    id: 'r1', jobId: 'j1', score: 8.5, verdict: 'recommended' as const,
    summary: 'sensitive notes inspector typed', checklist: [], issues: [],
    submittedAt: '2026-01-01T00:00:00Z', media: [], inspectorId: 'i1',
  };
  eq(projectReportBody(fakeReport, 'rejected'), null, 'rejected → null body');
  eq(projectReportBody(fakeReport, null), null, 'missing → null body');
  const preview = projectReportBody(fakeReport, 'submitted') as {
    id: string; summary?: string; verdict?: string;
  };
  eq(preview.id, 'r1', 'preview keeps id');
  eq(preview.verdict, 'recommended', 'preview keeps verdict');
  eq((preview as { summary?: string }).summary, undefined, 'preview drops summary');
  const full = projectReportBody(fakeReport, 'approved') as typeof fakeReport;
  eq(full.summary, fakeReport.summary, 'approved keeps summary');
}

/**
 * InspectionJob — state machine.
 *
 * Behavioral truth for inspector job lifecycle. Plain TypeScript,
 * explicit functions, asymmetric (each verb gets its own predicate).
 * Mirrors the booking machine's discipline; copies the structure
 * intentionally instead of abstracting.
 *
 * Backend reference:
 *   POST /api/inspector/jobs/:id/claim            → claimed
 *   POST /api/inspector/jobs/:id/on-route         → on_route
 *   POST /api/inspector/jobs/:id/arrived          → arrived
 *   POST /api/inspector/jobs/:id/start-inspection → inspecting
 *   POST /api/inspector/jobs/:id/report           → report_ready
 *   POST /api/inspector/jobs/:id/cancel           → cancelled
 *   (completion is server-driven, no inspector-side verb)
 */
import type { InspectionJobStatus } from '../contracts/inspection-job';
import type { InspectorExposure } from '../contracts/inspection-job';

// ─────────────────────────────────────────────────────────────────────
// Predicates — terminal / in-flight / fresh
// ─────────────────────────────────────────────────────────────────────

export function isTerminal(status: InspectionJobStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/** Inspector is physically en route, on site, or working. */
export function isFieldActive(status: InspectionJobStatus): boolean {
  return (
    status === 'on_route' ||
    status === 'arrived' ||
    status === 'inspecting'
  );
}

/** Job is awaiting any kind of inspector action. */
export function awaitsInspectorAction(status: InspectionJobStatus): boolean {
  return (
    status === 'claimed' ||
    status === 'on_route' ||
    status === 'arrived' ||
    status === 'inspecting'
  );
}

// ─────────────────────────────────────────────────────────────────────
// Capabilities — explicit, asymmetric, one verb per function.
//
// The asymmetry is intentional: `canClaim` reads from an exposure,
// every other verb reads from a job status. Generic abstractions would
// hide this — keep it explicit.
// ─────────────────────────────────────────────────────────────────────

/** Inspector can claim an exposure if it is still open. */
export function canClaim(exposure: Pick<InspectorExposure, 'status'>): boolean {
  return exposure.status === 'open';
}

/** Inspector can mark themselves as travelling once the job is claimed. */
export function canStartRoute(status: InspectionJobStatus): boolean {
  return status === 'claimed';
}

/** Inspector can confirm arrival once en route. */
export function canMarkArrived(status: InspectionJobStatus): boolean {
  return status === 'on_route';
}

/** Inspector can start the physical inspection only on site. */
export function canStartInspection(status: InspectionJobStatus): boolean {
  return status === 'arrived';
}

/** Inspector can submit a report only while actively inspecting. */
export function canSubmitReport(status: InspectionJobStatus): boolean {
  return status === 'inspecting';
}

/**
 * Inspector can cancel any non-terminal, pre-report job.
 *
 * Once the report is submitted, the inspector cannot unilaterally
 * cancel — that becomes a customer-facing dispute. This is the
 * regulatory safety boundary.
 */
export function canCancel(status: InspectionJobStatus): boolean {
  return (
    status === 'claimed' ||
    status === 'on_route' ||
    status === 'arrived' ||
    status === 'inspecting'
  );
}

// ─────────────────────────────────────────────────────────────────────
// Transitions — explicit literal map.
// ─────────────────────────────────────────────────────────────────────

const ALLOWED: Record<InspectionJobStatus, readonly InspectionJobStatus[]> = {
  claimed:      ['on_route', 'cancelled'],
  on_route:     ['arrived', 'cancelled'],
  arrived:      ['inspecting', 'cancelled'],
  inspecting:   ['report_ready', 'cancelled'],
  report_ready: ['completed'],
  completed:    [],
  cancelled:    [],
};

export function canTransition(
  from: InspectionJobStatus,
  to: InspectionJobStatus,
): boolean {
  if (from === to) return true;
  return ALLOWED[from].includes(to);
}

// ─────────────────────────────────────────────────────────────────────
// Display — i18n-keyed labels (string keys, not translated strings).
// ─────────────────────────────────────────────────────────────────────

export function statusI18nKey(status: InspectionJobStatus): string {
  return `inspection.status.${status}`;
}

export function statusFallbackLabel(status: InspectionJobStatus): string {
  switch (status) {
    case 'claimed':      return 'Claimed';
    case 'on_route':     return 'On the way';
    case 'arrived':      return 'On site';
    case 'inspecting':   return 'Inspecting';
    case 'report_ready': return 'Report submitted';
    case 'completed':    return 'Completed';
    case 'cancelled':    return 'Cancelled';
  }
}

/**
 * Stable ordinal — used by the UI to render progress dots/segments
 * in the same order regardless of locale. `cancelled` is intentionally
 * outside the normal progression and gets `-1`.
 */
export function statusOrdinal(status: InspectionJobStatus): number {
  switch (status) {
    case 'claimed':      return 0;
    case 'on_route':     return 1;
    case 'arrived':      return 2;
    case 'inspecting':   return 3;
    case 'report_ready': return 4;
    case 'completed':    return 5;
    case 'cancelled':    return -1;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Convenience view-model builder — flat shape, no methods.
// ─────────────────────────────────────────────────────────────────────

export interface InspectionJobViewModel {
  status: InspectionJobStatus;
  isTerminal: boolean;
  isFieldActive: boolean;
  awaitsInspectorAction: boolean;
  canStartRoute: boolean;
  canMarkArrived: boolean;
  canStartInspection: boolean;
  canSubmitReport: boolean;
  canCancel: boolean;
  statusI18nKey: string;
  statusFallback: string;
  statusOrdinal: number;
}

export function inspectionJobViewModel(
  job: { status: InspectionJobStatus },
): InspectionJobViewModel {
  const status = job.status;
  return {
    status,
    isTerminal:            isTerminal(status),
    isFieldActive:         isFieldActive(status),
    awaitsInspectorAction: awaitsInspectorAction(status),
    canStartRoute:         canStartRoute(status),
    canMarkArrived:        canMarkArrived(status),
    canStartInspection:    canStartInspection(status),
    canSubmitReport:       canSubmitReport(status),
    canCancel:             canCancel(status),
    statusI18nKey:         statusI18nKey(status),
    statusFallback:        statusFallbackLabel(status),
    statusOrdinal:         statusOrdinal(status),
  };
}

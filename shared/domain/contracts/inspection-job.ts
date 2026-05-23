/**
 * InspectionJob — entity contract.
 *
 * Mirrors the backend's `inspector_jobs` and `inspector_exposures`
 * collections (Sprint Phase 3 — B-lite marketplace).
 *
 * The lifecycle has two phases:
 *   1. **Exposure** — a job is offered to one or more inspectors.
 *      Each inspector sees the offer for a TTL window. Whoever claims
 *      first wins; siblings expire with reason `job_claimed_by_other`.
 *   2. **Job** — once claimed, the exposure becomes a real job with
 *      its own status progression: claimed → on_route → arrived →
 *      inspecting → report_ready → completed (or cancelled).
 *
 * We model these as two separate types because their consumer surfaces
 * are different — an inspector's "Exposures" tab and "My Jobs" tab
 * answer different questions. A unified type would force every screen
 * to handle nullable fields.
 *
 * Backend reference: `/api/inspector/exposures`, `/api/inspector/jobs`,
 *                    `/api/inspector/jobs/:id/{claim,on-route,arrived,
 *                                                start-inspection,report,cancel}`.
 */

// ─────────────────────────────────────────────────────────────────────
// Exposure — pre-claim offer
// ─────────────────────────────────────────────────────────────────────

export type ExposureStatus =
  | 'open'      // active offer, awaiting claim
  | 'expired'   // TTL elapsed or sibling claimed first
  | 'claimed';  // this exposure was claimed by THIS inspector

export type ExposureExpireReason =
  | 'ttl'
  | 'job_claimed_by_other'
  | 'job_cancelled';

export interface InspectorExposure {
  id: string;
  jobId: string;
  inspectorId: string;
  status: ExposureStatus;
  /** Score that ranked this inspector for the job (higher = better fit). */
  score: number;
  /** Why this exposure was created — e.g. `'initial'`, `'fallback'`, `'urgency_boost'`. */
  waveReason?: string;
  /** ISO-8601 — when this offer was made. */
  createdAt: string;
  /** ISO-8601 — when this offer expires (server-side TTL). */
  expiresAt: string;
  expireReason?: ExposureExpireReason | null;
  /** Snapshot of customer-facing job info shown without claim. */
  preview: {
    serviceLabel: string;
    cityLabel?: string | null;
    /** Customer's stated budget in EUR (or null for "estimate"). */
    budgetEur?: number | null;
    /** Free-text vehicle description, e.g. "BMW 3 Series 2018". */
    vehicleSummary?: string | null;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Job — post-claim work
// ─────────────────────────────────────────────────────────────────────

export type InspectionJobStatus =
  | 'claimed'       // inspector has accepted, not yet on the way
  | 'on_route'      // travelling to the location
  | 'arrived'       // at location, work not yet started
  | 'inspecting'    // physical inspection in progress
  | 'report_ready'  // inspection done, report submitted to customer
  | 'completed'     // customer acknowledged / payment settled
  | 'cancelled';    // cancelled by inspector / customer / system

export const INSPECTION_JOB_STATUSES: readonly InspectionJobStatus[] = [
  'claimed',
  'on_route',
  'arrived',
  'inspecting',
  'report_ready',
  'completed',
  'cancelled',
] as const;

export interface InspectionJob {
  id: string;
  status: InspectionJobStatus;
  inspectorId: string;
  customerId: string;
  /** Linked car_request id; the source of all preview data. */
  requestId: string;
  /** ISO-8601. */
  claimedAt: string;
  /** ISO-8601 — last status change. Used for staleness detection. */
  updatedAt: string;
  /** Vehicle / customer / pricing snapshot. Always present after claim. */
  brief: {
    vehicleSummary: string;
    serviceLabel: string;
    cityLabel: string;
    address?: string | null;
    customerName?: string | null;
    customerPhone?: string | null;
    /** Inspection fee paid to the inspector, in EUR. */
    feeEur: number;
  };
  /** Whether the inspector has uploaded a report PDF (drives 1.1B UI). */
  hasReport?: boolean;
  /** True if customer or admin cancelled — enables explanation in UI. */
  cancelReason?: string | null;
}

/**
 * Timeline event — operational confidence primitive.
 *
 * Even before realtime is wired in 1.1C, the inspector workspace shows
 * a read-only timeline of the job's history. Backend reconstructs
 * these from audit / status-change records.
 */
export interface InspectionJobTimelineEvent {
  /** ISO-8601. */
  at: string;
  /** Stable machine-readable label, e.g. `'claimed'`, `'on_route'`, `'cancelled'`. */
  kind: string;
  /** Human-friendly i18n key, e.g. `'inspection.timeline.claimed'`. */
  i18nKey: string;
  /** Optional actor description ("inspector", "customer", "system"). */
  actor?: string | null;
  /** Optional free-form note attached at the time. */
  note?: string | null;
}

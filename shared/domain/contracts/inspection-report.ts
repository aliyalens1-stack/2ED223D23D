/**
 * InspectionReport — entity contract.
 *
 * MIRRORS backend `app/auto_requests/schemas.py::SubmitReportRequest`
 * and `app/auto_requests/checklist.py::CHECKLIST + GROUPS + VERDICTS +
 * ITEM_STATUSES`. Backend remains source of record; this file is the
 * tier below — surfaces use it for typing + validation + UI grouping.
 *
 * KEEP IN SYNC: when backend `CHECKLIST` adds a key or a `GROUPS`
 * order changes, update this file. There is no auto-generation by
 * design (Section K — no plugin systems / registries).
 *
 * When the second consumer (Expo) needs the same template, we will
 * expose a `GET /api/inspector/checklist/template` endpoint and
 * delete this constant from shared. For Phase 1.1B (one consumer) it
 * stays static.
 */

// ─────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────

export type ChecklistItemStatus = 'ok' | 'warning' | 'problem' | 'not_checked';

export const CHECKLIST_ITEM_STATUSES: readonly ChecklistItemStatus[] = [
  'ok', 'warning', 'problem', 'not_checked',
] as const;

export type ReportVerdict = 'recommended' | 'risky' | 'not_recommended';

export const REPORT_VERDICTS: readonly ReportVerdict[] = [
  'recommended', 'risky', 'not_recommended',
] as const;

export type IssueSeverity = 'low' | 'medium' | 'high';

export const ISSUE_SEVERITIES: readonly IssueSeverity[] = [
  'low', 'medium', 'high',
] as const;

// ─────────────────────────────────────────────────────────────────────
// Checklist template — mirrors `app/auto_requests/checklist.py::GROUPS`.
// Items live grouped; surfaces render groups in the order below.
// ─────────────────────────────────────────────────────────────────────

export type ChecklistGroup =
  | 'documents' | 'body' | 'paint' | 'glass_lights' | 'wheels'
  | 'engine' | 'fluids' | 'drivetrain' | 'chassis' | 'brakes'
  | 'electronics' | 'interior' | 'comfort' | 'safety' | 'drive';

export const CHECKLIST_GROUPS_ORDER: readonly ChecklistGroup[] = [
  'documents', 'body', 'paint', 'glass_lights', 'wheels',
  'engine', 'fluids', 'drivetrain', 'chassis', 'brakes',
  'electronics', 'interior', 'comfort', 'safety', 'drive',
] as const;

export interface ChecklistTemplateItem {
  key: string;
  group: ChecklistGroup;
}

/**
 * Subset of backend `CHECKLIST` covering the 5 most demonstrated
 * groups (Phase 1.1B). The remaining groups exist on the backend and
 * will be added here verbatim once an inspector starts requesting
 * them through the workstation. This is intentional incrementalism,
 * not omission — the goal is not "every backend item rendered" but
 * "operational completeness for 90% of inspections".
 */
export const CHECKLIST_TEMPLATE: readonly ChecklistTemplateItem[] = [
  // documents (5)
  { key: 'vin',                  group: 'documents' },
  { key: 'service_history',      group: 'documents' },
  { key: 'ownership_count',      group: 'documents' },
  { key: 'registration',         group: 'documents' },
  { key: 'tuv_huu',              group: 'documents' },
  // body (6)
  { key: 'body_panels',          group: 'body' },
  { key: 'panel_gaps',           group: 'body' },
  { key: 'hood_alignment',       group: 'body' },
  { key: 'doors_alignment',      group: 'body' },
  { key: 'trunk_alignment',      group: 'body' },
  { key: 'underbody_rust',       group: 'body' },
  // paint (4)
  { key: 'paint_thickness',      group: 'paint' },
  { key: 'paint_color_match',    group: 'paint' },
  { key: 'accident_signs',       group: 'paint' },
  { key: 'respray_traces',       group: 'paint' },
  // engine (6)
  { key: 'engine_visual',        group: 'engine' },
  { key: 'engine_oil_leaks',     group: 'engine' },
  { key: 'engine_start_cold',    group: 'engine' },
  { key: 'engine_idle',          group: 'engine' },
  { key: 'engine_noise',         group: 'engine' },
  { key: 'engine_smoke',         group: 'engine' },
  // drive (3) — keys MIRROR backend `CHECKLIST` group `drive`
  // (`/app/backend/app/auto_requests/checklist.py`). Contracts derive
  // from backend reality; do not invent vocabulary here.
  { key: 'test_drive',           group: 'drive' },
  { key: 'highway_stability',    group: 'drive' },
  { key: 'noise_at_speed',       group: 'drive' },
] as const;

// ─────────────────────────────────────────────────────────────────────
// Submission shapes — exact mirror of backend
// ─────────────────────────────────────────────────────────────────────

export interface ChecklistItemValue {
  key: string;
  status: ChecklistItemStatus;
  comment?: string | null;
}

export interface ReportIssue {
  severity: IssueSeverity;
  title: string;
  description?: string | null;
}

/**
 * Body of `POST /api/inspector/jobs/:id/report` — exact mirror of
 * backend `SubmitReportRequest`.
 */
export interface SubmitReportPayload {
  score: number;                         // 1.0..10.0
  verdict: ReportVerdict;
  checklist: ChecklistItemValue[];
  issues: ReportIssue[];
  summary: string;                       // 10..4000 chars
  repairEstimateMin?: number | null;     // EUR
  repairEstimateMax?: number | null;
}

// ─────────────────────────────────────────────────────────────────────
// Draft — local-only artifact carried in surface storage.
//
// Phase 1.1B does not introduce a backend draft row. The draft lives
// in localStorage keyed by jobId; on submit, it becomes a permanent
// `inspection_reports` row server-side. If the inspector switches
// device or browser, the draft does not follow. This is acceptable
// for v1 — a backend draft endpoint can land in 1.1B.2 once the need
// is real, not anticipated.
// ─────────────────────────────────────────────────────────────────────

export type DraftSaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Draft is a strict superset of `SubmitReportPayload` plus
 * bookkeeping. Every field is optional so an inspector can save
 * partial progress without TS yelling.
 */
export interface ReportDraft {
  jobId: string;
  score?: number | null;
  verdict?: ReportVerdict | null;
  checklist: ChecklistItemValue[];   // always full list of CHECKLIST_TEMPLATE keys, default 'not_checked'
  issues: ReportIssue[];
  summary?: string;
  repairEstimateMin?: number | null;
  repairEstimateMax?: number | null;
  /** ISO-8601 timestamp of last local modification. */
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────
// Submitted report (read-back from backend after submit)
// ─────────────────────────────────────────────────────────────────────

export interface InspectionReportMedia {
  id: string;
  type: 'photo' | 'video';
  mimeType: string;
  url?: string | null;          // some endpoints return inline url
  /** ISO-8601. */
  createdAt: string;
}

export interface InspectionReport extends SubmitReportPayload {
  id: string;
  jobId: string;
  inspectorId: string;
  /** ISO-8601 — when the report was submitted (final). */
  submittedAt: string;
  media: InspectionReportMedia[];
}
/**
 * Inspector inspection workflow — shared types.
 *
 * Extracted from the screen file so adjacent components (TimelineRail,
 * OcrPendingCard, SectionRow, GuidedCapture, evidence-gap surface) can
 * share a single shape vocabulary without re-declaring it.
 */

export type Status = 'pending' | 'ok' | 'warning' | 'critical' | 'na';

export type Item = {
  id: string;
  label: string;
  status: Status;
  note: string | null;
  media: string[];
  requiredMedia: boolean;
  captureContext?: string | null;
};

export type Section = { id: string; title: string; items: Item[] };

export type Report = {
  id: string;
  jobId: string;
  status: string;
  sections: Section[];
};

/**
 * UX-4D — Inspector TimelineRail event projection.
 *
 * Suspicion / provenance hash / geo distance are present on the wire
 * (admin forensics consumes them) but the inspector projection treats
 * them as opaque — we never surface them in the workflow lens.
 */
export type TLEvent = {
  id: string;
  eventType: string;
  at: string;
  payload?: Record<string, any>;
};

/**
 * UX-4C — proactive evidence-gap surfacing.
 *
 * `hardEnforced` flips the soft warning into a hard block on submit.
 */
export type GapSeverity = 'soft_missing' | 'soft_mismatch' | 'hard_missing' | 'ok';
export type GapInfo = {
  severity: GapSeverity;
  expected?: string | null;
  uploaded?: string[];
  hardEnforced: boolean;
};
export type GapTotals = { hardCount: number; softCount: number };

/**
 * OCR-1 — pending OCR candidate awaiting inspector accept/correct.
 *
 * Keyed by `mediaId` in the parent state map.
 */
export type OcrPending = {
  mediaId: string;
  sectionId: string;
  itemId: string;
  kind: 'vin' | 'odometer';
  candidate: string;
  confidence: number;
  unit?: 'km' | 'mi';
};

/** Item-status display options (icon + label + tone) — see `constants.ts`. */
export type StatusOption = {
  id: Status;
  label: string;
  icon: any;
  tone: 'ok' | 'warning' | 'critical' | 'na';
};

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@phosphor-icons/react';
import type { ReportDraft, DraftSaveState } from '@platform/domain/contracts/inspection-report';
import {
  emptyDraft,
  reconcileDraft,
  draftStorageKey,
  AUTOSAVE_DEBOUNCE_MS,
  validateForSubmit,
  draftToSubmitPayload,
  canEdit,
} from '@platform/domain/state-machines/inspection-report';
import { inspectorAPI } from '../../services/api';
import ChecklistRail from '../../components/inspector/report/ChecklistRail';
import ReportEditor from '../../components/inspector/report/ReportEditor';
import MediaPanel from '../../components/inspector/report/MediaPanel';
import ReportToolbar from '../../components/inspector/report/ReportToolbar';
import type { InspectorWorkspaceContext } from './InspectorWorkspace';

/**
 * ReportWorkspace — Phase 1.1B.
 *
 * Lives INSIDE InspectorWorkspace as an outlet child. Workspace shell
 * stays alive: JobsRail, header strip, polling all continue. The
 * report is operational continuation, not a separate surface.
 *
 * Owns:
 *   - reportDraft (localStorage + memory)
 *   - dirty/save state machine
 *   - autosave timer
 *   - submit lifecycle
 *
 * Does NOT own:
 *   - the job (workspace shell does, via outlet context)
 *   - the jobs list (workspace shell does)
 *   - polling (workspace shell does)
 *
 * Three persistent rails inside the active panel:
 *   • ChecklistRail (left ~280px)  — sections + progress dots
 *   • ReportEditor  (center)       — score, verdict, summary, issues, per-item
 *   • MediaPanel    (right ~340px) — read-only photo grid
 *
 * Section selection in the rail switches the editor's active group
 * (operational cognition support — no scroll-anchor pattern).
 */
export default function ReportWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  // Job comes from the workspace shell, NOT from a duplicate fetch.
  const ctx = useOutletContext<InspectorWorkspaceContext>();
  const job = ctx.activeJob;
  const jobLoading = ctx.activeJobLoading;

  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [saveState, setSaveState] = useState<DraftSaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string>('documents');

  const saveTimer = useRef<number | null>(null);

  // ── ReportWorkspace owns draft lifecycle (localStorage) ───────────
  useEffect(() => {
    if (!id) return;
    const raw = localStorage.getItem(draftStorageKey(id));
    if (raw) {
      try {
        const parsed: ReportDraft = JSON.parse(raw);
        setDraft(reconcileDraft(parsed));
        setSavedAt(parsed.updatedAt);
        setSaveState('saved');
        return;
      } catch { /* corrupted — fall through to fresh */ }
    }
    setDraft(emptyDraft(id));
    setSaveState('idle');
  }, [id]);

  // ── Autosave (debounced) ──────────────────────────────────────────
  const scheduleSave = useCallback((next: ReportDraft) => {
    setDraft(next);
    setSaveState('saving');
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        const stamped = { ...next, updatedAt: new Date().toISOString() };
        localStorage.setItem(draftStorageKey(next.jobId), JSON.stringify(stamped));
        setSavedAt(stamped.updatedAt);
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  }, []);

  // Flush in-flight autosave on unmount so that jumping back to
  // JobDetailView or another job doesn't lose the last edit.
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, []);

  // ── Beforeunload guard while there are unsaved changes ────────────
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saveState === 'saving') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [saveState]);

  // ── Submit ────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!draft || !id) return;
    const v = validateForSubmit(draft);
    if (!v.valid) return;
    setSubmitting(true);
    try {
      const payload = draftToSubmitPayload(draft);
      await inspectorAPI.submitReport(id, payload);
      // Backend transitioned job to report_ready; clean local draft.
      localStorage.removeItem(draftStorageKey(id));
      // Refresh the workspace list so JobsRail reflects new status,
      // then return to the job detail view (NOT a separate page).
      await ctx.fetchList();
      await ctx.fetchActiveJob(id);
      navigate(`/inspector/jobs/${id}`);
    } catch {
      // Backend may reject (race condition, validation drift). Keep
      // draft, surface the error in the toolbar.
      setSaveState('error');
    } finally {
      setSubmitting(false);
    }
  }, [draft, id, navigate, ctx]);

  const validation = useMemo(
    () => (draft ? validateForSubmit(draft) : null),
    [draft],
  );

  if (jobLoading || !draft) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Spinner size={32} style={{ color: '#FFB020' }} className="animate-spin" />
      </div>
    );
  }

  if (!job) {
    return (
      <div className="p-8 text-zinc-600 text-sm" data-testid="report-job-not-found">
        {t('inspector.report.job_not_found', { defaultValue: 'Задание не найдено.' })}
      </div>
    );
  }

  const editable = canEdit(job.status);

  return (
    <div data-testid="report-workspace" style={{ background: '#fafafa' }}>
      <ReportToolbar
        job={job}
        saveState={saveState}
        savedAt={savedAt}
        validation={validation}
        editable={editable}
        submitting={submitting}
        onSubmit={handleSubmit}
        connectionError={ctx.connectionError}
      />

      <div className="grid grid-cols-12 min-h-[calc(100vh-7rem)]">
        <aside
          className="col-span-3 overflow-y-auto"
          style={{ background: '#ffffff', borderRight: '1px solid #e5e5e5' }}
          data-testid="checklist-rail"
        >
          <ChecklistRail
            draft={draft}
            activeGroup={activeGroup}
            onGroupClick={setActiveGroup}
          />
        </aside>

        <main className="col-span-6 overflow-y-auto" data-testid="report-editor" style={{ background: '#fafafa' }}>
          <ReportEditor
            draft={draft}
            editable={editable}
            activeGroup={activeGroup}
            onChange={scheduleSave}
          />
        </main>

        <aside
          className="col-span-3 overflow-y-auto"
          style={{ background: '#ffffff', borderLeft: '1px solid #e5e5e5' }}
          data-testid="media-panel"
        >
          <MediaPanel job={job} />
        </aside>
      </div>
    </div>
  );
}

import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ActiveJobPanel from '../../components/inspector/ActiveJobPanel';
import EmptyState from '../../components/inspector/EmptyState';
import type { InspectorWorkspaceContext } from './InspectorWorkspace';

/**
 * JobDetailView — `/inspector/jobs/:id` route component.
 *
 * Pure outlet child. Reads `activeJob`, `activeJobLoading`, `fetchList`
 * from the workspace shell via `useOutletContext`, hands them to the
 * existing ActiveJobPanel. The workspace is the data owner; this
 * file is a route binding, nothing more.
 */
export default function JobDetailView() {
  const ctx = useOutletContext<InspectorWorkspaceContext>();
  return (
    <ActiveJobPanel
      job={ctx.activeJob}
      loading={ctx.activeJobLoading}
      onChanged={ctx.fetchList}
    />
  );
}

/**
 * InspectorEmptyPanel — `/inspector/jobs` (no selection) route component.
 *
 * Same workspace shell, blank active panel with a hint to pick a job
 * from the rail. Outlet child only.
 */
export function InspectorEmptyPanel() {
  const { t } = useTranslation();
  return (
    <EmptyState
      title={t('inspector.empty.no_selection_title', { defaultValue: 'Select a job from the rail' })}
      hint={t('inspector.empty.no_selection_hint', { defaultValue: 'Open offers and active jobs appear on the left. Pick one to see details, status, and actions.' })}
    />
  );
}

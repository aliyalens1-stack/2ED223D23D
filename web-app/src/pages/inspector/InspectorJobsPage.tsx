/**
 * /inspector/jobs — Jobs page внутри cabinet shell.
 *
 * Re-uses the existing `InspectorWorkspace` body (JobsRail + detail Outlet),
 * but без своего topbar — общий header теперь приходит из
 * `InspectorCabinetShell`. Это гарантирует scope discipline: ТЗ требовало
 * «текущий workspace оставить, но встроить в новый shell», а не переписать
 * рабочую логику с нуля.
 */
import InspectorWorkspace from './InspectorWorkspace';

export default function InspectorJobsPage() {
  return <InspectorWorkspace embedded />;
}

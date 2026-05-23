import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Wrench, ArrowsClockwise, WifiX } from '@phosphor-icons/react';
import type {
  InspectionJob,
  InspectorExposure,
} from '@platform/domain/contracts/inspection-job';
import { useAuthStore } from '../../stores/authStore';
import { inspectorAPI } from '../../services/api';
import JobsRail from '../../components/inspector/JobsRail';
import InspectorUserMenu from '../../components/inspector/InspectorUserMenu';

/**
 * Backend → contract normalizer.
 *
 * The /api/inspector/jobs/* endpoints return a FLAT DTO
 * (id, city, brand, model, budget, status, createdAt, ...) that
 * predates the InspectionJob contract used by inspector UI components.
 *
 * Rather than refactor every component to handle two shapes, we
 * normalise once here. If a payload already carries `brief`, we pass
 * it through (forward-compatible with a future server-side migration).
 */
function normalizeJob(raw: any): InspectionJob | null {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  if (raw.brief && typeof raw.brief === 'object') return raw as InspectionJob;

  const brand = raw.brand ?? '';
  const model = raw.model ?? '';
  const vehicleSummary = [brand, model].filter(Boolean).join(' ').trim() || 'Vehicle';

  return {
    id: String(raw.id),
    status: (raw.status ?? 'claimed') as InspectionJob['status'],
    inspectorId: raw.inspectorId ?? '',
    customerId: raw.customerId ?? '',
    requestId: raw.requestId ?? '',
    claimedAt: raw.claimedAt ?? raw.createdAt ?? new Date().toISOString(),
    updatedAt:
      raw.updatedAt ??
      raw.completedAt ??
      raw.canceledAt ??
      raw.arrivedAt ??
      raw.onRouteAt ??
      raw.claimedAt ??
      raw.createdAt ??
      new Date().toISOString(),
    brief: {
      vehicleSummary,
      serviceLabel: raw.serviceLabel ?? 'Предпокупочная проверка',
      cityLabel: raw.cityLabel ?? raw.city ?? '—',
      address: raw.address ?? null,
      customerName: raw.customerName ?? null,
      customerPhone: raw.customerPhone ?? null,
      feeEur: Number(raw.feeEur ?? raw.budget ?? 0),
    },
    hasReport: Boolean(raw.hasReport ?? raw.reportId),
    cancelReason: raw.cancelReason ?? null,
  };
}

function normalizeExposure(raw: any): InspectorExposure | null {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  if (raw.preview && typeof raw.preview === 'object') return raw as InspectorExposure;

  const brand = raw.brand ?? '';
  const model = raw.model ?? '';
  const vehicleSummary = [brand, model].filter(Boolean).join(' ').trim() || null;

  return {
    id: String(raw.id),
    jobId: raw.jobId ?? raw.job_id ?? '',
    inspectorId: raw.inspectorId ?? raw.inspector_id ?? '',
    status: (raw.status ?? 'open') as InspectorExposure['status'],
    requestId: raw.requestId ?? '',
    createdAt: raw.createdAt ?? raw.created_at ?? new Date().toISOString(),
    expiresAt: raw.expiresAt ?? raw.expires_at ?? new Date().toISOString(),
    score: Number(raw.score ?? 0),
    preview: {
      serviceLabel: raw.serviceLabel ?? raw.service_label ?? 'Inspection',
      cityLabel: raw.cityLabel ?? raw.city ?? null,
      budgetEur: raw.budgetEur != null ? Number(raw.budgetEur) : raw.budget != null ? Number(raw.budget) : null,
      vehicleSummary,
    },
  } as InspectorExposure;
}

/**
 * InspectorWorkspace — light theme shell.
 *
 * Workspace-first shell. Owns the entire data lifecycle: jobs list,
 * active job detail, refresh cadence, connection state. Exposes that
 * via `<Outlet context>` to nested route children.
 */
export interface InspectorWorkspaceContext {
  activeJob: InspectionJob | null;
  activeJobLoading: boolean;
  fetchList: () => Promise<void>;
  fetchActiveJob: (id: string) => Promise<void>;
  connectionError: boolean;
}

export default function InspectorWorkspace({ embedded = false }: { embedded?: boolean } = {}) {
  const { id: activeId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { activeAccount } = useAuthStore();

  const [jobs, setJobs] = useState<InspectionJob[]>([]);
  const [exposures, setExposures] = useState<InspectorExposure[]>([]);
  const [activeJob, setActiveJob] = useState<InspectionJob | null>(null);
  const [activeJobLoading, setActiveJobLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [connectionError, setConnectionError] = useState(false);

  const inspectorId = activeAccount?.id ?? null;

  const fetchList = useCallback(async () => {
    try {
      const [jobsRes, expRes] = await Promise.all([
        inspectorAPI.getMyJobs(),
        inspectorAPI.getExposures(),
      ]);
      const rawJobs: any[] = jobsRes.data?.jobs ?? [];
      const rawExposures: any[] = expRes.data?.exposures ?? [];
      setJobs(rawJobs.map(normalizeJob).filter((j): j is InspectionJob => j !== null));
      setExposures(rawExposures.map(normalizeExposure).filter((e): e is InspectorExposure => e !== null));
      setConnectionError(false);
    } catch {
      setConnectionError(true);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);

  const fetchActiveJob = useCallback(async (id: string) => {
    setActiveJobLoading(true);
    try {
      const { data } = await inspectorAPI.getJob(id);
      const raw = data?.job ?? data ?? null;
      setActiveJob(normalizeJob(raw));
    } catch {
      setActiveJob(null);
    } finally {
      setActiveJobLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeId) { setActiveJob(null); return; }
    const fromList = jobs.find(j => j.id === activeId) ?? null;
    if (fromList) setActiveJob(fromList);
    fetchActiveJob(activeId);
  }, [activeId, fetchActiveJob, jobs]);

  useEffect(() => {
    const id = setInterval(fetchList, 30_000);
    return () => clearInterval(id);
  }, [fetchList]);

  const handleClaim = useCallback(async (exposureId: string) => {
    if (!inspectorId) return;
    try {
      const { data } = await inspectorAPI.claimExposure(exposureId, inspectorId);
      await fetchList();
      const newJobId = data?.jobId ?? data?.job?.id;
      if (newJobId) navigate(`/inspector/jobs/${newJobId}`);
    } catch { /* connection error surfaces via fetchList */ }
  }, [inspectorId, fetchList, navigate]);

  const handleSelectJob = useCallback((id: string) => {
    navigate(`/inspector/jobs/${id}`);
  }, [navigate]);

  const summary = useMemo(() => {
    const open = exposures.filter(e => e.status === 'open').length;
    const active = jobs.filter(j => j.status !== 'completed' && j.status !== 'cancelled').length;
    return { open, active, total: jobs.length };
  }, [jobs, exposures]);

  const ctx: InspectorWorkspaceContext = {
    activeJob,
    activeJobLoading,
    fetchList,
    fetchActiveJob,
    connectionError,
  };

  return (
    <div className={embedded ? '' : 'min-h-screen'} style={{ background: '#fafafa', color: '#0a0a0a' }} data-testid="inspector-workspace">
      {/* Workspace header — hidden in embedded mode (cabinet shell owns the topbar). */}
      {!embedded && (
      <div
        className="sticky top-0 z-30 backdrop-blur"
        style={{ background: 'rgba(255,255,255,0.85)', borderBottom: '1px solid #ececec' }}
      >
        <div className="max-w-[1600px] mx-auto px-6 h-14 flex items-center gap-6">
          <Link
            to="/inspector/jobs"
            className="flex items-center gap-2 text-sm font-bold hover:opacity-80 transition"
            style={{ color: '#b45309' }}
          >
            <Wrench size={18} weight="fill" />
            <span>{t('inspector.workspace.title', { defaultValue: 'Кабинет инспектора' })}</span>
          </Link>
          <div className="text-xs text-zinc-500 flex items-center gap-4">
            <span data-testid="summary-open">
              <b className="text-zinc-900 tabular-nums">{summary.open}</b>{' '}
              {t('inspector.workspace.summary_open', { defaultValue: 'предложений' })}
            </span>
            <span data-testid="summary-active">
              <b className="text-zinc-900 tabular-nums">{summary.active}</b>{' '}
              {t('inspector.workspace.summary_active', { defaultValue: 'активных' })}
            </span>
            <span data-testid="summary-total">
              <b className="text-zinc-900 tabular-nums">{summary.total}</b>{' '}
              {t('inspector.workspace.summary_total', { defaultValue: 'всего' })}
            </span>
          </div>
          <div className="flex-1" />
          {connectionError && (
            <span
              className="flex items-center gap-1.5 text-[11px] font-bold px-2 py-1 rounded"
              style={{ background: '#fef3c7', color: '#b45309' }}
              data-testid="connection-warning"
            >
              <WifiX size={14} /> {t('inspector.workspace.disconnected', { defaultValue: 'Переподключение…' })}
            </span>
          )}
          <button
            onClick={fetchList}
            className="text-xs text-zinc-600 hover:text-zinc-900 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-zinc-100 transition"
            data-testid="refresh-btn"
          >
            <ArrowsClockwise size={14} /> {t('inspector.workspace.refresh', { defaultValue: 'Обновить' })}
          </button>
          <InspectorUserMenu />
        </div>
      </div>
      )}

      {/* Split-pane workspace. */}
      <div className={`${embedded ? '' : 'max-w-[1600px] mx-auto'} grid grid-cols-12 gap-0 min-h-[calc(100vh-3.5rem)]`}>
        <aside
          className="col-span-4 xl:col-span-3 overflow-y-auto"
          style={{ background: '#ffffff', borderRight: '1px solid #ececec' }}
          data-testid="jobs-rail"
        >
          <JobsRail
            jobs={jobs}
            exposures={exposures}
            activeId={activeId ?? null}
            loading={listLoading}
            onSelectJob={handleSelectJob}
            onClaimExposure={handleClaim}
          />
        </aside>
        <main className="col-span-8 xl:col-span-9 overflow-y-auto" data-testid="active-job-pane">
          <Outlet context={ctx} />
        </main>
      </div>
    </div>
  );
}

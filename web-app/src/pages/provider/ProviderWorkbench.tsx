/**
 * Provider Workbench v1 — provider-facing operational projection.
 *
 * Doctrine (see /app/memory/PRD.md):
 *   "Provider Workbench is not a workflow engine. It is a provider-facing
 *    operational projection over existing truths."
 *
 * Surface rules:
 *   - This file MUST NOT branch on raw booking.status / job.status / report.status.
 *     The only field driving UI is `state` (ProviderWorkItemState).
 *   - The CTA on each card is `primaryAction` from the API. UI does not
 *     compose verbs from any other data.
 *   - Legacy /provider/inbox and /provider/current-job remain intact —
 *     this page is a parallel proving ground, not a replacement.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import { realtime } from '../../lib/socket';

// Inline type mirrors shared/domain/contracts/provider-work-item.ts.
// Web-app does not yet consume the shared/ types directly; once a 2nd
// consumer (mobile) starts, we wire the import path.
type State =
  | 'needs_response'
  | 'scheduled'
  | 'en_route'
  | 'on_site'
  | 'in_progress'
  | 'report_required'
  | 'awaiting_customer'
  | 'awaiting_review'
  | 'awaiting_payout'
  | 'completed'
  | 'blocked';

interface WorkItem {
  id: string;
  kind: 'booking' | 'inspection';
  state: State;
  primaryAction?: { verb: string; label: string; confirmationRequired: boolean };
  blockedReason?: { code: string; message: string; contactWho: 'customer' | 'support' | 'admin' };
  scheduledFor?: string;
  enteredCurrentStateAt: string;
  expectedActionBy?: string;
  priceShown: { amount: number; currency: string; surge?: number };
  customer: { name: string; address?: string; distanceKm?: number };
  serviceLabel: string;
}

// Provider-facing labels per state. NOTE: these do not echo backend taxonomy.
const STATE_GROUPS: { state: State; label: string; helper: string }[] = [
  { state: 'needs_response',    label: 'Ждут моего ответа',          helper: 'Принять или отклонить' },
  { state: 'blocked',           label: 'Заблокировано',              helper: 'Нужен контакт, чтобы продолжить' },
  { state: 'in_progress',       label: 'Сейчас в работе',            helper: 'Активные заказы' },
  { state: 'on_site',           label: 'На месте',                   helper: 'Вы прибыли — пора начать' },
  { state: 'en_route',          label: 'В пути',                     helper: 'Вы в дороге к клиенту' },
  { state: 'report_required',   label: 'Нужен отчёт',                helper: 'Загрузить отчёт по осмотру' },
  { state: 'awaiting_customer', label: 'Ждём клиента',               helper: 'Клиент должен подтвердить' },
  { state: 'awaiting_review',   label: 'На проверке',                helper: 'Платформа проверяет — ожидаем' },
  { state: 'scheduled',         label: 'Запланировано',              helper: 'Принято, пока без действий' },
  { state: 'awaiting_payout',   label: 'Ждём выплату',               helper: 'Деньги в обработке' },
  { state: 'completed',         label: 'Завершено',                  helper: 'Закрыто за последние 24ч' },
];

const STATE_COLOR: Record<State, string> = {
  needs_response:    '#f59e0b',
  blocked:           '#ef4444',
  in_progress:       '#3b82f6',
  on_site:           '#0ea5e9',
  en_route:          '#06b6d4',
  report_required:   '#8b5cf6',
  awaiting_customer: '#a855f7',
  awaiting_review:   '#a855f7',
  scheduled:         '#64748b',
  awaiting_payout:   '#10b981',
  completed:         '#94a3b8',
};

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}s назад`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн назад`;
}

function formatCountdown(iso?: string): string | null {
  if (!iso) return null;
  const remain = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
  if (remain <= 0) return 'просрочено';
  const m = Math.floor(remain / 60);
  const s = remain % 60;
  if (m === 0) return `${s}s`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatPrice(p: WorkItem['priceShown']): string {
  return `${p.amount} ${p.currency}${p.surge ? ` · x${p.surge.toFixed(2)}` : ''}`;
}

const CONTACT_LABEL: Record<NonNullable<WorkItem['blockedReason']>['contactWho'], string> = {
  customer: 'Связаться с клиентом',
  support:  'Написать в поддержку',
  admin:    'Связаться с админом',
};

interface ConfirmDialogState {
  itemId: string;
  verb: string;
  label: string;
  serviceLabel: string;
}

export default function ProviderWorkbench() {
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [viewer, setViewer] = useState<{ displayName: string; kind: string; organizationName?: string | null; slug?: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [tick, setTick] = useState(0); // forces relative-time recompute
  const mountedRef = useRef(true);

  const fetchItems = useCallback(async () => {
    try {
      const { data } = await api.get<{ items: WorkItem[]; viewer?: { displayName: string; kind: string; organizationName?: string | null; slug?: string | null } }>('/provider/work-items');
      if (mountedRef.current) {
        setItems(data.items || []);
        setViewer(data.viewer || null);
        setError(null);
      }
    } catch (e: any) {
      if (mountedRef.current) {
        setError(e?.response?.data?.message || 'Не удалось загрузить рабочий стол');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchItems();
    realtime.connect();

    // Single canonical channel: backend emits the projected item.
    const off = realtime.on('provider:work_item:updated', (p: any) => {
      if (!p) return;
      if (p.removed && p.id) {
        setItems((prev) => prev.filter((x) => x.id !== p.id));
        return;
      }
      const incoming: WorkItem | undefined = p.item;
      if (!incoming) return;
      setItems((prev) => {
        const idx = prev.findIndex((x) => x.id === incoming.id);
        if (idx === -1) return [incoming, ...prev];
        const next = prev.slice();
        next[idx] = incoming;
        return next;
      });
    });

    // Legacy events still fire from the underlying transitions; we treat
    // them as a hint to re-pull the projection (cheap O(N) on the server).
    const offNew = realtime.on('provider:new_request', () => fetchItems());
    const offExp = realtime.on('request:expired', () => fetchItems());

    const interval = setInterval(() => setTick((t) => t + 1), 1000);

    return () => {
      mountedRef.current = false;
      off();
      offNew();
      offExp();
      clearInterval(interval);
    };
  }, [fetchItems]);

  const grouped = useMemo(() => {
    const m = new Map<State, WorkItem[]>();
    for (const it of items) {
      const list = m.get(it.state) || [];
      list.push(it);
      m.set(it.state, list);
    }
    return m;
  }, [items, tick]); // tick is intentionally a dep so relative time refreshes

  const callAction = useCallback(async (item: WorkItem, verb: string) => {
    // submit_report routes to the legacy inspector form.
    if (verb === 'submit_report' && item.kind === 'inspection') {
      const rawId = item.id.replace(/^ij_/, '');
      navigate(`/inspector/jobs/${rawId}/report`);
      return;
    }

    setBusyId(item.id);
    try {
      // Sprint: Provider Dispatch Hardening + Action Idempotency.
      // Identical contract to the mobile workbench: same itemId + verb in the
      // same epoch-minute window produces the same key, so the backend
      // short-circuits duplicates without re-firing side-effects.
      const idemKey = `wb_${item.id}_${verb}_${Math.floor(Date.now() / 60000)}`;
      const { data } = await api.post<{ item?: WorkItem; removed?: boolean; id?: string }>(
        `/provider/work-items/${encodeURIComponent(item.id)}/action`,
        { verb },
        { headers: { 'Idempotency-Key': idemKey } },
      );
      if (data.removed) {
        setItems((prev) => prev.filter((x) => x.id !== item.id));
      } else if (data.item) {
        setItems((prev) => {
          const idx = prev.findIndex((x) => x.id === item.id);
          if (idx === -1) return [data.item as WorkItem, ...prev];
          const next = prev.slice();
          next[idx] = data.item as WorkItem;
          return next;
        });
      }
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Действие не выполнено');
    } finally {
      setBusyId(null);
    }
  }, [navigate]);

  const handlePrimary = useCallback((item: WorkItem) => {
    const action = item.primaryAction;
    if (!action) return;
    if (action.confirmationRequired) {
      setConfirmDialog({
        itemId: item.id,
        verb: action.verb,
        label: action.label,
        serviceLabel: item.serviceLabel,
      });
      return;
    }
    callAction(item, action.verb);
  }, [callAction]);

  const handleReject = useCallback((item: WorkItem) => {
    callAction(item, 'reject');
  }, [callAction]);

  const totals = useMemo(() => ({
    needsResponse: items.filter((i) => i.state === 'needs_response').length,
    inProgress:    items.filter((i) => i.state === 'in_progress' || i.state === 'on_site' || i.state === 'en_route').length,
    blocked:       items.filter((i) => i.state === 'blocked').length,
  }), [items]);

  return (
    <div data-testid="provider-workbench" style={styles.page}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Workbench</h1>
          <div style={styles.subtitle}>
            Что от меня сейчас требуется — и почему.
          </div>
          {viewer && (
            <div data-testid="workbench-persona" style={styles.personaBar}>
              <span style={styles.personaLabel}>Вы работаете как</span>
              <span style={styles.personaName}>
                {viewer.displayName}
                {viewer.kind ? ` · ${viewer.kind === 'inspector' ? 'Inspector' : viewer.kind === 'service_provider' ? 'Service Provider' : viewer.kind}` : ''}
              </span>
              {viewer.organizationName ? (
                <span style={styles.personaOrg}>от имени · {viewer.organizationName}</span>
              ) : null}
            </div>
          )}
        </div>
        <div style={styles.kpiRow}>
          <div style={styles.kpi}>
            <div style={styles.kpiNum} data-testid="workbench-kpi-needs">{totals.needsResponse}</div>
            <div style={styles.kpiLabel}>ждут ответа</div>
          </div>
          <div style={styles.kpi}>
            <div style={styles.kpiNum} data-testid="workbench-kpi-progress">{totals.inProgress}</div>
            <div style={styles.kpiLabel}>в работе</div>
          </div>
          <div style={styles.kpi}>
            <div style={{ ...styles.kpiNum, color: totals.blocked > 0 ? '#ef4444' : undefined }} data-testid="workbench-kpi-blocked">
              {totals.blocked}
            </div>
            <div style={styles.kpiLabel}>заблокировано</div>
          </div>
        </div>
      </header>

      {loading && <div style={styles.empty}>Загружаем рабочий стол…</div>}
      {error && <div style={{ ...styles.empty, color: '#ef4444' }} data-testid="workbench-error">{error}</div>}

      {!loading && !error && items.length === 0 && (
        <div style={styles.empty} data-testid="workbench-empty">
          Сейчас нет активных заказов и предложений. Когда что-то появится — увидите здесь.
        </div>
      )}

      {STATE_GROUPS.map(({ state, label, helper }) => {
        const groupItems = grouped.get(state) || [];
        if (groupItems.length === 0) return null;
        return (
          <section key={state} style={styles.group} data-testid={`workbench-group-${state}`}>
            <div style={styles.groupHeader}>
              <span style={{ ...styles.dot, background: STATE_COLOR[state] }} />
              <h2 style={styles.groupTitle}>{label}</h2>
              <span style={styles.groupCount}>{groupItems.length}</span>
              <span style={styles.groupHelper}>{helper}</span>
            </div>
            <div style={styles.cards}>
              {groupItems.map((it) => (
                <WorkItemCard
                  key={it.id}
                  item={it}
                  busy={busyId === it.id}
                  onPrimary={() => handlePrimary(it)}
                  onReject={() => handleReject(it)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {confirmDialog && (
        <ConfirmDialog
          dialog={confirmDialog}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={() => {
            const item = items.find((x) => x.id === confirmDialog.itemId);
            setConfirmDialog(null);
            if (item) callAction(item, confirmDialog.verb);
          }}
        />
      )}
    </div>
  );
}

interface CardProps {
  item: WorkItem;
  busy: boolean;
  onPrimary: () => void;
  onReject: () => void;
}

function WorkItemCard({ item, busy, onPrimary, onReject }: CardProps) {
  const isOffer = item.state === 'needs_response';
  const countdown = formatCountdown(item.expectedActionBy);
  const overdue = countdown === 'просрочено';

  return (
    <div
      style={{
        ...styles.card,
        ...(overdue ? styles.cardOverdue : {}),
      }}
      data-testid={`workitem-${item.id}`}
    >
      <div style={styles.cardTop}>
        <span style={styles.kindPill}>{item.kind === 'inspection' ? 'Осмотр' : 'Сервис'}</span>
        <span style={styles.cardTime}>{formatRelative(item.enteredCurrentStateAt)}</span>
      </div>

      <div style={styles.cardTitle}>{item.serviceLabel}</div>

      <div style={styles.cardCustomer}>
        {item.customer.name}
        {item.customer.address && <span style={styles.cardAddress}> · {item.customer.address}</span>}
        {item.customer.distanceKm != null && <span style={styles.cardAddress}> · {item.customer.distanceKm.toFixed(1)} km</span>}
      </div>

      <div style={styles.cardMetaRow}>
        <span style={styles.cardPrice}>{formatPrice(item.priceShown)}</span>
        {countdown && (
          <span style={{ ...styles.cardCountdown, color: overdue ? '#ef4444' : '#f59e0b' }}>
            {overdue ? '⚠ просрочено' : `⏱ ${countdown}`}
          </span>
        )}
      </div>

      {item.blockedReason && (
        <div style={styles.blockedBox} data-testid={`workitem-blocked-${item.id}`}>
          <div style={styles.blockedTitle}>Что мешает:</div>
          <div style={styles.blockedMessage}>{item.blockedReason.message}</div>
          <button type="button" style={styles.blockedButton}>
            {CONTACT_LABEL[item.blockedReason.contactWho]}
          </button>
        </div>
      )}

      {item.primaryAction && (
        <div style={styles.actions}>
          <button
            type="button"
            disabled={busy}
            onClick={onPrimary}
            style={{ ...styles.btnPrimary, opacity: busy ? 0.6 : 1 }}
            data-testid={`workitem-action-${item.primaryAction.verb}-${item.id}`}
          >
            {busy ? 'Выполняем…' : item.primaryAction.label}
          </button>
          {isOffer && (
            <button
              type="button"
              disabled={busy}
              onClick={onReject}
              style={styles.btnSecondary}
              data-testid={`workitem-action-reject-${item.id}`}
            >
              Отклонить
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface ConfirmDialogProps {
  dialog: ConfirmDialogState;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDialog({ dialog, onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <div style={styles.dialogBackdrop}>
      <div style={styles.dialog} data-testid="workbench-confirm-dialog">
        <div style={styles.dialogTitle}>Подтвердить действие?</div>
        <div style={styles.dialogBody}>
          <strong>{dialog.label}</strong>
          <div style={{ marginTop: 4, color: '#64748b' }}>{dialog.serviceLabel}</div>
        </div>
        <div style={styles.dialogActions}>
          <button type="button" style={styles.btnSecondary} onClick={onCancel} data-testid="workbench-confirm-cancel">
            Отмена
          </button>
          <button type="button" style={styles.btnPrimary} onClick={onConfirm} data-testid="workbench-confirm-ok">
            Подтвердить
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: { [k: string]: React.CSSProperties } = {
  page:        { maxWidth: 1100, margin: '0 auto', padding: '24px 20px 80px' },
  header:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 16 },
  title:       { fontSize: 28, fontWeight: 700, margin: 0 },
  subtitle:    { color: '#64748b', marginTop: 6, fontSize: 14 },
  // B.2 — Persona narrative bar
  personaBar:  { marginTop: 12, padding: '8px 12px', backgroundColor: '#f1f5f9', borderRadius: 8, borderLeft: '3px solid #1d4ed8', display: 'flex', flexDirection: 'column' as const, gap: 2 },
  personaLabel:{ fontSize: 11, color: '#64748b', textTransform: 'uppercase' as const, letterSpacing: 0.5, fontWeight: 600 },
  personaName: { fontSize: 14, color: '#0f172a', fontWeight: 700 },
  personaOrg:  { fontSize: 12, color: '#475569' },
  kpiRow:      { display: 'flex', gap: 16 },
  kpi:         { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: '12px 18px', minWidth: 96, textAlign: 'center' },
  kpiNum:      { fontSize: 22, fontWeight: 700 },
  kpiLabel:    { fontSize: 12, color: '#64748b', marginTop: 2 },
  empty:       { textAlign: 'center', padding: 48, color: '#94a3b8', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 12 },
  group:       { marginBottom: 28 },
  groupHeader: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  dot:         { width: 10, height: 10, borderRadius: '50%', display: 'inline-block' },
  groupTitle:  { fontSize: 16, fontWeight: 600, margin: 0 },
  groupCount:  { background: '#e2e8f0', color: '#475569', borderRadius: 8, padding: '2px 8px', fontSize: 12, fontWeight: 600 },
  groupHelper: { color: '#94a3b8', fontSize: 12, marginLeft: 8 },
  cards:       { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 },
  card:        { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' },
  cardOverdue: { borderColor: '#fca5a5', boxShadow: '0 0 0 2px rgba(239,68,68,0.08)' },
  cardTop:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  kindPill:    { background: '#eff6ff', color: '#1d4ed8', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 },
  cardTime:    { fontSize: 12, color: '#94a3b8' },
  cardTitle:   { fontSize: 16, fontWeight: 600, marginBottom: 4 },
  cardCustomer:{ fontSize: 14, color: '#475569', marginBottom: 8 },
  cardAddress: { color: '#94a3b8' },
  cardMetaRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  cardPrice:   { fontSize: 15, fontWeight: 600, color: '#0f172a' },
  cardCountdown:{ fontSize: 13, fontWeight: 600 },
  blockedBox:  { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 10, marginBottom: 10 },
  blockedTitle:{ fontSize: 12, fontWeight: 700, color: '#991b1b', marginBottom: 2 },
  blockedMessage:{ fontSize: 13, color: '#7f1d1d', marginBottom: 8 },
  blockedButton:{ background: '#fff', border: '1px solid #fca5a5', color: '#991b1b', padding: '6px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
  actions:     { display: 'flex', gap: 8 },
  btnPrimary:  { flex: 1, background: '#1d4ed8', color: '#fff', border: 'none', padding: '10px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  btnSecondary:{ flex: 1, background: '#fff', color: '#475569', border: '1px solid #cbd5e1', padding: '10px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  dialogBackdrop:{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  dialog:      { background: '#fff', borderRadius: 12, padding: 20, minWidth: 320, maxWidth: 420, boxShadow: '0 10px 40px rgba(0,0,0,0.15)' },
  dialogTitle: { fontSize: 18, fontWeight: 700, marginBottom: 12 },
  dialogBody:  { marginBottom: 16, fontSize: 15 },
  dialogActions:{ display: 'flex', gap: 8 },
};

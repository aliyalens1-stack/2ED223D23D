/**
 * Provider Earnings — Phase 3.1 read-only clarity surface.
 *
 * Doctrine (see /app/memory/PRD.md):
 *   "What does provider believe about money?"
 *   work completed ≠ client paid ≠ provider earned ≠ provider paid out
 *
 * Surface rules:
 *   - This file MUST NOT branch on raw payment.status / charge fields.
 *     The only field driving UI is `state` (ProviderEarningsItemState).
 *   - There is NO payout button. NO mutation UI. Read-only.
 *   - Currencies are NEVER summed across. Each currency is a separate row.
 *   - Legacy /provider/earnings (random.randint) is left intact at its old
 *     route — this page lives at /provider/earnings-clarity as a parallel
 *     proving ground.
 */
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import api from '../../services/api';

// Inline shape mirrors shared/domain/contracts/provider-earnings-item.ts.
type State =
  | 'pending'
  | 'payable'
  | 'processing'
  | 'paid_out'
  | 'disputed_hold'
  | 'deducted';

type Kind = 'job' | 'lead_fee';

interface Amount {
  gross: number;
  fee: number;
  net: number;
  currency: string;
}

interface BlockedReason {
  code: 'payment_disputed' | 'payment_refunded' | 'admin_hold' | 'documents_missing';
  message: string;
  contactWho: 'support' | 'admin' | 'customer';
}

interface EarningsItem {
  id: string;
  kind: Kind;
  state: State;
  workItemId?: string;
  amount: Amount;
  recognizedAt: string;
  expectedSettlementBy?: string;
  blockedReason?: BlockedReason;
  service: { label: string; customerName?: string };
}

interface CurrencyBucket {
  currency: string;
  pending:        { count: number; net: number };
  payable:        { count: number; net: number };
  processing:     { count: number; net: number };
  paid_out:       { count: number; net: number };
  disputed_hold:  { count: number; net: number };
  deducted:       { count: number; net: number };
}

interface Summary {
  byCurrency: CurrencyBucket[];
}

interface Response {
  items: EarningsItem[];
  summary: Summary;
  // B.2 — Persona narrative (read-only narration of the implicit viewer).
  viewer?: {
    displayName: string;
    kind: string;
    organizationName?: string | null;
    slug?: string | null;
  };
}

// Provider-facing copy. NO backend taxonomy in any of these strings.
const STATE_GROUPS: { state: State; label: string; helper: string }[] = [
  { state: 'disputed_hold', label: 'Удержано',         helper: 'Спор или возврат — деньги не двигаются' },
  { state: 'payable',       label: 'Готово к выплате', helper: 'Деньги у платформы, ждут перевода' },
  { state: 'pending',       label: 'Ждём оплаты',      helper: 'Работа закрыта, клиент ещё не оплатил' },
  { state: 'processing',    label: 'В обработке',      helper: 'Выплата запущена' },
  { state: 'paid_out',      label: 'Выплачено',        helper: 'Деньги у вас на счёте' },
  { state: 'deducted',      label: 'Списания',         helper: 'Платежи за лиды' },
];

const STATE_COLOR: Record<State, string> = {
  disputed_hold: '#ef4444',
  payable:       '#10b981',
  pending:       '#f59e0b',
  processing:    '#3b82f6',
  paid_out:      '#94a3b8',
  deducted:      '#a855f7',
};

const SUMMARY_TILES: { state: State; label: string }[] = [
  { state: 'disputed_hold', label: 'Удержано' },
  { state: 'payable',       label: 'К выплате' },
  { state: 'pending',       label: 'Ждём оплаты' },
  { state: 'deducted',      label: 'Списано' },
];

const CONTACT_LABEL: Record<BlockedReason['contactWho'], string> = {
  customer: 'Связаться с клиентом',
  support:  'Написать в поддержку',
  admin:    'Связаться с админом',
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

function formatMoney(amount: number, currency: string): string {
  const sign = amount < 0 ? '−' : '';
  const abs = Math.abs(amount);
  // Server always rounds to 2 decimals; preserve.
  return `${sign}${abs.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency}`;
}

function formatExpected(iso?: string): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!t) return null;
  const days = Math.ceil((t - Date.now()) / (1000 * 60 * 60 * 24));
  if (days < 0) return `${Math.abs(days)} дн просрочено`;
  if (days === 0) return 'сегодня';
  return `через ${days} дн`;
}

export default function ProviderEarningsClarity() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<State | 'all'>('all');
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const { data } = await api.get<Response>('/provider/earnings/items');
      if (mountedRef.current) {
        setData(data);
        setError(null);
      }
    } catch (e: any) {
      if (mountedRef.current) {
        setError(e?.response?.data?.message || 'Не удалось загрузить earnings');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => { mountedRef.current = false; };
  }, [fetchData]);

  const filteredItems = useMemo(() => {
    if (!data) return [];
    if (stateFilter === 'all') return data.items;
    return data.items.filter((it) => it.state === stateFilter);
  }, [data, stateFilter]);

  const grouped = useMemo(() => {
    const m = new Map<State, EarningsItem[]>();
    for (const it of filteredItems) {
      const list = m.get(it.state) || [];
      list.push(it);
      m.set(it.state, list);
    }
    return m;
  }, [filteredItems]);

  return (
    <div data-testid="provider-earnings-clarity" style={styles.page}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Где мои деньги</h1>
          <div style={styles.subtitle}>
            За последние 90 дней. Каждая валюта — отдельная реальность; ничего не складывается.
          </div>
          {data?.viewer && (
            <div data-testid="earnings-persona" style={{ marginTop: 12, padding: '8px 12px', backgroundColor: '#f1f5f9', borderRadius: 8, borderLeft: '3px solid #10b981', display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
              <span style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase' as const, letterSpacing: 0.5, fontWeight: 600 }}>Платежи учитываются для</span>
              <span style={{ fontSize: 14, color: '#0f172a', fontWeight: 700 }}>
                {data.viewer.organizationName ?? data.viewer.displayName}
              </span>
              <span style={{ fontSize: 12, color: '#475569' }}>
                {data.viewer.displayName}
                {data.viewer.kind ? ` · ${data.viewer.kind === 'inspector' ? 'Inspector' : data.viewer.kind === 'service_provider' ? 'Service Provider' : data.viewer.kind}` : ''}
              </span>
            </div>
          )}
        </div>
      </header>

      {loading && <div style={styles.empty}>Считаем earnings…</div>}
      {error && <div style={{ ...styles.empty, color: '#ef4444' }} data-testid="earnings-error">{error}</div>}

      {!loading && !error && data && data.summary.byCurrency.length === 0 && (
        <div style={styles.empty} data-testid="earnings-empty">
          За 90 дней не нашлось ни одного завершённого заказа.
          Новые заработки появятся здесь, как только клиенты оплатят первый завершённый заказ.
        </div>
      )}

      {/* Per-currency summary cards. Hard rule: no cross-currency total. */}
      {data?.summary.byCurrency.map((bucket) => (
        <section
          key={bucket.currency}
          style={styles.summaryCard}
          data-testid={`earnings-summary-${bucket.currency}`}
        >
          <div style={styles.summaryHeader}>
            <h2 style={styles.summaryCurrency}>{bucket.currency}</h2>
            <span style={styles.summaryHelper}>отдельная валюта · не суммируется с другими</span>
          </div>
          <div style={styles.summaryGrid}>
            {SUMMARY_TILES.map(({ state, label }) => {
              const v = bucket[state];
              return (
                <button
                  type="button"
                  key={state}
                  onClick={() => setStateFilter((s) => (s === state ? 'all' : state))}
                  style={{
                    ...styles.summaryTile,
                    ...(stateFilter === state ? styles.summaryTileActive : {}),
                    borderColor: stateFilter === state ? STATE_COLOR[state] : '#e2e8f0',
                  }}
                  data-testid={`earnings-summary-tile-${bucket.currency}-${state}`}
                >
                  <div style={styles.tileLabelRow}>
                    <span style={{ ...styles.dot, background: STATE_COLOR[state] }} />
                    <span style={styles.tileLabel}>{label}</span>
                  </div>
                  <div style={styles.tileNet}>{formatMoney(v.net, bucket.currency)}</div>
                  <div style={styles.tileCount}>{v.count} {v.count === 1 ? 'позиция' : 'позиций'}</div>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {/* Filter pill bar */}
      {data && filteredItems.length > 0 && stateFilter !== 'all' && (
        <div style={styles.filterBar} data-testid="earnings-filter-active">
          Показаны только: <strong>{STATE_GROUPS.find((g) => g.state === stateFilter)?.label}</strong>
          <button
            type="button"
            onClick={() => setStateFilter('all')}
            style={styles.clearFilter}
            data-testid="earnings-filter-clear"
          >
            показать все
          </button>
        </div>
      )}

      {/* Items grouped by state */}
      {STATE_GROUPS.map(({ state, label, helper }) => {
        const list = grouped.get(state) || [];
        if (list.length === 0) return null;
        return (
          <section key={state} style={styles.group} data-testid={`earnings-group-${state}`}>
            <div style={styles.groupHeader}>
              <span style={{ ...styles.dot, background: STATE_COLOR[state] }} />
              <h3 style={styles.groupTitle}>{label}</h3>
              <span style={styles.groupCount}>{list.length}</span>
              <span style={styles.groupHelper}>{helper}</span>
            </div>
            <div style={styles.list}>
              {list.map((it) => (
                <EarningsItemRow key={it.id} item={it} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function EarningsItemRow({ item }: { item: EarningsItem }) {
  const [expanded, setExpanded] = useState(false);
  const isNegative = item.amount.net < 0;
  const expected = item.state === 'payable' ? formatExpected(item.expectedSettlementBy) : null;

  return (
    <div style={styles.row} data-testid={`earnings-item-${item.id}`}>
      <div style={styles.rowMain}>
        <div>
          <div style={styles.rowLabelRow}>
            <span style={styles.kindPill}>
              {item.kind === 'lead_fee' ? 'Лид' : 'Заказ'}
            </span>
            <span style={styles.rowLabel}>{item.service.label}</span>
          </div>
          {item.service.customerName && (
            <div style={styles.rowCustomer}>{item.service.customerName}</div>
          )}
          <div style={styles.rowMeta}>
            <span>{formatRelative(item.recognizedAt)}</span>
            {expected && <span style={{ marginLeft: 8, color: '#10b981' }}>· ожидается {expected}</span>}
          </div>
        </div>
        <div style={styles.rowAmounts}>
          <div
            style={{
              ...styles.rowNet,
              color: isNegative ? '#ef4444' : '#0f172a',
            }}
            data-testid={`earnings-item-net-${item.id}`}
          >
            {formatMoney(item.amount.net, item.amount.currency)}
          </div>
          {(item.amount.gross > 0 || item.amount.fee > 0) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={styles.rowExpander}
              data-testid={`earnings-item-expand-${item.id}`}
            >
              {expanded ? 'свернуть' : 'разбивка'}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div style={styles.breakdown} data-testid={`earnings-item-breakdown-${item.id}`}>
          {item.kind === 'job' ? (
            <>
              <div style={styles.breakdownRow}>
                <span>Клиент платит (gross)</span>
                <span>{formatMoney(item.amount.gross, item.amount.currency)}</span>
              </div>
              <div style={styles.breakdownRow}>
                <span>Комиссия / удержания</span>
                <span style={{ color: '#475569' }}>−{formatMoney(item.amount.fee, item.amount.currency).replace('−', '')}</span>
              </div>
              <div style={{ ...styles.breakdownRow, fontWeight: 600 }}>
                <span>Чистыми</span>
                <span>{formatMoney(item.amount.net, item.amount.currency)}</span>
              </div>
            </>
          ) : (
            <div style={styles.breakdownRow}>
              <span>Списано платформой за лид</span>
              <span style={{ color: '#ef4444' }}>{formatMoney(item.amount.net, item.amount.currency)}</span>
            </div>
          )}
        </div>
      )}

      {item.blockedReason && (
        <div style={styles.blockedBox} data-testid={`earnings-item-blocked-${item.id}`}>
          <div style={styles.blockedTitle}>Что мешает:</div>
          <div style={styles.blockedMessage}>{item.blockedReason.message}</div>
          <button type="button" style={styles.blockedButton}>
            {CONTACT_LABEL[item.blockedReason.contactWho]}
          </button>
        </div>
      )}
    </div>
  );
}

const styles: { [k: string]: React.CSSProperties } = {
  page:           { maxWidth: 1100, margin: '0 auto', padding: '24px 20px 80px' },
  header:         { marginBottom: 24 },
  title:          { fontSize: 28, fontWeight: 700, margin: 0 },
  subtitle:       { color: '#64748b', marginTop: 6, fontSize: 14 },
  empty:          { textAlign: 'center', padding: 48, color: '#94a3b8', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 12 },

  summaryCard:    { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 20, marginBottom: 16 },
  summaryHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 },
  summaryCurrency:{ fontSize: 18, fontWeight: 700, margin: 0, letterSpacing: 0.5 },
  summaryHelper:  { fontSize: 12, color: '#94a3b8' },
  summaryGrid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 },
  summaryTile:    { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, textAlign: 'left', cursor: 'pointer', font: 'inherit' },
  summaryTileActive: { background: '#eff6ff', borderWidth: 2 },
  tileLabelRow:   { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 },
  tileLabel:      { fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 },
  tileNet:        { fontSize: 18, fontWeight: 700, color: '#0f172a' },
  tileCount:      { fontSize: 12, color: '#94a3b8', marginTop: 4 },

  filterBar:      { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, padding: '8px 12px', background: '#eff6ff', borderRadius: 8, fontSize: 13, color: '#1e40af' },
  clearFilter:    { background: 'transparent', border: 'none', color: '#1d4ed8', textDecoration: 'underline', cursor: 'pointer', fontSize: 13 },

  group:          { marginBottom: 28 },
  groupHeader:    { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  dot:            { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
  groupTitle:     { fontSize: 16, fontWeight: 600, margin: 0 },
  groupCount:     { background: '#e2e8f0', color: '#475569', borderRadius: 8, padding: '2px 8px', fontSize: 12, fontWeight: 600 },
  groupHelper:    { color: '#94a3b8', fontSize: 12, marginLeft: 8 },

  list:           { display: 'flex', flexDirection: 'column', gap: 8 },
  row:            { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14 },
  rowMain:        { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  rowLabelRow:    { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 },
  kindPill:       { background: '#f1f5f9', color: '#475569', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' },
  rowLabel:       { fontSize: 15, fontWeight: 500, color: '#0f172a' },
  rowCustomer:    { fontSize: 13, color: '#64748b' },
  rowMeta:        { fontSize: 12, color: '#94a3b8', marginTop: 4 },
  rowAmounts:     { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
  rowNet:         { fontSize: 16, fontWeight: 700 },
  rowExpander:    { background: 'transparent', border: 'none', color: '#3b82f6', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' },

  breakdown:      { marginTop: 12, padding: 10, background: '#f8fafc', borderRadius: 6, fontSize: 13 },
  breakdownRow:   { display: 'flex', justifyContent: 'space-between', padding: '4px 0' },

  blockedBox:     { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 10, marginTop: 12 },
  blockedTitle:   { fontSize: 12, fontWeight: 700, color: '#991b1b', marginBottom: 2 },
  blockedMessage: { fontSize: 13, color: '#7f1d1d', marginBottom: 8 },
  blockedButton:  { background: '#fff', border: '1px solid #fca5a5', color: '#991b1b', padding: '6px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
};

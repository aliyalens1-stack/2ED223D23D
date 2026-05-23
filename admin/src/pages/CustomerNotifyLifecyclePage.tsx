/**
 * CustomerNotifyLifecyclePage.tsx — Sprint Customer-Notify-3A (Phase A).
 *
 * Observability surface for the delivery_lifecycle namespace.
 *
 * Hard scope guards (Roman, 2026-05-15):
 *   • This is an OBSERVABILITY SURFACE, NOT a control plane.
 *   • Filters / status pills / provider response / timestamps /
 *     correlation to audit row — yes.
 *   • Resend, retry, dead-letter, bulk ops, cancel — explicitly NO.
 *
 * Invariant the UI honours:
 *   one lifecycle row = one delivery attempt
 *
 * Receipt enrichment (Phase B) will UPDATE the same row in place;
 * the UI must remain readable both before and after `deliveredAt` /
 * `receiptCheckedAt` arrive.
 */
import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';

// ───────── types ─────────

type Channel = 'push' | 'email' | 'sms';

type LifecycleRow = {
  id: string;
  auditRowId?: string;
  sourceTimelineId?: string;
  kind?: string;
  channel: Channel;
  lang?: string;
  recipientUserId?: string;
  deviceToken?: string;
  devicePlatform?: string;
  provider?: string;
  providerMessageId?: string | null;
  providerStatus?: string | null;
  providerError?: string | null;
  // Phase B fields (may be absent on rows written by 3A only).
  providerReceiptStatus?: string | null;
  providerReceiptError?: string | null;
  receiptCheckedAt?: string | null;
  projectedAt?: string | null;
  sentAt?: string | null;
  failedAt?: string | null;
  deliveredAt?: string | null;
  createdAt: string;
};

type LifecycleResponse = {
  items: LifecycleRow[];
  total: number;
  serverTime: string;
};

type ChannelState = {
  channels: Record<Channel, { dryRun: boolean; liveEnabled: boolean; provider: string | null }>;
  dryRunAlwaysOn: boolean;
};

type AuditRow = {
  id: string;
  sourceTimelineId: string;
  kind: string;
  channel: Channel;
  lang: string;
  recipientUserId: string;
  title: string | null;
  body: string;
  deepLinkKind: string;
  dryRun: boolean;
  createdAt: string;
};

type AuditResponse = { items: AuditRow[]; total: number };

// ───────── api ─────────

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});
api.interceptors.request.use((c) => {
  const t = localStorage.getItem('admin_token');
  if (t) c.headers.Authorization = `Bearer ${t}`;
  return c;
});

// ───────── styles (parity with CustomerNotifyPreviewPage) ─────────

const styles: Record<string, React.CSSProperties> = {
  page: { padding: 24, color: '#e4e7eb', background: '#0d1117', minHeight: '100vh' },
  h1: { fontSize: 22, fontWeight: 700, marginBottom: 4 },
  subtle: { color: '#8b95a1', fontSize: 13, marginBottom: 24 },
  section: { marginBottom: 28 },
  sectionTitle: {
    fontSize: 13, fontWeight: 700, letterSpacing: '0.08em',
    textTransform: 'uppercase' as const, color: '#8b95a1', marginBottom: 12,
  },
  card: {
    background: '#161b22', border: '1px solid #30363d',
    borderRadius: 8, padding: 16,
  },
  row: { display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'center' },
  pill: {
    display: 'inline-block', padding: '2px 10px',
    fontSize: 11, fontWeight: 600, borderRadius: 999,
    letterSpacing: '0.04em', textTransform: 'uppercase' as const,
  },
  pillDelivered: { background: '#23863633', color: '#7ce38b', border: '1px solid #238636' },
  pillSent: { background: '#1f6feb33', color: '#79c0ff', border: '1px solid #1f6feb' },
  pillFailed: { background: '#f8514933', color: '#ff7b72', border: '1px solid #f85149' },
  pillDryRun: { background: '#30363d', color: '#c9d1d9', border: '1px solid #484f58' },
  pillNeutral: { background: '#30363d', color: '#c9d1d9' },
  select: {
    background: '#0d1117', color: '#e4e7eb',
    border: '1px solid #30363d', borderRadius: 4,
    padding: '6px 10px', fontSize: 13,
  },
  input: {
    background: '#0d1117', color: '#e4e7eb',
    border: '1px solid #30363d', borderRadius: 4,
    padding: '6px 10px', fontSize: 13, fontFamily: 'monospace',
    minWidth: 240,
  },
  button: {
    background: '#21262d', color: '#c9d1d9',
    border: '1px solid #30363d', borderRadius: 4,
    padding: '6px 12px', fontSize: 13, cursor: 'pointer',
  },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th: {
    textAlign: 'left' as const, padding: '8px 10px',
    color: '#8b95a1', borderBottom: '1px solid #30363d',
    fontWeight: 600, fontSize: 11, textTransform: 'uppercase' as const,
    letterSpacing: '0.04em', background: '#161b22',
    position: 'sticky' as const, top: 0,
  },
  td: { padding: '10px', borderBottom: '1px solid #21262d', verticalAlign: 'top' as const },
  monoSmall: { fontFamily: 'monospace', fontSize: 11, color: '#8b95a1' },
  monoStrong: { fontFamily: 'monospace', fontSize: 12, color: '#e4e7eb' },
  empty: { color: '#8b95a1', padding: 24, textAlign: 'center' as const, fontSize: 13 },
  scope: {
    color: '#8b95a1', fontSize: 12, fontStyle: 'italic' as const,
    borderLeft: '2px solid #30363d', paddingLeft: 10, marginTop: 8,
  },
  inspectorPanel: {
    background: '#0d1117', border: '1px solid #30363d',
    borderRadius: 6, padding: 14, marginTop: 12,
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16,
  },
  field: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, color: '#c9d1d9', padding: '4px 0' },
  fieldKey: { color: '#8b95a1' },
  closeBtn: {
    background: 'transparent', color: '#8b95a1', border: 'none',
    cursor: 'pointer', fontSize: 18,
  },
};

// ───────── helpers ─────────

function fmtISO(s: string | null | undefined): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

function shortId(s: string | null | undefined, head = 6, tail = 4): string {
  if (!s) return '—';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

type Verdict = 'delivered' | 'sent' | 'failed' | 'pending';

function verdictOf(r: LifecycleRow): Verdict {
  if (r.deliveredAt) return 'delivered';
  if (r.failedAt) return 'failed';
  if (r.sentAt) return 'sent';
  return 'pending';
}

function VerdictPill({ v }: { v: Verdict }) {
  const map: Record<Verdict, { style: React.CSSProperties; label: string }> = {
    delivered: { style: styles.pillDelivered, label: 'Delivered' },
    sent:      { style: styles.pillSent,      label: 'Sent (awaiting receipt)' },
    failed:    { style: styles.pillFailed,    label: 'Failed' },
    pending:   { style: styles.pillNeutral,   label: 'Pending' },
  };
  return <span style={{ ...styles.pill, ...map[v].style }} data-testid={`lifecycle-verdict-${v}`}>{map[v].label}</span>;
}

// ───────── page ─────────

export default function CustomerNotifyLifecyclePage() {
  // filters — observability only
  const [channel, setChannel] = useState<'' | Channel>('');
  const [recipient, setRecipient] = useState('');
  const [verdictFilter, setVerdictFilter] = useState<'' | Verdict>('');
  const [limit, setLimit] = useState<number>(100);

  const [rows, setRows] = useState<LifecycleRow[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [serverTime, setServerTime] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const [channelState, setChannelState] = useState<ChannelState | null>(null);

  // audit correlation drawer
  const [auditRow, setAuditRow] = useState<AuditRow | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<LifecycleRow | null>(null);

  // load channel-state once (and on manual refresh)
  async function loadChannelState() {
    try {
      const r = await api.get<ChannelState>('/admin/customer-notify/channel-state');
      setChannelState(r.data);
    } catch (e: unknown) {
      // non-fatal — page can still render lifecycle rows
      console.warn('channel-state load failed', e);
    }
  }

  async function loadRows() {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string | number> = { limit };
      if (channel) params.channel = channel;
      if (recipient.trim()) params.recipient = recipient.trim();
      const r = await api.get<LifecycleResponse>('/admin/customer-notify/lifecycle', { params });
      setRows(r.data.items || []);
      setTotal(r.data.total || 0);
      setServerTime(r.data.serverTime || '');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } }; message?: string });
      setError(msg.response?.data?.message || msg.message || 'load failed');
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadChannelState();
    loadRows();
    // intentional: only on mount; filter changes use the Apply button
    // to avoid burning rate-limit on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // client-side verdict filter (Phase A scope — backend filter would
  // require a new query param; not worth a write today).
  const filteredRows = useMemo(() => {
    if (!verdictFilter) return rows;
    return rows.filter((r) => verdictOf(r) === verdictFilter);
  }, [rows, verdictFilter]);

  // KPI roll-up (client-side, current page only)
  const kpi = useMemo(() => {
    const k = { total: rows.length, delivered: 0, sent: 0, failed: 0, pending: 0 };
    for (const r of rows) {
      const v = verdictOf(r);
      k[v] += 1;
    }
    return k;
  }, [rows]);

  async function openAudit(row: LifecycleRow) {
    setInspecting(row);
    setAuditRow(null);
    setAuditError(null);
    if (!row.auditRowId) {
      setAuditError('lifecycle row carries no auditRowId — likely an out-of-band test-send');
      return;
    }
    try {
      // We list-then-find because there is no GET-by-id audit endpoint.
      // Recipient narrows the read; subsequent paging is future work.
      const params: Record<string, string | number> = { limit: 200 };
      if (row.recipientUserId) params.recipient = row.recipientUserId;
      if (row.channel) params.channel = row.channel;
      const r = await api.get<AuditResponse>('/admin/customer-notify/audit', { params });
      const hit = (r.data.items || []).find((it) => it.id === row.auditRowId);
      if (hit) setAuditRow(hit);
      else setAuditError('audit row not found in last 200 — may be older than current window');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } }; message?: string });
      setAuditError(msg.response?.data?.message || msg.message || 'audit fetch failed');
    }
  }

  return (
    <div style={styles.page} data-testid="lifecycle-page">
      <h1 style={styles.h1}>🔔 Customer Notify · Delivery Lifecycle</h1>
      <div style={styles.subtle}>
        Observability surface for the <code style={styles.monoSmall}>notification_delivery_lifecycle</code> collection
        (Notify-3A). Audit layer is the semantic source of truth; this view inspects the transport layer only.
      </div>

      {/* ─── Channel state matrix ─── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Channel-flip matrix · deploy-controlled</div>
        <div style={styles.card}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            {(['push', 'email', 'sms'] as Channel[]).map((ch) => {
              const cs = channelState?.channels[ch];
              const live = cs?.liveEnabled === true;
              return (
                <div key={ch} style={{ ...styles.card, background: '#0d1117' }} data-testid={`channel-state-${ch}`}>
                  <div style={{ ...styles.row, justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 700, color: '#e4e7eb', textTransform: 'uppercase' }}>{ch}</span>
                    <span style={{
                      ...styles.pill,
                      ...(live ? styles.pillDelivered : styles.pillDryRun),
                    }}>{live ? 'live' : 'dry-run only'}</span>
                  </div>
                  <div style={{ ...styles.field, marginTop: 8 }}>
                    <span style={styles.fieldKey}>provider</span>
                    <span style={styles.monoStrong}>{cs?.provider || '—'}</span>
                  </div>
                  <div style={styles.field}>
                    <span style={styles.fieldKey}>dryRun</span>
                    <span style={styles.monoStrong}>{cs?.dryRun ? 'true (always-on)' : 'false'}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={styles.scope}>
            Change requires a deploy. Source of truth: <code>backend/app/notifications/channel_state.py</code>.
            dryRun stays <strong>true</strong> permanently — audit layer is canonical, live delivery is secondary.
          </div>
        </div>
      </div>

      {/* ─── KPI ─── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>This page · roll-up (latest {rows.length} rows · DB total = {total})</div>
        <div style={{ ...styles.row, gap: 8 }}>
          <span style={{ ...styles.pill, ...styles.pillNeutral }} data-testid="kpi-total">Page rows · {kpi.total}</span>
          <span style={{ ...styles.pill, ...styles.pillDelivered }} data-testid="kpi-delivered">Delivered · {kpi.delivered}</span>
          <span style={{ ...styles.pill, ...styles.pillSent }} data-testid="kpi-sent">Sent · {kpi.sent}</span>
          <span style={{ ...styles.pill, ...styles.pillFailed }} data-testid="kpi-failed">Failed · {kpi.failed}</span>
          <span style={{ ...styles.pill, ...styles.pillNeutral }} data-testid="kpi-pending">Pending · {kpi.pending}</span>
          <span style={{ ...styles.monoSmall, marginLeft: 'auto' }}>server time · {fmtISO(serverTime)}</span>
        </div>
      </div>

      {/* ─── Filters ─── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Filters · observability only</div>
        <div style={styles.card}>
          <div style={{ ...styles.row, gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
              <span style={styles.monoSmall}>channel</span>
              <select
                style={styles.select}
                value={channel}
                onChange={(e) => setChannel(e.target.value as '' | Channel)}
                data-testid="filter-channel"
              >
                <option value="">(any)</option>
                <option value="push">push</option>
                <option value="email">email</option>
                <option value="sms">sms</option>
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
              <span style={styles.monoSmall}>recipientUserId</span>
              <input
                style={styles.input}
                placeholder="customer id (Mongo _id string)"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                data-testid="filter-recipient"
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
              <span style={styles.monoSmall}>verdict (client filter)</span>
              <select
                style={styles.select}
                value={verdictFilter}
                onChange={(e) => setVerdictFilter(e.target.value as '' | Verdict)}
                data-testid="filter-verdict"
              >
                <option value="">(any)</option>
                <option value="delivered">delivered</option>
                <option value="sent">sent</option>
                <option value="failed">failed</option>
                <option value="pending">pending</option>
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
              <span style={styles.monoSmall}>limit</span>
              <select
                style={styles.select}
                value={limit}
                onChange={(e) => setLimit(parseInt(e.target.value, 10))}
                data-testid="filter-limit"
              >
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="200">200</option>
                <option value="500">500</option>
              </select>
            </label>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginLeft: 'auto' }}>
              <button
                style={styles.button}
                onClick={() => { loadChannelState(); loadRows(); }}
                disabled={loading}
                data-testid="filter-apply"
              >
                {loading ? '…' : 'Apply / Refresh'}
              </button>
            </div>
          </div>
          <div style={styles.scope}>
            Scope guard: no resend, retry, cancel, dead-letter, or bulk actions on this surface.
            If you need to re-project, use the manual <code>/customer-notify/project</code> endpoint —
            that is grammar layer, not transport.
          </div>
        </div>
      </div>

      {/* ─── Table ─── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Delivery lifecycle rows · sorted by createdAt desc</div>
        {error && (
          <div style={{ ...styles.card, borderColor: '#f85149', color: '#ff7b72', marginBottom: 12 }} data-testid="lifecycle-error">
            {error}
          </div>
        )}
        <div style={{ ...styles.card, padding: 0, overflow: 'auto' }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>verdict</th>
                <th style={styles.th}>channel</th>
                <th style={styles.th}>kind</th>
                <th style={styles.th}>recipient</th>
                <th style={styles.th}>provider</th>
                <th style={styles.th}>providerStatus</th>
                <th style={styles.th}>projectedAt</th>
                <th style={styles.th}>sentAt</th>
                <th style={styles.th}>deliveredAt</th>
                <th style={styles.th}>failedAt</th>
                <th style={styles.th}>audit</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={11} style={styles.empty} data-testid="lifecycle-empty">
                    no rows · check filters or trigger an event via /customer-notify/project
                  </td>
                </tr>
              )}
              {filteredRows.map((r) => (
                <tr key={r.id} data-testid={`lifecycle-row-${r.id}`}>
                  <td style={styles.td}><VerdictPill v={verdictOf(r)} /></td>
                  <td style={styles.td}>{r.channel}</td>
                  <td style={styles.td}><span style={styles.monoStrong}>{r.kind || '—'}</span></td>
                  <td style={styles.td}><span style={styles.monoSmall}>{shortId(r.recipientUserId)}</span></td>
                  <td style={styles.td}>{r.provider || '—'}</td>
                  <td style={styles.td}><span style={styles.monoStrong}>{r.providerStatus || '—'}</span></td>
                  <td style={styles.td}><span style={styles.monoSmall}>{fmtISO(r.projectedAt)}</span></td>
                  <td style={styles.td}><span style={styles.monoSmall}>{fmtISO(r.sentAt)}</span></td>
                  <td style={styles.td}><span style={styles.monoSmall}>{fmtISO(r.deliveredAt)}</span></td>
                  <td style={styles.td}><span style={styles.monoSmall}>{fmtISO(r.failedAt)}</span></td>
                  <td style={styles.td}>
                    <button
                      style={styles.button}
                      onClick={() => openAudit(r)}
                      data-testid={`lifecycle-inspect-${r.id}`}
                    >
                      inspect →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Inspector panel (correlation to audit row) ─── */}
      {inspecting && (
        <div style={styles.section}>
          <div style={{ ...styles.row, justifyContent: 'space-between' }}>
            <div style={styles.sectionTitle}>Inspector · transport row ↔ grammar row</div>
            <button
              style={styles.closeBtn}
              onClick={() => { setInspecting(null); setAuditRow(null); setAuditError(null); }}
              data-testid="inspector-close"
              aria-label="close inspector"
            >
              ×
            </button>
          </div>
          <div style={styles.inspectorPanel} data-testid="inspector-panel">
            {/* transport side */}
            <div>
              <div style={{ ...styles.sectionTitle, marginBottom: 8 }}>transport (delivery_lifecycle)</div>
              <div style={styles.field}><span style={styles.fieldKey}>id</span><span style={styles.monoSmall}>{inspecting.id}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>auditRowId</span><span style={styles.monoSmall}>{inspecting.auditRowId || '—'}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>sourceTimelineId</span><span style={styles.monoSmall}>{inspecting.sourceTimelineId || '—'}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>channel</span><span style={styles.monoStrong}>{inspecting.channel}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>kind</span><span style={styles.monoStrong}>{inspecting.kind || '—'}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>lang</span><span style={styles.monoStrong}>{inspecting.lang || '—'}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>recipientUserId</span><span style={styles.monoSmall}>{inspecting.recipientUserId || '—'}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>deviceToken</span><span style={styles.monoSmall}>{shortId(inspecting.deviceToken, 12, 6)}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>devicePlatform</span><span style={styles.monoStrong}>{inspecting.devicePlatform || '—'}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>provider</span><span style={styles.monoStrong}>{inspecting.provider || '—'}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>providerMessageId</span><span style={styles.monoSmall}>{inspecting.providerMessageId || '—'}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>providerStatus</span><span style={styles.monoStrong}>{inspecting.providerStatus || '—'}</span></div>
              {inspecting.providerError && (
                <div style={styles.field}>
                  <span style={styles.fieldKey}>providerError</span>
                  <span style={{ ...styles.monoSmall, maxWidth: 280, textAlign: 'right', wordBreak: 'break-word' }}>
                    {inspecting.providerError}
                  </span>
                </div>
              )}
              <div style={styles.field}><span style={styles.fieldKey}>providerReceiptStatus</span><span style={styles.monoStrong}>{inspecting.providerReceiptStatus || '—'}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>receiptCheckedAt</span><span style={styles.monoSmall}>{fmtISO(inspecting.receiptCheckedAt)}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>projectedAt</span><span style={styles.monoSmall}>{fmtISO(inspecting.projectedAt)}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>sentAt</span><span style={styles.monoSmall}>{fmtISO(inspecting.sentAt)}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>deliveredAt</span><span style={styles.monoSmall}>{fmtISO(inspecting.deliveredAt)}</span></div>
              <div style={styles.field}><span style={styles.fieldKey}>failedAt</span><span style={styles.monoSmall}>{fmtISO(inspecting.failedAt)}</span></div>
            </div>

            {/* grammar side */}
            <div>
              <div style={{ ...styles.sectionTitle, marginBottom: 8 }}>grammar (projection_audit)</div>
              {auditError && (
                <div style={{ color: '#ff7b72', fontSize: 12, marginBottom: 8 }} data-testid="inspector-audit-error">
                  {auditError}
                </div>
              )}
              {!auditError && !auditRow && (
                <div style={styles.empty}>loading…</div>
              )}
              {auditRow && (
                <>
                  <div style={styles.field}><span style={styles.fieldKey}>id</span><span style={styles.monoSmall}>{auditRow.id}</span></div>
                  <div style={styles.field}><span style={styles.fieldKey}>sourceTimelineId</span><span style={styles.monoSmall}>{auditRow.sourceTimelineId}</span></div>
                  <div style={styles.field}><span style={styles.fieldKey}>kind</span><span style={styles.monoStrong}>{auditRow.kind}</span></div>
                  <div style={styles.field}><span style={styles.fieldKey}>channel</span><span style={styles.monoStrong}>{auditRow.channel}</span></div>
                  <div style={styles.field}><span style={styles.fieldKey}>lang</span><span style={styles.monoStrong}>{auditRow.lang}</span></div>
                  <div style={styles.field}><span style={styles.fieldKey}>deepLinkKind</span><span style={styles.monoStrong}>{auditRow.deepLinkKind}</span></div>
                  <div style={styles.field}><span style={styles.fieldKey}>dryRun</span><span style={styles.monoStrong}>{String(auditRow.dryRun)}</span></div>
                  <div style={styles.field}><span style={styles.fieldKey}>createdAt</span><span style={styles.monoSmall}>{fmtISO(auditRow.createdAt)}</span></div>
                  <div style={{ ...styles.field, alignItems: 'flex-start' }}>
                    <span style={styles.fieldKey}>title</span>
                    <span style={{ maxWidth: 280, textAlign: 'right' }}>{auditRow.title || '—'}</span>
                  </div>
                  <div style={{ ...styles.field, alignItems: 'flex-start' }}>
                    <span style={styles.fieldKey}>body</span>
                    <span style={{ maxWidth: 280, textAlign: 'right', wordBreak: 'break-word' }}>{auditRow.body}</span>
                  </div>
                </>
              )}
            </div>
          </div>
          <div style={styles.scope}>
            One lifecycle row = one delivery attempt. The grammar row on the right is what the
            customer would have read. The transport row on the left is what actually happened
            on the wire. Receipts (Phase B) will populate <code>deliveredAt</code> on the same
            row, never as a new event.
          </div>
        </div>
      )}
    </div>
  );
}

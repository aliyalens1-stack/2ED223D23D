/**
 * CustomerNotifyPreviewPage.tsx — Sprint Customer-Notify-2.5
 *
 * Admin observability surface for the customer narrative kernel.
 *
 * Four sections, each backed by an existing /api/admin/customer-notify
 * endpoint. NO new write-paths — this page is a viewer only.
 *
 *   1. Triple-channel comparison card
 *        Pick (kind, lang) → render push/email/sms side-by-side.
 *        Each card shows: title, body, deepLink, channel-shape badge,
 *        dryRun badge.
 *
 *   2. Forbidden-route inspector
 *        Type any eventType → see route-stage verdict explicitly:
 *        ALLOWED / NOT_ALLOWLISTED / FORBIDDEN(prefix).
 *
 *   3. Projection provenance block
 *        policyVersion (SHA-12 of projection-checksums.json), namespaces,
 *        generatedAt, dryRunOnly invariant.
 *
 *   4. "Would send" timeline
 *        Last 100 audit rows. Filter by kind / channel. Click a row to
 *        see its full payload + sourceTimelineId.
 *
 * Roman, 2026-05-14: observability before automation. Notify-3 (real
 * send) is irreversible complexity; we will not flip dryRun=false
 * until this surface is in production.
 */
import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';

// ───────── types ─────────

type Channel = 'push' | 'email' | 'sms';
type Lang = 'en' | 'de' | 'ru';

type ChannelPayload = {
  kind: string;
  channel: Channel;
  lang: Lang;
  title: string | null;
  body: string;
  deepLink: 'timeline' | 'continuity' | 'report';
};

type PreviewResponse = {
  kind: string;
  lang: Lang;
  forbiddenRoute: boolean;
  allowed: boolean;
  channels: Record<Channel, ChannelPayload | null>;
};

type Meta = {
  allowedKinds: string[];
  forbiddenRoutePrefixes: string[];
  supportedLangs: Lang[];
  supportedChannels: Channel[];
  deepLinkMap: Record<string, string>;
  projection: {
    policyVersion: string;
    policyFile: string | null;
    generatedAt: string | null;
    namespaces: string[];
  };
  policyDoc: string;
  dryRunOnly: boolean;
};

type AuditRow = {
  id: string;
  sourceTimelineId: string;
  kind: string;
  channel: Channel;
  lang: Lang;
  recipientUserId: string;
  title: string | null;
  body: string;
  deepLinkKind: 'timeline' | 'continuity' | 'report';
  dryRun: boolean;
  sentAt: string | null;
  eventMetadata: Record<string, unknown>;
  createdAt: string;
};

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

// ───────── styles ─────────

const styles: Record<string, React.CSSProperties> = {
  page: { padding: 24, color: '#e4e7eb', background: '#0d1117', minHeight: '100vh' },
  h1: { fontSize: 22, fontWeight: 700, marginBottom: 4 },
  subtle: { color: '#8b95a1', fontSize: 13, marginBottom: 24 },
  section: { marginBottom: 32 },
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
  pillDryRun: { background: '#1f6feb33', color: '#79c0ff', border: '1px solid #1f6feb' },
  pillForbidden: { background: '#f8514933', color: '#ff7b72', border: '1px solid #f85149' },
  pillAllowed: { background: '#23863633', color: '#7ce38b', border: '1px solid #238636' },
  pillNeutral: { background: '#30363d', color: '#c9d1d9' },
  channelGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 12,
  },
  channelCard: {
    background: '#0d1117', border: '1px solid #30363d',
    borderRadius: 6, padding: 14, minHeight: 180,
    display: 'flex', flexDirection: 'column' as const, gap: 8,
  },
  channelHead: {
    display: 'flex', justifyContent: 'space-between',
    alignItems: 'center', borderBottom: '1px solid #21262d',
    paddingBottom: 8,
  },
  channelTitle: { fontSize: 13, fontWeight: 700, color: '#c9d1d9' },
  channelBody: { fontSize: 14, color: '#e4e7eb', lineHeight: 1.5 },
  field: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#8b95a1' },
  select: {
    background: '#0d1117', color: '#e4e7eb',
    border: '1px solid #30363d', borderRadius: 4,
    padding: '6px 10px', fontSize: 13,
  },
  input: {
    background: '#0d1117', color: '#e4e7eb',
    border: '1px solid #30363d', borderRadius: 4,
    padding: '6px 10px', fontSize: 13, fontFamily: 'monospace',
    width: 360,
  },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th: {
    textAlign: 'left' as const, padding: '8px 10px',
    color: '#8b95a1', borderBottom: '1px solid #30363d',
    fontWeight: 600, fontSize: 11, textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  td: { padding: '10px', borderBottom: '1px solid #21262d', verticalAlign: 'top' as const },
  monoSmall: { fontFamily: 'monospace', fontSize: 11, color: '#8b95a1' },
  empty: { color: '#8b95a1', padding: 16, textAlign: 'center' as const, fontSize: 13 },
};

// ───────── helpers ─────────

function Pill({ kind, children, testID }: { kind: 'dryrun' | 'allowed' | 'forbidden' | 'neutral'; children: React.ReactNode; testID?: string }) {
  const style = {
    ...styles.pill,
    ...(kind === 'dryrun' ? styles.pillDryRun :
       kind === 'allowed' ? styles.pillAllowed :
       kind === 'forbidden' ? styles.pillForbidden :
       styles.pillNeutral),
  };
  return <span style={style} data-testid={testID}>{children}</span>;
}

function fmtISO(s: string | null | undefined): string {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return d.toLocaleString();
  } catch { return s; }
}

// ───────── page ─────────

export default function CustomerNotifyPreviewPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [kind, setKind] = useState<string>('inspection.started');
  const [lang, setLang] = useState<Lang>('en');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [inspectorInput, setInspectorInput] = useState('ocr.vin_detected');
  const [inspectorResult, setInspectorResult] = useState<PreviewResponse | null>(null);

  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [filterKind, setFilterKind] = useState<string>('');
  const [filterChannel, setFilterChannel] = useState<string>('');

  // Load meta once.
  useEffect(() => {
    let cancelled = false;
    api.get('/admin/customer-notify/meta')
      .then((r) => { if (!cancelled) setMeta(r.data); })
      .catch((e: { message?: string }) => { if (!cancelled) setMetaError(e.message || 'failed to load meta'); });
    return () => { cancelled = true; };
  }, []);

  // Preview reactive to (kind, lang).
  useEffect(() => {
    let cancelled = false;
    setPreviewError(null);
    api.post('/admin/customer-notify/preview', { kind, lang })
      .then((r) => { if (!cancelled) setPreview(r.data); })
      .catch((e: { message?: string }) => { if (!cancelled) setPreviewError(e.message || 'preview failed'); });
    return () => { cancelled = true; };
  }, [kind, lang]);

  // Audit feed.
  const reloadAudit = () => {
    const params: Record<string, string | number> = { limit: 100 };
    if (filterKind) params.kind = filterKind;
    if (filterChannel) params.channel = filterChannel;
    api.get('/admin/customer-notify/audit', { params })
      .then((r) => { setAudit(r.data.items || []); setAuditTotal(r.data.total || 0); })
      .catch(() => {});
  };
  useEffect(() => { reloadAudit(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filterKind, filterChannel]);

  // Forbidden-route inspector reactive.
  useEffect(() => {
    if (!inspectorInput.trim()) { setInspectorResult(null); return; }
    let cancelled = false;
    api.post('/admin/customer-notify/preview', { kind: inspectorInput.trim(), lang: 'en' })
      .then((r) => { if (!cancelled) setInspectorResult(r.data); })
      .catch(() => { if (!cancelled) setInspectorResult(null); });
    return () => { cancelled = true; };
  }, [inspectorInput]);

  const matchedPrefix = useMemo(() => {
    if (!meta || !inspectorResult || !inspectorResult.forbiddenRoute) return null;
    return meta.forbiddenRoutePrefixes.find((p) => inspectorInput.trim().startsWith(p)) || null;
  }, [meta, inspectorResult, inspectorInput]);

  // ───────── render ─────────

  if (metaError) {
    return (
      <div style={styles.page} data-testid="cnotify-error">
        <div style={styles.h1}>Customer Notification Preview</div>
        <div style={{ ...styles.card, borderColor: '#f85149', color: '#ff7b72' }}>
          Could not load meta: {metaError}
        </div>
      </div>
    );
  }
  if (!meta) {
    return <div style={styles.page}><div style={styles.subtle}>Loading meta…</div></div>;
  }

  return (
    <div style={styles.page} data-testid="customer-notify-preview-page">
      <div style={styles.h1}>Customer Notification Preview</div>
      <div style={styles.subtle}>
        Dry-run observability for the customer narrative kernel. No notification is sent from this surface.
      </div>

      {/* ───── Provenance ───── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Projection Provenance</div>
        <div style={styles.card} data-testid="cnotify-provenance">
          <div style={{ ...styles.row, marginBottom: 12 }}>
            <Pill kind="dryrun" testID="provenance-dryrun-badge">DRY RUN ONLY</Pill>
            <Pill kind="neutral">policy v{meta.projection.policyVersion}</Pill>
            <Pill kind="neutral">{meta.projection.namespaces.length} namespaces</Pill>
            <span style={styles.monoSmall}>regenerated {fmtISO(meta.projection.generatedAt)}</span>
          </div>
          <div style={{ ...styles.field, marginBottom: 4 }}>
            <span>Policy file</span><span style={styles.monoSmall}>{meta.projection.policyFile || '—'}</span>
          </div>
          <div style={{ ...styles.field, marginBottom: 4 }}>
            <span>Doc</span><span style={styles.monoSmall}>{meta.policyDoc}</span>
          </div>
          <div style={styles.field}>
            <span>Namespaces</span>
            <span style={styles.monoSmall}>{meta.projection.namespaces.join(' · ')}</span>
          </div>
        </div>
      </div>

      {/* ───── Triple-channel preview ───── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Triple-Channel Preview</div>
        <div style={styles.card}>
          <div style={{ ...styles.row, marginBottom: 16 }}>
            <label style={{ fontSize: 12, color: '#8b95a1' }}>Event</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              style={styles.select}
              data-testid="preview-kind-select"
            >
              {meta.allowedKinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <label style={{ fontSize: 12, color: '#8b95a1', marginLeft: 16 }}>Locale</label>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as Lang)}
              style={styles.select}
              data-testid="preview-lang-select"
            >
              {meta.supportedLangs.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>

          {previewError && (
            <div style={{ color: '#ff7b72', fontSize: 13, marginBottom: 12 }}>{previewError}</div>
          )}

          {preview && (
            <div style={styles.channelGrid}>
              {meta.supportedChannels.map((ch) => {
                const p = preview.channels[ch];
                return (
                  <div key={ch} style={styles.channelCard} data-testid={`channel-card-${ch}`}>
                    <div style={styles.channelHead}>
                      <div style={styles.channelTitle}>{ch.toUpperCase()}</div>
                      <Pill kind="dryrun">DRY-RUN</Pill>
                    </div>
                    {p ? (
                      <>
                        {p.title !== null ? (
                          <div style={{ fontWeight: 700, fontSize: 14, color: '#e4e7eb' }} data-testid={`channel-${ch}-title`}>
                            {p.title}
                          </div>
                        ) : (
                          <div style={{ ...styles.monoSmall, fontStyle: 'italic' }} data-testid={`channel-${ch}-title-null`}>
                            (no title — SMS carrier shape)
                          </div>
                        )}
                        <div style={styles.channelBody} data-testid={`channel-${ch}-body`}>{p.body}</div>
                        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                          <div style={styles.field}><span>deepLink</span><span style={styles.monoSmall}>{p.deepLink}</span></div>
                          <div style={styles.field}><span>lang</span><span style={styles.monoSmall}>{p.lang}</span></div>
                          <div style={styles.field}>
                            <span>shape</span>
                            <span style={styles.monoSmall}>
                              {ch === 'sms' ? 'body-only' : 'title+body'}
                            </span>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div style={styles.empty}>No copy projected for this channel.</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ───── Forbidden-route inspector ───── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Forbidden-Route Inspector</div>
        <div style={styles.card}>
          <div style={{ ...styles.row, marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: '#8b95a1' }}>eventType</label>
            <input
              value={inspectorInput}
              onChange={(e) => setInspectorInput(e.target.value)}
              style={styles.input}
              placeholder="e.g. ocr.vin_detected"
              data-testid="route-inspector-input"
            />
          </div>

          {inspectorResult && (
            <div data-testid="route-inspector-verdict">
              {inspectorResult.forbiddenRoute ? (
                <div style={{ ...styles.row, marginBottom: 8 }}>
                  <Pill kind="forbidden" testID="verdict-forbidden">FORBIDDEN ROUTE</Pill>
                  <span style={styles.monoSmall}>
                    matched prefix: <strong style={{ color: '#ff7b72' }}>{matchedPrefix || '—'}</strong>
                  </span>
                </div>
              ) : inspectorResult.allowed ? (
                <div style={{ ...styles.row, marginBottom: 8 }}>
                  <Pill kind="allowed" testID="verdict-allowed">ALLOWED</Pill>
                  <span style={styles.monoSmall}>on customer notification allowlist</span>
                </div>
              ) : (
                <div style={{ ...styles.row, marginBottom: 8 }}>
                  <Pill kind="neutral" testID="verdict-not-allowlisted">NOT ALLOWLISTED</Pill>
                  <span style={styles.monoSmall}>
                    not on customer notification allowlist (may still be on timeline allowlist)
                  </span>
                </div>
              )}
              <div style={{ fontSize: 12, color: '#8b95a1', marginTop: 12 }}>
                Forbidden prefixes:{' '}
                {meta.forbiddenRoutePrefixes.map((p, i) => (
                  <span key={p}>
                    <code style={{ color: '#ff7b72' }}>{p}*</code>
                    {i < meta.forbiddenRoutePrefixes.length - 1 ? ' · ' : ''}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 12, color: '#8b95a1', marginTop: 6 }}>
                Allowlist:{' '}
                {meta.allowedKinds.map((k, i) => (
                  <span key={k}>
                    <code style={{ color: '#7ce38b' }}>{k}</code>
                    {i < meta.allowedKinds.length - 1 ? ' · ' : ''}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ───── Would-send timeline ───── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>"Would Send" Timeline · {auditTotal} total</div>
        <div style={styles.card}>
          <div style={{ ...styles.row, marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: '#8b95a1' }}>Filter kind</label>
            <select
              value={filterKind}
              onChange={(e) => setFilterKind(e.target.value)}
              style={styles.select}
              data-testid="audit-filter-kind"
            >
              <option value="">all</option>
              {meta.allowedKinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <label style={{ fontSize: 12, color: '#8b95a1', marginLeft: 16 }}>Filter channel</label>
            <select
              value={filterChannel}
              onChange={(e) => setFilterChannel(e.target.value)}
              style={styles.select}
              data-testid="audit-filter-channel"
            >
              <option value="">all</option>
              {meta.supportedChannels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button
              onClick={reloadAudit}
              style={{ ...styles.select, cursor: 'pointer', marginLeft: 16 }}
              data-testid="audit-reload"
            >
              Reload
            </button>
          </div>

          {audit.length === 0 ? (
            <div style={styles.empty} data-testid="audit-empty">
              No audit rows yet. Trigger one via <code>POST /api/admin/customer-notify/project</code> or wait for inspection events.
            </div>
          ) : (
            <table style={styles.table} data-testid="audit-table">
              <thead>
                <tr>
                  <th style={styles.th}>when</th>
                  <th style={styles.th}>kind</th>
                  <th style={styles.th}>channel</th>
                  <th style={styles.th}>lang</th>
                  <th style={styles.th}>recipient</th>
                  <th style={styles.th}>title / body</th>
                  <th style={styles.th}>flags</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => (
                  <tr key={row.id} data-testid={`audit-row-${row.id}`}>
                    <td style={{ ...styles.td, ...styles.monoSmall, whiteSpace: 'nowrap' }}>{fmtISO(row.createdAt)}</td>
                    <td style={{ ...styles.td, ...styles.monoSmall, color: '#79c0ff' }}>{row.kind}</td>
                    <td style={styles.td}><Pill kind="neutral">{row.channel}</Pill></td>
                    <td style={{ ...styles.td, ...styles.monoSmall }}>{row.lang}</td>
                    <td style={{ ...styles.td, ...styles.monoSmall }}>{row.recipientUserId.slice(0, 12)}…</td>
                    <td style={styles.td}>
                      {row.title && <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{row.title}</div>}
                      <div style={{ fontSize: 12, color: '#c9d1d9' }}>{row.body}</div>
                      <div style={{ ...styles.monoSmall, marginTop: 4 }}>
                        deepLink: {row.deepLinkKind} · source: {row.sourceTimelineId.slice(0, 12)}…
                      </div>
                    </td>
                    <td style={styles.td}>
                      {row.dryRun && <Pill kind="dryrun">DRY</Pill>}
                      {row.sentAt === null && (
                        <span style={{ ...styles.monoSmall, marginLeft: 6 }}>not sent</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

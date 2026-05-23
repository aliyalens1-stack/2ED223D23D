/**
 * Sprint 3 Step 1 — Verification Admin Queue page.
 *
 * Left: actionable queue table with filters + roll-up counts.
 * Right: drawer with document preview, inspector snapshot, rejection
 * history, approve + reject (reason chips + free-form note).
 *
 * Pure data-driven — every server response shape lives in this file at
 * the top so future endpoint additions can extend the types without
 * touching the rendering code.
 */
import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Check, X, FileText, Loader2, RefreshCcw, ShieldCheck, AlertTriangle, Filter,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────
// Types — kept thin; backend is the source of truth.
// ─────────────────────────────────────────────────────────────────────

type Status =
  | 'missing' | 'uploaded' | 'pending_review'
  | 'approved' | 'rejected' | 'needs_resubmission' | 'expired';

interface InspectorSnap {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  verification?: {
    verified?: boolean;
    verifiedDocuments?: string[];
    verificationScore?: number;
  };
}

interface QueueItem {
  id: string;
  userId: string;
  kind: string;
  status: Status;
  fileName?: string | null;
  mimeType?: string | null;
  note?: string | null;
  uploadedAt?: string | null;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
  rejectionNote?: string | null;
  inspector: InspectorSnap;
}

interface QueueResponse {
  items: QueueItem[];
  total: number;
  counts: Record<string, number>;
  limit: number;
  skip: number;
}

interface QueueDetailResponse {
  document: QueueItem & { data?: string | null; hasFile?: boolean };
  inspector: InspectorSnap;
  rejectionHistory: Array<{
    id: string; reason: string; note?: string;
    reviewerId?: string; createdAt: string;
    kind?: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  passport: 'Паспорт',
  businessRegistration: 'Регистрация бизнеса',
  insurance: 'Страховка',
  taxId: 'Налоговый номер',
  toolsProof: 'Подтверждение инструментов',
  tuvCertificate: 'Сертификат TÜV',
};

const REJECTION_REASONS: Array<{ value: string; label: string }> = [
  { value: 'document_blurry',     label: 'Фото нечёткое' },
  { value: 'document_expired',    label: 'Документ просрочен' },
  { value: 'wrong_document_type', label: 'Неверный тип документа' },
  { value: 'name_mismatch',       label: 'Имя не совпадает' },
  { value: 'incomplete_scan',     label: 'Неполное сканирование' },
  { value: 'low_quality',         label: 'Низкое качество' },
  { value: 'suspicious',          label: 'Подозрительные данные' },
  { value: 'other',               label: 'Другое' },
];

// Step 3 — admin queue tone alignment. Operational labels stay terse
// (this is an admin tool, not a customer surface) but `rose` (red)
// rejection tone is replaced with `amber` so the queue reads as review
// continuity, not punitive failure cascades.
const STATUS_TONE: Record<Status, { fg: string; bg: string; label: string }> = {
  missing:            { fg: 'text-zinc-400', bg: 'bg-zinc-800/50',          label: 'Ожидает документации' },
  uploaded:           { fg: 'text-amber-300', bg: 'bg-amber-900/30',        label: 'Отправлено' },
  pending_review:     { fg: 'text-amber-300', bg: 'bg-amber-900/30',        label: 'Ожидает проверки' },
  approved:           { fg: 'text-emerald-300', bg: 'bg-emerald-900/30',    label: 'Подтверждено' },
  rejected:           { fg: 'text-amber-300', bg: 'bg-amber-900/30',        label: 'Доп. обзор' },
  needs_resubmission: { fg: 'text-amber-300', bg: 'bg-amber-900/30',        label: 'Доп. обзор' },
  expired:            { fg: 'text-amber-300', bg: 'bg-amber-900/30',        label: 'Обновление' },
};

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});
api.interceptors.request.use((cfg) => {
  const t = localStorage.getItem('admin_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

// ─────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────

export default function VerificationQueuePage() {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('actionable');
  const [kindFilter, setKindFilter] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {};
      if (statusFilter) params.status = statusFilter;
      if (kindFilter) params.kind = kindFilter;
      const res = await api.get<QueueResponse>('/admin/verification-queue', { params });
      setData(res.data);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить очередь');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter, kindFilter]);

  const counts = data?.counts || {};
  const totals = useMemo(() => ({
    pending: (counts.pending_review || 0) + (counts.uploaded || 0) + (counts.needs_resubmission || 0),
    approved: counts.approved || 0,
    rejected: counts.rejected || 0,
  }), [counts]);

  return (
    <div className="p-6 max-w-[1800px] mx-auto" data-testid="verification-queue-page">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <ShieldCheck className="w-7 h-7 text-amber-400" />
            Verification Queue
          </h1>
          <p className="text-sm text-zinc-400 mt-1">Документы инспекторов — approve / reject</p>
        </div>
        <button
          className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm text-zinc-200"
          onClick={() => load()}
          data-testid="verification-refresh"
        >
          <RefreshCcw className="w-4 h-4" /> Обновить
        </button>
      </div>

      {/* Roll-up KPIs */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Kpi label="В ОЧЕРЕДИ"   value={totals.pending}  tone="amber"   testid="kpi-pending" />
        <Kpi label="ОДОБРЕНО"     value={totals.approved} tone="emerald" testid="kpi-approved" />
        <Kpi label="ОТКЛОНЕНО"    value={totals.rejected} tone="rose"    testid="kpi-rejected" />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className="text-xs text-zinc-500 uppercase tracking-wider flex items-center gap-1">
          <Filter className="w-3 h-3" /> Фильтры
        </span>
        <FilterChip label="К действию" active={statusFilter === 'actionable'} onClick={() => setStatusFilter('actionable')} />
        <FilterChip label="На проверке" active={statusFilter === 'pending_review'} onClick={() => setStatusFilter('pending_review')} />
        <FilterChip label="Одобрено" active={statusFilter === 'approved'} onClick={() => setStatusFilter('approved')} />
        <FilterChip label="Отклонено" active={statusFilter === 'rejected'} onClick={() => setStatusFilter('rejected')} />
        <span className="w-px h-4 bg-zinc-700" />
        <select
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          data-testid="verification-kind-filter"
        >
          <option value="">Все типы</option>
          {Object.entries(KIND_LABEL).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </div>

      {error ? (
        <div className="p-4 bg-rose-950 border border-rose-700 rounded-lg flex items-center gap-3 text-rose-200">
          <AlertTriangle className="w-5 h-5" /> {error}
        </div>
      ) : null}

      {/* Table + drawer side-by-side */}
      <div className="grid grid-cols-12 gap-4">
        <div className={selectedId ? 'col-span-7' : 'col-span-12'}>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm" data-testid="verification-table">
              <thead className="bg-zinc-950">
                <tr className="text-left text-zinc-500 text-xs uppercase tracking-wider">
                  <th className="px-4 py-3">Инспектор</th>
                  <th className="px-4 py-3">Документ</th>
                  <th className="px-4 py-3">Загружено</th>
                  <th className="px-4 py-3">Статус</th>
                  <th className="px-4 py-3">Действия</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={5} className="px-4 py-12 text-center text-zinc-500">
                    <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Загрузка…
                  </td></tr>
                )}
                {!loading && (data?.items?.length || 0) === 0 && (
                  <tr><td colSpan={5} className="px-4 py-12 text-center text-zinc-500">
                    Очередь пуста для выбранных фильтров.
                  </td></tr>
                )}
                {(data?.items || []).map((it) => {
                  const tone = STATUS_TONE[it.status] || STATUS_TONE.uploaded;
                  return (
                    <tr
                      key={it.id}
                      className={`border-t border-zinc-800 hover:bg-zinc-800/40 cursor-pointer ${selectedId === it.id ? 'bg-zinc-800/60' : ''}`}
                      onClick={() => setSelectedId(it.id)}
                      data-testid={`verification-row-${it.id}`}
                    >
                      <td className="px-4 py-3">
                        <div className="text-zinc-100 font-medium">{it.inspector.name}</div>
                        <div className="text-zinc-500 text-xs">{it.inspector.email || it.inspector.phone || '—'}</div>
                      </td>
                      <td className="px-4 py-3 text-zinc-200">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-zinc-500" />
                          {KIND_LABEL[it.kind] || it.kind}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-zinc-400 text-xs">
                        {it.uploadedAt ? new Date(it.uploadedAt).toLocaleString('ru-RU') : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${tone.fg} ${tone.bg}`}>
                          {tone.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          className="text-xs text-amber-400 hover:text-amber-300 font-semibold"
                          onClick={(e) => { e.stopPropagation(); setSelectedId(it.id); }}
                        >
                          Открыть →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {selectedId ? (
          <div className="col-span-5">
            <Drawer docId={selectedId} onClose={() => setSelectedId(null)} onChange={load} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function Kpi({ label, value, tone, testid }: { label: string; value: number; tone: 'amber' | 'emerald' | 'rose'; testid: string }) {
  const cls = tone === 'amber' ? 'border-amber-700 bg-amber-950/30 text-amber-300'
            : tone === 'emerald' ? 'border-emerald-700 bg-emerald-950/30 text-emerald-300'
            : 'border-rose-700 bg-rose-950/30 text-rose-300';
  return (
    <div className={`p-4 rounded-xl border ${cls}`} data-testid={testid}>
      <div className="text-xs font-bold tracking-wider opacity-80">{label}</div>
      <div className="text-3xl font-black mt-1">{value}</div>
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-semibold transition ${
        active ? 'bg-amber-500 text-black' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
      }`}
    >{label}</button>
  );
}

function Drawer({ docId, onClose, onChange }: { docId: string; onClose: () => void; onChange: () => void }) {
  const [detail, setDetail] = useState<QueueDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('document_blurry');
  const [rejectNote, setRejectNote] = useState('');
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);

  // Sprint Verif-2: GridFS-stored docs don't carry inline base64 anymore.
  // We fetch the file as a blob (with admin JWT) and turn it into an
  // object URL so the <img> tag can render it.
  const [fileUrl, setFileUrl] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<QueueDetailResponse>(`/admin/verification-queue/${docId}`);
      setDetail(res.data);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Не удалось загрузить документ');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [docId]);

  // Resolve preview URL. New flow → authenticated blob fetch.
  // Legacy flow → inline base64 still works via data:URL.
  useEffect(() => {
    let revoke: string | null = null;
    (async () => {
      if (!detail) { setFileUrl(null); return; }
      const doc = detail.document as any;
      // Legacy: inline base64 still wins if present.
      if (doc.data && doc.mimeType) {
        setFileUrl(`data:${doc.mimeType};base64,${doc.data}`);
        return;
      }
      if (doc.hasFile) {
        try {
          const blobRes = await api.get(`/admin/verification-queue/${docId}/file`, { responseType: 'blob' });
          const url = URL.createObjectURL(blobRes.data as Blob);
          revoke = url;
          setFileUrl(url);
        } catch {
          setFileUrl(null);
        }
      } else {
        setFileUrl(null);
      }
    })();
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [detail, docId]);

  const approve = async () => {
    setSubmitting('approve');
    try {
      await api.post(`/admin/verification-queue/${docId}/approve`, { note: null });
      await load();
      onChange();
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Approve failed');
    } finally {
      setSubmitting(null);
    }
  };

  const reject = async () => {
    setSubmitting('reject');
    try {
      await api.post(`/admin/verification-queue/${docId}/reject`, { reason: rejectReason, note: rejectNote || null });
      await load();
      onChange();
      setRejecting(false);
      setRejectNote('');
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Reject failed');
    } finally {
      setSubmitting(null);
    }
  };

  if (loading) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center text-zinc-500">
        <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Загрузка…
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-zinc-300">
        {error}
        <button className="block mt-3 text-xs text-amber-400" onClick={onClose}>Закрыть</button>
      </div>
    );
  }

  const doc = detail.document;
  const tone = STATUS_TONE[doc.status] || STATUS_TONE.uploaded;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden sticky top-4" data-testid="verification-drawer">
      <div className="flex items-center justify-between p-4 border-b border-zinc-800">
        <div className="text-zinc-100 font-bold">{KIND_LABEL[doc.kind] || doc.kind}</div>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="p-4 space-y-4 max-h-[calc(100vh-180px)] overflow-y-auto">
        {/* Status */}
        <div>
          <span className={`inline-block px-2 py-1 rounded text-xs font-bold ${tone.fg} ${tone.bg}`}>
            {tone.label}
          </span>
        </div>

        {/* Inspector snapshot */}
        <Section label="ИНСПЕКТОР">
          <div className="text-sm text-zinc-100 font-semibold">{detail.inspector.name}</div>
          <div className="text-xs text-zinc-400">{detail.inspector.email || '—'}</div>
          {detail.inspector.phone ? <div className="text-xs text-zinc-400">{detail.inspector.phone}</div> : null}
          {detail.inspector.verification?.verificationScore != null ? (
            <div className="text-xs text-zinc-500 mt-1">
              Trust score: <span className="text-amber-400 font-bold">{detail.inspector.verification.verificationScore}%</span>
              {detail.inspector.verification.verified ? ' · ✓ verified' : ''}
            </div>
          ) : null}
        </Section>

        {/* Preview */}
        <Section label="ДОКУМЕНТ">
          {fileUrl ? (
            <img src={fileUrl} alt={doc.kind} className="w-full max-h-80 object-contain bg-zinc-950 rounded border border-zinc-800" />
          ) : (
            <div className="text-xs text-zinc-500 italic">Превью недоступно — файл сохранён без base64-данных.</div>
          )}
          <div className="text-xs text-zinc-500 mt-2">
            {doc.fileName || '—'} · {doc.mimeType || '—'}
          </div>
          {doc.uploadedAt ? (
            <div className="text-xs text-zinc-500">Загружено: {new Date(doc.uploadedAt).toLocaleString('ru-RU')}</div>
          ) : null}
          {doc.note ? <div className="text-xs text-zinc-400 mt-2">Комментарий инспектора: {doc.note}</div> : null}
        </Section>

        {/* Previous rejections */}
        {detail.rejectionHistory?.length ? (
          <Section label={`ИСТОРИЯ ОТКАЗОВ (${detail.rejectionHistory.length})`}>
            <div className="space-y-2">
              {detail.rejectionHistory.slice(0, 5).map((r) => (
                <div key={r.id} className="text-xs p-2 rounded border border-rose-900/50 bg-rose-950/20 text-rose-200">
                  <div className="font-semibold">{REJECTION_REASONS.find(x => x.value === r.reason)?.label || r.reason}</div>
                  {r.note ? <div className="text-rose-300/80 mt-0.5">{r.note}</div> : null}
                  <div className="text-rose-500/60 mt-1">{new Date(r.createdAt).toLocaleString('ru-RU')}</div>
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        {/* Existing rejection (current state) */}
        {doc.status === 'rejected' && (doc.rejectionReason || doc.rejectionNote) ? (
          <Section label="ТЕКУЩИЙ ОТКАЗ">
            <div className="p-3 rounded border border-rose-800 bg-rose-950/30 text-rose-200 text-xs">
              <div className="font-semibold">{REJECTION_REASONS.find(x => x.value === doc.rejectionReason)?.label || doc.rejectionReason}</div>
              {doc.rejectionNote ? <div className="mt-1">{doc.rejectionNote}</div> : null}
            </div>
          </Section>
        ) : null}

        {/* Actions */}
        {doc.status !== 'approved' && (
          <div className="space-y-3 pt-2">
            {!rejecting ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  className="flex items-center justify-center gap-2 py-2.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm disabled:opacity-50"
                  onClick={approve}
                  disabled={submitting !== null}
                  data-testid="verification-approve"
                >
                  <Check className="w-4 h-4" /> {submitting === 'approve' ? 'Одобряем…' : 'Одобрить'}
                </button>
                <button
                  className="flex items-center justify-center gap-2 py-2.5 rounded bg-rose-600 hover:bg-rose-500 text-white font-bold text-sm disabled:opacity-50"
                  onClick={() => setRejecting(true)}
                  disabled={submitting !== null}
                  data-testid="verification-reject-open"
                >
                  <X className="w-4 h-4" /> Отклонить
                </button>
              </div>
            ) : (
              <div className="space-y-2" data-testid="verification-reject-form">
                <div className="text-xs text-zinc-400 font-semibold uppercase tracking-wider">Заметка обзора</div>
                <div className="flex flex-wrap gap-1.5">
                  {REJECTION_REASONS.map((r) => (
                    <button
                      key={r.value}
                      onClick={() => setRejectReason(r.value)}
                      className={`px-2.5 py-1 rounded-full text-xs font-semibold transition ${
                        rejectReason === r.value ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                      }`}
                    >{r.label}</button>
                  ))}
                </div>
                <textarea
                  className="w-full bg-zinc-950 border border-zinc-700 rounded p-2 text-sm text-zinc-100 placeholder-zinc-500"
                  placeholder="Комментарий для инспектора (что конкретно не так)…"
                  rows={3}
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value)}
                  data-testid="verification-reject-note"
                />
                <div className="grid grid-cols-2 gap-2">
                  <button
                    className="py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm"
                    onClick={() => { setRejecting(false); setRejectNote(''); }}
                    disabled={submitting !== null}
                  >Отмена</button>
                  <button
                    className="py-2 rounded bg-rose-600 hover:bg-rose-500 text-white text-sm font-bold disabled:opacity-50"
                    onClick={reject}
                    disabled={submitting !== null}
                    data-testid="verification-reject-submit"
                  >{submitting === 'reject' ? 'Отклоняем…' : 'Подтвердить отказ'}</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-zinc-500 font-semibold tracking-wider uppercase mb-2">{label}</div>
      {children}
    </div>
  );
}

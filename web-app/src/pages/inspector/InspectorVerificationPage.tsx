/** /inspector/verification — document continuity. */
import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, IdentificationCard, UploadSimple, ArrowsClockwise, XCircle } from '@phosphor-icons/react';
import { inspectorAPI } from '../../services/api';
import { PageContainer, PageHeader, Section, Card, Spinner, ErrorBlock, Pill, GhostButton } from '../../components/inspector/cabinet/CabinetUI';

interface Doc {
  id: string | null; kind: string; status: string;
  fileName?: string | null; uploadedAt?: string | null; reviewedAt?: string | null; note?: string | null;
}

const KIND_LABEL: Record<string, string> = {
  passport: 'Паспорт / ID',
  businessRegistration: 'Регистрация ИП / GmbH',
  insurance: 'Страховка',
  taxId: 'Tax ID',
  toolsProof: 'Подтверждение инструментов',
  tuvCertificate: 'TÜV / сертификат',
};

// ─────────────────────────────────────────────────────────────────────
// Step 3 — restrained verification continuity vocabulary.
//
// Operational doctrine: verification is TRUST CONTINUITY, not a compliance
// score. The surface NEVER renders deficit framing ("N missing", "%",
// "rejected"). It only renders continuity adjectives:
//   • документация формируется         (no docs yet)
//   • документация продолжает формироваться  (partial)
//   • верификация подтверждена         (all approved)
//   • дополнительный обзор активен     (rejected / needs_resubmission)
//   • ожидает проверки                 (pending_review / uploaded)
//   • обновление документации          (expired)
// Tones are restricted to {success, warning, info, neutral}. `danger`
// is intentionally absent — punitive tone is forbidden here.
// ─────────────────────────────────────────────────────────────────────
function pillFor(status: string): { tone: 'success' | 'warning' | 'neutral' | 'info'; label: string } {
  switch (status) {
    case 'approved':
    case 'verified':            return { tone: 'success', label: 'подтверждено' };
    case 'pending_review':      return { tone: 'info',    label: 'ожидает проверки' };
    case 'uploaded':            return { tone: 'info',    label: 'отправлено' };
    case 'rejected':            return { tone: 'warning', label: 'доп. обзор' };
    case 'needs_resubmission':  return { tone: 'warning', label: 'доп. обзор' };
    case 'expired':             return { tone: 'warning', label: 'обновление' };
    default:                    return { tone: 'neutral', label: 'ожидает документации' };
  }
}

function continuityHeadline(overallStatus: string | undefined): string {
  if (overallStatus === 'verified') return 'Верификация подтверждена';
  if (overallStatus === 'partial')  return 'Документация продолжает формироваться';
  return 'Документация формируется';
}

export default function InspectorVerificationPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [meta, setMeta] = useState<{ totalRequired: number; verifiedCount: number; overallStatus: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadingKind, setUploadingKind] = useState<string | null>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = () => {
    setLoading(true);
    inspectorAPI.getVerification().then(r => {
      setDocs(r.data.documents); setMeta({ totalRequired: r.data.totalRequired, verifiedCount: r.data.verifiedCount, overallStatus: r.data.overallStatus });
      setLoading(false);
    }).catch(e => { setError(e?.message ?? 'load failed'); setLoading(false); });
  };
  useEffect(load, []);

  const onUpload = async (kind: string, file: File) => {
    setUploadingKind(kind); setError(null);
    try {
      const dataBase64: string = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      await inspectorAPI.uploadVerification({
        kind, fileName: file.name, mimeType: file.type, dataBase64,
      });
      load();
    } catch (e: unknown) { setError((e as { message?: string })?.message ?? 'upload failed'); }
    finally { setUploadingKind(null); }
  };

  if (loading) return <Spinner testId="verif-loading" />;

  return (
    <PageContainer>
      <PageHeader
        title="Верификация"
        subtitle={continuityHeadline(meta?.overallStatus)}
        testId="page-header-verification"
        actions={
          meta?.overallStatus === 'verified' ? (
            <Pill tone="success" testId="verif-overall">
              <ShieldCheck size={11} weight="fill" /> подтверждено
            </Pill>
          ) : null
        }
      />

      {error && <ErrorBlock message={error} />}

      <Section title="Документы">
        <div className="space-y-2" data-testid="verif-list">
          {docs.map(d => {
            const p = pillFor(d.status);
            return (
              <Card key={d.kind} className="px-4 py-3 flex items-center gap-4" testId={`verif-${d.kind}`}>
                <IdentificationCard size={18} className="text-zinc-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-zinc-900">{KIND_LABEL[d.kind] ?? d.kind}</div>
                  <div className="text-[11px] text-zinc-500 truncate">
                    {d.fileName ? `${d.fileName} · ` : ''}{d.uploadedAt ? new Date(d.uploadedAt).toLocaleString() : '—'}
                  </div>
                </div>
                <Pill tone={p.tone}>{p.label}</Pill>
                <input
                  ref={(el) => { fileRefs.current[d.kind] = el; }}
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={e => e.target.files?.[0] && onUpload(d.kind, e.target.files[0])}
                />
                <GhostButton onClick={() => fileRefs.current[d.kind]?.click()} disabled={uploadingKind === d.kind} data-testid={`verif-upload-${d.kind}`}>
                  {uploadingKind === d.kind ? <ArrowsClockwise size={12} className="inline animate-spin" /> : <UploadSimple size={12} className="inline" />}
                  {d.status === 'missing' ? ' Добавить документ' : ' Обновить документ'}
                </GhostButton>
                {d.id && d.status !== 'missing' && (
                  <button
                    onClick={() => inspectorAPI.patchVerificationStatus(d.id!, 'uploaded').then(load)}
                    className="text-zinc-400 hover:text-rose-500"
                    title="Сбросить статус"
                    data-testid={`verif-reset-${d.kind}`}
                  >
                    <XCircle size={14} />
                  </button>
                )}
              </Card>
            );
          })}
        </div>
        <div className="text-[11px] text-zinc-400 mt-2">
          Документация может пополняться по мере необходимости.
        </div>
      </Section>
    </PageContainer>
  );
}

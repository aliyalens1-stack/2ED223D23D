/**
 * LinkIngestStrip — single-input "paste URL → open vehicle memory".
 *
 * The world-generation primitive. One input. One submit. The user
 * pastes a mobile.de / autoscout24 / kleinanzeigen URL and we route
 * them straight into /vehicle/:id with the listing saved to the
 * persistent vehicle store. Idempotent: pasting the same URL twice
 * routes to the same vehicle.
 *
 * Failure modes (Step 11C — canonical-first):
 *   - hard fail (degradedReason ∈ HARD_FAIL_CODES) → inline error,
 *     no vehicle created.
 *   - soft fail (anti-bot / 4xx / timeout / weak) → vehicle is still
 *     created with `status="imported_soft"`, we navigate anyway.
 *     The substrate doctrine: parser failure must NEVER kill a
 *     vehicle context — an inspector opens the link manually.
 *   - matched   → vehicle already exists, navigate (no toast — feels native).
 *   - created   → fresh world entry, navigate.
 *
 * Hard/soft classification flows through `@platform/domain/parsers/canonical`
 * so this surface stays aligned with web customer intake (Step 11A) and
 * Expo customer intake (Step 11B).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Link as LinkIcon, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../services/api';
import { classifyParseFailure } from '@platform/domain/parsers/canonical';

const SAMPLES = [
  'https://www.mobile.de/...',
  'https://www.autoscout24.de/...',
  'https://www.kleinanzeigen.de/...',
];

interface IngestResp {
  status: 'created' | 'matched' | 'soft_fail';
  vehicleId: string | null;
  memoryUrl: string | null;
  // Step 11C — canonical envelope is the read source for hard/soft.
  // The keys below (`hardFail`, `softFail`, `error`) remain on the wire
  // for back-compat until Step 11D removes the legacy mirror.
  ok?: boolean;
  degradedReason?: string | null;
  parseCompleteness?: 'strong' | 'partial' | 'weak' | null;
  canonical?: {
    ok: boolean;
    source: string | null;
    parseCompleteness?: 'strong' | 'partial' | 'weak' | null;
    degradedReason?: string | null;
  } | null;
  // legacy mirror — kept on the type but no longer read on this surface
  hardFail?: boolean;
  softFail?: boolean;
  error?: string;
  hint?: string;
  vin?: { manufacturer?: string; modelYear?: number; country?: string } | null;
}

export default function LinkIngestStrip() {
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);

  async function submit() {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const { data } = await api.post<IngestResp>('/vehicles/ingest', { url: u });
      // Step 11C — canonical-first read. We prefer the nested envelope
      // (which is the contract surface from Step 10B), and fall back to
      // the flattened `degradedReason` mirror that the ingest endpoint
      // also publishes. Either way the shared classifier collapses
      // every failure code into hard / soft.
      const source = data.canonical?.source ?? null;
      const degraded = data.canonical?.degradedReason ?? data.degradedReason ?? null;
      const failure = classifyParseFailure(degraded, {
        sourceRecognised: !!source && source !== 'generic',
      });
      // Block establishment ONLY on hard-fail or missing vehicleId. A
      // soft-fail still produces an `imported_soft` vehicle and routes
      // the user into its memory — the substrate doctrine.
      if (failure === 'hard' || !data.vehicleId) {
        setErr(data.hint || 'Эта ссылка не распознана как объявление с поддерживаемых площадок.');
        return;
      }
      navigate(`/vehicle/${data.vehicleId}`);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setErr(msg || 'Не удалось обработать ссылку. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" data-testid="link-ingest-strip">
      <div
        className="rounded-2xl p-3 sm:p-4 border bg-white"
        style={{ borderColor: 'var(--border)', boxShadow: '0 1px 0 rgba(0,0,0,0.02), 0 8px 28px rgba(0,0,0,0.04)' }}
      >
        <div className="flex flex-col sm:flex-row gap-2 sm:items-stretch">
          <div className="flex-1 min-w-0 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 h-12 sm:h-14 rounded-xl bg-[var(--surface-soft)]">
            <LinkIcon size={16} className="shrink-0 text-[var(--text-soft)]" />
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={e => { setUrl(e.target.value); if (err) setErr(null); }}
              onFocus={() => setPlaceholderIdx((placeholderIdx + 1) % SAMPLES.length)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
              placeholder={`Вставь ссылку: ${SAMPLES[placeholderIdx]}`}
              className="flex-1 min-w-0 bg-transparent text-sm sm:text-[15px] placeholder:text-[var(--text-soft)] focus:outline-none"
              data-testid="link-ingest-input"
            />
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !url.trim()}
            className="h-12 sm:h-14 px-5 sm:px-7 rounded-xl bg-[var(--primary)] hover:bg-[#facc15] disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold text-sm inline-flex items-center justify-center gap-2 transition"
            data-testid="link-ingest-submit"
          >
            {busy ? (
              <><Loader2 size={16} className="animate-spin" /> Открываем…</>
            ) : (
              <>Открыть память <ArrowRight size={16} /></>
            )}
          </button>
        </div>

        {err ? (
          <div
            className="mt-2 flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
            style={{ background: 'rgba(239,68,68,0.06)', color: '#B91C1C' }}
            data-testid="link-ingest-error"
          >
            <AlertCircle size={14} className="shrink-0 mt-0.5" /> {err}
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-soft)]">
            <span className="font-bold tracking-wider uppercase">12 площадок</span>
            <span>· mobile.de</span>
            <span>· autoscout24</span>
            <span>· kleinanzeigen</span>
            <span>· otomoto · leboncoin · willhaben · …</span>
          </div>
        )}
      </div>
    </div>
  );
}

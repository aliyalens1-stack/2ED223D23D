/**
 * SaveSearchModal — "Подписаться на сегмент рынка".
 *
 * UX intentionally feels like a *subscription form*, not an "advanced
 * search". Submit produces a persistent market intent, the platform
 * keeps watching forever.
 *
 * Live preview: as the user types, we POST `/api/searches/preview` and
 * show "Сейчас в базе N машин под ваш запрос". This reframes the form
 * from "filters" to "supply you're claiming".
 */
import { useEffect, useRef, useState } from 'react';
import { X, Bell, Loader2, Check } from 'lucide-react';
import { api } from '../services/api';
import { getWatcherId } from '../lib/watcher';

interface Filter {
  brand?: string;
  model?: string;
  yearMin?: number;
  yearMax?: number;
  priceMax?: number;
  mileageMax?: number;
  city?: string;
  fuel?: string;
}

interface PreviewResp {
  label: string;
  count: number;
  samples: { vehicleId: string; brand: string; model: string; year?: number; price?: number; thumbnail?: string }[];
}

export interface SaveSearchModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  /** Pre-fill filter (e.g. derived from a vehicle the user is currently viewing). */
  prefill?: Filter;
  /** Override headline. Defaults to "Подписаться на рынок". */
  headline?: string;
  /** Optional explanatory line under headline. */
  subline?: string;
  /** Optional eyebrow text above headline. Defaults to "MARKET SUBSCRIPTION". */
  eyebrow?: string;
}

export default function SaveSearchModal({
  open, onClose, onSaved, prefill, headline, subline, eyebrow,
}: SaveSearchModalProps) {
  const [filter, setFilter] = useState<Filter>(prefill || {});
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed filter every time modal opens with a new prefill (e.g. opened
  // from different vehicle pages within the same session).
  useEffect(() => {
    if (open && prefill) setFilter(prefill);
    // open-only dep — we want re-seed only on open transition, not on every
    // prefill object identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Live preview as user edits.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const hasAny = Object.values(filter).some(v => v !== undefined && v !== '' && v !== null);
      if (!hasAny) {
        setPreview(null);
        return;
      }
      setPreviewing(true);
      try {
        const wid = getWatcherId();
        const r = await api.post<PreviewResp>('/searches/preview', { watcherId: wid, filter });
        setPreview(r.data);
      } catch {
        setPreview(null);
      } finally {
        setPreviewing(false);
      }
    }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [filter, open]);

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setSavedOk(false);
      // keep filter to feel persistent if user re-opens within session
    }
  }, [open]);

  if (!open) return null;

  function setField<K extends keyof Filter>(key: K, value: Filter[K] | undefined) {
    setFilter(prev => ({ ...prev, [key]: value === '' || value == null ? undefined : value }));
  }

  async function save() {
    const hasAny = Object.values(filter).some(v => v !== undefined && v !== '' && v !== null);
    if (!hasAny || saving) return;
    setSaving(true);
    try {
      await api.post('/searches', { watcherId: getWatcherId(), filter });
      setSavedOk(true);
      onSaved?.();
      setTimeout(() => { onClose(); setSavedOk(false); }, 1100);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose}
      data-testid="save-search-modal"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-[560px] bg-[#0F0F10] text-white rounded-t-3xl sm:rounded-2xl border border-white/10 shadow-2xl overflow-hidden"
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="min-w-0 pr-3">
            <div className="text-2xs uppercase tracking-[0.2em] text-amber">{eyebrow || 'MARKET SUBSCRIPTION'}</div>
            <h2 className="font-display tracking-bebas text-2xl mt-0.5">{headline || 'Подписаться на рынок'}</h2>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-md hover:bg-white/10 flex items-center justify-center shrink-0" aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>

        <div className="p-5 space-y-3">
          <p className="text-xs text-white/55 leading-relaxed">
            {subline || 'Опишите машину, которую ищете. Каждое новое объявление с поддерживаемых площадок проверяется на совпадение и попадает в вашу ленту.'}
          </p>

          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Марка" placeholder="BMW" value={filter.brand} onChange={v => setField('brand', v)} testid="ms-brand" />
            <Field label="Модель" placeholder="320d" value={filter.model} onChange={v => setField('model', v)} testid="ms-model" />
            <Field label="Город" placeholder="Berlin" value={filter.city} onChange={v => setField('city', v)} testid="ms-city" />
            <Field label="Топливо" placeholder="Дизель" value={filter.fuel} onChange={v => setField('fuel', v)} testid="ms-fuel" />
            <Field label="Год от" type="number" placeholder="2018" value={filter.yearMin} onChange={v => setField('yearMin', v ? +v : undefined)} testid="ms-year-min" />
            <Field label="Год до" type="number" placeholder="2022" value={filter.yearMax} onChange={v => setField('yearMax', v ? +v : undefined)} testid="ms-year-max" />
            <Field label="Цена ≤ €" type="number" placeholder="20000" value={filter.priceMax} onChange={v => setField('priceMax', v ? +v : undefined)} testid="ms-price-max" />
            <Field label="Пробег ≤ км" type="number" placeholder="120000" value={filter.mileageMax} onChange={v => setField('mileageMax', v ? +v : undefined)} testid="ms-mileage-max" />
          </div>

          {/* Live preview */}
          <div
            className="mt-2 rounded-xl p-3"
            style={{ background: 'rgba(255,176,32,0.06)', border: '1px solid rgba(255,176,32,0.18)' }}
            data-testid="ms-preview"
          >
            {previewing ? (
              <div className="flex items-center gap-2 text-xs text-white/60">
                <Loader2 size={12} className="animate-spin" /> считаем совпадения…
              </div>
            ) : preview ? (
              <>
                <div className="text-2xs uppercase tracking-widest text-amber mb-1">{preview.label}</div>
                <div className="text-sm">
                  Сейчас в базе <span className="font-display tracking-bebas text-amber text-xl align-middle">{preview.count}</span>{' '}
                  {preview.count === 1 ? 'машина' : preview.count >= 2 && preview.count <= 4 ? 'машины' : 'машин'} под ваш запрос
                </div>
                {preview.samples.length > 0 && (
                  <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
                    {preview.samples.slice(0, 6).map(s => (
                      <div key={s.vehicleId} className="shrink-0 w-16 h-16 rounded-md bg-white/5 overflow-hidden ring-1 ring-white/10">
                        {s.thumbnail ? <img src={s.thumbnail} alt="" className="w-full h-full object-cover" /> : null}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-white/45">Заполните хотя бы одно поле — покажем сколько совпадений уже есть.</div>
            )}
          </div>
        </div>

        <footer className="flex items-center gap-2 px-5 py-4 border-t border-white/10 bg-black/40">
          <button onClick={onClose} className="px-4 h-11 rounded-xl text-sm hover:bg-white/8" data-testid="ms-cancel">Отмена</button>
          <button
            onClick={save}
            disabled={saving || !preview || preview.count < 0}
            className="ml-auto inline-flex items-center gap-2 h-11 px-5 rounded-xl bg-amber text-black font-semibold text-sm disabled:opacity-50 hover:bg-yellow-300 transition"
            data-testid="ms-save"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : savedOk ? <Check size={14} /> : <Bell size={14} />}
            {savedOk ? 'Подписан' : 'Сохранить подписку'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, placeholder, value, onChange, type, testid }: {
  label: string; placeholder: string; value: string | number | undefined; onChange: (v: string) => void; type?: string; testid: string;
}) {
  return (
    <label className="block">
      <div className="text-2xs uppercase tracking-widest text-white/50 mb-1">{label}</div>
      <input
        type={type || 'text'}
        placeholder={placeholder}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={e => onChange(e.target.value)}
        className="w-full h-10 px-3 rounded-md bg-white/5 border border-white/10 text-sm focus:border-amber focus:outline-none placeholder:text-white/30"
        data-testid={testid}
      />
    </label>
  );
}

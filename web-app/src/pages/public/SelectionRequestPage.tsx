// Sprint 2 — Auto Request Core. Real form (replaces Sprint 1 placeholder).
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ClipboardCheck, ArrowLeft, X, Plus, ShieldCheck } from 'lucide-react';

const DEFAULT_CITIES = ['Berlin', 'München', 'Hamburg', 'Frankfurt', 'Köln', 'Stuttgart', 'Düsseldorf', 'Paris', 'Wien', 'Warszawa'];

export default function SelectionRequestPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState('');
  const [cities, setCities] = useState<string[]>([]);
  const [cityInput, setCityInput] = useState('');
  const [links, setLinks] = useState<string[]>(['']);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addCity = (c: string) => {
    const v = c.trim();
    if (!v) return;
    if (cities.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    if (cities.length >= 10) return;
    setCities([...cities, v]);
    setCityInput('');
  };

  const removeCity = (c: string) => setCities(cities.filter((x) => x !== c));

  const updateLink = (i: number, v: string) => {
    const copy = [...links];
    copy[i] = v;
    setLinks(copy);
  };
  const addLinkRow = () => links.length < 10 && setLinks([...links, '']);
  const removeLinkRow = (i: number) => setLinks(links.filter((_, idx) => idx !== i));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!brand.trim() || !model.trim()) {
      setError(t('selection_request.err.required_brand_model')); return;
    }
    const budgetN = parseInt(budget, 10);
    if (!Number.isFinite(budgetN) || budgetN < 500 || budgetN > 500000) {
      setError(t('selection_request.err.budget_range')); return;
    }
    if (cities.length === 0) {
      setError(t('selection_request.err.at_least_one_city')); return;
    }
    setLoading(true);
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch('/api/customer/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          brand: brand.trim(),
          model: model.trim(),
          budget: budgetN,
          links: links.map((l) => l.trim()).filter(Boolean),
          cities,
          comment: comment.trim() || undefined,
        }),
      });
      if (!res.ok) {
        if (res.status === 402) {
          const data = await res.json().catch(() => ({}));
          setError(`${t('selection_request.err.need_credits', { defaultValue: 'You need more inspection credits' })} — ${data.required || cities.length} needed, ${data.available || 0} available. Redirecting to /packages…`);
          setTimeout(() => navigate('/packages'), 1500);
          return;
        }
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const data = await res.json();
      navigate(`/dashboard/requests/${data.id}`);
    } catch (err: any) {
      setError(err?.message || 'request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 md:px-6 py-10" data-testid="selection-request-page">
      <Link to="/" className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-6" data-testid="selection-request-back">
        <ArrowLeft size={16} /> {t('common.back')}
      </Link>

      <h1 className="text-3xl md:text-4xl font-extrabold leading-tight" data-testid="selection-request-title">
        {t('selection_request.title')}
      </h1>
      <p className="mt-3 text-[var(--text-2)] max-w-2xl">
        {t('selection_request.subtitle')}
      </p>

      <form onSubmit={submit} className="mt-8 rounded-2xl border border-[var(--border)] bg-white p-6 shadow-[var(--shadow-card)] space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('selection_request.fields.brand')}>
            <input
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="BMW"
              className="fld-input"
              data-testid="sr-brand"
              required
            />
          </Field>
          <Field label={t('selection_request.fields.model')}>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="320d"
              className="fld-input"
              data-testid="sr-model"
              required
            />
          </Field>
          <Field label={t('selection_request.fields.budget_max')}>
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="20000"
              inputMode="numeric"
              className="fld-input"
              data-testid="sr-budget"
              required
            />
          </Field>
        </div>

        {/* Cities multi-select */}
        <Field label={t('selection_request.fields.cities')}>
          <div className="flex flex-wrap gap-1.5 mb-2" data-testid="sr-cities-chips">
            {cities.map((c) => (
              <span key={c} className="inline-flex items-center gap-1 rounded-full bg-[var(--primary-soft)] text-[var(--primary-h)] px-3 py-1 text-sm font-bold" data-testid={`sr-city-chip-${c}`}>
                {c}
                <button type="button" onClick={() => removeCity(c)} aria-label={`remove ${c}`} className="hover:text-[var(--text)]">
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={cityInput}
              onChange={(e) => setCityInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCity(cityInput); } }}
              placeholder="Berlin, Paris…"
              className="fld-input flex-1"
              data-testid="sr-city-input"
            />
            <button type="button" onClick={() => addCity(cityInput)} className="btn-dark" data-testid="sr-city-add">
              <Plus size={14} /> {t('selection_request.add')}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {DEFAULT_CITIES.filter((c) => !cities.includes(c)).slice(0, 8).map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => addCity(c)}
                className="rounded-full border border-[var(--border)] bg-[var(--surface-soft)] px-3 py-1 text-xs font-bold hover:border-[var(--primary)]"
                data-testid={`sr-city-suggest-${c}`}
              >
                + {c}
              </button>
            ))}
          </div>
        </Field>

        {/* Links */}
        <Field label={t('selection_request.fields.links')}>
          <div className="space-y-2" data-testid="sr-links">
            {links.map((l, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={l}
                  onChange={(e) => updateLink(i, e.target.value)}
                  placeholder={t('selection_request.fields.links_placeholder')}
                  className="fld-input flex-1"
                  data-testid={`sr-link-${i}`}
                />
                {links.length > 1 && (
                  <button type="button" onClick={() => removeLinkRow(i)} className="btn-dark px-3" aria-label="remove link">
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
            {links.length < 10 && (
              <button type="button" onClick={addLinkRow} className="text-sm font-bold text-[var(--primary-h)] hover:underline" data-testid="sr-link-add">
                + {t('selection_request.add_link')}
              </button>
            )}
          </div>
        </Field>

        <Field label={t('selection_request.fields.comment')} optional>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder={t('selection_request.fields.comment_placeholder')}
            className="fld-input resize-none"
            data-testid="sr-comment"
          />
        </Field>

        {error && (
          <div className="rounded-xl border border-red-300 bg-red-50 text-red-800 px-4 py-3 text-sm font-bold" data-testid="sr-error">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button type="submit" disabled={loading} className="btn-primary btn-lg disabled:opacity-60" data-testid="sr-submit">
            <ClipboardCheck size={16} /> {loading ? t('common.loading') : t('selection_request.submit')}
          </button>
          <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-soft)]">
            <ShieldCheck size={14} /> {t('selection_request.hint_no_payment_yet')}
          </span>
        </div>
      </form>

      <style>{`.fld-input{width:100%;border:1px solid var(--border);background:var(--surface-soft);border-radius:12px;padding:10px 12px;font-size:14px;outline:none}.fld-input:focus{border-color:var(--primary);background:#fff}`}</style>
    </div>
  );
}

function Field({ label, optional, children }: { label: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-soft)]">
        {label}{optional ? ' · (optional)' : ''}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

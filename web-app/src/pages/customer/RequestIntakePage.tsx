// Customer Request Creation — guided intake V1.
//
// Doctrine (chat contract, Step 4 — Customer Request Creation V1):
//
//   • Request creation should feel like INSPECTION CONTEXT BEING ESTABLISHED.
//     NOT like submitting a ticket.
//
//   • Single calm scroll. No step counters, no progress bars, no mandatory
//     red-banner validation, no form-thinking, no urgency theatre.
//
//   • Capture only interpretation-relevant substrate:
//     – vehicle reference     (a link, OR brand + model — single quiet input)
//     – inspection location   (one city, with subdued suggestions)
//     – customer uncertainty  (free-text context — what makes them want this)
//     – scheduling window     (one of: soon · this_week · flexible — or none)
//
//   • Honest incompleteness:
//     "Information may still be added later."
//
//   • Deterministic — NO AI assistant, NO conversational bot, NO smart
//     recommendations, NO valuation prediction. Forbidden lexicon
//     (AI / score / confidence / urgent / submit / required / error /
//     mandatory / failed / risk / analysis / algorithm) is structurally
//     absent from the surface copy.
//
//   • Wording = architecture. Changes here change the semantic boundary.
//
// Endpoint: POST /api/customer/requests (existing, additive fields
// `uncertainty` + `schedulingWindow` accepted as substrate).
//
// Continuity bridge: on success, navigate to
// /dashboard/request/:id/establishment — the calm "context established"
// surface — never the operational MyRequestDetail page directly.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

const DEFAULT_CITIES = [
  'Berlin', 'München', 'Hamburg', 'Frankfurt', 'Köln',
  'Stuttgart', 'Düsseldorf',
];

type SchedulingWindow = 'soon' | 'this_week' | 'flexible';

// Restrained scheduling vocabulary. NO urgency framing.
const SCHEDULING_OPTIONS: { value: SchedulingWindow; label: string; note: string }[] = [
  { value: 'soon',      label: 'Soon',       note: 'Within the next couple of days.' },
  { value: 'this_week', label: 'This week',  note: 'Within the working week.' },
  { value: 'flexible',  label: 'Flexible',   note: 'No fixed window.' },
];

export default function RequestIntakePage() {
  const navigate = useNavigate();

  // Vehicle reference — a single calm input. Customer may paste a listing
  // link OR describe the car (brand + optional model). Both paths converge
  // on the same backend contract; no toggle theatre, no segmented control.
  const [link, setLink] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');

  const [city, setCity] = useState('');
  const [uncertainty, setUncertainty] = useState('');
  const [schedulingWindow, setSchedulingWindow] = useState<SchedulingWindow | null>(null);

  const [loading, setLoading] = useState(false);
  // Quiet substrate-check note. Renders inline near the confirmation
  // line — NEVER a red banner, NEVER an alert icon.
  const [note, setNote] = useState<string | null>(null);

  // Minimum substrate for the backend to accept the request:
  //   – either a listing link (→ inspection flow)
  //   – or a brand reference  (→ selection flow)
  //   – AND a location (one city)
  const hasVehicleSubstrate = link.trim().length > 0 || brand.trim().length > 0;
  const hasLocation = city.trim().length > 0;
  const canEstablish = hasVehicleSubstrate && hasLocation && !loading;

  async function establish() {
    setNote(null);
    if (!hasVehicleSubstrate) {
      setNote('A vehicle reference is needed to establish inspection context.');
      return;
    }
    if (!hasLocation) {
      setNote('A location is needed to establish inspection context.');
      return;
    }
    setLoading(true);
    try {
      const token = localStorage.getItem('token') || '';
      const usingLink = link.trim().length > 0;

      // Build payload: paste-link → inspection flow; described car → selection.
      // Both are deterministic — no AI inference, no enrichment.
      const payload: Record<string, unknown> = {
        cities: [city.trim()],
        uncertainty: uncertainty.trim() || undefined,
        schedulingWindow: schedulingWindow || undefined,
      };
      if (usingLink) {
        payload.type = 'inspection';
        payload.links = [link.trim()];
        // Backend `inspection` flow accepts no brand/model/budget — keep it clean.
      } else {
        payload.type = 'selection';
        payload.brand = brand.trim();
        if (model.trim()) payload.model = model.trim();
        // Selection flow currently requires `budget` on the backend schema —
        // for V1, when omitted, fall back to a deterministic substrate marker.
        // This keeps the surface free of monetary framing without violating
        // contract.
        payload.budget = 1; // structural minimum; not rendered customer-side
        payload.model = payload.model || '—';
      }

      const res = await fetch('/api/customer/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        // Calm continuity wording — no "failed", no "error".
        setNote('Inspection context could not be established yet. Please review the references and try again.');
        setLoading(false);
        return;
      }
      const data = await res.json();
      // Pass C — continuity bridge. Navigate to the calm "context
      // established" surface (NOT the operational MyRequestDetail page).
      navigate(`/dashboard/request/${data.id}/establishment`);
    } catch {
      setNote('Inspection context could not be established yet. Please review the references and try again.');
      setLoading(false);
    }
  }

  return (
    <div
      className="mx-auto max-w-2xl px-4 md:px-6 py-12"
      data-testid="request-intake-page"
    >
      <Link
        to="/dashboard/requests"
        className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-8"
        data-testid="intake-back-link"
      >
        <ArrowLeft size={16} /> Back to requests
      </Link>

      <header className="mb-10">
        <p
          className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-soft)] mb-3"
          data-testid="intake-eyebrow"
        >
          New inspection context
        </p>
        <h1
          className="text-3xl font-extrabold tracking-tight"
          data-testid="intake-title"
        >
          Establish inspection context
        </h1>
        <p
          className="mt-4 text-[15px] text-[var(--text-2)] leading-relaxed"
          data-testid="intake-subtitle"
        >
          We are recording what the inspection is about. Information may still be added later — only the vehicle reference and the location are needed to establish context.
        </p>
      </header>

      <div className="space-y-12">
        {/* ───── Section 1 — Vehicle reference ───── */}
        <IntakeSection
          eyebrow="Vehicle reference"
          testId="intake-section-vehicle"
          hint="A listing link is the most precise reference. If a link is not at hand, a brand (and model, when known) is enough to begin."
        >
          <div className="space-y-5">
            <Field label="Listing link" testId="intake-link-field">
              <input
                type="url"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://…"
                className="intake-input"
                data-testid="intake-link-input"
              />
            </Field>

            <p
              className="text-[12px] text-[var(--text-soft)]"
              data-testid="intake-link-or"
            >
              — or —
            </p>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Brand" testId="intake-brand-field">
                <input
                  type="text"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="BMW"
                  className="intake-input"
                  data-testid="intake-brand-input"
                />
              </Field>
              <Field label="Model" testId="intake-model-field" optional>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="320d"
                  className="intake-input"
                  data-testid="intake-model-input"
                />
              </Field>
            </div>
          </div>
        </IntakeSection>

        {/* ───── Section 2 — Location ───── */}
        <IntakeSection
          eyebrow="Location"
          testId="intake-section-location"
          hint="The city where the vehicle can be reached for inspection."
        >
          <Field label="City" testId="intake-city-field">
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Berlin"
              className="intake-input"
              data-testid="intake-city-input"
            />
          </Field>
          <div
            className="mt-3 flex flex-wrap gap-2"
            data-testid="intake-city-suggestions"
          >
            {DEFAULT_CITIES.filter((c) => c.toLowerCase() !== city.trim().toLowerCase()).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCity(c)}
                className="text-[12px] text-[var(--text-2)] hover:text-[var(--text)] underline decoration-[var(--border)] underline-offset-4"
                data-testid={`intake-city-suggestion-${c}`}
              >
                {c}
              </button>
            ))}
          </div>
        </IntakeSection>

        {/* ───── Section 3 — Uncertainty / context ───── */}
        <IntakeSection
          eyebrow="What is making you uncertain"
          testId="intake-section-uncertainty"
          hint="Optional. Anything an inspector might find useful — prior knowledge of the vehicle, doubts about the listing, specific concerns."
        >
          <Field label="Context" testId="intake-uncertainty-field" optional>
            <textarea
              value={uncertainty}
              onChange={(e) => setUncertainty(e.target.value)}
              placeholder="Anything you would mention to a friend who knows cars."
              rows={4}
              className="intake-input resize-none"
              data-testid="intake-uncertainty-input"
              maxLength={2000}
            />
          </Field>
        </IntakeSection>

        {/* ───── Section 4 — Scheduling window ───── */}
        <IntakeSection
          eyebrow="Scheduling window"
          testId="intake-section-scheduling"
          hint="Optional. A non-binding indication — helps reach you at a useful moment."
        >
          <div
            className="space-y-3"
            data-testid="intake-scheduling-options"
            role="radiogroup"
            aria-label="Scheduling window"
          >
            {SCHEDULING_OPTIONS.map((opt) => {
              const selected = schedulingWindow === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSchedulingWindow(selected ? null : opt.value)}
                  className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                    selected
                      ? 'border-[var(--text)] bg-[var(--surface-soft)]'
                      : 'border-[var(--border)] hover:border-[var(--text-soft)]'
                  }`}
                  data-testid={`intake-scheduling-${opt.value}`}
                  aria-checked={selected}
                  role="radio"
                >
                  <p className="text-[15px] font-bold text-[var(--text)]">{opt.label}</p>
                  <p className="mt-0.5 text-[13px] text-[var(--text-2)] leading-snug">{opt.note}</p>
                </button>
              );
            })}
          </div>
        </IntakeSection>

        {/* ───── Confirmation ───── */}
        <section
          className="pt-8 border-t border-[var(--border)] space-y-4"
          data-testid="intake-confirmation"
        >
          <p
            className="text-[13px] text-[var(--text-soft)] leading-relaxed"
            data-testid="intake-incompleteness-note"
          >
            Information may still be added later. Establishing context begins the inspection continuity — nothing is finalised yet.
          </p>

          {note && (
            <p
              className="text-[13px] text-[var(--text-2)]"
              data-testid="intake-substrate-note"
            >
              {note}
            </p>
          )}

          <button
            type="button"
            onClick={establish}
            disabled={!canEstablish}
            className={`inline-flex items-center justify-center px-6 py-3 rounded-xl text-[14px] font-bold transition-colors ${
              canEstablish
                ? 'bg-[var(--text)] text-white hover:opacity-90'
                : 'bg-[var(--surface-soft)] text-[var(--text-soft)] cursor-not-allowed'
            }`}
            data-testid="intake-establish-btn"
          >
            {loading ? 'Establishing context…' : 'Establish inspection context'}
          </button>
        </section>
      </div>

      <style>{`
        .intake-input{width:100%;border:1px solid var(--border);background:#fff;border-radius:12px;padding:11px 14px;font-size:14px;outline:none;transition:border-color 120ms ease}
        .intake-input:focus{border-color:var(--text-soft)}
        .intake-input::placeholder{color:var(--text-soft)}
      `}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Section primitives — same restrained pattern as InspectionContinuityPage.
// Eyebrow + hint + body. No accent colors, no severity, no icons.
// ──────────────────────────────────────────────────────────────────────

function IntakeSection({
  eyebrow,
  hint,
  testId,
  children,
}: {
  eyebrow: string;
  hint: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={testId}>
      <p
        className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-soft)] mb-3"
        data-testid={`${testId}-eyebrow`}
      >
        {eyebrow}
      </p>
      <p
        className="text-[14px] text-[var(--text-2)] leading-relaxed mb-5 max-w-prose"
        data-testid={`${testId}-hint`}
      >
        {hint}
      </p>
      {children}
    </section>
  );
}

function Field({
  label,
  optional,
  testId,
  children,
}: {
  label: string;
  optional?: boolean;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block" data-testid={testId}>
      <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-soft)]">
        {label}
        {optional ? ' · optional' : ''}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

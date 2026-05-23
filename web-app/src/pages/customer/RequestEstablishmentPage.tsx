// Request Establishment — Pass C continuity bridge.
//
// Doctrine (Step 4 — guided intake V1):
//
//   • This surface is the bridge between "creation" and "tracking".
//     There is NO hard transition: the customer never sees "Your ticket
//     has been submitted." They see "Inspection context established."
//
//   • Restrained continuity vocabulary, same shape as
//     InspectionContinuityPage. Eyebrow + body. No celebration, no
//     confetti, no scoreboards, no progress estimation.
//
//   • Substrate captured = what we recorded, rendered VERBATIM (vehicle
//     reference, location, scheduling window). Customer uncertainty is
//     a structural signal — its presence is acknowledged with a calm
//     line, but the text itself is NOT mirrored back as decorative copy
//     (mirroring it back into the surface invites the customer to edit
//     it as if it were a form field; that is form-thinking).
//
//   • Continuity references (link plumbing only):
//       – view all requests (always)
//       – view this request's operational detail (always)
//       – view inspection continuity (only if a job has been claimed —
//         i.e. an inspector is engaged; before that the link is
//         structurally absent from the DOM).
//
//   • Wording vocabulary forbidden here: success / submitted / created /
//     thank you / done / complete / step / progress / next / completed.
//
// Read endpoints:
//   GET /api/customer/requests/{id}        — base substrate
//   GET /api/customer/requests/{id}/jobs   — to detect if continuity exists

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

type RequestDoc = {
  id: string;
  type: 'inspection' | 'selection';
  brand: string;
  model: string;
  links: string[];
  cities: string[];
  uncertainty?: string | null;
  schedulingWindow?: 'soon' | 'this_week' | 'flexible' | null;
};

type Job = {
  id?: string;
  _id?: string;
  inspectorId?: string | null;
  status?: string;
  city?: string;
};

const SCHEDULING_LABEL: Record<NonNullable<RequestDoc['schedulingWindow']>, string> = {
  soon: 'Soon — within the next couple of days.',
  this_week: 'This week — within the working week.',
  flexible: 'Flexible — no fixed window.',
};

export default function RequestEstablishmentPage() {
  const { id } = useParams<{ id: string }>();
  const [req, setReq] = useState<RequestDoc | null>(null);
  const [firstJob, setFirstJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const token = localStorage.getItem('token') || '';
        const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
        const [rReq, rJobs] = await Promise.all([
          fetch(`/api/customer/requests/${id}`, { headers }),
          fetch(`/api/customer/requests/${id}/jobs`, { headers }),
        ]);
        if (cancelled) return;
        if (rReq.status === 404) {
          setError('Inspection context not found.');
          setReq(null);
          return;
        }
        if (!rReq.ok) {
          setError('Inspection context not yet readable.');
          setReq(null);
          return;
        }
        const reqJson = (await rReq.json()) as RequestDoc;
        setReq(reqJson);
        if (rJobs.ok) {
          const jobsJson = await rJobs.json();
          const jobs: Job[] = jobsJson?.jobs || [];
          // Continuity becomes referenceable once an inspector is engaged
          // on at least one job. Otherwise no continuity-bridge link.
          const engaged = jobs.find((j) => j.inspectorId);
          setFirstJob(engaged || null);
        }
      } catch {
        if (!cancelled) {
          setError('Inspection context not yet readable.');
          setReq(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div
      className="mx-auto max-w-2xl px-4 md:px-6 py-12"
      data-testid="request-establishment-page"
    >
      <Link
        to="/dashboard/requests"
        className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-8"
        data-testid="establishment-back-link"
      >
        <ArrowLeft size={16} /> Back to requests
      </Link>

      <header className="mb-10">
        <h1
          className="text-3xl font-extrabold tracking-tight"
          data-testid="establishment-title"
        >
          Inspection context established
        </h1>
      </header>

      {loading && (
        <p
          className="text-sm text-[var(--text-2)]"
          data-testid="establishment-loading"
        >
          Loading…
        </p>
      )}

      {!loading && error && (
        <p
          className="text-base text-[var(--text-2)] leading-relaxed"
          data-testid="establishment-error-state"
        >
          {error}
        </p>
      )}

      {!loading && !error && req && (
        <article className="space-y-12" data-testid="establishment-readout">
          {/* Current state — single restrained line, never "submitted". */}
          <Section
            eyebrow="Current state"
            body="Context recorded. Inspector engagement is forming."
            testId="establishment-state"
          />

          {/* Substrate captured — verbatim from what was recorded. No
              re-interpretation, no AI summarisation. */}
          <Section
            eyebrow="Vehicle reference"
            body={describeVehicle(req)}
            testId="establishment-vehicle"
          />

          <Section
            eyebrow="Location"
            body={(req.cities[0] || '—')}
            testId="establishment-location"
          />

          {req.schedulingWindow && (
            <Section
              eyebrow="Scheduling window"
              body={SCHEDULING_LABEL[req.schedulingWindow]}
              testId="establishment-scheduling"
            />
          )}

          {/* Customer uncertainty: presence is acknowledged, content is
              NOT mirrored back into the surface (form-thinking trap). */}
          {req.uncertainty && req.uncertainty.trim().length > 0 && (
            <Section
              eyebrow="Context recorded"
              body="Your notes have been recorded and will reach the inspector."
              testId="establishment-uncertainty-ack"
            />
          )}

          {/* Honest incompleteness — same line as the intake. */}
          <p
            className="text-[13px] text-[var(--text-soft)] leading-relaxed"
            data-testid="establishment-incompleteness-note"
          >
            Information may still be added later. The inspection context will continue to form as an inspector engages.
          </p>

          {/* Continuity references — pure link plumbing. */}
          <section
            className="pt-8 border-t border-[var(--border)] space-y-3"
            data-testid="establishment-references"
          >
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-soft)] mb-2">
              References
            </p>
            <div className="space-y-2">
              <div>
                <Link
                  to={`/dashboard/requests/${req.id}`}
                  className="text-[14px] text-[var(--text-2)] hover:text-[var(--text)] underline decoration-[var(--border)] underline-offset-4"
                  data-testid="establishment-request-detail-link"
                >
                  View this request
                </Link>
              </div>
              {/*
                Continuity link is structurally ABSENT from the DOM until
                an inspector engages — no disabled state, no "coming soon".
              */}
              {firstJob && (firstJob.id || firstJob._id) && (
                <div data-testid="establishment-continuity-bridge">
                  <Link
                    to={`/dashboard/inspection/${firstJob.id || firstJob._id}/continuity`}
                    className="text-[14px] text-[var(--text-2)] hover:text-[var(--text)] underline decoration-[var(--border)] underline-offset-4"
                    data-testid="establishment-continuity-link"
                  >
                    View inspection continuity
                  </Link>
                </div>
              )}
              <div>
                <Link
                  to="/dashboard/requests"
                  className="text-[14px] text-[var(--text-2)] hover:text-[var(--text)] underline decoration-[var(--border)] underline-offset-4"
                  data-testid="establishment-requests-list-link"
                >
                  All inspection contexts
                </Link>
              </div>
            </div>
          </section>
        </article>
      )}
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────

function describeVehicle(req: RequestDoc): string {
  if (req.type === 'inspection' && req.links.length > 0) {
    return req.links[0];
  }
  const parts: string[] = [];
  if (req.brand) parts.push(req.brand);
  if (req.model && req.model !== '—') parts.push(req.model);
  if (parts.length === 0) return '—';
  return parts.join(' ');
}

function Section({
  eyebrow,
  body,
  testId,
}: {
  eyebrow: string;
  body: string;
  testId: string;
}) {
  return (
    <section data-testid={testId}>
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-soft)] mb-3">
        {eyebrow}
      </p>
      <p
        className="text-[17px] leading-relaxed text-[var(--text)] break-words"
        data-testid={`${testId}-body`}
      >
        {body}
      </p>
    </section>
  );
}

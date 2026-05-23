/**
 * UX-4B Inspection Forensics — Investigation Workspace.
 *
 * Not a log table. This is an admin-only workspace for forensic review of
 * inspection sessions:
 *  - Jobs list with trust-level badges (deterministic, not punitive)
 *  - Vertical timeline rail of events for the selected job
 *  - Suspicion badges per event (color-coded by code)
 *  - Aggregate trust score + flag counts
 *  - Evidence drill-down (click event → modal with full provenance + image)
 *
 * Stays silent: no moderation actions here. visibility + provenance only.
 */
import { useState, useEffect, useMemo } from 'react';
import {
  Shield, AlertTriangle, Camera, FileCheck, Play, Search,
  MapPin, Clock, Smartphone, Hash, X, Image as ImageIcon,
  GitCompareArrows,
} from 'lucide-react';
import { adminAPI } from '../services/api';

// ---------- Types ----------------------------------------------------------

interface FlagCounts { [code: string]: number }

interface TimelineSummary {
  totalEvents: number;
  suspicionCount: number;
  flagCounts: FlagCounts;
  trustLevel: 'low_risk' | 'review_recommended' | 'high_concern';
}

interface JobRow {
  jobId: string;
  status: string;
  inspectorId: string | null;
  customerId: string | null;
  vehicle: any;
  city: string | null;
  createdAt: string;
  updatedAt: string;
  reportId: string | null;
  timelineSummary: TimelineSummary;
}

interface Suspicion { code: string; msg: string }

interface Provenance {
  capturedAt?: string;
  uploadedAt?: string;
  uploadDelaySec?: number | null;
  deviceModel?: string | null;
  geoLat?: number | null;
  geoLng?: number | null;
  geoDistanceFromJobKm?: number | null;
  context?: string | null;
  expectedContext?: string | null;
  qualityPassed?: boolean | null;
  brightness?: number | null;
  width?: number | null;
  height?: number | null;
  sha256?: string | null;
}

interface TimelineEvent {
  id: string;
  jobId: string;
  reportId: string | null;
  eventType: string;
  actorId: string;
  at: string;
  payload: any;
  provenance: Provenance;
  suspicion: Suspicion[];
}

interface TimelineResponse {
  jobId: string;
  totalEvents: number;
  suspicionCount: number;
  flagCounts: FlagCounts;
  events: TimelineEvent[];
}

// ---------- Visual helpers -------------------------------------------------

const SUSPICION_META: Record<string, { label: string; color: string; tooltip: string }> = {
  CONTEXT_MISMATCH: {
    label: 'CTX', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    tooltip: 'Captured context differs from what the item expected',
  },
  DUPLICATE_HASH: {
    label: 'DUP', color: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
    tooltip: 'Same SHA-256 already uploaded to this job',
  },
  RAPID_BURST: {
    label: 'BURST', color: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
    tooltip: 'Many uploads in a short window — possibly batched',
  },
  LATE_UPLOAD: {
    label: 'LATE', color: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    tooltip: 'Captured long before it was uploaded',
  },
  FAR_FROM_JOB: {
    label: 'GEO', color: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30',
    tooltip: 'Photo geo is far from the job location',
  },
  QUALITY_FAIL: {
    label: 'QUAL', color: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
    tooltip: 'Client-side quality heuristic flagged this photo',
  },
};

const TRUST_META: Record<TimelineSummary['trustLevel'], { label: string; color: string; icon: any }> = {
  low_risk: { label: 'Low risk', color: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', icon: Shield },
  review_recommended: { label: 'Review', color: 'bg-amber-500/15 text-amber-300 border-amber-500/30', icon: AlertTriangle },
  high_concern: { label: 'High concern', color: 'bg-rose-500/15 text-rose-300 border-rose-500/30', icon: AlertTriangle },
};

const EVENT_ICON: Record<string, any> = {
  'inspection.started': Play,
  'item.flagged_critical': AlertTriangle,
  'item.flagged_warning': AlertTriangle,
  'media.uploaded': Camera,
  'report.submitted': FileCheck,
  'evidence.gaps_overridden': AlertTriangle,
  // OCR-1 + correlation layer — admin sees these too.
  'ocr.vin_detected': Hash,
  'ocr.odometer_detected': Hash,
  'ocr.corrected': Hash,
  'correlation.signal_raised': GitCompareArrows,
};

function eventIcon(eventType: string) {
  if (eventType.startsWith('media.uploaded')) return Camera;
  return EVENT_ICON[eventType] || Clock;
}

function shortId(id: string | null | undefined) {
  if (!id) return '—';
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit',
                                        day: '2-digit', month: 'short' });
  } catch { return iso; }
}

// ---------- Main page ------------------------------------------------------

export default function InspectionForensicsPage() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [drillEvent, setDrillEvent] = useState<TimelineEvent | null>(null);
  const [drillMediaUrl, setDrillMediaUrl] = useState<string | null>(null);

  // Load jobs list
  const loadJobs = async () => {
    setJobsLoading(true);
    try {
      const res = await adminAPI.listRecentInspectionJobs({
        limit: 100,
        status: statusFilter || undefined,
      });
      setJobs(res.data.jobs || []);
    } catch (err) {
      console.error('[forensics] load jobs failed', err);
    } finally {
      setJobsLoading(false);
    }
  };

  useEffect(() => { loadJobs(); }, [statusFilter]);

  // Load timeline for selected job
  useEffect(() => {
    if (!selectedJobId) { setTimeline(null); return; }
    setTimelineLoading(true);
    adminAPI.getInspectionTimeline(selectedJobId)
      .then((res) => setTimeline(res.data))
      .catch((err) => {
        console.error('[forensics] load timeline failed', err);
        setTimeline(null);
      })
      .finally(() => setTimelineLoading(false));
  }, [selectedJobId]);

  const filteredJobs = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return jobs;
    return jobs.filter((j) =>
      j.jobId.toLowerCase().includes(term)
      || (j.city || '').toLowerCase().includes(term)
      || (j.inspectorId || '').toLowerCase().includes(term)
      || (j.customerId || '').toLowerCase().includes(term)
    );
  }, [jobs, search]);

  // Load image when drilling into a media.uploaded event
  useEffect(() => {
    setDrillMediaUrl(null);
    if (!drillEvent || !drillEvent.eventType.startsWith('media.uploaded')) return;
    const mediaId = drillEvent.payload?.mediaId;
    if (!mediaId) return;
    adminAPI.getInspectionMedia(drillEvent.jobId, mediaId)
      .then((res) => {
        const b64 = res.data?.base64 || res.data?.media?.base64;
        const mime = res.data?.mimeType || res.data?.media?.mimeType || 'image/jpeg';
        if (b64) setDrillMediaUrl(`data:${mime};base64,${b64}`);
      })
      .catch((err) => console.error('[forensics] media fetch failed', err));
  }, [drillEvent]);

  return (
    <div className="p-6 space-y-6" data-testid="inspection-forensics-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white flex items-center gap-3">
            <Shield className="w-7 h-7 text-emerald-400" />
            Inspection Forensics
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            UX-4B silent auditability — provenance, suspicion flags, and forensic timeline.
            <span className="ml-2 text-amber-400/70">No moderation actions. visibility + provenance only.</span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* ── Jobs list (left) ─────────────────────────────────── */}
        <div className="col-span-12 lg:col-span-4 bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-3" data-testid="forensics-jobs-list">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search jobId / city / inspector…"
                className="w-full bg-slate-950/50 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50"
                data-testid="forensics-search-input"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-slate-950/50 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
              data-testid="forensics-status-filter"
            >
              <option value="">all</option>
              <option value="open">open</option>
              <option value="claimed">claimed</option>
              <option value="inspecting">inspecting</option>
              <option value="done">done</option>
              <option value="report_ready">report_ready</option>
            </select>
          </div>

          {jobsLoading ? (
            <div className="text-center py-12 text-slate-500 text-sm">Loading…</div>
          ) : filteredJobs.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-sm">No jobs</div>
          ) : (
            <div className="space-y-2 max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
              {filteredJobs.map((job) => {
                const meta = TRUST_META[job.timelineSummary.trustLevel];
                const TrustIcon = meta.icon;
                const isSelected = selectedJobId === job.jobId;
                return (
                  <button
                    key={job.jobId}
                    onClick={() => setSelectedJobId(job.jobId)}
                    className={`w-full text-left rounded-lg border px-3 py-3 transition-colors ${
                      isSelected
                        ? 'border-emerald-500/50 bg-emerald-500/5'
                        : 'border-slate-800 bg-slate-950/40 hover:border-slate-700 hover:bg-slate-900/50'
                    }`}
                    data-testid={`forensics-job-row-${job.jobId}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-mono text-xs text-slate-300 truncate">
                        {shortId(job.jobId)}
                      </div>
                      <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-medium ${meta.color}`}>
                        <TrustIcon className="w-3 h-3" />
                        {meta.label}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-[11px] text-slate-500">
                      <span>{job.status}</span>
                      <span>•</span>
                      <span>{job.city || '—'}</span>
                      <span className="ml-auto text-slate-400">
                        {job.timelineSummary.totalEvents} ev · {job.timelineSummary.suspicionCount} flag
                      </span>
                    </div>
                    {Object.keys(job.timelineSummary.flagCounts).length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {Object.entries(job.timelineSummary.flagCounts).map(([code, n]) => {
                          const m = SUSPICION_META[code] || { label: code.slice(0, 4), color: 'bg-slate-700 text-slate-300 border-slate-600' };
                          return (
                            <span key={code} className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${m.color}`}>
                              {m.label}×{n}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Timeline rail (right) ────────────────────────────── */}
        <div className="col-span-12 lg:col-span-8 bg-slate-900/60 border border-slate-800 rounded-xl p-6" data-testid="forensics-timeline-panel">
          {!selectedJobId ? (
            <div className="text-center py-24 text-slate-500">
              <Shield className="w-12 h-12 mx-auto text-slate-700 mb-3" />
              <p>Select a job on the left to inspect its forensic timeline.</p>
            </div>
          ) : timelineLoading ? (
            <div className="text-center py-24 text-slate-500 text-sm">Loading timeline…</div>
          ) : !timeline ? (
            <div className="text-center py-24 text-rose-400 text-sm">Failed to load timeline.</div>
          ) : (
            <>
              {/* Summary header */}
              <div className="flex flex-wrap items-center gap-4 mb-6 pb-6 border-b border-slate-800">
                <div>
                  <div className="text-xs text-slate-500 uppercase">Job</div>
                  <div className="font-mono text-sm text-white">{timeline.jobId}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 uppercase">Events</div>
                  <div className="text-2xl font-semibold text-white" data-testid="forensics-total-events">
                    {timeline.totalEvents}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 uppercase">Suspicion count</div>
                  <div className={`text-2xl font-semibold ${timeline.suspicionCount === 0 ? 'text-emerald-400' : 'text-amber-400'}`}
                       data-testid="forensics-suspicion-count">
                    {timeline.suspicionCount}
                  </div>
                </div>
                <div className="ml-auto flex flex-wrap gap-1">
                  {Object.entries(timeline.flagCounts).map(([code, n]) => {
                    const m = SUSPICION_META[code] || { label: code, color: 'bg-slate-700 text-slate-300 border-slate-600', tooltip: code };
                    return (
                      <span key={code} title={m.tooltip}
                            className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium border ${m.color}`}>
                        {m.label} <span className="opacity-70 ml-1">×{n}</span>
                      </span>
                    );
                  })}
                </div>
              </div>

              {/* Vertical timeline rail */}
              {timeline.events.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-sm">
                  No timeline events yet — this job has not produced inspection activity.
                </div>
              ) : (
                <div className="relative pl-8" data-testid="forensics-timeline-rail">
                  <div className="absolute left-3 top-0 bottom-0 w-px bg-slate-800" />
                  {timeline.events.map((ev, idx) => {
                    const Icon = eventIcon(ev.eventType);
                    const hasSuspicion = (ev.suspicion || []).length > 0;
                    const isMedia = ev.eventType.startsWith('media.uploaded');
                    return (
                      <button
                        key={ev.id || `${ev.at}-${idx}`}
                        onClick={() => setDrillEvent(ev)}
                        className="relative w-full text-left mb-4 group"
                        data-testid={`forensics-event-${idx}`}
                      >
                        <div className={`absolute -left-8 top-1.5 w-6 h-6 rounded-full border-2 flex items-center justify-center ${
                          hasSuspicion ? 'bg-amber-500/20 border-amber-400 text-amber-300'
                                       : 'bg-slate-800 border-slate-700 text-slate-300'
                        }`}>
                          <Icon className="w-3 h-3" />
                        </div>
                        <div className={`rounded-lg border px-4 py-3 transition-colors ${
                          hasSuspicion ? 'border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10'
                                       : 'border-slate-800 bg-slate-950/40 hover:bg-slate-900/50'
                        }`}>
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-sm font-medium text-white">{ev.eventType}</div>
                              <div className="text-[11px] text-slate-500 mt-0.5">{fmtTime(ev.at)} · actor {shortId(ev.actorId)}</div>
                            </div>
                            <div className="flex flex-wrap gap-1 justify-end max-w-[40%]">
                              {(ev.suspicion || []).map((s, i) => {
                                const m = SUSPICION_META[s.code] || { label: s.code, color: 'bg-slate-700 text-slate-300 border-slate-600', tooltip: s.msg };
                                return (
                                  <span key={i} title={s.msg}
                                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${m.color}`}>
                                    {m.label}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                          {/* Inline preview line */}
                          {isMedia && (
                            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-400">
                              {ev.provenance.context && (
                                <span>ctx: <span className="text-slate-200">{ev.provenance.context}</span>
                                  {ev.provenance.expectedContext && ev.provenance.expectedContext !== ev.provenance.context && (
                                    <span className="text-amber-400"> ≠ {ev.provenance.expectedContext}</span>
                                  )}
                                </span>
                              )}
                              {ev.provenance.uploadDelaySec != null && (
                                <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{ev.provenance.uploadDelaySec}s</span>
                              )}
                              {ev.provenance.geoDistanceFromJobKm != null && (
                                <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{ev.provenance.geoDistanceFromJobKm} km</span>
                              )}
                              {ev.provenance.deviceModel && (
                                <span className="flex items-center gap-1"><Smartphone className="w-3 h-3" />{ev.provenance.deviceModel}</span>
                              )}
                            </div>
                          )}
                          {ev.payload?.sectionId && (
                            <div className="mt-2 text-[11px] text-slate-500">
                              → section <span className="text-slate-300">{ev.payload.sectionId}</span>
                              {ev.payload.itemId && <> · item <span className="text-slate-300">{ev.payload.itemId}</span></>}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Drill-down modal */}
      {drillEvent && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4"
             onClick={() => setDrillEvent(null)}
             data-testid="forensics-drill-modal">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-800 sticky top-0 bg-slate-900">
              <div>
                <div className="text-xs text-slate-500 uppercase">Event</div>
                <div className="text-lg font-semibold text-white">{drillEvent.eventType}</div>
              </div>
              <button onClick={() => setDrillEvent(null)} className="p-1 text-slate-400 hover:text-white" data-testid="forensics-drill-close">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-5">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <Detail label="When" value={fmtTime(drillEvent.at)} />
                <Detail label="Actor" value={drillEvent.actorId} mono />
                <Detail label="Job" value={drillEvent.jobId} mono />
                <Detail label="Report" value={drillEvent.reportId || '—'} mono />
              </div>

              {drillEvent.suspicion?.length > 0 && (
                <div>
                  <div className="text-xs text-slate-500 uppercase mb-2">Suspicion ({drillEvent.suspicion.length})</div>
                  <div className="space-y-2">
                    {drillEvent.suspicion.map((s, i) => {
                      const m = SUSPICION_META[s.code] || { label: s.code, color: 'bg-slate-700 text-slate-300 border-slate-600', tooltip: '' };
                      return (
                        <div key={i} className={`flex items-start gap-2 rounded-lg px-3 py-2 border ${m.color}`}>
                          <span className="text-xs font-semibold">{m.label}</span>
                          <span className="text-xs opacity-90">{s.msg}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {drillEvent.provenance && Object.keys(drillEvent.provenance).length > 0 && (
                <div>
                  <div className="text-xs text-slate-500 uppercase mb-2">Provenance</div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {drillEvent.provenance.capturedAt && <Detail label="Captured at" value={fmtTime(drillEvent.provenance.capturedAt)} />}
                    {drillEvent.provenance.uploadedAt && <Detail label="Uploaded at" value={fmtTime(drillEvent.provenance.uploadedAt)} />}
                    {drillEvent.provenance.uploadDelaySec != null && <Detail label="Upload delay" value={`${drillEvent.provenance.uploadDelaySec}s`} />}
                    {drillEvent.provenance.deviceModel && <Detail label="Device" value={drillEvent.provenance.deviceModel} />}
                    {drillEvent.provenance.context && (
                      <Detail label="Context" value={
                        drillEvent.provenance.expectedContext && drillEvent.provenance.expectedContext !== drillEvent.provenance.context
                          ? `${drillEvent.provenance.context} (expected ${drillEvent.provenance.expectedContext})`
                          : drillEvent.provenance.context
                      } />
                    )}
                    {drillEvent.provenance.geoLat != null && drillEvent.provenance.geoLng != null && (
                      <Detail label="Geo" value={`${drillEvent.provenance.geoLat}, ${drillEvent.provenance.geoLng}`} />
                    )}
                    {drillEvent.provenance.geoDistanceFromJobKm != null && (
                      <Detail label="Distance from job" value={`${drillEvent.provenance.geoDistanceFromJobKm} km`} />
                    )}
                    {drillEvent.provenance.qualityPassed != null && (
                      <Detail label="Quality" value={drillEvent.provenance.qualityPassed ? 'passed' : 'failed'} />
                    )}
                    {drillEvent.provenance.width && drillEvent.provenance.height && (
                      <Detail label="Dimensions" value={`${drillEvent.provenance.width}×${drillEvent.provenance.height}px`} />
                    )}
                    {drillEvent.provenance.sha256 && (
                      <Detail label="SHA-256" value={drillEvent.provenance.sha256} mono full />
                    )}
                  </div>
                </div>
              )}

              {/* Media preview if event has mediaId */}
              {drillEvent.eventType.startsWith('media.uploaded') && (
                <div>
                  <div className="text-xs text-slate-500 uppercase mb-2 flex items-center gap-2">
                    <ImageIcon className="w-3 h-3" /> Evidence preview
                  </div>
                  {drillMediaUrl ? (
                    <img src={drillMediaUrl} alt="evidence" className="max-h-[400px] rounded-lg border border-slate-800" />
                  ) : (
                    <div className="text-xs text-slate-500 italic">Loading image…</div>
                  )}
                </div>
              )}

              {drillEvent.payload && Object.keys(drillEvent.payload).length > 0 && (
                <div>
                  <div className="text-xs text-slate-500 uppercase mb-2">Payload</div>
                  <pre className="text-[11px] text-slate-300 bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-x-auto">
                    {JSON.stringify(drillEvent.payload, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value, mono = false, full = false }: { label: string; value: string; mono?: boolean; full?: boolean }) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <div className="text-[11px] text-slate-500 uppercase">{label}</div>
      <div className={`text-sm text-slate-200 ${mono ? 'font-mono' : ''} break-all`}>{value}</div>
    </div>
  );
}

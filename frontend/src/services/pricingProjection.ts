/**
 * pricingProjection — thin client for /api/pricing/project endpoints.
 *
 * Used by booking flows to render the cost breakdown live as the user
 * picks an inspector / pickup point. Logic intentionally stays on the
 * backend — this file is just a typed fetch helper.
 */
import { api } from './api';
import type { PricingProjection } from '../components/PricingBreakdown';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface ProjectInput {
  basePrice: number;
  currency?: string;
  // Provide either distanceKm OR both inspectorBase + vehicleLocation.
  distanceKm?: number;
  inspectorBase?: GeoPoint;
  vehicleLocation?: GeoPoint;
}

/** Preview projection — does NOT persist. Use during quote/booking selection. */
export async function previewProjection(input: ProjectInput): Promise<PricingProjection> {
  const { data } = await api.post<PricingProjection>('/pricing/project', input);
  return data;
}

/** Freeze projection against a job ID — idempotent upsert. Use on confirm. */
export async function freezeProjection(
  jobId: string,
  input: ProjectInput,
): Promise<PricingProjection> {
  const { data } = await api.post<PricingProjection>(
    `/pricing/project/${encodeURIComponent(jobId)}`,
    input,
  );
  return data;
}

/** Read frozen projection for an existing job. */
export async function getProjection(jobId: string): Promise<PricingProjection | null> {
  try {
    const { data } = await api.get<PricingProjection>(
      `/pricing/project/${encodeURIComponent(jobId)}`,
    );
    return data;
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

/** Lock the projection as customer-accepted — IMMUTABLE thereafter. */
export async function confirmProjection(jobId: string): Promise<PricingProjection> {
  const { data } = await api.post<PricingProjection>(
    `/pricing/project/${encodeURIComponent(jobId)}/confirm`,
  );
  return data;
}

/** Inspector view — includes `inspectorDistancePayout`. Requires
 *  authenticated inspector token. Returns `null` on 404. */
export async function getInspectorJobPricing(jobId: string): Promise<PricingProjection | null> {
  try {
    const { data } = await api.get<PricingProjection>(
      `/inspector/jobs/${encodeURIComponent(jobId)}/pricing`,
    );
    return data;
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

/** Admin view — full doc, read-only. Requires admin token. */
export async function getAdminProjection(jobId: string): Promise<PricingProjection | null> {
  try {
    const { data } = await api.get<PricingProjection>(
      `/admin/pricing/projections/${encodeURIComponent(jobId)}`,
    );
    return data;
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

// ── Pricing-3: request-level customer quote ───────────────────────────

export interface QuoteJobLine {
  jobId: string;
  city: string;
  projection: PricingProjection & { _city?: string };
}

export interface RequestQuote {
  requestId: string;
  pricingVersion: string;
  currency: string;
  customerTotal: number;
  manualReview: boolean;
  status: 'pending' | 'confirmed' | 'mixed';
  digest: string;
  jobs: QuoteJobLine[];
}

export interface RequestQuoteInput {
  basePrice?: number;
  vehicleLocation?: GeoPoint;
  inspectorBases?: { city: string; location: GeoPoint }[];
}

/** Preview / refresh request-level quote.
 *  Confirmed jobs stay locked (per Pricing-2 invariant). */
export async function previewRequestQuote(
  requestId: string,
  input: RequestQuoteInput = {},
): Promise<RequestQuote> {
  const { data } = await api.post<RequestQuote>(
    `/customer/requests/${encodeURIComponent(requestId)}/quote`,
    input,
  );
  return data;
}

/** Read current quote (pending or confirmed). Null when none exists yet. */
export async function getRequestQuote(requestId: string): Promise<RequestQuote | null> {
  try {
    const { data } = await api.get<RequestQuote>(
      `/customer/requests/${encodeURIComponent(requestId)}/quote`,
    );
    return data;
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

/** Customer accepts — confirms ALL jobs of the request atomically, then
 *  writes a `car_requests.pricing` snapshot. Payment code must read from
 *  this snapshot, never recompute. */
export async function confirmRequestQuote(requestId: string): Promise<RequestQuote> {
  const { data } = await api.post<RequestQuote>(
    `/customer/requests/${encodeURIComponent(requestId)}/quote/confirm`,
  );
  return data;
}

export interface TierInfo {
  tier: 'soft_remote' | 'standard_remote' | 'far_remote';
  minKm: number;
  maxKm: number | null;
  ratePerKm: number;
  minimumFee: number;
  manualReview: boolean;
}

export interface TiersResponse {
  pricingVersion: string;
  currency: string;
  includedKm: number;
  inspectorPayoutPct: number;
  platformFeePct: number;
  tiers: TierInfo[];
}

/** Canonical tier table — used to render explanations / admin views. */
export async function getTiers(): Promise<TiersResponse> {
  const { data } = await api.get<TiersResponse>('/pricing/tiers');
  return data;
}

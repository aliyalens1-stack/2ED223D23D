// Vehicle Memory client — thin axios wrapper over /api/customer/vehicles.
// Used by the candidate list screen and the "Save vehicle" CTA in the
// auto-request create flow. Mirrors the backend Vehicle / VehicleCreate /
// VehicleUpdate shapes (see app/backend/app/vehicles/schemas.py).
//
// Sprint 2C — Vehicle Workspace: extends the type with `status` + `activity`
// timeline events, plus an `appendActivity` helper.

import { api } from './api';

export type VehicleStatus = 'saved' | 'inspection_requested' | 'inspection_completed' | 'purchased' | 'archived' | string;

export type ActivityEvent = {
  type: string;            // open string — see backend ActivityType
  at: string;              // ISO datetime
  text?: string | null;
};

export type Vehicle = {
  id: string;
  customerId: string;
  brand: string;
  model: string;
  year?: number | null;
  mileage?: number | null;
  price?: number | null;
  currency?: string | null;
  location?: string | null;
  fuel?: string | null;
  transmission?: string | null;
  thumbnail?: string | null;
  listing_url?: string | null;
  source?: string | null;
  external_source_id?: string | null;
  notes?: string | null;
  status?: VehicleStatus | null;
  createdAt: string;
  updatedAt: string;
  activity?: ActivityEvent[];
};

export type VehicleCreate = Omit<Vehicle, 'id' | 'customerId' | 'createdAt' | 'updatedAt' | 'activity'>;
export type VehicleUpdate = Partial<Omit<VehicleCreate, 'source' | 'external_source_id' | 'currency'>> & {
  notes?: string | null;
  status?: VehicleStatus | null;
};

export const vehiclesApi = {
  list: () => api.get<Vehicle[]>('/customer/vehicles').then((r) => r.data),
  get: (id: string) => api.get<Vehicle>(`/customer/vehicles/${id}`).then((r) => r.data),
  // P4.1 — Vehicle Linkage timeline aggregator. Returns:
  //   { vehicle, reports[], quotes[], payments[], bookings[] }
  // ALL refs are already in the LinkedXxxRef wire shape that the
  // shared `VehicleMemoryProjectionInput` expects (see
  // app/vehicles/timeline.py + @platform/domain/contracts/vehicle).
  // P4.2 — same endpoint shared with web-app. Mobile MUST consume
  // exactly this aggregator: no client-side fan-out, no fork.
  getTimeline: (id: string) =>
    api.get<{
      vehicle: Vehicle;
      reports: any[];
      quotes: any[];
      payments: any[];
      bookings: any[];
    }>(`/customer/vehicles/${id}/timeline`).then((r) => r.data),
  create: (payload: VehicleCreate) =>
    api.post<Vehicle>('/customer/vehicles', payload).then((r) => r.data),
  update: (id: string, patch: VehicleUpdate) =>
    api.patch<Vehicle>(`/customer/vehicles/${id}`, patch).then((r) => r.data),
  remove: (id: string) =>
    api.delete<void>(`/customer/vehicles/${id}`).then(() => undefined),
  // Sprint 2C — append a timeline event without mutating other fields.
  // Status changes go through `update()` — this endpoint is purely log-append.
  appendActivity: (id: string, type: string, text?: string) =>
    api.post<Vehicle>(`/customer/vehicles/${id}/activity`, { type, text }).then((r) => r.data),
};


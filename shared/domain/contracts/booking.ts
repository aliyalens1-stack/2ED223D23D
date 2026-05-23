/**
 * Booking — entity contract.
 *
 * Mirrors the backend's `bookings` / `web_bookings` collection shape.
 * Single source of truth for booking-related types across surfaces.
 *
 * Backend reference: `/api/bookings/*`, `/api/marketplace/booking/*`.
 */

/**
 * The seven canonical states a booking can be in.
 *
 * Matches the literal values used in MongoDB and emitted by the API.
 * Do not add cosmetic aliases (e.g. `'on_the_way'` vs `'on_route'`) —
 * if the backend changes the literal, change it here once.
 */
export type BookingStatus =
  | 'pending'      // created, awaiting provider confirmation
  | 'confirmed'    // provider accepted, not yet en route
  | 'on_route'     // provider is travelling to the customer
  | 'arrived'      // provider is at the location, work not yet started
  | 'in_progress'  // work is happening
  | 'completed'    // work finished successfully
  | 'cancelled';   // terminated by either party (or expired)

export const BOOKING_STATUSES: readonly BookingStatus[] = [
  'pending',
  'confirmed',
  'on_route',
  'arrived',
  'in_progress',
  'completed',
  'cancelled',
] as const;

/**
 * Minimal Booking shape consumed by surfaces.
 *
 * Surfaces may receive richer payloads (provider details, vehicle, payment
 * etc.) — those live on each page's view-model, not here. This type only
 * carries fields whose semantics are the *same* on every surface.
 */
export interface Booking {
  id: string;
  status: BookingStatus;
  customerId?: string | null;
  providerId?: string | null;
  serviceId?: string | null;
  /** ISO-8601 string. Backend stores TZ-aware UTC; surfaces convert to local. */
  scheduledAt?: string | null;
  /** ISO-8601 string. */
  createdAt: string;
  /** ISO-8601 string. */
  updatedAt?: string | null;
  /** Whether a payment has settled for this booking. */
  isPaid?: boolean;
}

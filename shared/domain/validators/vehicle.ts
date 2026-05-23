/**
 * Vehicle field validators — extracted in Shared Domain 0C.
 *
 * Why these specifically (and nothing else):
 *
 *   - `mileage` already had two callsites with conflicting handling:
 *     `backend/app/vehicles/schemas.py` enforces `ge=0, le=2_000_000`,
 *     `web-app/src/pages/customer/CustomerGarage.tsx` did `Number(x) || 0`
 *     — silently coerced negatives, NaN, and "9999999999" to 0 or
 *     accepted them whole. That's a real, observed inconsistency.
 *   - `vehicleYear` had similar drift: backend default `new Date().getFullYear()`,
 *     no client-side check at all. Any year accepted, including
 *     `-100` and `9999`.
 *
 * What this file does NOT include (per Shared Domain 0C discipline):
 *
 *   - `vin` — UX still iterating on whether 17-char strict or relaxed.
 *   - `plate` — country-specific format, premature.
 *   - `color` — string field, no range/enum agreed.
 *   - `brand`/`model` — free-text catalogues, not validators.
 *
 * Shape rule: each validator returns a discriminated result. Consumers
 * never read raw error strings as enums; they pattern-match on `code`
 * if they want surface-specific messages. This is the same shape we
 * will reuse for any future stable validator (money, listing URL, …).
 */

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ValidationErrorCode; message: string };

/** Stable error codes — surfaces translate these into user copy. */
export type ValidationErrorCode =
  | 'required'
  | 'not_a_number'
  | 'below_min'
  | 'above_max'
  | 'not_an_integer';

// ─────────────────────────────────────────────────────────────────────
// Mileage — kilometres on the odometer.
//
// Range mirrors backend Pydantic: `ge=0, le=2_000_000`. Cars beyond 2M
// km exist but are rare enough that we assume data-entry error and
// reject. Adjust here if the backend bound moves; both sides MUST stay
// in sync (single source of truth: this file → backend in 0D when we
// add Python codegen / shared schema).
// ─────────────────────────────────────────────────────────────────────

export const MILEAGE_MIN_KM = 0;
export const MILEAGE_MAX_KM = 2_000_000;

export function validateMileage(input: unknown): ValidationResult<number> {
  // Empty input is allowed at this level; surfaces decide whether
  // mileage is required for a given form. (Customer Garage allows
  // unknown mileage on car insertion.)
  if (input === '' || input === null || input === undefined) {
    return { ok: true, value: 0 };
  }
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) {
    return { ok: false, code: 'not_a_number', message: 'Mileage must be a number' };
  }
  if (!Number.isInteger(n)) {
    return { ok: false, code: 'not_an_integer', message: 'Mileage must be a whole number of km' };
  }
  if (n < MILEAGE_MIN_KM) {
    return { ok: false, code: 'below_min', message: `Mileage cannot be negative` };
  }
  if (n > MILEAGE_MAX_KM) {
    return { ok: false, code: 'above_max', message: `Mileage looks unrealistic (max ${MILEAGE_MAX_KM.toLocaleString('en')} km)` };
  }
  return { ok: true, value: n };
}

// ─────────────────────────────────────────────────────────────────────
// Vehicle year — model year of the car.
//
// Lower bound 1900 — hard-coded floor, not data-driven. Cars older
// than that exist but are museum pieces, not service-marketplace
// inventory; we'd rather force the user to retype than accept a typo
// like 1099.
//
// Upper bound is "current calendar year + 1" — manufacturers ship
// next-model-year cars in summer, so e.g. in May 2026 a 2027-model is
// legitimate. The +1 buffer comes from the actual product (German
// dealer inventory frequently lists +1MY).
// ─────────────────────────────────────────────────────────────────────

export const VEHICLE_YEAR_MIN = 1900;
export function vehicleYearMax(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

export function validateVehicleYear(
  input: unknown,
  now: Date = new Date(),
): ValidationResult<number> {
  if (input === '' || input === null || input === undefined) {
    return { ok: false, code: 'required', message: 'Vehicle year is required' };
  }
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) {
    return { ok: false, code: 'not_a_number', message: 'Year must be a number' };
  }
  if (!Number.isInteger(n)) {
    return { ok: false, code: 'not_an_integer', message: 'Year must be a whole number' };
  }
  const max = vehicleYearMax(now);
  if (n < VEHICLE_YEAR_MIN) {
    return { ok: false, code: 'below_min', message: `Year cannot be earlier than ${VEHICLE_YEAR_MIN}` };
  }
  if (n > max) {
    return { ok: false, code: 'above_max', message: `Year cannot be later than ${max}` };
  }
  return { ok: true, value: n };
}

// ─────────────────────────────────────────────────────────────────────
// Self-test invariants — same pattern as state-machine modules.
// Surfaces opt in via `assertVehicleValidatorInvariants()`. Tree-shaken
// in production. Aggregated by `assertSharedDomainInvariants()`.
// ─────────────────────────────────────────────────────────────────────

export function assertVehicleValidatorInvariants(): void {
  const eq = <T>(a: T, b: T, label: string) => {
    if (a !== b) {
      throw new Error(
        `vehicle validator invariant failed: ${label} (got=${String(a)} want=${String(b)})`,
      );
    }
  };
  const ok = (r: ValidationResult<number>, label: string) => {
    if (!r.ok) {
      const err = r as { ok: false; code: string; message: string };
      throw new Error(`expected ok for ${label}, got ${err.code}: ${err.message}`);
    }
  };
  const fail = (r: ValidationResult<number>, code: ValidationErrorCode, label: string) => {
    const err = r as { ok: false; code: ValidationErrorCode };
    if (r.ok || err.code !== code) {
      throw new Error(`expected fail(${code}) for ${label}, got ${JSON.stringify(r)}`);
    }
  };

  // mileage — typical valid path
  ok(validateMileage(0), 'mileage 0');
  ok(validateMileage(1), 'mileage 1');
  ok(validateMileage(150_000), 'mileage 150k');
  ok(validateMileage(MILEAGE_MAX_KM), 'mileage at max');
  // string coercion for form inputs
  ok(validateMileage('123456'), 'mileage stringified');
  // empty inputs default to 0 (surfaces gate "required" themselves)
  ok(validateMileage(''), 'empty string → 0');
  ok(validateMileage(null), 'null → 0');
  ok(validateMileage(undefined), 'undefined → 0');
  if ((validateMileage('') as { ok: true; value: number }).value !== 0) {
    throw new Error('empty mileage should default to 0');
  }
  // failure modes
  fail(validateMileage('abc'), 'not_a_number', 'non-numeric string');
  fail(validateMileage(NaN), 'not_a_number', 'NaN');
  fail(validateMileage(Infinity), 'not_a_number', 'Infinity');
  fail(validateMileage(123.45), 'not_an_integer', 'fractional km');
  fail(validateMileage(-1), 'below_min', 'negative mileage');
  fail(validateMileage(MILEAGE_MAX_KM + 1), 'above_max', 'mileage too high');

  // vehicle year — anchor "now" for deterministic tests
  const fakeNow = new Date('2026-05-08T00:00:00Z');
  ok(validateVehicleYear(2025, fakeNow), 'year 2025');
  ok(validateVehicleYear('2024', fakeNow), 'year stringified');
  ok(validateVehicleYear(VEHICLE_YEAR_MIN, fakeNow), 'year at floor');
  ok(validateVehicleYear(vehicleYearMax(fakeNow), fakeNow), 'year at +1MY');
  fail(validateVehicleYear('', fakeNow), 'required', 'empty year');
  fail(validateVehicleYear(undefined, fakeNow), 'required', 'undefined year');
  fail(validateVehicleYear('abc', fakeNow), 'not_a_number', 'non-numeric year');
  fail(validateVehicleYear(2025.5, fakeNow), 'not_an_integer', 'fractional year');
  fail(validateVehicleYear(VEHICLE_YEAR_MIN - 1, fakeNow), 'below_min', 'pre-1900');
  fail(validateVehicleYear(vehicleYearMax(fakeNow) + 1, fakeNow), 'above_max', 'too futuristic');

  // vehicleYearMax is deterministic for a given clock
  eq(vehicleYearMax(new Date('2026-12-31T23:59:59Z')), 2027, 'vehicleYearMax 2026 → 2027');
  eq(vehicleYearMax(new Date('2030-01-01T00:00:00Z')), 2031, 'vehicleYearMax 2030 → 2031');
}

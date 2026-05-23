/**
 * Shared Domain — single dev-only invariant entrypoint.
 *
 * Purpose: surfaces register ONE function on cold start instead of
 * rediscovering every domain's `assert*Invariants` and wrapping each
 * in its own try/catch. Every additional behavioral module added to
 * shared/domain MUST extend this aggregator — that's the gate that
 * prevents new modules from silently bypassing dev-time validation.
 *
 * Hard rules (Shared Domain 0C extraction discipline):
 *
 *   - This is NOT a registry. There is no `register(name, fn)`. The
 *     list of asserts is hand-edited; that's the point. We want a
 *     compile-time error when a domain module is renamed/removed,
 *     not a runtime no-op.
 *   - This is NOT a framework. It does no scheduling, no parallelism,
 *     no aggregation of results. It just calls the asserts in order
 *     and lets the first failure throw.
 *   - It's tree-shaken in production. Surfaces gate the call by
 *     `import.meta.env.DEV` (Vite) or `__DEV__` (Metro/Expo).
 *
 * If you need conditional invariants ("only run report asserts when
 * report module is loaded"), DON'T add a flag here — split the
 * aggregator. The right version of this file should fit on one screen.
 */
import { assertInspectionReportInvariants } from './state-machines/inspection-report';
import { assertPaymentInvariants } from './state-machines/payment';
import { assertQuoteInvariants } from './state-machines/quote';
import { assertVehicleMemoryInvariants } from './state-machines/vehicle';
import { assertVehicleValidatorInvariants } from './validators/vehicle';

/**
 * Run every shared-domain invariant. Throws on first failure with a
 * human-readable message; surfaces should `try/catch` once and log.
 *
 * Order is intentional: cheapest first, so a failure in the most
 * fundamental contract surfaces fastest in dev console output. Don't
 * shuffle for "alphabetical" or other cosmetic reasons.
 */
export function assertSharedDomainInvariants(): void {
  // Pure value-object validators first — fastest, no wire shape.
  assertVehicleValidatorInvariants();
  // Then state-machines, in dependency order: inspection (no deps),
  // payment (depends on no domain), quote (depends on no domain),
  // vehicle (depends only on the *types* of inspection/quote/payment/booking
  // — never their state machines, per P4 cross-domain rule).
  assertInspectionReportInvariants();
  assertPaymentInvariants();
  assertQuoteInvariants();
  assertVehicleMemoryInvariants();
}

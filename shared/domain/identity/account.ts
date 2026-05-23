/**
 * Identity — account primitives.
 *
 * Mirrors the backend's Sprint 1A–1E identity runtime:
 *   - `account.kind` answers "who you ARE" (customer / inspector / admin)
 *   - `capability` answers "what you can DO" (inspect / repair / wash / tow / sell)
 *   - `specialization` is data-only tagging (no auth gate)
 *
 * This file only declares the shapes. Permission predicates
 * (`canAccess(action, account)`) live in `domain/permissions/`
 * (added when the second consumer needs them).
 *
 * Backend reference: `app/core/identity_runtime.py`,
 * Sprint memos `sprint1d1_inspector_gate.md`, `sprint1d2_customer_domain.md`,
 * `sprint1d3_admin_domain_closure.md`, `sprint1e_account_switcher_closure.md`.
 */

/**
 * The four canonical principal types.
 *
 * Adding a new kind here requires:
 *   1. Backend `ACCOUNT_KINDS` to accept the same literal.
 *   2. Every `require_account_kind()` call site to consider it.
 *   3. A surface that renders it (otherwise it is invisible).
 *
 * Do not add a `provider` kind: providers are organizations, and a
 * provider's *user* is either a customer (consumer flow) or an
 * inspector (execution flow), gated additionally by capability.
 */
export type AccountKind = 'customer' | 'inspector' | 'admin' | 'guest';

export const ACCOUNT_KINDS: readonly AccountKind[] = [
  'customer',
  'inspector',
  'admin',
  'guest',
] as const;

/**
 * Professional verbs an account can perform.
 *
 * Capabilities are deliberately limited to *value-producing* actions —
 * not CRUD verbs like `view`, `pay`, `request`. Those belong to kinds.
 */
export type Capability = 'inspect' | 'repair' | 'wash' | 'tow' | 'sell';

export const CAPABILITIES: readonly Capability[] = [
  'inspect',
  'repair',
  'wash',
  'tow',
  'sell',
] as const;

/**
 * Minimal account shape carried in the JWT and surfaced in every API
 * response that includes the principal.
 */
export interface Account {
  id: string;
  kind: AccountKind;
  /** Email is optional for guests and some admin-managed accounts. */
  email?: string | null;
  /** Display name. May be empty for newly created accounts. */
  name?: string | null;
  /** Capabilities granted to this account (may be empty for customers). */
  capabilities: Capability[];
  /** Organization id for accounts that belong to a provider org. */
  organizationId?: string | null;
}

/**
 * The full identity context resolved by the backend.
 * `userId` is the legacy user document id; `accountId` is the
 * Sprint-1A account id. Both can be present during the migration window.
 */
export interface IdentityContext {
  userId?: string | null;
  accountId?: string | null;
  account?: Account | null;
  /** True when the request was made without a JWT. */
  isAnonymous: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Predicates — these are the *only* identity questions surfaces should ask.
// ─────────────────────────────────────────────────────────────────────

export function isAuthenticated(ctx: IdentityContext | null | undefined): boolean {
  return Boolean(ctx && !ctx.isAnonymous && ctx.account);
}

export function hasKind(account: Account | null | undefined, kind: AccountKind): boolean {
  return Boolean(account && account.kind === kind);
}

export function hasCapability(
  account: Account | null | undefined,
  capability: Capability,
): boolean {
  return Boolean(account && account.capabilities.includes(capability));
}

/**
 * True if the account can switch to another principal in the
 * Account Switcher (Sprint 1E). Admins can impersonate any kind;
 * inspectors and customers can only swap between themselves and a
 * guest persona.
 */
export function canSwitchTo(
  current: Account | null | undefined,
  target: AccountKind,
): boolean {
  if (!current) return target === 'guest';
  if (current.kind === target) return false;
  if (current.kind === 'admin') return true;
  // Non-admins can drop to guest. Other transitions require backend mint.
  return target === 'guest';
}

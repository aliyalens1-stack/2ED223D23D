// Step 11A — canonical parse-result reader.
//
// Pure-TS substrate (no JSX, no React, no DOM) for classifying the
// `parseMeta` envelope returned by `/api/parse/car-link` and
// `/api/inspection/report/generate`. Mirrors the backend contract in
// `backend/app/parsers/contract.py` — the two stay in lockstep.
//
// Why this lives in /app/shared/:
//
//   • Web (intake / inspect), Expo (mobile intake), Admin (operator
//     surfaces) all need to render hard-fail / soft-fail differently
//     without re-implementing the rules.
//   • The classification rules ARE behavioral truth, not presentation
//     truth — so they live in shared per architecture.md §C.
//   • UX copy is NOT here. Each surface keeps its own wording. This
//     module only answers: "given this degradedReason, is the link
//     hard-rejected or soft-accepted?"
//
// Backend pin: the code tables below must stay synchronized with
// `HARD_FAIL_CODES` / `SOFT_FAIL_CODES` in contract.py. The pin is
// enforced by review (no test runs cross-language); when a new failure
// code is added on the backend, this table must update in the same PR.

export type ParseCompleteness = 'strong' | 'partial' | 'weak';
export type ParseFailureMode = 'hard' | 'soft' | null;

/** Mirror of `HARD_FAIL_CODES` in backend/app/parsers/contract.py. */
const HARD_FAIL_CODES: ReadonlySet<string> = new Set<string>([
  'url_required',
  'bad_url',
  'unsupported_source',
  'unsupported_domain',
  'not_a_listing',
]);

/** Mirror of `SOFT_FAIL_CODES` in backend/app/parsers/contract.py. */
const SOFT_FAIL_CODES: ReadonlySet<string> = new Set<string>([
  'no_html',
  'timeout',
  'network',
  'fetch_failed',
  'fetch_error',
  'parse_error',
  'parse_exception',
  'low_extraction_confidence',
  'antibot',
  'expired_listing',
]);

/**
 * The canonical envelope as it ships across the wire. Both
 * `/api/parse/car-link` (under the `canonical` key) and
 * `/api/inspection/report/generate` (flattened into `parseMeta`)
 * conform to this shape.
 *
 * `parseCompleteness` and `degradedReason` are the read keys that
 * matter at the surface layer. `ok` is precomputed for callers that
 * only need a yes/no answer.
 */
export interface CanonicalParseEnvelope {
  ok: boolean;
  parseCompleteness?: ParseCompleteness | null;
  degradedReason?: string | null;
}

/**
 * Hard-fail when the user must change the input (bad URL, unsupported
 * domain, not a listing page). The surface should block establishment
 * and surface a calm message.
 *
 * Soft-fail when the link is structurally valid but the substrate
 * could not extract right now (anti-bot, timeout, 4xx, weak fields).
 * The surface MUST accept the link anyway — inspection context can
 * still be established and a human inspector opens it manually.
 *
 * Returns `null` when there is no failure at all (the substrate
 * succeeded; the surface renders a preview).
 *
 * `sourceRecognised` discriminates the `unsupported_source` edge
 * case identical to backend semantics: when the dispatcher already
 * accepted the host but a per-source extractor still emitted
 * `unsupported_source` (rare, legacy mobile.de path), treat it as
 * soft so the consumer keeps the link.
 */
export function classifyParseFailure(
  degradedReason: string | null | undefined,
  opts: { sourceRecognised: boolean } = { sourceRecognised: false },
): ParseFailureMode {
  if (!degradedReason) return null;

  if (HARD_FAIL_CODES.has(degradedReason)) {
    if (degradedReason === 'unsupported_source' && opts.sourceRecognised) {
      return 'soft';
    }
    return 'hard';
  }

  if (SOFT_FAIL_CODES.has(degradedReason)) return 'soft';

  // HTTP status patterns (`http_403`, `http_429`, `http_503`, …) and
  // `fetch_error:*` prefixes — always soft. Mirrors `_is_http_status_error`
  // and `_is_fetch_error_prefix` in contract.py.
  if (/^http_[45]\d{2}$/.test(degradedReason)) return 'soft';
  if (degradedReason.startsWith('fetch_error')) return 'soft';

  // Unknown code → default soft. Telemetry should surface "new code
  // observed" upstream; UX must keep the link in the meantime.
  return 'soft';
}

/**
 * `true` when the canonical envelope carries enough signal to render
 * a vehicle preview (strong OR partial). Wraps `ok` + completeness
 * so each surface doesn't reinvent the rule.
 */
export function hasPreviewSignal(env: CanonicalParseEnvelope): boolean {
  if (!env.ok) return false;
  return env.parseCompleteness === 'strong' || env.parseCompleteness === 'partial';
}

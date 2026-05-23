// Step 11A — canonical parse-result reader: unit tests.
//
// These tests pin the cross-surface invariants for hard-/soft-fail
// classification. The substrate boundary is shared between web /
// Expo / admin — when this changes, every surface changes.
//
// Run: `yarn test` from /app/shared (vitest, no JSDOM needed — pure TS).

import { describe, expect, it } from 'vitest';

import {
  classifyParseFailure,
  hasPreviewSignal,
  type CanonicalParseEnvelope,
} from '../canonical';


describe('classifyParseFailure', () => {
  it('returns null when there is no degradedReason', () => {
    expect(classifyParseFailure(null)).toBeNull();
    expect(classifyParseFailure(undefined)).toBeNull();
    expect(classifyParseFailure('')).toBeNull();
  });

  describe('hard failures — surface MUST block establishment', () => {
    it.each([
      'url_required',
      'bad_url',
      'unsupported_source',
      'unsupported_domain',
      'not_a_listing',
    ])('classifies %s as hard', (code) => {
      expect(classifyParseFailure(code)).toBe('hard');
    });

    it('unsupported_source + sourceRecognised collapses to soft', () => {
      // Backend edge case: dispatcher recognised the host (mobile.de
      // legacy path) but the per-source extractor still returned
      // `unsupported_source`. Surfaces treat this as soft so the link
      // is kept.
      expect(
        classifyParseFailure('unsupported_source', { sourceRecognised: true }),
      ).toBe('soft');
    });
  });

  describe('soft failures — surface MUST keep the link', () => {
    it.each([
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
    ])('classifies %s as soft', (code) => {
      expect(classifyParseFailure(code)).toBe('soft');
    });

    it.each([
      'http_403',
      'http_404',
      'http_429',
      'http_500',
      'http_503',
    ])('classifies HTTP %s as soft', (code) => {
      expect(classifyParseFailure(code)).toBe('soft');
    });

    it('classifies fetch_error:* prefixes as soft', () => {
      expect(classifyParseFailure('fetch_error:dns')).toBe('soft');
      expect(classifyParseFailure('fetch_error:conn_reset')).toBe('soft');
    });

    it('unknown codes default to soft (never blocks the link)', () => {
      // Future-proofing — a new degradedReason added on the backend
      // must NEVER cause the customer surface to hard-block.
      expect(classifyParseFailure('mystery_code')).toBe('soft');
      expect(classifyParseFailure('totally_new_thing')).toBe('soft');
    });
  });

  describe('exact mirror of backend contract.HARD_FAIL_CODES', () => {
    // Lockstep test — when this list grows on the backend, this list
    // grows here. Documented in canonical.ts header.
    const BACKEND_HARD = [
      'url_required',
      'bad_url',
      'unsupported_source',
      'unsupported_domain',
      'not_a_listing',
    ];

    it('hard set has no drift', () => {
      for (const c of BACKEND_HARD) {
        expect(classifyParseFailure(c)).toBe('hard');
      }
    });
  });
});


describe('hasPreviewSignal', () => {
  it('returns true for ok + strong', () => {
    const env: CanonicalParseEnvelope = {
      ok: true,
      parseCompleteness: 'strong',
    };
    expect(hasPreviewSignal(env)).toBe(true);
  });

  it('returns true for ok + partial', () => {
    const env: CanonicalParseEnvelope = {
      ok: true,
      parseCompleteness: 'partial',
    };
    expect(hasPreviewSignal(env)).toBe(true);
  });

  it('returns false for ok=false (anything)', () => {
    expect(hasPreviewSignal({ ok: false, parseCompleteness: 'strong' })).toBe(false);
    expect(hasPreviewSignal({ ok: false, parseCompleteness: 'weak' })).toBe(false);
  });

  it('returns false for weak completeness', () => {
    expect(hasPreviewSignal({ ok: true, parseCompleteness: 'weak' })).toBe(false);
  });

  it('returns false when completeness is missing', () => {
    // Defensive — server should always emit completeness, but if it
    // doesn't, the surface must NOT render a half-empty preview.
    expect(hasPreviewSignal({ ok: true })).toBe(false);
  });
});

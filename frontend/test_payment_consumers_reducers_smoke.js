/**
 * P0.b.C.i — Smoke test for the two surface-local reducers.
 *
 * Pure functions, no React, no async. Run:
 *   cd /app/frontend && node test_payment_consumers_reducers_smoke.js
 *
 * Verifies the doctrinal invariants of both reducers WITHOUT any
 * shared assertion — each section asserts against its own ontology
 * (customer-humanized vs admin-raw). The two reducers do NOT import
 * each other; this test imports them separately and asserts they
 * remain independent.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

// On-the-fly TypeScript transpilation hook for .ts files.
require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      jsx: ts.JsxEmit.React,
      strict: false,
      skipLibCheck: true,
    },
    fileName: filename,
  });
  module._compile(out.outputText, filename);
};

const SRC = path.resolve(__dirname, 'src');

const {
  customerPaymentChronologyReducer,
  initialCustomerPaymentChronologyState,
  dedupKey,
} = require(path.join(SRC, 'customer/payment-chronology/reducer.ts'));

const {
  forensicPaymentStreamReducer,
  initialForensicPaymentStreamState,
} = require(path.join(SRC, 'admin/payment-forensic/reducer.ts'));

const failures = [];
function assert(label, cond, ctx) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${ctx ? `: ${ctx}` : ''}`);
    console.log(`  ✗ ${label}${ctx ? ` (${ctx})` : ''}`);
  }
}

// Customer-projected sample rows (shape produced by P.project_customer)
const c = (id, kind, at, meta = {}) => ({
  id,
  paymentId: 'pay-i',
  kind,
  at,
  actor: { role: 'platform' },
  meta,
});

// ──────────────────────────────────────────────────────────────────────
// PART 1 — customer chronology reducer
// ──────────────────────────────────────────────────────────────────────
console.log('\n── PART 1 — customer chronology reducer (humanized) ──');

let s = initialCustomerPaymentChronologyState;
assert('initial state empty', s.events.length === 0 && s.seenIds.size === 0);

s = customerPaymentChronologyReducer(s, {
  type: 'hydrate',
  events: [
    c('r3', 'escrow.held', '2026-05-22T10:05:00Z'),
    c('r1', 'payment.initiated', '2026-05-22T10:00:00Z'),
    c('r2', 'escrow.held', '2026-05-22T10:02:00Z'),
  ],
});
assert(
  'hydrate sorts ascending by at',
  s.events.map((e) => e.id).join(',') === 'r1,r2,r3'
);
assert('hydrate populates seenIds', s.seenIds.size === 3);

s = customerPaymentChronologyReducer(s, {
  type: 'append',
  event: c('r4', 'escrow.released', '2026-05-22T10:10:00Z'),
});
assert(
  'append inserts after hydrate (sorted)',
  s.events.map((e) => e.id).join(',') === 'r1,r2,r3,r4'
);

const before = s;
s = customerPaymentChronologyReducer(s, {
  type: 'append',
  event: c('r4', 'escrow.released', '2026-05-22T10:10:00Z'),
});
assert('append dedup by id (returns same state)', s === before);

s = customerPaymentChronologyReducer(s, {
  type: 'reconcile',
  events: [
    c('r1', 'payment.initiated', '2026-05-22T10:00:00Z'),
    c('r2', 'escrow.held', '2026-05-22T10:02:00Z'),
    c('r3', 'escrow.held', '2026-05-22T10:05:00Z'),
  ],
});
assert(
  'reconcile drops local-only WS rows (REST wins)',
  s.events.map((e) => e.id).join(',') === 'r1,r2,r3'
);

assert(
  'dedupKey is event.id (stable React list key)',
  dedupKey({
    id: 'abc',
    paymentId: 'p',
    kind: 'x',
    at: '',
    actor: { role: 'platform' },
    meta: {},
  }) === 'abc'
);

s = customerPaymentChronologyReducer(s, { type: 'reset' });
assert('reset clears state', s.events.length === 0 && s.seenIds.size === 0);

s = customerPaymentChronologyReducer(initialCustomerPaymentChronologyState, {
  type: 'hydrate',
  events: [
    c('B', 'escrow.held', '2026-05-22T10:00:00Z'),
    c('A', 'escrow.held', '2026-05-22T10:00:00Z'),
  ],
});
assert(
  'tiebreak by id lex ASC',
  s.events.map((e) => e.id).join(',') === 'A,B'
);

s = customerPaymentChronologyReducer(initialCustomerPaymentChronologyState, {
  type: 'hydrate',
  events: [
    c('X', 'payment.initiated', null),
    c('A', 'payment.initiated', '2026-05-22T10:00:00Z'),
  ],
});
assert(
  'null at goes to tail',
  s.events.map((e) => e.id).join(',') === 'A,X'
);

s = customerPaymentChronologyReducer(initialCustomerPaymentChronologyState, {
  type: 'append',
  event: { id: '', paymentId: 'p', kind: 'x', at: '', actor: { role: 'platform' }, meta: {} },
});
assert('append with empty id is no-op', s.events.length === 0);

// ──────────────────────────────────────────────────────────────────────
// PART 2 — admin forensic reducer
// ──────────────────────────────────────────────────────────────────────
console.log('\n── PART 2 — admin forensic reducer (raw, append-many) ──');

const f = (id, kind, at, extra = {}) => ({
  id,
  paymentId: 'pay-i',
  kind,
  at,
  actor: { id: 'admin-1', role: 'admin' },
  meta: { internalNotes: 'raw' },
  sourceWebhookId: null,
  schemaVersion: 1,
  ...extra,
});

let a = initialForensicPaymentStreamState;
assert('admin initial state empty', a.rows.length === 0 && a.seenIds.size === 0);

a = forensicPaymentStreamReducer(a, {
  type: 'hydrate',
  rows: [
    f('z', 'admin.freeze.applied', '2026-05-22T10:05:00Z'),
    f('y', 'payment.initiated', '2026-05-22T10:00:00Z'),
    f('z', 'admin.freeze.applied', '2026-05-22T10:05:00Z'),
  ],
});
assert('admin hydrate dedups same id', a.rows.length === 2);
assert(
  'admin hydrate sorts asc',
  a.rows.map((r) => r.id).join(',') === 'y,z'
);

a = forensicPaymentStreamReducer(a, {
  type: 'appendMany',
  rows: [
    f('y', 'payment.initiated', '2026-05-22T10:00:00Z'),
    f('q', 'refund.requested:rejected', '2026-05-22T10:10:00Z'),
    f('q', 'refund.requested:rejected', '2026-05-22T10:10:00Z'),
    f('r', 'admin.force_release:rejected', '2026-05-22T10:12:00Z'),
  ],
});
assert(
  'appendMany dedups internally AND vs state',
  a.rows.length === 4 && a.rows.map((r) => r.id).join(',') === 'y,z,q,r'
);

assert(
  'admin retains :rejected suffix verbatim',
  a.rows[2].kind === 'refund.requested:rejected'
);
assert(
  'admin retains admin.* prefix verbatim',
  a.rows[1].kind === 'admin.freeze.applied'
);

assert(
  'admin sees internal meta keys unfiltered',
  a.rows[0].meta.internalNotes === 'raw'
);

a = forensicPaymentStreamReducer(a, {
  type: 'hydrate',
  rows: [
    f('y', 'payment.initiated', '2026-05-22T10:00:00Z'),
    f('z', 'admin.freeze.applied', '2026-05-22T10:05:00Z'),
  ],
});
assert(
  'admin hydrate replaces (REST wins)',
  a.rows.length === 2 && a.rows.map((r) => r.id).join(',') === 'y,z'
);

a = forensicPaymentStreamReducer(a, {
  type: 'append',
  row: f('y', 'payment.initiated', '2026-05-22T10:00:00Z'),
});
assert('admin append no-op on known id', a.rows.length === 2);

a = forensicPaymentStreamReducer(a, { type: 'reset' });
assert('admin reset clears', a.rows.length === 0 && a.seenIds.size === 0);

// ──────────────────────────────────────────────────────────────────────
// PART 3 — Independence of the two ontology species
// ──────────────────────────────────────────────────────────────────────
console.log('\n── PART 3 — surface independence ──');

const cs0 = initialCustomerPaymentChronologyState;
const as0 = initialForensicPaymentStreamState;
assert(
  'separate initial state objects (not shared)',
  cs0 !== as0 && cs0.events !== undefined && as0.rows !== undefined
);

const after = customerPaymentChronologyReducer(cs0, {
  type: 'appendMany',
  rows: [f('Q', 'admin.freeze.applied', '2026-05-22T10:00:00Z')],
});
assert(
  'customer reducer ignores admin-only appendMany action (default case)',
  after === cs0
);

const after2 = forensicPaymentStreamReducer(as0, {
  type: 'reconcile',
  events: [c('R', 'payment.initiated', '2026-05-22T10:00:00Z')],
});
assert(
  'admin reducer ignores customer-only reconcile action (default case)',
  after2 === as0
);

// ──────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log('\n❌ FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('\n✅ ALL P0.b.C.i REDUCER CHECKS PASSED ' +
  '(REST wins · dedup by id · stable sort · tiebreak · null-at-tail · ' +
  'surface independence · admin retains raw kinds and internal meta · ' +
  'cross-action immutability)');

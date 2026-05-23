// =====================================================================
// SHARED DOMAIN — INSTITUTIONAL MEMORY
// ─────────────────────────────────────────────────────────────────────
//
//   Shared domain is behavioral truth.
//   Do not import frameworks, transport, storage, or surface runtime here.
//   Cross-domain state-machines must not depend on each other.
//
// ─────────────────────────────────────────────────────────────────────
//
// What this config does (and ONLY this):
//
//   1. Forbids surface-runtime libs (react / react-router / react-dom).
//   2. Forbids transport libs (axios / socket.io-client / native fetch
//      via global, websocket).
//   3. Forbids browser/runtime API globals (window / document /
//      localStorage / sessionStorage / navigator / fetch / XMLHttpRequest).
//   4. Forbids @platform/* alias imports inside /app/shared (anti-cycle —
//      shared must be a sink, not a consumer of higher layers).
//   5. Forbids cross-domain state-machine imports: a state-machine for
//      domain X (vehicle.ts, quote.ts, payment.ts, inspection-report.ts)
//      may NOT import another domain's state-machine. Cross-domain
//      crossing happens only via /domain/contracts/*.ts (types) and
//      via projection inputs the surface assembles.
//
// What this config deliberately does NOT do:
//
//   - No custom plugins.
//   - No AST analyzers.
//   - No auto-discovery.
//   - No "platform framework".
//   - No generic dependency graph rules.
//
// Just `no-restricted-imports` + `no-restricted-globals` + per-file
// override patterns. Boring on purpose. The cost of a future violation
// is "the linter screams"; the cost of a clever framework is years of
// untangling.
// =====================================================================

import tsParser from '@typescript-eslint/parser';

// ---------------------------------------------------------------------
// Forbidden runtime / transport / surface modules.
//
// `no-restricted-imports` does NOT support glob in `paths`, so we
// enumerate. `patterns` supports glob for sub-path imports.
// ---------------------------------------------------------------------

const FORBIDDEN_SURFACE_RUNTIME = [
  // React + bindings
  { name: 'react', message: 'shared domain must not import react. shared is behavioral truth, not a UI module.' },
  { name: 'react-dom', message: 'shared domain must not import react-dom.' },
  { name: 'react-dom/client', message: 'shared domain must not import react-dom.' },
  { name: 'react-native', message: 'shared domain must not import react-native.' },
  { name: 'react-router', message: 'shared domain must not import routing. surfaces own routing.' },
  { name: 'react-router-dom', message: 'shared domain must not import routing.' },
  { name: 'expo-router', message: 'shared domain must not import routing.' },
];

const FORBIDDEN_TRANSPORT = [
  { name: 'axios', message: 'shared domain must not import transport. surface fetches; shared projects.' },
  { name: 'socket.io-client', message: 'shared domain must not open sockets.' },
  { name: 'ws', message: 'shared domain must not open sockets.' },
  { name: 'node-fetch', message: 'shared domain must not perform I/O.' },
  { name: 'cross-fetch', message: 'shared domain must not perform I/O.' },
];

const FORBIDDEN_STORAGE = [
  { name: '@react-native-async-storage/async-storage', message: 'shared domain must not access storage.' },
  { name: 'expo-secure-store', message: 'shared domain must not access storage.' },
  { name: 'mongodb', message: 'shared domain must not access database.' },
  { name: 'mongoose', message: 'shared domain must not access database.' },
];

// ---------------------------------------------------------------------
// Anti-cycle: shared is the sink, never the consumer.
// ---------------------------------------------------------------------

const ANTI_CYCLE_PATTERNS = [
  {
    group: ['@platform/*', '@platform/**'],
    message:
      'shared domain must not import via the @platform/* alias. ' +
      'shared is the sink layer — surfaces consume shared, not the other way around. ' +
      'use relative imports inside /app/shared instead.',
  },
  // Belt & suspenders: even relative imports that escape /app/shared
  // upward into surface trees are forbidden.
  {
    group: ['../../web-app/**', '../../admin/**', '../../frontend/**', '../../backend/**'],
    message: 'shared domain must not reach into surface or backend trees. shared is a sink.',
  },
];

// ---------------------------------------------------------------------
// Cross-domain isolation between state-machines.
//
// Each domain's state-machine file (vehicle.ts, quote.ts, payment.ts,
// inspection-report.ts) is the AUTHORITATIVE behavioral source for
// that domain. Importing another domain's state-machine creates an
// implicit semantic dependency that the architecture explicitly
// rejects (P4 guardrail: "cross-domain refs through typed projection
// inputs only").
//
// Crossing IS allowed via:
//   - /domain/contracts/*.ts  (types only — no behavior)
//
// We forbid `../state-machines/<other>` imports per file via overrides.
// ---------------------------------------------------------------------

function forbidOtherStateMachines(selfBaseName) {
  // Domain state-machines that exist today + any future siblings.
  // The pattern matches `../state-machines/X` and `./X` within the
  // state-machines directory — i.e. any sibling state-machine file.
  return {
    patterns: [
      {
        group: ['./*', '!./' + selfBaseName],
        message:
          'cross-domain state-machine imports are forbidden. ' +
          selfBaseName + '.ts must not depend on a sibling state-machine. ' +
          'crossing happens via /domain/contracts/*.ts (types) and via ' +
          'projection inputs the surface assembles.',
      },
      {
        group: ['../state-machines/*'],
        message:
          'cross-domain state-machine imports are forbidden. ' +
          selfBaseName + '.ts must not depend on a sibling state-machine. ' +
          'crossing happens via /domain/contracts/*.ts (types) and via ' +
          'projection inputs the surface assembles.',
      },
    ],
  };
}

// ---------------------------------------------------------------------
// Forbidden globals — runtime APIs that betray the "no I/O" rule.
//
// Note: ESLint's `no-restricted-globals` only fires when the global is
// referenced as a free identifier. Member access (`globalThis.window`)
// is intentionally NOT covered — we draw the line at obvious misuse.
// ---------------------------------------------------------------------

const FORBIDDEN_GLOBALS = [
  { name: 'window', message: 'shared domain must not access browser DOM.' },
  { name: 'document', message: 'shared domain must not access browser DOM.' },
  { name: 'localStorage', message: 'shared domain must not access storage.' },
  { name: 'sessionStorage', message: 'shared domain must not access storage.' },
  { name: 'navigator', message: 'shared domain must not access navigator API.' },
  { name: 'XMLHttpRequest', message: 'shared domain must not perform I/O.' },
  { name: 'WebSocket', message: 'shared domain must not open sockets.' },
  { name: 'fetch', message: 'shared domain must not perform I/O. surface fetches; shared projects.' },
  { name: 'alert', message: 'shared domain must not call surface UI APIs.' },
  { name: 'confirm', message: 'shared domain must not call surface UI APIs.' },
  { name: 'prompt', message: 'shared domain must not call surface UI APIs.' },
];

// =====================================================================
// Config
// =====================================================================

export default [
  // Ignore generated / vendor.
  {
    ignores: ['node_modules/**', 'dist/**', '**/*.d.ts'],
  },

  // ── Default rules for ALL .ts files inside /app/shared ─────────────
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...FORBIDDEN_SURFACE_RUNTIME,
            ...FORBIDDEN_TRANSPORT,
            ...FORBIDDEN_STORAGE,
          ],
          patterns: ANTI_CYCLE_PATTERNS,
        },
      ],
      'no-restricted-globals': ['error', ...FORBIDDEN_GLOBALS],
    },
  },

  // ── Per-domain state-machine isolation ─────────────────────────────
  //
  // Each override appends MORE restrictions (its own forbidden sibling
  // imports) on top of the base rules. ESLint's flat-config rule
  // semantics overwrite the base `no-restricted-imports` array, so we
  // re-emit the base lists here and merge in the cross-domain pattern.
  // Boring duplication beats clever metaprogramming.

  {
    files: ['domain/state-machines/vehicle.ts'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...FORBIDDEN_SURFACE_RUNTIME, ...FORBIDDEN_TRANSPORT, ...FORBIDDEN_STORAGE],
          patterns: [
            ...ANTI_CYCLE_PATTERNS,
            ...forbidOtherStateMachines('vehicle').patterns,
          ],
        },
      ],
    },
  },

  {
    files: ['domain/state-machines/quote.ts'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...FORBIDDEN_SURFACE_RUNTIME, ...FORBIDDEN_TRANSPORT, ...FORBIDDEN_STORAGE],
          patterns: [
            ...ANTI_CYCLE_PATTERNS,
            ...forbidOtherStateMachines('quote').patterns,
          ],
        },
      ],
    },
  },

  {
    files: ['domain/state-machines/payment.ts'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...FORBIDDEN_SURFACE_RUNTIME, ...FORBIDDEN_TRANSPORT, ...FORBIDDEN_STORAGE],
          patterns: [
            ...ANTI_CYCLE_PATTERNS,
            ...forbidOtherStateMachines('payment').patterns,
          ],
        },
      ],
    },
  },

  {
    files: ['domain/state-machines/inspection-report.ts'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...FORBIDDEN_SURFACE_RUNTIME, ...FORBIDDEN_TRANSPORT, ...FORBIDDEN_STORAGE],
          patterns: [
            ...ANTI_CYCLE_PATTERNS,
            ...forbidOtherStateMachines('inspection-report').patterns,
          ],
        },
      ],
    },
  },
];

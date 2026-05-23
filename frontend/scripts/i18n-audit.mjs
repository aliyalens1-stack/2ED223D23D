#!/usr/bin/env node
/**
 * i18n-audit.mjs — locale-parity and missing-key audit.
 *
 * Run:    node scripts/i18n-audit.mjs
 * Run:    yarn i18n:audit
 *
 * Exit codes:
 *   0  — locales are in parity AND no t() call references a missing key.
 *   1  — at least one locale has missing/extra keys, OR at least one
 *        t('foo') reference in code points at a non-existent key.
 *
 * Why: prevents the "DE leaks RU defaultValue" class of bug by failing CI
 * the moment a key is referenced in code but missing from de.json or
 * en.json. Pairs with i18n/index.ts's dev-mode missingKeyHandler.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'src/i18n/locales');
const APP_DIR = path.join(ROOT, 'app');
const SRC_DIR = path.join(ROOT, 'src');

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

function loadLocale(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return flatten(raw);
}

function walk(dir, exts = new Set(['.tsx', '.ts'])) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p, exts));
    else if (exts.has(path.extname(ent.name))) out.push(p);
  }
  return out;
}

// Extract all t('key') / t("key") / i18n.t('key') references from source.
const keyPattern = /\b(?:t|i18n\.t)\s*\(\s*['"]([a-zA-Z0-9_.]+)['"]/g;

// Heuristic: only keys with at least one `.` AND no leading/trailing dot are
// considered real i18n references. Skips placeholders like `...` or `foo.bar`
// that appear inside JSDoc/comments (we don't AST-parse to keep this simple).
function isProbablyRealKey(k) {
  if (!k.includes('.')) return false;
  if (k.startsWith('.') || k.endsWith('.')) return false;
  if (k.includes('..')) return false;
  if (k === 'foo.bar') return false;  // dev placeholder used in comments
  return true;
}

function extractKeys(file) {
  const text = fs.readFileSync(file, 'utf8');
  const keys = new Set();
  for (const m of text.matchAll(keyPattern)) {
    if (isProbablyRealKey(m[1])) keys.add(m[1]);
  }
  return keys;
}

// ── Run audit ────────────────────────────────────────────────────────────
const locales = fs
  .readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ code: f.replace('.json', ''), keys: loadLocale(path.join(LOCALES_DIR, f)) }));

const tsFiles = [...walk(APP_DIR), ...walk(SRC_DIR)];
const usedKeys = new Set();
for (const f of tsFiles) for (const k of extractKeys(f)) usedKeys.add(k);

let failures = 0;

// 1) Parity — same key set in every locale.
const reference = locales[0];
console.log(`Reference locale: ${reference.code} (${Object.keys(reference.keys).length} keys)\n`);
for (const lg of locales.slice(1)) {
  const refSet = new Set(Object.keys(reference.keys));
  const lgSet = new Set(Object.keys(lg.keys));
  const missingInLg = [...refSet].filter((k) => !lgSet.has(k));
  const extraInLg = [...lgSet].filter((k) => !refSet.has(k));
  if (missingInLg.length || extraInLg.length) {
    failures += 1;
    console.log(`❌ Parity mismatch: ${reference.code} ↔ ${lg.code}`);
    if (missingInLg.length) console.log(`   missing in ${lg.code} (${missingInLg.length}):`, missingInLg.slice(0, 10));
    if (extraInLg.length)   console.log(`   extra   in ${lg.code} (${extraInLg.length}):`,   extraInLg.slice(0, 10));
  } else {
    console.log(`✅ Parity ${reference.code} ↔ ${lg.code}: ${lgSet.size} keys`);
  }
}

// 2) Code-vs-locale: every t('...') key must exist in every locale.
const refKeys = new Set(Object.keys(reference.keys));
const codeMissing = [...usedKeys].filter((k) => !refKeys.has(k));
if (codeMissing.length) {
  failures += 1;
  console.log(`\n❌ ${codeMissing.length} t() references missing from ${reference.code}.json:`);
  for (const k of codeMissing.slice(0, 25)) console.log(`     ${k}`);
  if (codeMissing.length > 25) console.log(`     … and ${codeMissing.length - 25} more`);
} else {
  console.log(`\n✅ All ${usedKeys.size} t() references resolve in ${reference.code}.json`);
}

// 3) Unused keys (informational only — not a hard failure).
const unused = [...refKeys].filter((k) => !usedKeys.has(k));
console.log(`\nℹ️ ${unused.length}/${refKeys.size} keys in locales are not referenced by any source file.`);

if (failures) {
  console.log(`\n💥 i18n audit FAILED with ${failures} issue group(s).`);
  process.exit(1);
}
console.log('\n🎉 i18n audit passed.');

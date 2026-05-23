#!/usr/bin/env node
/**
 * scripts/check-customer-lexicon.mjs — locale-level lexicon firewall
 * test for the customer-grammar module (Sprint Customer-Loc-1).
 *
 * Asserts that NO customer-visible string in any locale contains a
 * forbidden token. Run via:
 *
 *     node scripts/check-customer-lexicon.mjs
 *
 * Exit codes:
 *     0 — clean, locks are tight
 *     1 — at least one violation found (CI must fail the build)
 *
 * Boundary: pure node, NO TypeScript runtime needed, NO yarn deps.
 * The script reads the four JSON files directly and applies a
 * word-boundary regex per (locale, key, string, token).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRAMMAR_DIR = resolve(__dirname, '..', 'src', 'customer-grammar');

const LOCALES = ['en', 'de', 'ru'];

/** Word-boundary check that works for both ASCII and Cyrillic.
 *  \b in JS regex is ASCII-only, so we hand-roll a boundary test:
 *  the token must either start the string or be preceded by a
 *  non-letter, AND end the string or be followed by a non-letter. */
function containsToken(haystack, token) {
  const h = haystack.toLowerCase();
  const t = token.toLowerCase();
  if (!t) return false;
  let idx = 0;
  while (true) {
    const found = h.indexOf(t, idx);
    if (found === -1) return false;
    const before = found === 0 ? '' : h[found - 1];
    const after = h[found + t.length] ?? '';
    const isLetter = (ch) =>
      ch &&
      // ASCII letters
      ((ch >= 'a' && ch <= 'z') ||
        // Cyrillic Unicode block U+0400..U+04FF
        (ch.charCodeAt(0) >= 0x0400 && ch.charCodeAt(0) <= 0x04ff) ||
        // German umlauts + ß
        'äöüß'.includes(ch));
    if (!isLetter(before) && !isLetter(after)) {
      return true;
    }
    idx = found + 1;
  }
}

/** Walk an arbitrarily-nested copy table, yielding (path, string). */
function* walkStrings(node, path = []) {
  if (typeof node === 'string') {
    yield { path: path.join('.'), value: node };
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      yield* walkStrings(node[i], [...path, String(i)]);
    }
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('_')) continue; // skip _doc / _meta fields
      yield* walkStrings(v, [...path, k]);
    }
  }
}

async function loadJson(rel) {
  const full = resolve(GRAMMAR_DIR, rel);
  const raw = await readFile(full, 'utf-8');
  return JSON.parse(raw);
}

async function main() {
  const forbidden = await loadJson('forbidden-lexicon.json');
  const universal = forbidden.universal ?? [];
  const perLocale = forbidden.perLocale ?? {};

  let totalStrings = 0;
  let totalChecks = 0;
  const violations = [];

  for (const lang of LOCALES) {
    const copy = await loadJson(`copy/${lang}.json`);
    const localeTokens = [...universal, ...(perLocale[lang] ?? [])];
    for (const { path, value } of walkStrings(copy)) {
      totalStrings += 1;
      for (const tok of localeTokens) {
        totalChecks += 1;
        if (containsToken(value, tok)) {
          violations.push({ lang, path, token: tok, value });
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `[lexicon] OK — locales=[${LOCALES.join(',')}], strings=${totalStrings}, ` +
        `checks=${totalChecks}, violations=0`,
    );
    process.exit(0);
  }

  console.error(`[lexicon] FAIL — ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  [${v.lang}] ${v.path}  ← token "${v.token}"`);
    console.error(`         "${v.value}"`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('[lexicon] runner crashed:', err);
  process.exit(2);
});

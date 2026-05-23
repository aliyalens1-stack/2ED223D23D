// R3A — Reactivity audit (detection-only, no writes).
//
// For every `i18n.t(...)` call in app/ and src/, classify by the
// SEMANTIC scope it lives in:
//
//   COMPONENT_RENDER  — inside a React component (function returning JSX
//                       or PascalCase function) AND in a render-path
//                       expression (JSX child / attribute / hook deps / 
//                       inline ternary inside JSX), or in a helper called
//                       only from render. Migrate-candidate.
//   COMPONENT_STATIC  — inside a component, but in a "static" context:
//                       const map/array/options defined inside the body
//                       once (intentional staticization). KEEP i18n.t.
//   MODULE_STATIC     — at module top-level (const X = {...}). KEEP i18n.t.
//   UTIL              — inside a non-component function (no JSX returned,
//                       not PascalCase). KEEP i18n.t.
//   AMBIGUOUS         — `const label = i18n.t(...); return <Text>{label}</Text>`
//                       Could be either. Manual review.
//
// Output: /app/audit/R3_REACTIVITY_AUDIT.json
//
// Run: node scripts/r3-reactivity-audit.mjs

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

const ROOT = '/app/frontend';
const SCAN_DIRS = ['app', 'src'];
const REPORT_PATH = '/app/audit/R3_REACTIVITY_AUDIT.json';

// ────────────────────────────────────────────────────────────────────
// File walking
// ────────────────────────────────────────────────────────────────────
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.metro-cache') continue;
      yield* walk(p);
    } else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) {
      yield p;
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// AST analysis
// ────────────────────────────────────────────────────────────────────
function parseFile(src) {
  return parse(src, {
    sourceType: 'module',
    allowReturnOutsideFunction: true,
    plugins: ['typescript', 'jsx', 'classProperties', 'decorators-legacy', 'topLevelAwait'],
    errorRecovery: true,
  });
}

function isPascalCase(name) {
  return typeof name === 'string' && /^[A-Z][a-zA-Z0-9_]*$/.test(name);
}

function isUseHook(name) {
  return typeof name === 'string' && /^use[A-Z]/.test(name);
}

// Determine if a function path is a "component" (PascalCase + may render JSX)
function functionInfo(path) {
  // Get name from various declaration forms
  let name = null;
  if (path.isFunctionDeclaration()) {
    name = path.node.id?.name ?? null;
  } else if (path.isFunctionExpression()) {
    name = path.node.id?.name ?? path.parent.id?.name ?? null;
  } else if (path.isArrowFunctionExpression()) {
    if (path.parent.type === 'VariableDeclarator') name = path.parent.id?.name ?? null;
  }
  // Check if the function returns JSX anywhere in its top-level body
  let returnsJsx = false;
  path.traverse({
    ReturnStatement(rp) {
      // Only consider returns of THIS function (skip nested)
      if (rp.getFunctionParent() !== path) return;
      const arg = rp.node.argument;
      if (!arg) return;
      if (arg.type === 'JSXElement' || arg.type === 'JSXFragment') returnsJsx = true;
      if (arg.type === 'ConditionalExpression' &&
        (arg.consequent.type === 'JSXElement' || arg.alternate.type === 'JSXElement' ||
         arg.consequent.type === 'JSXFragment' || arg.alternate.type === 'JSXFragment')) {
        returnsJsx = true;
      }
    },
    ArrowFunctionExpression(ap) { ap.skip(); },
    FunctionDeclaration(fp) { fp.skip(); },
    FunctionExpression(fp) { fp.skip(); },
  });
  // Arrow body that is JSX directly:
  if (path.isArrowFunctionExpression()) {
    const b = path.node.body;
    if (b.type === 'JSXElement' || b.type === 'JSXFragment') returnsJsx = true;
  }
  return {
    name,
    isComponent: returnsJsx || (isPascalCase(name) && (path.isFunctionDeclaration() || path.isFunctionExpression() || path.isArrowFunctionExpression())),
    isHook: isUseHook(name),
    returnsJsx,
  };
}

// Find ancestor function path
function getEnclosingFunction(path) {
  let p = path.parentPath;
  while (p) {
    if (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression() || p.isObjectMethod() || p.isClassMethod()) return p;
    p = p.parentPath;
  }
  return null;
}

// Does this CallExpression sit inside JSX (attribute / child / spread)?
function isInsideJSX(path) {
  let p = path.parentPath;
  while (p) {
    const t = p.node.type;
    if (t === 'JSXExpressionContainer' || t === 'JSXAttribute' || t === 'JSXSpreadAttribute' || t === 'JSXElement' || t === 'JSXFragment') return true;
    // Stop at function boundary; nested function is its own render world
    if (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression()) return false;
    p = p.parentPath;
  }
  return false;
}

// Is the call directly assigned to a const at component body root?
//   const label = i18n.t(...);
// And is that const later referenced inside JSX?
// We can't fully resolve aliases without symbol table; for now we just
// flag this case as AMBIGUOUS (per user's safety rule).
function isAssignedToConstAtBodyRoot(path, componentBodyNode) {
  // direct parent must be VariableDeclarator inside the component body
  let p = path.parentPath;
  while (p) {
    if (p.node === componentBodyNode) return false;
    if (p.isVariableDeclarator()) {
      // grandparent should be VariableDeclaration whose parent is BlockStatement of component
      const decl = p.parentPath;
      if (decl?.parentPath?.node === componentBodyNode) {
        return p.node.id?.type === 'Identifier' ? p.node.id.name : true;
      }
      return false;
    }
    if (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression()) return false;
    p = p.parentPath;
  }
  return false;
}

// Detect if call is inside an "intentionally static" container at component
// body root: const SOMETHING = [...] / {...} / new Map(...)
function isInsideStaticContainerAtBodyRoot(path, componentBodyNode) {
  // walk up; if we hit ArrayExpression/ObjectExpression whose VariableDeclarator
  // is a direct child of component body, that's a static container
  let p = path.parentPath;
  let inContainer = false;
  while (p) {
    if (p.node === componentBodyNode) return false;
    if (p.isArrayExpression() || p.isObjectExpression()) inContainer = true;
    if (p.isVariableDeclarator()) {
      const decl = p.parentPath;
      if (decl?.parentPath?.node === componentBodyNode) {
        // body-root const X = ...  — is it a STATIC container? we need inContainer
        return inContainer;
      }
      return false;
    }
    if (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression()) return false;
    p = p.parentPath;
  }
  return false;
}

function alreadyUsesHook(componentBodyNode) {
  if (!componentBodyNode || componentBodyNode.type !== 'BlockStatement') return false;
  for (const stmt of componentBodyNode.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (!d.init) continue;
      // const { t } = useTranslation()
      if (d.init.type === 'CallExpression' &&
          d.init.callee.type === 'Identifier' &&
          d.init.callee.name === 'useTranslation') return true;
    }
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────
// Per-file scan
// ────────────────────────────────────────────────────────────────────
function scanFile(relPath, src) {
  let ast;
  try { ast = parseFile(src); }
  catch (e) { return { parseError: e.message }; }

  const sites = [];
  traverse(ast, {
    CallExpression(path) {
      const c = path.node.callee;
      // Match i18n.t(...)
      const isI18nT =
        c.type === 'MemberExpression' &&
        c.object.type === 'Identifier' &&
        c.object.name === 'i18n' &&
        c.property.type === 'Identifier' &&
        c.property.name === 't' &&
        !c.computed;
      if (!isI18nT) return;

      const enclosing = getEnclosingFunction(path);
      const loc = path.node.loc?.start;
      const site = {
        line: loc?.line ?? -1,
        col: loc?.column ?? -1,
        scope: 'UNKNOWN',
        details: {},
      };

      if (!enclosing) {
        site.scope = 'MODULE_STATIC';
        sites.push(site);
        return;
      }

      const info = functionInfo(enclosing);
      site.details.fnName = info.name ?? '<anon>';
      site.details.isComponent = info.isComponent;
      site.details.isHook = info.isHook;
      site.details.returnsJsx = info.returnsJsx;

      const componentBody = enclosing.get('body').node;
      const alreadyHook = alreadyUsesHook(componentBody);
      site.details.alreadyUsesHook = alreadyHook;

      const insideJsx = isInsideJSX(path);
      const inStaticContainer = isInsideStaticContainerAtBodyRoot(path, componentBody);
      const assignedAtRoot = isAssignedToConstAtBodyRoot(path, componentBody);

      if (!info.isComponent && !info.isHook) {
        site.scope = 'UTIL';
      } else if (inStaticContainer) {
        site.scope = 'COMPONENT_STATIC';
      } else if (insideJsx) {
        site.scope = 'COMPONENT_RENDER';
      } else if (assignedAtRoot) {
        // `const label = i18n.t(...)` — could be intentional staticization
        // or pre-render formatting. Mark ambiguous per user's safety rule.
        site.scope = 'AMBIGUOUS';
        site.details.assignedTo = assignedAtRoot;
      } else {
        // call inside an inner block (useEffect, useCallback, event handler etc)
        // — these are usually NOT render-path; mark UTIL (KEEP i18n.t).
        site.scope = 'UTIL';
      }
      sites.push(site);
    },
  });
  return { sites };
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────
const report = {
  generatedAt: new Date().toISOString(),
  scannedDirs: SCAN_DIRS,
  totals: { COMPONENT_RENDER: 0, COMPONENT_STATIC: 0, MODULE_STATIC: 0, UTIL: 0, AMBIGUOUS: 0, parseErrors: 0 },
  files: [],
};

for (const dir of SCAN_DIRS) {
  const abs = join(ROOT, dir);
  try { statSync(abs); } catch { continue; }
  for await (const file of walk(abs)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('i18n.t(')) continue;
    const rel = relative(ROOT, file);
    const r = scanFile(rel, src);
    if (r.parseError) {
      report.totals.parseErrors++;
      report.files.push({ file: rel, parseError: r.parseError });
      continue;
    }
    if (!r.sites.length) continue;
    const counts = { COMPONENT_RENDER: 0, COMPONENT_STATIC: 0, MODULE_STATIC: 0, UTIL: 0, AMBIGUOUS: 0 };
    for (const s of r.sites) {
      counts[s.scope]++;
      report.totals[s.scope]++;
    }
    report.files.push({ file: rel, counts, sites: r.sites });
  }
}

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
console.log('=== R3A Reactivity Audit ===');
console.log(`scanned: ${report.files.length} files`);
console.log(`totals:`, JSON.stringify(report.totals, null, 2));
console.log(`report → ${REPORT_PATH}`);

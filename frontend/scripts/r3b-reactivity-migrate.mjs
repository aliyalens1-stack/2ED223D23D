// R3B — Selective Reactivity Migration (AST-based, conservative).
//
// LOCKED RULES (per user sign-off):
//   ✅ Migrate ONLY scope=COMPONENT_RENDER  →  i18n.t(...) becomes t(...)
//   ✅ Insert `const { t } = useTranslation();` at start of OUTERMOST
//      top-level component body, only if hook absent
//   ✅ Insert `import { useTranslation } from 'react-i18next'` only if missing
//   ❌ DO NOT touch: MODULE_STATIC, COMPONENT_STATIC, UTIL, AMBIGUOUS
//   ❌ DO NOT remove `import i18n` (other scopes still use it)
//   ❌ DO NOT reformat anything else
//   ❌ DO NOT touch tests/snapshots
//
// Outputs:
//   1. /app/audit/R3B_MIGRATION_REPORT.json  — diff summary
//   2. /app/audit/R3_AMBIGUOUS_TODO.md       — manual review list
//
// Run: node scripts/r3b-reactivity-migrate.mjs
//
// Strategy:
//   - Single pass per file. Re-parse to get fresh AST offsets.
//   - Classify each `i18n.t(...)` call with same logic as R3A.
//   - Collect (start, end, replacement) edits + hook insertions.
//   - Apply edits in REVERSE offset order so positions stay valid.
//   - Preserve whitespace / comments / quotes exactly.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

const ROOT = '/app/frontend';
const SCAN_DIRS = ['app', 'src'];
const REPORT_PATH = '/app/audit/R3B_MIGRATION_REPORT.json';
const AMBIGUOUS_PATH = '/app/audit/R3_AMBIGUOUS_TODO.md';

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

const PARSER_OPTS = {
  sourceType: 'module',
  allowReturnOutsideFunction: true,
  plugins: ['typescript', 'jsx', 'classProperties', 'decorators-legacy', 'topLevelAwait'],
  errorRecovery: true,
};

// ────────────────────────────────────────────────────────────────────
// Classification helpers (mirror of R3A logic)
// ────────────────────────────────────────────────────────────────────
const isPascalCase = (n) => typeof n === 'string' && /^[A-Z][a-zA-Z0-9_]*$/.test(n);
const isUseHook = (n) => typeof n === 'string' && /^use[A-Z]/.test(n);

function functionInfo(path) {
  let name = null;
  if (path.isFunctionDeclaration()) name = path.node.id?.name ?? null;
  else if (path.isFunctionExpression()) name = path.node.id?.name ?? path.parent.id?.name ?? null;
  else if (path.isArrowFunctionExpression()) {
    if (path.parent.type === 'VariableDeclarator') name = path.parent.id?.name ?? null;
  }
  let returnsJsx = false;
  path.traverse({
    ReturnStatement(rp) {
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
    ArrowFunctionExpression(p) { p.skip(); },
    FunctionDeclaration(p) { p.skip(); },
    FunctionExpression(p) { p.skip(); },
  });
  if (path.isArrowFunctionExpression()) {
    const b = path.node.body;
    if (b.type === 'JSXElement' || b.type === 'JSXFragment') returnsJsx = true;
  }
  return {
    name,
    isComponent: returnsJsx || (isPascalCase(name) &&
      (path.isFunctionDeclaration() || path.isFunctionExpression() || path.isArrowFunctionExpression())),
    isHook: isUseHook(name),
    returnsJsx,
  };
}

function getEnclosingFunction(path) {
  let p = path.parentPath;
  while (p) {
    if (p.isFunctionDeclaration() || p.isFunctionExpression() ||
        p.isArrowFunctionExpression() || p.isObjectMethod() || p.isClassMethod()) return p;
    p = p.parentPath;
  }
  return null;
}

function isInsideJSX(path) {
  let p = path.parentPath;
  while (p) {
    const t = p.node.type;
    if (t === 'JSXExpressionContainer' || t === 'JSXAttribute' ||
        t === 'JSXSpreadAttribute' || t === 'JSXElement' || t === 'JSXFragment') return true;
    if (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression()) return false;
    p = p.parentPath;
  }
  return false;
}

function isAssignedToConstAtBodyRoot(path, componentBodyNode) {
  let p = path.parentPath;
  while (p) {
    if (p.node === componentBodyNode) return false;
    if (p.isVariableDeclarator()) {
      const decl = p.parentPath;
      if (decl?.parentPath?.node === componentBodyNode) return p.node.id?.name || true;
      return false;
    }
    if (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression()) return false;
    p = p.parentPath;
  }
  return false;
}

function isInsideStaticContainerAtBodyRoot(path, componentBodyNode) {
  let p = path.parentPath;
  let inContainer = false;
  while (p) {
    if (p.node === componentBodyNode) return false;
    if (p.isArrayExpression() || p.isObjectExpression()) inContainer = true;
    if (p.isVariableDeclarator()) {
      const decl = p.parentPath;
      if (decl?.parentPath?.node === componentBodyNode) return inContainer;
      return false;
    }
    if (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression()) return false;
    p = p.parentPath;
  }
  return false;
}

function alreadyUsesHookInBody(bodyNode) {
  if (!bodyNode || bodyNode.type !== 'BlockStatement') return false;
  for (const stmt of bodyNode.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (!d.init) continue;
      if (d.init.type === 'CallExpression' &&
          d.init.callee.type === 'Identifier' &&
          d.init.callee.name === 'useTranslation') return true;
    }
  }
  return false;
}

// Walk up to find the outermost MODULE-LEVEL function that is a "top component".
// Returns the path of that function, or null.
function findOutermostTopComponent(path, ast) {
  const chain = [];
  let p = path.parentPath;
  while (p) {
    if (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression()) {
      chain.push(p);
    }
    p = p.parentPath;
  }
  if (chain.length === 0) return null;
  // The outermost is the LAST in chain.
  const outermost = chain[chain.length - 1];
  // Must be module-level: its parent (FunctionDeclaration) is Program OR
  // (ArrowFunction/FunctionExpression) parent is VariableDeclarator whose parent is module-level VariableDeclaration.
  const parent = outermost.parent;
  const parentParent = outermost.parentPath?.parent;
  const isModuleLevel =
    (outermost.isFunctionDeclaration() && parent?.type === 'Program') ||
    (outermost.isFunctionDeclaration() && (parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration') && parentParent?.type === 'Program') ||
    (parent?.type === 'VariableDeclarator' &&
      outermost.parentPath?.parentPath?.parent?.type === 'Program' ||
      outermost.parentPath?.parentPath?.parent?.type === 'ExportNamedDeclaration') ||
    (parent?.type === 'ExportDefaultDeclaration' && parentParent?.type === 'Program');
  if (!isModuleLevel) return null;
  // Must be component-like
  const info = functionInfo(outermost);
  if (!(info.isComponent || info.isHook)) return null;
  return outermost;
}

// Check ALL hooks in chain (outermost component + any inner closures).
// Returns true if `t` is available via useTranslation anywhere up the chain.
function hookAvailableInChain(path, ast) {
  let p = path.parentPath;
  while (p) {
    if (p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression()) {
      if (p.node.body?.type === 'BlockStatement' && alreadyUsesHookInBody(p.node.body)) return true;
    }
    p = p.parentPath;
  }
  return false;
}

function hasUseTranslationImport(ast) {
  let has = false;
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    if (node.source.value !== 'react-i18next') continue;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier' &&
          spec.imported.type === 'Identifier' &&
          spec.imported.name === 'useTranslation') has = true;
    }
  }
  return has;
}

function lastImportEndOffset(ast) {
  let end = 0;
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      end = node.end;
    }
  }
  return end;
}

// ────────────────────────────────────────────────────────────────────
// Per-file migration
// ────────────────────────────────────────────────────────────────────
function migrateFile(src) {
  let ast;
  try { ast = parse(src, PARSER_OPTS); }
  catch (e) { return { error: e.message }; }

  /** @type {Array<{start:number,end:number,replacement:string,kind:string,meta?:any}>} */
  const edits = [];
  const sitesMigrated = [];
  const hooksToInsert = new Map(); // functionNode -> {bodyStart, name}
  const ambiguous = [];

  traverse(ast, {
    CallExpression(path) {
      const c = path.node.callee;
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
      if (!enclosing) return;

      const info = functionInfo(enclosing);
      const body = enclosing.get('body').node;
      const insideJsx = isInsideJSX(path);
      const inStaticContainer = isInsideStaticContainerAtBodyRoot(path, body);
      const assignedAtRoot = isAssignedToConstAtBodyRoot(path, body);

      let scope;
      if (!info.isComponent && !info.isHook) scope = 'UTIL';
      else if (inStaticContainer) scope = 'COMPONENT_STATIC';
      else if (insideJsx) scope = 'COMPONENT_RENDER';
      else if (assignedAtRoot) scope = 'AMBIGUOUS';
      else scope = 'UTIL';

      if (scope === 'AMBIGUOUS') {
        ambiguous.push({
          line: loc?.line,
          col: loc?.column,
          fnName: info.name ?? '<anon>',
          assignedTo: typeof assignedAtRoot === 'string' ? assignedAtRoot : null,
        });
        return;
      }
      if (scope !== 'COMPONENT_RENDER') return;

      // EDIT 1: replace `i18n.t` (the MemberExpression) with `t`
      const me = c; // MemberExpression node
      edits.push({
        start: me.start,
        end: me.end,
        replacement: 't',
        kind: 'callee_replace',
        meta: { line: loc?.line },
      });
      sitesMigrated.push({ line: loc?.line, fnName: info.name ?? '<anon>' });

      // Determine hook insertion target: outermost top-level component in chain
      if (!hookAvailableInChain(path, ast)) {
        const target = findOutermostTopComponent(path, ast);
        if (target && target.node.body?.type === 'BlockStatement') {
          if (!hooksToInsert.has(target.node)) {
            // body starts at '{' position
            const bodyStart = target.node.body.start; // offset of '{'
            hooksToInsert.set(target.node, {
              bodyStart,
              name: functionInfo(target).name ?? '<anon-component>',
            });
          }
        } else {
          // No safe top-level component to insert into. Skip migration of this site.
          // Revert the edit.
          edits.pop();
          sitesMigrated.pop();
        }
      }
    },
  });

  // Add EDITs for hook insertions (insert after the opening '{')
  const hooksInserted = [];
  for (const [fnNode, info] of hooksToInsert) {
    // Re-check the function's body for already inserted hook
    if (alreadyUsesHookInBody(fnNode.body)) continue;
    const insertPos = info.bodyStart + 1; // right after '{'
    edits.push({
      start: insertPos,
      end: insertPos,
      replacement: '\n  const { t } = useTranslation();',
      kind: 'hook_insert',
      meta: { component: info.name },
    });
    hooksInserted.push({ component: info.name, atOffset: insertPos });
  }

  // useTranslation import
  let importInserted = false;
  if (sitesMigrated.length > 0 && !hasUseTranslationImport(ast)) {
    const insertPos = lastImportEndOffset(ast);
    edits.push({
      start: insertPos,
      end: insertPos,
      replacement: `\nimport { useTranslation } from 'react-i18next';`,
      kind: 'import_insert',
    });
    importInserted = true;
  }

  if (edits.length === 0) {
    return { sitesMigrated: 0, hooksInserted: [], importInserted: false, ambiguous };
  }

  // Apply edits in REVERSE offset order
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }

  // Sanity re-parse — if it fails, abort changes to this file
  try { parse(out, PARSER_OPTS); }
  catch (e) {
    return { error: `post-parse failed: ${e.message}`, abortedAt: 'reparse' };
  }

  return {
    newSrc: out,
    sitesMigrated: sitesMigrated.length,
    sites: sitesMigrated,
    hooksInserted,
    importInserted,
    ambiguous,
  };
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────
const report = {
  generatedAt: new Date().toISOString(),
  rulesLocked: 'COMPONENT_RENDER only; conservative; reparse-validated',
  totals: { filesTouched: 0, sitesMigrated: 0, hooksInserted: 0, importsInserted: 0, parseErrors: 0, abortedFiles: 0, ambiguousSeen: 0 },
  files: [],
};
const ambiguousAll = [];

for (const dir of SCAN_DIRS) {
  const abs = join(ROOT, dir);
  try { statSync(abs); } catch { continue; }
  for await (const file of walk(abs)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('i18n.t(')) continue;
    const rel = relative(ROOT, file);
    const r = migrateFile(src);

    if (r.error) {
      report.totals.parseErrors++;
      if (r.abortedAt) report.totals.abortedFiles++;
      report.files.push({ file: rel, error: r.error });
      continue;
    }
    if (r.ambiguous?.length) {
      report.totals.ambiguousSeen += r.ambiguous.length;
      for (const a of r.ambiguous) ambiguousAll.push({ file: rel, ...a });
    }
    if (!r.sitesMigrated) continue;

    writeFileSync(file, r.newSrc);
    report.totals.filesTouched++;
    report.totals.sitesMigrated += r.sitesMigrated;
    report.totals.hooksInserted += r.hooksInserted.length;
    if (r.importInserted) report.totals.importsInserted++;
    report.files.push({
      file: rel,
      sitesMigrated: r.sitesMigrated,
      hooksInserted: r.hooksInserted,
      importInserted: r.importInserted,
      sample: r.sites.slice(0, 3),
    });
  }
}

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

// ────────────────────────────────────────────────────────────────────
// AMBIGUOUS TODO doc
// ────────────────────────────────────────────────────────────────────
const lines = [];
lines.push('# R3 AMBIGUOUS TODO — manual review');
lines.push('');
lines.push(`> Generated: ${report.generatedAt}`);
lines.push(`> Total: ${ambiguousAll.length} sites across ${new Set(ambiguousAll.map(a => a.file)).size} files`);
lines.push('');
lines.push('Pattern: `const X = i18n.t(...)` at component body root, used inside JSX later.');
lines.push('Could be:');
lines.push('- (A) intentional pre-render formatting (e.g. heavy interpolation) → KEEP `i18n.t`');
lines.push('- (B) just a label that should be reactive → migrate to `t` (parent already has hook)');
lines.push('');
lines.push('Decide per-site. Test by switching language and confirming the label updates.');
lines.push('');
lines.push('| File | Line | Function | Const name |');
lines.push('|------|------|----------|------------|');
const sorted = ambiguousAll.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
for (const a of sorted) {
  lines.push(`| \`${a.file}\` | ${a.line} | \`${a.fnName}\` | \`${a.assignedTo ?? '?'}\` |`);
}
writeFileSync(AMBIGUOUS_PATH, lines.join('\n') + '\n');

console.log('=== R3B Migration ===');
console.log('totals:', JSON.stringify(report.totals, null, 2));
console.log(`report  → ${REPORT_PATH}`);
console.log(`ambig   → ${AMBIGUOUS_PATH}`);

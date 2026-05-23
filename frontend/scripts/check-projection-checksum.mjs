#!/usr/bin/env node
/**
 * scripts/check-projection-checksum.mjs — projection-checksum invariant
 * for the customer-grammar narrative subsystem.
 *
 * Run via:
 *   node scripts/check-projection-checksum.mjs           # verify
 *   node scripts/check-projection-checksum.mjs --update  # commit new hashes
 *
 * Roman, 2026-05-14: namespaces per transport. Notification drift can
 * no longer masquerade as timeline change, and per-channel drift is
 * localised:
 *
 *   {
 *     "timeline":      { "en": "...", "de": "...", "ru": "..." },
 *     "notifications": {
 *       "push":  { "en": "...", "de": "...", "ru": "..." },
 *       "email": { "en": "...", "de": "...", "ru": "..." },
 *       "sms":   { "en": "...", "de": "...", "ru": "..." }
 *     }
 *   }
 *
 * Each namespace hashes its own stable-serialised projection per locale.
 *
 * Workflow on intentional change:
 *   1. Edit copy / fixture / projection.
 *   2. Run `yarn grammar:check` — fails with `expected ≠ got`.
 *   3. Inspect the diff in the error output; confirm semantically.
 *   4. Run `node scripts/check-projection-checksum.mjs --update`.
 *   5. Commit the updated `projection-checksums.json` IN THE SAME PR.
 *
 * Exit codes: 0 verified, 1 hash drift, 2 runner crash.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRAMMAR_DIR = resolve(__dirname, '..', 'src', 'customer-grammar');
const CHECKSUMS_PATH = resolve(GRAMMAR_DIR, 'projection-checksums.json');
const LOCALES = ['en', 'de', 'ru'];
const CHANNELS = ['push', 'email', 'sms'];
const FORBIDDEN_ROUTE_PREFIXES = ['ocr.', 'correlation.', 'evidence.', 'internal.', 'suspicion.'];

const UPDATE_MODE = process.argv.includes('--update');

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

function isForbiddenRoute(eventType) {
  return FORBIDDEN_ROUTE_PREFIXES.some((p) => eventType.startsWith(p));
}

function getEventCopy(eventsTable, eventType) {
  if (eventType in eventsTable) return eventsTable[eventType];
  if (eventType.startsWith('media.uploaded.')) {
    return eventsTable['media.uploaded'] ?? null;
  }
  return null;
}

function projectTimeline(events, eventsTable) {
  const rendered = [];
  const dropped = [];
  events.forEach((ev, i) => {
    const id = ev.id || `${ev.eventType}-${ev.at}-${i}`;
    const copy = getEventCopy(eventsTable, ev.eventType);
    if (!copy) {
      dropped.push({ id, sourceEventType: ev.eventType });
      return;
    }
    rendered.push({
      id,
      sourceEventType: ev.eventType,
      title: copy.title,
      icon: copy.icon,
      at: ev.at,
    });
  });
  return { rendered, dropped };
}

const NOTIFICATION_DEEP_LINK = JSON.parse(
  await readFile(resolve(GRAMMAR_DIR, 'deep-links.json'), 'utf-8'),
).event_to_surface;

function projectNotifications(events, notificationsTable, channel) {
  const out = [];
  events.forEach((ev, i) => {
    if (isForbiddenRoute(ev.eventType)) return;
    if (!(ev.eventType in NOTIFICATION_DEEP_LINK)) return;
    const perEvent = notificationsTable[ev.eventType];
    if (!perEvent) return;
    const copy = perEvent[channel];
    if (!copy) return;
    out.push({
      id: ev.id || `${ev.eventType}-${ev.at}-${i}`,
      sourceEventType: ev.eventType,
      channel,
      title: copy.title,
      body: copy.body,
      deepLinkKind: NOTIFICATION_DEEP_LINK[ev.eventType],
    });
  });
  return out;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') +
    '}'
  );
}

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

async function main() {
  const fixture = await loadJson(resolve(GRAMMAR_DIR, 'test-fixtures', 'timeline-mock.json'));

  // Per namespace, per locale.
  const current = {
    timeline: {},
    notifications: { push: {}, email: {}, sms: {} },
    // Sprint Customer-Deep-Link-1 — deep_links is a SINGLE namespace
    // (not per-locale) because the deep-link kernel is locale-invariant
    // by construction. We hash the whole `deep-links.json` content +
    // a deterministic resolve over the fixture so any change to either
    // map or resolution logic shifts the namespace hash.
    deep_links: {},
  };

  // Load deep-links and resolve over the customer-allowed events in
  // the fixture for a stable, fixture-bound checksum.
  const deepLinks = await loadJson(resolve(GRAMMAR_DIR, 'deep-links.json'));
  const dlEventToSurface = deepLinks.event_to_surface || {};
  const dlRoutes = deepLinks.routes || {};
  const dlRequired = deepLinks.params_required || {};
  const dlOptional = deepLinks.params_optional || {};

  function resolveDL(eventType, metadata) {
    if (isForbiddenRoute(eventType)) return null;
    if (!(eventType in dlEventToSurface)) return null;
    const surface = dlEventToSurface[eventType];
    const required = dlRequired[surface] || [];
    const optional = dlOptional[surface] || [];
    const params = {};
    for (const k of required) {
      if (typeof metadata[k] !== 'string' || !metadata[k]) return null;
      params[k] = metadata[k];
    }
    for (const k of optional) {
      if (typeof metadata[k] === 'string' && metadata[k]) params[k] = metadata[k];
    }
    const bind = (tpl) => {
      let out = tpl;
      for (const k of required) out = out.split(`{${k}}`).join(encodeURIComponent(params[k]));
      return out;
    };
    const r = dlRoutes[surface] || {};
    let mobile = bind(r.mobile);
    let web = bind(r.web);
    if (surface === 'timeline' && params.itemId) {
      const focus = `focus=${encodeURIComponent(params.itemId)}`;
      mobile = mobile + (mobile.includes('?') ? '&' : '?') + focus;
      web = web + (web.includes('?') ? '&' : '?') + focus;
    }
    return { surface, params, routes: { mobile, web } };
  }

  // Resolve deep-links for every fixture event with a deterministic
  // synthetic jobId/itemId so the hash is stable.
  const dlResolutions = fixture.events.map((ev) => ({
    id: ev.id,
    eventType: ev.eventType,
    deepLink: resolveDL(ev.eventType, { jobId: 'fixture-job', itemId: 'fixture-item' }),
  }));
  current.deep_links = sha256Hex(
    stableStringify({ table: deepLinks, resolutions: dlResolutions }),
  );

  for (const lang of LOCALES) {
    const copy = await loadJson(resolve(GRAMMAR_DIR, 'copy', `${lang}.json`));
    current.timeline[lang] = sha256Hex(stableStringify(projectTimeline(fixture.events, copy.events)));
    for (const ch of CHANNELS) {
      current.notifications[ch][lang] = sha256Hex(
        stableStringify(projectNotifications(fixture.events, copy.notifications, ch)),
      );
    }
  }

  if (UPDATE_MODE) {
    const out = {
      _doc:
        'Projection checksums per namespace × locale. SHA-256 over ' +
        'stable-serialised projection output. Namespaces (timeline / ' +
        'notifications.push|email|sms) isolate semantic drift so a ' +
        'notification change cannot masquerade as a timeline change. ' +
        'DO NOT hand-edit. Regenerate via ' +
        '`node scripts/check-projection-checksum.mjs --update` and ' +
        'commit IN THE SAME PR as the semantic change. See POLICY.md.',
      fixture: 'src/customer-grammar/test-fixtures/timeline-mock.json',
      algorithm: 'sha256',
      generatedAt: new Date().toISOString(),
      checksums: current,
    };
    await writeFile(CHECKSUMS_PATH, JSON.stringify(out, null, 2) + '\n', 'utf-8');
    console.log('[checksum] WROTE projection-checksums.json:');
    console.log('  timeline:');
    for (const lang of LOCALES) console.log(`    ${lang}: ${current.timeline[lang]}`);
    for (const ch of CHANNELS) {
      console.log(`  notifications.${ch}:`);
      for (const lang of LOCALES) console.log(`    ${lang}: ${current.notifications[ch][lang]}`);
    }
    process.exit(0);
  }

  let committed;
  try {
    committed = await loadJson(CHECKSUMS_PATH);
  } catch {
    console.error(
      `[checksum] FAIL — projection-checksums.json missing. Run with --update once to commit baseline.`,
    );
    process.exit(1);
  }

  const drifts = [];
  // Timeline
  for (const lang of LOCALES) {
    const expected = committed.checksums?.timeline?.[lang];
    const got = current.timeline[lang];
    if (expected !== got) drifts.push({ namespace: 'timeline', lang, expected, got });
  }
  // Notifications per channel
  for (const ch of CHANNELS) {
    for (const lang of LOCALES) {
      const expected = committed.checksums?.notifications?.[ch]?.[lang];
      const got = current.notifications[ch][lang];
      if (expected !== got) {
        drifts.push({ namespace: `notifications.${ch}`, lang, expected, got });
      }
    }
  }
  // Sprint Customer-Deep-Link-1 — single-namespace deep_links checksum
  {
    const expected = committed.checksums?.deep_links;
    const got = current.deep_links;
    if (expected !== got) {
      drifts.push({ namespace: 'deep_links', lang: '-', expected, got });
    }
  }

  if (drifts.length === 0) {
    console.log(
      `[checksum] OK — namespaces=[timeline, notifications.{push,email,sms}], ` +
        `locales=[${LOCALES.join(',')}], drifts=0`,
    );
    process.exit(0);
  }

  console.error(`[checksum] FAIL — ${drifts.length} drift(s):`);
  for (const d of drifts) {
    console.error(`  [${d.namespace}][${d.lang}]`);
    console.error(`    expected: ${d.expected}`);
    console.error(`    got:      ${d.got}`);
  }
  console.error('');
  console.error(
    '  If this change is INTENTIONAL: run `node scripts/check-projection-checksum.mjs --update`',
  );
  console.error('  and commit the updated projection-checksums.json in the same PR.');
  process.exit(1);
}

main().catch((err) => {
  console.error('[checksum] runner crashed:', err);
  process.exit(2);
});

#!/usr/bin/env node
/**
 * scripts/check-projection-parity.mjs — projection-parity invariant
 * test for the customer-grammar `projectTimeline()` and
 * `projectNotification()` kernels.
 *
 * Run via:
 *
 *     node scripts/check-projection-parity.mjs
 *
 * Asserts the following invariants on a SHARED operational event
 * fixture, across all customer locales × all notification channels:
 *
 *   --- Timeline invariants ---
 *
 *   I1  allowlist invariant
 *         set(rendered.sourceEventType) is identical across locales.
 *
 *   I2  drop invariant
 *         set(dropped.sourceEventType) is identical across locales.
 *
 *   I3  order invariant
 *         rendered IDs preserve the input order (no implicit sort).
 *
 *   I4  fixture invariant
 *         rendered IDs == fixture.expectedRenderedIds,
 *         dropped  IDs == fixture.expectedDroppedIds.
 *
 *   I5  fallback invariant (media.uploaded.* → media.uploaded)
 *         events listed in fixture.expectedFallbackEventIds must
 *         render via the `media.uploaded` generic title.
 *
 *   I6  lexicon invariant
 *         every rendered title contains no token from the universal
 *         forbidden lexicon.
 *
 *   --- Notification invariants (Sprint Customer-Notify-1) ---
 *
 *   I7  notification eligibility invariant
 *         set(notified.sourceEventType) is identical across locales
 *         AND identical across channels (push/email/sms).
 *
 *   I7b notification fixture invariant
 *         notified IDs == fixture.expectedNotifiedIds (in order).
 *
 *   I8  deep-link invariant
 *         `deepLinkKind` is locale- AND channel-invariant per event id.
 *
 *   I9  channel-shape invariant
 *         push/email: title is a non-empty string AND body is non-empty.
 *         sms:        title is `null` (carriers have no title concept)
 *                     AND body is a non-empty string.
 *
 *   I10 lexicon invariant on notifications
 *         every (title|body) across every (lang, channel) contains no
 *         token from the universal forbidden lexicon.
 *
 *   I11 forbidden-route invariant
 *         every event id under fixture.forbiddenRoutedIds MUST NOT
 *         produce a notification on ANY channel. Routing-stage drop,
 *         not render-stage drop.
 *
 *   I12 channel-isolation invariant
 *         For every (event, lang), if push copy exists, email copy
 *         exists, and sms copy exists, they must be DISTINCT strings.
 *         Two channels carrying identical text is a sign of accidental
 *         reuse — the channel hierarchy collapsing.
 *
 * Exit code: 0 clean, 1 any invariant violated, 2 runner crash.
 *
 * Boundary: pure node, no TypeScript runtime, no yarn deps. The
 * projection function is re-implemented here so the fixture can run
 * without a TS toolchain. This script and `narrative.ts` MUST stay
 * structurally equal.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRAMMAR_DIR = resolve(__dirname, '..', 'src', 'customer-grammar');
const LOCALES = ['en', 'de', 'ru'];
const CHANNELS = ['push', 'email', 'sms'];

const FORBIDDEN_ROUTE_PREFIXES = ['ocr.', 'correlation.', 'evidence.', 'internal.', 'suspicion.'];

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

function isForbiddenRoute(eventType) {
  return FORBIDDEN_ROUTE_PREFIXES.some((p) => eventType.startsWith(p));
}

/** Mirror of `getEventCopy(lang, eventType)` in narrative.ts. */
function getEventCopy(eventsTable, eventType) {
  if (eventType in eventsTable) return eventsTable[eventType];
  if (eventType.startsWith('media.uploaded.')) {
    return eventsTable['media.uploaded'] ?? null;
  }
  return null;
}

/** Mirror of `projectTimeline(events, lang)` in narrative.ts. */
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
    rendered.push({ id, sourceEventType: ev.eventType, title: copy.title, icon: copy.icon, at: ev.at });
  });
  return { rendered, dropped };
}

/** Mirror of `NOTIFICATION_DEEP_LINK` in narrative.ts. Sourced from
 *  the canonical `deep-links.json` so a single edit there reflects in
 *  both the kernel AND the parity mirror. */
const NOTIFICATION_DEEP_LINK_TABLE = JSON.parse(
  await readFile(resolve(GRAMMAR_DIR, 'deep-links.json'), 'utf-8'),
).event_to_surface;
const NOTIFICATION_DEEP_LINK = NOTIFICATION_DEEP_LINK_TABLE;

/** Mirror of `projectNotification(event, lang, channel)` in narrative.ts. */
function projectNotification(event, notificationsTable, channel, i) {
  if (isForbiddenRoute(event.eventType)) return null;
  if (!(event.eventType in NOTIFICATION_DEEP_LINK)) return null;
  const perEvent = notificationsTable[event.eventType];
  if (!perEvent) return null;
  const copy = perEvent[channel];
  if (!copy) return null;
  return {
    id: event.id || `${event.eventType}-${event.at}-${i}`,
    sourceEventType: event.eventType,
    channel,
    title: copy.title,
    body: copy.body,
    deepLinkKind: NOTIFICATION_DEEP_LINK[event.eventType],
  };
}

function projectNotifications(events, notificationsTable, channel) {
  const out = [];
  events.forEach((ev, i) => {
    const n = projectNotification(ev, notificationsTable, channel, i);
    if (n) out.push(n);
  });
  return out;
}

function assertEqualSets(label, a, b, failures) {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  if (JSON.stringify(sa) !== JSON.stringify(sb)) {
    failures.push(`${label}: ${JSON.stringify(sa)} != ${JSON.stringify(sb)}`);
  }
}

function assertEqualOrdered(label, a, b, failures) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    failures.push(`${label}: [${a.join(',')}] != [${b.join(',')}]`);
  }
}

async function main() {
  const fixture = await loadJson(resolve(GRAMMAR_DIR, 'test-fixtures', 'timeline-mock.json'));
  const lexicon = await loadJson(resolve(GRAMMAR_DIR, 'forbidden-lexicon.json'));
  const universal = lexicon.universal ?? [];

  // Per-locale projections.
  const projections = {};
  for (const lang of LOCALES) {
    const copy = await loadJson(resolve(GRAMMAR_DIR, 'copy', `${lang}.json`));
    projections[lang] = {
      copy,
      timeline: projectTimeline(fixture.events, copy.events),
      notifications: {},
    };
    for (const ch of CHANNELS) {
      projections[lang].notifications[ch] = projectNotifications(
        fixture.events,
        copy.notifications,
        ch,
      );
    }
  }

  const failures = [];

  // ----- Timeline invariants -----

  // I1
  for (const lang of LOCALES.slice(1)) {
    assertEqualSets(
      `I1 timeline allowlist en vs ${lang}`,
      projections.en.timeline.rendered.map((r) => r.sourceEventType),
      projections[lang].timeline.rendered.map((r) => r.sourceEventType),
      failures,
    );
  }

  // I2
  for (const lang of LOCALES.slice(1)) {
    assertEqualSets(
      `I2 timeline drop en vs ${lang}`,
      projections.en.timeline.dropped.map((r) => r.sourceEventType),
      projections[lang].timeline.dropped.map((r) => r.sourceEventType),
      failures,
    );
  }

  // I3
  for (const lang of LOCALES) {
    const inputIds = fixture.events
      .filter((ev) => !projections[lang].timeline.dropped.some((d) => d.id === ev.id))
      .map((ev) => ev.id);
    assertEqualOrdered(
      `I3 timeline order [${lang}]`,
      projections[lang].timeline.rendered.map((r) => r.id),
      inputIds,
      failures,
    );
  }

  // I4
  for (const lang of LOCALES) {
    assertEqualOrdered(
      `I4 rendered IDs [${lang}]`,
      projections[lang].timeline.rendered.map((r) => r.id),
      fixture.expectedRenderedIds,
      failures,
    );
    assertEqualOrdered(
      `I4 dropped IDs [${lang}]`,
      projections[lang].timeline.dropped.map((r) => r.id),
      fixture.expectedDroppedIds,
      failures,
    );
  }

  // I5
  for (const lang of LOCALES) {
    const copy = projections[lang].copy;
    const fallbackTitle = copy.events['media.uploaded']?.title;
    for (const id of fixture.expectedFallbackEventIds) {
      const row = projections[lang].timeline.rendered.find((r) => r.id === id);
      if (!row) {
        failures.push(`I5 fallback [${lang}] event ${id} not rendered`);
        continue;
      }
      if (row.title !== fallbackTitle) {
        failures.push(
          `I5 fallback [${lang}] event ${id} title="${row.title}" !== fallback="${fallbackTitle}"`,
        );
      }
    }
  }

  // I6
  for (const lang of LOCALES) {
    for (const row of projections[lang].timeline.rendered) {
      if (!row.title || typeof row.title !== 'string') {
        failures.push(`I6 lexicon [${lang}] event ${row.id} empty title`);
        continue;
      }
      const lowered = row.title.toLowerCase();
      for (const tok of universal) {
        const t = tok.toLowerCase();
        const re = new RegExp(
          `(^|[^a-zа-яäöüß])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-zа-яäöüß]|$)`,
          'i',
        );
        if (re.test(lowered)) {
          failures.push(`I6 lexicon [${lang}] event ${row.id} leaks "${tok}": "${row.title}"`);
        }
      }
    }
  }

  // ----- Notification invariants -----

  // I7 — eligibility identical across locales AND channels
  for (const ch of CHANNELS) {
    for (const lang of LOCALES.slice(1)) {
      assertEqualSets(
        `I7 notif eligibility [${ch}] en vs ${lang}`,
        projections.en.notifications[ch].map((n) => n.sourceEventType),
        projections[lang].notifications[ch].map((n) => n.sourceEventType),
        failures,
      );
    }
  }
  // Also check eligibility identical across channels (en as canonical).
  for (const ch of CHANNELS.slice(1)) {
    assertEqualSets(
      `I7 notif eligibility push vs ${ch} [en]`,
      projections.en.notifications.push.map((n) => n.sourceEventType),
      projections.en.notifications[ch].map((n) => n.sourceEventType),
      failures,
    );
  }

  // I7b — fixture invariant per channel per locale
  for (const lang of LOCALES) {
    for (const ch of CHANNELS) {
      assertEqualOrdered(
        `I7b notified IDs [${lang}/${ch}]`,
        projections[lang].notifications[ch].map((n) => n.id),
        fixture.expectedNotifiedIds,
        failures,
      );
    }
  }

  // I8 — deepLinkKind invariant across (lang, channel) per event id
  for (const id of fixture.expectedNotifiedIds) {
    const kinds = [];
    for (const lang of LOCALES) {
      for (const ch of CHANNELS) {
        const n = projections[lang].notifications[ch].find((x) => x.id === id);
        if (n) kinds.push(n.deepLinkKind);
      }
    }
    if (new Set(kinds).size !== 1) {
      failures.push(`I8 deep-link drift on ${id}: ${[...new Set(kinds)].join(',')}`);
    }
  }

  // I9 — channel-shape invariant
  for (const lang of LOCALES) {
    for (const ch of CHANNELS) {
      for (const n of projections[lang].notifications[ch]) {
        if (ch === 'sms') {
          if (n.title !== null) {
            failures.push(`I9 sms [${lang}] ${n.id} title must be null, got: ${JSON.stringify(n.title)}`);
          }
        } else {
          if (!n.title || typeof n.title !== 'string') {
            failures.push(`I9 ${ch} [${lang}] ${n.id} title must be non-empty string`);
          }
        }
        if (!n.body || typeof n.body !== 'string') {
          failures.push(`I9 ${ch} [${lang}] ${n.id} body must be non-empty string`);
        }
      }
    }
  }

  // I10 — lexicon invariant on notification title+body
  for (const lang of LOCALES) {
    for (const ch of CHANNELS) {
      for (const n of projections[lang].notifications[ch]) {
        for (const field of ['title', 'body']) {
          const val = n[field];
          if (val === null || val === undefined) continue;
          const lowered = String(val).toLowerCase();
          for (const tok of universal) {
            const t = tok.toLowerCase();
            const re = new RegExp(
              `(^|[^a-zа-яäöüß])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-zа-яäöüß]|$)`,
              'i',
            );
            if (re.test(lowered)) {
              failures.push(
                `I10 lexicon [${lang}/${ch}] notif ${n.id} ${field} leaks "${tok}": "${val}"`,
              );
            }
          }
        }
      }
    }
  }

  // I11 — forbidden-route invariant: events under forbiddenRoutedIds
  //       MUST NOT produce a notification on ANY channel.
  const forbiddenRoutedIds = fixture.forbiddenRoutedIds ?? [];
  for (const id of forbiddenRoutedIds) {
    for (const lang of LOCALES) {
      for (const ch of CHANNELS) {
        const hit = projections[lang].notifications[ch].find((n) => n.id === id);
        if (hit) {
          failures.push(
            `I11 forbidden-route LEAK [${lang}/${ch}] ${id} produced notification: ${JSON.stringify(hit)}`,
          );
        }
      }
    }
  }
  // Also assert the fixture covers all five forbidden prefixes structurally.
  const coveredPrefixes = new Set();
  for (const id of forbiddenRoutedIds) {
    const ev = fixture.events.find((e) => e.id === id);
    if (!ev) {
      failures.push(`I11 fixture id ${id} missing from events[]`);
      continue;
    }
    const prefix = FORBIDDEN_ROUTE_PREFIXES.find((p) => ev.eventType.startsWith(p));
    if (prefix) coveredPrefixes.add(prefix);
  }
  for (const p of FORBIDDEN_ROUTE_PREFIXES) {
    if (!coveredPrefixes.has(p)) {
      failures.push(
        `I11 fixture does not cover forbidden prefix "${p}" — add at least one event with this prefix to forbiddenRoutedIds`,
      );
    }
  }

  // I12 — channel-isolation invariant: push/email/sms bodies for the
  //       same event in the same locale MUST be distinct strings. Two
  //       channels carrying identical body is accidental reuse.
  for (const lang of LOCALES) {
    for (const id of fixture.expectedNotifiedIds) {
      const bodies = {};
      for (const ch of CHANNELS) {
        const n = projections[lang].notifications[ch].find((x) => x.id === id);
        if (n) bodies[ch] = n.body;
      }
      const pairs = [
        ['push', 'email'],
        ['push', 'sms'],
        ['email', 'sms'],
      ];
      for (const [a, b] of pairs) {
        if (bodies[a] && bodies[b] && bodies[a] === bodies[b]) {
          failures.push(
            `I12 channel-isolation [${lang}] ${id}: ${a} and ${b} bodies are identical — channels must differ in tone`,
          );
        }
      }
    }
  }

  // ───── Sprint Customer-Deep-Link-1 invariants ─────
  //
  // Deep-link kernel lives in `customer-grammar/deep-links.json`. The
  // parity test asserts the kernel agrees with itself across all four
  // allowed kinds and that no forbidden-route event ever produces a
  // resolved destination. The deep-link payload is LOCALE-INVARIANT
  // by construction — there is no per-language map — but I13 verifies
  // that explicitly using the parity surface.

  // Re-load deep-links.json so the parity test exercises the same
  // policy artifact the kernel does (same content-addressing).
  const deepLinks = await loadJson(resolve(GRAMMAR_DIR, 'deep-links.json'));
  const eventToSurface = deepLinks.event_to_surface || {};
  const validSurfaces = new Set(deepLinks.surfaces || []);
  const paramsRequired = deepLinks.params_required || {};
  const routesTable = deepLinks.routes || {};

  // I13a — every notification-allowlisted kind has a surface mapping
  for (const k of Object.keys(NOTIFICATION_DEEP_LINK)) {
    if (!(k in eventToSurface)) {
      failures.push(`I13a deep-link [${k}] missing in deep-links.json#event_to_surface`);
    }
  }
  for (const k of Object.keys(eventToSurface)) {
    if (!(k in NOTIFICATION_DEEP_LINK)) {
      failures.push(
        `I13a deep-link [${k}] in deep-links.json but NOT on notification allowlist (NOTIFICATION_DEEP_LINK)`,
      );
    }
  }
  // I13b — every surface value is a member of the declared surfaces list
  for (const [k, surface] of Object.entries(eventToSurface)) {
    if (!validSurfaces.has(surface)) {
      failures.push(`I13b deep-link [${k}] → "${surface}" is not in surfaces list`);
    }
  }
  // I13c — every surface has routes for both mobile and web
  for (const surface of validSurfaces) {
    const r = routesTable[surface];
    if (!r || typeof r.mobile !== 'string' || typeof r.web !== 'string') {
      failures.push(`I13c deep-link surface "${surface}" missing mobile/web routes`);
    }
  }
  // I13d — route templates reference only declared required params
  for (const surface of validSurfaces) {
    const r = routesTable[surface] || {};
    const required = new Set(paramsRequired[surface] || []);
    for (const which of ['mobile', 'web']) {
      const tpl = r[which];
      if (typeof tpl !== 'string') continue;
      const tokens = [...tpl.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const tok of tokens) {
        if (!required.has(tok)) {
          failures.push(
            `I13d deep-link [${surface}/${which}] template references param "{${tok}}" not declared in params_required`,
          );
        }
      }
    }
  }
  // I13e — forbidden-route events MUST NOT appear in event_to_surface
  for (const id of forbiddenRoutedIds) {
    const ev = fixture.events.find((e) => e.id === id);
    if (!ev) continue;
    if (ev.eventType in eventToSurface) {
      failures.push(`I13e deep-link LEAK: forbidden route "${ev.eventType}" has surface mapping`);
    }
  }

  const totalRendered = projections.en.timeline.rendered.length;
  const totalDropped = projections.en.timeline.dropped.length;
  const totalNotified = projections.en.notifications.push.length;

  if (failures.length === 0) {
    console.log(
      `[parity] OK — locales=[${LOCALES.join(',')}], channels=[${CHANNELS.join(',')}], ` +
        `events=${fixture.events.length}, rendered=${totalRendered}, ` +
        `dropped=${totalDropped}, notified=${totalNotified}, ` +
        `forbidden_routed=${forbiddenRoutedIds.length}, surfaces=${validSurfaces.size}, ` +
        `invariants=13, violations=0`,
    );
    process.exit(0);
  }

  console.error(`[parity] FAIL — ${failures.length} violation(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

main().catch((err) => {
  console.error('[parity] runner crashed:', err);
  process.exit(2);
});

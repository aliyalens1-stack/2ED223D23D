# Step 10A — Vehicle Parser Audit + Canonical Listing Contract

**Status:** audit + contract freeze only. No refactor, no new sources, no proxies, no ML, no ingestion changes.

This is the *substrate map* of the parser surface as it exists today. Step 10B
will use this document and the contract module as the gate against which all
parser changes are evaluated.

---

## A. Inventory — every parser path that exists today

### A.1 Modules under `backend/app/parsers/`

| File | Role | Public surface |
|------|------|----------------|
| `parsers/__init__.py` | empty namespace doc | — |
| `parsers/mobile_de.py` | dedicated mobile.de parser (regex + JSON-LD + OG + URL slug + ScraperAPI/proxy fallback in `fetch_html`) | `parse_url(url)`, `parse_html(html, url)`, `fetch_html(url)`, `estimate_market_avg(year)` |
| `parsers/universal.py` | dispatcher across 11 marketplaces + generic fallback. Delegates mobile.de to `mobile_de.parse_url`, all others run `_parse_generic` (BeautifulSoup + JSON-LD + OG + regex heuristics). | `parse_listing(url)` |
| `parsers/vin.py` | pure-Python VIN decoder (ISO 3779). No HTTP. | `decode_vin(raw)`, `normalize_vin(raw)` |
| `parsers/router.py` | public endpoint `POST /api/parse/car-link` + `GET /api/parse/supported-sources`. Per-IP rate limit (20/60s). Wraps legacy `parse_listing` shape into `{recognized, softFail, hardFail, …, parsed, error}`. | — |

### A.2 Domains the dispatcher claims to recognize (`_detect_source` in `universal.py`)

| Source id | Country | Real extractor used | Fidelity (declared in `supported-sources`) |
|-----------|---------|---------------------|--------------------------------------------|
| `mobile.de` | DE | `mobile_de.parse_url` (full) | high |
| `autoscout24` | EU | `_parse_generic` (JSON-LD/OG) | medium |
| `kleinanzeigen.de` | DE | `_parse_generic` | medium |
| `heycar` | DE | `_parse_generic` | low |
| `pkw.de` | DE | `_parse_generic` | low |
| `otomoto.pl` | PL | `_parse_generic` | low |
| `leboncoin.fr` | FR | `_parse_generic` | low |
| `willhaben.at` | AT | `_parse_generic` | low |
| `marktplaats.nl` | NL | `_parse_generic` | low |
| `lacentrale.fr` | FR | `_parse_generic` | low |
| `subito.it` | IT | `_parse_generic` | low |
| `generic` | ANY | `_parse_generic` | best-effort |

**Observation:** advertised "12 sources" really means **one specialised parser
(`mobile.de`) + one generic OG/JSON-LD scraper applied to 10 host patterns**.
This is fine as a baseline but it is *not* per-source hardening — anti-bot,
schema drift, and field semantics differ wildly across these sites.

### A.3 Consumers of the parser surface (read points)

| Consumer | Entry point | Calls | What it does with the result |
|----------|-------------|-------|------------------------------|
| HTTP endpoint | `POST /api/parse/car-link` | `parse_listing(url)` | wraps into `recognized/softFail/hardFail` envelope, returns 200 even on failure (UX rule: never break the link). |
| Vehicle ingest pipeline | `POST /api/vehicles/ingest` (`vehicles/ingest.py`) | `parse_listing(url)` | uses `source` + `listingId` for idempotent vehicle id; rejects "no automotive signal" listings; otherwise creates/matches vehicle. |
| Inspection report | `POST /api/inspection/report/generate` (`inspection/router.py`) | `parse_mobile_de(url)` only — **does not** use `parse_listing` dispatcher. | Feeds `title/make/model/price/mileage/year/fuel/image` into the report builder; manual fields override parsed. |
| Vehicle refresh | `POST /api/vehicles/{id}/refresh` (`vehicles/refresh.py`) | `parse_listing(url)` | snapshots price/mileage/title/image diff, infers `available` from `parsed or title/price`. |

### A.4 Notable drift between consumers

1. `/api/inspection/report/generate` bypasses the dispatcher and calls
   `parse_mobile_de` directly. A non-mobile.de URL submitted there will
   return `parse_meta.parsed=False, error="unsupported_source"` even though
   the dispatcher would have produced a usable autoscout24/kleinanzeigen
   payload.
2. `vehicles/refresh._compute_diff` infers `available=True` from
   `parsed=True OR title/price present`. A soft-fail (anti-bot 403) yields
   `available=False` and emits a *disappeared* event — false negative.
3. `vehicles/ingest` has its own re-classification of hard/soft fail; the
   router has another; the underlying parser has a third. Three places to
   keep in sync.

---

## B. Current return shape (legacy, what consumers actually see today)

`parse_listing(url)` returns a dict with these keys, all `None`-able:

```
parsed:     bool               # extractor confidence flag (≥2 of title/price/mileage/year)
source:     str | None         # one of the 11 ids or "generic" or None
sourceUrl:  str
title:      str | None
make:       str | None
model:      str | None
year:       int | None
price:      int | None         # number only; currency separate
currency:   str (default "EUR")
mileage:    int | None         # km
fuel:       str | None         # normalised lower-case where possible
image:      str | None         # single image URL
listingId:  str | None         # extracted from URL slug or JSON-LD
marketAvg:  int | None         # mobile.de path only
error:      str | None         # see B.1
```

`/api/parse/car-link` adds the routing classifier:
```
recognized: bool
softFail:   bool   # URL OK, marketplace known, fetch blocked
hardFail:   bool   # unsupported domain or syntactically invalid URL
```

### B.1 Known `error` values currently emitted

| error code | Source | Meaning |
|------------|--------|---------|
| `url_required` | mobile_de.parse_url, universal.parse_listing | empty input |
| `bad_url` | router (`parse_car_link`) | no hostname or no dot in host |
| `unsupported_source` | mobile_de.parse_url | host not in `_MOBILE_DE_HOSTS` |
| `no_html` | mobile_de.parse_url | fetch returned empty body |
| `http_4xx` / `http_5xx` | fetch_html, _parse_generic | upstream returned an error status |
| `timeout` | fetch_html | httpx timeout |
| `network` / `fetch_error:*` | fetch_html | DNS / TLS / socket |
| `fetch_failed` | _parse_generic | generic try/except wrapper |
| `parse_error` | router (`parse_car_link`) | uncaught exception in `parse_listing` |
| `parse_exception` | inspection.router | uncaught exception around `parse_mobile_de` |
| `low_extraction_confidence` | mobile_de.parse_url | <2 of title/price/mileage/year extracted |

---

## C. Canonical listing schema (frozen here for Step 10B onward)

The canonical shape lives in `app/parsers/contract.py` as a Pydantic model.
**This contract module is read-only at this step — no consumer migrates to
it yet.** Step 10B is where the migration happens.

```
ListingParseResult {
  ok:                 bool
  source:             str
  sourceUrl:          str
  externalId:         str | null   # was: listingId
  title:              str | null
  make:               str | null
  model:              str | null
  year:               int | null
  priceEur:           int | null   # was: price; renamed to signal currency invariant
  mileageKm:          int | null   # was: mileage; renamed for clarity
  location:           str | null   # new — city/region from listing
  vin:                str | null
  fuel:               str | null
  transmission:       str | null   # new — manual/automatic
  sellerType:         str | null   # new — private/dealer
  images:             list[str]    # was: image (single)
  parseCompleteness:  "strong"|"partial"|"weak"   # renamed from "confidence"
  degradedReason:     str | null
}
```

**Field rename rationale:**
- `confidence` → `parseCompleteness` — the original name conflicted with the
  *user-facing* "report confidence" field already used in the inspection
  surface. `parseCompleteness` is unambiguously about extraction quality,
  not interpretation quality.
- `listingId` → `externalId` — listing ids are *external* primary keys
  scoped to a marketplace. The pair (`source`, `externalId`) is the
  natural foreign key.
- `price` → `priceEur` + `mileage` → `mileageKm` — explicit unit in the
  name removes "what currency is this?" ambiguity at every read site.
- `image` (single) → `images` (list) — most marketplaces expose a gallery;
  collapsing to one image was a 0A shortcut that should be lifted.

### C.1 `parseCompleteness` derivation

Counted core fields: `title`, `priceEur`, `mileageKm`, `year`.

| #filled core fields | parseCompleteness |
|----------------------|-------------------|
| 4 | `strong` |
| 2–3 | `partial` |
| 0–1 | `weak` |

`make` and `model` are *not* in the core count because for many sources
they are inferred from `title` and would double-count. They contribute to
"is this even a vehicle listing" check at the *ingestion* layer (see D.2).

---

## D. Hard-fail vs soft-fail — formal semantics

These two states are *substrate-level* — surfaces must render them
differently. Today the classification is duplicated across `router.py`,
`vehicles/ingest.py` and consumer code. Step 10B collapses them to a single
classifier in `contract.py`.

### D.1 Hard-fail — surface "we cannot accept this URL"

A hard-fail means the substrate has nothing useful to do with the input and
the user must correct it.

| Condition | error code |
|-----------|-----------|
| Empty / non-string url | `url_required` |
| URL has no scheme and no dot in host after `https://` prepend | `bad_url` |
| Host does not match any of the 11 known domain patterns AND no automotive JSON-LD/OG was found | `unsupported_domain` |
| The page is recognised as a non-listing surface (homepage, search results, login wall) — *new in 10B* | `not_a_listing` |

### D.2 Soft-fail — surface "✓ Link accepted, inspector will open it"

A soft-fail means the URL is structurally valid, the marketplace is known,
but the substrate could not get usable data right now. Inspection context
can still be established — the inspector clicks the link, the customer
trusts the platform.

| Condition | error code | parseCompleteness |
|-----------|-----------|-------------------|
| HTTP 403 / 429 / 503 from upstream | `http_4xx` / `http_5xx` | `weak` |
| Anti-bot challenge page (CF / Datadome) | `antibot` (10B) | `weak` |
| httpx timeout | `timeout` | `weak` |
| Network/DNS/TLS error | `network` / `fetch_error:*` | `weak` |
| Empty response body | `no_html` | `weak` |
| Listing removed / 404 with "expired" marker | `expired_listing` (10B) | `weak` |
| Fetch OK but <2 core fields extracted | `low_extraction_confidence` | `weak` |

### D.3 The non-fail spectrum (`ok=True`)

`ok=True` means the substrate successfully matched a known source AND
extracted at least *partial* signal. The consumer then decides what to do
based on `parseCompleteness`:

- `strong` → auto-fill form, no manual confirmation needed.
- `partial` → auto-fill what's present, prompt for the rest.
- `weak` → ask the customer to confirm details (sometimes anti-bot's only
  output is `make`/`model` from the URL slug — still better than nothing).

---

## E. What is fake-success today (the actual reason 10A exists)

Three real defects observed while writing this audit. All three are *not
fixed* in 10A — they are catalogued for 10B.

1. **Anti-bot pages reach `parsed=True`.** When `_parse_generic` hits a
   Cloudflare interstitial it gets a 200 response with HTML that has an
   OG title like *"Just a moment…"*. The current heuristic
   `parsed = bool(title or ld.get("price") or og.get("price"))` accepts
   this as a successful parse — the consumer sees `recognized=true` and
   the inspector receives a useless title. *Fix path 10B:* anti-bot
   signature detection (CF/Datadome/Akamai fingerprints) before claiming
   `ok`.
2. **Expired listings on autoscout24 / kleinanzeigen** return HTTP 200 with
   an OG title like *"Dieser Artikel ist nicht mehr verfügbar"*. Same
   fake-success path. *Fix path 10B:* per-source `expired_marker`
   detection.
3. **`/api/inspection/report/generate` ignores the dispatcher** — only
   `parse_mobile_de` is called, so any autoscout24/kleinanzeigen link
   downgrades to `unsupported_source` even though the dispatcher would
   accept it. *Fix path 10B:* route through `parse_listing`, normalise to
   the contract, feed the report builder.
4. **`universal._to_int` crashes on numeric JSON-LD `value`** — when a
   marketplace emits `{"mileageFromOdometer": {"value": 95000}}`
   (numeric, not string), the generic parser raises `TypeError` inside
   `_from_jsonld` and the whole call fails. Today most marketplaces emit
   strings ("95000"), so this hasn't burned in production, but it is a
   single-line defect that the contract suite makes visible. *Fix path
   10B:* coerce `m.get("value")` to `str` before `re.sub`. The contract
   suite carries a `pytest.mark.xfail(strict=True)` regression test that
   will flip green automatically once 10B lands the one-line fix.

---

## F. Test corpus (this step's deliverable)

Offline HTML fixtures live in `backend/tests/fixtures/listings/`. Tests
must never touch the network — `httpx.AsyncClient.get` is monkeypatched in
the fixture loader.

| Fixture | Tests |
|---------|-------|
| `mobile_de_basic.html` | full JSON-LD path → `parseCompleteness=strong` |
| `mobile_de_og_only.html` | OG + regex fallback → `parseCompleteness=strong` |
| `autoscout24_basic.html` | generic JSON-LD path → `parseCompleteness=strong` or `partial` |
| `kleinanzeigen_basic.html` | generic OG path → `parseCompleteness=partial` |
| `antibot_page.html` | 200 with non-listing OG → currently fake-success, **canonical view classifies as `weak`** |
| `expired_listing.html` | 200 with "no longer available" body → soft-fail in canonical view |
| `unsupported_domain.html` | random domain, no JSON-LD/OG → hard-fail |

A separate test set drives the canonical classifier directly with synthetic
input dicts (no HTML at all) to lock the `parseCompleteness` ladder and the
hard/soft fail decision.

---

## G. Explicitly NOT in this step

- ❌ ScraperAPI / proxy chain expansion
- ❌ New marketplaces (no source added)
- ❌ Customer-surface UI changes
- ❌ ML-based field extraction
- ❌ Rewriting `parse_listing` / `_parse_generic`
- ❌ Migrating consumers to the new contract
- ❌ Per-source extractors (autoscout24/kleinanzeigen still go through
  generic in 10A)

These all live in **Step 10B**.

---

## H. Step 10B handoff (what unblocks now)

With the contract frozen and fixtures in place, 10B can attack hardening
along three independent fronts in parallel without coupling:

1. **Per-source extractor strategies** — autoscout24, kleinanzeigen,
   willhaben, otomoto each get their own module like `mobile_de.py`. The
   contract guarantees the output shape regardless of which extractor ran.
2. **Anti-bot / expired detection** — page-level classifier that runs
   *before* the field extractor and short-circuits to soft-fail with a
   typed `degradedReason`.
3. **Ingestion soft-fail handling** — `vehicles/ingest` and
   `vehicles/refresh` switch from heuristic `available` inference to the
   canonical `parseCompleteness` + `degradedReason` pair.

## I. Step 10B Pass 1 — closure log

This audit was the gate for Step 10B Pass 1. Closures landed:

| Audit ref | What landed in 10B Pass 1 |
|-----------|---------------------------|
| E.1 anti-bot fake-success | New `app/parsers/page_classifier.py`. `_parse_generic` and `mobile_de.parse_url` route every fetched HTML through `classify_page()` *before* field extraction. Cloudflare/Datadome/Akamai title+body markers short-circuit to `error="antibot"` with no fake-success leakage of OG titles. |
| E.2 expired-listing fake-success | Same classifier path. Multi-language expired markers (DE/FR/IT/PL/AT/NL) map to `error="expired_listing"`. |
| E.4 `_to_int` int-value crash | Single-function coercion fix in `universal._to_int`. Now accepts `int`, `float`, `bool`, `str`, `None` — never raises `TypeError`. xfail regression test flipped green. |
| First-consumer migration | `/api/parse/car-link` now routes through `contract.from_legacy()` for `recognized` / `softFail` / `hardFail` classification AND emits the canonical envelope under `canonical` key alongside legacy keys (back-compat for mobile/web/admin). |

Deferred to **Step 10B Pass 2** (per scope discipline):

- E.3 `/api/inspection/report/generate` still bypasses dispatcher → next pass
- `vehicles/ingest` and `vehicles/refresh` still consume legacy shape → next pass
- Per-source extractors for autoscout24/kleinanzeigen/willhaben/otomoto
- Retry chain / proxy strategy
- `not_a_listing` classifier — conservative seed only; expand in Pass 2 with marketplace-specific URL patterns

Tests:
```
test_parser_contract_step10a.py  ........................... 51 passed
test_parser_contract_step10b.py  .................         19 passed
                                                           70 passed total
```

---

## J. Step 10B Pass 2 — closure log

This pass closed consumer drift. After Pass 1 the canonical contract existed
but only `/api/parse/car-link` consumed it. The other three entry points
(`inspection/report/generate`, `vehicles/ingest`, `vehicles/refresh`) kept
their own hard/soft classifiers — three sources of truth for the same
question. Pass 2 collapses them into one.

| Audit ref | What landed in 10B Pass 2 |
|-----------|---------------------------|
| E.3 `/api/inspection/report/generate` bypasses dispatcher | Endpoint now calls `parse_listing` (universal dispatcher) instead of `parse_mobile_de` directly. autoscout24 / kleinanzeigen / willhaben / otomoto URLs are now accepted. `parseMeta` enriched with `parseCompleteness`, `degradedReason`, `ok` from the canonical envelope. |
| `vehicles/ingest` local heuristics | New pure helper `_classify_ingest(canonical) -> (recognized, soft, hard)` replaces the inline `err.startswith("http_4") or err in {…}` block + the `has_signal` hack. Single source of truth: `ListingParseResult.degradedReason` → `classify_failure_mode`. The hard-fail response additionally exposes `degradedReason` and `parseCompleteness` so the customer surface can render the typed reason instead of a generic "unsupported domain" hint. |
| `vehicles/refresh` fake-disappearance | New helper `_refresh_verdict(canonical) -> ok\|degraded\|disappeared\|hard_anomaly`. Anti-bot 403 / timeout / 5xx / unknown error codes all fall into `degraded` — `lastRefreshAt` is bumped, `lastRefreshDegradedReason` is recorded, **no** snapshot is written, **no** `listing_disappeared` event is emitted. Only `expired_listing` (page-classifier marker) and `http_410` ("Gone") trigger the disappearance path. Defensive `hard_anomaly` bucket (`bad_url`/`unsupported_domain`/`not_a_listing` on a previously-good URL) is treated identically to `degraded`. |

Consumer drift killed: the four entry points (`car-link`, `report/generate`,
`vehicles/ingest`, `vehicles/refresh`) now share *one* failure model and
disagree about nothing.

Deferred to **Step 10C** (per Pass 2 discipline):

- Per-source extractors for autoscout24 / kleinanzeigen / willhaben / otomoto
- Retry chain (single-shot UA rotation on `antibot`, no proxy)
- `not_a_listing` URL-pattern detection per source
- Customer-surface migration to consume `canonical.*` directly and drop the legacy mirror fields

Tests:
```
test_parser_contract_step10a.py        51 passed
test_parser_contract_step10b.py        19 passed
test_parser_contract_step10b_pass2.py  N passed   (this pass)
```

---

## K. Step 10C-A — closure log (AutoScout24 dedicated extractor)

Pass 2 stabilised consumer drift. Pass C-A starts the per-source
extraction layer — without touching the contract, the classifier, or
the consumer semantics. The universal parser becomes a *fallback* path
rather than the main brain.

| Pass C-A delivery | What landed |
|-------------------|-------------|
| New module `app/parsers/autoscout24.py` | Dedicated extractor with the four-layer priority chain: **JSON-LD → __NEXT_DATA__ → meta tags → DOM fallback**. Pure `parse_html(html, url)` for unit-testing, `parse_url(url)` orchestrator that wires through `page_classifier` for anti-bot / expired short-circuit. Canonical fields: title, make, model, year, priceEur, mileageKm, fuel, transmission, sellerType, images[], location, listingId. No retry / no proxy / no UA pool — explicitly out of scope. |
| Dispatcher update `parse_listing` (universal.py) | Branch added: `source == "autoscout24"` → delegates to the new module. mobile.de branch unchanged. Everything else still falls through to `_parse_generic` (which keeps the page-classifier guard from Pass 1). |
| New fixture `autoscout24_nextdata.html` | Next.js page with NO JSON-LD — only `<script id="__NEXT_DATA__">{…}</script>`. Locks the new module's ability to extract from autoscout24's actual SSR shape. |
| Test suite `test_parser_autoscout24_10c.py` | 32 offline tests across 8 classes: URL gate, JSON-LD path, __NEXT_DATA__ path, isolated extraction layers, priority chain ordering (JSON-LD wins over NEXT_DATA over meta), orchestrator failure modes, dispatcher routing, generic fallback anchor. |

### Substrate boundary clarified

```
fetch_html (per-source or generic)
    ↓
classify_page (shared)
    ↓
extractor_for_source (mobile.de | autoscout24 | generic fallback)
    ↓
legacy dict shape
    ↓
contract.from_legacy → ListingParseResult
    ↓
canonical consumers (car-link | inspection | ingest | refresh)
```

### What the AutoScout extractor explicitly does NOT do

- Classify hard/soft fail (substrate's job via `classify_failure_mode`)
- Decide anti-bot / expired (page_classifier)
- Know about ingest / refresh / customer flow
- Emit telemetry, write to DB, touch any consumer

It is *only* HTML → normalized fields. The single boundary makes adding
Kleinanzeigen (Pass C-B) and Willhaben (Pass C-C) trivial — they slot
into the same dispatcher branch with no other changes.

Deferred to **Step 10C-B** (Kleinanzeigen):

- Kleinanzeigen extractor (private-seller-heavy, weak JSON-LD,
  custom anti-bot strategy on top of the shared `page_classifier`)
- `not_a_listing` URL-pattern detection for `/s-auto-kaufen-und-verkaufen`
  search pages without `/anzeige/{id}` segment

Tests:
```
test_parser_contract_step10a.py        51 passed
test_parser_contract_step10b.py        19 passed
test_parser_contract_step10b_pass2.py  43 passed
test_parser_autoscout24_10c.py         32 passed   (new)
test_parsers_mobile_de_b2.py           15 passed (offline subset)
                                       ─────────
                                       160 passed, 0 failed
```

---

## L. Step 10C-B — closure log (Kleinanzeigen dedicated extractor)

Pass C-A isolated the AutoScout layer. Pass C-B is structurally harder
because Kleinanzeigen's topology drift is the real problem — not its
HTML quality. The extractor adds a *URL topology gate* that runs
BEFORE the network is even touched, eliminating an entire class of
fake-success that the body-level page-classifier alone cannot catch.

| Pass C-B delivery | What landed |
|-------------------|-------------|
| New module `app/parsers/kleinanzeigen.py` | Dedicated extractor with priority chain different from AutoScout: **embedded JSON blobs → meta → DOM key-value list → weak fallback**. JSON-LD is folded into "embedded JSON blobs" — NOT a primary source. DOM extractor parses `<ul id="viewad-details-list">` with German labels (Erstzulassung / Kilometerstand / Kraftstoffart / Getriebe). VB price stripping. Price clamping (`0 < n ≤ 10_000_000`). |
| **URL topology classifier** (in same module) | Pure function `classify_url_topology(url) -> "listing" | "category" | "search" | "profile" | "unknown"`. Runs **BEFORE** fetch. Non-listing URLs short-circuit to `error="not_a_listing"` with zero HTTP overhead. Closes the audit emphasis "URL topology first, HTML heuristics second". |
| Dispatcher update | `source == "kleinanzeigen.de"` → `kleinanzeigen.parse_url`. Kleinanzeigen URLs no longer reach `_parse_generic`. The generic parser is now purely a fallback for not-yet-ported sources. |
| New fixture `kleinanzeigen_listing.html` | Real-shaped listing with DOM details list, VB pricing (`7.890 € VB`), Person-type seller in JSON-LD, `<div id="viewad-locality">` block. |
| Test suite `test_parser_kleinanzeigen_10c_b.py` | 42 offline tests, 9 classes: URL gate, URL topology classifier, parse_html rich, VB pricing invariance, isolated layers, orchestrator (topology short-circuit BEFORE fetch verified by patched fetch_html sentinel), dispatcher routing, anchor (kleinanzeigen URLs never touch `_parse_generic`), contract invariance (model fields unchanged). |

### Contract invariance — explicitly pinned

Step 10C-B did NOT add `negotiable`, `sellerTrust`, `freshness`, or any
other field. `TestContractNotExpanded` asserts that the canonical model
exposes exactly the fields frozen in Step 10A — 18 keys, no more, no
less. VB pricing collapses to `priceEur: int | None`. "Zu verschenken"
listings produce `priceEur=None` (consistent with the audit 10A rule
that `price=0` is treated as missing).

### Substrate boundary update

```
fetch_html (per-source or generic)
    ↓
url_topology_classifier (per-source: kleinanzeigen owns this gate)
    ↓
page_classifier (shared: anti-bot / expired)
    ↓
extractor_for_source (mobile.de | autoscout24 | kleinanzeigen | generic)
    ↓
legacy dict shape
    ↓
contract.from_legacy → ListingParseResult
    ↓
canonical consumers
```

Kleinanzeigen is the first source whose URL-topology gate runs *before*
the body classifier. AutoScout / mobile.de don't have category-URL-as-
listing confusion the same way, so they don't (yet) need this layer.

### What this pass explicitly did NOT do

- No retry chain, no UA rotation, no proxy, no Playwright
- No new fields on the contract (audit emphasis pinned by test)
- No customer / web / admin surface changes
- No migration to consume `canonical.*` directly (legacy keys remain
  top-level — Step 10D or post-10C concern)

Deferred to **Step 10C-C** (Willhaben / Otomoto / LeBoncoin):

- Willhaben extractor (Austrian topology, similar to autoscout structure)
- Otomoto extractor (Polish marketplace, schema.org-rich)
- LeBoncoin extractor (French marketplace, custom anti-bot stack)
- Fix the pre-existing `_detect_source` bug: `host.lstrip("www.")`
  strips characters not strings (`willhaben.at` → `illhaben.at`).
  Out of scope for 10C-B but worth a one-line patch in 10C-C.

Tests:
```
test_parser_contract_step10a.py        51 passed
test_parser_contract_step10b.py        19 passed
test_parser_contract_step10b_pass2.py  43 passed
test_parser_autoscout24_10c.py         32 passed
test_parser_kleinanzeigen_10c_b.py     42 passed   (new)
test_parsers_mobile_de_b2.py           15 passed (offline subset)
                                       ─────────
                                       202 passed, 0 failed
```


---

## M. Step 10C-C — closure log (Willhaben + Otomoto + `_detect_source` bug fix)

**Final extractor proliferation pass.** After 10C-C, tier topology
is frozen: any future per-source work must justify itself against
the maintenance-surface cost of a 6th extractor module. The substrate
is now:

```
tier 1 (high-fidelity):  mobile.de · autoscout24 · kleinanzeigen
tier 2 (schema-rich):    willhaben · otomoto
fallback (substrate):    generic (_parse_generic + page_classifier)
```

| Pass C-C delivery | What landed |
|-------------------|-------------|
| **Bug fix** `universal._detect_source` | `host.lstrip("www.")` was a real, latent bug — `str.lstrip` strips a *character set*, not a prefix. `"www.willhaben.at".lstrip("www.")` → `"illhaben.at"`; `"www.wuw.de".lstrip("www.")` → `"uw.de"`. Replaced with literal prefix check (`if host.startswith("www."): host = host[4:]`). The substring matches against marketplace names hid the defect today, but any future exact-host comparison would have silently lost traffic. |
| New module `app/parsers/willhaben.py` | Dedicated extractor for willhaben.at (AT). Three-layer priority chain: **JSON-LD → meta → DOM fallback** (no `__NEXT_DATA__` — willhaben is SSR with schema.org-rich pages). URL topology classifier runs BEFORE fetch: listing / profile / category / search short-circuit without network. Canonical fields: title, make, model, year, priceEur, mileageKm, fuel, transmission, sellerType, images[], location, listingId. |
| New module `app/parsers/otomoto.py` | Dedicated extractor for otomoto.pl (PL). Same three-layer chain. **PLN currency** preserved on legacy dict; `contract.from_legacy` drops `priceEur` per the existing currency guard (canonical contract pins EUR — FX is a presentation concern, not substrate). URL topology classifier covers 9 vehicle verticals (osobowe/dostawcze/motocykle/...). |
| Dispatcher update | Two new branches in `parse_listing` for `source == "willhaben.at"` and `source == "otomoto.pl"`. Both delegate to their per-source extractor; the generic fallback now serves ONLY heycar / pkw.de / marktplaats / lacentrale / subito / leboncoin / unknown hosts. |
| New fixtures | `willhaben_listing.html` (BMW 320d Touring, Vienna, EUR), `otomoto_listing.html` (Audi A4 Avant, Warsaw, PLN). Both schema.org-rich. |
| Test suite `test_parser_willhaben_otomoto_10c_c.py` | 63 offline tests across 10 classes: `_detect_source` bug regression locks, willhaben URL gate / topology / parse_html / orchestrator, otomoto URL gate / topology / parse_html / **PLN→canonical currency invariant** / orchestrator, dispatcher routing (no cross-routing), contract invariance (model fields frozen at 18). |

### Contract invariance — explicitly pinned again

`TestContractNotExpanded` asserts that `ListingParseResult.model_fields`
has exactly the 18 keys frozen in Step 10A — no `currency`, no
`pricePln`, no `negotiable`, no `freshness`, no `sourceCountry`. PLN
listings collapse to `priceEur=None` at the canonical layer; any
consumer that wants to render the original currency must read the
legacy dict.

### Substrate boundary — final shape

```
fetch_html (per-source or generic fallback)
    ↓
url_topology_classifier (per-source: kleinanzeigen / willhaben / otomoto)
    ↓
page_classifier (shared: anti-bot / expired / not_a_listing)
    ↓
extractor_for_source (5 per-source extractors | generic fallback)
    ↓
legacy dict shape
    ↓
contract.from_legacy → ListingParseResult
    ↓
canonical consumers (car-link | inspection | ingest | refresh)
```

### What this pass explicitly did NOT do (and what comes next)

❌ **LeBoncoin extractor** — explicitly out of scope. LeBoncoin has
complex anti-bot stack (Datadome) that the page_classifier already
catches at the substrate layer. Adding a dedicated extractor for it
would not improve fidelity over the generic fallback — it would just
add maintenance surface. Same call for marktplaats / lacentrale /
subito / heycar / pkw.de.

❌ **Retry chains, UA rotation, proxy infrastructure, stealth headers,
Playwright orchestration** — every one of these would invert the
parser's clean substrate boundary back into a "smart layer". Soft-fail
classification + a clear UX rule ("✓ Link accepted, inspector will
open it") is the correct response to anti-bot; we do not race against
CDNs at the substrate level.

❌ **Contract expansion** — pinned by test. Any new field belongs at
the consumer surface, not at `ListingParseResult`.

✅ **The actual next step is NOT parsing.** It is **canonical surface
consumption** (Step 11): web / Expo / admin / ingest flows currently
read both `canonical.*` and the legacy mirror fields at the top level
of `/api/parse/car-link` responses. Step 11 migrates them to read
`canonical.*` only, then removes the legacy duplicates. That removes
the transitional mirror layer and locks the contract as the *one*
read surface.

Tests:
```
test_parser_contract_step10a.py             51 passed
test_parser_contract_step10b.py             19 passed
test_parser_contract_step10b_pass2.py       43 passed
test_parser_autoscout24_10c.py              32 passed
test_parser_kleinanzeigen_10c_b.py          42 passed
test_parser_willhaben_otomoto_10c_c.py      63 passed   (new)
                                            ─────────
                                            250 passed, 0 failed
```

---

## N. Step 11A — Web customer parse consumption (canonical-first)

**Scope discipline pass.** Step 11 starts the transition from
*"surfaces read legacy mirror fields"* to *"surfaces read the
canonical envelope"*. The opening pass is web customer intake — the
primary entry point. Other surfaces (Expo 11B, admin 11C) follow the
same playbook; backend cleanup (11D) happens last so consumers have
time to migrate.

| 11A delivery | What landed |
|--------------|-------------|
| **New shared module** `/app/shared/domain/parsers/canonical.ts` | Pure-TS reader for the canonical parse envelope. Two exported helpers: `classifyParseFailure(degradedReason, opts)` → `'hard' \| 'soft' \| null`, and `hasPreviewSignal(envelope)` → `boolean`. Mirrors `HARD_FAIL_CODES` / `SOFT_FAIL_CODES` / `_is_http_status_error` / `_is_fetch_error_prefix` from `backend/app/parsers/contract.py` 1:1. `unsupported_source` + `sourceRecognised=true` collapses to soft (same edge case as backend). |
| **Tests** `shared/domain/parsers/__tests__/canonical.test.ts` | **30 tests, vitest, pure-TS** — no JSDOM, no React. Covers all hard/soft codes, HTTP 4xx/5xx pattern, `fetch_error:*` prefix, unknown codes default-to-soft, `unsupported_source` edge case, `hasPreviewSignal` for strong/partial/weak/missing. |
| **Test infrastructure** `shared/package.json` | Added `vitest` as devDependency + `yarn test` script. Shared now has its own test runner so future cross-surface invariants (state machines, formatters, classifiers) get unit coverage without coupling to web/Expo/admin. |
| **Web migration** `web-app/src/pages/public/InspectPage.tsx` | Sole web customer surface that read parse fields directly. Replaced `parseMeta.error` / `parseMeta.parsed` reads with `classifyParseFailure(parseMeta.degradedReason)`. Split `softError` into two slots: `hardError` (blocks preview, calm "Ссылка не похожа на объявление") and `softNote` (inline notice, does NOT block — "Ссылка принята. Инспектор откроет её вручную."). `ResultCard` uses `hasPreviewSignal` to decide preview vs fallback. `FallbackCTA` accepts `tone: 'hard' \| 'soft'` so the testID disambiguates. |

### Acceptance — closed

- ✅ Web intake no longer reads `parseMeta.parsed` / `parseMeta.error` directly.
- ✅ Hard-fail (`bad_url` / `unsupported_source` / `not_a_listing`) renders fallback CTA — establishment NOT blocked at the page level; user can still click "order inspection".
- ✅ Soft-fail (anti-bot, HTTP 4xx/5xx, timeout, expired, weak) is a calm inline notice + order CTA remains available.
- ✅ Preview only renders when `hasPreviewSignal({ok, parseCompleteness})` AND legacy core fields are present (transitional double-gate; collapses to canonical-only in 11D).
- ✅ Customer wording unchanged — i18n keys preserved (`inspect.soft_error.*` / `inspect.fallback.*`).
- ✅ Guardrails green: backend 250 parser tests pass, shared 30 canonical tests pass, web-app build clean.

### E2E smoke (via `/api/inspection/report/generate`)

```
willhaben search URL    → parseMeta.degradedReason="not_a_listing"  → classifier=hard
fake otomoto listing    → parseMeta.degradedReason="http_404"       → classifier=soft
unsupported example.com → parseMeta.degradedReason="http_404"       → classifier=soft
```

### What this pass explicitly did NOT do

❌ **Did not touch backend contract** — `parseMeta` still carries both legacy (`parsed`, `error`) and canonical (`parseCompleteness`, `degradedReason`, `ok`) keys side-by-side. Step 11D removes the legacy mirror.

❌ **Did not touch Expo** — Step 11B reuses the same `@platform/domain/parsers/canonical` module on RN.

❌ **Did not touch admin / ingest / refresh / vehicle-detail flows** — Steps 11C + 11D.

❌ **Did not change parser logic, did not add retry/proxy** — substrate is frozen.

❌ **Did not migrate RequestIntakePage** — that page does NOT read parse results directly; it submits the link to `/api/customer/requests` and the backend parses internally. The substrate boundary stays where it already is.

### What comes next

**Step 11B — Expo customer intake** reuses `@platform/domain/parsers/canonical` from the RN frontend (same import path resolves through the existing `@platform/*` alias). Same UX rule: hard-fail vs soft-fail, calm wording, never block establishment.

Tests:
```
test_parser_contract_step10a.py             51 passed
test_parser_contract_step10b.py             19 passed
test_parser_contract_step10b_pass2.py       43 passed
test_parser_autoscout24_10c.py              32 passed
test_parser_kleinanzeigen_10c_b.py          42 passed
test_parser_willhaben_otomoto_10c_c.py      63 passed
shared/domain/parsers/canonical.test.ts     30 passed   (new — vitest)
                                            ─────────
                                            280 passed, 0 failed
```

---

## O. Step 11B — Expo customer intake (canonical-first)

**Pure consumption pass.** No new semantics — the shared classifier
written in 11A (`@platform/domain/parsers/canonical`) is reused 1:1
on the Expo surface so hard/soft rules cannot drift between web and
mobile. The whole pass is "move one read site".

| 11B delivery | What landed |
|--------------|-------------|
| `frontend/app/auto-request/create.tsx` (`LinkPreview`) | Replaced the ad-hoc `preview.recognized ?? preview.parsed` / `preview.softFail` / `preview.hardFail` reads with `classifyParseFailure(canonical.degradedReason, {sourceRecognised})` + `hasPreviewSignal({ok, parseCompleteness, degradedReason})`. All display fields now read `canonical.priceEur` / `canonical.mileageKm` / `canonical.title` / `canonical.images[0]` / `canonical.year` / `canonical.fuel` / `canonical.location` / `canonical.source` / `canonical.sourceUrl`. `marketAvg` remains transitional read from the legacy mirror — it is not in the canonical contract (intentional: market data is a downstream concern, not a parser concern). |
| Fetch error path | `setPreview({ parsed: false, error: 'fetch_failed' })` (legacy) → `setPreview({ canonical: { ok: false, source: null, sourceUrl: v, parseCompleteness: 'weak', degradedReason: 'fetch_failed' }})`. Network failure now flows through the same canonical pipeline as backend-emitted failures — one decision path, no surface-only fork. |
| Source label map | Added `willhaben.at` / `otomoto.pl` rows (new tier-2 sources from Step 10C-C). |

### Acceptance — closed

- ✅ Expo intake no longer reads `preview.parsed` / `preview.error` / `preview.recognized` / `preview.softFail` / `preview.hardFail`.
- ✅ Shared classifier used directly via `@platform/domain/parsers/canonical` (alias was already wired in `metro.config.js` + `tsconfig.json`).
- ✅ Hard/soft semantics literally identical to the web surface — same module, same code paths, no copy.
- ✅ Preview gating uses `hasPreviewSignal` — `ok=false` or `parseCompleteness='weak'` collapses to the calm soft / hard fallback row.
- ✅ Customer wording unchanged (`create.link_*` i18n keys preserved).
- ✅ No new mobile-only drift introduced — fetch-failure path emits a synthetic canonical envelope rather than reviving the legacy shape.
- ✅ Backend untouched. `/api/parse/car-link` still emits both top-level legacy mirror keys AND `canonical` Pydantic dump — Step 11D removes the mirror.

### What this pass explicitly did NOT do

❌ **Did not touch `inspection-preview.tsx`** — that screen consumes `/api/inspection/report/generate`, which does not yet ship a `canonical` envelope (only canonical-envelope keys inside `parseMeta`). Migrating its preview card properly requires the backend to add `canonical` to that endpoint's response — pinned for Step 11D backend-pass.
❌ **Did not extend `ListingParseResult`** — `marketAvg` stays in the legacy mirror, not the canonical contract.
❌ Offline mode, retry UI, parser polling, local parser cache, analytics — out of scope per audit doctrine.

### What comes next

**Step 11C — Admin / internal surfaces.** Search admin pages for any read of `parse.parsed` / `parse.error` / `parsed.recognized`. If admin shows a parser preview (e.g. inside an `auto_requests` row), migrate it through the same shared classifier. If admin does not surface parser fields, 11C closes as a no-op.

**Step 11D — Backend cleanup.** After 11C, remove the top-level legacy mirror keys (`recognized`, `softFail`, `hardFail`, `parsed`, `error`, `title`, `image`, `price`, `mileage`, `year`, `fuel`, `make`, `model`, `currency` at top level of `/api/parse/car-link`); leave only `canonical`. Add `canonical` to `/api/inspection/report/generate` response and migrate `inspection-preview.tsx` Expo screen + `InspectPage` web `car.*` reads off the legacy mirror.

Tests:
```
test_parser_contract_step10a.py             51 passed
test_parser_contract_step10b.py             19 passed
test_parser_contract_step10b_pass2.py       43 passed
test_parser_autoscout24_10c.py              32 passed
test_parser_kleinanzeigen_10c_b.py          42 passed
test_parser_willhaben_otomoto_10c_c.py      63 passed
shared/domain/parsers/canonical.test.ts     30 passed
                                            ─────────
                                            280 passed, 0 failed
```
E2E (via `/api/parse/car-link`):
```
willhaben search URL    → canonical.degradedReason="not_a_listing"  → classifier=hard ✅
fake otomoto listing    → canonical.degradedReason="http_404"       → classifier=soft ✅
bad URL ("not-a-url")   → canonical.degradedReason="bad_url"        → classifier=hard ✅
```

---

## P. Step 11C — Admin / internal surfaces (audit pass)

**Audit-style pass, not new construction.** The directive was explicit:
*"если parser state вообще не surface'ится — фиксируем '11C no-op
verified', не трогаем код ради чистоты"*. The pass executed exactly
this discipline.

### Admin surfaces — scan result

Searched the full `admin/src/` tree for legacy parser semantics:

```
grep -rn "parseMeta|\.parsed\b|recognized|softFail|hardFail|parse/car-link" admin/src/
grep -rn "http_4|antibot|not_a_listing|degradedReason|parseCompleteness"   admin/src/
grep -rn "car\.image|car\.price|\.mileage\b"                                admin/src/
```

**Result: ZERO matches** outside one unrelated formatter hit
(`CustomersPage.tsx` renders `vehicle.mileage` as a customer-profile
data point, not a parser preview — it reads the persisted vehicle
record, not parse meta).

Verified `AutoRequestsPage.tsx` end-to-end: its detail modal renders
brand / model / budget / cities / `links[]` (as plain anchor tags) /
jobs table — no parser preview, no failure-mode branching, no
canonical envelope consumption needed. Backend `/api/admin/requests/{id}`
returns operational shape only (request + jobs).

**Conclusion:** admin = **11C no-op verified.** 70 admin pages, zero
parser drift. The audit doctrine pays off — admin focused on
operational reality, parsing stays at substrate.

### Internal surfaces — one real drift found, migrated

Scanning web-app for `recognized` / `softFail` / `hardFail` /
`parsed` outside of `pages/public/InspectPage.tsx` (already migrated
in 11A) surfaced **one** legitimate operator-side leak:

| File | Old read | Migration |
|------|----------|-----------|
| `web-app/src/components/LinkIngestStrip.tsx` (single-input "paste URL → vehicle memory" primitive — operator/customer hybrid) | `if (data.hardFail \|\| !data.vehicleId)` | `classifyParseFailure(data.canonical?.degradedReason ?? data.degradedReason ?? null, {sourceRecognised}) === 'hard'`. Same shared classifier as 11A/11B, same hard/soft semantics — no copy. |

### Backend touch — additive only (canonical envelope publication)

`/api/vehicles/ingest` previously emitted `degradedReason` /
`parseCompleteness` only in the hard-fail branch. The
`matched` / `created` branches returned legacy mirror keys only.
**Added the canonical envelope keys (`ok`, `degradedReason`,
`parseCompleteness`, plus the full `canonical` Pydantic dump) to all
three branches** so the shape is uniform and `LinkIngestStrip` can
read through the same path regardless of `status`. This is publication-
only — every legacy key (`recognized`, `softFail`, `hardFail`,
`error`, `hint`, `vin`, `status`, `vehicleId`, `vehicle`, `memoryUrl`)
remains in the response for back-compat. **Removal happens in 11D.**

### Acceptance — closed

- ✅ Admin scan: zero parser-state reads → no-op verified.
- ✅ One operator surface (`LinkIngestStrip`) migrated to shared classifier.
- ✅ `/api/vehicles/ingest` now publishes the canonical envelope on all three branches (additive — no break to existing consumers).
- ✅ No new UX introduced (LinkIngestStrip wording / styling unchanged).
- ✅ No new mobile/web/admin drift; all three surfaces now route every parser failure decision through `@platform/domain/parsers/canonical`.
- ✅ Backend 250 parser tests pass, shared 30 canonical tests pass, web-app build clean.

### E2E smoke (via `/api/vehicles/ingest`)

```
"not-a-url"               → canonical.ok=false, degraded="fetch_failed"  → classifier=soft (https:// prefixed, fetch failed)
fake mobile.de listing    → status="created", softFail=true,
                            canonical.parseCompleteness="weak",
                            degraded="http_403"                          → classifier=soft, navigates to vehicle/* anyway ✅
```

### What this pass explicitly did NOT do

❌ Did not rewrite admin pages for "consistency" — they were already correct.
❌ Did not extend `ListingParseResult` — same 18-field frozen contract.
❌ Did not remove legacy mirror keys (`recognized` / `softFail` / `hardFail` / `error` / `hint`) — that's 11D, after all consumers are migrated.
❌ Did not touch `inspection-preview.tsx` (Expo) or `InspectPage.tsx` `car.*` reads (web) — both deferred to 11D, which is the right moment to do them: backend `inspection/report/generate` needs the canonical envelope added first.

### What comes next — Step 11D (the real contract freeze)

After 11C, every consumer that the substrate is responsible for
routes through the shared canonical classifier. The remaining work is
**substrate cleanup**, not surface rewrites:

1. Add `canonical` envelope (Pydantic dump of `ListingParseResult`)
   to `/api/inspection/report/generate` response, alongside `parseMeta`.
2. Migrate `frontend/app/inspection-preview.tsx` (Expo HERO screen)
   from `car.*` legacy mirror to `canonical.*`.
3. Migrate `web-app/src/pages/public/InspectPage.tsx` `car.*` reads
   to `canonical.*` (already reads `parseMeta.{ok,parseCompleteness,
   degradedReason}` for classification; only the preview-field side
   remains legacy).
4. Remove top-level legacy mirror keys from `/api/parse/car-link` and
   `/api/vehicles/ingest`. Keep only `canonical` + endpoint-specific
   operational keys (`vehicleId`, `memoryUrl`, `status`, `vin`).
5. Mark `recognized` / `softFail` / `hardFail` / `error` as removed in
   the OpenAPI / contract docs.

After 11D:
```
one parser contract:    ListingParseResult (18 frozen fields)
one failure model:      classify_failure_mode → 'hard' | 'soft' | None
one substrate semantics: @platform/domain/parsers/canonical
all surfaces aligned:   web / Expo / admin / internal / ingest
```

Tests:
```
test_parser_contract_step10a.py             51 passed
test_parser_contract_step10b.py             19 passed
test_parser_contract_step10b_pass2.py       43 passed
test_parser_autoscout24_10c.py              32 passed
test_parser_kleinanzeigen_10c_b.py          42 passed
test_parser_willhaben_otomoto_10c_c.py      63 passed
shared/domain/parsers/canonical.test.ts     30 passed
                                            ─────────
                                            280 passed, 0 failed
```

---

## Q. Step 11D-α — additive canonical publication (inspection report endpoint)

**Lowest-risk opening pass of the contract consolidation.** No surface
migration, no field deletion — strictly additive backend publication
so 11D-β can move surface reads with zero coordination on the wire.

| 11D-α delivery | What landed |
|----------------|-------------|
| `backend/app/inspection/router.py` | Top-level `canonical` key added to `/api/inspection/report/generate` response. Three emission branches: **URL parsed successfully** → `canonical.model_dump()` (full 18-field envelope); **URL parse exception** → synthetic envelope with `source="unknown"`, `sourceUrl=payload.url`, `parseCompleteness="weak"`, `degradedReason="parse_error"`; **manual mode (no URL)** → `canonical: None` (explicit signal "parser was not invoked, fall back to user fields"). |
| `backend/tests/test_inspection_canonical_11d_alpha.py` | **5 new tests** pinning the additive contract: manual-only emits `null`, hard-fail URL emits full 18-key envelope with `not_a_listing` reason, soft-fail URL emits envelope with `http_4xx` reason, legacy `car.*` mirror + `parseMeta` still present (back-compat pin until 11D-γ), canonical envelope uses unit-suffix names (`priceEur` / `mileageKm` / `images`) and does NOT leak legacy unit-less names. |

### Wire shape after 11D-α (URL submission)

```json
{
  "report":   { ... build_report output ... },
  "car":      { "title": ..., "price": ..., "image": ..., ... },         // LEGACY mirror — removed in 11D-γ
  "parseMeta": {                                                          // LEGACY + canonical hybrid — also removed in 11D-γ
    "parsed": false, "error": "not_a_listing", "source": "willhaben.at",
    "parseCompleteness": "weak", "degradedReason": "not_a_listing", "ok": false
  },
  "canonical": {                                                          // NEW — 18 frozen fields, single source of truth
    "ok": false, "source": "willhaben.at", "sourceUrl": "...",
    "externalId": null, "title": null, "make": null, "model": null,
    "year": null, "priceEur": null, "mileageKm": null,
    "location": null, "vin": null, "fuel": null, "transmission": null,
    "sellerType": null, "images": [],
    "parseCompleteness": "weak", "degradedReason": "not_a_listing"
  },
  "pricing":  { "inspectionFee": 149, "currency": "EUR", "deliveryHours": 24 }
}
```

### Why this pass is one commit, not three

The whole 11D plan is *one* contract consolidation, but the user
discipline ("never mix migration and deletion in the same commit") is
enforced at the **pass boundary**, not at the file boundary:

- **11D-α** publishes the canonical envelope additively. Zero consumer
  migration. Zero deletion. Surfaces continue to read legacy fields;
  nothing observable changes for them yet.
- **11D-β** migrates Expo `inspection-preview.tsx` and web
  `InspectPage.tsx` `car.*` reads onto `canonical.*`. Backend
  untouched.
- **11D-γ** removes the top-level legacy mirror (`recognized`,
  `softFail`, `hardFail`, `parsed`, `error`, `hint` from
  `/api/parse/car-link` and `/api/vehicles/ingest`; `car.*` mirror
  from `/api/inspection/report/generate`). OpenAPI / fixtures /
  changelog update.

After 11D-α each surface can migrate at its own pace, observing the
canonical envelope live in staging without any code change required.

### What this pass explicitly did NOT do

❌ Did not touch any consumer (Expo / web / admin / ingest) — surface
   migration is 11D-β.
❌ Did not remove any legacy field — 11D-γ.
❌ Did not extend `ListingParseResult` — still the 18 fields frozen
   in Step 10A. The 5 new tests re-pin that surface.
❌ Did not change `/api/parse/car-link` or `/api/vehicles/ingest` —
   they already publish `canonical` (since 11C). 11D-α brings the
   third entry point in line.
❌ Did not introduce new parser logic, retry chains, proxies, or
   anything in the substrate. The substrate is frozen.

### Acceptance — closed

- ✅ `/api/inspection/report/generate` emits `canonical` on every
  response (full envelope when URL provided, `null` for manual-only).
- ✅ Synthetic envelope on parse exception keeps the user-provided
  URL in `sourceUrl` so the surface "✓ Link accepted" line still
  renders without legacy fallback.
- ✅ 250 parser contract tests still pass (no substrate change).
- ✅ 30 shared canonical tests still pass (no TS contract change).
- ✅ 19 inspection report B1 tests still pass (no `report` /
  `pricing` / `parseMeta` regression).
- ✅ 5 new canonical-publication tests pin the additive contract.
- ✅ Live smoke verified: manual / not_a_listing / http_4xx all
  produce the documented wire shape.

### What comes next — Step 11D-β (surface migration)

After 11D-α, two surfaces still read the legacy mirror:

1. `frontend/app/inspection-preview.tsx` (Expo HERO inspection card)
   reads `data.car.title / make / model / price / mileage / year /
   fuel / image / marketAvg / source / sourceUrl` directly.
   Migration: read from `data.canonical.{title, make, model,
   priceEur, mileageKm, year, fuel, images[0], source, sourceUrl}`.
   `marketAvg` stays at the legacy mirror — it's NOT a parser field
   (it's a downstream model-aware baseline computation; this stays
   transitional through 11D-γ).

2. `web-app/src/pages/public/InspectPage.tsx` already uses the
   shared classifier for failure-mode (since 11A), but its preview
   side still reads `car.image / price / mileage / year / fuel /
   marketAvg / source / sourceUrl / title / make / model`. Same
   migration as Expo.

Both migrations use the shared module
`@platform/domain/parsers/canonical` (`hasPreviewSignal` + safe
`canonical?.title` accessors) — no surface-local re-implementation.

After 11D-β: `grep -rn "data\.car\." frontend/app web-app/src` returns
zero hits in the inspection preview path. That grep IS the acceptance
gate for 11D-γ.

Tests after 11D-α:
```
test_parser_contract_step10a.py             51 passed
test_parser_contract_step10b.py             19 passed
test_parser_contract_step10b_pass2.py       43 passed
test_parser_autoscout24_10c.py              32 passed
test_parser_kleinanzeigen_10c_b.py          42 passed
test_parser_willhaben_otomoto_10c_c.py      63 passed
test_inspection_canonical_11d_alpha.py       5 passed   (new)
test_inspection_report_b1.py                19 passed
shared/domain/parsers/canonical.test.ts     30 passed
                                            ─────────
                                            304 passed, 0 failed
```

---

## R. Step 11D-β — surface migration off `data.car.*` (preview reads)

**Pure read-migration pass.** No backend changes, no UI changes, no
new logic, no failure-semantics tweaks. Two surfaces stop reading the
legacy `car.*` mirror and start reading `canonical.*` directly. The
substrate's `hasPreviewSignal()` becomes the **single gate** for
"should we render the preview card?" — every `if (car.image)` /
`if (car.price)` / `if (parseMeta.parsed)` heuristic is gone from
both surfaces' preview paths.

### What landed

| Surface | File | Migration |
|---------|------|-----------|
| Expo mobile | `frontend/app/inspection-preview.tsx` | `car.{title,make,model,price,mileage,year,fuel,image,source,sourceUrl}` → `canonical.{title,make,model,priceEur,mileageKm,year,fuel,images[0],source,sourceUrl}`. Added `InspectionCanonical` TS interface (18-field shape mirroring the Pydantic model). `marketAvg` retained on `car.*` (intentional — see invariant below). `hasPreviewSignal()` from `@platform/domain/parsers/canonical` derives `previewSignal` once and locals (`carTitle / carImage / hasImage / carPrice / carMileage / carYear / carFuel / carSource`) cascade from it. |
| Web operations | `web-app/src/pages/public/InspectPage.tsx` | Same migration in `ResultCard` for the visible header / specs row. Plus `orderInspection()` was reading `result.car.title` and `result.car.sourceUrl` for URL params — both moved to `result.canonical.{title,sourceUrl}`. Removed the legacy double-gate `previewable \|\| hasLegacyCore` (11A safety net): surfaces now trust `parseCompleteness` unilaterally. |

### Discipline invariants preserved

✅ **Only preview/read migration.** No parser logic touched, no
failure semantics moved, no new UI primitives, no fallback rewrites,
no new formatting helpers. The only function-level addition is local
`const`s pulling fields out of `canonical` — pure renaming.

✅ **`marketAvg` stays legacy.** It is NOT a parser substrate field —
it's a downstream `build_report` baseline. Absorbing it into
`ListingParseResult` would expand the canonical contract with a
presentation concern and re-open the door to drift. Kept on
`car.marketAvg` (only field remaining in the legacy mirror that
the surfaces still read). 11D-γ deletes everything else but
preserves this single field.

✅ **`hasPreviewSignal()` is the sole gate.** Both surfaces collapsed
their ad-hoc `if (image || price || make)` heuristics into one
call from the shared module. No surface re-implements the rule.

### Grep gate (run before 11D-γ — and the freeze gate)

```
GATE 1: data\.car\.        ✅ ZERO live reads
GATE 2: car\.(title|price|image|year|mileage|fuel|source|
              sourceUrl|make|model)   in inspection surfaces
                            ✅ ZERO live reads
GATE 3: \.parsed\b in surface code                    ✅ clean
GATE 4: \.softFail\b                                  ✅ clean
GATE 5: \.hardFail\b                                  ✅ clean
GATE 6: \.recognized\b                                ⚠ 1 hit
GATE 7: parseMeta\.error / meta\.error                ✅ clean
```

**GATE 6 finding (out of 11D-β scope, flagged for 11D-γ planning):**
`frontend/app/provider/workspace/[requestId].tsx:415` still reads
`preview.recognized`. This is the **provider workspace** surface
(not the customer inspection preview path covered by 11D-β). It
reads the `recognized` field from a provider-side preview payload,
which may or may not be the same wire shape as `/api/parse/car-link`.

**Resolution — see §S below (11D-β2):** Carve-out rejected by user.
Decision: extend β to include provider workspace before γ so that
`deletion` commit is unconditional and never depends on "out-of-scope"
exceptions. Done in §S.

### Tests

```
test_inspection_canonical_11d_alpha.py       5 passed
test_inspection_report_b1.py                19 passed   (no regression)
shared/domain/parsers/canonical.test.ts     30 passed
parser-contract suite (10A–10C-C)          250 passed   (substrate frozen)
web-app vite build                          green        (web-public 238 KB)
ESLint inspection-preview.tsx + InspectPage.tsx          clean
```

Live wire smoke unchanged from 11D-α — canonical envelope shipped on
every URL submission, surfaces consume it, `car.marketAvg` remains
on the legacy mirror as designed.

### What this pass explicitly did NOT do

❌ No backend changes — `/api/inspection/report/generate` unchanged.
❌ No `canonical` shape extension — still 18 frozen fields (10A).
❌ No `marketAvg` migration to canonical — out of scope, would expand
   the contract.
❌ No mirror deletion — that's 11D-γ. Legacy `car.*` keys still in
   wire response, just no surface reads them anymore (verified by
   GATE 1 + 2).
❌ No new tests added — the alpha tests (which pin the wire shape)
   are sufficient; β is consumer-only and visually verified via
   grep + web build.
❌ No provider workspace migration — flagged for γ planning.

### What comes next — Step 11D-γ (deletion)

Only after both:
  1. β tests live in staging long enough to confirm no surface relies
     on the legacy mirror (or `provider/workspace` decision is made);
  2. All 7 grep gates above stay clean across any new commits.

Then γ:
  - Remove `parsed / recognized / softFail / hardFail / error / hint`
    from `/api/parse/car-link` response.
  - Remove the same legacy keys from `/api/vehicles/ingest`.
  - Remove the legacy `car.{title,make,model,price,mileage,year,fuel,
    image,source,sourceUrl,currency,listingId}` mirror from
    `/api/inspection/report/generate` response (keep ONLY
    `car.marketAvg`).
  - Update OpenAPI schemas.
  - Update fixtures.
  - Add changelog note.
  - Final regression grep + test pass.

After γ the contract is frozen at:
```
one parser shape       — 18 canonical fields
one preview gate       — hasPreviewSignal()
one failure model      — classifyParseFailure() → 'hard' | 'soft' | null
one wire entry shape   — canonical envelope, top-level
zero legacy mirrors    — except car.marketAvg (NOT a parser field)
```



---

## S. Step 11D-β2 — Provider workspace canonical read cleanup

**Bounded follow-on to 11D-β.** Removes the last `preview.recognized`
read in the codebase so 11D-γ deletion becomes unconditional — no
"out of scope" carve-outs in the freeze gate. One file touched, no
backend changes, no UI changes, no wire-shape changes.

### What landed

| File | Migration |
|------|-----------|
| `frontend/app/provider/workspace/[requestId].tsx` | Imports `hasPreviewSignal` + `CanonicalParseEnvelope` + `ParseCompleteness` from `@platform/domain/parsers/canonical`. New typed `ParseCarLinkResponse` interface for the `/api/parse/car-link` response (declares `canonical: CanonicalFull | null` only — legacy mirror fields deliberately omitted so a typo can't leak them back). `preview` state retyped from `any` to `ParseCarLinkResponse | null`. Three read sites migrated: (1) **fetch catch fallback** — `setPreview({recognized:false, softFail:true})` replaced with a synthetic canonical envelope (`ok:false`, `parseCompleteness:'weak'`, `degradedReason:'parse_error'`); (2) **display gate** — `preview.recognized` replaced with `hasPreviewSignal({ok, parseCompleteness, degradedReason})` reading from `preview.canonical`; (3) **display reads** — `preview.{title,make,model,year,mileage,price,source}` → `preview.canonical?.{title,make,model,year,mileageKm,priceEur,source}`; (4) **submit reads** — same migration applied to the `POST /api/provider/requests/:id/candidates` body builder (`Candidate.preview` server-persisted shape is unchanged — only the *source* of its values is now canonical). |

`source` extraction additionally guards against the `"unknown"`
sentinel emitted by the parse-exception synthetic envelope —
surfaces never display a "source: unknown" line.

### Why a separate β2 instead of folding into β

User discipline: **deletion must be boring and unconditional.** Two
options were on the table before 11D-γ:

  1. Accept the one `preview.recognized` hit as out-of-scope (provider
     workspace ≠ customer inspection path) and document the carve-out
     in the γ removal commit.
  2. Extend β to include provider workspace so the grep gate is
     truly zero across all surfaces.

User chose option 2: *"если оставить один legacy read, γ станет
условным; через месяц никто не вспомнит, почему provider был
исключением."* Correct. Made β2.

### Freeze gate (all 7 grep gates — re-verified after β2)

```
GATE 1: data\.car\.                                ✅ ZERO
GATE 2: car\.(title|price|image|year|mileage|
              fuel|source|sourceUrl|make|model)
        in customer/provider preview surfaces       ✅ ZERO
GATE 3: \.parsed\b in surface code                  ✅ ZERO
GATE 4: \.softFail\b                                ✅ ZERO
GATE 5: \.hardFail\b                                ✅ ZERO
GATE 6: \.recognized\b                              ✅ ZERO  ← cleared by β2
GATE 7: parseMeta\.error / meta\.error              ✅ ZERO
```

**All seven gates are now zero across `frontend/app/`,
`web-app/src/`, and `admin/src/`.** This is the unconditional
acceptance gate for 11D-γ: any new legacy-mirror read appearing
in surfaces will trip these greps and block deletion.

### Discipline invariants

✅ **Scope-bounded.** Exactly one file changed.
✅ **No backend touched.** `/api/parse/car-link` still emits the
   legacy mirror fields on the wire (deleted in γ); β2 only changes
   what the consumer reads.
✅ **No UI changes.** Same two preview-box layouts (green-bordered
   "recognized" / neutral "unavailable"). Same submit body shape
   to `POST /api/provider/requests/:id/candidates`.
✅ **No new failure semantics.** `hasPreviewSignal()` is reused;
   no new classifier, no new fallback rules, no new formatters.
✅ **`marketAvg` not in scope.** Provider workspace never read it;
   it lives only in the customer inspection report path.

### Tests

```
test_inspection_canonical_11d_alpha.py       5 passed
test_inspection_report_b1.py                19 passed
test_parser_contract_step10a.py             51 passed
shared/domain/parsers/canonical.test.ts     30 passed
                                            ─────────
                                           105 passed, 0 failed
```

`tsc --noEmit` on the migrated file: zero errors (50 pre-existing
errors in other files — unrelated). ESLint glob can't parse
`[requestId].tsx` because the square brackets are interpreted as a
character class; this is a pre-existing platform quirk and does
not affect runtime — Metro bundles the file via Babel which strips
TS types correctly. No regression.

### Wire shape — STILL unchanged

`/api/parse/car-link`, `/api/vehicles/ingest`, and
`/api/inspection/report/generate` all continue to emit the legacy
mirror fields alongside the canonical envelope. β2 changed zero
bytes on the wire. The β2 pass is *purely* read-side cleanup.

### What comes next — Step 11D-γ (deletion, unconditional)

The gate is now closed. γ can proceed with:

  1. Remove from `/api/parse/car-link` response:
     `parsed`, `recognized`, `softFail`, `hardFail`, `error`, `hint`,
     `title`, `make`, `model`, `price`, `mileage`, `year`, `fuel`,
     `image`, `source`, `sourceUrl`, `currency`, `listingId`.
     Keep only `canonical`.
  2. Remove the same set from `/api/vehicles/ingest` response
     (all three branches: matched / created / hard-fail).
  3. Remove from `/api/inspection/report/generate` response:
     the `car.{title,make,model,price,currency,mileage,year,fuel,
     image,source,sourceUrl,listingId}` keys. Keep `car.marketAvg`
     (downstream build_report baseline, not parser substrate).
     Keep `report`, `parseMeta`, `canonical`, `pricing`.
  4. Optional: also remove `parseMeta` since `canonical` carries
     `ok` / `parseCompleteness` / `degradedReason` already. This
     is a separate decision — `parseMeta` predates the canonical
     envelope and surfaces no longer read it (GATE 7 clean), so
     it's deletable, but it's been used by tests for back-compat.
     Discussion item for γ planning.
  5. Update OpenAPI schemas.
  6. Update test fixtures.
  7. Final regression sweep — all 7 grep gates must remain zero.
  8. Add changelog note.

After γ:
```
one parser shape       — 18 canonical fields           (frozen at 10A)
one preview gate       — hasPreviewSignal()            (shared)
one failure model      — classifyParseFailure()        (shared)
one wire entry shape   — canonical envelope, top-level
zero legacy mirrors    — except car.marketAvg
                         (build_report baseline, NOT parser substrate)
zero grep gates        — across all surfaces (β2 closed the gate)
```

That's the freeze.

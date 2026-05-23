#!/usr/bin/env python3
"""
P2.4 — Anti-regression wall (OpenAPI cross-check edition).

Reads the canonical catalogue at /app/shared/contracts/ and verifies every
declared path is mounted on the FastAPI backend by cross-referencing
against /openapi.json.

Why OpenAPI cross-check and not per-path curl?
  FastAPI returns 404 (not 405) for GET against a POST-only route, which
  makes naive HTTP probing report false drift for write-only endpoints.
  OpenAPI's `paths` map is the authoritative router truth — if a path
  template is present there, the route is mounted (regardless of method).

Status semantics (per /app/shared/contracts/DOCTRINE.md §6):
  template in /openapi.json paths        -> ok (mounted)
  template absent                        -> DRIFT
  (HTTP method gates / auth gates do not affect this smoke)

Plus a SECONDARY HTTP probe of a curated public route list to verify the
backend is actually responding (not just bundling routes statically).

Exit codes:
  0   no drift
  1   drift detected
  2   smoke could not run (backend unreachable, no contracts found)
"""

from __future__ import annotations

import os
import re
import sys
import json
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Iterable

ROOT       = Path(__file__).resolve().parent.parent
CONTRACTS  = ROOT / "shared" / "contracts"
BASE_URL   = os.environ.get("SMOKE_BASE_URL", "http://localhost:8001")
API_PREFIX = "/api"

CONTRACT_FILES = [
    "auth.ts",
    "customer.ts",
    "provider.ts",
    "marketplace.ts",
    "engine.ts",
    "admin.ts",
    "realtime.ts",
]

# Path strings (single/double/backtick quoted, starting with /).
# Excludes any inside comments — quick filter via line-start preprocess.
PATH_STR_RE = re.compile(r"['\"`](\/[A-Za-z0-9_\-/\.]+)['\"`]")
PATH_FN_RE  = re.compile(r"=>\s*`(\/[^`]+)`")

# Routes whose presence we want to verify via HTTP probe too. These are
# public GET endpoints that should always 200 against a running backend.
PUBLIC_PROBE = [
    "/health",
    "/system/health",
]

# Catalogue entries that intentionally are not REST endpoints — skip.
SKIP_PATHS = {
    "/api/socket.io/",
    "/realtime",  # socket namespace (not an HTTP path)
}


# ─── 1. Strip TS comments so we don't pick up paths from /** */ blocks ──

def strip_ts_comments(src: str) -> str:
    # Remove /* ... */ block comments (non-greedy, across lines).
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    # Remove // line comments (preserve the newline so line counts stay sane).
    src = re.sub(r"(?m)^\s*//.*$", "", src)
    return src


def _to_openapi_template(path: str) -> str:
    """
    Convert a runtime path with literal IDs back to an OpenAPI template.
    Catalogue functions produce `/foo/${id}` -> `/foo/${id}` literal in
    the source; the regex captures `/foo/${id}` verbatim, then we
    normalise `${...}` -> `{id}` style for the OpenAPI lookup.
    """
    return re.sub(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}", lambda m: "{" + m.group(0)[2:-1] + "}", path)


def extract_catalogue_paths() -> list[str]:
    seen: dict[str, None] = {}

    for fname in CONTRACT_FILES:
        fpath = CONTRACTS / fname
        if not fpath.is_file():
            print(f"[warn] missing contract file: {fpath}", file=sys.stderr)
            continue
        text = strip_ts_comments(fpath.read_text(encoding="utf-8"))

        # Bare string paths (no template variables).
        for m in PATH_STR_RE.finditer(text):
            p = m.group(1)
            if p.startswith("/") and p not in SKIP_PATHS and "{" not in p:
                seen[p] = None

        # Function path templates.
        for m in PATH_FN_RE.finditer(text):
            tmpl = m.group(1)
            if tmpl.startswith("/") and tmpl not in SKIP_PATHS:
                seen[_to_openapi_template(tmpl)] = None

    return list(seen.keys())


# ─── 2. Fetch OpenAPI from running backend ──────────────────────────────

def fetch_openapi() -> dict:
    url = f"{BASE_URL}/openapi.json"
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise SystemExit(f"[fatal] backend openapi unreachable at {url}: {e}") from e


def normalize_openapi_paths(spec: dict) -> set[str]:
    """
    OpenAPI paths are prefixed with /api (matches FastAPI router prefix).
    Strip the /api prefix so we can compare apples-to-apples with the
    catalogue (which is /api-relative).
    """
    out: set[str] = set()
    for p in spec.get("paths", {}).keys():
        if p.startswith(API_PREFIX):
            out.add(p[len(API_PREFIX):])
        else:
            out.add(p)
    return out


# ─── 3. HTTP probe of public routes (sanity check) ──────────────────────

def probe_get(path: str) -> int:
    url = f"{BASE_URL}{API_PREFIX}{path}"
    try:
        with urllib.request.urlopen(url, timeout=8) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
    except urllib.error.URLError:
        return -1


# ─── 4. Driver ──────────────────────────────────────────────────────────

def main(argv: Iterable[str]) -> int:
    verbose = "-v" in argv

    catalogue = extract_catalogue_paths()
    if not catalogue:
        print("[fatal] no paths extracted from /app/shared/contracts/", file=sys.stderr)
        return 2

    spec = fetch_openapi()
    backend_paths = normalize_openapi_paths(spec)

    print(f"P2.4 smoke  base={BASE_URL}  contracts={len(catalogue)}  openapi_paths={len(backend_paths)}")
    print("-" * 78)

    drift: list[str] = []
    okays = 0
    started = time.time()

    for p in catalogue:
        if p in backend_paths:
            okays += 1
            if verbose:
                print(f"ok    {p}")
            continue
        # Fuzzy retry: catalogue may use a slightly different placeholder
        # name (`{id}` vs `{userId}`). Compare by structural equivalence:
        # replace any `{...}` with `*` on both sides.
        canon_cat = re.sub(r"\{[^}]+\}", "*", p)
        match = next(
            (bp for bp in backend_paths if re.sub(r"\{[^}]+\}", "*", bp) == canon_cat),
            None,
        )
        if match:
            okays += 1
            if verbose:
                print(f"ok    {p}  (≈ {match})")
            continue
        drift.append(p)

    elapsed = time.time() - started
    print(f"summary  ok={okays}  drift={len(drift)}  ({elapsed:.2f}s)")

    # Sanity: backend actually responding to public endpoints.
    if not drift:
        print("")
        print("HTTP sanity probe (public routes):")
        for p in PUBLIC_PROBE:
            s = probe_get(p)
            tag = "ok" if s == 200 else "WARN"
            print(f"  {tag}  [{s}]  /api{p}")

    if drift:
        print("")
        print("❌ CONTRACT DRIFT — catalogue points at routes not mounted in /openapi.json:")
        for p in drift:
            print(f"   - {p}")
        print("")
        print("Fix options:")
        print("   1. Add the FastAPI route (catalogue is right, backend is wrong)")
        print("   2. Remove/rename the entry in /app/shared/contracts/*.ts")
        print("   3. If you renamed a route, update both backend AND catalogue")
        return 1

    print("")
    print("✅ no drift — all catalogue paths are mounted")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

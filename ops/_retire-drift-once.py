#!/usr/bin/env python3
"""
One-shot drift retirement script — P2 closure.

For each path string / function template in /app/shared/contracts/*.ts:
  - If template (with {param} placeholders) is in OpenAPI paths -> keep.
  - Otherwise: comment out the line and tag with `// DRIFT-RETIRED P2:`.

This converts the catalogue from "wishful thinking" to "verified surface".
Runs ONCE — the diff is what gets committed; this script doesn't need to
live in CI (smoke does).

Saves a retirement log to /app/shared/contracts/RETIRED_P2_2026_02_22.md.
"""
from __future__ import annotations

import re
import sys
import json
import urllib.request
from pathlib import Path

CONTRACTS = Path("/app/shared/contracts")
FILES = ["auth.ts", "customer.ts", "provider.ts", "marketplace.ts", "engine.ts", "admin.ts", "realtime.ts"]
API_PREFIX = "/api"


def fetch_openapi_paths() -> set[str]:
    with urllib.request.urlopen("http://localhost:8001/openapi.json", timeout=30) as r:
        spec = json.loads(r.read().decode())
    out: set[str] = set()
    for p in spec["paths"].keys():
        if p.startswith(API_PREFIX):
            out.add(p[len(API_PREFIX):])
        else:
            out.add(p)
    return out


# Match `key: '/path'` or `key: "/path"` where path is bare (no templates).
LINE_STR_RE = re.compile(r"""^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*)(['"`])(/[^'"`\s]+)\4(\s*,?\s*)(//.*)?$""")
# Match `key: (args) => `/path/${id}``
LINE_FN_RE  = re.compile(r"""^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*\([^)]*\)\s*=>\s*)`(/[^`]+)`(\s*,?\s*)(//.*)?$""")


def template_form(path: str) -> str:
    """Replace ${name} -> {name} for OpenAPI lookup."""
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", r"{\1}", path)


def canonicalize(p: str) -> str:
    """Reduce {x} to * so different param names still match."""
    return re.sub(r"\{[^}]+\}", "*", p)


def main() -> int:
    openapi_paths = fetch_openapi_paths()
    openapi_canon = {canonicalize(p) for p in openapi_paths}

    total_retired: list[tuple[str, str]] = []  # (file, path)

    for fname in FILES:
        fpath = CONTRACTS / fname
        src   = fpath.read_text(encoding="utf-8")
        lines = src.split("\n")
        new_lines: list[str] = []
        file_retired: list[str] = []

        for ln in lines:
            m_str = LINE_STR_RE.match(ln)
            m_fn  = LINE_FN_RE.match(ln)

            target_path: str | None = None
            if m_str:
                target_path = m_str.group(5)
            elif m_fn:
                target_path = template_form(m_fn.group(4))

            if target_path is None:
                new_lines.append(ln)
                continue

            # Some entries are intentionally non-REST (socket, namespace).
            if target_path in ("/api/socket.io/", "/realtime"):
                new_lines.append(ln)
                continue

            if target_path in openapi_paths or canonicalize(target_path) in openapi_canon:
                new_lines.append(ln)
                continue

            # DRIFT — retire this line.
            indent = (m_str or m_fn).group(1)
            new_lines.append(f"{indent}// DRIFT-RETIRED P2: backend route missing — restore when backend adds it")
            new_lines.append(f"{indent}// {ln.lstrip()}")
            file_retired.append(target_path)

        if file_retired:
            fpath.write_text("\n".join(new_lines), encoding="utf-8")
            print(f"{fname}: retired {len(file_retired)} entries")
            for p in file_retired:
                total_retired.append((fname, p))

    # Write retirement log.
    log = CONTRACTS / "RETIRED_P2_2026_02_22.md"
    log.write_text(
        "# Drift retirement log — P2 closure (2026-02-22)\n\n"
        "> Entries below were present in the legacy `api-contracts.ts`\n"
        "> but the backend does not (currently) mount them in `/openapi.json`.\n"
        "> They have been commented out in the canonical catalogue with a\n"
        "> `// DRIFT-RETIRED P2:` marker.\n\n"
        "> Restoring an entry requires the backend FastAPI route to be added\n"
        "> in the same PR. Smoke (`/app/ops/smoke-api-contracts.sh`) will\n"
        "> verify.\n\n"
        f"**Total retired:** {len(total_retired)}\n\n"
        "| File | Path |\n|---|---|\n"
        + "\n".join(f"| `{f}` | `{p}` |" for f, p in total_retired)
        + "\n",
        encoding="utf-8",
    )
    print(f"\nTotal retired: {len(total_retired)} entries → {log}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

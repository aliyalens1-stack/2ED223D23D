#!/usr/bin/env bash
# P2.4 — Contract anti-regression wall.
#
# Shell wrapper around /app/ops/smoke-api-contracts.py. Exits with the
# child's exit code; safe to call from pre-commit and CI.
#
# Env:
#   SMOKE_BASE_URL   default http://localhost:8001
#   SMOKE_SAMPLE_ID  default smoke_id_000
#
# See /app/shared/contracts/DOCTRINE.md §6 for status semantics.

set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 ops/smoke-api-contracts.py "$@"

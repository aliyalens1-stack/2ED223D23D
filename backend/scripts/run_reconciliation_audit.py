#!/usr/bin/env python3
"""Sprint B4.3-A.1 — Run reconciliation audit against live MongoDB.

READ-ONLY. Produces two artefacts:

  /app/audit/reconciliation_<YYYYMMDD_HHMMSS>.json
  /app/audit/reconciliation_<YYYYMMDD_HHMMSS>.md

And, optionally, prints a short human summary to stdout.

Usage:
  python /app/backend/scripts/run_reconciliation_audit.py
  python /app/backend/scripts/run_reconciliation_audit.py --limit 5000
  python /app/backend/scripts/run_reconciliation_audit.py --quiet

Doctrine:
  This script does not write to MongoDB. It only reads. The audit
  directory output is the only side-effect. Re-running is idempotent
  except for the timestamp in the filename.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Allow `python scripts/run_reconciliation_audit.py` from /app/backend.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient
from app.payments.reconciliation import generate_report


MONGO = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")
AUDIT_DIR = Path("/app/audit")


def _fmt_money_dict(d: dict) -> str:
    if not d:
        return "—"
    return ", ".join(f"{round(v, 2)} {k}" for k, v in d.items())


def render_markdown(report: dict) -> str:
    lines: list[str] = []
    lines.append(f"# Reconciliation Audit — service_payments")
    lines.append("")
    lines.append(f"**Generated:** {report['generatedAt']}")
    lines.append(f"**Scope:** {report['scope']}")
    lines.append(f"**Total docs scanned:** {report['totalDocs']}")
    if report.get("limit"):
        lines.append(f"**Limit applied:** {report['limit']}")
    lines.append("")
    lines.append("---")
    lines.append("")

    lines.append("## Buckets")
    lines.append("")
    lines.append("| Bucket | Statuses observed | Count | Gross | Provider payout | Refund |")
    lines.append("|---|---|---:|---|---|---|")
    bucket_order = [
        "outstanding_escrow",
        "settled_to_provider",
        "refunded_to_customer",
        "terminal_failure",
        "pre_escrow",
        "unknown",
    ]
    for name in bucket_order:
        b = report["buckets"].get(name)
        if not b:
            continue
        lines.append(
            f"| `{name}` | {', '.join(b['statuses']) or '—'} | {b['count']} | "
            f"{_fmt_money_dict(b['gross_by_currency'])} | "
            f"{_fmt_money_dict(b['payout_by_currency'])} | "
            f"{_fmt_money_dict(b['refund_by_currency'])} |"
        )
    lines.append("")

    lines.append("## Outstanding escrow (the platform's open liability)")
    lines.append("")
    outstanding = report["buckets"].get("outstanding_escrow") or {}
    if outstanding.get("count", 0) == 0:
        lines.append("_No outstanding escrow at audit time._")
    else:
        lines.append(f"**{outstanding['count']} payment(s)** in escrow, statuses: "
                     f"`{', '.join(outstanding['statuses'])}`.")
        lines.append("")
        lines.append(f"Sum by currency: **{_fmt_money_dict(outstanding['gross_by_currency'])}**")
    lines.append("")

    lines.append("## Top providers by outstanding escrow")
    lines.append("")
    tp = report.get("topProvidersOutstanding") or []
    if not tp:
        lines.append("_No data._")
    else:
        lines.append("| Provider | Count | Total by currency |")
        lines.append("|---|---:|---|")
        for r in tp:
            lines.append(f"| `{r['key']}` | {r['count']} | {_fmt_money_dict(r['totalByCurrency'])} |")
    lines.append("")

    lines.append("## Top customers by outstanding escrow")
    lines.append("")
    tc = report.get("topCustomersOutstanding") or []
    if not tc:
        lines.append("_No data._")
    else:
        lines.append("| Customer | Count | Total by currency |")
        lines.append("|---|---:|---|")
        for r in tc:
            lines.append(f"| `{r['key']}` | {r['count']} | {_fmt_money_dict(r['totalByCurrency'])} |")
    lines.append("")

    lines.append("## Divergences")
    lines.append("")
    counts = report.get("divergenceCountsByCode") or {}
    if not counts:
        lines.append("_No divergences detected._ ✅")
    else:
        lines.append("| Code | Count |")
        lines.append("|---|---:|")
        for code, n in sorted(counts.items(), key=lambda kv: -kv[1]):
            lines.append(f"| `{code}` | {n} |")
        lines.append("")
        lines.append("<details><summary>First 50 divergence records</summary>")
        lines.append("")
        lines.append("```json")
        lines.append(json.dumps(report["divergences"][:50], indent=2, ensure_ascii=False))
        lines.append("```")
        lines.append("")
        lines.append("</details>")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("_This report is read-only. No data was mutated to produce it. "
                 "Re-running on a quiet DB should produce an identical bucket table."
                 " Divergences reflect the state at audit time only._")
    return "\n".join(lines)


async def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None,
                   help="Sample limit (default: all rows)")
    p.add_argument("--quiet", action="store_true",
                   help="Suppress the stdout summary")
    p.add_argument("--out-dir", type=str, default=str(AUDIT_DIR),
                   help="Output directory (default: /app/audit)")
    args = p.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    client = AsyncIOMotorClient(MONGO)
    db = client[DB_NAME]
    try:
        report = await generate_report(db, limit=args.limit)
    finally:
        client.close()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    json_path = out_dir / f"reconciliation_{stamp}.json"
    md_path = out_dir / f"reconciliation_{stamp}.md"

    with json_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    with md_path.open("w", encoding="utf-8") as f:
        f.write(render_markdown(report))

    if not args.quiet:
        print("─" * 64)
        print(f"Reconciliation Audit — service_payments")
        print(f"  generated:    {report['generatedAt']}")
        print(f"  total docs:   {report['totalDocs']}")
        print(f"  artefacts:    {json_path}")
        print(f"                {md_path}")
        print()
        for name in ("outstanding_escrow", "settled_to_provider",
                     "refunded_to_customer", "terminal_failure",
                     "pre_escrow", "unknown"):
            b = report["buckets"].get(name, {})
            statuses = ", ".join(b.get("statuses", [])) or "—"
            cnt = b.get("count", 0)
            gross = b.get("gross_by_currency", {})
            gross_str = ", ".join(f"{round(v,2)} {k}" for k, v in gross.items()) or "—"
            print(f"  {name:<22} count={cnt:<6} gross=[{gross_str}]")
            if statuses != "—":
                print(f"  {' '*22} statuses=[{statuses}]")
        print()
        divs = report.get("divergenceCountsByCode") or {}
        if not divs:
            print("  divergences:  none ✅")
        else:
            print("  divergences:")
            for code, n in sorted(divs.items(), key=lambda kv: -kv[1]):
                print(f"    {code:<32} {n}")
        print("─" * 64)

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

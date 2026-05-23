"""Sprint 28 — Revenue Dashboard.

Aggregates payments + boost purchases for admin to answer in 10s:
сколько заработали / откуда / какие провайдеры платят / где просадка.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase  # type: ignore

router = APIRouter(tags=["admin-revenue"])

logger = logging.getLogger("server")

db: Optional[AsyncIOMotorDatabase] = None
_verify_admin = None


def init(database, verify_admin_token):
    global db, _verify_admin
    db = database
    _verify_admin = verify_admin_token


def _now():
    return datetime.now(timezone.utc)


# ─────────────────────────────────────────────────────────────
# Reader-side tolerant datetime coercion — Phase 2A-β follow-up.
#
# Why this exists:
#   `payment_transactions.createdAt` and `provider_purchases.createdAt`
#   have historically been written in two shapes:
#     * Python `datetime` (BSON Date)        ← e.g. early seed paths, some
#                                              MongoDB-native writers
#     * ISO 8601 `str`                       ← most current Python writers
#   When `recent.sort(key=lambda r: r.get("createdAt") or "", ...)` mixed
#   both types, Python raised:
#     TypeError: '<' not supported between instances of 'datetime.datetime'
#     and 'str'
#   and the whole `/api/admin/revenue/summary` endpoint 500'd.
#
# Scope of this helper (locked):
#   - reader-side only — NO write paths touch the DB to "normalize" data.
#   - additive — same callers see the same response shape; only the sort
#     key and the response `createdAt` value are coerced.
#   - tolerant — accepts datetime + str + None; rejects everything else
#     without raising.
#   - never silently coerces malformed values into wrong totals — see the
#     `_malformed_created_at_counter` to detect drift.
#
# Coercion rules (literal):
#   datetime               → ISO 8601 string via .isoformat()
#   str (any non-empty)    → kept verbatim (NOT parsed; lexicographic sort
#                            on ISO 8601 is correct chronological sort)
#   None / "" / other type → "" (sortable bottom; never raises)
#
# We deliberately do NOT call datetime.fromisoformat on the string form:
#   1. ISO 8601 sorts lexicographically the same way it sorts as a date.
#   2. Parsing every recent[] item would multiply CPU cost and surface
#      parse errors for legacy timezone-suffix variants we don't need to
#      handle here.
#   3. User constraint: "Не parse all dates everywhere".
#
# Malformed counter:
#   _malformed_created_at_counter increments whenever the helper sees a
#   value that is neither `datetime` nor a non-empty string nor `None`.
#   This is a debug signal, not user-facing — visible via logs at WARNING
#   level on each transition (debounced to first occurrence per minute by
#   `_malformed_log_throttle`).
# ─────────────────────────────────────────────────────────────
_malformed_created_at_counter = 0
_malformed_log_throttle: dict = {"last_minute_bucket": -1}


def _coerce_created_at(value: Any) -> str:
    """Reader-side coercion of `createdAt` to an ISO-8601 sortable string.

    See module docstring for the full contract and rationale.
    """
    global _malformed_created_at_counter
    if value is None:
        return ""
    if isinstance(value, datetime):
        # Datetimes from BSON Date — emit ISO so they sort against ISO strings.
        return value.isoformat()
    if isinstance(value, str):
        # ISO strings — keep verbatim (lex sort is correct for ISO 8601).
        return value
    # Unknown type — count, optionally log, and treat as sortable bottom.
    _malformed_created_at_counter += 1
    try:
        import time as _time
        minute_bucket = int(_time.time() // 60)
        if _malformed_log_throttle["last_minute_bucket"] != minute_bucket:
            _malformed_log_throttle["last_minute_bucket"] = minute_bucket
            logger.warning(
                f"revenue._coerce_created_at: malformed createdAt type={type(value).__name__} "
                f"(total since boot: {_malformed_created_at_counter})"
            )
    except Exception:
        pass
    return ""


async def _sum_amount(start_iso: str, extra_match: Optional[dict] = None):
    """Sum amount across payment_transactions + provider_purchases (both are revenue sources)."""
    match = {"createdAt": {"$gte": start_iso}, "status": {"$in": ["paid", "completed"]}}
    if extra_match:
        match.update(extra_match)
    pipeline = [
        {"$match": match},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}, "count": {"$sum": 1}}},
    ]
    total = 0
    count = 0
    for coll_name in ("payment_transactions", "provider_purchases"):
        try:
            coll = getattr(db, coll_name)
            rows = await coll.aggregate(pipeline).to_list(1)
            if rows:
                total += int(rows[0].get("total", 0) or 0)
                count += int(rows[0].get("count", 0) or 0)
        except Exception:
            continue
    return {"total": total, "count": count}


@router.get("/api/admin/revenue/summary")
async def revenue_summary():  # auth applied via dependency below
    if db is None:
        raise HTTPException(500, "DB not initialised")

    now = _now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    week_start = (now - timedelta(days=7)).isoformat()
    month_start = (now - timedelta(days=30)).isoformat()

    today = await _sum_amount(today_start)
    week = await _sum_amount(week_start)
    month = await _sum_amount(month_start)

    # ── Sprint 28 finalization: yesterday + last-week (для growth deltas) ──
    yesterday_start = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    today_start_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday_end = today_start_dt.isoformat()
    yesterday = await _sum_amount(yesterday_start, {"createdAt": {"$gte": yesterday_start, "$lt": yesterday_end}})
    last_week_start = (now - timedelta(days=14)).isoformat()
    last_week_end = (now - timedelta(days=7)).isoformat()
    last_week = await _sum_amount(last_week_start, {"createdAt": {"$gte": last_week_start, "$lt": last_week_end}})

    def _growth(curr: int, prev: int) -> float:
        if not prev:
            return 0.0 if not curr else 1.0
        return round((curr - prev) / prev, 3)

    growth = {
        "vsYesterday": _growth(today["total"], yesterday["total"]),
        "vsLastWeek": _growth(week["total"], last_week["total"]),
    }

    # Status breakdown (last 30d) — across both collections
    paid = 0
    failed = 0
    total_txn = 0
    for coll_name in ("payment_transactions", "provider_purchases"):
        try:
            coll = getattr(db, coll_name)
            rows = await coll.aggregate([
                {"$match": {"createdAt": {"$gte": month_start}}},
                {"$group": {"_id": "$status", "count": {"$sum": 1}}},
            ]).to_list(20)
            for r in rows:
                cnt = int(r.get("count", 0) or 0)
                total_txn += cnt
                if r.get("_id") in ("paid", "completed"):
                    paid += cnt
                elif r.get("_id") == "failed":
                    failed += cnt
        except Exception:
            continue
    conversion = round(paid / total_txn, 3) if total_txn else 0

    # Boost-only revenue (productCode containing 'boost' OR config.boostMultiplier present)
    boost_revenue = 0
    try:
        rows = await db.provider_purchases.aggregate([
            {"$match": {
                "createdAt": {"$gte": month_start},
                "status": {"$in": ["paid", "completed"]},
                "productCode": {"$regex": "boost", "$options": "i"},
            }},
            {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
        ]).to_list(1)
        boost_revenue = int(rows[0]["total"]) if rows else 0
    except Exception:
        pass

    avg_order = round(month["total"] / month["count"], 2) if month["count"] else 0

    # ── Sprint 28 finalization: revenue breakdown by source ───────────────
    # boost = provider_purchases с productCode~boost; subscription = sub*; other = всё остальное
    breakdown = {"boost": boost_revenue, "subscription": 0, "other": 0}
    try:
        sub_rows = await db.provider_purchases.aggregate([
            {"$match": {
                "createdAt": {"$gte": month_start},
                "status": {"$in": ["paid", "completed"]},
                "productCode": {"$regex": "subscription|sub_", "$options": "i"},
            }},
            {"$group": {"_id": None, "total": {"$sum": "$amount"}}},
        ]).to_list(1)
        breakdown["subscription"] = int(sub_rows[0]["total"]) if sub_rows else 0
    except Exception:
        pass
    breakdown["other"] = max(0, int(month["total"]) - breakdown["boost"] - breakdown["subscription"])

    # Top providers (last 30d) — across both collections
    by_slug: dict = {}
    for coll_name in ("payment_transactions", "provider_purchases"):
        try:
            coll = getattr(db, coll_name)
            rows = await coll.aggregate([
                {"$match": {
                    "createdAt": {"$gte": month_start},
                    "status": {"$in": ["paid", "completed"]},
                }},
                {"$group": {
                    "_id": "$providerSlug",
                    "revenue": {"$sum": "$amount"},
                    "transactions": {"$sum": 1},
                }},
            ]).to_list(50)
            for r in rows:
                slug = r.get("_id")
                if not slug:
                    continue
                slot = by_slug.setdefault(slug, {"revenue": 0, "transactions": 0})
                slot["revenue"] += int(r.get("revenue", 0) or 0)
                slot["transactions"] += int(r.get("transactions", 0) or 0)
        except Exception:
            continue
    top_slugs = sorted(by_slug.items(), key=lambda kv: kv[1]["revenue"], reverse=True)[:5]
    slugs = [s for s, _ in top_slugs]
    orgs = await db.organizations.find({"slug": {"$in": slugs}}, {"_id": 0, "slug": 1, "name": 1}).to_list(50)
    org_by_slug = {o["slug"]: o for o in orgs}
    top_providers_out = []
    for slug, agg in top_slugs:
        ent = await db.provider_entitlements.find_one({"providerSlug": slug, "boostActive": True}, {"_id": 0})
        top_providers_out.append({
            "providerId": slug,
            "name": (org_by_slug.get(slug, {}) or {}).get("name") or slug,
            "revenue": agg["revenue"],
            "transactions": agg["transactions"],
            "boostLevel": ent.get("boostLevel") if ent else None,
        })

    # Top zones (best-effort — payment_transactions может содержать zoneId)
    top_zones_out = []
    try:
        rows = await db.payment_transactions.aggregate([
            {"$match": {
                "status": {"$in": ["paid", "completed"]},
                "createdAt": {"$gte": month_start},
                "zoneId": {"$exists": True, "$ne": None},
            }},
            {"$group": {"_id": "$zoneId", "revenue": {"$sum": "$amount"}, "transactions": {"$sum": 1}}},
            {"$sort": {"revenue": -1}},
            {"$limit": 5},
        ]).to_list(5)
        if rows:
            zone_ids = [r["_id"] for r in rows]
            zones = await db.zones.find({"id": {"$in": zone_ids}}, {"_id": 0, "id": 1, "name": 1}).to_list(20)
            zone_by_id = {z["id"]: z for z in zones}
            for r in rows:
                zid = r["_id"]
                top_zones_out.append({
                    "zoneId": zid,
                    "name": (zone_by_id.get(zid, {}) or {}).get("name") or zid,
                    "revenue": int(r["revenue"]),
                    "transactions": int(r["transactions"]),
                })
    except Exception:
        pass

    # Recent transactions (mix from both collections)
    recent: list = []
    for coll_name, type_default in (("provider_purchases", "boost"), ("payment_transactions", "payment")):
        try:
            coll = getattr(db, coll_name)
            docs = await coll.find({}, {"_id": 0}).sort("createdAt", -1).limit(10).to_list(10)
            for d in docs:
                recent.append({
                    "id": d.get("id") or d.get("_id") or "",
                    "providerId": d.get("providerSlug") or d.get("providerId") or "",
                    "amount": int(d.get("amount", 0) or 0),
                    "status": d.get("status") or "unknown",
                    "type": d.get("type") or d.get("productCode") or type_default,
                    # Reader-side tolerant coercion (see module docstring).
                    # Normalize at projection time so the sort below and the
                    # JSON response both see a string. Datetime/BSON-Date docs
                    # become ISO; unknown types become "" (sortable bottom).
                    "createdAt": _coerce_created_at(d.get("createdAt")) or None,
                })
        except Exception:
            continue
    # Sort by the already-coerced string — datetime ↔ str crash impossible.
    recent.sort(key=lambda r: r.get("createdAt") or "", reverse=True)
    recent = recent[:10]

    # ── Sprint 28 finalization: critical alerts (что орёт когда деньги падают) ──
    alerts: list = []
    # 1) Падение конверсии (threshold: -20% vs прошлая неделя — сравним paid/total)
    try:
        prev_paid = 0
        prev_total = 0
        for coll_name in ("payment_transactions", "provider_purchases"):
            coll = getattr(db, coll_name)
            rows = await coll.aggregate([
                {"$match": {"createdAt": {"$gte": last_week_start, "$lt": last_week_end}}},
                {"$group": {"_id": "$status", "count": {"$sum": 1}}},
            ]).to_list(20)
            for r in rows:
                cnt = int(r.get("count", 0) or 0)
                prev_total += cnt
                if r.get("_id") in ("paid", "completed"):
                    prev_paid += cnt
        prev_conv = (prev_paid / prev_total) if prev_total else 0
        if prev_conv > 0 and conversion > 0:
            delta = (conversion - prev_conv) / prev_conv
            if delta <= -0.2:
                alerts.append({
                    "type": "danger",
                    "text": f"Падение конверсии {int(delta * 100)}% за неделю ({int(prev_conv * 100)}% → {int(conversion * 100)}%)",
                })
    except Exception:
        pass

    # 2) Нет новых платежей за последние 3 часа (если хотя бы что-то было за день)
    try:
        if today["count"] > 0:
            three_h_ago = (now - timedelta(hours=3)).isoformat()
            recent3 = await _sum_amount(three_h_ago)
            if recent3["count"] == 0:
                alerts.append({
                    "type": "warning",
                    "text": "Нет новых платежей за последние 3 часа",
                })
    except Exception:
        pass

    # 3) Failed > 30% от транзакций за день — Stripe/payment provider issue
    try:
        if today["count"] >= 3:
            fail_rows = []
            for coll_name in ("payment_transactions", "provider_purchases"):
                coll = getattr(db, coll_name)
                r = await coll.aggregate([
                    {"$match": {"createdAt": {"$gte": today_start}, "status": "failed"}},
                    {"$group": {"_id": None, "count": {"$sum": 1}}},
                ]).to_list(1)
                fail_rows.extend(r)
            today_fails = sum(int(r.get("count", 0) or 0) for r in fail_rows)
            if today_fails / today["count"] >= 0.3:
                alerts.append({
                    "type": "danger",
                    "text": f"{today_fails} из {today['count']} платежей провалились — проверьте Stripe webhook",
                })
    except Exception:
        pass

    # 4) Concentration risk: один провайдер даёт >50% месячного дохода
    try:
        if month["total"] > 0 and top_providers_out:
            top = top_providers_out[0]
            share = top["revenue"] / month["total"]
            if share > 0.5:
                alerts.append({
                    "type": "warning",
                    "text": f"{top['name']} даёт {int(share * 100)}% дохода — высокая концентрация",
                })
    except Exception:
        pass

    # ── Phase 2A — cluster-aware split (additive read; READERS ONLY).
    # Invariants:
    #   1. NEVER sum money across currencies.
    #   2. Documents without explicit `cluster` field go to "unknown" bucket
    #      (NOT inferred to repair/inspection — honors Phase 1B manual_review semantics).
    #   3. Documents without explicit `currency` field land in a separate
    #      currency=null sub-bucket (NOT defaulted to UAH).
    #   4. Existing response keys above stay byte-identical for back-compat.
    async def _cluster_split_for_period(start_iso: str) -> dict:
        """Group paid txns by (cluster, currency). Returns:
        {
          "byCluster": {
            "<cluster_or_unknown>": {
              "byCurrency": [{"currency": "EUR"|"UAH"|None, "total": int, "count": int}, ...],
              "transactions": int
            },
            ...
          },
          "byCurrency": [{"currency": "EUR", "total": int, "count": int}, ...],
          "manualReviewCount": int,
          "period": "month"
        }
        """
        match = {
            "createdAt": {"$gte": start_iso},
            "status": {"$in": ["paid", "completed"]},
        }
        pipeline = [
            {"$match": match},
            {"$group": {
                "_id": {
                    "cluster": "$cluster",   # may be null/missing → bucket as unknown
                    "currency": "$currency", # may be null → currency=null sub-bucket
                },
                "total": {"$sum": "$amount"},
                "count": {"$sum": 1},
            }},
        ]
        by_cluster: dict = {}
        by_currency_global: dict = {}
        manual_review_count = 0
        # Aggregate ACROSS both collections, but keep currencies STRICTLY separated.
        for coll_name in ("payment_transactions", "provider_purchases"):
            try:
                coll = getattr(db, coll_name)
                rows = await coll.aggregate(pipeline).to_list(200)
                for r in rows:
                    cluster_val = (r.get("_id", {}) or {}).get("cluster") or "unknown"
                    currency_val = (r.get("_id", {}) or {}).get("currency")  # keep None if absent
                    total = int(r.get("total", 0) or 0)
                    count = int(r.get("count", 0) or 0)

                    slot = by_cluster.setdefault(cluster_val, {"byCurrency": {}, "transactions": 0})
                    cur_slot = slot["byCurrency"].setdefault(currency_val, {"total": 0, "count": 0})
                    cur_slot["total"] += total
                    cur_slot["count"] += count
                    slot["transactions"] += count

                    g = by_currency_global.setdefault(currency_val, {"total": 0, "count": 0})
                    g["total"] += total
                    g["count"] += count
            except Exception:
                continue

        # manual_review: docs with clusterBackfillMeta.strategy='manual_review'
        # OR clusterCreateMeta.strategy='manual_review' AND payment-paid.
        try:
            for coll_name in ("payment_transactions", "provider_purchases"):
                coll = getattr(db, coll_name)
                manual_review_count += await coll.count_documents({
                    "createdAt": {"$gte": start_iso},
                    "status": {"$in": ["paid", "completed"]},
                    "$or": [
                        {"clusterBackfillMeta.strategy": "manual_review"},
                        {"clusterCreateMeta.strategy": "manual_review"},
                    ],
                })
        except Exception:
            pass

        # Flatten currency dicts → arrays (deterministic order: sort by currency str, None last).
        def _flatten_currency_dict(d: dict) -> list:
            items = []
            for cur, agg in d.items():
                items.append({"currency": cur, "total": agg["total"], "count": agg["count"]})
            items.sort(key=lambda x: (x["currency"] is None, x["currency"] or ""))
            return items

        for cluster_val, slot in by_cluster.items():
            slot["byCurrency"] = _flatten_currency_dict(slot["byCurrency"])

        return {
            "byCluster": by_cluster,
            "byCurrency": _flatten_currency_dict(by_currency_global),
            "manualReviewCount": manual_review_count,
            "period": "month",
        }

    cluster_split = await _cluster_split_for_period(month_start)

    return {
        "today": today["total"],
        "yesterday": yesterday["total"],
        "week": week["total"],
        "lastWeek": last_week["total"],
        "month": month["total"],
        "currency": "UAH",
        "transactions": total_txn,
        "paidTransactions": paid,
        "failedTransactions": failed,
        "boostRevenue": boost_revenue,
        "avgOrderValue": avg_order,
        "conversionRate": conversion,
        "growth": growth,
        "revenueBreakdown": breakdown,
        "alerts": alerts,
        "topProviders": top_providers_out,
        "topZones": top_zones_out,
        "recent": recent,
    }


# ─────────────────────────────────────────────────────────────
# Phase 2A — cluster-aware revenue split (READER ONLY, separate endpoint).
#
# Strict invariants:
#   1. NEVER sums money across currencies.
#   2. Documents WITHOUT explicit `cluster` field → "unknown" bucket
#      (NOT inferred to repair/inspection — honors Phase 1B manual_review semantics).
#   3. Documents WITHOUT explicit `currency` field → currency=null sub-bucket
#      (NOT defaulted to UAH — honors "never infer amount semantics").
#   4. Does NOT modify /api/admin/revenue/summary response shape (back-compat).
#   5. Adds NO write paths, NO webhook changes, NO UI assumptions.
#
# ⚠ DEPRECATED in favor of /api/admin/revenue/cluster-summary (below) —
#    canonical Phase 2A-α contract uses `totalsByCluster` shape with
#    nested currency map and `amount=null` semantics. This endpoint
#    is kept verbatim because it had zero external consumers at the
#    time of the rename; do not build new clients against it.
# ─────────────────────────────────────────────────────────────
@router.get("/api/admin/revenue/cluster-split")
async def revenue_cluster_split(period: str = "month"):
    """Return paid revenue grouped by (cluster, currency) for the requested period.

    Args:
        period: one of "today" | "week" | "month" (default month).

    Response shape:
        {
          "period": "month",
          "windowStart": "<iso>",
          "byCluster": {
            "<cluster_or_unknown>": {
              "byCurrency": [{"currency": "EUR"|"UAH"|None, "total": int, "count": int}, ...],
              "transactions": int
            }, ...
          },
          "byCurrency": [{"currency": "EUR", "total": int, "count": int}, ...],
          "manualReviewCount": int,
          "unknownClusterCount": int,
          "missingCurrencyCount": int
        }
    """
    if db is None:
        raise HTTPException(500, "DB not initialised")
    now = _now()
    if period == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "week":
        start = now - timedelta(days=7)
    else:
        start = now - timedelta(days=30)
        period = "month"
    start_iso = start.isoformat()

    match = {
        "createdAt": {"$gte": start_iso},
        "status": {"$in": ["paid", "completed"]},
    }
    pipeline = [
        {"$match": match},
        {"$group": {
            "_id": {
                "cluster": "$cluster",
                "currency": "$currency",
            },
            "total": {"$sum": "$amount"},
            "count": {"$sum": 1},
        }},
    ]

    by_cluster: dict = {}
    by_currency_global: dict = {}
    unknown_cluster_count = 0
    missing_currency_count = 0

    # Aggregate across BOTH payment_transactions and provider_purchases — but
    # currencies are kept strictly separated at every level.
    for coll_name in ("payment_transactions", "provider_purchases"):
        try:
            coll = getattr(db, coll_name)
            rows = await coll.aggregate(pipeline).to_list(200)
            for r in rows:
                ident = r.get("_id", {}) or {}
                cluster_val = ident.get("cluster") or "unknown"
                currency_val = ident.get("currency")  # keep None if absent
                total = int(r.get("total", 0) or 0)
                count = int(r.get("count", 0) or 0)

                if cluster_val == "unknown":
                    unknown_cluster_count += count
                if currency_val is None:
                    missing_currency_count += count

                slot = by_cluster.setdefault(cluster_val, {"byCurrency": {}, "transactions": 0})
                cur_slot = slot["byCurrency"].setdefault(currency_val, {"total": 0, "count": 0})
                cur_slot["total"] += total
                cur_slot["count"] += count
                slot["transactions"] += count

                g = by_currency_global.setdefault(currency_val, {"total": 0, "count": 0})
                g["total"] += total
                g["count"] += count
        except Exception:
            continue

    # manual_review: docs with Phase 1A or Phase 1B manual_review breadcrumb,
    # paid in the window.
    manual_review_count = 0
    try:
        for coll_name in ("payment_transactions", "provider_purchases"):
            coll = getattr(db, coll_name)
            manual_review_count += await coll.count_documents({
                "createdAt": {"$gte": start_iso},
                "status": {"$in": ["paid", "completed"]},
                "$or": [
                    {"clusterBackfillMeta.strategy": "manual_review"},
                    {"clusterCreateMeta.strategy": "manual_review"},
                ],
            })
    except Exception:
        pass

    def _flatten_currency_dict(d: dict) -> list:
        items = []
        for cur, agg in d.items():
            items.append({"currency": cur, "total": agg["total"], "count": agg["count"]})
        items.sort(key=lambda x: (x["currency"] is None, x["currency"] or ""))
        return items

    for cluster_val, slot in by_cluster.items():
        slot["byCurrency"] = _flatten_currency_dict(slot["byCurrency"])

    return {
        "period": period,
        "windowStart": start_iso,
        "byCluster": by_cluster,
        "byCurrency": _flatten_currency_dict(by_currency_global),
        "manualReviewCount": manual_review_count,
        "unknownClusterCount": unknown_cluster_count,
        "missingCurrencyCount": missing_currency_count,
    }


# Wrap with admin auth at registration time (server.py applies dependency).


# ═════════════════════════════════════════════════════════════
# Phase 2A-α — CANONICAL revenue reader contract.
#
# Scope (locked):
#   - read-only
#   - no writer changes
#   - no webhook changes
#   - no checkout changes
#   - no currency conversion
#   - no summing across currencies
#   - no UI assumptions (frontend MUST wait for contract freeze)
#
# Master invariant: money is grouped by currency BEFORE it is summed.
#
# Field semantics (HARD-LOCKED — do not change without bumping version):
#   - `totalsByCluster`: dict<cluster_label, dict<currency_label, {count, amount}>>
#   - `cluster_label`:
#       * any concrete cluster string that Phase 1B writers stamp
#         (inspection, repair, billing_boost, etc.), AS-IS
#       * "manual_review" — explicit bucket for documents whose Phase 1B
#         writer chose `clusterCreateMeta.strategy='manual_review'`
#         (writer-side decision is pending). Overrides any `cluster` field
#         these docs might also carry.
#       * "unknown" — documents missing the `cluster` field entirely
#         (NOT inferred — admin must see how many slipped through writers).
#   - `currency_label`:
#       * any concrete currency string from the doc (`EUR`, `UAH`, ...)
#       * "unknown" — documents missing the `currency` field
#         (NOT defaulted to UAH — admin must see how many lack it).
#   - `count`: ALWAYS an integer (we count rows even when we don't trust
#     their sum).
#   - `amount`:
#       * integer (sum of `doc.amount` in this (cluster, currency) bucket)
#         IFF cluster != "manual_review" AND currency != "unknown".
#       * `null` (JSON null) otherwise — signals "untrusted aggregate, see
#         count". This is intentional. Frontend MUST NOT default null to 0
#         when rendering — it MUST render the bucket with a "pending /
#         unverified" affordance distinct from a zero-revenue bucket.
#
# Period dimension:
#   - `period`: "today" | "week" | "month" (default month — same windows
#     as existing /api/admin/revenue/summary endpoint).
#   - `windowStart`: ISO 8601 timestamp marking the lower bound of the
#     aggregation window (`createdAt >= windowStart`).
#
# Source collections:
#   - payment_transactions
#   - provider_purchases
#   Aggregated together, but currencies kept strictly separated at every
#   group level. There is no merger across collections that would conflate
#   monetary semantics.
# ═════════════════════════════════════════════════════════════
@router.get("/api/admin/revenue/cluster-summary")
async def revenue_cluster_summary(period: str = "month"):
    """Canonical Phase 2A-α revenue read.

    Returns paid revenue grouped by `(cluster, currency)` with strict
    no-sum-across-currencies semantics and explicit `null` amounts for
    untrusted buckets (manual_review or missing currency).

    See the locked contract notes above this function for the exhaustive
    field semantics. Frontend integration is DEFERRED until the contract
    is frozen by Phase 2A-β.
    """
    if db is None:
        raise HTTPException(500, "DB not initialised")

    now = _now()
    if period == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        period_label = "today"
    elif period == "week":
        start = now - timedelta(days=7)
        period_label = "week"
    else:
        start = now - timedelta(days=30)
        period_label = "month"
    start_iso = start.isoformat()

    # Aggregation: project effective cluster/currency labels BEFORE grouping,
    # so a single $group call yields the canonical (cluster, currency) keys.
    # - manual_review override: if writer breadcrumb says manual_review,
    #   the row goes to that bucket regardless of any `cluster` field.
    # - "unknown" labels are STRING (not Mongo null) so JSON keys serialize
    #   cleanly into the response dict.
    pipeline = [
        {"$match": {
            "createdAt": {"$gte": start_iso},
            "status": {"$in": ["paid", "completed"]},
        }},
        {"$addFields": {
            "_effectiveCluster": {
                "$cond": [
                    {"$or": [
                        {"$eq": ["$clusterCreateMeta.strategy", "manual_review"]},
                        {"$eq": ["$clusterBackfillMeta.strategy", "manual_review"]},
                    ]},
                    "manual_review",
                    {"$ifNull": ["$cluster", "unknown"]},
                ],
            },
            "_effectiveCurrency": {"$ifNull": ["$currency", "unknown"]},
        }},
        {"$group": {
            "_id": {
                "cluster": "$_effectiveCluster",
                "currency": "$_effectiveCurrency",
            },
            "rawTotal": {"$sum": "$amount"},
            "count": {"$sum": 1},
        }},
    ]

    # Accumulate across both source collections — keys (cluster, currency)
    # are identical across collections, so we merge at the Python layer.
    totals: dict = {}  # cluster -> currency -> {count, amount}
    for coll_name in ("payment_transactions", "provider_purchases"):
        try:
            coll = getattr(db, coll_name)
            rows = await coll.aggregate(pipeline).to_list(500)
            for r in rows:
                ident = r.get("_id", {}) or {}
                cluster_label = ident.get("cluster") or "unknown"
                currency_label = ident.get("currency") or "unknown"
                raw_total = int(r.get("rawTotal", 0) or 0)
                count = int(r.get("count", 0) or 0)

                cluster_slot = totals.setdefault(cluster_label, {})
                cur_slot = cluster_slot.setdefault(
                    currency_label, {"count": 0, "_raw": 0}
                )
                cur_slot["count"] += count
                cur_slot["_raw"] += raw_total
        except Exception:
            continue

    # Final pass: apply trust rule (amount=null for manual_review OR
    # currency=="unknown"). Strip the internal "_raw" accumulator.
    totals_by_cluster: dict = {}
    for cluster_label, currencies in totals.items():
        out_cur: dict = {}
        for currency_label, agg in currencies.items():
            untrusted = (
                cluster_label == "manual_review" or currency_label == "unknown"
            )
            out_cur[currency_label] = {
                "count": agg["count"],
                "amount": None if untrusted else agg["_raw"],
            }
        totals_by_cluster[cluster_label] = out_cur

    return {
        "period": period_label,
        "windowStart": start_iso,
        "totalsByCluster": totals_by_cluster,
    }


# ─────────────────────────────────────────────────────────────
# 🧪 Dev seed: создаёт N fake paid transactions (для проверки DoD).
# Прячем за admin auth + опциональный флаг.
# ─────────────────────────────────────────────────────────────
@router.post("/api/admin/revenue/_dev_seed_fake")
async def dev_seed_fake_payments(count: int = 3):
    if db is None:
        raise HTTPException(500, "DB not initialised")
    import uuid
    now = _now()
    iso = now.isoformat()
    inserted = []
    samples = [
        {"providerSlug": "avtomaster-pro", "amount": 699,  "productCode": "boost_pro_7d",   "type": "boost"},
        {"providerSlug": "mobile-service-24", "amount": 299, "productCode": "boost_basic_7d", "type": "boost"},
        {"providerSlug": "avtomaster-pro", "amount": 1499, "productCode": "boost_max_7d",   "type": "boost"},
        {"providerSlug": "avtomaster-pro", "amount": 499,  "productCode": "subscription_monthly", "type": "subscription"},
        {"providerSlug": "mobile-service-24", "amount": 200, "productCode": "commission_order", "type": "payment"},
    ]
    for i in range(min(max(count, 1), len(samples))):
        s = samples[i]
        doc = {
            "id": str(uuid.uuid4()),
            "providerSlug": s["providerSlug"],
            "providerId": s["providerSlug"],
            "amount": s["amount"],
            "currency": "UAH",
            "status": "paid",
            "productCode": s["productCode"],
            "type": s["type"],
            "createdAt": iso,
            "source": "dev_seed",
        }
        coll = db.payment_transactions if s["type"] == "payment" else db.provider_purchases
        await coll.insert_one(doc)
        inserted.append({"id": doc["id"], "amount": s["amount"], "type": s["type"], "providerSlug": s["providerSlug"]})
    return {"ok": True, "inserted": inserted, "count": len(inserted)}

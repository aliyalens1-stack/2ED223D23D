"""Inspector-facing timeline projection (P0.b.C.c).

Inspector chronology is **inspection-centric execution timeline**,
not a generic booking timeline. The underlying `booking_timeline`
rows are the same canonical truth as for customer + provider, but
the inspector reads them through a different lens:

  underlying action     →  inspector label
  ────────────────────     ──────────────────
  mark_matched          →  "Осмотр назначен" (NOT "matched to booking")
  mark_in_progress      →  "Осмотр начат"    (NOT "Работа идёт")
  mark_completed        →  "Отчёт отправлен" (NOT "Работа завершена")
  open_dispute          →  "Открыт спор"     (with attention tone)

This file is **separate** from `customer.py` and `provider.py`.
No inheritance, no shared utility, no scope dispatcher. Inspector
semantics will diverge — duplication here is semantic insulation.

Visibility contract (whitelist, not blacklist):

  Inspector SHOULD see:
    * mark_matched      → assigned (job claimed)
    * mark_on_route     → on_route (travel)
    * mark_arrived      → arrived (on_site)
    * mark_in_progress  → inspecting (documenting)
    * mark_completed    → completed (submitted — report dispatched)
    * cancel            → contextual (customer/own/admin label)
    * open_dispute      → dispute_opened (attention)
    * resolve_dispute   → dispute_resolved (closed)

  Inspector MAY see in meta (whitelist — DIFFERENT from provider's):
    * eta                    — own ETA on on_route
    * reason                 — cancel / dispute reason
    * note                   — own milestone note
    * reportId               — surfaces on completion (from reports.submit)
    * inspectorPayoutAmount  — own payout, when explicitly populated.
                               NOT the provider's `payoutAmount`.

  Inspector MUST NEVER see:
    * `*:rejected` rows — no debugging feed; same discipline as
      customer / provider
    * `mark_confirmed` — that's the *provider*'s accept event,
      not the inspector's. Inspector's chronology starts with
      `mark_matched` (= job assigned).
    * platformCut / commission / pricing internals
    * providerCost / payoutAmount (provider-side money — different
      aggregate from inspector payout)
    * refundAmount / refund internals
    * internalNotes / adminNote / moderation comments
    * customerNote (those are notes meant for *provider* surface,
      not inspector)
    * trustScore / fraudFlag / rankingScore (governance signals)
    * admin actor ids
    * other inspector ids (no competitive topology leakage)
    * error / TOCTOU strings

Anti-goals (deliberately rejected):
    ❌ inherit from provider projection
    ❌ shared `_PROJECTION_RENDERER` helper
    ❌ scope-param dispatcher
    ❌ generic safe-meta filter across projections
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


# ─────────────────────────────────────────────────────────────────────
# Visible-actions whitelist.
#
# Labels are inspection-centric, NOT booking-centric, even when the
# underlying canonical action overlaps with provider's whitelist.
# ─────────────────────────────────────────────────────────────────────
_INSPECTOR_VISIBLE_ACTIONS: Dict[str, Dict[str, str]] = {
    "mark_matched": {
        "key": "assigned",
        "label": "Осмотр назначен",
        "description": "Подтвердите и выезжайте.",
        "tone": "ready",
    },
    "mark_on_route": {
        "key": "on_route",
        "label": "В пути на осмотр",
        "description": "Двигайтесь к объекту.",
        "tone": "travel",
    },
    "mark_arrived": {
        "key": "arrived",
        "label": "На месте",
        "description": "Готовьтесь к осмотру.",
        "tone": "on_site",
    },
    "mark_in_progress": {
        "key": "inspecting",
        "label": "Осмотр начат",
        "description": "Проходите чек-лист.",
        "tone": "documenting",
    },
    "mark_completed": {
        "key": "completed",
        "label": "Отчёт отправлен",
        "description": "Осмотр завершён.",
        "tone": "submitted",
    },
    "open_dispute": {
        "key": "dispute_opened",
        "label": "Открыт спор по осмотру",
        "description": "Сохраняйте доказательства.",
        "tone": "attention",
    },
    "resolve_dispute": {
        "key": "dispute_resolved",
        "label": "Спор разрешён",
        "description": "См. решение администрации.",
        "tone": "closed",
    },
    # `cancel` handled contextually below (own / customer / admin /
    # provider). Never one-size-fits-all labelling.
    # `mark_confirmed` deliberately NOT here — provider's commitment
    # is not material to inspector's execution timeline.
}


# Documentation-only mirror of what is hidden. Keep manually in sync.
HIDDEN_FROM_INSPECTOR: List[str] = [
    # Every rejected attempt — non-negotiable hide.
    "mark_matched:rejected",
    "mark_confirmed:rejected",
    "mark_on_route:rejected",
    "mark_arrived:rejected",
    "mark_in_progress:rejected",
    "mark_completed:rejected",
    "cancel:rejected",
    "open_dispute:rejected",
    "resolve_dispute:rejected",
    # Provider-domain event the inspector doesn't need to track.
    "mark_confirmed",
    # Activity-feed noise.
    "provider_viewed_booking",
    "customer_opened_page",
    "system_heartbeat",
    "inspector_opened_page",
]


# ─────────────────────────────────────────────────────────────────────
# Meta-key whitelist for inspector surface.
#
# NOT shared with customer or provider whitelists.
#  - customer whitelist: {reason, eta}
#  - provider whitelist: {eta, reason, payoutAmount, customerNote, note}
#  - inspector whitelist: {eta, reason, note, reportId, inspectorPayoutAmount}
#
# Differences are deliberate:
#   * inspector has `reportId` (their primary deliverable)
#   * inspector has `inspectorPayoutAmount` (separate from provider's
#     `payoutAmount` which is a different aggregate)
#   * inspector does NOT see `customerNote` (those are notes meant
#     for the *provider* surface — buzzer codes, access instructions)
#   * inspector does NOT see provider's `payoutAmount` (cross-actor
#     money topology leakage)
# ─────────────────────────────────────────────────────────────────────
_SAFE_META_KEYS = {
    "eta",                     # own ETA on on_route
    "reason",                  # cancel / dispute reason
    "note",                    # own milestone note
    "reportId",                # primary deliverable, surfaces on completion
    "inspectorPayoutAmount",   # own net payout, when populated explicitly
}


def _sanitize_meta(meta: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Whitelist — anything not listed is silently dropped.

    Future raw fields landing on `booking_timeline.meta` MUST be
    invisible to inspector by default. Surfacing requires deliberate
    listing here AND a snapshot test update.
    """
    if not meta:
        return {}
    out: Dict[str, Any] = {}
    for k, v in meta.items():
        if k not in _SAFE_META_KEYS:
            continue
        if v is None or v == "":
            continue
        out[k] = v
    return out


def _row_belongs_to_inspector(
    row: Dict[str, Any], inspector_ids: List[str]
) -> bool:
    """Is the row's actor THIS inspector?"""
    if row.get("actorRole") != "inspector":
        return False
    actor_id = row.get("actorId")
    return bool(actor_id) and actor_id in inspector_ids


def _render_cancel(
    row: Dict[str, Any], inspector_ids: List[str]
) -> Dict[str, Any]:
    """Cancel is contextual. Inspector needs to know operationally:

      - "Вы отменили выезд"    → own cancellation
      - "Клиент отменил"       → customer side
      - "Провайдер отменил"    → provider side (rare; matters for SLA)
      - "Отменено администрацией" → escalation handled; identity hidden

    Admin actor id NEVER surfaces, even when admin is the source.
    """
    actor_role = row.get("actorRole")
    if _row_belongs_to_inspector(row, inspector_ids):
        return {
            "key": "cancelled",
            "label": "Вы отменили выезд",
            "description": "Заявка снята с вашего исполнения.",
            "tone": "closed",
            "isSelfAction": True,
        }
    if actor_role == "customer":
        return {
            "key": "cancelled",
            "label": "Клиент отменил",
            "description": "Осмотр отменён клиентом.",
            "tone": "attention",
            "isSelfAction": False,
        }
    if actor_role == "provider":
        return {
            "key": "cancelled",
            "label": "Провайдер отменил",
            "description": "Осмотр отменён со стороны провайдера.",
            "tone": "attention",
            "isSelfAction": False,
        }
    # admin or system fallback — DO NOT leak actor identity.
    return {
        "key": "cancelled",
        "label": "Отменено администрацией",
        "description": "Осмотр снят платформой.",
        "tone": "attention",
        "isSelfAction": False,
    }


def project_timeline_for_inspector(
    rows: List[Dict[str, Any]],
    *,
    inspector_ids: List[str],
) -> List[Dict[str, Any]]:
    """Project raw `booking_timeline` rows into the inspector view.

    Args:
        rows: ordered list of timeline rows (chronological ascending).
        inspector_ids: identifiers under which this caller is recorded
            as an inspector (sub / userId / accountId / inspectorId /
            inspectorAccountId). Multi-keyed because legacy
            `inspection_jobs` rows store inspector ownership variably.

    Returns:
        Filtered + relabelled list. Hidden rows are dropped entirely;
        unknown actions are silently dropped (no fallthrough). Sort
        order matches input.

    Output schema (per event):
        {
            "key":          short stable identifier,
            "label":        inspector-facing headline (Russian),
            "description":  secondary line, execution-oriented,
            "tone":         one of {ready, travel, on_site, documenting,
                                    submitted, closed, attention},
            "at":           ISO8601 timestamp string,
            "isSelfAction": bool — was this the inspector themselves?
            "meta":         whitelisted, non-empty values only,
        }
    """
    safe_ids = [pid for pid in inspector_ids if pid]

    out: List[Dict[str, Any]] = []
    for row in rows:
        action = row.get("action") or ""

        # 1. Every rejected attempt — non-negotiable hide.
        if action.endswith(":rejected"):
            continue

        # 2. cancel has its own contextual renderer.
        if action == "cancel":
            rendered = _render_cancel(row, safe_ids)
            out.append({
                **rendered,
                "at": row.get("timestamp"),
                "meta": _sanitize_meta(row.get("meta")),
            })
            continue

        # 3. Anything else must be in the whitelist or it's dropped.
        spec = _INSPECTOR_VISIBLE_ACTIONS.get(action)
        if spec is None:
            # Unknown actions silently dropped — no activity-feed leak.
            continue

        # 4. For inspector's own milestone actions, mark isSelfAction.
        is_self = _row_belongs_to_inspector(row, safe_ids)
        out.append({
            "key": spec["key"],
            "label": spec["label"],
            "description": spec["description"],
            "tone": spec["tone"],
            "at": row.get("timestamp"),
            "isSelfAction": is_self,
            "meta": _sanitize_meta(row.get("meta")),
        })
    return out


__all__ = [
    "project_timeline_for_inspector",
    "HIDDEN_FROM_INSPECTOR",
]

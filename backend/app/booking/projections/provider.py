"""Provider-facing timeline projection (P0.b.C.b).

Provider chronology is an **execution-oriented** view, not a forensic
one. It is INTENTIONALLY different from the customer projection in
both *what is visible* and *how it is worded*.

  Customer chronology  →  calm reassurance ("Готовится к выезду.")
  Provider chronology  →  operational execution ("Готовьтесь к выезду.")

Same chronology, different emotional semantics. This file owns the
provider semantics in full — labels, visibility, tone. We do NOT
share rendering code with `customer.py`. Even where 70% of the
content overlaps today, the two are guaranteed to diverge as the
product matures. Duplication here is *semantic insulation*, not waste.

Visibility contract (whitelist, not blacklist):

  Provider SHOULD see:
    * mark_matched      → "Назначено вам" (assignment received)
    * mark_confirmed    → "Вы приняли заказ"
    * mark_on_route     → "В пути"
    * mark_arrived      → "На месте"
    * mark_in_progress  → "Работа идёт"
    * mark_completed    → "Работа завершена"
    * cancel            → contextual (customer / own / admin)
    * open_dispute      → "Открыт спор. Не закрывайте задачу."
    * resolve_dispute   → "Спор разрешён"

  Provider MAY see in meta (whitelist):
    * eta              — own ETA on on_route
    * reason           — customer's cancel reason / own reason
    * payoutAmount     — own net payout (if explicitly populated)
    * customerNote     — customer-facing note (e.g. "buzzer broken")
    * note             — own note left on a milestone

  Provider MUST NEVER see:
    * `*:rejected` rows — never expose attempt traces
    * platformCut / commission / internal pricing
    * internalNotes / adminNote / moderation comments
    * error / TOCTOU strings
    * trustScore / fraudFlag / fraud heuristics
    * customer trust scoring
    * admin actor ids (admin actions surface, identities don't)
    * `customer_opened_page` / activity-feed noise — unknown actions
       are silently dropped, not "fallen through"

Anti-goals (deliberately rejected):
    ❌ project_timeline(rows, actor="provider") dispatcher
    ❌ shared renderer with customer.py
    ❌ generic visibility matrix / role registry
    ❌ generic safe-meta filter shared across projections

Each actor owns its OWN file. Diverge freely.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


# ─────────────────────────────────────────────────────────────────────
# Visible-actions whitelist.
#
# Each entry is a literal — no inheritance, no templates. Adding a
# new visible action here is a deliberate UX decision.
# ─────────────────────────────────────────────────────────────────────
_PROVIDER_VISIBLE_ACTIONS: Dict[str, Dict[str, str]] = {
    "mark_matched": {
        "key": "matched",
        "label": "Назначено вам",
        "description": "Новая задача. Подтвердите или откажитесь.",
        "tone": "action_required",
    },
    "mark_confirmed": {
        "key": "confirmed",
        "label": "Вы приняли заказ",
        "description": "Готовьтесь к выезду по графику.",
        "tone": "neutral",
    },
    "mark_on_route": {
        "key": "on_route",
        "label": "В пути",
        "description": "Клиент уведомлён.",
        "tone": "in_flight",
    },
    "mark_arrived": {
        "key": "arrived",
        "label": "На месте",
        "description": "Можно приступать к работе.",
        "tone": "in_flight",
    },
    "mark_in_progress": {
        "key": "in_progress",
        "label": "Работа идёт",
        "description": "Зафиксируйте завершение по факту.",
        "tone": "in_flight",
    },
    "mark_completed": {
        "key": "completed",
        "label": "Работа завершена",
        "description": "Ожидается подтверждение и выплата.",
        "tone": "settled",
    },
    "open_dispute": {
        "key": "dispute_opened",
        "label": "Открыт спор",
        "description": "Не закрывайте задачу до решения.",
        "tone": "alert",
    },
    "resolve_dispute": {
        "key": "dispute_resolved",
        "label": "Спор разрешён",
        "description": "См. решение администрации.",
        "tone": "neutral",
    },
    # `cancel` is handled separately — label/description depend on who
    # initiated it (customer / self / admin). See `_render_cancel`.
}


# ─────────────────────────────────────────────────────────────────────
# Documentation-only mirror of what is hidden. Keep manually in sync
# with `_PROVIDER_VISIBLE_ACTIONS` + the FSM. Used by tests.
# ─────────────────────────────────────────────────────────────────────
HIDDEN_FROM_PROVIDER: List[str] = [
    # Every rejected attempt — never surface "we tried X and failed"
    "mark_matched:rejected",
    "mark_confirmed:rejected",
    "mark_on_route:rejected",
    "mark_arrived:rejected",
    "mark_in_progress:rejected",
    "mark_completed:rejected",
    "cancel:rejected",
    "open_dispute:rejected",
    "resolve_dispute:rejected",
    # Activity-feed noise that may leak in via future telemetry
    "provider_viewed_booking",
    "customer_opened_page",
    "system_heartbeat",
]


# ─────────────────────────────────────────────────────────────────────
# Meta-key whitelist for provider surface.
#
# NOT shared with customer projection — provider sees `payoutAmount`
# and `customerNote` which customer never does; customer sees no
# extra fields beyond what they themselves provided.
# ─────────────────────────────────────────────────────────────────────
_SAFE_META_KEYS = {
    "eta",            # own ETA on on_route
    "reason",         # cancel reason (any side)
    "payoutAmount",   # own net payout amount (when populated)
    "customerNote",   # customer-facing note (e.g. "buzzer broken")
    "note",           # own milestone note
}


def _sanitize_meta(meta: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Whitelist — anything not listed is silently dropped.

    A blacklist here would degrade into "forgot to hide one more
    field" entropy. New raw fields on `booking_timeline.meta` MUST be
    invisible to provider by default; surfacing them requires
    explicit listing in `_SAFE_META_KEYS`.
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


def _row_belongs_to_provider(row: Dict[str, Any], provider_ids: List[str]) -> bool:
    """Is the row's actor THIS provider?"""
    if row.get("actorRole") != "provider":
        return False
    actor_id = row.get("actorId")
    return bool(actor_id) and actor_id in provider_ids


def _render_cancel(row: Dict[str, Any], provider_ids: List[str]) -> Dict[str, Any]:
    """Cancel is the only action where label/description depend on
    who initiated. Provider needs to know operationally:

      - "Клиент отменил" → log it, move on
      - "Вы отменили"    → confirmation
      - "Отменено администрацией" → escalation handled; identity hidden

    We never leak the admin actor id even when admin is the source.
    """
    actor_role = row.get("actorRole")
    if _row_belongs_to_provider(row, provider_ids):
        return {
            "key": "cancelled",
            "label": "Вы отменили заказ",
            "description": "Заказ снят с вашего исполнения.",
            "tone": "neutral",
            "isSelfAction": True,
        }
    if actor_role == "customer":
        return {
            "key": "cancelled",
            "label": "Клиент отменил",
            "description": "Заказ снят клиентом.",
            "tone": "neutral",
            "isSelfAction": False,
        }
    # admin or system fallback — DO NOT leak actor identity.
    return {
        "key": "cancelled",
        "label": "Отменено администрацией",
        "description": "Заказ снят платформой.",
        "tone": "alert",
        "isSelfAction": False,
    }


def project_timeline_for_provider(
    rows: List[Dict[str, Any]],
    *,
    provider_ids: List[str],
) -> List[Dict[str, Any]]:
    """Project raw `booking_timeline` rows into the provider view.

    Args:
        rows: ordered list of timeline rows (chronological ascending).
        provider_ids: identifiers that prove "this row's actor is the
            authenticated provider". Pass a list because provider
            ownership is multi-keyed (user id / account id / slug);
            the caller resolves and supplies all relevant ids.

    Returns:
        Filtered + relabelled list. Hidden rows are dropped entirely;
        unknown actions are silently dropped (no fallthrough). Sort
        order matches input.

    Output schema (per event):
        {
            "key":           short stable identifier,
            "label":         provider-facing headline (Russian),
            "description":   secondary line, operational,
            "tone":          one of {action_required, neutral,
                                     in_flight, settled, alert},
            "at":            ISO8601 timestamp string,
            "isSelfAction":  bool — was this the provider themselves?
            "meta":          whitelisted, non-empty values only,
        }
    """
    # Defensive — never trust caller to dedupe / pre-clean.
    safe_ids = [pid for pid in provider_ids if pid]

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
        spec = _PROVIDER_VISIBLE_ACTIONS.get(action)
        if spec is None:
            # Unknown actions silently dropped — no activity-feed leak.
            continue

        # 4. For provider's own milestone actions, mark isSelfAction.
        is_self = _row_belongs_to_provider(row, safe_ids)
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
    "project_timeline_for_provider",
    "HIDDEN_FROM_PROVIDER",
]

"""
backend/app/notifications/customer_kernel.py — Sprint Customer-Notify-1.

Python adapter for the canonical customer-grammar narrative kernel. The
single source of truth for customer-facing notification copy lives in:

    /app/frontend/src/customer-grammar/copy/{en,de,ru}.json

This module loads the SAME JSON files at import time and exposes a
deterministic projector identical in semantics to TypeScript's
`projectNotification(event, lang, channel)` in
`frontend/src/customer-grammar/narrative.ts`. Two layers reading one
table → zero drift.

Roman, 2026-05-14 (Notify-1):
  • allowlist  = strict subset of customer event allowlist
  • channels   = push (ultra-short), email (calm), sms (fallback minimal)
  • forbidden routing: ocr.*, correlation.*, evidence.*, internal.*,
                       suspicion.* → DROP at route stage, before copy lookup
  • channel isolation: missing copy on channel C → DROP on C; NEVER
                       fall back to another channel. SMS especially.

This kernel is consumed by `backend/app/notifications/projector.py` to
render the customer-facing slice of each timeline event. Inspector and
admin notifications continue to use their own internal copy maps —
those are different narrative surfaces and are out of scope for
Customer-Notify-1.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ----- Load shared grammar at import time -----------------------------

# Canonical location of the customer-grammar tables. The path is
# hard-coded to the repo layout — if it ever moves, this constant is
# the single point of update.
_GRAMMAR_DIR = Path("/app/frontend/src/customer-grammar/copy")

SUPPORTED_LANGS: tuple = ("en", "de", "ru")
SUPPORTED_CHANNELS: tuple = ("push", "email", "sms")

# Route-stage deny list — events whose eventType starts with any of
# these prefixes are dropped BEFORE copy lookup. Operational/forensic/
# internal vocabularies that have no place in any customer transport.
FORBIDDEN_ROUTE_PREFIXES: tuple = (
    "ocr.",
    "correlation.",
    "evidence.",
    "internal.",
    "suspicion.",
)

# Strict notification allowlist (mirror of NOTIFICATION_DEEP_LINK in
# narrative.ts). Sprint Customer-Deep-Link-1 rotated this map to its
# current epistemic shape (continuity / timeline / report-cognition).
# The values are loaded from `deep-links.json` so backend and frontend
# share one source — adding a new key here without updating the JSON
# (and every per-channel copy) is a parity-test failure (intentional).
NOTIFICATION_DEEP_LINK: Dict[str, str] = dict(
    (_DEEP_LINKS_RAW := json.loads(Path(
        "/app/frontend/src/customer-grammar/deep-links.json"
    ).read_text(encoding="utf-8"))).get("event_to_surface") or {}
)

ALLOWED_NOTIFICATION_KINDS: frozenset = frozenset(NOTIFICATION_DEEP_LINK.keys())

# Sprint Customer-Deep-Link-1 — semantic destination kernel.
# Loaded once at import from the shared `deep-links.json` so backend
# and frontend resolve identical (surface, params, routes) tuples.
_DEEP_LINKS_PATH = Path("/app/frontend/src/customer-grammar/deep-links.json")


def _load_deep_links() -> Dict[str, Any]:
    try:
        with _DEEP_LINKS_PATH.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as e:
        logger.warning(
            "customer_kernel: failed to load deep-links.json (%s) — "
            "resolve_deep_link will return None for all events", e
        )
        return {}


_DEEP_LINKS: Dict[str, Any] = _load_deep_links()

SURFACES: tuple = tuple(_DEEP_LINKS.get("surfaces") or ())
EVENT_TO_SURFACE: Dict[str, str] = dict(_DEEP_LINKS.get("event_to_surface") or {})
PARAMS_REQUIRED: Dict[str, List[str]] = dict(_DEEP_LINKS.get("params_required") or {})
PARAMS_OPTIONAL: Dict[str, List[str]] = dict(_DEEP_LINKS.get("params_optional") or {})
ROUTES_TABLE: Dict[str, Dict[str, str]] = dict(_DEEP_LINKS.get("routes") or {})


def surface_for(event_type: str) -> Optional[str]:
    """Return the epistemic surface for an event type, or None when
    the event is forbidden-routed or not on the allowlist. Mirror of
    `surfaceFor()` in deep-links.ts."""
    if is_forbidden_route(event_type):
        return None
    return EVENT_TO_SURFACE.get(event_type)


def resolve_deep_link(
    event_type: str,
    metadata: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Resolve `(eventType, metadata)` into a transport-independent
    deep-link payload. Locale-invariant. Returns None when:
      • eventType is forbidden-routed, or
      • eventType is not on the allowlist, or
      • metadata is missing a required param for the resolved surface.

    Mirror of `resolveDeepLink()` in deep-links.ts."""
    from urllib.parse import quote

    surface = surface_for(event_type)
    if not surface:
        return None
    if surface not in ROUTES_TABLE:
        return None

    meta = metadata or {}
    required = PARAMS_REQUIRED.get(surface, [])
    optional = PARAMS_OPTIONAL.get(surface, [])

    params: Dict[str, str] = {}
    for key in required:
        v = meta.get(key)
        if not isinstance(v, str) or not v:
            return None
        params[key] = v
    for key in optional:
        v = meta.get(key)
        if isinstance(v, str) and v:
            params[key] = v

    def bind(tpl: str) -> str:
        out = tpl
        for k in required:
            if k in params:
                out = out.replace("{" + k + "}", quote(params[k], safe=""))
        return out

    mobile = bind(ROUTES_TABLE[surface]["mobile"])
    web = bind(ROUTES_TABLE[surface]["web"])

    if surface == "timeline" and params.get("itemId"):
        focus = f"focus={quote(params['itemId'], safe='')}"
        mobile = mobile + ("&" if "?" in mobile else "?") + focus
        web = web + ("&" if "?" in web else "?") + focus

    return {
        "surface": surface,
        "params": params,
        "routes": {"mobile": mobile, "web": web},
    }


def _load_tables() -> Dict[str, dict]:
    """Read en/de/ru copy tables once at module import. If the file
    is missing or invalid, the kernel becomes inert (every call
    returns None) and logs a warning. We deliberately do NOT raise —
    customer transports must remain available even when grammar is
    temporarily broken; missing copy is the correct silent drop.
    """
    out: Dict[str, dict] = {}
    for lang in SUPPORTED_LANGS:
        path = _GRAMMAR_DIR / f"{lang}.json"
        try:
            with path.open("r", encoding="utf-8") as fh:
                out[lang] = json.load(fh)
        except Exception as e:
            logger.warning(
                "customer_kernel: failed to load %s (%s) — kernel will "
                "DROP all notifications in this locale", path, e
            )
            out[lang] = {}
    return out


_TABLES: Dict[str, dict] = _load_tables()


# ----- Public API -----------------------------------------------------

def normalise_lang(lang: Optional[str]) -> str:
    """Normalise i18n-style tags to one of the three supported locales.
    Unknown → 'de' (platform default). Mirror of narrative.ts logic."""
    if not lang:
        return "de"
    base = str(lang).lower().split("-")[0].split("_")[0]
    if base in SUPPORTED_LANGS:
        return base
    return "de"


def is_forbidden_route(event_type: str) -> bool:
    """Predicate: True iff eventType matches a route-stage deny prefix.
    Pure, hot-path. Callers may use this for telemetry decisions too."""
    if not event_type:
        return False
    for prefix in FORBIDDEN_ROUTE_PREFIXES:
        if event_type.startswith(prefix):
            return True
    return False


def project_customer_notification(
    event_type: str,
    lang: Optional[str] = "de",
    channel: str = "push",
) -> Optional[Dict[str, Any]]:
    """
    Project ONE eventType into ONE notification, for ONE channel and
    ONE locale. Returns None when:

      • event_type is on the forbidden-route list (routing drop), or
      • event_type is not on the notification allowlist (allowlist drop), or
      • there is no curated copy for this (lang, channel) tuple
        (transport-level drop; NEVER falls back to another channel).

    Return shape (when not None):
        {
          "kind":       str,         # canonical event type
          "channel":    str,          # 'push' | 'email' | 'sms'
          "lang":       str,          # 'en' | 'de' | 'ru'
          "title":      str | None,   # None for sms
          "body":       str,
          "deepLink":   str,          # 'timeline' | 'continuity' | 'report'
        }
    """
    # 1. Route-stage deny — drop before any lookup
    if is_forbidden_route(event_type):
        return None

    # 2. Allowlist
    if event_type not in ALLOWED_NOTIFICATION_KINDS:
        return None

    # 3. Channel validation
    if channel not in SUPPORTED_CHANNELS:
        return None

    # 4. Curated copy lookup — NO cross-channel fallback
    lang_n = normalise_lang(lang)
    table = _TABLES.get(lang_n) or {}
    notifications = table.get("notifications") or {}
    per_event = notifications.get(event_type)
    if not isinstance(per_event, dict):
        return None
    copy = per_event.get(channel)
    if not isinstance(copy, dict):
        return None

    body = copy.get("body")
    if not isinstance(body, str) or not body:
        return None

    title = copy.get("title")
    # Channel-shape rule mirrors I9 in parity test:
    #   sms title must be None; push/email title must be a non-empty str.
    if channel == "sms":
        if title is not None:
            # invalid shape — drop defensively
            return None
    else:
        if not isinstance(title, str) or not title:
            return None

    return {
        "kind": event_type,
        "channel": channel,
        "lang": lang_n,
        "title": title,
        "body": body,
        "deepLink": NOTIFICATION_DEEP_LINK[event_type],
    }


def project_all_channels(
    event_type: str,
    lang: Optional[str] = "de",
) -> Dict[str, Optional[Dict[str, Any]]]:
    """Convenience: project the same eventType across all three channels.
    Used by the projector when fanning out push/email/sms in parallel."""
    return {
        ch: project_customer_notification(event_type, lang, ch)
        for ch in SUPPORTED_CHANNELS
    }


def reload_tables() -> None:
    """Test/ops hook to re-read JSON files from disk. Normal runtime
    does NOT call this — the kernel is read-once at import."""
    global _TABLES
    _TABLES = _load_tables()


__all__ = [
    "SUPPORTED_LANGS",
    "SUPPORTED_CHANNELS",
    "FORBIDDEN_ROUTE_PREFIXES",
    "NOTIFICATION_DEEP_LINK",
    "ALLOWED_NOTIFICATION_KINDS",
    "SURFACES",
    "EVENT_TO_SURFACE",
    "ROUTES_TABLE",
    "PARAMS_REQUIRED",
    "PARAMS_OPTIONAL",
    "normalise_lang",
    "is_forbidden_route",
    "project_customer_notification",
    "project_all_channels",
    "surface_for",
    "resolve_deep_link",
    "reload_tables",
]

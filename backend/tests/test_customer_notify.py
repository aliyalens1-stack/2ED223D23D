"""
Sprint Customer-Notify-1 — pytest for the Python customer-grammar kernel.

Verifies that the Python adapter has identical semantics to the
TypeScript `projectNotification(event, lang, channel)` in
`frontend/src/customer-grammar/narrative.ts`. Two layers reading one
table → zero drift.
"""
import pytest

from app.notifications import customer_kernel as ck


# ----- Forbidden routing ------------------------------------------------

@pytest.mark.parametrize(
    "event_type",
    [
        "ocr.vin_detected",
        "ocr.odometer_detected",
        "correlation.spatial_anomaly",
        "evidence.gaps_overridden",
        "internal.audit.replay",
        "suspicion.vin_mismatch",
    ],
)
@pytest.mark.parametrize("lang", ["en", "de", "ru"])
@pytest.mark.parametrize("channel", ["push", "email", "sms"])
def test_forbidden_routing_dropped(event_type, lang, channel):
    """Operational/forensic events MUST be dropped at the routing stage
    on every channel and every locale. No notification body produced."""
    assert ck.is_forbidden_route(event_type) is True
    out = ck.project_customer_notification(event_type, lang=lang, channel=channel)
    assert out is None, f"FORBIDDEN ROUTE LEAK: {event_type} → {out}"


# ----- Allowlist --------------------------------------------------------

ALLOWED = ["inspection.started", "report.submitted", "item.flagged_critical", "item.flagged_warning"]


@pytest.mark.parametrize("event_type", ALLOWED)
@pytest.mark.parametrize("lang", ["en", "de", "ru"])
@pytest.mark.parametrize("channel", ["push", "email", "sms"])
def test_allowed_events_have_copy(event_type, lang, channel):
    """Every (allowed event, lang, channel) tuple has curated copy."""
    out = ck.project_customer_notification(event_type, lang=lang, channel=channel)
    assert out is not None, f"MISSING COPY: {event_type} / {lang} / {channel}"
    assert out["kind"] == event_type
    assert out["channel"] == channel
    assert out["lang"] == lang
    assert isinstance(out["body"], str) and out["body"]
    assert out["deepLink"] in {"continuity", "timeline", "report-cognition"}


@pytest.mark.parametrize("event_type", ALLOWED)
@pytest.mark.parametrize("lang", ["en", "de", "ru"])
def test_sms_title_is_null(event_type, lang):
    """Channel-shape rule: SMS has NO title (carriers have no title concept)."""
    out = ck.project_customer_notification(event_type, lang=lang, channel="sms")
    assert out is not None
    assert out["title"] is None, f"SMS title leak [{lang}/{event_type}]: {out['title']}"


@pytest.mark.parametrize("event_type", ALLOWED)
@pytest.mark.parametrize("lang", ["en", "de", "ru"])
@pytest.mark.parametrize("channel", ["push", "email"])
def test_push_email_title_required(event_type, lang, channel):
    """Channel-shape rule: push and email require non-empty title."""
    out = ck.project_customer_notification(event_type, lang=lang, channel=channel)
    assert out is not None
    assert isinstance(out["title"], str) and out["title"], (
        f"{channel} title missing/empty [{lang}/{event_type}]"
    )


# ----- Channel isolation (no cross-channel fallback) --------------------

@pytest.mark.parametrize("event_type", ALLOWED)
@pytest.mark.parametrize("lang", ["en", "de", "ru"])
def test_channel_bodies_are_distinct(event_type, lang):
    """Roman's I12: push/email/sms bodies for the same event in the same
    locale MUST be distinct strings. Two channels carrying identical
    body is accidental reuse — channel hierarchy collapsing."""
    p = ck.project_customer_notification(event_type, lang=lang, channel="push")
    e = ck.project_customer_notification(event_type, lang=lang, channel="email")
    s = ck.project_customer_notification(event_type, lang=lang, channel="sms")
    assert p is not None and e is not None and s is not None
    assert p["body"] != e["body"], f"push==email body [{lang}/{event_type}]"
    assert p["body"] != s["body"], f"push==sms body  [{lang}/{event_type}]"
    assert e["body"] != s["body"], f"email==sms body [{lang}/{event_type}]"


# ----- Unknown / invalid inputs -----------------------------------------

def test_unknown_event_type_dropped():
    """Events outside the allowlist are dropped silently."""
    assert ck.project_customer_notification("inspection.unknown", "en", "push") is None
    assert ck.project_customer_notification("media.uploaded.vin", "en", "push") is None  # event yes, notification no
    assert ck.project_customer_notification("item.flagged_ok", "en", "push") is None


def test_invalid_channel_dropped():
    """Unsupported channels return None (defensive)."""
    assert ck.project_customer_notification("inspection.started", "en", "telegram") is None
    assert ck.project_customer_notification("inspection.started", "en", "") is None


def test_unknown_lang_falls_back_to_de():
    """Locale normalisation: unknown lang resolves to DE (platform default).
    The notification is still produced because DE has the copy."""
    out = ck.project_customer_notification("inspection.started", "fr-FR", "push")
    assert out is not None
    assert out["lang"] == "de"


def test_locale_tags_normalise():
    """i18n-style tags ('ru-RU', 'de_DE', 'en-US') resolve correctly."""
    for raw, expected in [("ru-RU", "ru"), ("de_DE", "de"), ("en-US", "en"), ("EN", "en"), (None, "de"), ("", "de")]:
        assert ck.normalise_lang(raw) == expected


# ----- Allowlist constants ---------------------------------------------

def test_allowed_kinds_match_deep_link():
    """The ALLOWED_NOTIFICATION_KINDS set MUST match NOTIFICATION_DEEP_LINK
    keys exactly. Drift here means a kind is allowlisted with no
    deep-link policy decided (or vice versa)."""
    assert ck.ALLOWED_NOTIFICATION_KINDS == frozenset(ck.NOTIFICATION_DEEP_LINK.keys())


def test_forbidden_prefixes_are_lower_case():
    """All forbidden prefixes are lowercase + end with a dot. We use
    str.startswith() for matching — a missing dot would over-match."""
    for p in ck.FORBIDDEN_ROUTE_PREFIXES:
        assert p == p.lower()
        assert p.endswith("."), f"prefix {p!r} must end with '.'"


# ----- Lexicon firewall (universal tokens) ------------------------------

UNIVERSAL_FORBIDDEN_LOWER = {
    "ai", "ocr", "hash", "sha256", "override", "overridden", "suspicion",
    "suspicious", "suspect", "algorithm", "algo", "percent",
    "flagged", "flag", "draft", "drafted", "confidence", "probability",
    "accuracy", "urgent", "urgently", "asap", "alarm",
}


def _contains_token(haystack: str, token: str) -> bool:
    """Word-boundary token check matching the JS implementation in
    check-customer-lexicon.mjs. Handles ASCII + Cyrillic + umlauts."""
    h = haystack.lower()
    t = token.lower()
    if not t:
        return False
    idx = 0
    while True:
        i = h.find(t, idx)
        if i == -1:
            return False
        before = h[i - 1] if i > 0 else ""
        after = h[i + len(t)] if i + len(t) < len(h) else ""

        def is_letter(ch: str) -> bool:
            if not ch:
                return False
            if "a" <= ch <= "z":
                return True
            if "äöüß".find(ch) >= 0:
                return True
            code = ord(ch)
            if 0x0400 <= code <= 0x04FF:  # Cyrillic
                return True
            return False

        if not is_letter(before) and not is_letter(after):
            return True
        idx = i + 1


@pytest.mark.parametrize("event_type", ALLOWED)
@pytest.mark.parametrize("lang", ["en", "de", "ru"])
@pytest.mark.parametrize("channel", ["push", "email", "sms"])
def test_no_forbidden_lexicon_in_copy(event_type, lang, channel):
    out = ck.project_customer_notification(event_type, lang=lang, channel=channel)
    assert out is not None
    for field in ("title", "body"):
        val = out.get(field)
        if val is None:
            continue
        for tok in UNIVERSAL_FORBIDDEN_LOWER:
            assert not _contains_token(val, tok), (
                f"LEXICON LEAK [{lang}/{channel}/{event_type}] {field} contains '{tok}': {val!r}"
            )

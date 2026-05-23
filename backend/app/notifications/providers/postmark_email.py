"""
backend/app/notifications/providers/postmark_email.py — Sprint Notify-3B.

DUMB transport adapter for Postmark. Roman 2026-05-15 invariants:

  payload in → provider format out

Forbidden inside this adapter:
  - choosing copy / locale / destination / urgency
  - dynamic prose, conditional sections, marketing slots
  - provider-side templates (no Postmark Templates API)
  - reading channel state, audit, or grammar tables
  - mutating any database collection (lifecycle write lives outside)

Allowed:
  - building deterministic HTML from {title, body, deepLink}
  - HTTP POST to Postmark's /email endpoint
  - parsing response into normalized {ok, providerMessageId, providerStatus, providerError}

Sandbox mode: if POSTMARK_SERVER_TOKEN == "POSTMARK_API_TEST" Postmark
processes the request without actually delivering email. Webhooks are
not fired in sandbox (per docs); for webhook smoke we simulate POSTs.
"""
from __future__ import annotations

import html
import logging
import os
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

POSTMARK_API_BASE = os.environ.get("POSTMARK_API_BASE", "https://api.postmarkapp.com")
PROVIDER_NAME = "postmark"
MESSAGE_STREAM = os.environ.get("POSTMARK_MESSAGE_STREAM", "outbound")
TIMEOUT_SECONDS = 15.0


# ─────────────────────────────────────────────────────────────────────
# Deterministic HTML wrapper
# ─────────────────────────────────────────────────────────────────────
# Strict scope: title + body + button(deepLink) + footer.
# No conditional prose. No channel-specific edits. No marketing.
# Output is identical for identical inputs.

_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="{lang}"><head><meta charset="UTF-8">\
<meta name="viewport" content="width=device-width, initial-scale=1">\
<title>{title_safe}</title></head>\
<body style="margin:0;padding:0;background:#f4f4f6;\
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;\
color:#1f2937;line-height:1.5;">\
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f6;padding:24px 0;">\
<tr><td align="center">\
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" \
style="max-width:560px;background:#ffffff;border-radius:8px;\
box-shadow:0 1px 2px rgba(0,0,0,0.06);">\
<tr><td style="padding:32px 32px 16px 32px;">\
<h1 style="margin:0 0 12px 0;font-size:20px;font-weight:600;color:#111827;">{title_safe}</h1>\
<div style="font-size:15px;color:#374151;white-space:pre-wrap;">{body_safe}</div>\
</td></tr>\
{cta_block}\
<tr><td style="padding:24px 32px 32px 32px;border-top:1px solid #e5e7eb;\
font-size:12px;color:#6b7280;">\
<p style="margin:0;">Transactional notification. Do not reply to this address.</p>\
</td></tr>\
</table></td></tr></table></body></html>"""

_CTA_TEMPLATE = (
    '<tr><td style="padding:0 32px 16px 32px;">'
    '<a href="{href_safe}" style="display:inline-block;padding:12px 22px;'
    'background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;'
    'font-size:14px;font-weight:600;">{cta_text_safe}</a>'
    '</td></tr>'
)


def _build_deterministic_html(
    *, title: str, body: str, lang: str,
    deep_link_href: Optional[str], cta_text: str,
) -> str:
    title_safe = html.escape(str(title or "").strip())
    body_safe = html.escape(str(body or "").strip())
    lang_safe = html.escape(str(lang or "en").strip().split("-")[0])[:5] or "en"
    cta_block = ""
    if deep_link_href:
        cta_block = _CTA_TEMPLATE.format(
            href_safe=html.escape(deep_link_href, quote=True),
            cta_text_safe=html.escape(cta_text or "Open"),
        )
    return _HTML_TEMPLATE.format(
        title_safe=title_safe, body_safe=body_safe,
        lang=lang_safe, cta_block=cta_block,
    )


def _build_text(body: str, deep_link_href: Optional[str]) -> str:
    """Plain-text twin for HtmlBody. Deterministic."""
    text = str(body or "").strip()
    if deep_link_href:
        text = f"{text}\n\n{deep_link_href}"
    return text or " "  # Postmark rejects empty TextBody


# ─────────────────────────────────────────────────────────────────────
# Adapter — send_email
# ─────────────────────────────────────────────────────────────────────

async def send_email(
    *,
    to_address: str,
    subject: str,
    body: str,
    lang: str,
    deep_link_href: Optional[str] = None,
    cta_text: str = "Open",
    metadata: Optional[Dict[str, str]] = None,
    timeout_s: float = TIMEOUT_SECONDS,
) -> Dict[str, Any]:
    """One email send. Returns:
      {ok, providerMessageId, providerStatus, providerError}

    Never raises. All transport / API failures become a `providerStatus`
    string and `providerError` message in the returned dict.
    """
    token = os.environ.get("POSTMARK_SERVER_TOKEN") or "POSTMARK_API_TEST"
    from_email = os.environ.get("POSTMARK_FROM_EMAIL") or "noreply@example.com"
    from_name = os.environ.get("POSTMARK_FROM_NAME") or "Notifications"
    from_field = f"{from_name} <{from_email}>"

    html_body = _build_deterministic_html(
        title=subject, body=body, lang=lang,
        deep_link_href=deep_link_href, cta_text=cta_text,
    )
    text_body = _build_text(body=body, deep_link_href=deep_link_href)

    # Postmark Metadata constraints: max 10 keys, key<=20 chars, value<=80 chars.
    md_clean: Dict[str, str] = {}
    if isinstance(metadata, dict):
        for k, v in list(metadata.items())[:10]:
            ks = str(k)[:20]
            vs = str(v if v is not None else "")[:80]
            if ks:
                md_clean[ks] = vs

    payload: Dict[str, Any] = {
        "From": from_field,
        "To": to_address,
        "Subject": str(subject or "Notification")[:250],
        "HtmlBody": html_body,
        "TextBody": text_body,
        "MessageStream": MESSAGE_STREAM,
        "TrackOpens": False,
        "TrackLinks": "None",
    }
    if md_clean:
        payload["Metadata"] = md_clean

    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": token,
    }
    url = f"{POSTMARK_API_BASE.rstrip('/')}/email"

    try:
        async with httpx.AsyncClient(timeout=timeout_s) as c:
            r = await c.post(url, json=payload, headers=headers)
    except httpx.HTTPError as e:
        logger.warning(f"postmark adapter transport_error: {e}")
        return {
            "ok": False, "providerMessageId": None,
            "providerStatus": "transport_error",
            "providerError": str(e)[:512],
        }

    try:
        body_data = r.json() if r.content else {}
    except Exception:
        body_data = {"_unparseable": True, "_text": r.text[:512]}

    if r.status_code // 100 == 2:
        return {
            "ok": True,
            "providerMessageId": body_data.get("MessageID"),
            # Postmark returns ErrorCode=0 on success.
            "providerStatus": "ok" if body_data.get("ErrorCode", 0) == 0 else "warn",
            "providerError": None,
        }

    err_code = body_data.get("ErrorCode")
    err_msg = body_data.get("Message") or r.text
    logger.warning(f"postmark adapter http_{r.status_code} ErrorCode={err_code} msg={err_msg!r}")
    return {
        "ok": False,
        "providerMessageId": None,
        "providerStatus": f"http_{r.status_code}",
        "providerError": f"[{err_code}] {err_msg}"[:512],
    }


__all__ = ["send_email", "PROVIDER_NAME"]

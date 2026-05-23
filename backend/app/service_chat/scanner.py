"""Sprint 4 — Anti-Bypass Message Scanner.

Цель: не дать пользователям увести коммуникацию в WhatsApp/Telegram/SMS.

Архитектура: пачка regex'ов + ключевые слова + строгая шкала severity.
БЕЗ LLM, БЕЗ ML — детерминированно и дёшево.

Severity:
  clean       — ничего подозрительного
  warn        — есть намёк (внешний URL), сообщение проходит + warning
  shadow_hide — явный контакт (телефон, email, WhatsApp number) — отправитель
                видит, получатель не видит. Это самый эффективный способ:
                bypass-попытка не доходит до жертвы, но виновный думает что всё ок.
  block       — повторный bypass-attempt (после strike) или явный phone в
                первом же сообщении: отказ + предупреждение.

Что ловим:
  - Phone numbers (international, DE/AT/RU/UA/BY local formats)
  - Emails
  - URLs / domains
  - WhatsApp / Telegram / Viber / Signal / Telegram username (@user)
  - "напиши мне в …", "позвони на …", "наберите …"
"""
from __future__ import annotations
import re
from .models import BypassSeverity


# Phone: +49 30 12345678, 030/12345678, 8 (911) 123-45-67, +380 67 ...
# Намеренно жадно — лучше много false-positive чем пропуск.
PHONE_RE = re.compile(
    r"(?:(?:\+|00)\d{1,3}[\s\-.()]*)?"          # optional +49 / 0044
    r"(?:\(?\d{2,4}\)?[\s\-.]*)"                # area code
    r"\d{2,4}[\s\-.]*\d{2,4}[\s\-.]*\d{0,4}"    # rest
)

EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b", re.IGNORECASE)

URL_RE = re.compile(
    r"\b(?:https?://|www\.)\S+\b|"
    r"\b[a-z0-9-]+\.(?:com|de|net|org|ru|ua|by|me|io|app|info|co|biz|live|pro|tg|link)\b",
    re.IGNORECASE,
)

# Telegram username
TG_USER_RE = re.compile(r"@[a-z0-9_]{4,}", re.IGNORECASE)

# Messenger keywords (multilang)
MESSENGER_KW = re.compile(
    r"\b(whatsapp|вотсап|ватсап|whatsap|wa|telegram|телега|телеграм|tg|viber|вибер|signal|сигнал|signl)\b",
    re.IGNORECASE,
)

# «напиши в …» / «позвони на …»
CALL_INTENT_RE = re.compile(
    r"\b(?:напиш\w*|позвон\w*|набер\w*|наберите|связ\w*|call\s+me|text\s+me|"
    r"reach\s+me|hit\s+me|message\s+me|whatsapp\s+me|telegram\s+me)\b",
    re.IGNORECASE,
)


def _strip_phone_false_positives(text: str, matches: list[str]) -> list[str]:
    """Отфильтровать матчи которые на самом деле просто номера сумм / VIN / дат."""
    out: list[str] = []
    for m in matches:
        digits = re.sub(r"\D", "", m)
        if len(digits) < 7:
            continue  # слишком короткое чтобы быть телефоном
        if len(digits) > 15:
            continue  # слишком длинное — скорее VIN/bank-номер
        # Чистая 4-значная дата
        if len(digits) == 4 and 1900 <= int(digits) <= 2100:
            continue
        out.append(m.strip())
    return out


def scan_message(text: str | None) -> dict:
    """Возвращает {severity, kinds, hits, redacted}.

    `redacted` — текст с заменёнными матчами на ●●●●●. Используется когда
    severity=warn (показываем «cleaned» вариант получателю), либо для admin-log.
    """
    if not text:
        return {"severity": "clean", "kinds": [], "hits": [], "redacted": text or ""}

    hits: list[tuple[str, str]] = []
    kinds: set[str] = set()

    # Phones — самое серьёзное
    raw_phones = PHONE_RE.findall(text)
    phones = _strip_phone_false_positives(text, raw_phones)
    if phones:
        kinds.add("phone")
        for p in phones:
            hits.append(("phone", p))

    # Emails
    for m in EMAIL_RE.findall(text):
        kinds.add("email")
        hits.append(("email", m))

    # URLs
    for m in URL_RE.findall(text):
        kinds.add("url")
        hits.append(("url", m))

    # Telegram @username
    for m in TG_USER_RE.findall(text):
        kinds.add("telegram_user")
        hits.append(("telegram_user", m))

    # Messenger keywords
    msg_hits = MESSENGER_KW.findall(text)
    if msg_hits:
        kinds.add("messenger_kw")
        for h in msg_hits:
            hits.append(("messenger_kw", h))

    # Call intent
    if CALL_INTENT_RE.search(text):
        kinds.add("call_intent")

    # ── Severity escalation ───────────────────────────────────────────
    # phone + email = жёсткий bypass attempt → shadow_hide
    # phone alone, или email alone = shadow_hide
    # messenger keyword + call intent = shadow_hide
    # просто URL без других сигналов = warn (могут быть фото авто)
    # telegram_user alone = shadow_hide
    severity: BypassSeverity = "clean"
    if "phone" in kinds or "email" in kinds or "telegram_user" in kinds:
        severity = "shadow_hide"
    elif "messenger_kw" in kinds and "call_intent" in kinds:
        severity = "shadow_hide"
    elif "messenger_kw" in kinds or "call_intent" in kinds:
        severity = "warn"
    elif "url" in kinds:
        severity = "warn"

    # Redacted text для логов / получателя
    redacted = text
    for kind, val in hits:
        redacted = redacted.replace(val, "●●●●●")

    return {
        "severity": severity,
        "kinds": sorted(list(kinds)),
        "hits": [{"kind": k, "value": v[:80]} for k, v in hits[:10]],
        "redacted": redacted,
    }

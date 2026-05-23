"""OCR-1 — VIN + Odometer OCR (server-side, vision LLM).

Narrow scope by design:
  • VIN: 17-char alphanumeric (ISO 3779) — never contains I, O, Q.
  • Odometer: integer kilometers (or miles, but we coerce to km).
  • No damage AI, no paint/panel CV, no auto-verdicts.

Inputs: base64-encoded image already on the backend (from the existing
inspection media upload). Output: candidate string + confidence in [0, 1].

Failure is silent — OCR never blocks a media upload. The inspector can
still capture the photo and manually enter the value.
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from typing import Literal, Optional

logger = logging.getLogger(__name__)

# Single canonical model choice: cheap, fast, vision-capable.
# Decided per inspector OS roadmap (OCR-1 sprint) — see
# memory/ocr1_vin_odometer_2026_05_14.md.
_OCR_PROVIDER = "gemini"
_OCR_MODEL = "gemini-2.5-flash"

# ISO 3779 forbids I, O, Q in VIN positions.
_VIN_CHAR_SET = set("ABCDEFGHJKLMNPRSTUVWXYZ0123456789")
_VIN_RE = re.compile(r"[A-HJ-NPR-Z0-9]{17}")


def _validate_vin(raw: str) -> Optional[str]:
    """Return canonical 17-char VIN or None. Accepts surrounding noise."""
    if not raw:
        return None
    cleaned = raw.upper().replace(" ", "").replace("-", "")
    # Replace common confusables that humans/OCR may emit
    cleaned = cleaned.replace("O", "0").replace("I", "1").replace("Q", "0")
    m = _VIN_RE.search(cleaned)
    if not m:
        return None
    vin = m.group(0)
    if not all(c in _VIN_CHAR_SET for c in vin):
        return None
    return vin


def _parse_odometer(raw: str) -> Optional[int]:
    """Pull an integer odometer reading. Accepts '92,400 km' / '92400' / '92 400'."""
    if not raw:
        return None
    digits = re.sub(r"[^0-9]", "", raw)
    if not digits:
        return None
    try:
        val = int(digits)
    except ValueError:
        return None
    # Sanity bounds — odometers are 0–999,999 in practice
    if val < 0 or val > 1_500_000:
        return None
    return val


_VIN_PROMPT = (
    "You are an OCR engine. The image shows a vehicle identification number "
    "(VIN) plate or sticker. Return ONLY a JSON object with two keys:\n"
    '  {"candidate": "<17-char VIN, no spaces>", "confidence": <float 0-1>}\n'
    "Rules:\n"
    "  - VIN is exactly 17 alphanumeric characters.\n"
    "  - VIN never contains the letters I, O, or Q.\n"
    '  - If you cannot read it confidently, return {"candidate": "", "confidence": 0}.\n'
    "  - No prose, no markdown, JSON only."
)

_ODO_PROMPT = (
    "You are an OCR engine. The image shows a vehicle odometer cluster. "
    "Return ONLY a JSON object with three keys:\n"
    '  {"candidate": "<integer km>", "confidence": <float 0-1>, "unit": "km"|"mi"}\n'
    "Rules:\n"
    "  - Return the total kilometer reading as an integer string (no commas).\n"
    "  - If the display is in miles, set unit to 'mi' and return the miles integer.\n"
    '  - If you cannot read it confidently, return {"candidate": "", "confidence": 0, "unit": "km"}.\n'
    "  - No prose, no markdown, JSON only."
)


async def run_ocr(
    image_base64: str,
    kind: Literal["vin", "odometer"],
    *,
    mime: str = "image/jpeg",
) -> Optional[dict]:
    """Run vision LLM OCR. Returns dict or None on failure.

    Returns:
      For vin:      {"kind": "vin", "candidate": "...", "confidence": 0..1, "raw": "..."}
      For odometer: {"kind": "odometer", "candidate": "92400", "confidence": 0..1,
                     "unit": "km"|"mi", "raw": "..."}
      None if OCR provider unavailable or returns unparseable output.
    """
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        logger.warning("[ocr] EMERGENT_LLM_KEY not set — OCR disabled")
        return None
    if not image_base64:
        return None

    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent
    except ImportError as e:
        logger.warning(f"[ocr] emergentintegrations import failed: {e}")
        return None

    prompt = _VIN_PROMPT if kind == "vin" else _ODO_PROMPT
    try:
        chat = LlmChat(
            api_key=api_key,
            session_id=f"ocr-{kind}-{uuid.uuid4().hex[:8]}",
            system_message=prompt,
        ).with_model(_OCR_PROVIDER, _OCR_MODEL)
        msg = UserMessage(
            text=f"Extract the {kind} and respond with JSON only.",
            file_contents=[ImageContent(image_base64=image_base64)],
        )
        raw = await chat.send_message(msg)
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[ocr] {kind} LLM call failed: {exc}")
        return None

    raw_text = str(raw).strip()
    # Tolerate markdown code fences just in case the model adds them
    if raw_text.startswith("```"):
        raw_text = raw_text.strip("`")
        if raw_text.startswith("json"):
            raw_text = raw_text[4:]
        raw_text = raw_text.strip()

    try:
        parsed = json.loads(raw_text)
    except Exception:
        # Try to find a JSON object in the response
        m = re.search(r"\{[^{}]*\}", raw_text)
        if not m:
            logger.warning(f"[ocr] {kind} unparseable response: {raw_text[:120]!r}")
            return None
        try:
            parsed = json.loads(m.group(0))
        except Exception:
            return None

    cand_raw = str(parsed.get("candidate", "") or "")
    try:
        conf = float(parsed.get("confidence", 0) or 0)
    except (TypeError, ValueError):
        conf = 0.0
    conf = max(0.0, min(1.0, conf))

    if kind == "vin":
        vin = _validate_vin(cand_raw)
        if not vin:
            # Treat as low-confidence with empty candidate so UI can show "couldn't read"
            return {"kind": "vin", "candidate": "", "confidence": 0.0, "raw": raw_text[:200]}
        return {"kind": "vin", "candidate": vin, "confidence": conf, "raw": raw_text[:200]}

    # odometer
    val = _parse_odometer(cand_raw)
    unit = (parsed.get("unit") or "km").lower()
    if unit not in ("km", "mi"):
        unit = "km"
    if val is None:
        return {"kind": "odometer", "candidate": "", "confidence": 0.0,
                "unit": unit, "raw": raw_text[:200]}
    # Coerce miles → km for downstream consistency
    if unit == "mi":
        val_km = int(round(val * 1.609344))
    else:
        val_km = val
    return {
        "kind": "odometer",
        "candidate": str(val_km),
        "candidateUnit": "km",
        "rawValue": val,
        "rawUnit": unit,
        "confidence": conf,
        "raw": raw_text[:200],
    }

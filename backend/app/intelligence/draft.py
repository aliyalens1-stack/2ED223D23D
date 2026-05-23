"""Draft synthesis pipeline (Sprint 2 Step 4).

Pipeline:
  1. detect_contradictions(runtime, checklist)          — deterministic
  2. detect_missing_evidence(runtime, media, checklist) — deterministic
  3. compute_confidence(deterministic_signals)          — deterministic
  4. synthesize_report(...) — Claude Sonnet 4.5 (12s timeout) + sanitize
  5. persist into `inspection_drafts`
  6. emit timeline event (draft_generated / draft_flagged)

LLM failure is NEVER fatal: deterministic fallback always produces a valid
draft object.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("server")

# ─────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────
LLM_PROVIDER = "anthropic"
LLM_MODEL = "claude-sonnet-4-5-20250929"
LLM_TIMEOUT_SEC = 12.0
DRAFT_VERSION = "1"

VERDICT_VALUES = ("recommended", "risky", "not_recommended")
CONFIDENCE_VALUES = ("low", "medium", "high")
SEVERITY_VALUES = ("info", "ok", "warning", "critical", "problem", "not_checked")

NO_ISSUES_PHRASES = (
    "без замечаний",
    "no issues",
    "all good",
    "all ok",
    "ничего не найдено",
    "all fine",
)

REQUIRED_ITEM_KEYS = ("vin", "odometer")


# ─────────────────────────────────────────────────────────────────────
# Deterministic checks
# ─────────────────────────────────────────────────────────────────────
def _iter_checklist(checklist: Any) -> List[Dict[str, Any]]:
    if isinstance(checklist, dict):
        items = checklist.get("items") or []
        if isinstance(items, list):
            return [i for i in items if isinstance(i, dict)]
        return []
    if isinstance(checklist, list):
        return [i for i in checklist if isinstance(i, dict)]
    return []


def _severity(item: Dict[str, Any]) -> str:
    sev = (item.get("severity") or item.get("status") or "").lower()
    return sev if sev in SEVERITY_VALUES else "not_checked"


def _paint_value(item: Dict[str, Any]) -> Optional[float]:
    """Try to extract paint-depth value (µm) from common keys."""
    for k in ("paintDepth", "paint_depth", "value", "paintMicrons", "thicknessUm"):
        v = item.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    # Fall back to parsing the note string for a "NNN µm" pattern
    note = item.get("note") or ""
    if isinstance(note, str):
        m = re.search(r"(\d{2,4})\s*µ?m", note)
        if m:
            try:
                return float(m.group(1))
            except Exception:
                pass
    return None


def detect_contradictions(
    runtime_state: Dict[str, Any],
    checklist: Any,
    summary: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Return canonical contradiction records [{code, itemKey, message, severity}].

    Examples encoded:
      • paint depth > 500 µm but severity = ok        → paint_depth_conflict
      • severity = critical but no note / comment     → critical_without_note
      • critical item AND summary uses "no issues"    → summary_severity_conflict
      • verdict=recommended but any critical present  → verdict_severity_conflict
                                                       (raised by caller, not here)
    """
    out: List[Dict[str, Any]] = []
    items = _iter_checklist(checklist) or _iter_checklist(runtime_state.get("checklist"))

    has_critical = False
    summary_lc = (summary or "").lower()

    for item in items:
        key = item.get("key") or item.get("itemKey") or "item"
        sev = _severity(item)
        if sev == "critical":
            has_critical = True

        paint = _paint_value(item)
        if paint is not None:
            if paint >= 500 and sev in {"ok", "info", "not_checked"}:
                out.append({
                    "code": "paint_depth_conflict",
                    "itemKey": key,
                    "message": f"Толщина ЛКП {paint:.0f} µm, но severity={sev}. Возможно перекрас.",
                    "severity": "warning",
                })
            if paint >= 300 and paint < 500 and sev == "ok":
                out.append({
                    "code": "paint_depth_borderline",
                    "itemKey": key,
                    "message": f"Толщина ЛКП {paint:.0f} µm — пограничное значение для severity=ok.",
                    "severity": "info",
                })

        # critical without note → low evidence
        note = (item.get("note") or item.get("comment") or "").strip()
        if sev == "critical" and not note:
            out.append({
                "code": "critical_without_note",
                "itemKey": key,
                "message": f"{key}: severity=critical, но комментарий пуст.",
                "severity": "warning",
            })

    # Summary vs severity
    if has_critical and any(p in summary_lc for p in NO_ISSUES_PHRASES):
        out.append({
            "code": "summary_severity_conflict",
            "itemKey": "summary",
            "message": "В отчёте есть критичные пункты, но summary говорит 'без замечаний'.",
            "severity": "warning",
        })

    return out


def detect_missing_evidence(
    runtime_state: Dict[str, Any],
    media: List[Dict[str, Any]],
    checklist: Any,
) -> List[Dict[str, Any]]:
    """Return canonical missing-evidence records [{itemKey, reason, severity}]."""
    out: List[Dict[str, Any]] = []
    items = _iter_checklist(checklist) or _iter_checklist(runtime_state.get("checklist"))
    media_items = media if isinstance(media, list) else []
    media_count = len(media_items)

    # Build (sectionKey, itemKey) → present? from media records
    media_keys = set()
    media_sections = set()
    media_categories = set()
    for m in media_items:
        if isinstance(m, dict):
            if m.get("sectionKey") and m.get("itemKey"):
                media_keys.add((m["sectionKey"], m["itemKey"]))
            if m.get("sectionKey"):
                media_sections.add(m["sectionKey"])
            if m.get("category"):
                media_categories.add(m["category"])

    # Rule 1 — warning/critical items without any photo
    for item in items:
        key = item.get("key") or item.get("itemKey")
        sev = _severity(item)
        if not key:
            continue
        section = item.get("sectionKey") or item.get("section") or ""
        has_photo = (
            (section, key) in media_keys
            or key in media_categories
            or section in media_sections
        )
        if sev in {"warning", "critical", "problem"} and not has_photo:
            out.append({
                "itemKey": key,
                "reason": "photo_required",
                "severity": "warning",
                "message": f"Severity={sev}, но фото для подтверждения отсутствует.",
            })
        # Required items untouched
        if (key in REQUIRED_ITEM_KEYS) and sev == "not_checked":
            out.append({
                "itemKey": key,
                "reason": "required_not_checked",
                "severity": "warning",
                "message": f"Обязательный пункт '{key}' не проверен.",
            })

    # Rule 2 — no test-drive media
    if not any(m.get("category") == "test_drive" or m.get("sectionKey") == "test_drive" for m in media_items):
        out.append({
            "itemKey": "test_drive",
            "reason": "no_testdrive_media",
            "severity": "info",
            "message": "Нет медиа из тест-драйва.",
        })

    # Rule 3 — too few photos overall
    if media_count < 8:
        out.append({
            "itemKey": "media_total",
            "reason": "too_few_photos",
            "severity": "info",
            "message": f"Всего {media_count} файлов — обычно делают ≥ 8.",
        })

    return out


def compute_confidence(
    contradictions: List[Dict[str, Any]],
    missing: List[Dict[str, Any]],
    checklist: Any,
    media_count: int,
) -> str:
    """Heuristic confidence — used both as standalone signal and as guidance
    to the LLM. The LLM may override but we keep a safe deterministic floor."""
    items = _iter_checklist(checklist)
    checked = sum(1 for i in items if _severity(i) not in {"not_checked", ""})
    coverage = (checked / max(1, len(items))) if items else 0

    score = 100
    score -= 12 * sum(1 for c in contradictions if c.get("severity") == "warning")
    score -= 6 * sum(1 for m in missing if m.get("severity") == "warning")
    score -= 3 * sum(1 for m in missing if m.get("severity") == "info")
    score += 20 * (coverage - 0.5)
    score += min(15, media_count)  # cap +15 from media volume

    if score >= 75:
        return "high"
    if score >= 45:
        return "medium"
    return "low"


def _severity_distribution(checklist: Any) -> Dict[str, int]:
    dist = {k: 0 for k in SEVERITY_VALUES}
    for item in _iter_checklist(checklist):
        sev = _severity(item)
        dist[sev] = dist.get(sev, 0) + 1
    return dist


def _deterministic_verdict(dist: Dict[str, int]) -> str:
    if dist.get("critical", 0) >= 1 or dist.get("problem", 0) >= 3:
        return "not_recommended"
    if dist.get("warning", 0) >= 2 or dist.get("problem", 0) >= 1:
        return "risky"
    return "recommended"


def _deterministic_score(dist: Dict[str, int]) -> int:
    score = 100
    score -= 30 * dist.get("critical", 0)
    score -= 12 * dist.get("problem", 0)
    score -= 6 * dist.get("warning", 0)
    score -= 1 * dist.get("not_checked", 0)
    return max(0, min(100, score))


def _deterministic_top_problems(checklist: Any, limit: int = 5) -> List[Dict[str, Any]]:
    sev_rank = {"critical": 4, "problem": 3, "warning": 2, "info": 1, "ok": 0, "not_checked": 0}
    items = _iter_checklist(checklist)
    ranked = sorted(items, key=lambda i: sev_rank.get(_severity(i), 0), reverse=True)
    out = []
    for it in ranked[:limit]:
        if sev_rank.get(_severity(it), 0) < 2:
            break
        out.append({
            "itemKey": it.get("key") or it.get("itemKey") or "unknown",
            "severity": _severity(it),
            "note": (it.get("note") or it.get("comment") or "").strip()[:140],
        })
    return out


def _deterministic_summary(
    verdict: str, dist: Dict[str, int], top: List[Dict[str, Any]], vehicle: Dict[str, Any],
) -> str:
    brand = (vehicle or {}).get("brand") or ""
    model = (vehicle or {}).get("model") or ""
    name = f"{brand} {model}".strip() or "автомобиль"
    if verdict == "not_recommended":
        head = f"{name}: серьёзные дефекты — покупка не рекомендуется"
    elif verdict == "risky":
        head = f"{name}: есть значимые недостатки — покупка с риском"
    else:
        head = f"{name}: критичных проблем не выявлено"
    if top:
        problems = "; ".join(f"{p['itemKey']} ({p['severity']})" for p in top)
        return f"{head}. Основные пункты внимания: {problems}."
    return f"{head}. Все проверенные пункты в норме."


# ─────────────────────────────────────────────────────────────────────
# LLM synthesis
# ─────────────────────────────────────────────────────────────────────
_SYSTEM_PROMPT = (
    "Ты — ассистент инспектора подержанных автомобилей. "
    "Получив выжимку проверки (severity по пунктам, медиа-стат, противоречия, "
    "пропущенные доказательства, базовую инфу о машине), верни СТРОГО валидный JSON "
    "по схеме (без объяснений снаружи):\n"
    '{"verdict":"recommended|risky|not_recommended",'
    '"score":0-100,'
    '"confidence":"low|medium|high",'
    '"summary":"одна-две предложения для клиента",'
    '"topProblems":[{"itemKey":"","severity":"","note":""}],'
    '"recommendedActions":["короткие пункты"],'
    '"reasoning":"одна фраза почему такой verdict"}\n'
    "Правила:\n"
    " - Если есть критичный пункт → verdict=not_recommended; score ≤ 40.\n"
    " - Если 2+ warning или 1+ problem → verdict=risky; score 40-69.\n"
    " - Иначе → verdict=recommended; score ≥ 70.\n"
    " - confidence снижай при пропущенных доказательствах и противоречиях.\n"
    " - Никогда не пиши 'AI решил' и подобное. Тон: ассистент, не финальный судья.\n"
    " - summary — на языке инспектора (RU), без эмодзи, без markdown."
)


def _build_user_prompt(payload: Dict[str, Any]) -> str:
    """Compact representation that fits in <2k tokens."""
    return json.dumps(payload, ensure_ascii=False, default=str)


_JSON_FENCE = re.compile(r"^```(?:json)?\s*(.+?)\s*```$", re.DOTALL | re.IGNORECASE)


def _strip_fences(text: str) -> str:
    text = text.strip()
    m = _JSON_FENCE.match(text)
    if m:
        return m.group(1).strip()
    return text


def _safe_parse_llm_json(raw: str) -> Optional[Dict[str, Any]]:
    if not raw:
        return None
    cleaned = _strip_fences(raw)
    # Find the first balanced { ... }
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    candidate = cleaned[start: end + 1]
    try:
        return json.loads(candidate)
    except Exception:
        return None


def _sanitize_llm_draft(parsed: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Normalise / guard the LLM output."""
    if not isinstance(parsed, dict):
        return {}
    verdict = (parsed.get("verdict") or "").lower()
    if verdict not in VERDICT_VALUES:
        verdict = ""
    confidence = (parsed.get("confidence") or "").lower()
    if confidence not in CONFIDENCE_VALUES:
        confidence = ""

    raw_score = parsed.get("score")
    score: Optional[int] = None
    if isinstance(raw_score, (int, float)):
        score = max(0, min(100, int(raw_score)))

    summary = parsed.get("summary")
    if not isinstance(summary, str):
        summary = ""
    summary = summary.strip()[:1200]

    top: List[Dict[str, Any]] = []
    raw_top = parsed.get("topProblems")
    if isinstance(raw_top, list):
        for item in raw_top[:10]:
            if isinstance(item, dict) and item.get("itemKey"):
                top.append({
                    "itemKey": str(item.get("itemKey"))[:64],
                    "severity": str(item.get("severity") or "")[:24],
                    "note": str(item.get("note") or "")[:240],
                })

    actions: List[str] = []
    raw_actions = parsed.get("recommendedActions")
    if isinstance(raw_actions, list):
        for a in raw_actions[:8]:
            if isinstance(a, str) and a.strip():
                actions.append(a.strip()[:200])

    reasoning = parsed.get("reasoning")
    if not isinstance(reasoning, str):
        reasoning = ""
    reasoning = reasoning.strip()[:400]

    out = {
        "verdict": verdict,
        "score": score,
        "confidence": confidence,
        "summary": summary,
        "topProblems": top,
        "recommendedActions": actions,
        "reasoning": reasoning,
    }
    return {k: v for k, v in out.items() if v not in (None, "", [])}


async def _call_claude(prompt_payload: Dict[str, Any]) -> tuple[Optional[Dict[str, Any]], float, Optional[str]]:
    """Returns (sanitized_draft_or_None, latency_seconds, error_or_None)."""
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        return None, 0.0, "EMERGENT_LLM_KEY not configured"

    started = time.perf_counter()
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage

        chat = (
            LlmChat(
                api_key=api_key,
                session_id=f"draft_{prompt_payload.get('jobId', 'unknown')}_{int(started * 1000)}",
                system_message=_SYSTEM_PROMPT,
            )
            .with_model(LLM_PROVIDER, LLM_MODEL)
        )
        msg = UserMessage(text=_build_user_prompt(prompt_payload))
        raw = await asyncio.wait_for(chat.send_message(msg), timeout=LLM_TIMEOUT_SEC)
        latency = time.perf_counter() - started
        parsed = _safe_parse_llm_json(raw if isinstance(raw, str) else str(raw))
        sanitized = _sanitize_llm_draft(parsed)
        if not sanitized.get("verdict"):
            return None, latency, "llm_output_unusable"
        return sanitized, latency, None
    except asyncio.TimeoutError:
        return None, time.perf_counter() - started, f"timeout>{LLM_TIMEOUT_SEC}s"
    except Exception as e:
        logger.exception("Claude draft synthesis failed")
        return None, time.perf_counter() - started, str(e)[:200]


# ─────────────────────────────────────────────────────────────────────
# Main entry — synthesize & persist
# ─────────────────────────────────────────────────────────────────────
async def synthesize_report(
    *,
    job: Dict[str, Any],
    runtime_state: Dict[str, Any],
    media: List[Dict[str, Any]],
    vehicle: Dict[str, Any],
    inspector_id: str,
) -> Dict[str, Any]:
    """Produce a draft. Returns the canonical draft payload."""
    checklist = runtime_state.get("checklist") if isinstance(runtime_state, dict) else None
    if not checklist:
        checklist = runtime_state.get("checklistItems") if isinstance(runtime_state, dict) else None
    summary_hint = (runtime_state or {}).get("summary")

    # 1-3 deterministic
    contradictions = detect_contradictions(runtime_state or {}, checklist, summary=summary_hint)
    missing = detect_missing_evidence(runtime_state or {}, media, checklist)
    media_count = len(media) if isinstance(media, list) else 0
    confidence_det = compute_confidence(contradictions, missing, checklist, media_count)
    dist = _severity_distribution(checklist)

    # Deterministic fallback values
    det_verdict = _deterministic_verdict(dist)
    det_score = _deterministic_score(dist)
    det_top = _deterministic_top_problems(checklist)
    det_summary = _deterministic_summary(det_verdict, dist, det_top, vehicle or {})

    # 4 — LLM
    prompt_payload = {
        "jobId": str(job.get("_id") or job.get("id")),
        "vehicle": {
            "brand": (vehicle or {}).get("brand"),
            "model": (vehicle or {}).get("model"),
            "year": (vehicle or {}).get("year"),
            "vin": (vehicle or {}).get("vin"),
        },
        "severityDistribution": dist,
        "deterministic": {
            "verdict": det_verdict,
            "score": det_score,
            "confidence": confidence_det,
            "topProblems": det_top,
        },
        "checklistSummary": [
            {
                "key": it.get("key") or it.get("itemKey"),
                "severity": _severity(it),
                "note": (it.get("note") or it.get("comment") or "")[:140],
                "paint": _paint_value(it),
            }
            for it in _iter_checklist(checklist)[:60]
        ],
        "contradictions": contradictions,
        "missingEvidence": missing,
        "mediaCount": media_count,
        "mediaBySection": _media_section_counts(media),
        "summaryHint": (summary_hint or "")[:500],
    }
    llm_out, latency, err = await _call_claude(prompt_payload)

    # 5 — merge with fallback
    verdict = (llm_out or {}).get("verdict") or det_verdict
    score = (llm_out or {}).get("score")
    if score is None:
        score = det_score
    confidence = (llm_out or {}).get("confidence") or confidence_det
    summary = (llm_out or {}).get("summary") or det_summary
    top_problems = (llm_out or {}).get("topProblems") or det_top
    actions = (llm_out or {}).get("recommendedActions") or []
    reasoning = (llm_out or {}).get("reasoning") or ""

    # Safety floors: never let LLM upgrade a critical case to "recommended"
    if dist.get("critical", 0) >= 1 and verdict == "recommended":
        verdict = "risky" if det_verdict == "risky" else "not_recommended"

    draft_id = f"draft_{uuid.uuid4().hex[:24]}"
    generated_at = datetime.now(timezone.utc).isoformat()

    draft = {
        "_id": draft_id,
        "id": draft_id,
        "version": DRAFT_VERSION,
        "jobId": str(job.get("_id") or job.get("id")),
        "requestId": job.get("requestId"),
        "vehicleId": job.get("vehicleId"),
        "inspectorId": inspector_id,
        "verdict": verdict,
        "score": int(score),
        "confidence": confidence,
        "summary": summary,
        "topProblems": top_problems,
        "contradictions": contradictions,
        "missingEvidence": missing,
        "recommendedActions": actions,
        "reasoning": reasoning,
        "inspectorEditable": {"summary": True, "verdict": True, "score": True},
        "ai": {
            "model": LLM_MODEL,
            "provider": LLM_PROVIDER,
            "latencyMs": int(latency * 1000),
            "ok": err is None,
            "error": err,
            "rawAvailable": llm_out is not None,
        },
        "input": {
            "snapshotAt": generated_at,
            "mediaCount": media_count,
            "severityDistribution": dist,
        },
        "generatedAt": generated_at,
    }

    # 6 — persist
    try:
        from app.core.db import get_db
        await get_db().inspection_drafts.insert_one(draft)
    except Exception:
        logger.exception("inspection_drafts insert failed (non-fatal)")

    # 7 — timeline
    try:
        from app.inspector.timeline import append_event
        kind = "draft_flagged" if contradictions or missing else "draft_generated"
        sev = "warning" if contradictions else "info"
        parent_req_user_id = None
        try:
            from app.core.db import get_db
            db = get_db()
            req = await db.car_requests.find_one(
                {"_id": job.get("requestId")}, {"_id": 0, "userId": 1}
            )
            parent_req_user_id = (req or {}).get("userId")
        except Exception:
            pass
        await append_event(
            kind=kind,
            job_id=str(job.get("_id") or job.get("id")),
            vehicle_id=job.get("vehicleId"),
            inspector_id=inspector_id,
            customer_id=parent_req_user_id,
            actor_type="system",
            actor_id="intelligence",
            actor_label="AI Draft",
            severity=sev,
            title="Черновик сформирован" if kind == "draft_generated" else "Найдены противоречия",
            text=f"verdict={verdict} · score={score} · confidence={confidence}",
            metadata={
                "draftId": draft_id,
                "verdict": verdict,
                "score": int(score),
                "confidence": confidence,
                "contradictionsCount": len(contradictions),
                "missingEvidenceCount": len(missing),
                "llmOk": err is None,
            },
            stable_key=draft_id,
        )
    except Exception:
        logger.debug("timeline emit (draft) failed", exc_info=True)

    # Strip the Mongo _id from the response
    return {k: v for k, v in draft.items() if k != "_id"}


def _media_section_counts(media: List[Dict[str, Any]]) -> Dict[str, int]:
    by: Dict[str, int] = {}
    for m in media or []:
        if not isinstance(m, dict):
            continue
        sec = m.get("sectionKey") or m.get("category") or "uncategorized"
        by[sec] = by.get(sec, 0) + 1
    return by


# ─────────────────────────────────────────────────────────────────────
# Override-logging helper (called from reports.submit_report)
# ─────────────────────────────────────────────────────────────────────
async def log_ai_overrides(
    *,
    draft_id: Optional[str],
    job_id: str,
    report_id: str,
    inspector_id: str,
    submitted: Dict[str, Any],
) -> int:
    """Compare submitted report vs the draft and write delta rows to
    `ai_overrides_log`. Returns the number of overrides logged.
    """
    if not draft_id:
        return 0
    try:
        from app.core.db import get_db
        db = get_db()
        draft = await db.inspection_drafts.find_one({"_id": draft_id})
        if not draft:
            return 0
        comparisons = [
            ("verdict",  draft.get("verdict"),   submitted.get("verdict")),
            ("score",    draft.get("score"),     submitted.get("score")),
            ("summary",  (draft.get("summary") or "").strip(),
                          (submitted.get("summary") or "").strip()),
        ]
        rows = []
        now_iso = datetime.now(timezone.utc).isoformat()
        for field, ai_val, human_val in comparisons:
            if ai_val is None:
                continue
            if isinstance(ai_val, str) and isinstance(human_val, str):
                same = ai_val.strip() == human_val.strip()
            else:
                same = ai_val == human_val
            if same:
                continue
            rid = f"ovr_{draft_id}_{field}"
            rows.append({
                "_id": rid,
                "id": rid,
                "draftId": draft_id,
                "jobId": job_id,
                "reportId": report_id,
                "inspectorId": inspector_id,
                "field": field,
                "aiValue": ai_val,
                "humanValue": human_val,
                "createdAt": now_iso,
            })
        if not rows:
            return 0
        for r in rows:
            try:
                await db.ai_overrides_log.update_one(
                    {"_id": r["_id"]},
                    {"$setOnInsert": r},
                    upsert=True,
                )
            except Exception:
                pass
        return len(rows)
    except Exception:
        logger.exception("log_ai_overrides failed")
        return 0


async def ensure_intelligence_indexes() -> None:
    try:
        from app.core.db import get_db
        db = get_db()
        await db.inspection_drafts.create_index([("jobId", 1), ("generatedAt", -1)])
        await db.inspection_drafts.create_index([("inspectorId", 1), ("generatedAt", -1)])
        await db.ai_overrides_log.create_index([("jobId", 1), ("createdAt", -1)])
        await db.ai_overrides_log.create_index([("draftId", 1)])
        await db.ai_overrides_log.create_index([("field", 1), ("createdAt", -1)])
    except Exception:
        logger.warning("intelligence indexes ensure failed", exc_info=True)


__all__ = [
    "synthesize_report",
    "detect_contradictions",
    "detect_missing_evidence",
    "compute_confidence",
    "log_ai_overrides",
    "ensure_intelligence_indexes",
]

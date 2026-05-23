"""observatory.interpreter — deterministic phrase synthesis.

No LLM. No randomness. Phrases are picked by simple ratio/threshold rules
over substrate counts. Output vocabulary is restricted to:

  continuity · coherence · restraint · accumulation · persistence ·
  alignment · interpretation · compression · expansion · holding · drifting

Banned vocabulary (must never appear): ROI, success, accuracy, efficiency,
performance, productivity, growth, conversion.
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any


# ── posture mapping ─────────────────────────────────────────────────────
_POSTURE_PHRASE: dict[str, str] = {
    "timeline_events": "narrative continuity",
    "notifications": "broadcast posture",
    "assignments": "routing posture",
    "reputation_snapshots": "reputational consolidation",
    "verification_rejection_history": "gatekeeping posture",
    "inspection_drafts": "deliberation posture",
    "offline_replay_log": "repair posture",
    "governance_actions": "governance posture",
    "demand_action_executions": "intervention posture",
    "system_logs": "observation posture",
}


def _humanize_source(name: str) -> str:
    return _POSTURE_PHRASE.get(name, name.replace("_", " "))


def _coherence_for(actions: int) -> str:
    # Lower variance / fewer actions ⇒ aligned. Higher ⇒ drifting.
    if actions == 0:
        return "dormant"
    if actions < 5:
        return "aligned"
    if actions < 15:
        return "holding"
    return "drifting"


def _phase_for(actions: int) -> str:
    if actions == 0:
        return "absent"
    if actions < 5:
        return "compression"
    if actions < 15:
        return "expansion"
    return "saturation"


def _persistence_phrase(cycles: int) -> str:
    if cycles <= 0:
        return "no held cycles"
    if cycles == 1:
        return "held for 1 cycle"
    return f"held for {cycles} cycles"


def _continuity_phrase(first: str | None, last: str | None, count: int) -> str:
    if not first or not last or count == 0:
        return "no continuity recorded"
    try:
        f = datetime.fromisoformat(first.replace("Z", "+00:00"))
        last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
        delta = last_dt - f
        days = max(1, delta.days)
        if days >= 14:
            return f"continuity sustained across {days} days"
        if days >= 3:
            return f"continuity holding for {days} days"
        return f"continuity emerging across {days} day(s)"
    except Exception:
        return "continuity present but unparseable"


def _accumulation_phrase(reputation_depth: int, total: int) -> str:
    if reputation_depth == 0:
        return "no reputational accumulation yet"
    if reputation_depth < 3:
        return f"accumulation early ({reputation_depth} operators)"
    return f"accumulation deepening across {reputation_depth} operators"


def _shadow_phrase(blocked: int, waiting: int, unresolved: int) -> str:
    parts: list[str] = []
    if blocked:
        parts.append(f"{blocked} blocked")
    if waiting:
        parts.append(f"{waiting} waiting")
    if unresolved:
        parts.append(f"{unresolved} unresolved")
    if not parts:
        return "no shadow structures detected"
    return "shadow structures present: " + " · ".join(parts)


def interpret(substrate: dict[str, Any]) -> dict[str, Any]:
    """Map raw aggregator output → canonical observatory response."""
    top_postures: list[str] = substrate.get("topPostures") or []
    top_zones: list[dict] = substrate.get("topZones") or []
    shadow: dict[str, int] = substrate.get("shadow") or {}
    continuity: dict = substrate.get("continuity") or {}
    rep_depth: int = int(substrate.get("reputationDepth") or 0)
    symbols: list[str] = substrate.get("alignmentSymbols") or []
    total: int = int(substrate.get("substrateTotal") or 0)

    # ── deploymentClimate ──────────────────────────────────────────────
    if top_postures:
        dominant = _humanize_source(top_postures[0])
        secondary = [_humanize_source(p) for p in top_postures[1:]]
        if secondary:
            climate_interpretation = (
                f"system holding under {dominant}; "
                f"secondary layers — {', '.join(secondary)}"
            )
        else:
            climate_interpretation = f"system held by {dominant} alone"
    else:
        dominant = "dormant"
        climate_interpretation = "no dominant posture; system is quiet"

    blocked_by: str
    if shadow.get("blocked", 0) > 0:
        blocked_by = "gatekeeping (verification rejections present)"
    elif shadow.get("unresolved", 0) > 0:
        blocked_by = "unresolved offline replays"
    elif shadow.get("waiting", 0) > 0:
        blocked_by = "deliberation (drafts held)"
    else:
        blocked_by = "nothing currently blocks the deployment"

    deployment_climate = {
        "dominantPosture": dominant,
        "blockedBy": blocked_by,
        "interpretation": climate_interpretation,
    }

    # ── alignmentDrift — per zone/symbol coherence ─────────────────────
    alignment_drift: list[dict] = []
    if top_zones:
        for z in top_zones[:5]:
            actions = int(z.get("actions") or 0)
            zid = str(z.get("zoneId") or "unknown")
            alignment_drift.append({
                "symbol": zid,
                "coherence": _coherence_for(actions),
                "interpretation": (
                    f"{zid} showing {_coherence_for(actions)} signal "
                    f"({actions} interventions in 24h)"
                ),
            })
    elif symbols:
        for s in symbols[:3]:
            alignment_drift.append({
                "symbol": s,
                "coherence": "dormant",
                "interpretation": f"{s} present in history but quiet in 24h window",
            })

    # ── cognitiveMemory — continuity + accumulation ────────────────────
    cognitive_memory = {
        "continuity": _continuity_phrase(
            continuity.get("first"),
            continuity.get("last"),
            int(continuity.get("timelineCount") or 0),
        ),
        "accumulation": _accumulation_phrase(rep_depth, total),
        "interpretation": (
            "memory is being laid down" if total >= 10
            else "memory is forming but thin"
        ),
    }

    # ── shadowStructures ────────────────────────────────────────────────
    shadow_block = {
        "blocked": int(shadow.get("blocked", 0)),
        "waiting": int(shadow.get("waiting", 0)),
        "unresolved": int(shadow.get("unresolved", 0)),
        "interpretation": _shadow_phrase(
            int(shadow.get("blocked", 0)),
            int(shadow.get("waiting", 0)),
            int(shadow.get("unresolved", 0)),
        ),
    }

    # ── regimeContinuity — phase × persistence per symbol ──────────────
    regime_continuity: list[dict] = []
    if top_zones:
        for z in top_zones[:5]:
            actions = int(z.get("actions") or 0)
            zid = str(z.get("zoneId") or "unknown")
            # persistence ≈ how many 24h sub-windows had activity. We don't have
            # sub-window data here, so we proxy via floor(actions / 5) bounded by 6.
            cycles = min(6, max(1, actions // 5)) if actions else 0
            regime_continuity.append({
                "symbol": zid,
                "phase": _phase_for(actions),
                "persistence": _persistence_phrase(cycles),
            })

    return {
        "deploymentClimate": deployment_climate,
        "alignmentDrift": alignment_drift,
        "cognitiveMemory": cognitive_memory,
        "shadowStructures": shadow_block,
        "regimeContinuity": regime_continuity,
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()

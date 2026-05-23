"""observatory.snapshots — continuity memory layer.

V2: intentional snapshotting on manual refresh, deterministic structural diff,
count-based retention. NOT a metrics store. NOT an observability warehouse.

Hard invariants (enforced in code):
  • No numeric deltas surfaced (no "X → Y", no percentages, no ratios)
  • Lexicon allowed: entered · exited · transitioned · held · emerged ·
    receded · widened · narrowed
  • Lexicon forbidden: improved · worsened · higher · lower · better · weaker
  • Persist only when canonical interpretation hash changed
  • Hash computed over interpreter output (NOT raw substrate)
  • Retention: keep last 50 snapshots; drop older
"""
from __future__ import annotations
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any

# Collection name. Read-only contract for consumers; only this module writes.
SNAPSHOTS_COLLECTION = "observatory_snapshots"
RETENTION_LIMIT = 50


# ── Canonical interpretation hash ───────────────────────────────────────
# Only these 5 keys participate in the identity. Anything else (e.g. zone
# count drift inside `interpretation` strings) is ignored deliberately —
# continuity belongs to topology, not turbulence.
_HASH_KEYS = (
    "deploymentClimate",
    "alignmentDrift",
    "cognitiveMemory",
    "shadowStructures",
    "regimeContinuity",
)


def _canonical_skeleton(interpretation: dict[str, Any]) -> dict[str, Any]:
    """Reduce interpretation to its topology-only skeleton for hashing.

    We strip the prose `interpretation` substrings (they contain raw counts
    like "208 interventions in 24h" which would otherwise cause hash churn
    on every aggregator pass). What remains is structural: symbols, phases,
    coherences, postures, presence flags.
    """
    dc = interpretation.get("deploymentClimate") or {}
    al = interpretation.get("alignmentDrift") or []
    cm = interpretation.get("cognitiveMemory") or {}
    sh = interpretation.get("shadowStructures") or {}
    rc = interpretation.get("regimeContinuity") or []

    return {
        "deploymentClimate": {
            "dominantPosture": dc.get("dominantPosture"),
            "blockedBy": dc.get("blockedBy"),
        },
        "alignmentDrift": [
            {"symbol": row.get("symbol"), "coherence": row.get("coherence")}
            for row in al
        ],
        "cognitiveMemory": {
            "continuity": cm.get("continuity"),
            "accumulation": cm.get("accumulation"),
        },
        "shadowStructures": {
            "blockedPresent": bool((sh.get("blocked") or 0) > 0),
            "waitingPresent": bool((sh.get("waiting") or 0) > 0),
            "unresolvedPresent": bool((sh.get("unresolved") or 0) > 0),
        },
        "regimeContinuity": [
            {"symbol": row.get("symbol"), "phase": row.get("phase")}
            for row in rc
        ],
    }


def compute_hash(interpretation: dict[str, Any]) -> str:
    skeleton = _canonical_skeleton(interpretation)
    payload = json.dumps(skeleton, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ── Deterministic 1-line summary ────────────────────────────────────────

_POSTURE_VERB = {
    True: "held",        # same as previous
    False: "transitioned",
}


def _alignment_phrase(prev: dict | None, curr: dict) -> str:
    """Describe alignment movement in restrained terms (no numerics)."""
    curr_syms = {row.get("symbol"): row.get("coherence")
                 for row in (curr.get("alignmentDrift") or [])}
    if prev is None:
        n = len(curr_syms)
        if n == 0:
            return "no alignment signal present"
        if n == 1:
            return "alignment narrow to a single symbol"
        return f"alignment spread across {n} symbols"

    prev_syms = {row.get("symbol"): row.get("coherence")
                 for row in (prev.get("alignmentDrift") or [])}
    entered = set(curr_syms) - set(prev_syms)
    exited = set(prev_syms) - set(curr_syms)
    if entered and not exited:
        return "alignment widened"
    if exited and not entered:
        return "alignment narrowed"
    if entered and exited:
        return "alignment redistributed"
    # Same set — check phase/coherence transitions
    transitions = [s for s in curr_syms if curr_syms[s] != prev_syms.get(s)]
    if transitions:
        return "alignment transitioned"
    return "alignment held"


def _posture_phrase(prev: dict | None, curr: dict) -> str:
    cdc = curr.get("deploymentClimate") or {}
    posture = cdc.get("dominantPosture") or "no posture"
    if prev is None:
        return f"{posture} emerged"
    pdc = prev.get("deploymentClimate") or {}
    if pdc.get("dominantPosture") == cdc.get("dominantPosture"):
        return f"{posture} held"
    return f"{pdc.get('dominantPosture') or 'no posture'} transitioned to {posture}"


def deterministic_summary(prev_interp: dict | None, curr_interp: dict) -> str:
    """One restrained sentence. No metrics, no ratios, no value comparatives."""
    posture = _posture_phrase(prev_interp, curr_interp)
    alignment = _alignment_phrase(prev_interp, curr_interp)

    # Shadow presence flip — only mention if it changed
    shadow_note = ""
    if prev_interp is not None:
        p_sh = prev_interp.get("shadowStructures") or {}
        c_sh = curr_interp.get("shadowStructures") or {}
        for key in ("blocked", "waiting", "unresolved"):
            p_present = (p_sh.get(key) or 0) > 0
            c_present = (c_sh.get(key) or 0) > 0
            if p_present != c_present:
                verb = "emerged" if c_present else "receded"
                shadow_note = f"; shadow {key} {verb}"
                break
    else:
        c_sh = curr_interp.get("shadowStructures") or {}
        if any((c_sh.get(k) or 0) > 0 for k in ("blocked", "waiting", "unresolved")):
            shadow_note = "; shadow structures present"

    # Capitalize first word, single period at end.
    raw = f"{posture}, {alignment}{shadow_note}"
    if raw:
        raw = raw[0].upper() + raw[1:]
    if not raw.endswith("."):
        raw += "."
    return raw


# ── Structural diff (topology-only) ─────────────────────────────────────

def _diff_alignment(prev: dict, curr: dict) -> list[dict]:
    """Per-symbol structural events. No counts, no ratios."""
    out: list[dict] = []
    prev_map = {row.get("symbol"): row.get("coherence")
                for row in (prev.get("alignmentDrift") or [])}
    curr_map = {row.get("symbol"): row.get("coherence")
                for row in (curr.get("alignmentDrift") or [])}
    for sym in sorted(set(prev_map) | set(curr_map)):
        in_prev = sym in prev_map
        in_curr = sym in curr_map
        if in_prev and not in_curr:
            out.append({
                "kind": "alignment",
                "symbol": sym,
                "event": "receded",
                "note": f"{sym} exited alignment",
            })
        elif in_curr and not in_prev:
            out.append({
                "kind": "alignment",
                "symbol": sym,
                "event": "emerged",
                "note": f"{sym} entered alignment",
            })
        elif prev_map[sym] != curr_map[sym]:
            out.append({
                "kind": "alignment",
                "symbol": sym,
                "event": "transitioned",
                "note": f"{sym}: {prev_map[sym]} → {curr_map[sym]}",
            })
    return out


def _diff_regime(prev: dict, curr: dict) -> list[dict]:
    out: list[dict] = []
    prev_map = {row.get("symbol"): row.get("phase")
                for row in (prev.get("regimeContinuity") or [])}
    curr_map = {row.get("symbol"): row.get("phase")
                for row in (curr.get("regimeContinuity") or [])}
    for sym in sorted(set(prev_map) | set(curr_map)):
        if sym in prev_map and sym not in curr_map:
            out.append({
                "kind": "regime",
                "symbol": sym,
                "event": "receded",
                "note": f"{sym} exited regime",
            })
        elif sym in curr_map and sym not in prev_map:
            out.append({
                "kind": "regime",
                "symbol": sym,
                "event": "emerged",
                "note": f"{sym} entered regime",
            })
        elif prev_map.get(sym) != curr_map.get(sym):
            out.append({
                "kind": "regime",
                "symbol": sym,
                "event": "transitioned",
                "note": f"{sym}: {prev_map[sym]} → {curr_map[sym]}",
            })
    return out


def _diff_climate(prev: dict, curr: dict) -> list[dict]:
    out: list[dict] = []
    p = prev.get("deploymentClimate") or {}
    c = curr.get("deploymentClimate") or {}
    if p.get("dominantPosture") != c.get("dominantPosture"):
        out.append({
            "kind": "posture",
            "event": "transitioned",
            "note": f"{p.get('dominantPosture')} → {c.get('dominantPosture')}",
        })
    if p.get("blockedBy") != c.get("blockedBy"):
        out.append({
            "kind": "block",
            "event": "transitioned",
            "note": f"{p.get('blockedBy')} → {c.get('blockedBy')}",
        })
    return out


def _diff_shadow(prev: dict, curr: dict) -> list[dict]:
    out: list[dict] = []
    p = prev.get("shadowStructures") or {}
    c = curr.get("shadowStructures") or {}
    for key in ("blocked", "waiting", "unresolved"):
        p_present = (p.get(key) or 0) > 0
        c_present = (c.get(key) or 0) > 0
        if p_present == c_present:
            continue
        verb = "emerged" if c_present else "receded"
        out.append({
            "kind": "shadow",
            "event": verb,
            "note": f"shadow {key} {verb}",
        })
    return out


def structural_diff(prev_interp: dict | None, curr_interp: dict) -> list[dict]:
    """Return ordered list of topology-only events. Empty list = no change."""
    if prev_interp is None:
        # First snapshot — emit a single bootstrap event, no diff.
        return []
    events: list[dict] = []
    events.extend(_diff_climate(prev_interp, curr_interp))
    events.extend(_diff_alignment(prev_interp, curr_interp))
    events.extend(_diff_regime(prev_interp, curr_interp))
    events.extend(_diff_shadow(prev_interp, curr_interp))
    return events


# ── Persistence ─────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


async def latest_snapshot(db) -> dict | None:
    """Most recent snapshot or None."""
    try:
        return await db[SNAPSHOTS_COLLECTION].find_one(
            {}, sort=[("takenAt", -1)], projection={"_id": 0}
        )
    except Exception:
        return None


async def maybe_persist(db, interpretation: dict) -> tuple[bool, dict | None, dict | None]:
    """Intentional snapshot — write only if canonical hash changed.

    Returns: (persisted, current_snapshot_or_none, previous_snapshot_or_none)
    """
    current_hash = compute_hash(interpretation)
    prev = await latest_snapshot(db)

    if prev and prev.get("substrateHash") == current_hash:
        # No structural change — do not write. Keep continuity intentional.
        return False, prev, prev

    prev_interp = (prev or {}).get("interpretation") if prev else None
    summary = deterministic_summary(prev_interp, interpretation)

    snapshot = {
        "id": str(uuid.uuid4()),
        "takenAt": _now_iso(),
        "substrateHash": current_hash,
        "summary": summary,
        "interpretation": interpretation,
    }

    try:
        await db[SNAPSHOTS_COLLECTION].insert_one(dict(snapshot))
        # Remove the inserted _id from in-memory copy (insert_one mutates).
        snapshot.pop("_id", None)
        await _enforce_retention(db)
        return True, snapshot, prev
    except Exception:
        return False, prev, prev


async def _enforce_retention(db) -> None:
    """Drop snapshots beyond RETENTION_LIMIT, oldest first."""
    try:
        total = await db[SNAPSHOTS_COLLECTION].count_documents({})
        excess = total - RETENTION_LIMIT
        if excess <= 0:
            return
        # Find ids of oldest `excess` snapshots
        cursor = db[SNAPSHOTS_COLLECTION].find(
            {}, sort=[("takenAt", 1)], projection={"_id": 0, "id": 1}
        ).limit(excess)
        old_ids = [doc["id"] async for doc in cursor]
        if old_ids:
            await db[SNAPSHOTS_COLLECTION].delete_many({"id": {"$in": old_ids}})
    except Exception:
        pass


async def list_snapshots(db, limit: int = 50) -> list[dict]:
    """Newest first, projection: id/takenAt/summary/substrateHash only.

    Full interpretation is excluded to keep the list view restrained.
    """
    try:
        cursor = db[SNAPSHOTS_COLLECTION].find(
            {},
            sort=[("takenAt", -1)],
            projection={"_id": 0, "id": 1, "takenAt": 1,
                        "summary": 1, "substrateHash": 1},
        ).limit(min(int(limit), RETENTION_LIMIT))
        return [doc async for doc in cursor]
    except Exception:
        return []


async def find_snapshot(db, snapshot_id: str) -> dict | None:
    try:
        return await db[SNAPSHOTS_COLLECTION].find_one(
            {"id": snapshot_id}, projection={"_id": 0}
        )
    except Exception:
        return None


async def predecessor_of(db, snapshot: dict) -> dict | None:
    """Snapshot immediately older than `snapshot` by takenAt. None if first."""
    if not snapshot or not snapshot.get("takenAt"):
        return None
    try:
        return await db[SNAPSHOTS_COLLECTION].find_one(
            {"takenAt": {"$lt": snapshot["takenAt"]}},
            sort=[("takenAt", -1)],
            projection={"_id": 0},
        )
    except Exception:
        return None

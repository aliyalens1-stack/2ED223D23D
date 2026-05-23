"""scripts/phase1a_org_mapping — FROZEN canonical org→cluster mapping.

Phase 1A invariant: this mapping is HAND-AUTHORED, not algorithmically derived.

Why frozen?
-----------
Phase 0 backfill_dryrun (§Critical Finding 3) discovered that pure-rule inference
fails on `eu-auto-delivery` (city=berlin, country='' empty) — would mis-route to
`repair` instead of `delivery`. Rules cannot fix incomplete data.

Therefore: each of the 11 existing organizations is tagged explicitly by `_id`.
New organizations (created after Phase 1A) auto-set cluster on insert and never
need this table.

Source of authoritative review
------------------------------
- Each entry below was hand-verified against:
  - `organizations._id` (MongoDB ObjectId-string)
  - `slug` (human-readable)
  - `providerType` (semantic role)
  - `city` + `country` (geographic context)
  - `name` (product owner intent — e.g., "EU Auto Delivery" → delivery cluster)

Layout
------
Each entry: (object_id_str, slug, expected_cluster, reasoning_note)

Verification rule: backfill script MUST cross-check `slug` matches before applying
`expected_cluster` — protects against ObjectId reassignment.

DO NOT REMOVE ENTRIES. DO NOT EDIT WITHOUT TICKET.
"""
from __future__ import annotations

# Phase 1A frozen mapping — 11 organizations as of 2026-05-12
# Format: (_id, slug, cluster, reasoning)
FROZEN_ORG_MAPPING: list[tuple[str, str, str, str]] = [
    # ── Legacy Kyiv UAH taxi-marketplace (repair cluster) ─────────────────
    ("6a03895b68146358658cd2ce", "avtomaster-pro",     "repair",
     "Kyiv СТО, providerType=mechanic, UAH market"),
    ("6a03895b68146358658cd2cf", "mobile-service-24",  "repair",
     "Kyiv mobile mechanic, providerType=mobile_mechanic, UAH market"),
    ("6a03895b68146358658cd2d0", "sto-formula",        "repair",
     "Kyiv СТО Формула, providerType=mechanic, UAH market"),
    ("6a03895b68146358658cd2d1", "techno-diagnostic",  "repair",
     "Kyiv diagnostic shop, providerType=mechanic, UAH market"),
    ("6a03895b68146358658cd2d2", "evacuator-ua",       "repair",
     "Kyiv tow service ЭвакуаторUA, providerType=transporter "
     "but country=UA + city=kyiv → repair (legacy taxi domain). "
     "Note: rule would also produce 'repair' via 'transporter+non-DE→repair', "
     "but mapping is explicit to prevent silent edge cases."),
    ("6a03895b68146358658cd2d3", "brake-service",      "repair",
     "Kyiv БрейкСервис, providerType=mechanic, UAH market"),
    ("6a03895b68146358658cd2d4", "autoelectric-pro",   "repair",
     "Kyiv AutoElectric Pro, providerType=mechanic, UAH market"),
    ("6a03895b68146358658cd2d5", "kuzov-master",       "repair",
     "Kyiv КузовМастер, providerType=mechanic, UAH market"),

    # ── New Auto Search DE EUR (inspection / selection / delivery) ─────────
    ("6a03895b68146358658cd2d6", "berlin-auto-check",  "inspection",
     "Berlin pre-purchase TÜV inspector, providerType=inspector → inspection"),
    ("6a03895b68146358658cd2d7", "car-selection-eu",   "selection",
     "Berlin car-selection expert, providerType=buyer → selection cluster"),
    ("6a03895b68146358658cd2d8", "eu-auto-delivery",   "delivery",
     "Berlin transport service. providerType=transporter, but country field is "
     "empty in DB (data gap). Name 'EU Auto Delivery' + city=berlin makes intent "
     "unambiguous → delivery cluster. This is the case rules cannot solve."),
]


def get_frozen_mapping_by_id() -> dict[str, str]:
    """Return {_id_string: cluster} dict for backfill consumption."""
    return {entry[0]: entry[2] for entry in FROZEN_ORG_MAPPING}


def get_frozen_mapping_by_slug() -> dict[str, str]:
    """Return {slug: cluster} dict for backfill consumption."""
    return {entry[1]: entry[2] for entry in FROZEN_ORG_MAPPING}


def verify_entry(_id: str, slug: str) -> tuple[bool, str | None, str | None]:
    """Cross-check that an org's (_id, slug) matches a frozen mapping entry.

    Returns (ok, cluster, error_reason).
    """
    for entry_id, entry_slug, cluster, _note in FROZEN_ORG_MAPPING:
        if entry_id == _id:
            if entry_slug == slug:
                return True, cluster, None
            return False, None, f"slug mismatch: expected '{entry_slug}', got '{slug}'"
    return False, None, f"_id '{_id}' not in frozen mapping"


# Cluster distribution sanity check
def assert_distribution_invariants() -> None:
    """Assert the mapping has the expected cluster distribution from Phase 0."""
    counts: dict[str, int] = {}
    for _, _, cluster, _ in FROZEN_ORG_MAPPING:
        counts[cluster] = counts.get(cluster, 0) + 1
    expected = {"repair": 8, "inspection": 1, "selection": 1, "delivery": 1}
    assert counts == expected, (
        f"Frozen mapping distribution drift: expected {expected}, got {counts}"
    )


if __name__ == "__main__":
    assert_distribution_invariants()
    print(f"FROZEN_ORG_MAPPING — {len(FROZEN_ORG_MAPPING)} entries")
    for _id, slug, cluster, note in FROZEN_ORG_MAPPING:
        print(f"  {_id} | {slug:<22} → {cluster}")
    print("\n✅ Distribution invariants pass.")

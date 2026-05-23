"""Inspection Checklist — Stage 4 (60+ items, professional grade).

Each item:
  - `key`   — stable identifier (snake_case)
  - `group` — UI grouping (one of GROUPS)

Inspector marks each as one of: ok | warning | problem | not_checked.

NOTE: keys are STABLE — never rename (reports reference them).
Add new keys at the bottom of their group.
"""
from __future__ import annotations
from typing import Final, List, Dict

# Display order for groups in the UI
GROUPS: Final[tuple[str, ...]] = (
    "documents",
    "body",
    "paint",
    "glass_lights",
    "wheels",
    "engine",
    "fluids",
    "drivetrain",
    "chassis",
    "brakes",
    "electronics",
    "interior",
    "comfort",
    "safety",
    "drive",
)

CHECKLIST: Final[List[Dict[str, str]]] = [
    # ── DOCUMENTS (5)
    {"key": "vin",                  "group": "documents"},
    {"key": "service_history",      "group": "documents"},
    {"key": "ownership_count",      "group": "documents"},
    {"key": "registration",         "group": "documents"},
    {"key": "tuv_huu",              "group": "documents"},

    # ── BODY (6)
    {"key": "body_panels",          "group": "body"},
    {"key": "panel_gaps",           "group": "body"},
    {"key": "hood_alignment",       "group": "body"},
    {"key": "doors_alignment",      "group": "body"},
    {"key": "trunk_alignment",      "group": "body"},
    {"key": "underbody_rust",       "group": "body"},

    # ── PAINT (4)
    {"key": "paint_thickness",      "group": "paint"},
    {"key": "paint_color_match",    "group": "paint"},
    {"key": "accident_signs",       "group": "paint"},
    {"key": "respray_traces",       "group": "paint"},

    # ── GLASS & LIGHTS (4)
    {"key": "windshield",           "group": "glass_lights"},
    {"key": "side_glass",           "group": "glass_lights"},
    {"key": "headlights",           "group": "glass_lights"},
    {"key": "taillights",           "group": "glass_lights"},

    # ── WHEELS (4)
    {"key": "tire_condition",       "group": "wheels"},
    {"key": "tire_age_dot",         "group": "wheels"},
    {"key": "rims_condition",       "group": "wheels"},
    {"key": "spare_jack",           "group": "wheels"},

    # ── ENGINE (6)
    {"key": "engine_visual",        "group": "engine"},
    {"key": "engine_oil_leaks",     "group": "engine"},
    {"key": "engine_start_cold",    "group": "engine"},
    {"key": "engine_idle",          "group": "engine"},
    {"key": "engine_noise",         "group": "engine"},
    {"key": "engine_smoke",         "group": "engine"},

    # ── FLUIDS (4)
    {"key": "engine_oil_level",     "group": "fluids"},
    {"key": "coolant_level",        "group": "fluids"},
    {"key": "brake_fluid",          "group": "fluids"},
    {"key": "transmission_fluid",   "group": "fluids"},

    # ── DRIVETRAIN (4)
    {"key": "gearbox_shift",        "group": "drivetrain"},
    {"key": "clutch_or_torque",     "group": "drivetrain"},
    {"key": "drive_shaft",          "group": "drivetrain"},
    {"key": "differential",         "group": "drivetrain"},

    # ── CHASSIS (5)
    {"key": "suspension_front",     "group": "chassis"},
    {"key": "suspension_rear",      "group": "chassis"},
    {"key": "shock_absorbers",      "group": "chassis"},
    {"key": "steering_play",        "group": "chassis"},
    {"key": "exhaust_system",       "group": "chassis"},

    # ── BRAKES (4)
    {"key": "brake_discs",          "group": "brakes"},
    {"key": "brake_pads",           "group": "brakes"},
    {"key": "handbrake",            "group": "brakes"},
    {"key": "abs_warning",          "group": "brakes"},

    # ── ELECTRONICS (6)
    {"key": "obd_scan",             "group": "electronics"},
    {"key": "dashboard_warnings",   "group": "electronics"},
    {"key": "battery_health",       "group": "electronics"},
    {"key": "alternator",           "group": "electronics"},
    {"key": "infotainment",         "group": "electronics"},
    {"key": "sensors_cameras",      "group": "electronics"},

    # ── INTERIOR (5)
    {"key": "seats_condition",      "group": "interior"},
    {"key": "seat_belts",           "group": "interior"},
    {"key": "dashboard_trim",       "group": "interior"},
    {"key": "carpet_floor",         "group": "interior"},
    {"key": "interior_smell",       "group": "interior"},

    # ── COMFORT (4)
    {"key": "ac_cooling",           "group": "comfort"},
    {"key": "heating",              "group": "comfort"},
    {"key": "windows_function",     "group": "comfort"},
    {"key": "central_locking",      "group": "comfort"},

    # ── SAFETY (3)
    {"key": "airbag_indicators",    "group": "safety"},
    {"key": "abs_esp_function",     "group": "safety"},
    {"key": "tpms",                 "group": "safety"},

    # ── DRIVE (3)
    {"key": "test_drive",           "group": "drive"},
    {"key": "highway_stability",    "group": "drive"},
    {"key": "noise_at_speed",       "group": "drive"},
]

CHECKLIST_KEYS: Final[set[str]] = {it["key"] for it in CHECKLIST}

# ── D3 compat (Sprint 4 fixtures + legacy mobile clients) ───────────
# Older clients submit a coarse-grained summary checklist with keys equal
# to GROUP names (engine, brakes, etc.) instead of the 60+ atomic keys.
# We accept both — the report consumer treats group-level entries as a
# group-aggregate. New code should use atomic keys.
# TODO: remove_after_shared_inspection_0B
LEGACY_GROUP_ALIAS_KEYS: Final[set[str]] = set(GROUPS)
ACCEPTED_CHECKLIST_KEYS: Final[set[str]] = CHECKLIST_KEYS | LEGACY_GROUP_ALIAS_KEYS

ITEM_STATUSES: Final[tuple[str, ...]] = ("ok", "warning", "problem", "not_checked")
VERDICTS: Final[tuple[str, ...]] = ("recommended", "risky", "not_recommended")

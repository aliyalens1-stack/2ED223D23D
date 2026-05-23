"""Phase 1A inference rule unit tests — pure function tests, no DB.

Run with: python -m pytest backend/tests/phase1a/test_inference_rules.py -v
Or:       cd /app/backend && python tests/phase1a/test_inference_rules.py
"""
import sys
import os

# Add backend/ to path so we can import app.*
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from app.core.clusters_phase1 import (
    CLUSTER_REPAIR,
    CLUSTER_INSPECTION,
    CLUSTER_SELECTION,
    CLUSTER_DELIVERY,
    VALID_CLUSTERS,
    CLUSTER_TO_CURRENCY,
    is_valid_cluster,
    cluster_for_currency,
    zone_to_cluster,
    account_kind_to_cluster,
    event_type_to_cluster,
    action_type_to_cluster_hint,
)

# Add scripts/ to path for frozen mapping
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "scripts")))
from phase1a_org_mapping import (
    FROZEN_ORG_MAPPING,
    get_frozen_mapping_by_id,
    get_frozen_mapping_by_slug,
    verify_entry,
    assert_distribution_invariants,
)


PASS, FAIL = "✅", "❌"
results = []


def t(name, condition, detail=""):
    sym = PASS if condition else FAIL
    results.append((condition, name, detail))
    print(f"  {sym} {name}" + (f"  [{detail}]" if detail and not condition else ""))


# ──────────────────────────────────────────────────────────────────
print("\n[1] Cluster constants & vocabulary")
t("4 valid clusters exist", len(VALID_CLUSTERS) == 4)
t("REPAIR is in vocabulary", CLUSTER_REPAIR in VALID_CLUSTERS)
t("INSPECTION is in vocabulary", CLUSTER_INSPECTION in VALID_CLUSTERS)
t("SELECTION is in vocabulary", CLUSTER_SELECTION in VALID_CLUSTERS)
t("DELIVERY is in vocabulary", CLUSTER_DELIVERY in VALID_CLUSTERS)
t("is_valid_cluster True on known", is_valid_cluster("repair") and is_valid_cluster("inspection"))
t("is_valid_cluster False on unknown", not is_valid_cluster("taxi") and not is_valid_cluster(None))

# ──────────────────────────────────────────────────────────────────
print("\n[2] Currency ↔ cluster")
t("REPAIR→UAH", CLUSTER_TO_CURRENCY[CLUSTER_REPAIR] == "UAH")
t("INSPECTION→EUR", CLUSTER_TO_CURRENCY[CLUSTER_INSPECTION] == "EUR")
t("SELECTION→EUR", CLUSTER_TO_CURRENCY[CLUSTER_SELECTION] == "EUR")
t("DELIVERY→EUR", CLUSTER_TO_CURRENCY[CLUSTER_DELIVERY] == "EUR")
t("cluster_for_currency(UAH)→repair", cluster_for_currency("UAH") == CLUSTER_REPAIR)
t("cluster_for_currency(uah)→repair (case-insensitive)", cluster_for_currency("uah") == CLUSTER_REPAIR)
t("cluster_for_currency(EUR)→None (ambiguous)", cluster_for_currency("EUR") is None)
t("cluster_for_currency(None)→None", cluster_for_currency(None) is None)
t("cluster_for_currency('')→None", cluster_for_currency("") is None)

# ──────────────────────────────────────────────────────────────────
print("\n[3] zone_to_cluster")
t("UA+UAH→repair",
  zone_to_cluster({"country": "UA", "currency": "UAH"}) == CLUSTER_REPAIR)
t("DE+EUR→inspection",
  zone_to_cluster({"country": "DE", "currency": "EUR"}) == CLUSTER_INSPECTION)
t("AT+EUR→inspection",
  zone_to_cluster({"country": "AT", "currency": "EUR"}) == CLUSTER_INSPECTION)
t("DE+eur (lowercase)→inspection",
  zone_to_cluster({"country": "DE", "currency": "eur"}) == CLUSTER_INSPECTION)
t("PL+EUR→None (unsupported)",
  zone_to_cluster({"country": "PL", "currency": "EUR"}) is None)
t("UA+EUR→None (conflicting)",
  zone_to_cluster({"country": "UA", "currency": "EUR"}) is None)
t("DE+UAH→None (conflicting)",
  zone_to_cluster({"country": "DE", "currency": "UAH"}) is None)
t("empty dict→None", zone_to_cluster({}) is None)
t("None input→None", zone_to_cluster(None) is None)

# ──────────────────────────────────────────────────────────────────
print("\n[4] account_kind_to_cluster")
t("inspector→inspection", account_kind_to_cluster("inspector") == CLUSTER_INSPECTION)
t("service_provider→repair", account_kind_to_cluster("service_provider") == CLUSTER_REPAIR)
t("dealer→selection", account_kind_to_cluster("dealer") == CLUSTER_SELECTION)
t("transport_provider→delivery", account_kind_to_cluster("transport_provider") == CLUSTER_DELIVERY)
t("INSPECTOR uppercase→inspection (case-insensitive)",
  account_kind_to_cluster("INSPECTOR") == CLUSTER_INSPECTION)
t("customer→None (orthogonal)", account_kind_to_cluster("customer") is None)
t("admin→None (orthogonal)", account_kind_to_cluster("admin") is None)
t("None input→None", account_kind_to_cluster(None) is None)
t("Unknown kind→None", account_kind_to_cluster("warlock") is None)

# ──────────────────────────────────────────────────────────────────
print("\n[5] event_type_to_cluster (runtime_ledger_events)")
t("INSPECTION_CONTEXT_ESTABLISHED→inspection",
  event_type_to_cluster("INSPECTION_CONTEXT_ESTABLISHED") == CLUSTER_INSPECTION)
t("ASSIGNMENT_CONTINUITY_CLAIMED→inspection",
  event_type_to_cluster("ASSIGNMENT_CONTINUITY_CLAIMED") == CLUSTER_INSPECTION)
t("VEHICLE_INGESTED→inspection",
  event_type_to_cluster("VEHICLE_INGESTED") == CLUSTER_INSPECTION)
t("CONTACT_REVEALED→inspection",
  event_type_to_cluster("CONTACT_REVEALED") == CLUSTER_INSPECTION)
t("QUOTE_ACCEPTED→repair",
  event_type_to_cluster("QUOTE_ACCEPTED") == CLUSTER_REPAIR)
t("BOOKING_COMPLETED→repair",
  event_type_to_cluster("BOOKING_COMPLETED") == CLUSTER_REPAIR)
t("Unknown event→None",
  event_type_to_cluster("SOMETHING_RANDOM") is None)
t("None→None", event_type_to_cluster(None) is None)

# ──────────────────────────────────────────────────────────────────
print("\n[6] action_type_to_cluster_hint (taxi primitives)")
t("set_surge→repair hint", action_type_to_cluster_hint("set_surge") == CLUSTER_REPAIR)
t("push_providers→repair hint", action_type_to_cluster_hint("push_providers") == CLUSTER_REPAIR)
t("expand_radius→repair hint", action_type_to_cluster_hint("expand_radius") == CLUSTER_REPAIR)
t("priority_bias→repair hint", action_type_to_cluster_hint("priority_bias") == CLUSTER_REPAIR)
t("non-taxi action→None", action_type_to_cluster_hint("schedule_inspection") is None)
t("None→None", action_type_to_cluster_hint(None) is None)

# ──────────────────────────────────────────────────────────────────
print("\n[7] FROZEN_ORG_MAPPING — finite, manual, verified")
t("Exactly 11 entries",
  len(FROZEN_ORG_MAPPING) == 11,
  f"got {len(FROZEN_ORG_MAPPING)}")
t("All entries have valid cluster",
  all(c in VALID_CLUSTERS for _, _, c, _ in FROZEN_ORG_MAPPING))

# distribution invariants
try:
    assert_distribution_invariants()
    dist_ok = True
except AssertionError as e:
    dist_ok = False
    print(f"    distribution error: {e}")
t("Distribution = {repair:8, inspection:1, selection:1, delivery:1}", dist_ok)

# uniqueness
ids = [e[0] for e in FROZEN_ORG_MAPPING]
slugs = [e[1] for e in FROZEN_ORG_MAPPING]
t("All _id values unique", len(ids) == len(set(ids)))
t("All slug values unique", len(slugs) == len(set(slugs)))

# verify_entry cross-check
ok, cluster, _ = verify_entry("6a03895b68146358658cd2d6", "berlin-auto-check")
t("verify_entry: berlin-auto-check→inspection", ok and cluster == CLUSTER_INSPECTION)

ok, cluster, _ = verify_entry("6a03895b68146358658cd2d8", "eu-auto-delivery")
t("verify_entry: eu-auto-delivery→delivery (the tricky one)",
  ok and cluster == CLUSTER_DELIVERY)

# wrong slug fails
ok, _, err = verify_entry("6a03895b68146358658cd2d6", "wrong-slug")
t("verify_entry: catches slug drift", not ok and err and "slug mismatch" in err)

# unknown _id fails
ok, _, err = verify_entry("000000000000000000000000", "ghost")
t("verify_entry: rejects unknown _id", not ok and err and "not in frozen mapping" in err)

# ──────────────────────────────────────────────────────────────────
print("\n[8] Mapping lookup APIs")
by_id = get_frozen_mapping_by_id()
by_slug = get_frozen_mapping_by_slug()
t("by_id dict has 11 entries", len(by_id) == 11)
t("by_slug dict has 11 entries", len(by_slug) == 11)
t("by_id['6a03895b68146358658cd2d6'] == 'inspection'",
  by_id.get("6a03895b68146358658cd2d6") == "inspection")
t("by_slug['eu-auto-delivery'] == 'delivery'",
  by_slug.get("eu-auto-delivery") == "delivery")

# ──────────────────────────────────────────────────────────────────
# Summary
passed = sum(1 for ok, _, _ in results if ok)
failed = sum(1 for ok, _, _ in results if not ok)
total = len(results)
print(f"\n{'='*60}")
print(f"  PASSED: {passed}/{total}")
if failed:
    print(f"  FAILED: {failed}")
    for ok, name, detail in results:
        if not ok:
            print(f"    ✗ {name}  {detail}")
    sys.exit(1)
print(f"  ✅ ALL INFERENCE RULE TESTS PASS")
sys.exit(0)

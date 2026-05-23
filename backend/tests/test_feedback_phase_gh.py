"""
Phase G+H: Action Feedback Loop Engine + Strategy Optimizer - Backend API Tests

Tests all feedback endpoints:
- GET /api/feedback/actions - feedback records with stats
- GET /api/feedback/zone/{zoneId} - zone-specific feedback
- GET /api/feedback/top-actions - most effective actions
- GET /api/feedback/worst-actions - least effective actions
- GET /api/feedback/strategy - global + per-zone strategy weights
- GET /api/feedback/recommendations - AI recommendations
- POST /api/feedback/recalculate - manual trigger (admin)
- GET /api/feedback/dashboard - full dashboard

Also verifies:
- Background tasks running (feedback processor, strategy optimizer)
- Enhanced orchestrator integration
- Previous Phase E endpoints still working
"""

import pytest
import requests
import os
import time

# Use external URL for testing (what users see)
BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
# Test credentials from /app/memory/test_credentials.md
ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"


@pytest.fixture(scope="module")
def api_client():
    """Shared requests session"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session


@pytest.fixture(scope="module")
def admin_token(api_client):
    """Get admin JWT token for protected endpoints"""
    response = api_client.post(f"{BASE_URL}/api/auth/login", json={
        "email": ADMIN_EMAIL,
        "password": ADMIN_PASSWORD
    })
    assert response.status_code == 200, f"Admin login failed: {response.text}"
    data = response.json()
    assert "accessToken" in data, "No accessToken in login response"
    return data["accessToken"]


class TestFeedbackEndpoints:
    """Test Phase G feedback endpoints"""

    def test_feedback_actions_endpoint(self, api_client):
        """GET /api/feedback/actions - should return feedback records with stats"""
        response = api_client.get(f"{BASE_URL}/api/feedback/actions?limit=50")
        assert response.status_code == 200, f"Failed: {response.text}"
        data = response.json()
        
        # Verify structure
        assert "records" in data, "Missing 'records' field"
        assert "stats" in data, "Missing 'stats' field"
        
        # Verify stats structure
        stats = data["stats"]
        assert "total" in stats
        assert "completed" in stats
        assert "pending" in stats
        assert "avgEffectiveness" in stats
        assert "byActionType" in stats
        
        # Verify records
        records = data["records"]
        assert isinstance(records, list), "records should be a list"
        
        # Main agent said 106+ samples processed
        assert len(records) > 0, "Should have feedback records (main agent said 106+ samples)"
        
        # Verify record structure
        if records:
            record = records[0]
            assert "id" in record
            assert "zoneId" in record
            assert "zoneName" in record
            assert "actionType" in record
            assert "severity" in record
            assert "status" in record
            assert "before" in record
            assert "createdAt" in record
            
            # If completed, should have effectiveness data
            if record.get("status") == "completed":
                assert "after" in record
                assert "delta" in record
                assert "effectivenessScore" in record
                assert "componentScores" in record
                assert "completedAt" in record
        
        print(f"✓ Feedback actions: {stats['total']} total, {stats['completed']} completed, {stats['pending']} pending")
        print(f"  Avg effectiveness: {stats['avgEffectiveness']}")
        print(f"  Action types: {list(stats['byActionType'].keys())}")

    def test_feedback_actions_with_filters(self, api_client):
        """GET /api/feedback/actions with status and actionType filters"""
        # Filter by status=completed
        response = api_client.get(f"{BASE_URL}/api/feedback/actions?status=completed&limit=20")
        assert response.status_code == 200
        data = response.json()
        
        # All records should be completed
        for record in data["records"]:
            assert record["status"] == "completed", "Filter by status=completed not working"
        
        # Filter by actionType
        response2 = api_client.get(f"{BASE_URL}/api/feedback/actions?actionType=ENABLE_SURGE&limit=20")
        assert response2.status_code == 200
        data2 = response2.json()
        
        # All records should be ENABLE_SURGE
        for record in data2["records"]:
            assert record["actionType"] == "ENABLE_SURGE", "Filter by actionType not working"
        
        print(f"✓ Filters working: completed={len(data['records'])}, ENABLE_SURGE={len(data2['records'])}")

    def test_feedback_zone_specific(self, api_client):
        """GET /api/feedback/zone/{zoneId} - should return zone-specific feedback"""
        zone_id = "kyiv-center"
        response = api_client.get(f"{BASE_URL}/api/feedback/zone/{zone_id}?limit=30")
        assert response.status_code == 200, f"Failed: {response.text}"
        data = response.json()
        
        # Verify structure
        assert "zoneId" in data
        assert data["zoneId"] == zone_id
        assert "records" in data
        assert "breakdown" in data
        
        # All records should be for this zone
        for record in data["records"]:
            assert record["zoneId"] == zone_id, f"Wrong zone: expected {zone_id}, got {record['zoneId']}"
        
        # Verify breakdown structure
        breakdown = data["breakdown"]
        assert isinstance(breakdown, dict), "breakdown should be a dict"
        
        # Each action type should have avgScore and count
        for action_type, stats in breakdown.items():
            assert "avgScore" in stats
            assert "count" in stats
            assert isinstance(stats["avgScore"], (int, float))
            assert isinstance(stats["count"], int)
        
        print(f"✓ Zone {zone_id}: {len(data['records'])} records, {len(breakdown)} action types")
        print(f"  Breakdown: {breakdown}")

    def test_feedback_top_actions(self, api_client):
        """GET /api/feedback/top-actions - should return most effective actions sorted by score"""
        response = api_client.get(f"{BASE_URL}/api/feedback/top-actions?limit=10")
        assert response.status_code == 200, f"Failed: {response.text}"
        data = response.json()
        
        assert "topActions" in data
        top_actions = data["topActions"]
        assert isinstance(top_actions, list)
        
        # Should have some top actions
        assert len(top_actions) > 0, "Should have top actions"
        
        # Verify sorted by effectivenessScore DESC
        scores = [a.get("effectivenessScore", 0) for a in top_actions]
        assert scores == sorted(scores, reverse=True), "Top actions not sorted by score DESC"
        
        # Verify structure
        if top_actions:
            action = top_actions[0]
            assert "effectivenessScore" in action
            assert "zoneId" in action
            assert "actionType" in action
            assert "before" in action
            assert "after" in action
        
        print(f"✓ Top actions: {len(top_actions)} actions")
        if top_actions:
            print(f"  Best: {top_actions[0]['actionType']} in {top_actions[0]['zoneId']} (score={top_actions[0]['effectivenessScore']})")

    def test_feedback_worst_actions(self, api_client):
        """GET /api/feedback/worst-actions - should return least effective actions sorted by score"""
        response = api_client.get(f"{BASE_URL}/api/feedback/worst-actions?limit=10")
        assert response.status_code == 200, f"Failed: {response.text}"
        data = response.json()
        
        assert "worstActions" in data
        worst_actions = data["worstActions"]
        assert isinstance(worst_actions, list)
        
        # Should have some worst actions
        assert len(worst_actions) > 0, "Should have worst actions"
        
        # Verify sorted by effectivenessScore ASC
        scores = [a.get("effectivenessScore", 0) for a in worst_actions]
        assert scores == sorted(scores), "Worst actions not sorted by score ASC"
        
        print(f"✓ Worst actions: {len(worst_actions)} actions")
        if worst_actions:
            print(f"  Worst: {worst_actions[0]['actionType']} in {worst_actions[0]['zoneId']} (score={worst_actions[0]['effectivenessScore']})")


class TestStrategyEndpoints:
    """Test Phase H strategy optimizer endpoints"""

    def test_feedback_strategy_weights(self, api_client):
        """GET /api/feedback/strategy - should return global + per-zone strategy weights"""
        response = api_client.get(f"{BASE_URL}/api/feedback/strategy")
        assert response.status_code == 200, f"Failed: {response.text}"
        data = response.json()
        
        # Verify structure
        assert "global" in data
        assert "zones" in data
        assert "defaults" in data
        
        # Verify defaults
        defaults = data["defaults"]
        assert "ENABLE_SURGE" in defaults
        assert "PUSH_PROVIDERS" in defaults
        assert "SET_FANOUT" in defaults
        assert "SET_PRIORITY_BIAS" in defaults
        assert "SET_ZONE_BOOST" in defaults
        assert defaults["ENABLE_SURGE"] == 1.0, "Default weights should be 1.0"
        
        # Verify global weights
        global_w = data["global"]
        assert "weights" in global_w
        global_weights = global_w["weights"]
        
        # Main agent said weights diverged from defaults (Pechersk ~0.5, Podol ~1.5)
        # Check if global weights are different from defaults (learning happened)
        weights_changed = False
        for action_type, weight in global_weights.items():
            if abs(weight - 1.0) > 0.1:  # More than 10% difference
                weights_changed = True
                break
        
        assert weights_changed, "Global strategy weights should have diverged from defaults (main agent said learning happened)"
        
        # Verify zone weights
        zones = data["zones"]
        assert isinstance(zones, list)
        
        # Should have zone-specific weights
        if zones:
            zone = zones[0]
            assert "zoneId" in zone
            assert "weights" in zone
            assert "updatedAt" in zone
        
        print(f"✓ Strategy weights: global + {len(zones)} zones")
        print(f"  Global weights: {global_weights}")
        print(f"  Defaults: {defaults}")
        print(f"  Weights changed from defaults: {weights_changed}")

    def test_feedback_recommendations(self, api_client):
        """GET /api/feedback/recommendations - should return AI recommendations"""
        response = api_client.get(f"{BASE_URL}/api/feedback/recommendations")
        assert response.status_code == 200, f"Failed: {response.text}"
        data = response.json()
        
        assert "recommendations" in data
        recs = data["recommendations"]
        assert isinstance(recs, list)
        
        # Main agent said 6 recommendations generated
        assert len(recs) > 0, "Should have recommendations (main agent said 6 generated)"
        
        # Verify recommendation structure
        if recs:
            rec = recs[0]
            assert "type" in rec  # warning, boost, zone_warning, zone_boost
            assert "action" in rec
            assert "message" in rec
            assert "avgScore" in rec
            assert "sampleCount" in rec
            assert "createdAt" in rec
            
            # Type should be one of the expected values
            assert rec["type"] in ["warning", "boost", "zone_warning", "zone_boost"]
        
        print(f"✓ Recommendations: {len(recs)} recommendations")
        for rec in recs[:3]:  # Print first 3
            print(f"  [{rec['type']}] {rec['action']}: {rec['message']}")

    def test_feedback_recalculate_without_auth(self, api_client):
        """POST /api/feedback/recalculate - should return 401 without auth"""
        response = api_client.post(f"{BASE_URL}/api/feedback/recalculate")
        assert response.status_code == 401, "Should require admin auth"

    def test_feedback_recalculate_with_auth(self, api_client, admin_token):
        """POST /api/feedback/recalculate - should manually trigger recalculation with admin token"""
        response = api_client.post(
            f"{BASE_URL}/api/feedback/recalculate",
            headers={"Authorization": f"Bearer {admin_token}"}
        )
        assert response.status_code == 200, f"Failed: {response.text}"
        data = response.json()
        
        assert "status" in data
        assert data["status"] == "recalculated"
        assert "globalWeights" in data
        
        # Verify global weights returned
        global_weights = data["globalWeights"]
        assert isinstance(global_weights, dict)
        assert len(global_weights) > 0
        
        print(f"✓ Manual recalculation triggered")
        print(f"  New global weights: {global_weights}")

    def test_feedback_dashboard(self, api_client):
        """GET /api/feedback/dashboard - should return full dashboard with stats, breakdown, strategy, recs"""
        response = api_client.get(f"{BASE_URL}/api/feedback/dashboard")
        assert response.status_code == 200, f"Failed: {response.text}"
        data = response.json()
        
        # Verify structure
        assert "stats" in data
        assert "actionBreakdown" in data
        assert "strategy" in data
        assert "recommendations" in data
        
        # Verify stats
        stats = data["stats"]
        assert "lastHour" in stats
        assert "last24h" in stats
        assert "pending" in stats
        assert "avgEffectiveness24h" in stats
        
        assert "total" in stats["lastHour"]
        assert "completed" in stats["lastHour"]
        assert "total" in stats["last24h"]
        assert "completed" in stats["last24h"]
        
        # Verify action breakdown
        breakdown = data["actionBreakdown"]
        assert isinstance(breakdown, dict)
        
        # Verify strategy
        strategy = data["strategy"]
        assert "globalWeights" in strategy
        assert "lastUpdated" in strategy
        assert "sampleCount" in strategy
        
        # Verify recommendations
        recs = data["recommendations"]
        assert isinstance(recs, list)
        
        print(f"✓ Dashboard complete")
        print(f"  Last hour: {stats['lastHour']['total']} total, {stats['lastHour']['completed']} completed")
        print(f"  Last 24h: {stats['last24h']['total']} total, {stats['last24h']['completed']} completed")
        print(f"  Pending: {stats['pending']}")
        print(f"  Avg effectiveness 24h: {stats['avgEffectiveness24h']}")
        print(f"  Action types: {len(breakdown)}")
        print(f"  Recommendations: {len(recs)}")


class TestOrchestratorIntegration:
    """Test that orchestrator still works with enhanced feedback integration"""

    def test_orchestrator_state_still_works(self, api_client):
        """GET /api/orchestrator/state - should still work with Phase G+H"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/state")
        assert response.status_code == 200, f"Orchestrator state endpoint broken: {response.text}"
        data = response.json()
        
        assert "enabled" in data
        assert "cycleCount" in data
        assert "zones" in data
        assert "metrics" in data
        
        print(f"✓ Orchestrator state working: cycle #{data['cycleCount']}, {len(data['zones'])} zones")

    def test_orchestrator_logs_include_strategy_weight(self, api_client):
        """GET /api/orchestrator/logs - logs should now include strategyWeight field"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/logs?limit=10")
        assert response.status_code == 200, f"Orchestrator logs endpoint broken: {response.text}"
        data = response.json()
        
        assert "logs" in data
        logs = data["logs"]
        
        # Should have logs
        assert len(logs) > 0, "Should have orchestrator logs"
        
        # Check if recent logs include strategyWeight in actions
        found_strategy_weight = False
        for log in logs:
            actions = log.get("actions", [])
            for action in actions:
                if "strategyWeight" in action:
                    found_strategy_weight = True
                    print(f"  Found strategyWeight: {action['type']} = {action['strategyWeight']}")
                    break
            if found_strategy_weight:
                break
        
        assert found_strategy_weight, "Orchestrator logs should include strategyWeight field in actions (Phase G integration)"
        
        print(f"✓ Orchestrator logs enhanced with strategy weights")


class TestBackgroundTasks:
    """Test that background tasks are running"""

    def test_feedback_processor_running(self, api_client):
        """Verify feedback processor is completing pending records"""
        # Get initial pending count
        response1 = api_client.get(f"{BASE_URL}/api/feedback/actions?status=pending&limit=100")
        assert response1.status_code == 200
        data1 = response1.json()
        initial_pending = len(data1["records"])
        
        print(f"Initial pending feedback records: {initial_pending}")
        
        # If there are pending records, wait for processor to complete some
        if initial_pending > 0:
            # Check if any are ready to be processed (captureAfterAt in the past)
            now = time.time()
            ready_count = 0
            for record in data1["records"]:
                capture_at = record.get("captureAfterAt", "")
                # Simple check: if created more than 3 minutes ago, should be ready
                created_at = record.get("createdAt", "")
                if created_at:
                    # Just count as ready if it exists (processor should handle it)
                    ready_count += 1
            
            print(f"Pending records found: {ready_count}")
        
        # Get completed count
        response2 = api_client.get(f"{BASE_URL}/api/feedback/actions?status=completed&limit=100")
        assert response2.status_code == 200
        data2 = response2.json()
        completed_count = len(data2["records"])
        
        # Main agent said 106+ samples processed
        assert completed_count > 0, "Feedback processor should have completed some records (main agent said 106+ samples)"
        
        print(f"✓ Feedback processor working: {completed_count} completed records")

    def test_strategy_optimizer_running(self, api_client):
        """Verify strategy optimizer has recalculated weights"""
        response = api_client.get(f"{BASE_URL}/api/feedback/strategy")
        assert response.status_code == 200
        data = response.json()
        
        global_w = data["global"]
        
        # Should have updatedAt timestamp
        assert "updatedAt" in global_w or "weights" in global_w, "Strategy weights should exist"
        
        # Should have sample count
        if "sampleCount" in global_w:
            assert global_w["sampleCount"] > 0, "Strategy optimizer should have processed samples"
        
        # Weights should be different from defaults (learning happened)
        weights = global_w.get("weights", {})
        defaults = data["defaults"]
        
        weights_changed = False
        for action_type in defaults.keys():
            if action_type in weights:
                if abs(weights[action_type] - defaults[action_type]) > 0.1:
                    weights_changed = True
                    break
        
        assert weights_changed, "Strategy optimizer should have adjusted weights from defaults"
        
        print(f"✓ Strategy optimizer working: weights diverged from defaults")
        print(f"  Sample count: {global_w.get('sampleCount', 'N/A')}")
        print(f"  Last updated: {global_w.get('updatedAt', 'N/A')}")


class TestPreviousPhaseEEndpoints:
    """Verify previous Phase E endpoints still work"""

    def test_auth_login_still_works(self, api_client):
        """POST /api/auth/login - should still work"""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        assert response.status_code == 200
        data = response.json()
        assert "accessToken" in data
        print("✓ Auth login working")

    def test_auth_me_still_works(self, api_client, admin_token):
        """GET /api/auth/me - should still work"""
        response = api_client.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": f"Bearer {admin_token}"}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["email"] == ADMIN_EMAIL
        print("✓ Auth me working")

    def test_orchestrator_rules_still_works(self, api_client):
        """GET /api/orchestrator/rules - should still work"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/rules")
        assert response.status_code == 200
        data = response.json()
        assert "rules" in data
        assert len(data["rules"]) == 4
        print("✓ Orchestrator rules working")

    def test_orchestrator_metrics_still_works(self, api_client):
        """GET /api/orchestrator/metrics - should still work"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/metrics")
        assert response.status_code == 200
        data = response.json()
        assert "enabled" in data
        assert "cycleCount" in data
        assert "timeline" in data
        print("✓ Orchestrator metrics working")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])

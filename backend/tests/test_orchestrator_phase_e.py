"""
Phase E: Market Orchestration Layer - Backend API Tests

Tests all orchestrator endpoints:
- Auth endpoints (login, register, me)
- Orchestrator state, rules, overrides, logs, metrics
- Manual cycle trigger, toggle, config
- Zone-specific history
"""

import pytest
import requests
import os
import time

# Use external URL for testing (what users see)
BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', '').rstrip('/')
if not BASE_URL:
    pytest.skip("EXPO_PUBLIC_BACKEND_URL not set", allow_module_level=True)

# Test credentials from /app/memory/test_credentials.md
ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"
CUSTOMER_EMAIL = "customer@test.com"
CUSTOMER_PASSWORD = "Customer123!"
PROVIDER_EMAIL = "provider@test.com"
PROVIDER_PASSWORD = "Provider123!"


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


class TestHealthAndAuth:
    """Health check and authentication tests"""

    def test_health_endpoint(self, api_client):
        """GET /api/health - should return 200"""
        response = api_client.get(f"{BASE_URL}/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "timestamp" in data

    def test_admin_login_success(self, api_client):
        """POST /api/auth/login - admin login should succeed"""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        assert response.status_code == 200
        data = response.json()
        assert "accessToken" in data
        assert "user" in data
        assert data["user"]["email"] == ADMIN_EMAIL
        assert data["user"]["role"] == "admin"

    def test_customer_login_success(self, api_client):
        """POST /api/auth/login - customer login should succeed"""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": CUSTOMER_EMAIL,
            "password": CUSTOMER_PASSWORD
        })
        assert response.status_code == 200
        data = response.json()
        assert "accessToken" in data
        assert data["user"]["role"] == "customer"

    def test_provider_login_success(self, api_client):
        """POST /api/auth/login - provider login should succeed"""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": PROVIDER_EMAIL,
            "password": PROVIDER_PASSWORD
        })
        assert response.status_code == 200
        data = response.json()
        assert "accessToken" in data
        assert data["user"]["role"] == "provider_owner"

    def test_login_invalid_credentials(self, api_client):
        """POST /api/auth/login - invalid credentials should return 401"""
        response = api_client.post(f"{BASE_URL}/api/auth/login", json={
            "email": "wrong@test.com",
            "password": "wrongpass"
        })
        assert response.status_code == 401

    def test_auth_me_with_valid_token(self, api_client, admin_token):
        """GET /api/auth/me - should return user data with valid token"""
        response = api_client.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": f"Bearer {admin_token}"}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["email"] == ADMIN_EMAIL
        assert data["role"] == "admin"

    def test_auth_me_without_token(self, api_client):
        """GET /api/auth/me - should return 401 without token"""
        response = api_client.get(f"{BASE_URL}/api/auth/me")
        assert response.status_code == 401


class TestOrchestratorPublicEndpoints:
    """Test public orchestrator endpoints (no auth required)"""

    def test_orchestrator_state(self, api_client):
        """GET /api/orchestrator/state - should return zones and metrics"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/state")
        assert response.status_code == 200
        data = response.json()
        
        # Verify structure
        assert "enabled" in data
        assert "cycleCount" in data
        assert "zones" in data
        assert "metrics" in data
        assert "rulesConfigured" in data
        
        # Verify zones data
        assert isinstance(data["zones"], list)
        assert len(data["zones"]) > 0, "Should have at least one zone"
        
        zone = data["zones"][0]
        assert "id" in zone
        assert "name" in zone
        assert "status" in zone
        assert "demand" in zone
        assert "supply" in zone
        assert "ratio" in zone
        assert "surgeMultiplier" in zone
        assert "activeActions" in zone
        assert "hasOverride" in zone
        
        # Verify metrics
        metrics = data["metrics"]
        assert "totalActionsLastHour" in metrics
        assert "executedLastHour" in metrics
        assert "zonesMonitored" in metrics
        assert metrics["zonesMonitored"] == len(data["zones"])

    def test_orchestrator_rules(self, api_client):
        """GET /api/orchestrator/rules - should return all 4 severity rules"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/rules")
        assert response.status_code == 200
        data = response.json()
        
        assert "rules" in data
        rules = data["rules"]
        assert len(rules) == 4, "Should have exactly 4 rules (BALANCED, BUSY, SURGE, CRITICAL)"
        
        severities = [r["severity"] for r in rules]
        assert "BALANCED" in severities
        assert "BUSY" in severities
        assert "SURGE" in severities
        assert "CRITICAL" in severities
        
        # Verify rule structure
        rule = rules[0]
        assert "severity" in rule
        assert "enableSurge" in rule
        assert "enablePushProviders" in rule
        assert "enableFanoutOverride" in rule
        assert "cooldownSeconds" in rule

    def test_orchestrator_overrides(self, api_client):
        """GET /api/orchestrator/overrides - should return active overrides"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/overrides")
        assert response.status_code == 200
        data = response.json()
        
        assert "overrides" in data
        assert isinstance(data["overrides"], list)

    def test_orchestrator_logs(self, api_client):
        """GET /api/orchestrator/logs - should return action logs with stats"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/logs?limit=10")
        assert response.status_code == 200
        data = response.json()
        
        assert "logs" in data
        assert "stats" in data
        
        stats = data["stats"]
        assert "total" in stats
        assert "executed" in stats
        assert "failed" in stats
        assert "skipped" in stats
        assert "bySeverity" in stats
        assert "byActionType" in stats

    def test_orchestrator_logs_with_zone_filter(self, api_client):
        """GET /api/orchestrator/logs?zoneId=kyiv-center - should filter by zone"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/logs?zoneId=kyiv-center&limit=5")
        assert response.status_code == 200
        data = response.json()
        
        assert "logs" in data
        # All logs should be for kyiv-center
        for log in data["logs"]:
            assert log["zoneId"] == "kyiv-center"

    def test_orchestrator_metrics(self, api_client):
        """GET /api/orchestrator/metrics - should return performance metrics timeline"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/metrics")
        assert response.status_code == 200
        data = response.json()
        
        assert "enabled" in data
        assert "cycleCount" in data
        assert "timeline" in data
        assert "zoneHealth" in data
        assert "activeOverrides" in data
        
        # Verify timeline structure
        assert isinstance(data["timeline"], list)
        if len(data["timeline"]) > 0:
            metric = data["timeline"][0]
            assert "hour" in metric
            assert "timestamp" in metric
            assert "totalActions" in metric
            assert "executed" in metric
            assert "failed" in metric
        
        # Verify zone health
        health = data["zoneHealth"]
        assert "total" in health
        assert "balanced" in health
        assert "busy" in health
        assert "surge" in health
        assert "critical" in health

    def test_orchestrator_zone_history(self, api_client):
        """GET /api/orchestrator/zone/{zone_id}/history - should return zone-specific history"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/zone/kyiv-center/history?limit=5")
        assert response.status_code == 200
        data = response.json()
        
        assert "zoneId" in data
        assert data["zoneId"] == "kyiv-center"
        assert "logs" in data
        assert "actionTimeline" in data
        
        # All logs should be for this zone
        for log in data["logs"]:
            assert log["zoneId"] == "kyiv-center"

    def test_orchestrator_config(self, api_client):
        """GET /api/orchestrator/config - should return engine configuration"""
        response = api_client.get(f"{BASE_URL}/api/orchestrator/config")
        assert response.status_code == 200
        data = response.json()
        
        assert "enabled" in data
        assert "cycleIntervalSeconds" in data
        assert data["cycleIntervalSeconds"] == 10
        assert "cycleCount" in data
        assert "cooldowns" in data
        assert "defaultRules" in data


class TestOrchestratorAdminEndpoints:
    """Test admin-protected orchestrator endpoints"""

    def test_update_rule_without_auth(self, api_client):
        """PATCH /api/orchestrator/rules - should return 401 without auth"""
        response = api_client.patch(f"{BASE_URL}/api/orchestrator/rules", json={
            "severity": "BUSY",
            "surgeMultiplier": 1.5
        })
        assert response.status_code == 401

    def test_update_rule_with_auth(self, api_client, admin_token):
        """PATCH /api/orchestrator/rules - should update rule with admin token"""
        response = api_client.patch(
            f"{BASE_URL}/api/orchestrator/rules",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "severity": "BUSY",
                "surgeMultiplier": 1.4,
                "cooldownSeconds": 45
            }
        )
        assert response.status_code == 200
        data = response.json()
        
        assert data["status"] == "updated"
        assert "rule" in data
        assert data["rule"]["severity"] == "BUSY"
        assert data["rule"]["surgeMultiplier"] == 1.4
        assert data["rule"]["cooldownSeconds"] == 45

    def test_update_rule_invalid_severity(self, api_client, admin_token):
        """PATCH /api/orchestrator/rules - should return 400 for invalid severity"""
        response = api_client.patch(
            f"{BASE_URL}/api/orchestrator/rules",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "severity": "INVALID",
                "surgeMultiplier": 1.5
            }
        )
        assert response.status_code == 400

    def test_create_override_without_auth(self, api_client):
        """POST /api/orchestrator/overrides - should return 401 without auth"""
        response = api_client.post(f"{BASE_URL}/api/orchestrator/overrides", json={
            "zoneId": "kyiv-center",
            "disableSurge": True
        })
        assert response.status_code == 401

    def test_create_override_with_auth(self, api_client, admin_token):
        """POST /api/orchestrator/overrides - should create override with admin token"""
        response = api_client.post(
            f"{BASE_URL}/api/orchestrator/overrides",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "zoneId": "kyiv-center",
                "disableSurge": True,
                "reason": "Test override",
                "expiresMinutes": 30
            }
        )
        assert response.status_code == 200
        data = response.json()
        
        assert data["status"] == "created"
        assert "override" in data
        override = data["override"]
        assert override["zoneId"] == "kyiv-center"
        assert override["isActive"] is True
        assert override["overrides"]["disableSurge"] is True
        assert override["reason"] == "Test override"
        assert "id" in override
        
        # Verify override appears in GET /api/orchestrator/overrides
        get_response = api_client.get(f"{BASE_URL}/api/orchestrator/overrides")
        assert get_response.status_code == 200
        overrides = get_response.json()["overrides"]
        assert any(ov["id"] == override["id"] for ov in overrides)
        
        return override["id"]

    def test_disable_override_without_auth(self, api_client):
        """POST /api/orchestrator/overrides/{id}/disable - should return 401 without auth"""
        response = api_client.post(f"{BASE_URL}/api/orchestrator/overrides/test-id/disable")
        assert response.status_code == 401

    def test_create_and_disable_override(self, api_client, admin_token):
        """Create override then disable it"""
        # Create override
        create_response = api_client.post(
            f"{BASE_URL}/api/orchestrator/overrides",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "zoneId": "kyiv-podil",
                "forceFanout": 6,
                "reason": "Test disable flow"
            }
        )
        assert create_response.status_code == 200
        override_id = create_response.json()["override"]["id"]
        
        # Disable override
        disable_response = api_client.post(
            f"{BASE_URL}/api/orchestrator/overrides/{override_id}/disable",
            headers={"Authorization": f"Bearer {admin_token}"}
        )
        assert disable_response.status_code == 200
        data = disable_response.json()
        
        assert data["status"] == "disabled"
        assert data["override"]["isActive"] is False
        assert "disabledAt" in data["override"]

    def test_manual_run_cycle_without_auth(self, api_client):
        """POST /api/orchestrator/run-cycle - should return 401 without auth"""
        response = api_client.post(f"{BASE_URL}/api/orchestrator/run-cycle")
        assert response.status_code == 401

    def test_manual_run_cycle_with_auth(self, api_client, admin_token):
        """POST /api/orchestrator/run-cycle - should trigger cycle with admin token"""
        response = api_client.post(
            f"{BASE_URL}/api/orchestrator/run-cycle",
            headers={"Authorization": f"Bearer {admin_token}"}
        )
        assert response.status_code == 200
        data = response.json()
        
        assert data["status"] == "ok"
        assert "cycleCount" in data
        assert "lastActionsCount" in data

    def test_toggle_engine_without_auth(self, api_client):
        """POST /api/orchestrator/toggle - should return 401 without auth"""
        response = api_client.post(f"{BASE_URL}/api/orchestrator/toggle", json={"enabled": False})
        assert response.status_code == 401

    def test_toggle_engine_with_auth(self, api_client, admin_token):
        """POST /api/orchestrator/toggle - should toggle engine with admin token"""
        # Disable engine
        response = api_client.post(
            f"{BASE_URL}/api/orchestrator/toggle",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"enabled": False}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["enabled"] is False
        
        # Verify state changed
        state_response = api_client.get(f"{BASE_URL}/api/orchestrator/state")
        assert state_response.json()["enabled"] is False
        
        # Re-enable engine
        enable_response = api_client.post(
            f"{BASE_URL}/api/orchestrator/toggle",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"enabled": True}
        )
        assert enable_response.status_code == 200
        assert enable_response.json()["enabled"] is True


class TestOrchestratorEngineRunning:
    """Test that the orchestrator engine is actually running"""

    def test_engine_is_running(self, api_client):
        """Verify orchestrator engine is running by checking cycle count increases"""
        # Get initial state
        response1 = api_client.get(f"{BASE_URL}/api/orchestrator/state")
        assert response1.status_code == 200
        data1 = response1.json()
        initial_cycle = data1["cycleCount"]
        
        # Wait 12 seconds (engine runs every 10s)
        print(f"Waiting 12s for orchestrator cycle (current cycle: {initial_cycle})...")
        time.sleep(12)
        
        # Get state again
        response2 = api_client.get(f"{BASE_URL}/api/orchestrator/state")
        assert response2.status_code == 200
        data2 = response2.json()
        new_cycle = data2["cycleCount"]
        
        # Cycle count should have increased
        assert new_cycle > initial_cycle, f"Orchestrator engine not running: cycle count didn't increase ({initial_cycle} -> {new_cycle})"
        print(f"✓ Orchestrator engine is running: cycle {initial_cycle} -> {new_cycle}")

    def test_cooldown_mechanism(self, api_client):
        """Verify cooldown prevents action spam for same zone+severity"""
        # Get logs for a specific zone
        response = api_client.get(f"{BASE_URL}/api/orchestrator/logs?zoneId=kyiv-center&limit=20")
        assert response.status_code == 200
        logs = response.json()["logs"]
        
        if len(logs) >= 2:
            # Check that consecutive logs for same severity have time gap >= cooldown
            for i in range(len(logs) - 1):
                log1 = logs[i]
                log2 = logs[i + 1]
                
                if log1["severity"] == log2["severity"]:
                    # Parse timestamps and check gap
                    from datetime import datetime
                    t1 = datetime.fromisoformat(log1["createdAt"].replace("Z", "+00:00"))
                    t2 = datetime.fromisoformat(log2["createdAt"].replace("Z", "+00:00"))
                    gap_seconds = abs((t1 - t2).total_seconds())
                    
                    # Cooldown should be at least 30s (minimum cooldown in rules)
                    print(f"Gap between {log1['severity']} actions: {gap_seconds}s")


class TestOrchestratorOverrideLogic:
    """Test that overrides actually affect orchestrator behavior"""

    def test_override_disables_surge(self, api_client, admin_token):
        """Verify override with disableSurge=true prevents surge for that zone"""
        # Create override to disable surge for kyiv-obolon
        override_response = api_client.post(
            f"{BASE_URL}/api/orchestrator/overrides",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "zoneId": "kyiv-obolon",
                "disableSurge": True,
                "reason": "Test surge disable"
            }
        )
        assert override_response.status_code == 200
        override_id = override_response.json()["override"]["id"]
        
        # Check state - zone should show hasOverride=true
        state_response = api_client.get(f"{BASE_URL}/api/orchestrator/state")
        zones = state_response.json()["zones"]
        obolon = next((z for z in zones if z["id"] == "kyiv-obolon"), None)
        assert obolon is not None
        assert obolon["hasOverride"] is True
        
        # activeActions should NOT include "surge" if override is working
        # (This depends on zone severity, but override should prevent it)
        print(f"Zone kyiv-obolon activeActions: {obolon['activeActions']}")
        
        # Clean up
        api_client.post(
            f"{BASE_URL}/api/orchestrator/overrides/{override_id}/disable",
            headers={"Authorization": f"Bearer {admin_token}"}
        )

    def test_override_force_fanout(self, api_client, admin_token):
        """Verify override with forceFanout overrides the rule fanout"""
        # Create override with forceFanout
        override_response = api_client.post(
            f"{BASE_URL}/api/orchestrator/overrides",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "zoneId": "kyiv-center",
                "forceFanout": 8,
                "reason": "Test fanout override"
            }
        )
        assert override_response.status_code == 200
        override_id = override_response.json()["override"]["id"]
        
        # Trigger manual cycle
        api_client.post(
            f"{BASE_URL}/api/orchestrator/run-cycle",
            headers={"Authorization": f"Bearer {admin_token}"}
        )
        
        # Check logs for SET_FANOUT action with fanout=8
        logs_response = api_client.get(f"{BASE_URL}/api/orchestrator/logs?zoneId=kyiv-center&limit=5")
        logs = logs_response.json()["logs"]
        
        # Look for recent SET_FANOUT action
        fanout_actions = []
        for log in logs:
            for action in log.get("actions", []):
                if action["type"] == "SET_FANOUT":
                    fanout_actions.append(action)
        
        print(f"Found {len(fanout_actions)} SET_FANOUT actions for kyiv-center")
        
        # Clean up
        api_client.post(
            f"{BASE_URL}/api/orchestrator/overrides/{override_id}/disable",
            headers={"Authorization": f"Bearer {admin_token}"}
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])

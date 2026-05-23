"""Inline smoke-test для C14 ML guard.

Проверяет:
  1. is_valid_prediction — NaN/Inf/negative/huge/None → False; 5.0 → True.
  2. predict_demand — при падении ML и EWMA → возвращает 0.0, не пробрасывает.
  3. predict_demand — при ML=NaN → fallback на EWMA.
  4. trigger_pre_engagement — при pressure=NaN/predicted<0 → None, no-op.
  5. trigger_pre_engagement — happy path — создаёт event.
  6. predict_with_interval — при model.predict=NaN → None.
"""
from __future__ import annotations
import asyncio
import math
import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.ml.predictor import (
    is_valid_prediction,
    predict_demand,
    DemandPredictor,
    _predict_demand_ewma,
)
from app.orchestrator.pre_engagement import trigger_pre_engagement, pre_engagement_cooldowns


async def run():
    failures = []

    # 1. is_valid_prediction
    cases = [
        (None, False),
        (float("nan"), False),
        (float("inf"), False),
        (float("-inf"), False),
        (-1.0, False),
        (10001.0, False),  # > MAX_SANE_PREDICTION
        ("abc", False),
        (5.0, True),
        (0, True),
        (0.0, True),
        (499.9, True),
    ]
    for val, expected in cases:
        got = is_valid_prediction(val)
        if got != expected:
            failures.append(f"is_valid_prediction({val!r}) expected={expected} got={got}")
    print(f"[1] is_valid_prediction: {len(cases) - len([f for f in failures if 'is_valid' in f])}/{len(cases)} passed")

    # 2. predict_demand — ML raises, EWMA raises → 0.0
    async def ml_raise(zid):
        raise RuntimeError("simulated ML failure")

    async def ewma_raise(zid):
        raise RuntimeError("simulated EWMA failure")

    with patch.object(DemandPredictor, "predict", side_effect=ml_raise), \
         patch("app.ml.predictor._predict_demand_ewma", side_effect=ewma_raise):
        result = await predict_demand("test-zone")
    if result != 0.0:
        failures.append(f"predict_demand all-fail expected 0.0, got {result}")
    print(f"[2] predict_demand all-fail → 0.0: {'PASS' if result == 0.0 else 'FAIL got=' + str(result)}")

    # 3. predict_demand — ML returns NaN → fallback to EWMA (which returns 7.5)
    async def ml_nan(zid):
        return float("nan")

    async def ewma_ok(zid):
        return 7.5

    with patch.object(DemandPredictor, "predict", side_effect=ml_nan), \
         patch("app.ml.predictor._predict_demand_ewma", side_effect=ewma_ok):
        result = await predict_demand("test-zone")
    if result != 7.5:
        failures.append(f"predict_demand ML=NaN+EWMA=7.5 expected 7.5, got {result}")
    print(f"[3] predict_demand ML=NaN → EWMA fallback: {'PASS' if result == 7.5 else 'FAIL got=' + str(result)}")

    # 4. trigger_pre_engagement — invalid pressure → None
    zone = {"id": "zone-invalid", "name": "Test"}
    pre_engagement_cooldowns.clear()

    r_nan = await trigger_pre_engagement(zone, float("nan"), 10.0, 2)
    if r_nan is not None:
        failures.append("trigger_pre_engagement pressure=NaN should return None")

    r_neg = await trigger_pre_engagement(zone, 1.5, -5.0, 2)
    if r_neg is not None:
        failures.append("trigger_pre_engagement predicted=-5 should return None")

    r_zero_supply = await trigger_pre_engagement(zone, 1.5, 10.0, 0)
    if r_zero_supply is not None:
        failures.append("trigger_pre_engagement supply=0 should return None")

    print(f"[4] trigger_pre_engagement guards: {'PASS' if r_nan is None and r_neg is None and r_zero_supply is None else 'FAIL'}")

    # 5. trigger_pre_engagement — happy path должен создать event и сохранить в cooldowns
    pre_engagement_cooldowns.clear()
    # Мокаем db.pre_engagement_events.insert_one + emit_realtime_event.
    # Патчим через прямую подмену атрибутов модуля (patch() не работает с _DBProxy
    # — тот raises RuntimeError при любом getattr до инициализации).
    import app.orchestrator.pre_engagement as pe_module
    insert_called = {"n": 0}

    async def fake_insert(doc):
        insert_called["n"] += 1
        return MagicMock(inserted_id="x")

    async def fake_emit(*a, **kw):
        return None

    fake_db_pe = MagicMock()
    fake_db_pe.pre_engagement_events.insert_one = fake_insert

    orig_db = pe_module.db
    orig_emit = pe_module.emit_realtime_event
    pe_module.db = fake_db_pe
    pe_module.emit_realtime_event = fake_emit
    try:
        r_ok = await trigger_pre_engagement({"id": "zone-ok", "name": "OK"}, 1.5, 10.0, 2)
    finally:
        pe_module.db = orig_db
        pe_module.emit_realtime_event = orig_emit

    if r_ok is None:
        failures.append("trigger_pre_engagement happy-path returned None")
    if insert_called["n"] != 1:
        failures.append(f"trigger_pre_engagement happy-path insert_one called {insert_called['n']} times, expected 1")
    print(f"[5] trigger_pre_engagement happy-path: {'PASS' if r_ok is not None and insert_called['n'] == 1 else 'FAIL'}")

    # 6. predict_with_interval — model returns NaN → None (guard внутри метода)
    class FakeNaNModel:
        def predict(self, X):
            return [float("nan")]

    # Sub in fake model and snapshots
    DemandPredictor.models["fake-zone"] = FakeNaNModel()
    DemandPredictor.metadata["fake-zone"] = {"residualStd": 1.0}

    fake_snaps = [
        {"demand": 5, "supply": 3, "ratio": 1.0, "surge": 1.0, "timestamp": "2026-04-28T12:00:00+00:00"},
        {"demand": 4, "supply": 3, "ratio": 1.0, "surge": 1.0, "timestamp": "2026-04-28T11:59:00+00:00"},
        {"demand": 6, "supply": 3, "ratio": 1.0, "surge": 1.0, "timestamp": "2026-04-28T11:58:00+00:00"},
        {"demand": 5, "supply": 3, "ratio": 1.0, "surge": 1.0, "timestamp": "2026-04-28T11:57:00+00:00"},
    ]

    class FakeCursor:
        def sort(self, *a, **kw):
            return self
        async def to_list(self, n):
            return fake_snaps

    class FakeCollection:
        def find(self, *a, **kw):
            return FakeCursor()

    fake_db = MagicMock()
    fake_db.zone_snapshots = FakeCollection()

    import app.ml.predictor as predictor_module
    orig_db_ml = predictor_module.db
    orig_beh = predictor_module._compute_behavioral_signals
    predictor_module.db = fake_db

    async def fake_behavior():
        return {"accept_rate": 0.7, "cancel_rate": 0.1, "avg_response_h": 0.5}

    predictor_module._compute_behavioral_signals = fake_behavior
    try:
        result = await DemandPredictor.predict_with_interval("fake-zone")
    finally:
        predictor_module.db = orig_db_ml
        predictor_module._compute_behavioral_signals = orig_beh

    if result is not None:
        failures.append(f"predict_with_interval NaN should return None, got {result}")
    print(f"[6] predict_with_interval NaN → None: {'PASS' if result is None else 'FAIL got=' + str(result)}")

    # Clean up
    DemandPredictor.models.pop("fake-zone", None)
    DemandPredictor.metadata.pop("fake-zone", None)

    # Summary
    print("\n" + "=" * 60)
    if failures:
        print(f"❌ {len(failures)} failures:")
        for f in failures:
            print(f"   - {f}")
        sys.exit(1)
    else:
        print("✅ All C14 guard tests PASSED")
        sys.exit(0)


if __name__ == "__main__":
    asyncio.run(run())

"""app.admin.forecast — Sprint 21 C12A.

Admin forecast endpoints (2, Sprint 19+20 DemandPredictor):
  GET  /api/admin/forecast/status    — обученные модели, MAE, P10/P50/P90
  POST /api/admin/forecast/retrain   — принудительно переобучить все зоны

Логика 1-в-1 из server.py. Зависимости (`SKLEARN_OK`, `DemandPredictor`,
`_predict_demand_ewma`, `_compute_behavioral_signals`) живут пока в server.py.
Runtime-import внутри функций безопасен (endpoints вызываются после полной
загрузки server.py).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.db import db
from app.core.security import verify_admin_token


router = APIRouter()


@router.get("/api/admin/forecast/status")
async def admin_forecast_status(_=Depends(verify_admin_token)):
    """
    Sprint 19+20: статус DemandPredictor — обученные модели, MAE, residualStd,
    P10/P50/P90 предсказание, behavioral signals.
    """
    from app.ml.predictor import SKLEARN_OK, DemandPredictor, _compute_behavioral_signals, _predict_demand_ewma

    if not SKLEARN_OK:
        return {"status": "sklearn_unavailable", "models": {}, "fallback": "ewma_only"}

    behavior = await _compute_behavioral_signals()
    zones_doc = await db.zones.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(50)
    out = {}
    for z in zones_doc:
        zid = z["id"]
        meta = DemandPredictor.metadata.get(zid, {"status": "not_trained"})
        try:
            interval = await DemandPredictor.predict_with_interval(zid)
        except Exception:
            interval = None
        ewma = await _predict_demand_ewma(zid)
        out[zid] = {
            "name": z.get("name", zid),
            **meta,
            "prediction": interval,                 # {p10, p50, p90, residualStd} или None
            "ewmaBaseline": ewma,
            "predictionSource": "ml" if interval else "ewma",
        }
    return {
        "status": "ok",
        "trainerLastRunAt": DemandPredictor.last_train,
        "trainIntervalSec": DemandPredictor.TRAIN_INTERVAL_S,
        "minSamples": DemandPredictor.MIN_SAMPLES,
        "lag": DemandPredictor.LAG,
        "behavioralSignals": behavior,
        "featureNames": DemandPredictor.FEATURE_NAMES,
        "zones": out,
    }


@router.post("/api/admin/forecast/retrain")
async def admin_forecast_retrain(_=Depends(verify_admin_token)):
    """Принудительно запустить переобучение всех моделей сейчас."""
    from app.ml.predictor import SKLEARN_OK, DemandPredictor

    if not SKLEARN_OK:
        raise HTTPException(status_code=503, detail="sklearn unavailable")
    await DemandPredictor.train_all_zones()
    return {"status": "retrained", "metadata": DemandPredictor.metadata}

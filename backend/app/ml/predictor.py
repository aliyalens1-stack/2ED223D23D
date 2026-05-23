"""app.ml.predictor — Sprint 21 C13.

DemandPredictor (GBM per-zone) + EWMA fallback + behavioral signals aggregator.
Логика 1-в-1 из server.py (Sprint 19+20).

Sprint 21 C14: добавлены guard-ы (is_valid_prediction) для защиты orchestrator
от NaN/Inf/negative предиктов, которые иначе могли бы заспамить pre-engagement.
Поведение happy-path не меняется.
"""
from __future__ import annotations
import asyncio
import base64
import io
import logging
import math
import time
from datetime import datetime, timedelta
from typing import Optional

from app.core.db import db
from app.core.utils import now_utc


logger = logging.getLogger("server")


# ── Sprint 21 C14: prediction validity guard ──
# Максимальное разумное значение спроса (защита от выбросов/бага в модели).
# demand у нас обычно <50 в самых горячих зонах; 500 — это порог «что-то явно
# сломалось», а не «просто пик».
MAX_SANE_PREDICTION = 500.0


def is_valid_prediction(value) -> bool:
    """True, если значение — конечное неотрицательное число в разумных пределах.

    Защищает orchestrator/pre-engagement от NaN, inf, отрицательных и абсурдных
    предиктов (баг модели, плохие фичи и т.п.). При False потребитель должен
    уйти в fallback (EWMA / current demand / noop).
    """
    if value is None:
        return False
    try:
        v = float(value)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(v):
        return False
    if v < 0:
        return False
    if v > MAX_SANE_PREDICTION:
        return False
    return True


# ─── sklearn availability probe (lazy: don't crash import if missing) ──────
try:
    import joblib
    from sklearn.ensemble import GradientBoostingRegressor
    from sklearn.metrics import mean_absolute_error
    import numpy as np
    SKLEARN_OK = True
except Exception as _e:
    SKLEARN_OK = False
    logger.warning(f"sklearn not available, prediction will fallback to EWMA: {_e}")


# ─── Behavioral features cache ─────────────────────────────────────────────
_behavioral_cache: dict = {"computedAt": 0.0, "data": None}
_BEHAVIORAL_CACHE_TTL_S = 60


async def _compute_behavioral_signals() -> dict:
    """Глобальные поведенческие метрики (zoneId в bookings отсутствует).

    Возвращает dict с тремя фичами в [0..1] / [0..N]:
      accept_rate     — confirmed+in_progress+completed / total
      cancel_rate     — cancelled / total
      avg_response_h  — avg часов между createdAt и acceptedAt (или 0 если NA)
    """
    now = time.time()
    if now - _behavioral_cache["computedAt"] < _BEHAVIORAL_CACHE_TTL_S and _behavioral_cache["data"]:
        return _behavioral_cache["data"]

    cutoff = (now_utc() - timedelta(hours=24)).isoformat()
    pipeline = [
        {"$match": {"createdAt": {"$gte": cutoff}}},
        {"$group": {
            "_id": "$status",
            "n": {"$sum": 1},
            "respSum": {"$sum": {"$cond": [
                {"$ne": ["$acceptedAt", None]},
                {"$cond": [
                    {"$and": [{"$ne": ["$createdAt", None]}, {"$ne": ["$acceptedAt", None]}]},
                    {"$divide": [{"$subtract": [
                        {"$dateFromString": {"dateString": "$acceptedAt", "onError": now_utc()}},
                        {"$dateFromString": {"dateString": "$createdAt",  "onError": now_utc()}},
                    ]}, 1000 * 60 * 60]},
                    0,
                ]},
                0,
            ]}},
        }},
    ]
    counts = {"total": 0, "accepted": 0, "cancelled": 0}
    resp_total_h, resp_count = 0.0, 0
    try:
        async for row in db.bookings.aggregate(pipeline):
            n = row.get("n", 0)
            counts["total"] += n
            st = row.get("_id")
            if st in ("confirmed", "in_progress", "on_route", "completed"):
                counts["accepted"] += n
                resp_total_h += float(row.get("respSum", 0) or 0)
                resp_count += n
            elif st == "cancelled":
                counts["cancelled"] += n
    except Exception as e:
        logger.error(f"_compute_behavioral_signals aggregate error: {e}")

    accept_rate = (counts["accepted"] / counts["total"]) if counts["total"] else 0.7
    cancel_rate = (counts["cancelled"] / counts["total"]) if counts["total"] else 0.1
    avg_response_h = (resp_total_h / resp_count) if resp_count else 0.5

    data = {
        "accept_rate": round(min(1.0, max(0.0, accept_rate)), 4),
        "cancel_rate": round(min(1.0, max(0.0, cancel_rate)), 4),
        "avg_response_h": round(max(0.0, min(24.0, avg_response_h)), 4),
        "totalBookings24h": counts["total"],
    }
    _behavioral_cache["computedAt"] = now
    _behavioral_cache["data"] = data
    return data


class DemandPredictor:
    """
    Per-zone GBM forecaster — Sprint 19 (base) + Sprint 20 (production).

    Sprint 20 upgrades:
      • Persistence: модели + residual_std + metadata сохраняются в db.ml_models
        (joblib → base64). При старте процесса load_persisted() гидратирует RAM.
      • Prediction interval: помимо P50 даём P10 / P90 (через std остатков
        на validation set + нормальная аппроксимация).
      • Behavioral features (3 шт): accept_rate, cancel_rate, avg_response_h.
        Читаем из bookings (24h окно, cache 60 с).
    """

    models: dict = {}        # zone_id -> fitted regressor
    metadata: dict = {}      # zone_id -> {trainedAt, mae, n, residualStd, status, lastDemand}
    last_train: float = 0.0
    TRAIN_INTERVAL_S = 300   # 5 мин
    MIN_SAMPLES = 50
    LAG = 3
    WINDOW = 600
    FEATURE_NAMES = [
        "demand_t-1", "demand_t-2", "demand_t-3",
        "supply", "ratio", "surge",
        "sin_hod", "cos_hod", "sin_dow", "cos_dow",
        "accept_rate", "cancel_rate", "avg_response_h",
    ]

    @classmethod
    def _features_for_row(cls, prev: list, supply: float, ratio: float,
                          surge: float, ts: datetime, behavior: dict):
        hour = ts.hour + ts.minute / 60.0
        dow = ts.weekday()
        return [
            *prev,
            float(supply or 0),
            float(ratio or 0),
            float(surge or 1),
            math.sin(2 * math.pi * hour / 24.0),
            math.cos(2 * math.pi * hour / 24.0),
            math.sin(2 * math.pi * dow / 7.0),
            math.cos(2 * math.pi * dow / 7.0),
            float(behavior.get("accept_rate", 0.7)),
            float(behavior.get("cancel_rate", 0.1)),
            float(behavior.get("avg_response_h", 0.5)),
        ]

    # ─── PERSISTENCE ───────────────────────────────────────────────────
    @classmethod
    async def _persist(cls, zone_id: str):
        model = cls.models.get(zone_id)
        meta = cls.metadata.get(zone_id, {})
        if model is None:
            return
        try:
            buf = io.BytesIO()
            joblib.dump(model, buf, compress=3)
            blob = base64.b64encode(buf.getvalue()).decode("ascii")
            await db.ml_models.update_one(
                {"zoneId": zone_id, "kind": "demand_predictor"},
                {"$set": {
                    "model": blob,
                    "modelSizeKb": round(len(blob) / 1024, 1),
                    "trainedAt": meta.get("trainedAt"),
                    "mae": meta.get("mae"),
                    "residualStd": meta.get("residualStd"),
                    "n": meta.get("n"),
                    "lastDemand": meta.get("lastDemand"),
                    "featureNames": cls.FEATURE_NAMES,
                    "version": 2,
                    "updatedAt": now_utc().isoformat(),
                }},
                upsert=True,
            )
        except Exception as e:
            logger.error(f"DemandPredictor persist error for {zone_id}: {e}")

    @classmethod
    async def load_persisted(cls):
        if not SKLEARN_OK:
            return 0
        loaded = 0
        try:
            async for doc in db.ml_models.find({"kind": "demand_predictor"}):
                zid = doc.get("zoneId")
                blob = doc.get("model")
                if not (zid and blob):
                    continue
                try:
                    raw = base64.b64decode(blob)
                    model = joblib.load(io.BytesIO(raw))
                    cls.models[zid] = model
                    cls.metadata[zid] = {
                        "status": "loaded_from_db",
                        "trainedAt": doc.get("trainedAt"),
                        "mae": doc.get("mae"),
                        "residualStd": doc.get("residualStd"),
                        "n": doc.get("n"),
                        "lastDemand": doc.get("lastDemand"),
                    }
                    loaded += 1
                except Exception as e:
                    logger.error(f"DemandPredictor load model {zid} failed: {e}")
        except Exception as e:
            logger.error(f"DemandPredictor.load_persisted error: {e}")
        if loaded:
            logger.info(f"Sprint 20: DemandPredictor hydrated {loaded} models from db.ml_models")
        return loaded

    # ─── TRAINING ──────────────────────────────────────────────────────
    @classmethod
    async def train_zone(cls, zone_id: str, behavior: dict):
        if not SKLEARN_OK:
            return None
        snaps = await db.zone_snapshots.find(
            {"zoneId": zone_id},
            {"_id": 0, "demand": 1, "supply": 1, "ratio": 1, "surge": 1, "timestamp": 1},
        ).sort("timestamp", 1).to_list(cls.WINDOW)
        if len(snaps) < cls.MIN_SAMPLES + cls.LAG + 1:
            cls.metadata[zone_id] = {"status": "insufficient_data", "n": len(snaps)}
            return None

        X, y = [], []
        for i in range(cls.LAG, len(snaps) - 1):
            row = snaps[i]
            prev = [snaps[i - k]["demand"] for k in range(1, cls.LAG + 1)]
            try:
                ts_raw = row["timestamp"]
                ts = datetime.fromisoformat(ts_raw.replace('Z', '+00:00')) \
                    if isinstance(ts_raw, str) else ts_raw
            except Exception:
                ts = datetime.utcnow()
            feats = cls._features_for_row(
                prev, row.get("supply", 0), row.get("ratio", 0),
                row.get("surge", 1), ts, behavior,
            )
            X.append(feats)
            y.append(snaps[i + 1]["demand"])

        if len(X) < cls.MIN_SAMPLES:
            cls.metadata[zone_id] = {"status": "insufficient_after_build", "n": len(X)}
            return None

        hold = min(20, max(5, len(X) // 10))
        X_train, y_train = X[:-hold], y[:-hold]
        X_val, y_val = X[-hold:], y[-hold:]

        model = GradientBoostingRegressor(
            n_estimators=80, max_depth=3, learning_rate=0.07,
            min_samples_leaf=4, random_state=42,
        )
        model.fit(X_train, y_train)

        try:
            preds = model.predict(X_val)
            mae = float(mean_absolute_error(y_val, preds))
            residuals = np.array(y_val) - preds
            residual_std = float(np.std(residuals))
        except Exception:
            mae = -1.0
            residual_std = 1.5

        cls.models[zone_id] = model
        cls.metadata[zone_id] = {
            "status": "trained",
            "trainedAt": now_utc().isoformat(),
            "n": len(X),
            "mae": round(mae, 3),
            "residualStd": round(residual_std, 3),
            "lastDemand": int(snaps[-1]["demand"]),
        }
        await cls._persist(zone_id)
        return model

    @classmethod
    async def train_all_zones(cls):
        if not SKLEARN_OK:
            return
        behavior = await _compute_behavioral_signals()
        zones = await db.zones.find({}, {"_id": 0, "id": 1}).to_list(50)
        results = await asyncio.gather(
            *[cls.train_zone(z["id"], behavior) for z in zones],
            return_exceptions=True,
        )
        trained = sum(1 for r in results if r is not None and not isinstance(r, Exception))
        cls.last_train = time.time()
        logger.info(
            f"Sprint 20: DemandPredictor trained {trained}/{len(zones)} zones "
            f"(behav: ar={behavior.get('accept_rate')} cr={behavior.get('cancel_rate')} "
            f"rt={behavior.get('avg_response_h')}h)"
        )

    # ─── PREDICTION ────────────────────────────────────────────────────
    @classmethod
    async def predict(cls, zone_id: str):
        """Возвращает P50 (mean prediction) или None — для совместимости с Sprint 19."""
        result = await cls.predict_with_interval(zone_id)
        return result["p50"] if result else None

    @classmethod
    async def predict_with_interval(cls, zone_id: str):
        """Возвращает {p10, p50, p90, residualStd} или None если модель не готова."""
        model = cls.models.get(zone_id)
        if model is None:
            return None
        snaps = await db.zone_snapshots.find(
            {"zoneId": zone_id},
            {"_id": 0, "demand": 1, "supply": 1, "ratio": 1, "surge": 1, "timestamp": 1},
        ).sort("timestamp", -1).to_list(cls.LAG + 1)
        if len(snaps) < cls.LAG + 1:
            return None

        latest = snaps[0]
        prev = [snaps[i]["demand"] for i in range(cls.LAG)]
        try:
            ts_raw = latest["timestamp"]
            ts = datetime.fromisoformat(ts_raw.replace('Z', '+00:00')) \
                if isinstance(ts_raw, str) else ts_raw
        except Exception:
            ts = datetime.utcnow()
        behavior = await _compute_behavioral_signals()
        feats = cls._features_for_row(
            prev, latest.get("supply", 0), latest.get("ratio", 0),
            latest.get("surge", 1), ts, behavior,
        )
        try:
            yhat = float(model.predict([feats])[0])
        except Exception as e:
            logger.warning(f"DemandPredictor.predict_with_interval model error for {zone_id}: {e}")
            return None

        # Sprint 21 C14: защита от NaN/Inf/мусорных значений из модели.
        if not math.isfinite(yhat):
            logger.warning(
                f"DemandPredictor.predict_with_interval yielded non-finite value "
                f"for {zone_id}: {yhat!r}"
            )
            return None

        std = float(cls.metadata.get(zone_id, {}).get("residualStd") or 1.5)
        if not math.isfinite(std) or std < 0:
            std = 1.5
        p50 = max(0.0, min(200.0, round(yhat, 2)))
        p10 = max(0.0, round(yhat - 1.28 * std, 2))
        p90 = max(0.0, min(200.0, round(yhat + 1.28 * std, 2)))
        return {"p10": p10, "p50": p50, "p90": p90, "residualStd": round(std, 3)}


async def predict_demand(zone_id: str) -> float:
    """Прогноз спроса на ближайшее окно (~3-5 минут). ML → EWMA → safe zero.

    Sprint 21 C14: двухслойный fallback с валидацией:
      ML → если невалидный/падает → EWMA → если тоже падает → 0.0.
    Гарантирует, что вызывающий orchestrator никогда не получит NaN/inf/None.
    """
    # Слой 1: ML
    try:
        ml = await DemandPredictor.predict(zone_id)
        if is_valid_prediction(ml):
            return float(ml)
        if ml is not None:
            logger.warning(
                f"predict_demand: ML produced invalid value for {zone_id}: {ml!r}, "
                f"falling back to EWMA"
            )
    except Exception as e:
        logger.warning(f"predict_demand: DemandPredictor.predict failed for {zone_id}: {e}; falling back to EWMA")

    # Слой 2: EWMA
    try:
        ewma = await _predict_demand_ewma(zone_id)
        if is_valid_prediction(ewma):
            return float(ewma)
        logger.warning(
            f"predict_demand: EWMA produced invalid value for {zone_id}: {ewma!r}, using 0.0"
        )
    except Exception as e:
        logger.warning(f"predict_demand: EWMA failed for {zone_id}: {e}; using 0.0")

    # Слой 3: safe zero — orchestrator воспримет как «нет сигнала, ничего не делаем»
    return 0.0


async def _predict_demand_ewma(zone_id: str) -> float:
    """EWMA baseline — используется если ML-модель ещё не готова."""
    snaps = await db.zone_snapshots.find(
        {"zoneId": zone_id},
        {"_id": 0, "demand": 1, "timestamp": 1}
    ).sort("timestamp", -1).to_list(12)

    if not snaps:
        zone = await db.zones.find_one({"id": zone_id}, {"_id": 0, "demandScore": 1})
        return float(zone.get("demandScore", 0)) if zone else 0.0

    alpha = 0.5
    weight = 1.0
    weighted_sum = 0.0
    weight_total = 0.0
    for s in snaps:
        d = float(s.get("demand", 0) or 0)
        weighted_sum += d * weight
        weight_total += weight
        weight *= (1 - alpha)

    avg = weighted_sum / weight_total if weight_total else 0.0

    last = float(snaps[0].get("demand", 0) or 0)
    if last > avg * 1.2:
        avg = avg * 1.2
    return round(avg, 2)

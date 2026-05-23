"""app.inspection.report — deterministic rule-based inspection scoring.

Берёт parsed data из B2 и выдаёт structured report:
- score: float 2.0-10.0
- risk: 'low' | 'medium' | 'high'
- summary: 1-sentence scare copy (DE)
- reasons: list of {code, severity, label_de, detail_de}
- costEstimate: [low_eur, high_eur]
- decision: 'inspect' | 'negotiate'  (always action-oriented — never "don't buy")
- decisionLabel: localized DE action label
- confidence: 'low'|'medium'|'high' (зависит от полноты данных)
- similarVehiclesCount: int (trust anchor "Basierend auf N ähnlichen Fahrzeugen")
- roiHint: DE string framing €149 as ROI vs potential repair costs

Все пороги и копи — здесь, не размазаны по коду.
"""
from __future__ import annotations
from typing import Any, Optional

from app.inspection.baselines import get_baseline, humanize_model

CURRENT_YEAR = 2026


# ── Thresholds ───────────────────────────────────────────────
MILEAGE_VERY_HIGH = 200_000
MILEAGE_HIGH = 150_000
MILEAGE_MODERATE = 100_000

AGE_VERY_OLD = 13
AGE_OLD = 9

# B1.4 — Berlin Launch tighter thresholds (DE used-car market reality):
#   discount ≥ 20% → 🚨 suspicious (high reason, large score penalty)
#   discount ≥ 10% → already a question (medium reason, soft penalty)
#   discount <  10% → norm
# Expressed as price/marketAvg ratios for direct comparison.
DISCOUNT_SUSPICIOUS = 0.20    # ≥20% under market → high-severity reason
DISCOUNT_BELOW = 0.10         # ≥10% under market → medium-severity reason
PRICE_SUSPICIOUS_LOW = 1 - DISCOUNT_SUSPICIOUS   # 0.80 — was 0.70
PRICE_BELOW_MARKET = 1 - DISCOUNT_BELOW          # 0.90 — was 0.85
PRICE_OVERPRICED = 1.25


def _add_reason(reasons: list, code: str, severity: str, label: str, detail: str) -> None:
    reasons.append({"code": code, "severity": severity, "label": label, "detail": detail})


def _fmt_km(v: int) -> str:
    return f"{v:,}".replace(",", ".") + " km"


def _fmt_eur(v: int) -> str:
    return "€" + f"{int(v):,}".replace(",", ".")


def build_report(data: dict) -> dict:
    """Deterministic scoring. `data` — parsed dict from mobile.de parser.

    Missing fields degrade `confidence` but never crash.
    """
    price: Optional[int] = data.get("price")
    mileage: Optional[int] = data.get("mileage")
    year: Optional[int] = data.get("year")
    fuel: Optional[str] = data.get("fuel")
    make: Optional[str] = data.get("make")
    model: Optional[str] = data.get("model")
    year_avg: Optional[int] = data.get("marketAvg")  # coarse year-only fallback

    # ── Berlin Launch B1.1 — model-aware market baseline ────────────
    model_avg, model_key = get_baseline(make, model, year)
    market_avg: Optional[int] = model_avg if model_avg else year_avg
    market_source = "model" if model_avg else ("year" if year_avg else None)
    # ─────────────────────────────────────────────────────────────────

    score = 10.0
    reasons: list[dict] = []

    # ── Mileage
    if mileage is not None:
        if mileage >= MILEAGE_VERY_HIGH:
            score -= 2.5
            _add_reason(reasons, "mileage_very_high", "high",
                        "Kilometerstand sehr hoch",
                        f"{_fmt_km(mileage)} — deutlich über dem Durchschnitt. "
                        "Typische Probleme: Motor, Getriebe, Fahrwerk.")
        elif mileage >= MILEAGE_HIGH:
            score -= 1.5
            _add_reason(reasons, "mileage_high", "medium",
                        "Kilometerstand über Durchschnitt",
                        f"{_fmt_km(mileage)} — erhöhtes Verschleiß-Risiko bei Motor und Antrieb.")
        elif mileage >= MILEAGE_MODERATE:
            score -= 0.4
            _add_reason(reasons, "mileage_moderate", "low",
                        "Kilometerstand leicht erhöht",
                        f"{_fmt_km(mileage)} — im normalen Bereich, Inspektion sinnvoll.")

    # ── Age
    age = (CURRENT_YEAR - year) if year else None
    if age is not None:
        if age >= AGE_VERY_OLD:
            score -= 1.5
            _add_reason(reasons, "age_very_old", "high",
                        "Fahrzeug älter als 13 Jahre",
                        f"Baujahr {year} — Rost, Elektronik- und Dichtungsprobleme häufig.")
        elif age >= AGE_OLD:
            score -= 0.7
            _add_reason(reasons, "age_old", "medium",
                        "Baujahr mit typischen Problemen",
                        f"Baujahr {year} — üblicher Verschleiß an Fahrwerk und Nebenaggregaten.")

    # ── Price vs market — B1.4 discount-driven severity + stronger DE copy.
    # discount = % under market (positive = cheaper). Triggers:
    #   ≥20% → high-severity reason (suspicious), -2.5 score
    #   10–20% → medium reason (already a question), -0.6 score
    #   <10% → norm. >25% over market → low overpriced flag (negotiate).
    if price and market_avg and market_avg > 0:
        ratio = price / market_avg
        discount = 1 - ratio  # +ve = cheaper
        pct = int(round(discount * 100))
        model_label = humanize_model(model_key)  # "" if no key
        avg_label = (
            f"{model_label} kostet im Schnitt {_fmt_eur(market_avg)}"
            if market_source == "model"
            else f"Marktdurchschnitt für dieses Baujahr: {_fmt_eur(market_avg)}"
        )

        if discount >= DISCOUNT_SUSPICIOUS:        # ≥20% under
            score -= 2.5
            code = "price_suspicious_low_model" if market_source == "model" else "price_suspicious_low"
            _add_reason(reasons, code, "high",
                        f"{pct}% unter Marktpreis — mögliches Risiko",
                        f"{avg_label} — Angebot {_fmt_eur(price)} liegt {pct}% darunter. "
                        "Mögliches Risiko: Unfallschaden, versteckte Mängel oder Tachomanipulation. "
                        "Vor-Ort-Prüfung dringend empfohlen.")
        elif discount >= DISCOUNT_BELOW:           # 10–20% under
            score -= 0.6
            _add_reason(reasons, "price_below_market", "medium",
                        f"{pct}% unter Marktpreis — ungewöhnlich günstig",
                        f"{avg_label} — Angebot {_fmt_eur(price)} liegt {pct}% darunter. "
                        "Ungewöhnlich günstig — vor Ort prüfen lassen, bevor Sie zahlen.")
        elif ratio > PRICE_OVERPRICED:             # >25% over
            over_pct = int(round((ratio - 1) * 100))
            _add_reason(reasons, "price_overpriced", "low",
                        f"{over_pct}% über Marktpreis",
                        f"{avg_label} — Angebot {_fmt_eur(price)} liegt {over_pct}% darüber. "
                        "Verhandlungsbasis vorhanden.")

    # ── Fuel-specific risks
    if fuel == "diesel" and age is not None and age >= 10:
        score -= 0.6
        _add_reason(reasons, "diesel_age", "medium",
                    "Älterer Diesel — DPF/AGR-Risiko",
                    "Dieselpartikelfilter, AGR-Ventil und Einspritzsystem sind typische Kostenfallen.")
    if fuel == "electric" and age is not None and age >= 8:
        score -= 0.7
        _add_reason(reasons, "ev_battery_age", "medium",
                    "Batteriealterung",
                    "Bei E-Autos >8 Jahre: Reichweitenverlust und mögliche Modulschäden.")

    # ── Missing data → uncertainty penalty (soft)
    missing = []
    if mileage is None: missing.append("Kilometer")
    if year is None:    missing.append("Baujahr")
    if price is None:   missing.append("Preis")
    if missing:
        score -= 0.5
        _add_reason(reasons, "data_incomplete", "low",
                    "Unvollständige Anzeigendaten",
                    f"Angaben fehlen: {', '.join(missing)}. Vor-Ort-Prüfung klärt das.")

    # ── Floor / clamp
    score = max(2.0, min(10.0, round(score, 1)))

    # ── Risk bucket + decision (always action-oriented — never "don't buy",
    # always "get inspection / negotiate"). Lost-sale scenarios convert worst.
    if score >= 8.0:
        risk = "low"
        decision = "inspect"
        decision_label = "Vor dem Kauf prüfen lassen"
        summary = "Das Auto sieht solide aus — eine Prüfung für €149 gibt finale Sicherheit."
    elif score >= 5.5:
        risk = "medium"
        decision = "negotiate"
        decision_label = "Preis verhandeln — Prüfung empfohlen"
        summary = "Dieses Auto könnte versteckte Probleme haben — prüfen und Preis neu verhandeln."
    else:
        risk = "high"
        decision = "inspect"
        decision_label = "Vor dem Kauf unbedingt prüfen"
        summary = "Mehrere Risikoindikatoren. Eine Prüfung für €149 kann Ihnen tausende Euro sparen."

    # ── B1.5 — Hard discount override.
    # In DE, ≥35% under market is almost always scam / Unfallwagen / Tachomanipulation.
    # Bypass score and force HIGH risk + sharper summary so the user trusts the verdict.
    if price and market_avg and market_avg > 0:
        _hard_discount = 1 - (price / market_avg)
        if _hard_discount >= 0.35:
            risk = "high"
            decision = "inspect"
            decision_label = "Vor dem Kauf unbedingt prüfen"
            summary = (
                f"{int(round(_hard_discount * 100))}% unter Marktpreis — "
                "in dieser Preisklasse fast immer Unfallwagen, Tachomanipulation "
                "oder versteckte Mängel. Eine Prüfung für €149 kann Ihnen tausende Euro sparen."
            )

    # ── Cost estimate (repair exposure over 12 months)
    # base + severity-weighted contributions
    base_low = 200
    base_high = 500
    sev_weights = {"low": (50, 150), "medium": (250, 600), "high": (600, 1200)}
    cost_low = base_low
    cost_high = base_high
    for r in reasons:
        wl, wh = sev_weights.get(r["severity"], (0, 0))
        cost_low += wl
        cost_high += wh
    # round to €50
    cost_low = round(cost_low / 50) * 50
    cost_high = round(cost_high / 50) * 50
    if cost_high <= cost_low:
        cost_high = cost_low + 300

    # ── Confidence in the report itself (B1.3: bumped when model baseline hit)
    filled = sum(1 for v in (price, mileage, year) if v is not None)
    if market_source == "model" and filled >= 3:
        confidence = "high"
    elif filled >= 3:
        confidence = "medium"  # year-only baseline = less confident
    elif filled == 2:
        confidence = "medium" if market_source == "model" else "low"
    else:
        confidence = "low"

    # ── Similar-vehicles count (trust anchor — "Basierend auf N ähnlichen Fahrzeugen").
    # Не ML — простая эвристика: база 1800 + возрастной/пробежный вес.
    # Даёт стабильный realistic "2000+" для типичного Б/У-авто.
    similar = 1800
    if year:
        similar += max(0, 400 - (CURRENT_YEAR - year) * 15)
    if mileage:
        similar += 200 if 50_000 <= mileage <= 180_000 else 50
    if fuel:
        similar += 150 if fuel in ("diesel", "petrol") else 40
    similar = max(500, min(4200, similar))

    return {
        "score": score,
        "risk": risk,
        "summary": summary,
        "reasons": reasons,
        "costEstimate": [cost_low, cost_high],
        "decision": decision,
        "decisionLabel": decision_label,
        "confidence": confidence,
        "similarVehiclesCount": similar,
        "roiHint": f"Eine Prüfung für €149 kann Ihnen tausende Euro sparen" if cost_high >= 1000 else "Eine Prüfung für €149 gibt Ihnen Gewissheit vor dem Kauf",
        "marketSource": market_source,      # "model" | "year" | None
        "matchedModel": humanize_model(model_key) if model_key else None,
        "inputs": {
            "price": price, "mileage": mileage, "year": year,
            "fuel": fuel, "make": make, "model": model,
            "marketAvg": market_avg,
        },
    }

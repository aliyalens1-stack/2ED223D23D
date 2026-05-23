"""app.core.constants — shared numeric / taxonomy constants.

Sprint 21 C10: вынесены PRE_ENGAGEMENT_* пороги, потому что они используются
сразу в нескольких модулях (server.py /api/provider/pre-engage +
app/marketplace/matching.py /api/matching/zone-aware). Держать их в server.py
и импортировать обратно из marketplace → circular import.

Любые новые multi-domain-константы селятся сюда.
"""
from __future__ import annotations

# Sprint 18 — Provider Pre-Engagement Engine (proactive supply)
PRE_ENGAGEMENT_TTL_MIN: int = 15      # сколько действует приглашение (минут)
PRE_ENGAGEMENT_BOOST: float = 1.1     # ranking score *= 1.1 для boosted провайдеров

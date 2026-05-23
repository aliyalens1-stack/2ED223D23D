"""
app.governance — Sprint 21 final cleanup.

Закрывает декомпозицию server.py: 37 оставшихся @app.* handlers (demand-push,
provider behavior, flow control, demand action chains, revenue A/B
experiments, monetization promote/priority, distribution config, billing
revenue, zone admin controls, push-device legacy, simulation/analytics)
вынесены сюда в виде APIRouter.

Зачем единый модуль, а не 10 sub-модулей:
- все endpoints — admin-only governance surface, общая семантика
- общий контракт: governance_actions audit log + cluster enrichment
- проще читать в одном месте, чем прыгать между файлами

Server.py теперь содержит только: bootstrap + middleware + exception
handlers + lifecycle + catch-all NestJS proxy. Domain логики — ноль.
"""
from .router import router as router  # noqa: F401

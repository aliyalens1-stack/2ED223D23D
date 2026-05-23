"""app.orchestrator — domain package (Sprint 21 C11).

Содержит мозг системы: zone-state engine, orchestrator cycles, pre-engagement,
feedback/strategy learning. Функции и endpoints вынесены из server.py 1-в-1,
запуск loops остаётся в server.py startup через asyncio.create_task.
"""

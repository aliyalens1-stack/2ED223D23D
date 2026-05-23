"""app.admin.entities — Sprint 21 C12C marker.

Admin entity list/detail endpoints: users / bookings / quotes / disputes /
reviews / organizations — все уже обслуживаются NestJS-модулями (31 модуль,
см. ops/ARCHITECTURE.md). FastAPI выступает прокси через catch-all
`/api/{path:path}` → NestJS :3001.

В server.py native endpoint'ов по этим сущностям нет — переносить нечего.
Файл оставлен как маркер домена: когда админ-UI начнёт требовать native
composition/aggregation поверх NestJS, код будет добавляться сюда.
"""

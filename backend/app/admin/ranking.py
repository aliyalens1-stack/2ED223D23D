"""app.admin.ranking — Sprint 21 C12A placeholder.

Маркер домена. Сами endpoints:
  GET  /api/admin/ranking/weights
  GET  /api/admin/ranking/weights/{zone_id}
  POST /api/admin/ranking/recalculate

…уже вынесены в Sprint 21 C9 → `app/marketplace/quick_request.py` (они исторически
жили рядом с quick-request ranking optimizer loop). Создавать дубликат здесь
было бы шаг назад. В C12 мы оставляем их там же, а этот файл — просто маркер,
чтобы было видно: ranking в admin-домене присутствует, но физически у Quick
Request модуля.
"""

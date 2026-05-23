"""app.static.router — SPA static hosting для Admin Panel и Web App.

Sprint 21 C7: 8 endpoints вынесены из server.py. Обслуживание dist-билдов
Vite-фронтов (admin/dist, web-app/dist) напрямую из FastAPI.

Endpoint structure per SPA (web-app и admin-panel):
  1. GET /api/<spa>            → RedirectResponse к /api/<spa>/
  2. GET /api/<spa>/           → index.html
  3. GET /api/<spa>/assets/... → hashed static assets (JS/CSS bundles)
  4. GET /api/<spa>/{path:path}→ SPA fallback (file if exists, else index.html)

КРИТИЧНО: порядок регистрации routes внутри router'а — specific перед
catch-all. Endpoints (3) /assets/ всегда первыми, SPA catch-all (4) последний.

Global proxy_to_nestjs ("/api/{path:path}") в server.py остаётся в самом
конце файла — FastAPI first-match выбирает более специфичные static routes,
зарегистрированные через include_router ДО proxy.
"""
from __future__ import annotations
from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse
from starlette.responses import RedirectResponse

from app.core.config import ADMIN_BUILD_DIR, WEBAPP_BUILD_DIR


router = APIRouter()


# ═══════════════════════════════════════════════
# 🌐 WEB APP (client #3)
# ═══════════════════════════════════════════════
@router.get("/api/web-app")
async def web_app_redirect():
    return RedirectResponse(url="/api/web-app/")


@router.get("/api/web-app/")
async def web_app_index():
    index_path = WEBAPP_BUILD_DIR / 'index.html'
    if index_path.exists():
        return FileResponse(str(index_path), media_type='text/html')
    return JSONResponse({"error": "Web app not built"}, status_code=404)


@router.get("/api/web-app/assets/{file_path:path}")
async def web_app_assets(file_path: str):
    file = WEBAPP_BUILD_DIR / 'assets' / file_path
    if file.exists():
        media_type = (
            'application/javascript' if str(file).endswith('.js')
            else 'text/css' if str(file).endswith('.css')
            else None
        )
        return FileResponse(str(file), media_type=media_type)
    return JSONResponse({"error": "File not found"}, status_code=404)


@router.get("/api/web-app/{path:path}")
async def web_app_spa(path: str):
    file = WEBAPP_BUILD_DIR / path
    if file.exists() and file.is_file():
        return FileResponse(str(file))
    index_path = WEBAPP_BUILD_DIR / 'index.html'
    if index_path.exists():
        return FileResponse(str(index_path), media_type='text/html')
    return JSONResponse({"error": "Web app not built"}, status_code=404)


# ═══════════════════════════════════════════════
# 🔧 ADMIN PANEL
# ═══════════════════════════════════════════════
@router.get("/api/admin-panel")
async def admin_panel_redirect():
    """Redirect /api/admin-panel to /api/admin-panel/"""
    return RedirectResponse(url="/api/admin-panel/")


@router.get("/api/admin-panel/")
async def admin_panel_index():
    """Serve admin panel index.html"""
    index_path = ADMIN_BUILD_DIR / 'index.html'
    if index_path.exists():
        return FileResponse(str(index_path), media_type='text/html')
    return JSONResponse({"error": "Admin panel not built"}, status_code=404)


@router.get("/api/admin-panel/assets/{file_path:path}")
async def admin_panel_assets(file_path: str):
    """Serve admin panel static assets"""
    file = ADMIN_BUILD_DIR / 'assets' / file_path
    if file.exists():
        media_type = (
            'application/javascript' if str(file).endswith('.js')
            else 'text/css' if str(file).endswith('.css')
            else None
        )
        return FileResponse(str(file), media_type=media_type)
    return JSONResponse({"error": "File not found"}, status_code=404)


@router.get("/api/admin-panel/{path:path}")
async def admin_panel_spa(path: str):
    """SPA fallback - serve index.html for all admin routes"""
    # Check if it's a static file first
    file = ADMIN_BUILD_DIR / path
    if file.exists() and file.is_file():
        return FileResponse(str(file))
    # Otherwise serve index.html for SPA routing
    index_path = ADMIN_BUILD_DIR / 'index.html'
    if index_path.exists():
        return FileResponse(str(index_path), media_type='text/html')
    return JSONResponse({"error": "Admin panel not built"}, status_code=404)

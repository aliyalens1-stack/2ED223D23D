"""app.core.proxy — shared helper для пересылки запросов в NestJS.

Sprint 21 C8: извлечён 1-в-1 из server.py (_proxy_to), чтобы и app/system/compat.py,
и оставшиеся admin-compat endpoints в server.py использовали одну реализацию
без copy-paste. Поведение не меняется.

Использует ctx.http_client (установленный в Sprint 21 C4) и NESTJS_URL (C1).
"""
from __future__ import annotations
from typing import Optional
from urllib.parse import urlencode

from fastapi import Request, Response

from app.core.config import NESTJS_URL
from app.core.context import ctx


async def proxy_to_nest(
    request: Request,
    target_path: str,
    method: Optional[str] = None,
    query_override: Optional[dict] = None,
) -> Response:
    """Forward request to NestJS with optional path/query rewrite.

    Mirrors the original server._proxy_to byte-for-byte:
      * target URL = {NESTJS_URL}/api/{target_path}
      * query_override (if given) replaces query completely; иначе forward as-is
      * host / content-length / content-encoding / transfer-encoding
        headers strip'аются — без этого httpx умирает на chunked ответах
    """
    target = f"{NESTJS_URL}/api/{target_path.lstrip('/')}"
    if query_override is not None:
        if query_override:
            target += "?" + urlencode(query_override)
    elif request.query_params:
        target += f"?{request.query_params}"

    headers = dict(request.headers)
    headers.pop('host', None)
    headers.pop('content-length', None)
    body = await request.body()

    resp = await ctx.http_client.request(
        method=method or request.method,
        url=target,
        headers=headers,
        content=body,
    )

    rh = dict(resp.headers)
    for k in ('content-length', 'content-encoding', 'transfer-encoding'):
        rh.pop(k, None)

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=rh,
        media_type=resp.headers.get('content-type', 'application/json'),
    )

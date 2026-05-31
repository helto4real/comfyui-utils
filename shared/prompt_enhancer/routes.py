from __future__ import annotations

import asyncio

from aiohttp import web
import server

from .provider import DEFAULT_OLLAMA_TIMEOUT, DEFAULT_OLLAMA_URL, OllamaPromptProvider


ROUTE_PREFIX = "/helto_prompt_enhancer"


def _parse_timeout(value) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return DEFAULT_OLLAMA_TIMEOUT


async def _request_models(data: dict) -> web.Response:
    url = data.get("url") or DEFAULT_OLLAMA_URL
    timeout = _parse_timeout(data.get("timeout"))
    try:
        models = await asyncio.to_thread(OllamaPromptProvider().list_models, url, timeout)
        return web.json_response({"models": models})
    except Exception as exc:
        return web.json_response({"error": str(exc), "models": []}, status=400)


@server.PromptServer.instance.routes.get(f"{ROUTE_PREFIX}/models")
async def get_models(request):
    return await _request_models(
        {
            "url": request.query.get("url", DEFAULT_OLLAMA_URL),
            "timeout": request.query.get("timeout", DEFAULT_OLLAMA_TIMEOUT),
        }
    )


@server.PromptServer.instance.routes.post(f"{ROUTE_PREFIX}/models")
async def post_models(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await _request_models(data if isinstance(data, dict) else {})

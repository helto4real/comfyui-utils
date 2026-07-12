from __future__ import annotations

import asyncio

from aiohttp import web
import server

from .local_provider import (
    LocalProviderError,
    download_local_model,
    provider_catalog,
    unload_local_model,
)
from .provider import DEFAULT_OLLAMA_TIMEOUT, DEFAULT_OLLAMA_URL, OllamaPromptProvider
from .prompts import (
    delete_system_prompt_preset,
    list_system_prompt_presets,
    reset_default_system_prompt,
    reset_system_prompt,
    save_default_system_prompt,
    save_system_prompt,
    save_system_prompt_preset,
    system_prompt_payload,
)


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


async def _request_provider_models(data: dict) -> web.Response:
    url = data.get("url") or DEFAULT_OLLAMA_URL
    timeout = _parse_timeout(data.get("timeout"))
    ollama_models = []
    ollama_error = ""
    try:
        ollama_models = await asyncio.to_thread(OllamaPromptProvider().list_models, url, timeout)
    except Exception as exc:  # noqa: BLE001 - unified catalog should still show local providers.
        ollama_error = str(exc)
    return web.json_response(provider_catalog(ollama_models, ollama_error))


async def _download_provider_model(data: dict) -> web.Response:
    try:
        result = await asyncio.to_thread(download_local_model, data.get("model_id") or data.get("model"))
        return web.json_response(result)
    except LocalProviderError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def _unload_provider_model(data: dict) -> web.Response:
    try:
        result = await asyncio.to_thread(unload_local_model, data.get("model_id") or data.get("model") or None)
        return web.json_response(result)
    except LocalProviderError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def _request_system_prompt(kind: str | None) -> web.Response:
    try:
        return web.json_response(system_prompt_payload(kind))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


async def _save_system_prompt(data: dict) -> web.Response:
    try:
        return web.json_response(save_system_prompt(data.get("kind"), data.get("prompt")))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


async def _reset_system_prompt(data: dict) -> web.Response:
    try:
        return web.json_response(reset_system_prompt(data.get("kind")))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


async def _request_system_prompt_presets(kind: str | None) -> web.Response:
    try:
        return web.json_response(list_system_prompt_presets(kind))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


async def _save_system_prompt_preset(data: dict) -> web.Response:
    try:
        return web.json_response(
            save_system_prompt_preset(
                data.get("kind"),
                data.get("name"),
                data.get("prompt"),
                data.get("id") or data.get("preset_id"),
            )
        )
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


async def _save_default_system_prompt(data: dict) -> web.Response:
    try:
        return web.json_response(save_default_system_prompt(data.get("kind"), data.get("prompt")))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


async def _reset_default_system_prompt(data: dict) -> web.Response:
    try:
        return web.json_response(reset_default_system_prompt(data.get("kind")))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


async def _delete_system_prompt_preset(data: dict) -> web.Response:
    try:
        return web.json_response(delete_system_prompt_preset(data.get("kind"), data.get("id") or data.get("preset_id")))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


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


@server.PromptServer.instance.routes.get(f"{ROUTE_PREFIX}/providers/models")
async def get_provider_models(request):
    return await _request_provider_models(
        {
            "url": request.query.get("url", DEFAULT_OLLAMA_URL),
            "timeout": request.query.get("timeout", DEFAULT_OLLAMA_TIMEOUT),
        }
    )


@server.PromptServer.instance.routes.post(f"{ROUTE_PREFIX}/providers/models")
async def post_provider_models(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await _request_provider_models(data if isinstance(data, dict) else {})


@server.PromptServer.instance.routes.get(f"{ROUTE_PREFIX}/system_prompt")
async def get_system_prompt(request):
    return await _request_system_prompt(request.query.get("kind"))


@server.PromptServer.instance.routes.post(f"{ROUTE_PREFIX}/system_prompt")
async def post_system_prompt(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await _save_system_prompt(data if isinstance(data, dict) else {})


@server.PromptServer.instance.routes.post(f"{ROUTE_PREFIX}/system_prompt/reset")
async def post_system_prompt_reset(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await _reset_system_prompt(data if isinstance(data, dict) else {})


@server.PromptServer.instance.routes.get(f"{ROUTE_PREFIX}/system_prompts")
async def get_system_prompt_presets(request):
    return await _request_system_prompt_presets(request.query.get("kind"))


@server.PromptServer.instance.routes.post(f"{ROUTE_PREFIX}/system_prompts")
async def post_system_prompt_preset(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await _save_system_prompt_preset(data if isinstance(data, dict) else {})


@server.PromptServer.instance.routes.post(f"{ROUTE_PREFIX}/system_prompts/default")
async def post_default_system_prompt(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await _save_default_system_prompt(data if isinstance(data, dict) else {})


@server.PromptServer.instance.routes.post(f"{ROUTE_PREFIX}/system_prompts/reset_default")
async def post_default_system_prompt_reset(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await _reset_default_system_prompt(data if isinstance(data, dict) else {})


@server.PromptServer.instance.routes.post(f"{ROUTE_PREFIX}/system_prompts/delete")
async def post_system_prompt_preset_delete(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await _delete_system_prompt_preset(data if isinstance(data, dict) else {})

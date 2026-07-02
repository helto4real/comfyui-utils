from __future__ import annotations

import logging

from aiohttp import web
from server import PromptServer

from .queue_manager_store import load_queue_manager_state, save_queue_manager_state


LOGGER = logging.getLogger(__name__)
routes = PromptServer.instance.routes


@routes.get("/helto_queue_manager/state")
async def get_queue_manager_state(request):
    try:
        return web.json_response(load_queue_manager_state())
    except Exception as exc:
        LOGGER.warning("Queue manager load failed: %s", exc)
        return web.json_response({"ok": False, "error": "Failed to load queue state."}, status=500)


@routes.post("/helto_queue_manager/state")
async def post_queue_manager_state(request):
    try:
        data = await request.json()
        state = data.get("state")
        if not isinstance(state, dict):
            return web.json_response({"ok": False, "error": "state must be an object"}, status=400)
        privacy_enabled = data.get("privacy_enabled")
        if privacy_enabled is not None:
            privacy_enabled = bool(privacy_enabled)
        return web.json_response(save_queue_manager_state(state, privacy_enabled=privacy_enabled))
    except Exception as exc:
        LOGGER.warning("Queue manager save failed: %s", exc)
        return web.json_response({"ok": False, "error": "Failed to save queue state."}, status=500)

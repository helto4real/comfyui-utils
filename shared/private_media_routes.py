from __future__ import annotations

import asyncio
import logging

from aiohttp import web
from helto_privacy import aiohttp_check_privacy_token
import server

from .privacy import read_private_media_token


LOGGER = logging.getLogger(__name__)
ROUTE_PREFIX = "/helto_utils"


@server.PromptServer.instance.routes.get(f"{ROUTE_PREFIX}/private_media")
async def get_private_media(request):
    try:
        denied = aiohttp_check_privacy_token(request)
        if denied is not None:
            return denied
        token = request.query.get("token", "")
        # File read + decrypt can be large; keep it off the event loop.
        data, content_type, filename = await asyncio.to_thread(read_private_media_token, token)
        return web.Response(
            body=data,
            content_type=content_type,
            headers={"Content-Disposition": f'filename="{filename}"'},
        )
    except FileNotFoundError:
        return web.Response(text="Private media not found.", status=404)
    except Exception as exc:
        # Do not echo exception text (leaks file paths / token internals).
        LOGGER.warning("Private media request rejected: %s", exc)
        return web.Response(text="Invalid or expired private media token.", status=400)

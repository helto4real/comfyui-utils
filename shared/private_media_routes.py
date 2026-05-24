from __future__ import annotations

from aiohttp import web
import server

from .privacy import read_private_media_token


ROUTE_PREFIX = "/helto_utils"


@server.PromptServer.instance.routes.get(f"{ROUTE_PREFIX}/private_media")
async def get_private_media(request):
    try:
        token = request.query.get("token", "")
        data, content_type, filename = read_private_media_token(token)
        return web.Response(
            body=data,
            content_type=content_type,
            headers={"Content-Disposition": f'filename="{filename}"'},
        )
    except FileNotFoundError:
        return web.Response(text="Private media not found.", status=404)
    except Exception as exc:
        return web.Response(text=str(exc), status=400)

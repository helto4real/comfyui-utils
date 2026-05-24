from __future__ import annotations

from aiohttp import web

import folder_paths
from server import PromptServer

from .services import (
    DeleteImagesPayload,
    ScanFoldersPayload,
    clear_cache_payload,
    decrypt_payload,
    delete_images_payload,
    encrypt_payload,
    get_input_dir_payload,
    image_path_exists,
    scan_folders_payload,
    thumbnail_payload,
)

routes = PromptServer.instance.routes


@routes.get("/helto_selector/input_dir")
async def get_input_dir(request):
    try:
        return web.json_response(get_input_dir_payload(folder_paths.get_input_directory))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/helto_selector/scan_folders")
async def scan_folders(request):
    try:
        data = await request.json()
        payload = ScanFoldersPayload.from_request_data(data)
        return web.json_response(scan_folders_payload(payload))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/helto_selector/thumbnail")
async def get_thumbnail(request):
    try:
        image_path = request.query.get("path")
        privacy_mode = request.query.get("privacy", "false").lower() == "true"

        if not image_path_exists(image_path):
            return web.Response(text="Image path not found", status=404)

        webp_bytes = thumbnail_payload(image_path, privacy_mode)
        return web.Response(body=webp_bytes, content_type="image/webp")
    except Exception as e:
        return web.Response(text=str(e), status=500)


@routes.get("/helto_selector/view_image")
async def view_image(request):
    try:
        image_path = request.query.get("path")

        if not image_path_exists(image_path):
            return web.Response(text="Image path not found", status=404)

        return web.FileResponse(image_path)
    except Exception as e:
        return web.Response(text=str(e), status=500)


@routes.post("/helto_selector/delete_images")
async def api_delete_images(request):
    try:
        data = await request.json()
        payload = DeleteImagesPayload.from_request_data(data)
        return web.json_response(delete_images_payload(payload))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/helto_selector/encrypt")
async def api_encrypt(request):
    try:
        data = await request.json()
        return web.json_response(encrypt_payload(data))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/helto_selector/decrypt")
async def api_decrypt(request):
    try:
        data = await request.json()
        return web.json_response(decrypt_payload(data))
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/helto_selector/clear_cache")
async def api_clear_cache(request):
    try:
        return web.json_response(clear_cache_payload())
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

from __future__ import annotations

import json

from aiohttp import web

import folder_paths
from server import PromptServer

from .services import (
    DeleteImagesPayload,
    DeleteMaskPayload,
    MigrateMasksPayload,
    PasteImagePayload,
    SaveMaskPayload,
    ScanFoldersPayload,
    SelectorPathError,
    authorize_selector_image_path,
    clear_cache_payload,
    decrypt_payload,
    delete_images_payload,
    delete_mask_payload,
    encrypt_payload,
    get_input_dir_payload,
    mask_image_payload,
    migrate_masks_payload,
    paste_image_payload,
    scan_folders_payload,
    save_mask_payload,
    thumbnail_payload,
)

routes = PromptServer.instance.routes


def _parse_folders_field(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _request_folders(request):
    return _parse_folders_field(request.query.get("folders"))


def _selector_text_error(error: SelectorPathError):
    return web.Response(text=error.public_message, status=error.status_code)


def _selector_json_error(error: SelectorPathError):
    return web.json_response({"error": error.public_message}, status=error.status_code)


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
    except SelectorPathError as e:
        return _selector_json_error(e)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/helto_selector/thumbnail")
async def get_thumbnail(request):
    try:
        image_path = authorize_selector_image_path(
            request.query.get("path"),
            configured_folders=_request_folders(request),
        )
        privacy_mode = request.query.get("privacy", "false").lower() == "true"

        webp_bytes = thumbnail_payload(image_path, privacy_mode)
        return web.Response(body=webp_bytes, content_type="image/webp")
    except SelectorPathError as e:
        return _selector_text_error(e)
    except Exception:
        return web.Response(text="Failed to load thumbnail", status=500)


@routes.get("/helto_selector/view_image")
async def view_image(request):
    try:
        image_path = authorize_selector_image_path(
            request.query.get("path"),
            configured_folders=_request_folders(request),
        )
        return web.FileResponse(image_path)
    except SelectorPathError as e:
        return _selector_text_error(e)
    except Exception:
        return web.Response(text="Failed to load image", status=500)


@routes.get("/helto_selector/mask")
async def get_mask(request):
    try:
        image_path = authorize_selector_image_path(
            request.query.get("path"),
            configured_folders=_request_folders(request),
        )
        png_bytes = mask_image_payload(image_path)
        return web.Response(body=png_bytes, content_type="image/png")
    except SelectorPathError as e:
        return _selector_text_error(e)
    except Exception:
        return web.Response(text="Failed to load mask", status=500)


@routes.post("/helto_selector/delete_images")
async def api_delete_images(request):
    try:
        data = await request.json()
        payload = DeleteImagesPayload.from_request_data(data)
        return web.json_response(delete_images_payload(payload))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/helto_selector/paste_image")
async def api_paste_image(request):
    try:
        data = await request.post()
        image = data.get("image")
        if not image or not getattr(image, "file", None):
            return web.json_response({"error": "Image data is required"}, status=400)

        payload = PasteImagePayload(
            destination=str(data.get("destination") or ""),
            folders=_parse_folders_field(data.get("folders")),
            filename=str(getattr(image, "filename", "") or ""),
            content=image.file.read(),
            content_type=str(getattr(image, "content_type", "") or ""),
        )
        return web.json_response(paste_image_payload(payload))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
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


@routes.post("/helto_selector/save_mask")
async def api_save_mask(request):
    try:
        data = await request.json()
        payload = SaveMaskPayload.from_request_data(data)
        return web.json_response(save_mask_payload(payload))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except FileNotFoundError as e:
        return web.json_response({"error": str(e)}, status=404)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/helto_selector/delete_mask")
async def api_delete_mask(request):
    try:
        data = await request.json()
        payload = DeleteMaskPayload.from_request_data(data)
        return web.json_response(delete_mask_payload(payload))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except FileNotFoundError as e:
        return web.json_response({"error": str(e)}, status=404)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/helto_selector/migrate_masks")
async def api_migrate_masks(request):
    try:
        data = await request.json()
        payload = MigrateMasksPayload.from_request_data(data)
        return web.json_response(migrate_masks_payload(payload))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/helto_selector/clear_cache")
async def api_clear_cache(request):
    try:
        return web.json_response(clear_cache_payload())
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

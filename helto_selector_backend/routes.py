from __future__ import annotations

import asyncio
import json
import logging

from aiohttp import web
from helto_privacy import aiohttp_check_privacy_token

import folder_paths
from server import PromptServer

LOGGER = logging.getLogger(__name__)

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
    effective_authorized_roots,
    encrypt_payload,
    get_input_dir_payload,
    mask_image_payload,
    migrate_masks_payload,
    paste_image_payload,
    register_selector_roots,
    registered_selector_roots_payload,
    scan_folders_payload,
    save_mask_payload,
    thumbnail_payload,
    unregister_selector_root,
)
from .crypto import shared_privacy

routes = PromptServer.instance.routes


def _roots_kwargs() -> dict:
    return {"authorized_roots": effective_authorized_roots()}


def _authorize_request_image(request):
    return authorize_selector_image_path(
        request.query.get("path"),
        authorized_roots=effective_authorized_roots(),
    )


def _parse_folders_field(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _selector_text_error(error: SelectorPathError):
    return web.Response(text=error.public_message, status=error.status_code)


def _selector_json_error(error: SelectorPathError):
    return web.json_response({"error": error.public_message}, status=error.status_code)


def _selector_internal_error(handler: str, exc: Exception):
    if "PRIVACY_" in str(exc):
        return web.json_response({"ok": False, "error": shared_privacy.privacy_unavailable_error(exc)}, status=401)
    # Log the detail server-side; return a generic message so raw exception text
    # (file paths, internals) never reaches the client.
    LOGGER.warning("Selector %s failed: %s", handler, exc)
    return web.json_response({"error": "Selector request failed."}, status=500)


def _privacy_guard(request):
    return aiohttp_check_privacy_token(request)


@routes.get("/helto_selector/input_dir")
async def get_input_dir(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        return web.json_response(get_input_dir_payload(folder_paths.get_input_directory))
    except Exception as e:
        return _selector_internal_error(request.path, e)


@routes.post("/helto_selector/scan_folders")
async def scan_folders(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        data = await request.json()
        payload = ScanFoldersPayload.from_request_data(data)
        return web.json_response(scan_folders_payload(payload, **_roots_kwargs()))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except Exception as e:
        return _selector_internal_error(request.path, e)


@routes.get("/helto_selector/thumbnail")
async def get_thumbnail(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        image_path = _authorize_request_image(request)
        privacy_mode = request.query.get("privacy", "false").lower() == "true"

        webp_bytes = await asyncio.to_thread(thumbnail_payload, image_path, privacy_mode)
        return web.Response(
            body=webp_bytes,
            content_type="image/webp",
            headers={"Cache-Control": "private, no-store"},
        )
    except SelectorPathError as e:
        return _selector_text_error(e)
    except Exception:
        return web.Response(text="Failed to load thumbnail", status=500)


@routes.get("/helto_selector/view_image")
async def view_image(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        image_path = _authorize_request_image(request)
        return web.FileResponse(image_path, headers={"Cache-Control": "private, no-store"})
    except SelectorPathError as e:
        return _selector_text_error(e)
    except Exception:
        return web.Response(text="Failed to load image", status=500)


@routes.get("/helto_selector/mask")
async def get_mask(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        image_path = _authorize_request_image(request)
        png_bytes = await asyncio.to_thread(mask_image_payload, image_path)
        return web.Response(body=png_bytes, content_type="image/png")
    except SelectorPathError as e:
        return _selector_text_error(e)
    except Exception:
        return web.Response(text="Failed to load mask", status=500)


@routes.post("/helto_selector/delete_images")
async def api_delete_images(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        data = await request.json()
        payload = DeleteImagesPayload.from_request_data(data)
        return web.json_response(delete_images_payload(payload, **_roots_kwargs()))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except Exception as e:
        return _selector_internal_error(request.path, e)


@routes.post("/helto_selector/paste_image")
async def api_paste_image(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
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
        return web.json_response(paste_image_payload(payload, **_roots_kwargs()))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return _selector_internal_error(request.path, e)


@routes.post("/helto_selector/encrypt")
async def api_encrypt(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        data = await request.json()
        return web.json_response(encrypt_payload(data))
    except Exception as e:
        return _selector_internal_error(request.path, e)


@routes.post("/helto_selector/decrypt")
async def api_decrypt(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        data = await request.json()
        return web.json_response(decrypt_payload(data))
    except Exception as e:
        return _selector_internal_error(request.path, e)


@routes.post("/helto_selector/save_mask")
async def api_save_mask(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        data = await request.json()
        payload = SaveMaskPayload.from_request_data(data)
        return web.json_response(save_mask_payload(payload, **_roots_kwargs()))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except FileNotFoundError as e:
        return web.json_response({"error": str(e)}, status=404)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return _selector_internal_error(request.path, e)


@routes.post("/helto_selector/delete_mask")
async def api_delete_mask(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        data = await request.json()
        payload = DeleteMaskPayload.from_request_data(data)
        return web.json_response(delete_mask_payload(payload, **_roots_kwargs()))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except FileNotFoundError as e:
        return web.json_response({"error": str(e)}, status=404)
    except Exception as e:
        return _selector_internal_error(request.path, e)


@routes.post("/helto_selector/migrate_masks")
async def api_migrate_masks(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        data = await request.json()
        payload = MigrateMasksPayload.from_request_data(data)
        return web.json_response(migrate_masks_payload(payload, **_roots_kwargs()))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except Exception as e:
        return _selector_internal_error(request.path, e)


@routes.post("/helto_selector/clear_cache")
async def api_clear_cache(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        return web.json_response(clear_cache_payload())
    except Exception as e:
        return _selector_internal_error(request.path, e)


@routes.post("/helto_selector/register_roots")
async def api_register_roots(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        data = await request.json()
        if isinstance(data, dict) and data.get("action") == "revoke":
            return web.json_response(unregister_selector_root(str(data.get("folder") or "")))
        folders = _parse_folders_field(data.get("folders") if isinstance(data, dict) else None)
        return web.json_response(register_selector_roots(folders))
    except SelectorPathError as e:
        return _selector_json_error(e)
    except Exception as e:
        return _selector_internal_error(request.path, e)


@routes.get("/helto_selector/registered_roots")
async def api_registered_roots(request):
    try:
        denied = _privacy_guard(request)
        if denied is not None:
            return denied
        return web.json_response(registered_selector_roots_payload())
    except Exception as e:
        return _selector_internal_error(request.path, e)

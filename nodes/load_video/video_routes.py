from __future__ import annotations

import os
import urllib.parse

from aiohttp import web
import server

from .video_config import (
    VIDEO_EXTENSIONS,
    add_folder,
    folder_by_alias,
    load_folders,
    remove_folder,
    resolve_video_path,
)
from .video_io import list_videos, preview_result, thumbnail_bytes


ROUTE_PREFIX = "/helto_load_video"


def folder_payload() -> list[dict]:
    folders = []
    for folder in load_folders():
        exists = os.path.isdir(folder.path)
        folders.append(
            {
                "alias": folder.alias,
                "enabled": folder.enabled,
                "exists": exists,
                "video_count": len(list_videos(folder.path)) if exists else 0,
            }
        )
    return folders


@server.PromptServer.instance.routes.get(f"{ROUTE_PREFIX}/folders")
async def get_folders(_request):
    return web.json_response({"folders": folder_payload()})


@server.PromptServer.instance.routes.post(f"{ROUTE_PREFIX}/folders")
async def post_folder(request):
    try:
        data = await request.json()
        add_folder(data.get("alias"), data.get("path"))
        return web.json_response({"status": "ok", "folders": folder_payload()})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@server.PromptServer.instance.routes.delete(f"{ROUTE_PREFIX}/folders")
async def delete_folder(request):
    try:
        alias = request.query.get("alias", "input") or "input"
        remove_folder(alias)
        return web.json_response({"status": "ok", "folders": folder_payload()})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@server.PromptServer.instance.routes.get(f"{ROUTE_PREFIX}/videos")
async def get_videos(request):
    try:
        alias = request.query.get("alias", "input") or "input"
        recursive = request.query.get("recursive", "1").lower() not in {"0", "false", "no"}
        privacy_mode = request.query.get("privacy", "true").lower() in {"1", "true", "yes"}
        folder = folder_by_alias(alias)
        if not os.path.isdir(folder.path):
            return web.json_response({"videos": [], "warning": "Folder does not exist."})

        videos = list_videos(folder.path, recursive=recursive)
        for video in videos:
            video["video_url"] = (
                f"{ROUTE_PREFIX}/video?"
                + urllib.parse.urlencode({"alias": alias, "filename": video["filename"], "t": int(video["mtime"])})
            )
            video["thumb_url"] = (
                f"{ROUTE_PREFIX}/thumb?"
                + urllib.parse.urlencode({
                    "alias": alias,
                    "filename": video["filename"],
                    "t": int(video["mtime"]),
                    "privacy": "1" if privacy_mode else "0",
                })
            )
        return web.json_response({"videos": videos})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@server.PromptServer.instance.routes.post(f"{ROUTE_PREFIX}/refresh")
async def refresh(_request):
    return web.json_response({"status": "ok", "folders": folder_payload()})


@server.PromptServer.instance.routes.get(f"{ROUTE_PREFIX}/video")
async def get_video(request):
    try:
        alias = request.query.get("alias", "input") or "input"
        filename = urllib.parse.unquote(request.query.get("filename", ""))
        path = resolve_video_path(alias, filename)
        if path.suffix.lower() not in VIDEO_EXTENSIONS:
            return web.Response(status=400, text="Unsupported video type")
        return web.FileResponse(path, headers={"Cache-Control": "private, max-age=300"})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@server.PromptServer.instance.routes.get(f"{ROUTE_PREFIX}/preview")
async def get_preview(request):
    try:
        alias = request.query.get("alias", "input") or "input"
        filename = urllib.parse.unquote(request.query.get("filename", ""))
        privacy_mode = request.query.get("privacy", "true").lower() in {"1", "true", "yes"}
        path = resolve_video_path(alias, filename)
        if path.suffix.lower() not in VIDEO_EXTENSIONS:
            return web.json_response({"error": "Unsupported video type"}, status=400)
        return web.json_response({"images": [preview_result(path, privacy_mode=privacy_mode)], "animated": [True]})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)


@server.PromptServer.instance.routes.get(f"{ROUTE_PREFIX}/thumb")
async def get_thumb(request):
    try:
        alias = request.query.get("alias", "input") or "input"
        privacy_mode = request.query.get("privacy", "true").lower() in {"1", "true", "yes"}
        filename = urllib.parse.unquote(request.query.get("filename", ""))
        path = resolve_video_path(alias, filename)
        return web.Response(
            body=thumbnail_bytes(path, privacy_mode),
            headers={"Cache-Control": "public, max-age=86400"},
            content_type="image/webp",
        )
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=400)

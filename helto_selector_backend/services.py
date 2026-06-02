from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .crypto import decrypt_selection, encrypt_selection
from .scanning import delete_image_files, discover_image_folders, scan_image_folders
from .thumbnail_cache import clear_thumbnail_cache, delete_thumbnail_cache_for_paths, get_thumbnail_bytes


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _normalize_folder_path(path: str) -> str:
    normalized = os.path.normpath(path.strip())
    return normalized if Path(normalized).parts else ""


def _folder_list(value: Any) -> list[str]:
    folders: list[str] = []
    seen_paths: set[str] = set()

    for item in _string_list(value):
        normalized = _normalize_folder_path(item)
        if not normalized or normalized in seen_paths:
            continue
        folders.append(normalized)
        seen_paths.add(normalized)

    return folders


def _truthy(value: Any) -> bool:
    return bool(value)


@dataclass(frozen=True)
class ScanFoldersPayload:
    folders: list[str]
    recursive: bool
    previous_paths: list[str]

    @classmethod
    def from_request_data(cls, data: Mapping[str, Any]) -> "ScanFoldersPayload":
        return cls(
            folders=_folder_list(data.get("folders", [])),
            recursive=_truthy(data.get("recursive", False)),
            previous_paths=_string_list(data.get("previous_paths") or []),
        )


@dataclass(frozen=True)
class DeleteImagesPayload:
    paths: list[str]
    folders: list[str]
    recursive: bool

    @classmethod
    def from_request_data(cls, data: Mapping[str, Any]) -> "DeleteImagesPayload":
        return cls(
            paths=_string_list(data.get("paths") or []),
            folders=_folder_list(data.get("folders") or []),
            recursive=_truthy(data.get("recursive", False)),
        )


def get_input_dir_payload(get_input_directory: Callable[[], str]) -> dict[str, str]:
    return {"input_dir": get_input_directory()}


def scan_folders_payload(
    payload: ScanFoldersPayload,
    delete_cache_func: Callable[[list[str]], int] = delete_thumbnail_cache_for_paths,
) -> dict[str, Any]:
    images = scan_image_folders(payload.folders, payload.recursive)
    folder_options = discover_image_folders(payload.folders)
    current_paths = {image["path"] for image in images}
    previous_paths = {
        os.path.normpath(path)
        for path in payload.previous_paths
        if isinstance(path, str) and path
    }
    missing_paths = sorted(previous_paths - current_paths)
    removed_cache_count = delete_cache_func(missing_paths) if missing_paths else 0
    return {
        "images": images,
        "folders": folder_options,
        "removed_cache_count": removed_cache_count,
        "removed_paths": missing_paths,
    }


def image_path_exists(image_path: str | None) -> bool:
    return bool(image_path) and os.path.exists(image_path)


def thumbnail_payload(image_path: str, privacy_mode: bool) -> bytes:
    return get_thumbnail_bytes(image_path, privacy_mode)


def delete_images_payload(
    payload: DeleteImagesPayload,
    delete_func: Callable[[list[str], list[str], bool], dict[str, list[str]]] = delete_image_files,
    delete_cache_func: Callable[[list[str]], int] = delete_thumbnail_cache_for_paths,
) -> dict[str, Any]:
    delete_result = delete_func(payload.paths, payload.folders, payload.recursive)
    cache_paths = delete_result["deleted"] + delete_result["missing"]
    removed_cache_count = delete_cache_func(cache_paths) if cache_paths else 0

    return {
        **delete_result,
        "deleted_count": len(delete_result["deleted"]),
        "missing_count": len(delete_result["missing"]),
        "skipped_count": len(delete_result["skipped"]),
        "removed_cache_count": removed_cache_count,
    }


def encrypt_payload(data: Mapping[str, Any]) -> dict[str, str]:
    return {"encrypted": encrypt_selection(data.get("data", ""))}


def decrypt_payload(data: Mapping[str, Any]) -> dict[str, str]:
    return {"data": decrypt_selection(data.get("encrypted", ""))}


def clear_cache_payload(clear_cache_func: Callable[[], None] = clear_thumbnail_cache) -> dict[str, str]:
    clear_cache_func()
    return {"status": "success"}

from __future__ import annotations

import json
import os
import re
from io import BytesIO
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import folder_paths
from PIL import Image, ImageOps

from .constants import CONFIG_DIR, SUPPORTED_EXTENSIONS
from .mask_storage import delete_mask, load_mask_bytes, migrate_mask_privacy, save_mask_data_url
from .scanning import delete_image_files, discover_image_folders, scan_image_folders
from .thumbnail_cache import clear_thumbnail_cache, delete_thumbnail_cache_for_paths, get_thumbnail_bytes

try:
    from ..shared.private_json import write_private_json
except ImportError:
    from shared.private_json import write_private_json


_FALLBACK_IMAGE_EXTENSIONS = {
    "image/bmp": ".bmp",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/tiff": ".tiff",
    "image/webp": ".webp",
}


class SelectorPathError(ValueError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.public_message = message


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _normalize_folder_path(path: str) -> str:
    normalized = os.path.normpath(os.path.expanduser(path.strip()))
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


def _absolute_path(path: str) -> str:
    return os.path.abspath(os.path.normpath(path))


def _real_path(path: str) -> str:
    return os.path.realpath(_absolute_path(path))


def _is_same_or_child_path(path: str, parent_path: str) -> bool:
    try:
        return os.path.commonpath([path, parent_path]) == parent_path
    except ValueError:
        return False


def _is_supported_image_path(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in SUPPORTED_EXTENSIONS


SELECTOR_ROOTS_FILE = os.path.join(CONFIG_DIR, "selector_roots.json")
SELECTOR_ROOTS_ENV = "HELTO_SELECTOR_ROOTS"


def _default_authorized_root_paths() -> list[str]:
    return [
        folder_paths.get_input_directory(),
        folder_paths.get_output_directory(),
        folder_paths.get_temp_directory(),
    ]


def load_registered_selector_roots() -> list[str]:
    """Load user-approved selector roots from the server-owned registry."""
    try:
        with open(SELECTOR_ROOTS_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    roots: list[str] = []
    seen: set[str] = set()
    for item in data:
        if not isinstance(item, str) or not item.strip():
            continue
        root = _real_path(os.path.expanduser(item))
        if root in seen:
            continue
        seen.add(root)
        roots.append(root)
    return roots


def _environment_authorized_roots() -> list[str]:
    env_value = os.environ.get(SELECTOR_ROOTS_ENV, "")
    return [part for part in env_value.split(os.pathsep) if part.strip()]


def register_selector_roots(folders: list[str]) -> dict[str, Any]:
    """Persist folders approved through the authenticated selector UI.

    This is the only request-facing authority expansion seam. Ordinary scan,
    preview, delete, paste, and mask requests can select from registered roots,
    but cannot add roots themselves.
    """
    requested = _folder_list(folders)
    if not requested:
        raise SelectorPathError("At least one selector folder is required", 400)

    approved: list[str] = []
    for folder in requested:
        expanded = os.path.expanduser(folder)
        if not os.path.isabs(expanded):
            raise SelectorPathError("Selector folders must use absolute paths", 400)
        root = _real_path(expanded)
        if not os.path.isdir(root):
            raise SelectorPathError("Selector folder was not found", 404)
        approved.append(root)

    registered = load_registered_selector_roots()
    seen = set(registered)
    added: list[str] = []
    for root in approved:
        if root in seen:
            continue
        seen.add(root)
        registered.append(root)
        added.append(root)
    write_private_json(SELECTOR_ROOTS_FILE, registered)
    return {"ok": True, "registered": approved, "added": added}


def registered_selector_roots_payload() -> dict[str, Any]:
    return {"ok": True, "folders": load_registered_selector_roots()}


def unregister_selector_root(folder: str) -> dict[str, Any]:
    expanded = os.path.expanduser(str(folder or "").strip())
    if not expanded or not os.path.isabs(expanded):
        raise SelectorPathError("Selector folder must use an absolute path", 400)
    target = _real_path(expanded)
    registered = load_registered_selector_roots()
    remaining = [root for root in registered if root != target]
    removed = len(remaining) != len(registered)
    if removed:
        write_private_json(SELECTOR_ROOTS_FILE, remaining)
    return {"ok": True, "removed": removed, "folder": target}


def effective_authorized_roots() -> list[str]:
    """Return the complete server-owned selector root allowlist."""
    return selector_authorized_roots(
        [
            *_default_authorized_root_paths(),
            *_environment_authorized_roots(),
            *load_registered_selector_roots(),
        ]
    )


def _authorized_root_pairs(
    authorized_roots: list[str] | tuple[str, ...] | None = None,
) -> list[tuple[str, str]]:
    roots = list(authorized_roots if authorized_roots is not None else effective_authorized_roots())
    pairs: list[tuple[str, str]] = []
    seen_real_paths: set[str] = set()

    for root in roots:
        if not isinstance(root, str) or not root.strip():
            continue
        absolute = _absolute_path(root)
        real = _real_path(absolute)
        if real in seen_real_paths:
            continue
        pairs.append((absolute, real))
        seen_real_paths.add(real)

    return pairs


def selector_authorized_roots(
    authorized_roots: list[str] | tuple[str, ...] | None = None,
) -> list[str]:
    return [absolute for absolute, _real in _authorized_root_pairs(authorized_roots)]


def _is_under_authorized_root(path: str, root_pairs: list[tuple[str, str]]) -> bool:
    real_path = _real_path(path)
    return any(_is_same_or_child_path(real_path, root_real) for _root, root_real in root_pairs)


def authorize_selector_image_path(
    image_path: str | None,
    *,
    must_exist: bool = True,
    authorized_roots: list[str] | tuple[str, ...] | None = None,
) -> str:
    if not image_path:
        raise SelectorPathError("Image path is required", 400)

    normalized_path = _absolute_path(str(image_path))
    if not _is_supported_image_path(normalized_path):
        raise SelectorPathError("Unsupported image extension", 400)

    root_pairs = _authorized_root_pairs(authorized_roots)
    if not root_pairs or not _is_under_authorized_root(normalized_path, root_pairs):
        raise SelectorPathError("Image path is outside authorized selector folders", 403)

    if must_exist and not os.path.isfile(normalized_path):
        raise SelectorPathError("Image path not found", 404)

    return normalized_path


def authorize_selector_folders(
    folders: list[str],
    *,
    authorized_roots: list[str] | tuple[str, ...] | None = None,
) -> list[str]:
    root_pairs = _authorized_root_pairs(authorized_roots)
    authorized_folders: list[str] = []
    seen_paths: set[str] = set()

    for folder in folders:
        if not isinstance(folder, str) or not folder:
            continue
        normalized = _absolute_path(folder)
        if not root_pairs or not _is_under_authorized_root(normalized, root_pairs):
            raise SelectorPathError("Selector folder is outside authorized roots", 403)
        if normalized in seen_paths:
            continue
        authorized_folders.append(normalized)
        seen_paths.add(normalized)

    return authorized_folders


def _sanitize_pasted_filename(filename: str, content_type: str = "") -> str:
    name = os.path.basename((filename or "").replace("\\", "/")).strip()
    stem, extension = os.path.splitext(name)
    extension = extension.lower()

    if not extension:
        extension = _FALLBACK_IMAGE_EXTENSIONS.get((content_type or "").lower(), ".png")

    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError("Unsupported image extension")

    stem = stem.strip() or "pasted_image"
    stem = re.sub(r"[\x00-\x1f/\\]+", "_", stem).strip(" .") or "pasted_image"
    return f"{stem}{extension}"


def _resolve_allowed_destination_root(destination: str, folders: list[str]) -> tuple[str, str]:
    if not destination:
        raise ValueError("Destination folder is required")
    if not folders:
        raise ValueError("No selector folders are configured")

    destination_path = _absolute_path(destination)
    allowed_roots = [_absolute_path(folder) for folder in folders if folder]
    matching_roots = [
        root
        for root in allowed_roots
        if root and _is_same_or_child_path(_real_path(destination_path), _real_path(root))
    ]
    if not matching_roots:
        raise ValueError("Destination is outside the configured selector folders")

    matching_roots.sort(key=len, reverse=True)
    return destination_path, matching_roots[0]


def _file_bytes_match(path: str, content: bytes) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read() == content
    except OSError:
        return False


def _dedupe_pasted_image_path(destination: str, filename: str, content: bytes) -> tuple[str, str, bool]:
    stem, extension = os.path.splitext(filename)
    current_name = filename
    current_path = os.path.join(destination, current_name)
    counter = 1

    while os.path.exists(current_path):
        if _file_bytes_match(current_path, content):
            return current_path, current_name, True
        current_name = f"{stem} ({counter}){extension}"
        current_path = os.path.join(destination, current_name)
        counter += 1

    return current_path, current_name, False


def _image_metadata(folder_path: str, image_path: str) -> dict[str, Any]:
    normalized_path = os.path.normpath(image_path)
    stat = os.stat(normalized_path)
    return {
        "path": normalized_path,
        "folder": os.path.normpath(folder_path),
        "image_folder": os.path.normpath(os.path.dirname(normalized_path)),
        "name": os.path.basename(normalized_path),
        "date_modified": stat.st_mtime,
        "size_bytes": stat.st_size,
    }


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


@dataclass(frozen=True)
class SaveMaskPayload:
    path: str
    mask_data: str
    privacy: bool

    @classmethod
    def from_request_data(cls, data: Mapping[str, Any]) -> "SaveMaskPayload":
        return cls(
            path=str(data.get("path") or ""),
            mask_data=str(data.get("mask_data") or ""),
            privacy=_truthy(data.get("privacy", False)),
        )


@dataclass(frozen=True)
class DeleteMaskPayload:
    path: str

    @classmethod
    def from_request_data(cls, data: Mapping[str, Any]) -> "DeleteMaskPayload":
        return cls(
            path=str(data.get("path") or ""),
        )


@dataclass(frozen=True)
class MigrateMasksPayload:
    paths: list[str]
    privacy: bool

    @classmethod
    def from_request_data(cls, data: Mapping[str, Any]) -> "MigrateMasksPayload":
        return cls(
            paths=_string_list(data.get("paths") or []),
            privacy=_truthy(data.get("privacy", False)),
        )


@dataclass(frozen=True)
class PasteImagePayload:
    destination: str
    folders: list[str]
    filename: str
    content: bytes
    content_type: str = ""


def get_input_dir_payload(get_input_directory: Callable[[], str]) -> dict[str, str]:
    return {"input_dir": get_input_directory()}


def scan_folders_payload(
    payload: ScanFoldersPayload,
    delete_cache_func: Callable[[list[str]], int] = delete_thumbnail_cache_for_paths,
    *,
    authorized_roots: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    authorized_folders = authorize_selector_folders(payload.folders, authorized_roots=authorized_roots)
    images = scan_image_folders(authorized_folders, payload.recursive)
    folder_options = discover_image_folders(authorized_folders)
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


def default_mask_png_payload(image_path: str) -> bytes:
    with Image.open(image_path) as img:
        img = ImageOps.exif_transpose(img)
        mask = Image.new("L", img.size, 255)
        output = BytesIO()
        mask.save(output, format="PNG")
        return output.getvalue()


def mask_image_payload(image_path: str) -> bytes:
    return load_mask_bytes(image_path) or default_mask_png_payload(image_path)


def delete_images_payload(
    payload: DeleteImagesPayload,
    delete_func: Callable[[list[str], list[str], bool], dict[str, list[str]]] = delete_image_files,
    delete_cache_func: Callable[[list[str]], int] = delete_thumbnail_cache_for_paths,
    *,
    authorized_roots: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    authorized_folders = authorize_selector_folders(payload.folders, authorized_roots=authorized_roots)
    authorized_paths = [
        authorize_selector_image_path(
            path,
            must_exist=False,
            authorized_roots=authorized_roots,
        )
        for path in payload.paths
    ]
    delete_result = delete_func(authorized_paths, authorized_folders, payload.recursive)
    cache_paths = delete_result["deleted"] + delete_result["missing"]
    removed_cache_count = delete_cache_func(cache_paths) if cache_paths else 0

    return {
        **delete_result,
        "deleted_count": len(delete_result["deleted"]),
        "missing_count": len(delete_result["missing"]),
        "skipped_count": len(delete_result["skipped"]),
        "removed_cache_count": removed_cache_count,
    }


def paste_image_payload(
    payload: PasteImagePayload,
    *,
    authorized_roots: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    if not payload.content:
        raise ValueError("Image data is required")

    authorized_folders = authorize_selector_folders(payload.folders, authorized_roots=authorized_roots)
    destination, root_folder = _resolve_allowed_destination_root(payload.destination, authorized_folders)
    filename = _sanitize_pasted_filename(payload.filename, payload.content_type)

    os.makedirs(destination, exist_ok=True)
    filepath, saved_name, duplicate = _dedupe_pasted_image_path(destination, filename, payload.content)
    if not duplicate:
        with open(filepath, "wb") as f:
            f.write(payload.content)

    normalized_path = os.path.normpath(filepath)
    return {
        "status": "success",
        "path": normalized_path,
        "name": saved_name,
        "duplicate": duplicate,
        "image": _image_metadata(root_folder, normalized_path),
    }


def save_mask_payload(
    payload: SaveMaskPayload,
    *,
    authorized_roots: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    image_path = authorize_selector_image_path(
        payload.path,
        authorized_roots=authorized_roots,
    )
    if not payload.mask_data:
        raise ValueError("Mask data is required")
    return {
        "status": "success",
        "path": image_path,
        "ref": save_mask_data_url(image_path, payload.mask_data, payload.privacy),
    }


def delete_mask_payload(
    payload: DeleteMaskPayload,
    *,
    authorized_roots: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    image_path = authorize_selector_image_path(
        payload.path,
        authorized_roots=authorized_roots,
    )
    return {
        "status": "success",
        "path": image_path,
        "cleared": True,
        "deleted_count": delete_mask(image_path),
    }


def migrate_masks_payload(
    payload: MigrateMasksPayload,
    *,
    authorized_roots: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    authorized_paths = [
        authorize_selector_image_path(
            path,
            must_exist=False,
            authorized_roots=authorized_roots,
        )
        for path in payload.paths
    ]
    existing_paths = [path for path in authorized_paths if image_path_exists(path)]
    return {
        "status": "success",
        "migrated_count": migrate_mask_privacy(existing_paths, payload.privacy),
    }


def clear_cache_payload(clear_cache_func: Callable[[], None] = clear_thumbnail_cache) -> dict[str, str]:
    clear_cache_func()
    return {"status": "success"}

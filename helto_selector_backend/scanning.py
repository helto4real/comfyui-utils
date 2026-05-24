from __future__ import annotations

import os
from typing import Any

from .constants import SUPPORTED_EXTENSIONS


def _image_metadata(folder_path: str, image_path: str, name: str, stat: os.stat_result) -> dict[str, Any]:
    normalized_image_path = os.path.normpath(image_path)
    return {
        "path": normalized_image_path,
        "folder": os.path.normpath(folder_path),
        "image_folder": os.path.normpath(os.path.dirname(normalized_image_path)),
        "name": name,
        "date_modified": stat.st_mtime,
        "size_bytes": stat.st_size,
    }


def _folder_metadata(root_path: str, folder_path: str) -> dict[str, str]:
    normalized_root = os.path.normpath(root_path)
    normalized_path = os.path.normpath(folder_path)
    relative = os.path.relpath(normalized_path, normalized_root)
    if relative == ".":
        relative = ""

    return {
        "path": normalized_path,
        "root": normalized_root,
        "name": os.path.basename(normalized_path) or normalized_path,
        "relative": relative,
    }


def _is_supported_image(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in SUPPORTED_EXTENSIONS


def _absolute_path(path: str) -> str:
    return os.path.abspath(os.path.normpath(path))


def _is_same_or_child_path(path: str, parent_path: str) -> bool:
    try:
        return os.path.commonpath([path, parent_path]) == parent_path
    except ValueError:
        return False


def _path_matches_scan_scope(path: str, folders: list[str], recursive: bool) -> bool:
    image_dir = os.path.dirname(path)

    for folder_path in folders:
        if not folder_path:
            continue

        root_path = _absolute_path(folder_path)
        if recursive:
            if _is_same_or_child_path(path, root_path):
                return True
        elif image_dir == root_path:
            return True

    return False


def _sort_folder_names(names: list[str]) -> None:
    names.sort(key=str.casefold)


def discover_image_folders(folders: list[str]) -> list[dict[str, str]]:
    folder_options: list[dict[str, str]] = []
    seen_paths: set[str] = set()

    for folder_path in folders:
        if not folder_path or not os.path.isdir(folder_path):
            continue

        normalized_folder = os.path.normpath(folder_path)
        for root, dirs, _ in os.walk(normalized_folder):
            _sort_folder_names(dirs)
            normalized_root = os.path.normpath(root)
            if normalized_root in seen_paths:
                continue
            seen_paths.add(normalized_root)
            folder_options.append(_folder_metadata(normalized_folder, normalized_root))

    folder_options.sort(key=lambda item: (item["root"].casefold(), item["relative"].casefold(), item["name"].casefold()))
    return folder_options


def _append_image_metadata(
    images: list[dict[str, Any]],
    seen_paths: set[str],
    folder_path: str,
    full_path: str,
    name: str,
) -> None:
    if full_path in seen_paths:
        return
    seen_paths.add(full_path)
    try:
        images.append(_image_metadata(folder_path, full_path, name, os.stat(full_path)))
    except Exception:
        pass


def _scan_recursive_folder(folder_path: str, images: list[dict[str, Any]], seen_paths: set[str]) -> None:
    for root, _, files in os.walk(folder_path):
        for file_name in files:
            if not _is_supported_image(file_name):
                continue
            full_path = os.path.normpath(os.path.join(root, file_name))
            _append_image_metadata(images, seen_paths, folder_path, full_path, file_name)


def _scan_flat_folder(folder_path: str, images: list[dict[str, Any]], seen_paths: set[str]) -> None:
    try:
        for entry in os.scandir(folder_path):
            if not entry.is_file() or not _is_supported_image(entry.name):
                continue
            full_path = os.path.normpath(entry.path)
            if full_path in seen_paths:
                continue
            seen_paths.add(full_path)
            try:
                images.append(_image_metadata(folder_path, full_path, entry.name, entry.stat()))
            except Exception:
                pass
    except Exception:
        pass


def scan_image_folders(folders: list[str], recursive: bool = False) -> list[dict[str, Any]]:
    images: list[dict[str, Any]] = []
    seen_paths: set[str] = set()

    for folder_path in folders:
        if not folder_path or not os.path.isdir(folder_path):
            continue

        if recursive:
            _scan_recursive_folder(folder_path, images, seen_paths)
        else:
            _scan_flat_folder(folder_path, images, seen_paths)

    return images


def delete_image_files(paths: list[str], folders: list[str], recursive: bool = False) -> dict[str, list[str]]:
    if not isinstance(paths, list):
        paths = []
    if not isinstance(folders, list):
        folders = []

    scan_paths = {
        _absolute_path(image["path"])
        for image in scan_image_folders(folders, recursive)
        if isinstance(image.get("path"), str)
    }
    deleted: list[str] = []
    missing: list[str] = []
    skipped: list[str] = []
    seen_paths: set[str] = set()

    for raw_path in paths:
        if not isinstance(raw_path, str) or not raw_path:
            continue

        display_path = os.path.normpath(raw_path)
        absolute_path = _absolute_path(display_path)
        if absolute_path in seen_paths:
            continue
        seen_paths.add(absolute_path)

        if not _is_supported_image(display_path) or not _path_matches_scan_scope(absolute_path, folders, recursive):
            skipped.append(display_path)
            continue

        if absolute_path not in scan_paths:
            if os.path.exists(absolute_path):
                skipped.append(display_path)
            else:
                missing.append(display_path)
            continue

        try:
            os.unlink(absolute_path)
            deleted.append(display_path)
        except FileNotFoundError:
            missing.append(display_path)
        except OSError:
            skipped.append(display_path)

    return {
        "deleted": deleted,
        "missing": missing,
        "skipped": skipped,
    }

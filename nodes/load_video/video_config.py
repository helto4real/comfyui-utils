from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

import folder_paths


NODE_DIR = Path(__file__).resolve().parent
CONFIG_DIR = NODE_DIR / "config"
FOLDERS_FILE = CONFIG_DIR / "video_folders.json"
THUMB_CACHE_DIR = NODE_DIR / "thumbnail_cache"
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}


@dataclass(frozen=True)
class VideoFolder:
    alias: str
    path: str
    enabled: bool = True


def ensure_dirs() -> None:
    CONFIG_DIR.mkdir(exist_ok=True)
    THUMB_CACHE_DIR.mkdir(exist_ok=True)


def default_folder() -> VideoFolder:
    return VideoFolder(alias="input", path=os.path.normpath(folder_paths.get_input_directory()), enabled=True)


def safe_alias(alias: str) -> str:
    alias = str(alias or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_. -]{1,80}", alias):
        raise ValueError("Alias must be 1-80 characters using letters, numbers, spaces, dot, underscore, or dash.")
    return alias


def load_folders() -> list[VideoFolder]:
    ensure_dirs()
    default = default_folder()
    if not FOLDERS_FILE.exists():
        return [default]

    try:
        data = json.loads(FOLDERS_FILE.read_text(encoding="utf-8") or "{}")
    except Exception:
        return [default]

    folders: list[VideoFolder] = []
    seen: set[str] = set()
    for entry in data.get("folders", []):
        try:
            alias = safe_alias(entry.get("alias"))
        except ValueError:
            continue

        path = os.path.normpath(os.path.expanduser(str(entry.get("path", ""))))
        if alias in seen or not path:
            continue
        folders.append(VideoFolder(alias=alias, path=path, enabled=bool(entry.get("enabled", True))))
        seen.add(alias)

    if default.alias not in seen:
        folders.insert(0, default)
    return folders


def save_folders(folders: list[VideoFolder]) -> None:
    ensure_dirs()
    payload = {
        "version": 1,
        "folders": [
            {"alias": folder.alias, "path": os.path.normpath(folder.path), "enabled": folder.enabled}
            for folder in folders
        ],
    }
    FOLDERS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def folder_by_alias(alias: str) -> VideoFolder:
    for folder in load_folders():
        if folder.alias == alias:
            return folder
    raise ValueError(f"Unknown folder alias: {alias}")


def resolve_video_path(alias: str, filename: str) -> Path:
    folder = folder_by_alias(alias or "input")
    if not folder.enabled:
        raise ValueError(f"Folder alias is disabled: {alias}")

    root = Path(os.path.normpath(os.path.expanduser(folder.path))).resolve()
    candidate = (root / str(filename or "")).resolve()
    if root != candidate and root not in candidate.parents:
        raise ValueError("Invalid video path.")
    if candidate.suffix.lower() not in VIDEO_EXTENSIONS:
        raise ValueError(f"Unsupported video extension: {candidate.suffix}")
    if not candidate.is_file():
        raise FileNotFoundError(f"Video not found: {folder.alias}/{filename}")
    return candidate


def add_folder(alias: str, path: str) -> list[VideoFolder]:
    alias = safe_alias(alias)
    path = os.path.normpath(os.path.expanduser(str(path or "")))
    if not os.path.isdir(path):
        raise ValueError(f"Folder does not exist: {path}")

    folders = load_folders()
    if any(folder.alias == alias for folder in folders):
        raise ValueError(f"Folder alias already exists: {alias}")
    folders.append(VideoFolder(alias=alias, path=path, enabled=True))
    save_folders(folders)
    return folders


def remove_folder(alias: str) -> list[VideoFolder]:
    if alias == "input":
        raise ValueError("Cannot remove the default input folder.")
    folders = load_folders()
    next_folders = [folder for folder in folders if folder.alias != alias]
    if len(next_folders) == len(folders):
        raise ValueError(f"Folder alias not found: {alias}")
    save_folders(next_folders)
    return next_folders

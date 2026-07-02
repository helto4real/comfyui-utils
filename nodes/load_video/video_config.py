from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

import folder_paths

try:
    from ...shared.temp_cache import public_temp_cache_dir
except ImportError:
    from shared.temp_cache import public_temp_cache_dir


NODE_DIR = Path(__file__).resolve().parent
CONFIG_DIR = NODE_DIR / "config"
FOLDERS_FILE = CONFIG_DIR / "video_folders.json"
THUMB_CACHE_DIR: Path | None = None
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
LOAD_VIDEO_ROOTS_ENV = "HELTO_LOAD_VIDEO_ROOTS"


@dataclass(frozen=True)
class VideoFolder:
    alias: str
    path: str
    enabled: bool = True


def ensure_dirs() -> None:
    CONFIG_DIR.mkdir(exist_ok=True)
    thumbnail_cache_dir().mkdir(parents=True, exist_ok=True)


def thumbnail_cache_dir() -> Path:
    if THUMB_CACHE_DIR is not None:
        return Path(THUMB_CACHE_DIR)
    return public_temp_cache_dir("HeltoLoadVideo", "thumbnails")


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


def _load_video_allowlist_roots() -> list[str]:
    """Opt-in server-side allowlist for folders that may be registered.

    Set HELTO_LOAD_VIDEO_ROOTS (os.pathsep-separated) to confine added folders
    to input/output/temp plus those roots. Unset keeps the permissive default.
    """
    env_value = os.environ.get(LOAD_VIDEO_ROOTS_ENV, "")
    return [part for part in env_value.split(os.pathsep) if part.strip()]


def _assert_folder_allowed(path: str) -> None:
    extra_roots = _load_video_allowlist_roots()
    if not extra_roots:
        return
    allowed = [
        os.path.realpath(os.path.expanduser(root))
        for root in ([folder_paths.get_input_directory(), folder_paths.get_output_directory(),
                      folder_paths.get_temp_directory()] + extra_roots)
    ]
    real = os.path.realpath(path)
    for root in allowed:
        try:
            if os.path.commonpath([real, root]) == root:
                return
        except ValueError:
            continue
    raise ValueError("Folder is outside the configured HELTO_LOAD_VIDEO_ROOTS allowlist.")


def add_folder(alias: str, path: str) -> list[VideoFolder]:
    alias = safe_alias(alias)
    path = os.path.normpath(os.path.expanduser(str(path or "")))
    if not os.path.isdir(path):
        raise ValueError(f"Folder does not exist: {path}")
    _assert_folder_allowed(path)

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

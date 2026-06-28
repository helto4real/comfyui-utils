from __future__ import annotations

import tempfile
from pathlib import Path

try:
    import folder_paths
except ModuleNotFoundError:
    folder_paths = None


def _safe_segment(value: object, fallback: str) -> str:
    text = str(value or fallback)
    clean = "".join(char if char.isalnum() or char in "._-" else "_" for char in text)
    if clean in {"", ".", ".."}:
        return fallback
    return clean


def _temp_root() -> Path:
    if folder_paths is not None and callable(getattr(folder_paths, "get_temp_directory", None)):
        return Path(folder_paths.get_temp_directory())
    return Path(tempfile.gettempdir())


def temp_cache_dir(node_id: str, purpose: str, *, private: bool = False) -> Path:
    root_name = "helto_private" if private else "helto_cache"
    path = _temp_root() / root_name / _safe_segment(node_id, "node") / _safe_segment(purpose, "cache")
    path.mkdir(parents=True, exist_ok=True)
    return path


def public_temp_cache_dir(node_id: str, purpose: str) -> Path:
    return temp_cache_dir(node_id, purpose, private=False)


def private_temp_cache_dir(node_id: str, purpose: str) -> Path:
    return temp_cache_dir(node_id, purpose, private=True)

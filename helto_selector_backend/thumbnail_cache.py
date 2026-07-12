from __future__ import annotations

import hashlib
import os
import shutil
from io import BytesIO
from typing import BinaryIO

from PIL import Image, ImageOps

try:
    from ..shared.temp_cache import public_temp_cache_dir
except ImportError:
    from shared.temp_cache import public_temp_cache_dir


THUMBNAIL_MAX_SIZE = 512
THUMBNAIL_CACHE_VERSION = "v2"


def selector_thumbnail_cache_dir() -> str:
    return str(public_temp_cache_dir("HeltoImageSelector", "thumbnails"))


def _resolve_cache_dir(cache_dir: str | os.PathLike[str] | None) -> str:
    return os.fspath(cache_dir) if cache_dir is not None else selector_thumbnail_cache_dir()


def thumbnail_cache_key(image_path: str) -> str:
    cache_key = f"{THUMBNAIL_CACHE_VERSION}:{image_path}"
    return hashlib.sha256(cache_key.encode("utf-8")).hexdigest()


def thumbnail_cache_paths(image_path: str, cache_dir: str | os.PathLike[str] | None = None) -> tuple[str, str]:
    cache_dir = _resolve_cache_dir(cache_dir)
    path_hash = thumbnail_cache_key(image_path)
    return (
        os.path.join(cache_dir, f"{path_hash}.webp"),
        os.path.join(cache_dir, f"{path_hash}.webp.enc"),
    )


def generate_thumbnail_bytes(
    image_path: str | os.PathLike[str] | BinaryIO,
) -> bytes:
    with Image.open(image_path) as img:
        img = ImageOps.exif_transpose(img)
        img.thumbnail((THUMBNAIL_MAX_SIZE, THUMBNAIL_MAX_SIZE))

        out = BytesIO()
        img.save(out, format="WEBP", quality=80)
        return out.getvalue()


def _is_cache_fresh(cache_path: str, image_path: str) -> bool:
    try:
        return os.stat(cache_path).st_mtime_ns >= os.stat(image_path).st_mtime_ns
    except OSError:
        return False


def _read_fresh_cache(cache_path: str, image_path: str) -> bytes | None:
    if not _is_cache_fresh(cache_path, image_path):
        return None
    with open(cache_path, "rb") as f:
        return f.read()


def get_thumbnail_bytes(
    image_path: str,
    privacy_mode: bool,
    cache_dir: str | os.PathLike[str] | None = None,
) -> bytes:
    cache_dir = _resolve_cache_dir(cache_dir)
    os.makedirs(cache_dir, exist_ok=True)
    plain_cache_path, enc_cache_path = thumbnail_cache_paths(image_path, cache_dir)

    if privacy_mode:
        raise RuntimeError("Private thumbnails require managed artifacts.")

    plain_bytes = _read_fresh_cache(plain_cache_path, image_path)
    if plain_bytes is not None:
        return plain_bytes

    webp_bytes = generate_thumbnail_bytes(image_path)

    with open(plain_cache_path, "wb") as f:
        f.write(webp_bytes)
    try:
        os.remove(enc_cache_path)
    except Exception:
        pass
    return webp_bytes


def delete_thumbnail_cache_for_paths(paths: list[str], cache_dir: str | os.PathLike[str] | None = None) -> int:
    cache_dir = _resolve_cache_dir(cache_dir)
    os.makedirs(cache_dir, exist_ok=True)
    deleted_count = 0

    for image_path in paths:
        if not image_path:
            continue

        plain_cache_path, enc_cache_path = thumbnail_cache_paths(os.path.normpath(image_path), cache_dir)
        for cache_path in (plain_cache_path, enc_cache_path):
            try:
                if os.path.isfile(cache_path) or os.path.islink(cache_path):
                    os.unlink(cache_path)
                    deleted_count += 1
            except Exception:
                pass

    return deleted_count


def clear_thumbnail_cache(cache_dir: str | os.PathLike[str] | None = None) -> None:
    cache_dir = _resolve_cache_dir(cache_dir)
    os.makedirs(cache_dir, exist_ok=True)
    for filename in os.listdir(cache_dir):
        file_path = os.path.join(cache_dir, filename)
        try:
            if os.path.isfile(file_path) or os.path.islink(file_path):
                os.unlink(file_path)
            elif os.path.isdir(file_path):
                shutil.rmtree(file_path)
        except Exception:
            pass

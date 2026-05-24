from __future__ import annotations

import hashlib
import os
import shutil
from io import BytesIO

from PIL import Image, ImageOps

from .constants import CACHE_DIR, ensure_runtime_dirs
from .crypto import ENCRYPTION_KEY, decrypt_bytes, encrypt_bytes

THUMBNAIL_MAX_SIZE = 512
THUMBNAIL_CACHE_VERSION = "v2"


def thumbnail_cache_paths(image_path: str, cache_dir: str = CACHE_DIR) -> tuple[str, str]:
    cache_key = f"{THUMBNAIL_CACHE_VERSION}:{image_path}"
    path_hash = hashlib.sha256(cache_key.encode("utf-8")).hexdigest()
    return (
        os.path.join(cache_dir, f"{path_hash}.webp"),
        os.path.join(cache_dir, f"{path_hash}.webp.enc"),
    )


def generate_thumbnail_bytes(image_path: str) -> bytes:
    with Image.open(image_path) as img:
        img = ImageOps.exif_transpose(img)
        img.thumbnail((THUMBNAIL_MAX_SIZE, THUMBNAIL_MAX_SIZE))

        out = BytesIO()
        img.save(out, format="WEBP", quality=80)
        return out.getvalue()


def get_thumbnail_bytes(
    image_path: str,
    privacy_mode: bool,
    cache_dir: str = CACHE_DIR,
    key: bytes = ENCRYPTION_KEY,
) -> bytes:
    ensure_runtime_dirs()
    plain_cache_path, enc_cache_path = thumbnail_cache_paths(image_path, cache_dir)

    if privacy_mode:
        if os.path.exists(enc_cache_path):
            with open(enc_cache_path, "rb") as f:
                return decrypt_bytes(key, f.read())

        if os.path.exists(plain_cache_path):
            with open(plain_cache_path, "rb") as f:
                webp_bytes = f.read()
        else:
            webp_bytes = generate_thumbnail_bytes(image_path)

        with open(enc_cache_path, "wb") as f:
            f.write(encrypt_bytes(key, webp_bytes))
        try:
            os.remove(plain_cache_path)
        except Exception:
            pass
        return webp_bytes

    if os.path.exists(plain_cache_path):
        with open(plain_cache_path, "rb") as f:
            return f.read()

    if os.path.exists(enc_cache_path):
        with open(enc_cache_path, "rb") as f:
            webp_bytes = decrypt_bytes(key, f.read())
    else:
        webp_bytes = generate_thumbnail_bytes(image_path)

    with open(plain_cache_path, "wb") as f:
        f.write(webp_bytes)
    try:
        os.remove(enc_cache_path)
    except Exception:
        pass
    return webp_bytes


def delete_thumbnail_cache_for_paths(paths: list[str], cache_dir: str = CACHE_DIR) -> int:
    ensure_runtime_dirs()
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


def clear_thumbnail_cache(cache_dir: str = CACHE_DIR) -> None:
    ensure_runtime_dirs()
    for filename in os.listdir(cache_dir):
        file_path = os.path.join(cache_dir, filename)
        try:
            if os.path.isfile(file_path) or os.path.islink(file_path):
                os.unlink(file_path)
            elif os.path.isdir(file_path):
                shutil.rmtree(file_path)
        except Exception:
            pass

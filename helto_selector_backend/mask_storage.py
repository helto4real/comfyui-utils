from __future__ import annotations

import base64
import hashlib
import os
from io import BytesIO
from typing import Any

from PIL import Image, ImageOps

from .constants import CACHE_DIR, ensure_runtime_dirs
from .crypto import decrypt_bytes, encrypt_bytes

try:
    from ..shared.privacy import SELECTOR_MASK_PURPOSE
except ImportError:
    from shared.privacy import SELECTOR_MASK_PURPOSE

MASK_CACHE_DIR = os.path.join(CACHE_DIR, "masks")


def _ensure_mask_cache_dir(mask_cache_dir: str = MASK_CACHE_DIR) -> None:
    ensure_runtime_dirs()
    os.makedirs(mask_cache_dir, exist_ok=True)


def mask_cache_key(image_path: str) -> str:
    normalized = os.path.abspath(os.path.normpath(image_path))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def mask_cache_paths(image_path: str, mask_cache_dir: str = MASK_CACHE_DIR) -> tuple[str, str]:
    key = mask_cache_key(image_path)
    return (
        os.path.join(mask_cache_dir, f"{key}.png"),
        os.path.join(mask_cache_dir, f"{key}.png.enc"),
    )


def mask_ref_for_path(image_path: str) -> dict[str, str]:
    return {"key": mask_cache_key(image_path)}


def edited_mask_path_set(edited_masks: Any) -> set[str]:
    if not isinstance(edited_masks, dict):
        return set()
    return {path for path, ref in edited_masks.items() if isinstance(path, str) and ref}


def _decode_data_url(data_url: str) -> bytes:
    if "," in data_url and data_url.startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    return base64.b64decode(data_url.encode("utf-8"))


def _normalize_mask_png(mask_bytes: bytes) -> bytes:
    with Image.open(BytesIO(mask_bytes)) as img:
        img = ImageOps.exif_transpose(img).convert("L")
        output = BytesIO()
        img.save(output, format="PNG")
        return output.getvalue()


def save_mask_data_url(
    image_path: str,
    data_url: str,
    privacy_mode: bool,
    mask_cache_dir: str = MASK_CACHE_DIR,
) -> dict[str, str]:
    png_bytes = _normalize_mask_png(_decode_data_url(data_url))
    return save_mask_bytes(image_path, png_bytes, privacy_mode, mask_cache_dir)


def save_mask_bytes(
    image_path: str,
    png_bytes: bytes,
    privacy_mode: bool,
    mask_cache_dir: str = MASK_CACHE_DIR,
) -> dict[str, str]:
    _ensure_mask_cache_dir(mask_cache_dir)
    plain_path, encrypted_path = mask_cache_paths(image_path, mask_cache_dir)

    if privacy_mode:
        with open(encrypted_path, "wb") as f:
            f.write(encrypt_bytes(png_bytes, purpose=SELECTOR_MASK_PURPOSE))
        if os.path.exists(plain_path):
            os.remove(plain_path)
    else:
        with open(plain_path, "wb") as f:
            f.write(png_bytes)
        if os.path.exists(encrypted_path):
            os.remove(encrypted_path)

    return mask_ref_for_path(image_path)


def delete_mask(
    image_path: str,
    mask_cache_dir: str = MASK_CACHE_DIR,
) -> int:
    plain_path, encrypted_path = mask_cache_paths(image_path, mask_cache_dir)
    deleted_count = 0
    for path in (plain_path, encrypted_path):
        if os.path.exists(path):
            os.remove(path)
            deleted_count += 1
    return deleted_count


def load_mask_bytes(
    image_path: str,
    mask_cache_dir: str = MASK_CACHE_DIR,
) -> bytes | None:
    plain_path, encrypted_path = mask_cache_paths(image_path, mask_cache_dir)

    if os.path.exists(plain_path):
        with open(plain_path, "rb") as f:
            return f.read()

    if os.path.exists(encrypted_path):
        with open(encrypted_path, "rb") as f:
            return decrypt_bytes(f.read(), purpose=SELECTOR_MASK_PURPOSE)

    return None


def load_mask_image(
    image_path: str,
    mask_cache_dir: str = MASK_CACHE_DIR,
) -> Image.Image | None:
    mask_bytes = load_mask_bytes(image_path, mask_cache_dir)
    if mask_bytes is None:
        return None
    with Image.open(BytesIO(mask_bytes)) as img:
        return ImageOps.exif_transpose(img).convert("L")


def migrate_mask_privacy(
    image_paths: list[str],
    privacy_mode: bool,
    mask_cache_dir: str = MASK_CACHE_DIR,
) -> int:
    migrated = 0
    for image_path in image_paths:
        mask_bytes = load_mask_bytes(image_path, mask_cache_dir)
        if mask_bytes is None:
            continue
        save_mask_bytes(image_path, mask_bytes, privacy_mode, mask_cache_dir)
        migrated += 1
    return migrated

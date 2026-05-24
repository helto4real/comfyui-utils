from __future__ import annotations

import json
import os
from collections.abc import Callable

import numpy as np
import torch
from PIL import Image, ImageOps

from .crypto import decrypt_selection

DEFAULT_PLACEHOLDER_SIZE = 512
DEFAULT_RESIZE_MODE = "zoom to fit"


def make_placeholder_image(size: int = DEFAULT_PLACEHOLDER_SIZE) -> torch.Tensor:
    return torch.zeros((1, size, size, 3), dtype=torch.float32)


def make_image_batch(tensor_list: list[torch.Tensor]) -> torch.Tensor:
    if not tensor_list:
        return make_placeholder_image()

    first_shape = tensor_list[0].shape[1:]
    if all(tensor.shape[1:] == first_shape for tensor in tensor_list):
        return torch.cat(tensor_list, dim=0)

    max_h = max(tensor.shape[1] for tensor in tensor_list)
    max_w = max(tensor.shape[2] for tensor in tensor_list)
    padded_tensors = []

    for tensor in tensor_list:
        _, h, w, c = tensor.shape
        scale = min(max_w / w, max_h / h)
        resized_h = min(max_h, max(1, int(round(h * scale))))
        resized_w = min(max_w, max(1, int(round(w * scale))))

        if resized_h != h or resized_w != w:
            nchw_tensor = tensor.permute(0, 3, 1, 2)
            tensor = torch.nn.functional.interpolate(
                nchw_tensor,
                size=(resized_h, resized_w),
                mode="bilinear",
                align_corners=False,
            ).permute(0, 2, 3, 1)

        padded = torch.zeros((tensor.shape[0], max_h, max_w, c), dtype=tensor.dtype, device=tensor.device)
        offset_y = (max_h - tensor.shape[1]) // 2
        offset_x = (max_w - tensor.shape[2]) // 2
        padded[:, offset_y:offset_y + tensor.shape[1], offset_x:offset_x + tensor.shape[2], :] = tensor
        padded_tensors.append(padded)

    return torch.cat(padded_tensors, dim=0)


def parse_selected_paths(
    selected_images: str | None,
    decrypt_func: Callable[[str], str] = decrypt_selection,
) -> list[str]:
    raw_selection = decrypt_func(selected_images or "[]")
    try:
        image_paths = json.loads(raw_selection)
    except Exception as e:
        print(f"[HeltoSelector] Failed to parse selection JSON: {e}")
        return []

    if not isinstance(image_paths, list):
        print("[HeltoSelector] Selection JSON was not a list.")
        return []
    return [path for path in image_paths if isinstance(path, str)]


def filter_existing_paths(image_paths: list[str]) -> list[str]:
    valid_paths = [path for path in image_paths if os.path.exists(path)]
    if len(valid_paths) != len(image_paths):
        skipped = len(image_paths) - len(valid_paths)
        print(f"[HeltoSelector] Warning: Skipped {skipped} missing files.")
    return valid_paths


def load_rgb_images(paths: list[str]) -> list[Image.Image]:
    loaded_images = []
    for path in paths:
        try:
            with Image.open(path) as img:
                img = ImageOps.exif_transpose(img)
                loaded_images.append(img.convert("RGB"))
        except Exception as e:
            print(f"[HeltoSelector] Error loading image {path}: {e}")
    return loaded_images


def _resize_zoom_to_fit(images: list[Image.Image]) -> list[Image.Image]:
    target_w, target_h = images[0].size
    return [
        img.resize((target_w, target_h), Image.Resampling.LANCZOS)
        if img.size != (target_w, target_h)
        else img
        for img in images
    ]


def _pad_to_largest_image(images: list[Image.Image]) -> list[Image.Image]:
    max_w = max(img.size[0] for img in images)
    max_h = max(img.size[1] for img in images)
    processed_images = []
    for img in images:
        if img.size == (max_w, max_h):
            processed_images.append(img)
            continue
        new_img = Image.new("RGB", (max_w, max_h), (0, 0, 0))
        offset_x = (max_w - img.size[0]) // 2
        offset_y = (max_h - img.size[1]) // 2
        new_img.paste(img, (offset_x, offset_y))
        processed_images.append(new_img)
    return processed_images


def resize_images(images: list[Image.Image], resize_mode: str) -> list[Image.Image]:
    if resize_mode == DEFAULT_RESIZE_MODE:
        return _resize_zoom_to_fit(images)

    if resize_mode == "pad":
        return _pad_to_largest_image(images)

    return images


def image_to_tensor(img: Image.Image) -> torch.Tensor:
    img_np = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(img_np).unsqueeze(0)


def select_images(selected_images: str | None = "[]", resize_mode: str = DEFAULT_RESIZE_MODE) -> tuple[list[torch.Tensor], torch.Tensor]:
    image_paths = parse_selected_paths(selected_images)
    valid_paths = filter_existing_paths(image_paths)

    if not valid_paths:
        print("[HeltoSelector] No images selected. Outputting 512x512 black placeholder.")
        black_image = make_placeholder_image()
        return [black_image], black_image

    loaded_images = load_rgb_images(valid_paths)
    if not loaded_images:
        black_image = make_placeholder_image()
        return [black_image], black_image

    processed_images = resize_images(loaded_images, resize_mode)
    tensor_list = [image_to_tensor(img) for img in processed_images]
    return tensor_list, make_image_batch(tensor_list)

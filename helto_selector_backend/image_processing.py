from __future__ import annotations

import json
import os
from collections.abc import Callable
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageOps

from .crypto import decrypt_selection
from .mask_storage import edited_mask_path_set, load_mask_image

DEFAULT_PLACEHOLDER_SIZE = 512
DEFAULT_RESIZE_MODE = "zoom to fit"


def make_placeholder_image(size: int = DEFAULT_PLACEHOLDER_SIZE) -> torch.Tensor:
    return torch.zeros((1, size, size, 3), dtype=torch.float32)


def make_placeholder_mask(size: int = DEFAULT_PLACEHOLDER_SIZE) -> torch.Tensor:
    return torch.ones((1, size, size), dtype=torch.float32)


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


def make_mask_batch(tensor_list: list[torch.Tensor]) -> torch.Tensor:
    if not tensor_list:
        return make_placeholder_mask()

    first_shape = tensor_list[0].shape[1:]
    if all(tensor.shape[1:] == first_shape for tensor in tensor_list):
        return torch.cat(tensor_list, dim=0)

    max_h = max(tensor.shape[1] for tensor in tensor_list)
    max_w = max(tensor.shape[2] for tensor in tensor_list)
    padded_tensors = []

    for tensor in tensor_list:
        _, h, w = tensor.shape
        scale = min(max_w / w, max_h / h)
        resized_h = min(max_h, max(1, int(round(h * scale))))
        resized_w = min(max_w, max(1, int(round(w * scale))))

        if resized_h != h or resized_w != w:
            nchw_tensor = tensor.unsqueeze(1)
            tensor = torch.nn.functional.interpolate(
                nchw_tensor,
                size=(resized_h, resized_w),
                mode="bilinear",
                align_corners=False,
            ).squeeze(1)

        padded = torch.ones((tensor.shape[0], max_h, max_w), dtype=tensor.dtype, device=tensor.device)
        offset_y = (max_h - tensor.shape[1]) // 2
        offset_x = (max_w - tensor.shape[2]) // 2
        padded[:, offset_y:offset_y + tensor.shape[1], offset_x:offset_x + tensor.shape[2]] = tensor
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


def parse_edited_masks(
    edited_masks: str | None,
    decrypt_func: Callable[[str], str] = decrypt_selection,
) -> dict[str, Any]:
    raw_masks = decrypt_func(edited_masks or "{}")
    try:
        mask_map = json.loads(raw_masks)
    except Exception as e:
        print(f"[HeltoSelector] Failed to parse edited mask JSON: {e}")
        return {}

    if not isinstance(mask_map, dict):
        print("[HeltoSelector] Edited mask JSON was not an object.")
        return {}
    return {path: ref for path, ref in mask_map.items() if isinstance(path, str) and ref}


def parse_edited_bboxes(
    edited_bboxes: str | None,
    decrypt_func: Callable[[str], str] = decrypt_selection,
) -> dict[str, list[dict[str, float]]]:
    raw_bboxes = decrypt_func(edited_bboxes or "{}")
    try:
        bbox_map = json.loads(raw_bboxes)
    except Exception as e:
        print(f"[HeltoSelector] Failed to parse edited bbox JSON: {e}")
        return {}

    if not isinstance(bbox_map, dict):
        print("[HeltoSelector] Edited bbox JSON was not an object.")
        return {}

    parsed: dict[str, list[dict[str, float]]] = {}
    for path, boxes in bbox_map.items():
        if not isinstance(path, str) or not isinstance(boxes, list):
            continue
        valid_boxes = []
        for box in boxes:
            if not isinstance(box, dict):
                continue
            try:
                x = float(box["x"])
                y = float(box["y"])
                width = float(box["width"])
                height = float(box["height"])
            except (KeyError, TypeError, ValueError):
                continue
            if width <= 0 or height <= 0:
                continue
            valid_boxes.append({"x": x, "y": y, "width": width, "height": height})
        if valid_boxes:
            parsed[path] = valid_boxes
    return parsed


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


def load_rgb_image_pairs(paths: list[str]) -> list[tuple[str, Image.Image]]:
    loaded_images = []
    for path in paths:
        try:
            with Image.open(path) as img:
                img = ImageOps.exif_transpose(img)
                loaded_images.append((path, img.convert("RGB")))
        except Exception as e:
            print(f"[HeltoSelector] Error loading image {path}: {e}")
    return loaded_images


def load_masks_for_images(image_pairs: list[tuple[str, Image.Image]], edited_masks: dict[str, Any]) -> list[Image.Image]:
    edited_paths = edited_mask_path_set(edited_masks)
    masks = []
    for path, img in image_pairs:
        mask_img = load_mask_image(path) if path in edited_paths else None
        if mask_img is None:
            mask_img = Image.new("L", img.size, 255)
        elif mask_img.size != img.size:
            mask_img = mask_img.resize(img.size, Image.Resampling.BILINEAR)
        masks.append(mask_img)
    return masks


def _resize_zoom_to_fit(images: list[Image.Image]) -> list[Image.Image]:
    target_w, target_h = images[0].size
    return [
        img.resize((target_w, target_h), Image.Resampling.LANCZOS)
        if img.size != (target_w, target_h)
        else img
        for img in images
    ]


def _pad_to_largest_image(images: list[Image.Image], fill: int | tuple[int, int, int] = (0, 0, 0)) -> list[Image.Image]:
    max_w = max(img.size[0] for img in images)
    max_h = max(img.size[1] for img in images)
    processed_images = []
    for img in images:
        if img.size == (max_w, max_h):
            processed_images.append(img)
            continue
        new_img = Image.new(img.mode, (max_w, max_h), fill)
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


def resize_masks(masks: list[Image.Image], resize_mode: str) -> list[Image.Image]:
    if resize_mode == DEFAULT_RESIZE_MODE:
        return _resize_zoom_to_fit(masks)

    if resize_mode == "pad":
        return _pad_to_largest_image(masks, fill=255)

    return masks


def _round_bbox(x1: float, y1: float, x2: float, y2: float) -> dict[str, int] | None:
    rounded_x1 = int(round(x1))
    rounded_y1 = int(round(y1))
    rounded_x2 = int(round(x2))
    rounded_y2 = int(round(y2))
    if rounded_x2 <= rounded_x1 or rounded_y2 <= rounded_y1:
        return None
    return {
        "x": rounded_x1,
        "y": rounded_y1,
        "width": rounded_x2 - rounded_x1,
        "height": rounded_y2 - rounded_y1,
    }


def _transformed_image_batch_layouts(images: list[Image.Image]) -> list[tuple[float, float, float]]:
    if not images:
        return []

    max_w = max(img.size[0] for img in images)
    max_h = max(img.size[1] for img in images)
    layouts = []
    for img in images:
        w, h = img.size
        scale = min(max_w / w, max_h / h)
        resized_w = min(max_w, max(1, int(round(w * scale))))
        resized_h = min(max_h, max(1, int(round(h * scale))))
        offset_x = (max_w - resized_w) // 2
        offset_y = (max_h - resized_h) // 2
        layouts.append((scale, float(offset_x), float(offset_y)))
    return layouts


def transform_bboxes_for_output(
    image_pairs: list[tuple[str, Image.Image]],
    processed_images: list[Image.Image],
    edited_bboxes: dict[str, list[dict[str, float]]],
    resize_mode: str,
) -> list[list[dict[str, int]]]:
    layouts = _transformed_image_batch_layouts(processed_images)
    output_bboxes: list[list[dict[str, int]]] = []
    pad_w = max((img.size[0] for img in processed_images), default=0)
    pad_h = max((img.size[1] for img in processed_images), default=0)

    for index, (path, original_image) in enumerate(image_pairs):
        boxes = edited_bboxes.get(path, [])
        if not boxes:
            output_bboxes.append([])
            continue

        original_w, original_h = original_image.size
        processed_w, processed_h = processed_images[index].size
        batch_scale, batch_offset_x, batch_offset_y = layouts[index]
        pre_scale_x = processed_w / original_w if resize_mode == DEFAULT_RESIZE_MODE else 1.0
        pre_scale_y = processed_h / original_h if resize_mode == DEFAULT_RESIZE_MODE else 1.0
        pre_offset_x = ((pad_w - original_w) // 2) if resize_mode == "pad" else 0.0
        pre_offset_y = ((pad_h - original_h) // 2) if resize_mode == "pad" else 0.0
        frame_boxes = []

        for box in boxes:
            x1 = max(0.0, min(float(box["x"]), float(original_w)))
            y1 = max(0.0, min(float(box["y"]), float(original_h)))
            x2 = max(0.0, min(float(box["x"] + box["width"]), float(original_w)))
            y2 = max(0.0, min(float(box["y"] + box["height"]), float(original_h)))
            if x2 <= x1 or y2 <= y1:
                continue
            transformed = _round_bbox(
                ((x1 * pre_scale_x) + pre_offset_x) * batch_scale + batch_offset_x,
                ((y1 * pre_scale_y) + pre_offset_y) * batch_scale + batch_offset_y,
                ((x2 * pre_scale_x) + pre_offset_x) * batch_scale + batch_offset_x,
                ((y2 * pre_scale_y) + pre_offset_y) * batch_scale + batch_offset_y,
            )
            if transformed is not None:
                frame_boxes.append(transformed)

        output_bboxes.append(frame_boxes)
    return output_bboxes


def image_to_tensor(img: Image.Image) -> torch.Tensor:
    img_np = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(img_np).unsqueeze(0)


def mask_to_tensor(img: Image.Image) -> torch.Tensor:
    mask_np = np.array(img.convert("L")).astype(np.float32) / 255.0
    return torch.from_numpy(mask_np).unsqueeze(0)


def select_images(
    selected_images: str | None = "[]",
    resize_mode: str = DEFAULT_RESIZE_MODE,
    edited_masks: str | None = "{}",
    edited_bboxes: str | None = "{}",
) -> tuple[list[torch.Tensor], torch.Tensor, list[torch.Tensor], torch.Tensor, list[list[dict[str, int]]]]:
    image_paths = parse_selected_paths(selected_images)
    edited_mask_map = parse_edited_masks(edited_masks)
    edited_bbox_map = parse_edited_bboxes(edited_bboxes)
    valid_paths = filter_existing_paths(image_paths)

    if not valid_paths:
        print("[HeltoSelector] No images selected. Outputting 512x512 black placeholder.")
        black_image = make_placeholder_image()
        white_mask = make_placeholder_mask()
        return [black_image], black_image, [white_mask], white_mask, [[]]

    image_pairs = load_rgb_image_pairs(valid_paths)
    if not image_pairs:
        black_image = make_placeholder_image()
        white_mask = make_placeholder_mask()
        return [black_image], black_image, [white_mask], white_mask, [[]]

    loaded_images = [img for _, img in image_pairs]
    loaded_masks = load_masks_for_images(image_pairs, edited_mask_map)
    processed_images = resize_images(loaded_images, resize_mode)
    processed_masks = resize_masks(loaded_masks, resize_mode)
    output_bboxes = transform_bboxes_for_output(image_pairs, processed_images, edited_bbox_map, resize_mode)
    tensor_list = [image_to_tensor(img) for img in processed_images]
    mask_list = [mask_to_tensor(mask) for mask in processed_masks]
    return tensor_list, make_image_batch(tensor_list), mask_list, make_mask_batch(mask_list), output_bboxes

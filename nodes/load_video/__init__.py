from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F
from comfy_api.latest import InputImpl, io

try:
    import comfy.model_management
except Exception:
    comfy = None

from .video_config import resolve_video_path
from . import video_routes  # noqa: F401


_SILENT_SAMPLE_RATE = 44100


def _empty_audio(duration: float = 0.0) -> dict[str, Any]:
    samples = max(1, int(max(float(duration), 0.0) * _SILENT_SAMPLE_RATE))
    return {"waveform": torch.zeros((1, 1, samples), dtype=torch.float32), "sample_rate": _SILENT_SAMPLE_RATE}


def _empty_images() -> torch.Tensor:
    return torch.zeros((1, 64, 64, 3), dtype=torch.float32)


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except Exception:
        return default


def _as_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except Exception:
        return default


def _resolve_source(video: str, video_folder_alias: str) -> Path:
    video = str(video or "").strip()
    if not video:
        raise FileNotFoundError("No video selected.")
    return resolve_video_path(video_folder_alias or "input", video)


def _target_device_dtype() -> tuple[torch.device | str, torch.dtype]:
    if comfy is None:
        return "cpu", torch.float32
    return comfy.model_management.intermediate_device(), comfy.model_management.intermediate_dtype()


def _normalize_images(images: torch.Tensor) -> torch.Tensor:
    if images.ndim != 4 or images.shape[-1] < 1:
        return _empty_images()

    images = images.float().clamp(0, 1)
    channels = images.shape[-1]
    if channels == 1:
        images = images.repeat(1, 1, 1, 3)
    elif channels > 3:
        images = images[..., :3]
    elif channels != 3:
        return _empty_images()
    return images


def _sample_indices(frame_count: int, source_fps: float, select_every_nth: int, force_rate: float) -> tuple[list[int], float]:
    if frame_count <= 0:
        return [], max(force_rate, source_fps, 0.0)

    select_every_nth = max(1, int(select_every_nth))
    base_indices = list(range(0, frame_count, select_every_nth))
    if not base_indices:
        return [], max(force_rate, source_fps, 0.0)

    fps_after_select = source_fps / select_every_nth if source_fps > 0 else source_fps
    if force_rate <= 0 or fps_after_select <= 0:
        return base_indices, fps_after_select

    duration = len(base_indices) / fps_after_select
    sample_count = max(1, int(math.ceil(duration * force_rate)))
    sampled: list[int] = []
    for out_index in range(sample_count):
        source_pos = int(round((out_index / force_rate) * fps_after_select))
        sampled.append(base_indices[min(source_pos, len(base_indices) - 1)])
    return sampled, force_rate


def _trim_audio(audio: dict[str, Any] | None, start_offset: float, duration: float) -> dict[str, Any]:
    if audio is None:
        return _empty_audio(duration)

    try:
        waveform = audio["waveform"]
        sample_rate = int(audio["sample_rate"])
    except Exception:
        return _empty_audio(duration)

    if waveform is None or sample_rate <= 0:
        return _empty_audio(duration)

    start_sample = max(0, int(start_offset * sample_rate))
    end_sample = start_sample + max(1, int(max(duration, 0.0) * sample_rate))
    trimmed = waveform[..., start_sample:end_sample]
    if trimmed.shape[-1] == 0:
        trimmed = torch.zeros((*waveform.shape[:-1], 1), dtype=waveform.dtype, device=waveform.device)
    return {"waveform": trimmed, "sample_rate": sample_rate}


def _resize_images(images: torch.Tensor, resize_mode: str, custom_width: int, custom_height: int) -> torch.Tensor:
    resize_mode = str(resize_mode or "original")
    if resize_mode == "original":
        return images

    frame_count, height, width, channels = images.shape
    target_width = int(custom_width) if custom_width > 0 else width
    target_height = int(custom_height) if custom_height > 0 else height
    if target_width <= 0 or target_height <= 0 or (target_width == width and target_height == height and resize_mode == "resize"):
        return images

    image_bchw = images.permute(0, 3, 1, 2)

    if resize_mode == "resize":
        resized = F.interpolate(image_bchw, size=(target_height, target_width), mode="bilinear", align_corners=False)
        return resized.permute(0, 2, 3, 1).contiguous()

    scale = min(target_width / width, target_height / height) if resize_mode == "pad" else max(target_width / width, target_height / height)
    scaled_width = max(1, int(round(width * scale)))
    scaled_height = max(1, int(round(height * scale)))
    resized = F.interpolate(image_bchw, size=(scaled_height, scaled_width), mode="bilinear", align_corners=False)

    if resize_mode == "pad":
        output = torch.zeros((frame_count, channels, target_height, target_width), dtype=resized.dtype, device=resized.device)
        top = max(0, (target_height - scaled_height) // 2)
        left = max(0, (target_width - scaled_width) // 2)
        output[:, :, top : top + scaled_height, left : left + scaled_width] = resized
        return output.permute(0, 2, 3, 1).contiguous()

    if resize_mode == "crop":
        top = max(0, (scaled_height - target_height) // 2)
        left = max(0, (scaled_width - target_width) // 2)
        cropped = resized[:, :, top : top + target_height, left : left + target_width]
        return cropped.permute(0, 2, 3, 1).contiguous()

    return images


class HeltoLoadVideo(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoLoadVideo",
            display_name="Load Video",
            category="HELTO/Video",
            description="Loads a selected video as image frames, audio, and video metadata.",
            inputs=[
                io.String.Input("video", default=""),
                io.String.Input("video_folder_alias", default="input"),
                io.Float.Input("start_time", default=0.0, min=0.0, max=100000.0, step=0.01),
                io.Float.Input("duration", default=0.0, min=0.0, max=100000.0, step=0.01),
                io.Float.Input("force_rate", default=0.0, min=0.0, max=1000.0, step=0.01),
                io.Int.Input("frame_load_cap", default=0, min=0, max=1000000, step=1),
                io.Int.Input("skip_first_frames", default=0, min=0, max=1000000, step=1),
                io.Int.Input("select_every_nth", default=1, min=1, max=1000000, step=1),
                io.Combo.Input("resize_mode", options=["original", "resize", "pad", "crop"], default="original"),
                io.Int.Input("custom_width", default=0, min=0, max=16384, step=8),
                io.Int.Input("custom_height", default=0, min=0, max=16384, step=8),
            ],
            outputs=[
                io.Image.Output("images"),
                io.Audio.Output("audio"),
                io.Float.Output("fps"),
                io.Int.Output("width"),
                io.Int.Output("height"),
                io.Float.Output("duration"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, video: str = "", video_folder_alias: str = "input", **kwargs) -> str:
        try:
            path = _resolve_source(video, video_folder_alias)
            stat = path.stat()
            source = f"{path}:{stat.st_mtime_ns}:{stat.st_size}"
        except Exception:
            source = f"{video_folder_alias}:{video}"
        settings = "|".join(f"{key}={value}" for key, value in sorted(kwargs.items()))
        return f"{source}|{settings}"

    @classmethod
    def execute(
        cls,
        video: str = "",
        video_folder_alias: str = "input",
        start_time: float = 0.0,
        duration: float = 0.0,
        force_rate: float = 0.0,
        frame_load_cap: int = 0,
        skip_first_frames: int = 0,
        select_every_nth: int = 1,
        resize_mode: str = "original",
        custom_width: int = 0,
        custom_height: int = 0,
    ) -> io.NodeOutput:
        try:
            source_path = _resolve_source(video, video_folder_alias)
        except Exception:
            return io.NodeOutput(_empty_images(), _empty_audio(), 0.0, 64, 64, 0.0)

        start_time = max(_as_float(start_time), 0.0)
        requested_duration = max(_as_float(duration), 0.0)
        force_rate = max(0.0, _as_float(force_rate, 0.0))
        frame_load_cap = max(0, _as_int(frame_load_cap))
        select_every_nth = max(1, _as_int(select_every_nth, 1))
        skip_first_frames = max(0, _as_int(skip_first_frames))

        metadata_source = InputImpl.VideoFromFile(str(source_path))
        metadata_fps = _as_float(metadata_source.get_frame_rate(), 0.0)
        load_duration = requested_duration
        if frame_load_cap > 0 and metadata_fps > 0:
            if force_rate > 0:
                capped_duration = (skip_first_frames / metadata_fps) + (frame_load_cap / force_rate)
            else:
                capped_duration = (skip_first_frames + (frame_load_cap * select_every_nth)) / metadata_fps
            capped_duration += 1.0 / metadata_fps
            load_duration = min(requested_duration, capped_duration) if requested_duration > 0 else capped_duration

        source = InputImpl.VideoFromFile(str(source_path), start_time=start_time, duration=load_duration)
        components = source.get_components()
        source_fps = _as_float(components.frame_rate, metadata_fps)

        images = _normalize_images(components.images)
        if skip_first_frames >= images.shape[0]:
            return io.NodeOutput(_empty_images(), _trim_audio(components.audio, 0.0, 0.0), source_fps, 64, 64, 0.0)

        if skip_first_frames > 0:
            images = images[skip_first_frames:]

        indices, output_fps = _sample_indices(
            int(images.shape[0]),
            source_fps,
            select_every_nth,
            force_rate,
        )
        if frame_load_cap > 0:
            indices = indices[:frame_load_cap]

        if indices:
            images = images[torch.tensor(indices, dtype=torch.long)]
        else:
            images = _empty_images()
            output_fps = source_fps

        output_fps = output_fps if output_fps > 0 else source_fps
        output_duration = float(images.shape[0] / output_fps) if output_fps > 0 else 0.0
        audio_start_offset = (skip_first_frames / source_fps) if source_fps > 0 else 0.0
        audio = _trim_audio(components.audio, audio_start_offset, output_duration)

        images = _resize_images(
            images,
            resize_mode=resize_mode,
            custom_width=max(0, _as_int(custom_width)),
            custom_height=max(0, _as_int(custom_height)),
        )

        device, dtype = _target_device_dtype()
        images = images.to(device=device, dtype=dtype)
        height = int(images.shape[1]) if images.ndim == 4 else 0
        width = int(images.shape[2]) if images.ndim == 4 else 0

        return io.NodeOutput(images, audio, float(output_fps), width, height, float(output_duration))

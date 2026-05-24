from __future__ import annotations

import os
import re
import uuid
from fractions import Fraction
from typing import Any

import folder_paths
import torch
from comfy_api.latest import InputImpl, Types, io, ui


_PREVIEW_SUBFOLDER = "helto_video_comparer"


def _safe_node_id(value: Any) -> str:
    if value is None:
        return "default"
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value))[:80] or "default"


def _hidden_node_id(cls: type[io.ComfyNode]) -> str:
    hidden = getattr(cls, "hidden", None)
    unique_id = getattr(hidden, "unique_id", None)
    return _safe_node_id(unique_id)


def _frame_rate_fraction(frame_rate: float) -> Fraction:
    if frame_rate <= 0:
        raise ValueError("Video Comparer requires a frame rate greater than 0.")
    return Fraction(round(float(frame_rate) * 1000), 1000)


def _prepare_image_frames(images: torch.Tensor) -> torch.Tensor:
    if images.ndim != 4:
        raise ValueError("Video Comparer image inputs must use ComfyUI's [frames, height, width, channels] shape.")

    frames = images.detach().cpu().float().clamp(0, 1)
    channels = frames.shape[-1]
    if channels == 1:
        frames = frames.repeat(1, 1, 1, 3)
    elif channels > 3:
        frames = frames[..., :3]
    elif channels != 3:
        raise ValueError("Video Comparer image inputs must have 1, 3, or 4 channels.")

    height, width = frames.shape[1], frames.shape[2]
    pad_height = height % 2
    pad_width = width % 2
    if pad_height or pad_width:
        padded = torch.zeros(
            (frames.shape[0], height + pad_height, width + pad_width, 3),
            dtype=frames.dtype,
        )
        padded[:, :height, :width, :] = frames
        frames = padded

    return frames


class VideoComparer(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        def video_input(name: str) -> io.Input:
            return io.MultiType.Input(
                name,
                [io.Video, io.Image],
                tooltip="A VIDEO input, or an IMAGE frame batch that will be encoded for preview.",
            )

        return io.Schema(
            node_id="HeltoVideoComparer",
            display_name="Video Comparer",
            category="HELTO/Video",
            description="Compares two videos side by side in a synchronized node preview.",
            inputs=[
                video_input("video_1"),
                video_input("video_2"),
                io.Float.Input("frame_rate", default=24.0, min=0.01, max=1000.0, step=0.01),
            ],
            outputs=[],
            hidden=[
                io.Hidden.unique_id,
            ],
            is_output_node=True,
            not_idempotent=True,
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs) -> float:
        return float("NaN")

    @classmethod
    def execute(cls, video_1, video_2, frame_rate: float = 24.0) -> io.NodeOutput:
        result = {
            "video_comparison": [{
                "videos": [
                    cls._preview_result(video_1, "video_1", frame_rate),
                    cls._preview_result(video_2, "video_2", frame_rate),
                ],
                "frame_rate": float(frame_rate),
            }]
        }

        return io.NodeOutput(ui=result)

    @classmethod
    def _preview_result(cls, source, slot: str, frame_rate: float) -> ui.SavedResult:
        preview_dir = os.path.join(folder_paths.get_temp_directory(), _PREVIEW_SUBFOLDER)
        os.makedirs(preview_dir, exist_ok=True)

        filename = f"{_hidden_node_id(cls)}_{slot}_{uuid.uuid4().hex}.mp4"
        output_path = os.path.join(preview_dir, filename)

        metadata = {
            "node": "HeltoVideoComparer",
            "slot": slot,
            "frame_rate": float(frame_rate),
        }

        if hasattr(source, "save_to"):
            source.save_to(
                output_path,
                format=Types.VideoContainer.MP4,
                codec=Types.VideoCodec.H264,
                metadata=metadata,
            )
        else:
            frames = _prepare_image_frames(source)
            video = InputImpl.VideoFromComponents(
                Types.VideoComponents(
                    images=frames,
                    audio=None,
                    frame_rate=_frame_rate_fraction(float(frame_rate)),
                    metadata=metadata,
                )
            )
            video.save_to(output_path, format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264, metadata=metadata)

        return ui.SavedResult(filename, _PREVIEW_SUBFOLDER, io.FolderType.temp)

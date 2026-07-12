from __future__ import annotations

import os
import re
import uuid
from io import BytesIO
from fractions import Fraction
from typing import Any

import folder_paths
import torch
from comfy_api.latest import InputImpl, Types, io, ui

from ...shared.managed_privacy import utils_media_artifacts


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


def _materialize_audio(audio, slot: str):
    if audio is None:
        return None

    try:
        waveform = audio["waveform"]
        sample_rate = audio["sample_rate"]
    except Exception as exc:
        print(f"Video Comparer ignored unavailable {slot} audio: {exc}")
        return None

    if waveform is None or sample_rate is None:
        return None

    return {
        "waveform": waveform,
        "sample_rate": sample_rate,
    }


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
            display_name="Helto Video Comparer",
            category="HELTO/Video",
            description="Compares two videos side by side in a synchronized node preview.",
            inputs=[
                video_input("video_1"),
                video_input("video_2"),
                io.Audio.Input("audio_1", optional=True, tooltip="Audio source for video 1 preview playback."),
                io.Audio.Input("audio_2", optional=True, tooltip="Audio source for video 2 preview playback."),
                io.Float.Input("frame_rate", default=24.0, min=0.01, max=1000.0, step=0.01),
                io.Boolean.Input("privacy_mode", default=True),
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
    async def execute(
        cls,
        video_1,
        video_2,
        audio_1=None,
        audio_2=None,
        frame_rate: float = 24.0,
        privacy_mode: bool = True,
        unique_id: str | None = None,
    ) -> io.NodeOutput:
        if privacy_mode:
            managed = utils_media_artifacts()
            owner = str(unique_id or "helto-video-comparer")
            videos = [
                await cls._managed_preview_record(
                    video_1,
                    "video_1",
                    frame_rate,
                    managed,
                    owner_key=f"{owner}:video-1",
                    audio=audio_1,
                ),
                await cls._managed_preview_record(
                    video_2,
                    "video_2",
                    frame_rate,
                    managed,
                    owner_key=f"{owner}:video-2",
                    audio=audio_2,
                ),
            ]
        else:
            videos = [
                cls._preview_result(video_1, "video_1", frame_rate, audio_1, privacy_mode=False),
                cls._preview_result(video_2, "video_2", frame_rate, audio_2, privacy_mode=False),
            ]
        result = {
            "video_comparison": [{
                "videos": videos,
                "frame_rate": float(frame_rate),
            }]
        }

        return io.NodeOutput(ui=result)

    @classmethod
    def _preview_result(cls, source, slot: str, frame_rate: float, audio=None, privacy_mode: bool = True) -> ui.SavedResult | dict:
        preview_dir = os.path.join(folder_paths.get_temp_directory(), _PREVIEW_SUBFOLDER)
        audio = _materialize_audio(audio, slot)

        filename = f"{_hidden_node_id(cls)}_{slot}_{uuid.uuid4().hex}.mp4"
        output_path = os.path.join(preview_dir, filename)

        metadata = {
            "node": "HeltoVideoComparer",
            "slot": slot,
            "frame_rate": float(frame_rate),
        }

        target = BytesIO() if privacy_mode else output_path
        if not privacy_mode:
            os.makedirs(preview_dir, exist_ok=True)

        cls._encode_preview_to(
            source,
            target,
            frame_rate=frame_rate,
            audio=audio,
            metadata=metadata,
        )

        if privacy_mode:
            raise RuntimeError("Private previews require managed artifacts.")

        return ui.SavedResult(filename, _PREVIEW_SUBFOLDER, io.FolderType.temp)

    @classmethod
    def _encode_preview_to(
        cls,
        source,
        target,
        *,
        frame_rate: float,
        audio,
        metadata: dict,
    ) -> None:
        if hasattr(source, "save_to"):
            if audio is None:
                source.save_to(
                    target,
                    format=Types.VideoContainer.MP4,
                    codec=Types.VideoCodec.H264,
                    metadata=metadata,
                )
            else:
                components = source.get_components()
                video = InputImpl.VideoFromComponents(
                    Types.VideoComponents(
                        images=components.images,
                        audio=audio,
                        frame_rate=components.frame_rate,
                        metadata=metadata,
                    )
                )
                video.save_to(
                    target,
                    format=Types.VideoContainer.MP4,
                    codec=Types.VideoCodec.H264,
                    metadata=metadata,
                )
        else:
            frames = _prepare_image_frames(source)
            video = InputImpl.VideoFromComponents(
                Types.VideoComponents(
                    images=frames,
                    audio=audio,
                    frame_rate=_frame_rate_fraction(float(frame_rate)),
                    metadata=metadata,
                )
            )
            video.save_to(target, format=Types.VideoContainer.MP4, codec=Types.VideoCodec.H264, metadata=metadata)

    @classmethod
    def _encode_preview_bytes(
        cls,
        source,
        slot: str,
        frame_rate: float,
        audio=None,
    ) -> bytes:
        target = BytesIO()
        cls._encode_preview_to(
            source,
            target,
            frame_rate=frame_rate,
            audio=_materialize_audio(audio, slot),
            metadata={
                "node": "HeltoVideoComparer",
                "slot": slot,
                "frame_rate": float(frame_rate),
            },
        )
        return target.getvalue()

    @classmethod
    async def _managed_preview_record(
        cls,
        source,
        slot: str,
        frame_rate: float,
        managed_artifacts,
        *,
        owner_key: str,
        audio=None,
        privacy_mode: object = True,
        mode_facts: object = None,
        execution: object = None,
    ) -> dict:
        records = await managed_artifacts.publish_encoded_previews(
            "HeltoVideoComparer",
            lambda: [
                cls._encode_preview_bytes(source, slot, frame_rate, audio)
            ],
            owner_key=owner_key,
            privacy_mode=privacy_mode,
            mode_facts=mode_facts,
            execution=execution,
        )
        return records[0].to_record()

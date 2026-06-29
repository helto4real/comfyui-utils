from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from collections.abc import Mapping
from datetime import date
from io import BytesIO
from pathlib import Path
from string import Template
from typing import Any

from aiohttp import web
import folder_paths
import numpy as np
import server
import torch
from comfy.cli_args import args as comfy_args
from comfy.utils import ProgressBar
from comfy_api.latest import io, ui
from comfy_execution.graph import ExecutionBlocker
from PIL import Image, ExifTags
from PIL.PngImagePlugin import PngInfo

from ...shared import progress_api as helto_progress
from ...shared.privacy import (
    content_type_for_path,
    decrypt_bytes,
    encrypt_bytes,
    private_media_record,
    write_encrypted_temp_file,
)
from ...shared.temp_cache import private_temp_cache_dir, public_temp_cache_dir


_COUNTER_RE_TEMPLATE = r"^{prefix}_(?P<counter>\d+)(?:-audio)?\.[^.]+$"
_VHS_FORMAT_FOLDER = "VHS_video_formats"
_FORMAT_CACHE: tuple[list[str], dict[str, list[list[Any]]], dict[str, dict[str, Any]]] | None = None
_FALLBACK_FORMATS: dict[str, dict[str, Any]] = {
    "h264-mp4": {
        "main_pass": [
            "-n",
            "-c:v",
            "libx264",
            "-pix_fmt",
            ["pix_fmt", ["yuv420p", "yuv420p10le"]],
            "-crf",
            ["crf", "INT", {"default": 19, "min": 0, "max": 100, "step": 1}],
            "-vf",
            "scale=out_color_matrix=bt709",
            "-color_range",
            "tv",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
        ],
        "fake_trc": "bt709",
        "audio_pass": ["-c:a", "aac"],
        "save_metadata": ["save_metadata", "BOOLEAN", {"default": True}],
        "trim_to_audio": ["trim_to_audio", "BOOLEAN", {"default": False}],
        "extension": "mp4",
    },
    "webm": {
        "main_pass": [
            "-n",
            "-pix_fmt",
            ["pix_fmt", ["yuv420p", "yuva420p"]],
            "-crf",
            ["crf", "INT", {"default": 20, "min": 0, "max": 100, "step": 1}],
            "-b:v",
            "0",
            "-vf",
            "scale=out_color_matrix=bt709",
            "-color_range",
            "tv",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
        ],
        "fake_trc": "bt709",
        "audio_pass": ["-c:a", "libvorbis"],
        "save_metadata": ["save_metadata", "BOOLEAN", {"default": True}],
        "trim_to_audio": ["trim_to_audio", "BOOLEAN", {"default": False}],
        "extension": "webm",
    },
    "ffmpeg-gif": {
        "main_pass": [
            "-n",
            "-filter_complex",
            [
                "dither",
                [
                    "bayer",
                    "heckbert",
                    "floyd_steinberg",
                    "sierra2",
                    "sierra2_4a",
                    "sierra3",
                    "burkes",
                    "atkinson",
                    "none",
                ],
                {"default": "sierra2_4a"},
                "[0:v] split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse=dither=$val",
            ],
        ],
        "extension": "gif",
    },
}


def _safe_node_id(value: Any) -> str:
    if value is None:
        return "default"
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value))[:80] or "default"


def _tensor_to_int(tensor: torch.Tensor, bits: int) -> np.ndarray:
    array = tensor.detach().cpu().numpy() * (2**bits - 1) + 0.5
    return np.clip(array, 0, (2**bits - 1))


def _tensor_to_bytes(tensor: torch.Tensor) -> np.ndarray:
    return _tensor_to_int(tensor, 8).astype(np.uint8)


def _tensor_to_shorts(tensor: torch.Tensor) -> np.ndarray:
    return _tensor_to_int(tensor, 16).astype(np.uint16)


def _to_pingpong(frames: list[torch.Tensor]) -> list[torch.Tensor]:
    if len(frames) <= 2:
        return frames
    return frames + list(reversed(frames[1:-1]))


def _is_format_widget(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) >= 2
        and isinstance(value[0], str)
        and (
            value[1] in ("BOOLEAN", "INT", "FLOAT", "STRING")
            or isinstance(value[1], list)
        )
    )


def _iter_format_widgets(value: Any):
    if _is_format_widget(value):
        yield value[:3]
        return

    if isinstance(value, dict):
        for key, child in value.items():
            if key == "extra_widgets" and isinstance(child, list):
                for widget in child:
                    if _is_format_widget(widget):
                        yield widget[:3]
                continue
            yield from _iter_format_widgets(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_format_widgets(child)


def _widget_default(widget: list[Any]) -> Any:
    if len(widget) > 2 and isinstance(widget[2], dict) and "default" in widget[2]:
        return widget[2]["default"]
    if isinstance(widget[1], list) and widget[1]:
        return widget[1][0]
    return {"BOOLEAN": False, "INT": 0, "FLOAT": 0, "STRING": ""}.get(widget[1], "")


def _format_paths() -> dict[str, Path]:
    paths: dict[str, Path] = {}

    if _VHS_FORMAT_FOLDER in folder_paths.folder_names_and_paths:
        for filename in folder_paths.get_filename_list(_VHS_FORMAT_FOLDER):
            full_path = folder_paths.get_full_path(_VHS_FORMAT_FOLDER, filename)
            if full_path:
                paths[Path(filename).stem] = Path(full_path)

    package_root = Path(__file__).resolve().parents[2]
    candidate_dirs = [
        package_root.parent / "ComfyUI-Helto-VideoHelperSuite" / "video_formats",
        package_root.parent / "ComfyUI-VideoHelperSuite" / "video_formats",
    ]

    if "custom_nodes" in folder_paths.folder_names_and_paths:
        for custom_nodes_dir in folder_paths.get_folder_paths("custom_nodes"):
            base = Path(custom_nodes_dir)
            candidate_dirs.extend(
                [
                    base / "ComfyUI-Helto-VideoHelperSuite" / "video_formats",
                    base / "ComfyUI-VideoHelperSuite" / "video_formats",
                ]
            )

    for directory in candidate_dirs:
        if not directory.is_dir():
            continue
        for path in directory.glob("*.json"):
            paths[path.stem] = path

    return paths


def _load_video_format(name: str, path: Path | None = None) -> dict[str, Any]:
    if path is None:
        fallback = _FALLBACK_FORMATS.get(name)
        if fallback is None:
            raise ValueError(f"Unknown video format preset: {name}")
        return json.loads(json.dumps(fallback))

    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def _available_formats() -> tuple[list[str], dict[str, list[list[Any]]], dict[str, dict[str, Any]]]:
    global _FORMAT_CACHE
    if _FORMAT_CACHE is not None:
        return _FORMAT_CACHE

    format_paths = _format_paths()
    presets: dict[str, dict[str, Any]] = {}
    for name, path in format_paths.items():
        try:
            preset = _load_video_format(name, path)
        except Exception as exc:
            print(f"Save Video Advanced ignored invalid video format {path}: {exc}")
            continue
        if "gifski_pass" in preset:
            continue
        if "%" in str(preset.get("extension", "")):
            continue
        presets[name] = preset

    for name, preset in _FALLBACK_FORMATS.items():
        presets.setdefault(name, json.loads(json.dumps(preset)))

    format_options = ["image/gif", "image/webp"] + [f"video/{name}" for name in sorted(presets)]
    format_widgets: dict[str, list[list[Any]]] = {
        "image/webp": [["lossless", "BOOLEAN", {"default": True}]],
    }
    for name, preset in presets.items():
        widgets = list(_iter_format_widgets(preset))
        if widgets:
            format_widgets[f"video/{name}"] = widgets

    _FORMAT_CACHE = (format_options, format_widgets, presets)
    return _FORMAT_CACHE


def _template_value(value: str, params: dict[str, Any]) -> str:
    return Template(value).safe_substitute(**params)


def _resolve_format_value(value: Any, params: dict[str, Any]) -> Any:
    if isinstance(value, str):
        return _template_value(value, params)

    if isinstance(value, list):
        if len(value) == 1 and isinstance(value[0], list):
            return [_template_value(str(item), params) for item in value[0]]

        if len(value) >= 2 and isinstance(value[0], str) and isinstance(value[1], dict):
            selected = params.get(value[0])
            selected_key = str(selected)
            mapped = value[1].get(selected_key)
            if mapped is None and isinstance(selected, bool):
                mapped = value[1].get("True" if selected else "False")
            if mapped is None:
                mapped = value[1].get(str(_widget_default([value[0], list(value[1].keys())])))
            return _resolve_format_value(mapped if mapped is not None else [], params)

        if _is_format_widget(value):
            selected = params.get(value[0], _widget_default(value))
            if len(value) > 3:
                return Template(str(value[3])).safe_substitute(val=selected, **params)
            return str(selected)

        resolved = []
        for item in value:
            child = _resolve_format_value(item, params)
            if isinstance(child, list):
                resolved.extend(child)
            elif child is not None:
                resolved.append(child)
        return resolved

    if isinstance(value, dict):
        return {key: _resolve_format_value(child, params) for key, child in value.items()}

    return value


def _apply_format_widgets(format_name: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    _, _, presets = _available_formats()
    if format_name in presets:
        preset = json.loads(json.dumps(presets[format_name]))
    else:
        preset = _load_video_format(format_name, None)

    params = dict(kwargs)
    for widget in _iter_format_widgets(preset):
        params.setdefault(widget[0], _widget_default(widget))

    return _resolve_format_value(preset, params)


def _merge_filter_args(command: list[str], flag: str = "-vf") -> None:
    try:
        first = command.index(flag) + 1
        index = first + 1
        while True:
            index = command.index(flag, index)
            command[first] += "," + command[index + 1]
            command.pop(index)
            command.pop(index)
    except ValueError:
        pass


def _find_ffmpeg() -> str | None:
    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        if ffmpeg and os.path.exists(ffmpeg):
            return ffmpeg
    except Exception:
        pass
    return shutil.which("ffmpeg")


class SaveVideoAdvanced(io.ComfyNode):
    state = {
        "previews": {},
        "media": {},
        "releases": {},
    }

    @classmethod
    def define_schema(cls) -> io.Schema:
        formats, format_widgets, _ = _available_formats()
        default_format = "video/h264-mp4" if "video/h264-mp4" in formats else formats[0]
        images_input = io.MultiType.Input(
            "images",
            [io.Image, io.Latent],
            optional=True,
            tooltip="Images or latents to save as a video. Connect a VAE when passing latents.",
        )

        return io.Schema(
            node_id="HeltoSaveVideoAdvanced",
            display_name="Helto Save Video Advanced",
            category="HELTO/Video",
            description="Saves images or latents as video with advanced folder routing and VideoHelperSuite-style format controls.",
            inputs=[
                images_input,
                io.Audio.Input("audio", optional=True),
                io.Vae.Input("vae", optional=True),
                io.Float.Input("frame_rate", default=24.0, min=0.01, max=1000.0, step=0.01),
                io.Int.Input("loop_count", default=0, min=0, max=100, step=1),
                io.String.Input(
                    "folder",
                    default=folder_paths.get_output_directory(),
                ),
                io.String.Input("alternative_folder", default=""),
                io.Boolean.Input("use_alternative_folder", default=False),
                io.Boolean.Input("use_date_folder", default=False),
                io.String.Input("subfolder", default=""),
                io.String.Input("filename_prefix", default="video"),
                io.Combo.Input(
                    "format",
                    options=formats,
                    default=default_format,
                    extra_dict={"formats": format_widgets},
                ),
                io.Boolean.Input("pingpong", default=False),
                io.Boolean.Input("save_output", default=True),
                io.Boolean.Input("pause_mode", display_name="pause mode", default=False),
                io.Boolean.Input("privacy_mode", default=True),
            ],
            outputs=[
                io.Image.Output("images"),
                io.Audio.Output("audio"),
                io.Custom("VHS_FILENAMES").Output("filenames"),
            ],
            hidden=[
                io.Hidden.unique_id,
            ],
            is_output_node=True,
            not_idempotent=True,
            accept_all_inputs=True,
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs) -> float:
        return float("NaN")

    @classmethod
    def execute(
        cls,
        images=None,
        audio=None,
        vae=None,
        frame_rate: float = 24.0,
        loop_count: int = 0,
        folder: str = "",
        alternative_folder: str = "",
        use_alternative_folder: bool = False,
        use_date_folder: bool = False,
        subfolder: str = "",
        filename_prefix: str = "video",
        format: str = "video/h264-mp4",
        pingpong: bool = False,
        save_output: bool = True,
        pause_mode: bool = False,
        privacy_mode: bool = True,
        **kwargs,
    ) -> io.NodeOutput:
        node_id = cls._node_id()
        cached_preview = cls.state["previews"].get(node_id)
        release = cls._consume_release(node_id)

        if release is not None:
            stored = cls._load_replay_bundle(node_id)
            if stored is not None:
                cls.state["media"][node_id]["paused"] = False
                control = cls._pause_control_payload(node_id, mode="released", released=True)
                return io.NodeOutput(
                    stored["images"],
                    stored["audio"],
                    stored["filenames"],
                    ui=cls._with_pause_control(cached_preview, control),
                )

        if images is None:
            return io.NodeOutput(
                None,
                audio,
                (save_output, []),
                ui=cls._with_pause_control(
                    cached_preview,
                    cls._pause_control_payload(node_id, mode="empty"),
                ),
            )

        helto_progress.start("Preparing video frames", phase="prepare", percent=0, node_id=node_id)
        try:
            decoded_images = cls._prepare_images(images, vae)
            frames = [frame for frame in decoded_images]
        except Exception as exc:
            helto_progress.error(str(exc), phase="error", node_id=node_id)
            raise
        if len(frames) == 0:
            helto_progress.done("No video frames to save", phase="complete", percent=100, node_id=node_id)
            return io.NodeOutput(
                decoded_images,
                audio,
                (save_output, []),
                ui=cls._with_pause_control(
                    cached_preview,
                    cls._pause_control_payload(node_id, mode="empty"),
                ),
            )
        if pingpong:
            frames = _to_pingpong(frames)
            helto_progress.update(f"Prepared {len(frames)} ping-pong frames", phase="prepare", percent=20, node_id=node_id)
        else:
            helto_progress.update(f"Prepared {len(frames)} frames", phase="prepare", percent=20, node_id=node_id)

        staging_dir = None
        save_dir = (
            cls._resolve_save_dir(
                folder=folder,
                alternative_folder=alternative_folder,
                use_alternative_folder=use_alternative_folder,
                use_date_folder=use_date_folder,
                subfolder=subfolder,
            )
            if save_output
            else folder_paths.get_temp_directory()
        )
        if privacy_mode and not save_output:
            staging_dir = tempfile.mkdtemp(
                prefix="helto_save_video_private_",
                dir=folder_paths.get_temp_directory(),
            )
            save_dir = staging_dir

        filename_prefix = cls._normalize_filename_prefix(filename_prefix)
        os.makedirs(save_dir, exist_ok=True)
        counter = cls._next_counter(save_dir, filename_prefix)

        try:
            helto_progress.update("Saving video output", phase="save_video", percent=30, node_id=node_id)
            output_files = cls._save_video(
                frames=frames,
                audio=audio,
                save_dir=save_dir,
                filename_prefix=filename_prefix,
                counter=counter,
                frame_rate=float(frame_rate),
                loop_count=int(loop_count),
                format=format,
                save_output=save_output,
                format_kwargs=kwargs,
            )
            final_path = output_files[-1]
            helto_progress.update("Creating video preview", phase="preview", percent=75, node_id=node_id)
            if privacy_mode:
                preview = ui.PreviewVideo([cls._private_preview_record(final_path)])
            else:
                preview = ui.PreviewVideo([cls._preview_result(final_path)])

            returned_files = output_files if save_output or not privacy_mode else []
            filenames = (save_output, returned_files)
            helto_progress.update("Storing replay bundle", phase="store", percent=88, node_id=node_id)
            revision = cls._store_replay_bundle(
                node_id,
                images=decoded_images,
                audio=audio,
                filenames=filenames,
                paused=bool(pause_mode),
                privacy_mode=bool(privacy_mode),
            )
            control = cls._pause_control_payload(
                node_id,
                mode="paused" if pause_mode else "ready",
                paused=bool(pause_mode),
                revision=revision,
            )
            preview = cls._with_pause_control(preview, control)
            cls.state["previews"][node_id] = preview
            helto_progress.done("Video output ready", phase="complete", percent=100, node_id=node_id)

            if save_output:
                print(f"Save Video Advanced saved {len(output_files)} file(s) to: {save_dir}")
            elif privacy_mode:
                print("Save Video Advanced created an encrypted private preview without saving output files.")
            else:
                print(f"Save Video Advanced saved {len(output_files)} temp file(s) to: {save_dir}")

            if pause_mode:
                blocker = ExecutionBlocker(None)
                return io.NodeOutput(blocker, blocker, blocker, ui=preview)

            return io.NodeOutput(decoded_images, audio, filenames, ui=preview)
        except Exception as exc:
            helto_progress.error(str(exc), phase="error", node_id=node_id)
            raise
        finally:
            if staging_dir is not None:
                shutil.rmtree(staging_dir, ignore_errors=True)

    @classmethod
    def _store_replay_bundle(
        cls,
        node_id: str,
        *,
        images,
        audio,
        filenames,
        paused: bool,
        privacy_mode: bool,
    ) -> int:
        previous = cls.state["media"].get(node_id)
        if previous is not None:
            cls._delete_replay_bundle(previous)

        existing_revision = int(previous.get("revision", 0)) if previous else 0
        revision = existing_revision + 1
        encrypted = bool(privacy_mode)
        path = cls._write_replay_bundle(
            {
                "images": cls._to_cpu_value(images),
                "audio": cls._to_cpu_value(audio),
                "filenames": filenames,
            },
            encrypted=encrypted,
        )
        cls.state["media"][node_id] = {
            "path": str(path),
            "encrypted": encrypted,
            "revision": revision,
            "paused": paused,
        }
        return revision

    @staticmethod
    def _to_cpu_value(value):
        if isinstance(value, torch.Tensor):
            return value.detach().cpu()
        if isinstance(value, dict):
            return {key: SaveVideoAdvanced._to_cpu_value(item) for key, item in value.items()}
        if isinstance(value, Mapping):
            return {key: SaveVideoAdvanced._to_cpu_value(value[key]) for key in value}
        if isinstance(value, list):
            return [SaveVideoAdvanced._to_cpu_value(item) for item in value]
        if isinstance(value, tuple):
            return tuple(SaveVideoAdvanced._to_cpu_value(item) for item in value)
        return value

    @classmethod
    def _write_replay_bundle(cls, payload: dict[str, Any], *, encrypted: bool) -> Path:
        buffer = BytesIO()
        torch.save(payload, buffer)
        if encrypted:
            output_path = private_temp_cache_dir("HeltoSaveVideoAdvanced", "replay") / f"{uuid.uuid4().hex}.pt.enc"
            output_path.write_bytes(encrypt_bytes(buffer.getvalue()))
            return output_path

        output_dir = public_temp_cache_dir("HeltoSaveVideoAdvanced", "replay")
        output_path = output_dir / f"{uuid.uuid4().hex}.pt"
        output_path.write_bytes(buffer.getvalue())
        return output_path

    @classmethod
    def _load_replay_bundle(cls, node_id: str) -> dict[str, Any] | None:
        stored = cls.state["media"].get(node_id)
        if stored is None:
            return None

        path = Path(stored.get("path", ""))
        if not path.is_file():
            return None

        try:
            data = path.read_bytes()
            if stored.get("encrypted"):
                data = decrypt_bytes(data)

            buffer = BytesIO(data)
            return torch.load(buffer, map_location="cpu", weights_only=True)
        except Exception:
            cls._delete_replay_bundle(stored)
            cls.state["media"].pop(node_id, None)
            return None

    @staticmethod
    def _delete_replay_bundle(stored: dict[str, Any]) -> None:
        path = Path(stored.get("path", ""))
        try:
            if path.is_file() or path.is_symlink():
                path.unlink()
        except Exception:
            pass

    @classmethod
    def request_release(cls, node_id: str, revision=None) -> dict:
        stored = cls.state["media"].get(node_id)
        if stored is None or not Path(stored.get("path", "")).is_file():
            return {
                "ok": False,
                "error": "No stored video is available for this node.",
                "status": 404,
            }

        current_revision = int(stored.get("revision", 0))
        if revision is not None:
            try:
                requested_revision = int(revision)
            except (TypeError, ValueError):
                requested_revision = None
            if requested_revision != current_revision:
                return {
                    "ok": False,
                    "error": "Stored video revision is no longer current.",
                    "revision": current_revision,
                    "status": 409,
                }

        cls.state["releases"][node_id] = {"revision": current_revision}
        return {
            "ok": True,
            "has_media": True,
            "revision": current_revision,
            "paused": bool(stored.get("paused", False)),
        }

    @classmethod
    def _consume_release(cls, node_id: str) -> dict | None:
        return cls.state["releases"].pop(node_id, None)

    @classmethod
    def _pause_control_payload(
        cls,
        node_id: str,
        mode: str,
        *,
        paused: bool | None = None,
        released: bool = False,
        revision: int | None = None,
    ) -> dict:
        stored = cls.state["media"].get(node_id)
        has_media = bool(stored and Path(stored.get("path", "")).is_file())
        if stored is not None:
            revision = int(stored.get("revision", 0)) if revision is None else revision
            paused = bool(stored.get("paused", False)) if paused is None else paused

        return {
            "has_media": has_media,
            "mode": mode,
            "paused": bool(paused) if paused is not None else False,
            "released": released,
            "revision": revision,
        }

    @staticmethod
    def _preview_as_dict(preview) -> dict:
        if preview is None:
            return {}
        if isinstance(preview, dict):
            return {key: list(value) if isinstance(value, tuple) else value for key, value in preview.items()}
        as_dict = getattr(preview, "as_dict", None)
        if callable(as_dict):
            return as_dict()
        values = getattr(preview, "values", None)
        if values is not None:
            return {"images": values, "animated": (True,)}
        return {}

    @classmethod
    def _with_pause_control(cls, preview, control: dict) -> dict:
        payload = cls._preview_as_dict(preview)
        payload["helto_pause_control"] = [control]
        return payload

    @classmethod
    def _prepare_images(cls, images, vae):
        node_id = cls._node_id()
        if isinstance(images, dict):
            if vae is None:
                raise ValueError("Save Video Advanced requires a VAE when the images input receives latents.")
            samples = images.get("samples")
            if samples is None:
                raise ValueError("Save Video Advanced received a latent dictionary without samples.")
            helto_progress.start("Decoding latent frames", phase="decode", percent=0, node_id=node_id)
            decoded = vae.decode(samples)
            helto_progress.done("Decoded latent frames", phase="decode", percent=100, node_id=node_id)
            return decoded
        helto_progress.update("Using image frames", phase="prepare", percent=10, node_id=node_id)
        return images

    @classmethod
    def _save_video(
        cls,
        frames: list[torch.Tensor],
        audio,
        save_dir: str,
        filename_prefix: str,
        counter: int,
        frame_rate: float,
        loop_count: int,
        format: str,
        save_output: bool,
        format_kwargs: dict[str, Any],
    ) -> list[str]:
        if "/" not in format:
            raise ValueError(f"Save Video Advanced expected a type/name format, got: {format}")

        format_type, format_ext = format.split("/", 1)
        node_id = cls._node_id()
        if format_type == "image":
            helto_progress.update(f"Encoding animated {format_ext.upper()}", phase="encode_animation", percent=0, node_id=node_id)
            output_path = cls._save_animated_image(
                frames,
                save_dir,
                filename_prefix,
                counter,
                frame_rate,
                loop_count,
                format_ext,
                format_kwargs,
            )
            return [output_path]

        if format_type != "video":
            raise ValueError(f"Save Video Advanced does not support format type: {format_type}")

        helto_progress.update(f"Encoding {format_ext} video", phase="encode_video", percent=0, node_id=node_id)
        return cls._save_ffmpeg_video(
            frames,
            audio,
            save_dir,
            filename_prefix,
            counter,
            frame_rate,
            loop_count,
            format_ext,
            save_output,
            format_kwargs,
        )

    @classmethod
    def _save_animated_image(
        cls,
        frames: list[torch.Tensor],
        save_dir: str,
        filename_prefix: str,
        counter: int,
        frame_rate: float,
        loop_count: int,
        format_ext: str,
        format_kwargs: dict[str, Any],
    ) -> str:
        if format_ext not in ("gif", "webp"):
            raise ValueError(f"Save Video Advanced image format is not supported: image/{format_ext}")

        total = len(frames)
        node_id = cls._node_id()
        helto_progress.start(
            f"Converting {format_ext.upper()} frames",
            phase="encode_animation",
            value=0,
            total=total,
            node_id=node_id,
        )
        pil_frames = []
        for index, frame in enumerate(frames, start=1):
            pil_frames.append(Image.fromarray(_tensor_to_bytes(frame[..., :3])))
            helto_progress.update(
                f"Converted frame {index}/{total}",
                phase="encode_animation",
                value=index,
                total=total,
                node_id=node_id,
            )
        output_path = os.path.join(save_dir, f"{filename_prefix}_{counter:05}.{format_ext}")
        kwargs: dict[str, Any] = {
            "save_all": True,
            "append_images": pil_frames[1:],
            "duration": round(1000 / frame_rate),
            "loop": loop_count,
            "compress_level": 4,
        }

        if format_ext == "gif":
            kwargs["disposal"] = 2
        elif format_ext == "webp":
            exif = Image.Exif()
            exif[ExifTags.IFD.Exif] = {36867: date.today().isoformat()}
            kwargs["exif"] = exif
            kwargs["lossless"] = bool(format_kwargs.get("lossless", True))

        metadata = cls._png_metadata()
        if metadata is not None and format_ext == "png":
            kwargs["pnginfo"] = metadata

        helto_progress.update(f"Writing {format_ext.upper()} file", phase="encode_animation", value=total, total=total, node_id=node_id)
        pil_frames[0].save(output_path, format=format_ext.upper(), **kwargs)
        helto_progress.done(f"Encoded {format_ext.upper()} file", phase="encode_animation", value=total, total=total, node_id=node_id)
        return output_path

    @classmethod
    def _save_ffmpeg_video(
        cls,
        frames: list[torch.Tensor],
        audio,
        save_dir: str,
        filename_prefix: str,
        counter: int,
        frame_rate: float,
        loop_count: int,
        format_ext: str,
        save_output: bool,
        format_kwargs: dict[str, Any],
    ) -> list[str]:
        node_id = cls._node_id()
        helto_progress.start("Configuring ffmpeg video", phase="encode_video", percent=0, node_id=node_id)
        ffmpeg = _find_ffmpeg()
        if ffmpeg is None:
            raise ProcessLookupError(
                "ffmpeg is required for Save Video Advanced video outputs. Install imageio-ffmpeg or make ffmpeg available on PATH."
            )

        first_frame = frames[0]
        has_alpha = first_frame.shape[-1] == 4
        params = dict(format_kwargs)
        params["has_alpha"] = has_alpha
        video_format = _apply_format_widgets(format_ext, params)
        dim_alignment = int(video_format.get("dim_alignment", 2))
        frames, dimensions = cls._pad_frames(frames, dim_alignment)

        frame_total = len(frames)
        helto_progress.start("Converting video frames", phase="convert_frames", value=0, total=frame_total, node_id=node_id)
        frame_arrays = []
        if video_format.get("input_color_depth", "8bit") == "16bit":
            for index, frame in enumerate(frames, start=1):
                frame_arrays.append(_tensor_to_shorts(frame[..., : 4 if has_alpha else 3]))
                helto_progress.update(
                    f"Converted frame {index}/{frame_total}",
                    phase="convert_frames",
                    value=index,
                    total=frame_total,
                    node_id=node_id,
                )
            input_pix_fmt = "rgba64" if has_alpha else "rgb48"
        else:
            for index, frame in enumerate(frames, start=1):
                frame_arrays.append(_tensor_to_bytes(frame[..., : 4 if has_alpha else 3]))
                helto_progress.update(
                    f"Converted frame {index}/{frame_total}",
                    phase="convert_frames",
                    value=index,
                    total=frame_total,
                    node_id=node_id,
                )
            input_pix_fmt = "rgba" if has_alpha else "rgb24"
        helto_progress.done("Converted video frames", phase="convert_frames", value=frame_total, total=frame_total, node_id=node_id)

        extension = video_format["extension"]
        video_path = os.path.join(save_dir, f"{filename_prefix}_{counter:05}.{extension}")
        command = [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            input_pix_fmt,
            "-color_range",
            "pc",
            "-colorspace",
            "rgb",
            "-color_primaries",
            "bt709",
            "-color_trc",
            video_format.get("fake_trc", "iec61966-2-1"),
            "-s",
            f"{dimensions[0]}x{dimensions[1]}",
            "-r",
            str(frame_rate),
            "-i",
            "-",
        ]

        metadata_path = cls._write_ffmpeg_metadata_file(video_format, save_dir)
        if metadata_path is not None:
            command += ["-f", "ffmetadata", "-i", metadata_path, "-map_metadata", "1"]

        if loop_count > 0:
            command += ["-vf", f"loop=loop={loop_count}:size={len(frames)}"]

        command += video_format.get("inputs_main_pass", [])
        command += video_format.get("main_pass", [])

        bitrate = video_format.get("bitrate")
        if bitrate is not None:
            suffix = "M" if str(video_format.get("megabit")) == "True" else "K"
            command += ["-b:v", f"{bitrate}{suffix}"]

        if metadata_path is not None:
            command += ["-movflags", "use_metadata_tags"]
        _merge_filter_args(command)
        command.append(video_path)

        env = os.environ.copy()
        env.update(video_format.get("environment", {}))
        pbar = ProgressBar(len(frame_arrays))
        frame_total = len(frame_arrays)
        helto_progress.start("Writing frames to ffmpeg", phase="write_frames", value=0, total=frame_total, node_id=node_id)
        try:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            assert process.stdin is not None
            assert process.stderr is not None
            try:
                for index, frame_array in enumerate(frame_arrays, start=1):
                    process.stdin.write(frame_array.tobytes())
                    pbar.update(1)
                    helto_progress.update(
                        f"Writing frame {index}/{frame_total}",
                        phase="write_frames",
                        value=index,
                        total=frame_total,
                        node_id=node_id,
                    )
                process.stdin.close()
                stderr = process.stderr.read()
                return_code = process.wait()
            except BrokenPipeError:
                stderr = process.stderr.read()
                return_code = process.wait()
        finally:
            if metadata_path is not None:
                try:
                    os.unlink(metadata_path)
                except FileNotFoundError:
                    pass

        if return_code != 0:
            raise RuntimeError("Save Video Advanced ffmpeg failed:\n" + stderr.decode("utf-8", "replace"))
        helto_progress.done("Wrote frames to ffmpeg", phase="write_frames", value=frame_total, total=frame_total, node_id=node_id)
        if stderr:
            print(stderr.decode("utf-8", "replace"), end="")

        helto_progress.update("Finalizing video file", phase="encode_video", percent=95, node_id=node_id)
        cls._replace_with_audio_mux_if_needed(
            audio=audio,
            video_path=video_path,
            save_dir=save_dir,
            filename_prefix=filename_prefix,
            counter=counter,
            extension=extension,
            frame_rate=frame_rate,
            frame_count=len(frames),
            video_format=video_format,
            env=env,
        )

        helto_progress.done("Encoded video file", phase="encode_video", percent=100, node_id=node_id)
        return [video_path]

    @classmethod
    def _pad_frames(cls, frames: list[torch.Tensor], dim_alignment: int) -> tuple[list[torch.Tensor], tuple[int, int]]:
        first = frames[0]
        width = first.shape[1]
        height = first.shape[0]
        pad_width = -width % dim_alignment
        pad_height = -height % dim_alignment
        if pad_width == 0 and pad_height == 0:
            return frames, (width, height)

        padding = (
            pad_width // 2,
            pad_width - pad_width // 2,
            pad_height // 2,
            pad_height - pad_height // 2,
        )
        padder = torch.nn.ReplicationPad2d(padding)
        padded = []
        for frame in frames:
            chw = frame.permute((2, 0, 1)).to(dtype=torch.float32)
            padded.append(padder(chw).permute((1, 2, 0)))
        return padded, (width + pad_width, height + pad_height)

    @classmethod
    def _replace_with_audio_mux_if_needed(
        cls,
        audio,
        video_path: str,
        save_dir: str,
        filename_prefix: str,
        counter: int,
        extension: str,
        frame_rate: float,
        frame_count: int,
        video_format: dict[str, Any],
        env: dict[str, str],
    ) -> None:
        node_id = cls._node_id()
        if audio is None or "waveform" not in audio:
            return

        ffmpeg = _find_ffmpeg()
        if ffmpeg is None:
            return

        helto_progress.start("Muxing audio", phase="mux_audio", percent=0, node_id=node_id)
        waveform = audio["waveform"]
        if waveform.ndim == 3:
            waveform = waveform[0]
        channels = waveform.shape[0]
        sample_rate = audio["sample_rate"]
        audio_data = waveform.transpose(0, 1).contiguous().cpu().numpy().astype(np.float32).tobytes()
        output_path = os.path.join(save_dir, f"{filename_prefix}_{counter:05}.audio_mux.{uuid.uuid4().hex}.{extension}")
        audio_pass = video_format.get("audio_pass", ["-c:a", "libopus"])
        apad = []
        if str(video_format.get("trim_to_audio", "False")) == "False":
            apad = ["-af", f"apad=whole_dur={frame_count / frame_rate + 1}"]

        command = [
            ffmpeg,
            "-v",
            "error",
            "-n",
            "-i",
            video_path,
            "-ar",
            str(sample_rate),
            "-ac",
            str(channels),
            "-f",
            "f32le",
            "-i",
            "-",
            "-c:v",
            "copy",
        ] + audio_pass + apad + ["-shortest", output_path]
        _merge_filter_args(command, "-af")

        result = subprocess.run(command, input=audio_data, env=env, capture_output=True, check=False)
        try:
            if result.returncode != 0:
                raise RuntimeError("Save Video Advanced audio mux failed:\n" + result.stderr.decode("utf-8", "replace"))
            if result.stderr:
                print(result.stderr.decode("utf-8", "replace"), end="")
            os.replace(output_path, video_path)
            helto_progress.done("Muxed audio", phase="mux_audio", percent=100, node_id=node_id)
        finally:
            try:
                os.unlink(output_path)
            except FileNotFoundError:
                pass

    @classmethod
    def _ffmpeg_metadata(cls, video_format: dict[str, Any]) -> dict[str, str]:
        if comfy_args.disable_metadata or str(video_format.get("save_metadata", "False")) == "False":
            return {}

        metadata: dict[str, str] = {}
        hidden = getattr(cls, "hidden", None)
        if hidden is not None:
            if hidden.prompt is not None:
                metadata["prompt"] = json.dumps(hidden.prompt)
            if hidden.extra_pnginfo is not None:
                for key, value in hidden.extra_pnginfo.items():
                    metadata[key] = json.dumps(value)
        return metadata

    @staticmethod
    def _ffmetadata_escape(value: str) -> str:
        return re.sub(r"([=;#\\])", r"\\\1", value).replace("\n", r"\n")

    @classmethod
    def _write_ffmpeg_metadata_file(cls, video_format: dict[str, Any], save_dir: str) -> str | None:
        metadata = cls._ffmpeg_metadata(video_format)
        if not metadata:
            return None

        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            prefix="helto_save_video_metadata_",
            suffix=".ffmetadata",
            dir=save_dir,
            delete=False,
        ) as stream:
            stream.write(";FFMETADATA1\n")
            for key, value in metadata.items():
                stream.write(f"{cls._ffmetadata_escape(str(key))}={cls._ffmetadata_escape(value)}\n")
            return stream.name

    @classmethod
    def _png_metadata(cls) -> PngInfo | None:
        if comfy_args.disable_metadata:
            return None
        return ui.ImageSaveHelper._create_png_metadata(cls)

    @classmethod
    def _preview_result(cls, path: str) -> ui.SavedResult:
        path = os.path.abspath(path)
        for folder_type, base_dir in (
            (io.FolderType.output, folder_paths.get_output_directory()),
            (io.FolderType.temp, folder_paths.get_temp_directory()),
        ):
            base_dir = os.path.abspath(base_dir)
            if os.path.commonpath((base_dir, path)) == base_dir:
                rel_path = os.path.relpath(path, base_dir)
                return ui.SavedResult(os.path.basename(rel_path), os.path.dirname(rel_path), folder_type)

        preview_dir = os.path.join(folder_paths.get_temp_directory(), "helto_save_video_advanced")
        os.makedirs(preview_dir, exist_ok=True)
        preview_name = os.path.basename(path)
        preview_path = os.path.join(preview_dir, preview_name)
        if os.path.abspath(preview_path) != path:
            if os.path.exists(preview_path):
                stem = Path(preview_name).stem
                suffix = Path(preview_name).suffix
                preview_path = os.path.join(preview_dir, f"{stem}_{uuid.uuid4().hex}{suffix}")
            shutil.copy2(path, preview_path)
        return ui.SavedResult(os.path.basename(preview_path), "helto_save_video_advanced", io.FolderType.temp)

    @classmethod
    def _private_preview_record(cls, path: str) -> dict[str, Any]:
        encrypted_path = write_encrypted_temp_file(path, "save_video_advanced")
        preview_filename = f"video_{_safe_node_id(cls._node_id())}_{uuid.uuid4().hex}{Path(path).suffix or '.bin'}"
        return private_media_record(
            encrypted_path,
            content_type=content_type_for_path(path),
            encrypted=True,
            filename=preview_filename,
        )

    @classmethod
    def _node_id(cls) -> str:
        hidden = getattr(cls, "hidden", None)
        unique_id = getattr(hidden, "unique_id", None)
        return str(unique_id) if unique_id is not None else "__default__"

    @classmethod
    def _resolve_save_dir(
        cls,
        folder: str,
        alternative_folder: str,
        use_alternative_folder: bool,
        use_date_folder: bool,
        subfolder: str,
    ) -> str:
        selected_folder = alternative_folder if use_alternative_folder else folder
        base_folder = (selected_folder or "").strip()

        if base_folder and not os.path.isabs(base_folder):
            raise ValueError("Save Video Advanced requires an absolute base folder path.")

        save_dir = os.path.abspath(base_folder or folder_paths.get_output_directory())

        if use_date_folder:
            save_dir = os.path.join(save_dir, date.today().strftime("%Y-%m-%d"))

        clean_subfolder = (subfolder or "").strip()
        if clean_subfolder:
            if os.path.isabs(clean_subfolder):
                raise ValueError("Save Video Advanced subfolder must be relative.")
            if os.pardir in clean_subfolder.replace("\\", os.sep).split(os.sep):
                raise ValueError("Save Video Advanced subfolder cannot contain path traversal.")

            save_dir = os.path.join(save_dir, os.path.normpath(clean_subfolder))

        return save_dir

    @staticmethod
    def _normalize_filename_prefix(filename_prefix: str) -> str:
        prefix = (filename_prefix or "").strip() or "video"
        prefix = os.path.basename(os.path.normpath(prefix))
        return prefix if prefix not in ("", ".", os.pardir) else "video"

    @staticmethod
    def _next_counter(save_dir: str, filename_prefix: str) -> int:
        counter_re = re.compile(
            _COUNTER_RE_TEMPLATE.format(prefix=re.escape(filename_prefix)),
            re.IGNORECASE,
        )
        counters = []
        for filename in os.listdir(save_dir):
            match = counter_re.match(filename)
            if match:
                counters.append(int(match.group("counter")))
        return max(counters, default=0) + 1


@server.PromptServer.instance.routes.post("/helto_save_video_advanced/release")
async def release_save_video_advanced(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id", ""))
        result = SaveVideoAdvanced.request_release(node_id, data.get("revision"))
        status = int(result.pop("status", 200))
        return web.json_response(result, status=status)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)

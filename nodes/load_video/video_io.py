from __future__ import annotations

import os
import hashlib
import shutil
import uuid
from fractions import Fraction
from pathlib import Path
from typing import Any

import folder_paths

try:
    from comfy_api.latest import io, ui
except ImportError:
    io = None
    ui = None

try:
    from .video_config import THUMB_CACHE_DIR, VIDEO_EXTENSIONS
except ImportError:
    from video_config import THUMB_CACHE_DIR, VIDEO_EXTENSIONS


def _fraction_to_float(value: Any) -> float:
    try:
        if isinstance(value, Fraction):
            return float(value)
        return float(Fraction(value))
    except Exception:
        return 0.0


def video_metadata(path: Path) -> dict[str, Any]:
    width = height = 0
    duration = 0.0
    fps = 0.0

    try:
        import av

        with av.open(str(path), mode="r") as container:
            video_stream = next((stream for stream in container.streams if stream.type == "video"), None)
            if video_stream is not None:
                width = int(video_stream.codec_context.width or video_stream.width or 0)
                height = int(video_stream.codec_context.height or video_stream.height or 0)
                fps = _fraction_to_float(video_stream.average_rate)
                if getattr(video_stream, "duration", None) is not None and getattr(video_stream, "time_base", None):
                    duration = float(video_stream.duration * video_stream.time_base)
            if duration <= 0 and container.duration is not None:
                duration = float(container.duration / av.time_base)
    except Exception:
        pass

    return {
        "width": width,
        "height": height,
        "duration": duration,
        "fps": fps,
    }


def thumbnail_path(video_path: Path, max_size: int = 360) -> Path:
    video_path = Path(video_path)
    stat = video_path.stat()
    key = hashlib.sha256(f"{video_path.resolve()}:{stat.st_mtime_ns}:{stat.st_size}:{max_size}".encode("utf-8")).hexdigest()
    return THUMB_CACHE_DIR / f"{key}.webp"


def make_thumbnail(video_path: Path, max_size: int = 360) -> Path:
    video_path = Path(video_path)
    THUMB_CACHE_DIR.mkdir(exist_ok=True)
    output_path = thumbnail_path(video_path, max_size=max_size)
    if output_path.exists():
        return output_path

    import av
    from PIL import Image

    with av.open(str(video_path), mode="r") as container:
        video_stream = next((stream for stream in container.streams if stream.type == "video"), None)
        if video_stream is None:
            raise ValueError(f"No video stream found in {video_path}")

        for frame in container.decode(video_stream):
            image = Image.fromarray(frame.to_ndarray(format="rgb24"))
            rotation = getattr(frame, "rotation", 0) or 0
            if rotation != 0:
                image = image.rotate(-rotation, expand=True)
            image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
            output_path.parent.mkdir(exist_ok=True)
            image.save(output_path, "WEBP", quality=86, method=4)
            return output_path

    raise ValueError(f"No decodable video frame found in {video_path}")


def preview_result(video_path: Path, subfolder: str = "helto_load_video") -> ui.SavedResult:
    if io is None or ui is None:
        raise RuntimeError("ComfyUI API is required to create video preview results.")

    video_path = Path(video_path).resolve()
    for folder_type, base_dir in (
        (io.FolderType.output, folder_paths.get_output_directory()),
        (io.FolderType.temp, folder_paths.get_temp_directory()),
    ):
        base_path = Path(base_dir).resolve()
        try:
            if os.path.commonpath((str(base_path), str(video_path))) == str(base_path):
                rel_path = os.path.relpath(video_path, base_path)
                return ui.SavedResult(os.path.basename(rel_path), os.path.dirname(rel_path), folder_type)
        except ValueError:
            continue

    preview_dir = Path(folder_paths.get_temp_directory()) / subfolder
    preview_dir.mkdir(parents=True, exist_ok=True)
    preview_path = preview_dir / video_path.name
    if preview_path.resolve() != video_path:
        if preview_path.exists():
            preview_path = preview_dir / f"{video_path.stem}_{uuid.uuid4().hex}{video_path.suffix}"
        shutil.copy2(video_path, preview_path)
    return ui.SavedResult(preview_path.name, subfolder, io.FolderType.temp)


def list_videos(root: str | Path, recursive: bool = True) -> list[dict[str, Any]]:
    root = Path(root)
    results: list[dict[str, Any]] = []
    if not root.is_dir():
        return results

    if recursive:
        walker = os.walk(root)
    else:
        walker = [(root, [], [path.name for path in root.iterdir() if path.is_file()])]

    for dirpath, _, filenames in walker:
        for filename in filenames:
            path = Path(dirpath) / filename
            if path.suffix.lower() not in VIDEO_EXTENSIONS:
                continue

            rel = path.relative_to(root).as_posix()
            meta = video_metadata(path)
            stat = path.stat() if path.exists() else None
            results.append(
                {
                    "filename": rel,
                    "width": meta["width"],
                    "height": meta["height"],
                    "duration": meta["duration"],
                    "fps": meta["fps"],
                    "mtime": stat.st_mtime if stat else 0,
                    "size": stat.st_size if stat else 0,
                }
            )

    return sorted(results, key=lambda item: item["filename"].lower())

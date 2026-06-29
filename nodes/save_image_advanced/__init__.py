from __future__ import annotations

import os
import re
from io import BytesIO
from datetime import date

from aiohttp import web
import folder_paths
import server
from comfy_api.latest import io, ui
from comfy_execution.graph import ExecutionBlocker

from ...shared import progress_api as helto_progress
from ...shared.privacy import private_media_record, write_encrypted_temp_bytes


_COUNTER_RE_TEMPLATE = r"^{prefix}_(?P<counter>\d+)_?\.png$"


def _item_count(value) -> int | None:
    try:
        return len(value)
    except Exception:
        return None


class SaveImageAdvanced(io.ComfyNode):
    state = {
        "previews": {},
        "media": {},
        "releases": {},
    }

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoSaveImageAdvanced",
            display_name="Helto Save Image Advanced",
            category="HELTO/Image",
            description="Saves images to an absolute folder with optional alternate, date, and subfolder routing.",
            inputs=[
                io.Image.Input("images", optional=True),
                io.String.Input(
                    "folder",
                    default=folder_paths.get_output_directory(),
                ),
                io.String.Input("alternative_folder", default=""),
                io.Boolean.Input("use_alternative_folder", default=False),
                io.Boolean.Input("use_date_folder", default=False),
                io.String.Input("subfolder", default=""),
                io.String.Input("filename_prefix", default="img"),
                io.Boolean.Input("pause_mode", display_name="pause mode", default=False),
                io.Boolean.Input("privacy_mode", default=True),
                io.Boolean.Input("save_image", display_name="save image", default=True),
            ],
            outputs=[
                io.Image.Output("images"),
            ],
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
    def execute(
        cls,
        images=None,
        folder: str = "",
        alternative_folder: str = "",
        use_alternative_folder: bool = False,
        use_date_folder: bool = False,
        subfolder: str = "",
        filename_prefix: str = "img",
        pause_mode: bool = False,
        privacy_mode: bool = True,
        save_image: bool = True,
    ) -> io.NodeOutput:
        node_id = cls._node_id()
        cached_preview = cls.state["previews"].get(node_id)
        release = cls._consume_release(node_id)

        if release is not None:
            stored = cls.state["media"].get(node_id)
            if stored is not None:
                stored["paused"] = False
                control = cls._pause_control_payload(node_id, mode="released", released=True)
                return io.NodeOutput(
                    stored["images"],
                    ui=cls._with_pause_control(cached_preview, control),
                )

        if images is None:
            return io.NodeOutput(
                None,
                ui=cls._with_pause_control(
                    cached_preview,
                    cls._pause_control_payload(node_id, mode="empty"),
                ),
            )

        helto_progress.start(
            "Preparing image output",
            phase="prepare",
            percent=0,
            node_id=node_id,
            native_text=False,
        )
        try:
            filename_prefix = cls._normalize_filename_prefix(filename_prefix)

            if save_image:
                save_dir = cls._resolve_save_dir(
                    folder=folder,
                    alternative_folder=alternative_folder,
                    use_alternative_folder=use_alternative_folder,
                    use_date_folder=use_date_folder,
                    subfolder=subfolder,
                )
                saved_paths = cls._save_images(images, save_dir, filename_prefix)
                print(f"Save Image Advanced saved {len(saved_paths)} image(s) to: {save_dir}")
            else:
                helto_progress.update(
                    "Preparing preview only",
                    phase="preview",
                    percent=35,
                    node_id=node_id,
                    native_text=False,
                )
                print("Save Image Advanced created a preview without saving output files.")

            if privacy_mode:
                preview = {
                    "helto_private_images": cls._private_preview_records(images, filename_prefix),
                    "images": [],
                }
            else:
                helto_progress.update(
                    "Creating temp preview",
                    phase="preview",
                    percent=70,
                    node_id=node_id,
                    native_text=False,
                )
                preview = ui.SavedImages(
                    ui.ImageSaveHelper.save_images(
                        images,
                        filename_prefix=filename_prefix,
                        folder_type=io.FolderType.temp,
                        cls=cls,
                        compress_level=4,
                    )
                )
            revision = cls._store_media(node_id, images, paused=bool(pause_mode))
            control = cls._pause_control_payload(
                node_id,
                mode="paused" if pause_mode else "ready",
                paused=bool(pause_mode),
                revision=revision,
            )
            preview = cls._with_pause_control(preview, control)
            cls.state["previews"][node_id] = preview
            helto_progress.done(
                "Image output ready",
                phase="complete",
                percent=100,
                node_id=node_id,
                native_text=False,
            )

            if pause_mode:
                return io.NodeOutput(ExecutionBlocker(None), ui=preview)

            return io.NodeOutput(images, ui=preview)
        except Exception as exc:
            helto_progress.error(str(exc), phase="error", node_id=node_id, native_text=False)
            raise

    @classmethod
    def _node_id(cls) -> str:
        hidden = getattr(cls, "hidden", None)
        unique_id = getattr(hidden, "unique_id", None)
        return str(unique_id) if unique_id is not None else "__default__"

    @classmethod
    def _store_media(cls, node_id: str, images, paused: bool) -> int:
        existing = cls.state["media"].get(node_id) or {}
        revision = int(existing.get("revision", 0)) + 1
        cls.state["media"][node_id] = {
            "images": images,
            "revision": revision,
            "paused": paused,
        }
        return revision

    @classmethod
    def request_release(cls, node_id: str, revision=None) -> dict:
        stored = cls.state["media"].get(node_id)
        if stored is None:
            return {
                "ok": False,
                "error": "No stored image is available for this node.",
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
                    "error": "Stored image revision is no longer current.",
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
        if stored is not None:
            revision = int(stored.get("revision", 0)) if revision is None else revision
            paused = bool(stored.get("paused", False)) if paused is None else paused

        return {
            "has_media": stored is not None,
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
        return {}

    @classmethod
    def _with_pause_control(cls, preview, control: dict) -> dict:
        payload = cls._preview_as_dict(preview)
        payload["helto_pause_control"] = [control]
        return payload

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
            raise ValueError("Save Image Advanced requires an absolute base folder path.")

        save_dir = os.path.abspath(base_folder or folder_paths.get_output_directory())

        if use_date_folder:
            save_dir = os.path.join(save_dir, date.today().strftime("%Y-%m-%d"))

        clean_subfolder = (subfolder or "").strip()
        if clean_subfolder:
            if os.path.isabs(clean_subfolder):
                raise ValueError("Save Image Advanced subfolder must be relative.")
            if os.pardir in clean_subfolder.replace("\\", os.sep).split(os.sep):
                raise ValueError("Save Image Advanced subfolder cannot contain path traversal.")

            normalized_subfolder = os.path.normpath(clean_subfolder)

            save_dir = os.path.join(save_dir, normalized_subfolder)

        return save_dir

    @staticmethod
    def _normalize_filename_prefix(filename_prefix: str) -> str:
        prefix = (filename_prefix or "").strip() or "img"
        prefix = os.path.basename(os.path.normpath(prefix))
        return prefix if prefix not in ("", ".", os.pardir) else "img"

    @classmethod
    def _save_images(cls, images, save_dir: str, filename_prefix: str) -> list[str]:
        os.makedirs(save_dir, exist_ok=True)
        counter = cls._next_counter(save_dir, filename_prefix)
        metadata = ui.ImageSaveHelper._create_png_metadata(cls)
        saved_paths = []
        total = _item_count(images)
        node_id = cls._node_id()
        helto_progress.start(
            "Saving image files",
            phase="save_images",
            value=0,
            total=total,
            node_id=node_id,
            native_text=False,
        )

        for index, image in enumerate(images, start=1):
            image_file = f"{filename_prefix}_{counter:05}.png"
            image_path = os.path.join(save_dir, image_file)
            pil_image = ui.ImageSaveHelper._convert_tensor_to_pil(image)
            pil_image.save(image_path, pnginfo=metadata, compress_level=4)
            saved_paths.append(image_path)
            counter += 1
            helto_progress.update(
                f"Saved image {index}/{total or index}",
                phase="save_images",
                value=index,
                total=total,
                node_id=node_id,
                native_text=False,
            )

        helto_progress.done(
            "Saved image files",
            phase="save_images",
            value=total if total is not None else len(saved_paths),
            total=total,
            node_id=node_id,
            native_text=False,
        )
        return saved_paths

    @classmethod
    def _private_preview_records(cls, images, filename_prefix: str) -> list[dict]:
        records = []
        metadata = ui.ImageSaveHelper._create_png_metadata(cls)
        total = _item_count(images)
        node_id = cls._node_id()
        helto_progress.start(
            "Creating private image previews",
            phase="private_preview",
            value=0,
            total=total,
            node_id=node_id,
            native_text=False,
        )
        for index, image in enumerate(images):
            pil_image = ui.ImageSaveHelper._convert_tensor_to_pil(image)
            buffer = BytesIO()
            pil_image.save(buffer, format="PNG", pnginfo=metadata, compress_level=4)
            path = write_encrypted_temp_bytes(buffer.getvalue(), ".png", "save_image_advanced")
            records.append(
                private_media_record(
                    path,
                    content_type="image/png",
                    encrypted=True,
                    filename=f"{filename_prefix}_{index + 1:05}.png",
                )
            )
            helto_progress.update(
                f"Encrypted preview {index + 1}/{total or index + 1}",
                phase="private_preview",
                value=index + 1,
                total=total,
                node_id=node_id,
                native_text=False,
            )
        helto_progress.done(
            "Created private image previews",
            phase="private_preview",
            value=total if total is not None else len(records),
            total=total,
            node_id=node_id,
            native_text=False,
        )
        return records

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


@server.PromptServer.instance.routes.post("/helto_save_image_advanced/release")
async def release_save_image_advanced(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id", ""))
        result = SaveImageAdvanced.request_release(node_id, data.get("revision"))
        status = int(result.pop("status", 200))
        return web.json_response(result, status=status)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)

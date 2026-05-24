from __future__ import annotations

import os
import re
from io import BytesIO
from datetime import date

import folder_paths
from comfy_api.latest import io, ui

from ...shared.privacy import private_media_record, write_encrypted_temp_bytes


_COUNTER_RE_TEMPLATE = r"^{prefix}_(?P<counter>\d+)_?\.png$"


class SaveImageAdvanced(io.ComfyNode):
    state = {
        "previews": {},
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
                io.Boolean.Input("privacy_mode", default=True),
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
        privacy_mode: bool = True,
    ) -> io.NodeOutput:
        node_id = cls._node_id()
        cached_preview = cls.state["previews"].get(node_id)

        if images is None:
            return io.NodeOutput(None, ui=cached_preview)

        save_dir = cls._resolve_save_dir(
            folder=folder,
            alternative_folder=alternative_folder,
            use_alternative_folder=use_alternative_folder,
            use_date_folder=use_date_folder,
            subfolder=subfolder,
        )
        filename_prefix = cls._normalize_filename_prefix(filename_prefix)

        saved_paths = cls._save_images(images, save_dir, filename_prefix)
        print(f"Save Image Advanced saved {len(saved_paths)} image(s) to: {save_dir}")
        if privacy_mode:
            preview = {
                "helto_private_images": cls._private_preview_records(images, filename_prefix),
                "images": [],
            }
        else:
            preview = ui.SavedImages(
                ui.ImageSaveHelper.save_images(
                    images,
                    filename_prefix=filename_prefix,
                    folder_type=io.FolderType.temp,
                    cls=cls,
                    compress_level=4,
                )
            )
        cls.state["previews"][node_id] = preview

        return io.NodeOutput(images, ui=preview)

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

        for image in images:
            image_file = f"{filename_prefix}_{counter:05}.png"
            image_path = os.path.join(save_dir, image_file)
            pil_image = ui.ImageSaveHelper._convert_tensor_to_pil(image)
            pil_image.save(image_path, pnginfo=metadata, compress_level=4)
            saved_paths.append(image_path)
            counter += 1

        return saved_paths

    @classmethod
    def _private_preview_records(cls, images, filename_prefix: str) -> list[dict]:
        records = []
        metadata = ui.ImageSaveHelper._create_png_metadata(cls)
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

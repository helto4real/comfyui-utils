from __future__ import annotations

from io import BytesIO

from comfy_api.latest import io, ui

from ...shared.privacy import private_media_record, write_encrypted_temp_bytes


def _private_image_records(images, filename_prefix: str, cls: type[io.ComfyNode]) -> list[dict]:
    records = []
    metadata = ui.ImageSaveHelper._create_png_metadata(cls)
    for index, image in enumerate(images):
        pil_image = ui.ImageSaveHelper._convert_tensor_to_pil(image)
        buffer = BytesIO()
        pil_image.save(buffer, format="PNG", pnginfo=metadata, compress_level=1)
        path = write_encrypted_temp_bytes(buffer.getvalue(), ".png", "image_comparer")
        records.append(
            private_media_record(
                path,
                content_type="image/png",
                encrypted=True,
                filename=f"{filename_prefix}_{index + 1:05}.png",
            )
        )
    return records


class ImageComparer(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoImageComparer",
            display_name="Helto Image Comparer",
            category="HELTO/Image",
            description="Compares an original image against a new image in the node preview.",
            inputs=[
                io.Image.Input("original"),
                io.Image.Input("new"),
                io.Boolean.Input("privacy_mode", default=True),
            ],
            outputs=[],
            hidden=[
                io.Hidden.unique_id,
            ],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, original, new, privacy_mode: bool = True) -> io.NodeOutput:
        result = {
            "a_images": [],
            "b_images": [],
        }

        if privacy_mode:
            if original is not None and len(original) > 0:
                result["a_images"] = _private_image_records(original, "helto.compare.original", cls)
            if new is not None and len(new) > 0:
                result["b_images"] = _private_image_records(new, "helto.compare.new", cls)
            return io.NodeOutput(ui=result)

        if original is not None and len(original) > 0:
            result["a_images"] = ui.ImageSaveHelper.save_images(
                original,
                filename_prefix="helto.compare.original",
                folder_type=io.FolderType.temp,
                cls=cls,
                compress_level=1,
            )

        if new is not None and len(new) > 0:
            result["b_images"] = ui.ImageSaveHelper.save_images(
                new,
                filename_prefix="helto.compare.new",
                folder_type=io.FolderType.temp,
                cls=cls,
                compress_level=1,
            )

        return io.NodeOutput(ui=result)

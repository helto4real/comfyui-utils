from __future__ import annotations

from comfy_api.latest import io, ui


class ImageComparer(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoImageComparer",
            display_name="Image Comparer",
            category="HELTO/Image",
            description="Compares an original image against a new image in the node preview.",
            inputs=[
                io.Image.Input("original"),
                io.Image.Input("new"),
            ],
            outputs=[],
            hidden=[
                io.Hidden.unique_id,
            ],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, original, new) -> io.NodeOutput:
        result = {
            "a_images": [],
            "b_images": [],
        }

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

from __future__ import annotations

from comfy_api.latest import io

from .image_processing import DEFAULT_RESIZE_MODE, select_images


class HeltoImageSelector(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoImageSelector",
            display_name="Multi-Image Selector",
            category="image",
            inputs=[
                io.String.Input(
                    "selected_images",
                    default="[]",
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
                io.String.Input(
                    "resize_mode",
                    default=DEFAULT_RESIZE_MODE,
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
            ],
            outputs=[
                io.Image.Output("images", display_name="images", is_output_list=True),
                io.Image.Output("image_batch", display_name="image_batch"),
            ],
        )

    @classmethod
    def execute(cls, selected_images: str = "[]", resize_mode: str = DEFAULT_RESIZE_MODE) -> io.NodeOutput:
        tensor_list, image_batch = select_images(selected_images, resize_mode)
        return io.NodeOutput(tensor_list, image_batch)


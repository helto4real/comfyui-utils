from __future__ import annotations

from comfy_api.latest import io

from .image_processing import DEFAULT_RESIZE_MODE, select_images


def coerce_batching_mode(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"", "0", "false", "no", "off"}:
            return False
    return bool(value)


class HeltoImageSelector(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoImageSelector",
            display_name="Helto Multi-Image Selector",
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
                io.String.Input(
                    "edited_masks",
                    default="{}",
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
                io.String.Input(
                    "edited_bboxes",
                    default="{}",
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
                io.Boolean.Input(
                    "batching_mode",
                    default=False,
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
            ],
            outputs=[
                io.Image.Output("images", display_name="images", is_output_list=True),
                io.Image.Output("image_batch", display_name="image_batch"),
                io.Mask.Output("masks", display_name="masks", is_output_list=True),
                io.Mask.Output("mask_batch", display_name="mask_batch"),
                io.BoundingBox.Output("bboxes", display_name="bboxes", is_output_list=True),
            ],
        )

    @classmethod
    def execute(
        cls,
        selected_images: str = "[]",
        resize_mode: str = DEFAULT_RESIZE_MODE,
        edited_masks: str = "{}",
        edited_bboxes: str = "{}",
        batching_mode: bool = False,
    ) -> io.NodeOutput:
        tensor_list, image_batch, mask_list, mask_batch, bboxes = select_images(
            selected_images,
            resize_mode,
            edited_masks,
            edited_bboxes,
        )
        if not coerce_batching_mode(batching_mode):
            return io.NodeOutput([image_batch], image_batch, [mask_batch], mask_batch, [bboxes])
        return io.NodeOutput(tensor_list, image_batch, mask_list, mask_batch, bboxes)

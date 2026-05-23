from __future__ import annotations

from comfy_api.latest import io

from ...shared.video_params import ASPECT_RATIOS, ORIENTATIONS, calculate_aspect_dimensions


class AspectRatioCalculator(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AspectRatioCalculator",
            display_name="Aspect Ratio Calculator",
            category="HELTO/Utils",
            description="Calculates width and height from an aspect ratio and side length.",
            inputs=[
                io.Int.Input("side_length", default=512, min=64, max=8192, step=8),
                io.Combo.Input("aspect_ratio", options=ASPECT_RATIOS),
                io.Combo.Input("orientation", options=ORIENTATIONS),
                io.Boolean.Input("use_max_side", default=False),
            ],
            outputs=[
                io.Int.Output("width"),
                io.Int.Output("height"),
            ],
        )

    @classmethod
    def execute(
        cls,
        side_length: int,
        aspect_ratio: str,
        orientation: str,
        use_max_side: bool,
    ) -> io.NodeOutput:
        width, height = calculate_aspect_dimensions(
            side_length,
            aspect_ratio,
            orientation,
            use_max_side,
        )
        return io.NodeOutput(width, height)

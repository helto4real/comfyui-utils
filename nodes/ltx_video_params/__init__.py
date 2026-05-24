from __future__ import annotations

from comfy_api.latest import io

from ...shared.video_params import (
    ASPECT_RATIOS,
    LTX_QUALITY_TIERS,
    LTX_RESOLUTIONS,
    ORIENTATIONS,
    calculate_ltx_frames,
    calculate_video_dimensions,
)


class HeltoVideoParamsLTX(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoVideoParamsLTX",
            display_name="Helto Video Parameters LTX",
            category="HELTO/Video",
            description="Returns LTX 2.3 video dimensions and frame-safe sampler parameters.",
            inputs=[
                io.Float.Input("fps", default=24.0, min=1.0, max=120.0, step=0.01),
                io.Int.Input("duration", default=5, min=1, max=10000, step=1),
                io.Combo.Input("aspect_ratio", options=ASPECT_RATIOS),
                io.Combo.Input(
                    "orientation",
                    options=ORIENTATIONS,
                    default="landscape",
                ),
                io.Combo.Input(
                    "quality_tier",
                    options=LTX_QUALITY_TIERS,
                    default="6 - LTX 2.3 native",
                ),
                io.Boolean.Input("use_nfsw", default=False),
                io.Float.Input(
                    "motion_amplitude",
                    default=1.15,
                    min=1.0,
                    max=1.5,
                    step=0.05,
                ),
                io.Int.Input("steps", default=8, min=1, max=50, step=1),
                io.Float.Input(
                    "shift_value",
                    default=8.0,
                    min=1.0,
                    max=10.0,
                    step=0.5,
                ),
            ],
            outputs=[
                io.Float.Output("fps"),
                io.Int.Output("duration"),
                io.Int.Output("width"),
                io.Int.Output("height"),
                io.Int.Output("nr_frames"),
                io.Int.Output("steps"),
                io.Float.Output("shift_value"),
                io.Float.Output("motion_amplitude"),
                io.Boolean.Output("use_nfsw"),
            ],
        )

    @classmethod
    def execute(
        cls,
        fps: float,
        duration: int,
        aspect_ratio: str,
        orientation: str,
        quality_tier: str,
        steps: int,
        shift_value: float,
        motion_amplitude: float,
        use_nfsw: bool,
    ) -> io.NodeOutput:
        width, height = calculate_video_dimensions(
            LTX_RESOLUTIONS,
            aspect_ratio,
            orientation,
            quality_tier,
        )
        nr_frames = calculate_ltx_frames(fps, duration)

        return io.NodeOutput(
            fps,
            duration,
            width,
            height,
            nr_frames,
            steps,
            shift_value,
            motion_amplitude,
            use_nfsw,
        )

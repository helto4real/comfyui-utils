from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from .nodes.aspect_ratio_calculator import AspectRatioCalculator
from .nodes.ltx_video_params import HeltoVideoParamsLTX
from .nodes.model_auto_router import ModelAutoRouter
from .nodes.wan_video_params import HeltoVideoParams


class HeltoUtilsExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            HeltoVideoParams,
            HeltoVideoParamsLTX,
            AspectRatioCalculator,
            ModelAutoRouter,
        ]


async def comfy_entrypoint() -> HeltoUtilsExtension:
    return HeltoUtilsExtension()

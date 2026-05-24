from typing_extensions import override

from comfy_api.latest import ComfyExtension, io

from .nodes.aspect_ratio_calculator import AspectRatioCalculator
from .nodes.image_comparer import ImageComparer
from .nodes.ltx_video_params import HeltoVideoParamsLTX
from .nodes.model_auto_router import ModelAutoRouter
from .nodes.save_image_advanced import SaveImageAdvanced
from .nodes.save_video_advanced import SaveVideoAdvanced
from .nodes.video_comparer import VideoComparer
from .nodes.wan_video_params import HeltoVideoParams


WEB_DIRECTORY = "./web"


class HeltoUtilsExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            HeltoVideoParams,
            HeltoVideoParamsLTX,
            AspectRatioCalculator,
            ModelAutoRouter,
            ImageComparer,
            VideoComparer,
            SaveImageAdvanced,
            SaveVideoAdvanced,
        ]


async def comfy_entrypoint() -> HeltoUtilsExtension:
    return HeltoUtilsExtension()

from pathlib import Path


WEB_DIRECTORY = "./web"
_PACKAGE_ROOT = Path(__file__).resolve().parent

if __package__:
    from helto_privacy import register_helto_privacy_ui
    from typing_extensions import override

    from comfy_api.latest import ComfyExtension, io

    from .shared import progress_api as _helto_progress_api
    from .shared.managed_privacy import (
        install_utils_privacy,
        prompt_execution_dispatch,
        queue_operation_bindings,
        selector_execution_dispatch,
    )
    from .shared.managed_privacy_routes import register_managed_privacy_routes
    from .nodes.aspect_ratio_calculator import AspectRatioCalculator
    from .nodes.image_comparer import ImageComparer
    from .nodes.load_video import HeltoLoadVideo
    from .nodes.ltx_video_params import HeltoVideoParamsLTX
    from .nodes.model_auto_router import ModelAutoRouter
    from .nodes.prompt_enhancer import PromptEnhancer
    from .nodes.privacy_show_any import HeltoPrivacyShowAny
    from .nodes.save_image_advanced import SaveImageAdvanced
    from .nodes.save_video_advanced import SaveVideoAdvanced
    from .nodes.video_comparer import VideoComparer
    from .nodes.wan_video_params import HeltoVideoParams
    from .helto_image_selector import HeltoImageSelector

    register_helto_privacy_ui(legacy_key_dir=_PACKAGE_ROOT / "config")
    install_utils_privacy(
        _PACKAGE_ROOT,
        selector_dispatch=selector_execution_dispatch,
        prompt_dispatch=prompt_execution_dispatch,
        queue_operations=queue_operation_bindings(),
    )
    register_managed_privacy_routes()
    _helto_progress_api.install_public_alias()

    class HeltoUtilsExtension(ComfyExtension):
        @override
        async def get_node_list(self) -> list[type[io.ComfyNode]]:
            return [
                HeltoVideoParams,
                HeltoVideoParamsLTX,
                AspectRatioCalculator,
                ModelAutoRouter,
                PromptEnhancer,
                HeltoPrivacyShowAny,
                ImageComparer,
                VideoComparer,
                HeltoLoadVideo,
                HeltoImageSelector,
                SaveImageAdvanced,
                SaveVideoAdvanced,
            ]

    async def comfy_entrypoint() -> HeltoUtilsExtension:
        return HeltoUtilsExtension()

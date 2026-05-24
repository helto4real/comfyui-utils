from __future__ import annotations

from comfy_api.latest import ComfyExtension, io

from .helto_selector_backend.node import HeltoImageSelector
from .helto_selector_backend import routes as _routes  # noqa: F401 - import registers routes


class HeltoImageSelectorExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [HeltoImageSelector]


async def comfy_entrypoint() -> HeltoImageSelectorExtension:
    return HeltoImageSelectorExtension()


WEB_DIRECTORY = "./web"

__all__ = ["comfy_entrypoint", "WEB_DIRECTORY"]

from __future__ import annotations

# Compatibility shim. The selector node class lives in helto_selector_backend,
# and the package entry point in __init__.py is what ComfyUI actually loads.
# Importing this module re-exports the node class and, as a side effect,
# registers the selector's HTTP routes.
from .helto_selector_backend.node import HeltoImageSelector

__all__ = ["HeltoImageSelector"]

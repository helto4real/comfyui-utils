from __future__ import annotations

from typing import Any

from comfy.comfy_types.node_typing import IO
from comfy_api.latest import io

try:
    from ...shared.managed_privacy import utils_privacy_pack
    from ...shared.privacy_show_any_managed import PrivacyShowAnyManagedNodeAdapter
    from ...shared.privacy_show_any_text import convert_any_to_text
except ImportError as exc:
    if str(exc) != "attempted relative import beyond top-level package":
        raise
    from shared.managed_privacy import utils_privacy_pack
    from shared.privacy_show_any_managed import PrivacyShowAnyManagedNodeAdapter
    from shared.privacy_show_any_text import convert_any_to_text


anything = io.Custom(IO.ANY)

TEXT_UI_KEY = "helto_privacy_show_any"


class HeltoPrivacyShowAny(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoPrivacyShowAny",
            display_name="Helto Privacy Show Any",
            category="HELTO/Privacy",
            description="Displays any incoming value as text without saving plaintext display state in workflows.",
            inputs=[
                anything.Input("input", optional=True, tooltip="Any ComfyUI value to display as text."),
                io.String.Input("encrypted_text_state", default="", optional=True),
            ],
            outputs=[
                io.String.Output("text"),
            ],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, input: Any = None, encrypted_text_state: str = "") -> io.NodeOutput:
        del encrypted_text_state
        return PrivacyShowAnyManagedNodeAdapter(
            lambda text, ui_payload: io.NodeOutput(text, ui=ui_payload)
        ).invoke(
            input,
            utils_privacy_pack().workflow("privacy-show-any-workflow"),
        )

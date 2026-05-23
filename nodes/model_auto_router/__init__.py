from __future__ import annotations

from comfy_api.latest import io


class ModelAutoRouter(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="ModelAutoRouter",
            display_name="Model Auto Router (Mute-safe)",
            category="HELTO/Utils",
            description="Routes model_a when connected, otherwise falls back to model_b.",
            inputs=[
                io.Model.Input("model_a", optional=True),
                io.Model.Input("model_b", optional=True),
            ],
            outputs=[
                io.Model.Output(),
            ],
        )

    @classmethod
    def execute(cls, model_a=None, model_b=None) -> io.NodeOutput:
        if model_a is not None:
            return io.NodeOutput(model_a)

        if model_b is not None:
            return io.NodeOutput(model_b)

        raise ValueError("Ingen modell hittades! Koppla in eller av-muta minst en modell.")

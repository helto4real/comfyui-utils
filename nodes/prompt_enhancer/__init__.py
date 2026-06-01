from __future__ import annotations

import random
from typing import Any

from comfy_api.latest import io

from ...shared.prompt_enhancer import (
    DEFAULT_OLLAMA_KEEP_ALIVE,
    DEFAULT_OLLAMA_MODEL,
    DEFAULT_OLLAMA_TIMEOUT,
    DEFAULT_OLLAMA_URL,
    MAX_PROMPT_IMAGES,
    OllamaPromptProvider,
    PromptEnhancerRequest,
    PromptEnhancerSettings,
    build_system_prompt,
    decrypt_prompt_text,
    resolve_seed,
    substitute_prompt_variables,
)
from ...shared.prompt_enhancer.provider import encode_images_for_ollama
from ...shared.prompt_enhancer import routes  # noqa: F401


class PromptEnhancer(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoPromptEnhancer",
            display_name="Prompt enhancer",
            category="HELTO/Prompt",
            description="Enhances a prompt with Ollama using optional image context.",
            inputs=[
                io.Image.Input("images", optional=True),
                io.Video.Input("video", optional=True),
                io.Audio.Input("audio", optional=True),
                io.Int.Input(
                    "seed",
                    default=-1,
                    min=-1,
                    max=2_147_483_647,
                    step=1,
                    display_mode=io.NumberDisplay.number,
                ),
                io.String.Input("model", default=DEFAULT_OLLAMA_MODEL),
                io.Combo.Input("prompt_type", options=["image", "video", "multi scene video"], default="image"),
                io.String.Input(
                    "prompt",
                    multiline=True,
                    default="",
                    placeholder="Describe the result you want.",
                    dynamic_prompts=False,
                ),
                io.String.Input("variables", default="[]", dynamic_prompts=False),
                io.Boolean.Input("hide_mode", default=False),
                io.Boolean.Input("privacy_mode", default=True),
                io.String.Input("ollama_url", default=DEFAULT_OLLAMA_URL),
                io.Int.Input("ollama_keep_alive", default=DEFAULT_OLLAMA_KEEP_ALIVE, min=-1, max=120, step=1),
                io.Combo.Input("ollama_keep_alive_unit", options=["seconds", "minutes", "hours"], default="minutes"),
                io.Int.Input("ollama_timeout", default=DEFAULT_OLLAMA_TIMEOUT, min=1, max=3600, step=1),
            ],
            outputs=[
                io.String.Output("prompt"),
                io.String.Output("system_prompt"),
                io.String.Output("resolved_prompt"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, seed: int = -1, **kwargs: Any) -> str:
        if _as_int(seed, -1) < 0:
            return str(random.SystemRandom().random())
        return ""

    @classmethod
    def execute(
        cls,
        images=None,
        video=None,
        audio=None,
        seed: int = -1,
        model: str = DEFAULT_OLLAMA_MODEL,
        prompt_type: str = "image",
        prompt: str = "",
        variables: str = "[]",
        hide_mode: bool = False,
        privacy_mode: bool = True,
        ollama_url: str = DEFAULT_OLLAMA_URL,
        ollama_keep_alive: int = DEFAULT_OLLAMA_KEEP_ALIVE,
        ollama_keep_alive_unit: str = "minutes",
        ollama_timeout: int = DEFAULT_OLLAMA_TIMEOUT,
    ) -> io.NodeOutput:
        resolved_seed = resolve_seed(seed)
        system_prompt = build_system_prompt(prompt_type, has_video=video is not None, has_audio=audio is not None)
        settings = PromptEnhancerSettings(
            ollama_url=ollama_url or DEFAULT_OLLAMA_URL,
            keep_alive=_as_int(ollama_keep_alive, DEFAULT_OLLAMA_KEEP_ALIVE),
            keep_alive_unit=ollama_keep_alive_unit or "minutes",
            timeout=max(1, _as_int(ollama_timeout, DEFAULT_OLLAMA_TIMEOUT)),
        )
        plain_prompt = decrypt_prompt_text(prompt)
        resolved_prompt = substitute_prompt_variables(plain_prompt.strip(), variables, resolved_seed)
        request = PromptEnhancerRequest(
            model=(model or DEFAULT_OLLAMA_MODEL).strip() or DEFAULT_OLLAMA_MODEL,
            prompt_type=prompt_type or "image",
            prompt=resolved_prompt,
            system_prompt=system_prompt,
            seed=resolved_seed,
            images=encode_images_for_ollama(images, MAX_PROMPT_IMAGES),
            settings=settings,
        )
        generated_prompt = OllamaPromptProvider().generate(request)
        return io.NodeOutput(generated_prompt, system_prompt, resolved_prompt)


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

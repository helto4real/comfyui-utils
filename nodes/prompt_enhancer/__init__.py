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
    PromptEnhancerRequest,
    PromptEnhancerSettings,
    PromptProviderRegistry,
    build_system_prompt,
    decrypt_prompt_text,
    PromptEnhancerProgress,
    resolve_seed,
    build_resolved_segment_prompt,
    build_segment_variables,
    substitute_prompt_variables,
    parse_video_prompt_script,
)
from ...shared.prompt_enhancer.provider import encode_images_for_ollama
from ...shared.prompt_enhancer import routes  # noqa: F401


VIDEO_PROMPT_TYPES = {"video", "multi scene video"}
ALL_SEGMENTS_MODE = "all segments"
SINGLE_SEGMENT_MODE = "single segment"
SEGMENT_GENERATION_MODES = [ALL_SEGMENTS_MODE, SINGLE_SEGMENT_MODE]


class PromptEnhancer(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoPromptEnhancer",
            display_name="Prompt enhancer",
            category="HELTO/Prompt",
            description="Enhances a prompt with Ollama using optional image context.",
            hidden=[io.Hidden.unique_id],
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
                io.Int.Input(
                    "active_segment_index",
                    default=1,
                    min=1,
                    max=10_000,
                    step=1,
                    display_mode=io.NumberDisplay.number,
                ),
                io.Combo.Input(
                    "segment_generation_mode",
                    options=SEGMENT_GENERATION_MODES,
                    default=ALL_SEGMENTS_MODE,
                ),
                io.String.Input(
                    "script",
                    multiline=True,
                    default="",
                    placeholder="Describe the result you want, or write a segmented video script.",
                    dynamic_prompts=False,
                ),
                io.String.Input("variables", default="[]", dynamic_prompts=False),
                io.Boolean.Input("hide_mode", default=False),
                io.Boolean.Input("privacy_mode", default=True),
                io.String.Input("ollama_url", default=DEFAULT_OLLAMA_URL),
                io.Int.Input("ollama_keep_alive", default=DEFAULT_OLLAMA_KEEP_ALIVE, min=-1, max=120, step=1),
                io.Combo.Input("ollama_keep_alive_unit", options=["seconds", "minutes", "hours"], default="minutes"),
                io.Int.Input("ollama_timeout", default=DEFAULT_OLLAMA_TIMEOUT, min=1, max=3600, step=1),
                io.String.Input("provider", default="ollama"),
                io.String.Input("model_id", default=""),
                io.String.Input("model_backend", default="ollama"),
                io.String.Input("provider_model_history", default="{}", dynamic_prompts=False),
            ],
            outputs=[
                io.String.Output("enhanced_prompt"),
                io.String.Output("system_prompt"),
                io.String.Output("resolved_segment_prompt"),
                io.String.Output("parsed_direction"),
                io.String.Output("parsed_continuity"),
                io.String.Output("reference_mode"),
                io.String.Output("image_notes"),
                io.Int.Output("segment_count"),
                io.String.Output("warnings"),
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
        provider: str = "ollama",
        model_id: str = "",
        model_backend: str = "ollama",
        provider_model_history: str = "{}",
        model: str = DEFAULT_OLLAMA_MODEL,
        prompt_type: str = "image",
        active_segment_index: int = 1,
        segment_generation_mode: str = ALL_SEGMENTS_MODE,
        script: str = "",
        variables: str = "[]",
        hide_mode: bool = False,
        privacy_mode: bool = True,
        ollama_url: str = DEFAULT_OLLAMA_URL,
        ollama_keep_alive: int = DEFAULT_OLLAMA_KEEP_ALIVE,
        ollama_keep_alive_unit: str = "minutes",
        ollama_timeout: int = DEFAULT_OLLAMA_TIMEOUT,
        unique_id: str | None = None,
    ) -> io.NodeOutput:
        unique_id = unique_id or getattr(getattr(cls, "hidden", None), "unique_id", None)
        progress = PromptEnhancerProgress(unique_id)
        resolved_seed = resolve_seed(seed)
        settings = PromptEnhancerSettings(
            ollama_url=ollama_url or DEFAULT_OLLAMA_URL,
            keep_alive=_as_int(ollama_keep_alive, DEFAULT_OLLAMA_KEEP_ALIVE),
            keep_alive_unit=ollama_keep_alive_unit or "minutes",
            timeout=max(1, _as_int(ollama_timeout, DEFAULT_OLLAMA_TIMEOUT)),
        )
        prompt_kind = prompt_type if prompt_type in VIDEO_PROMPT_TYPES else "image"
        plain_script = decrypt_prompt_text(script)
        resolved_script = substitute_prompt_variables(plain_script.strip(), variables, resolved_seed)
        progress.phase_start("media")
        registry = PromptProviderRegistry()
        model_name = (model or DEFAULT_OLLAMA_MODEL).strip() or DEFAULT_OLLAMA_MODEL
        model_identifier = (model_id or model or DEFAULT_OLLAMA_MODEL).strip()
        if prompt_kind in VIDEO_PROMPT_TYPES:
            encoded_images = encode_images_for_ollama(images, MAX_PROMPT_IMAGES, progress, preserve_order=True)
            parsed_script = parse_video_prompt_script(resolved_script, image_count=_prompt_image_count(images))
            segment_variables_list = _segment_variables_for_mode(
                parsed_script=parsed_script,
                generation_mode=segment_generation_mode,
                active_segment_index=active_segment_index,
                prompt_kind=prompt_kind,
                has_video=video is not None,
                has_audio=audio is not None,
            )
            system_prompts: list[str] = []
            resolved_prompts: list[str] = []
            generated_prompts: list[str] = []
            for segment_variables in segment_variables_list:
                system_prompt_for_segment = build_system_prompt(
                    prompt_kind,
                    has_video=video is not None,
                    has_audio=audio is not None,
                    prompt_values=segment_variables,
                )
                resolved_prompt_for_segment = build_resolved_segment_prompt(segment_variables)
                system_prompts.append(system_prompt_for_segment)
                resolved_prompts.append(resolved_prompt_for_segment)
                request = PromptEnhancerRequest(
                    model=model_name,
                    prompt_type=prompt_kind,
                    prompt=resolved_prompt_for_segment,
                    system_prompt=system_prompt_for_segment,
                    seed=resolved_seed,
                    images=encoded_images,
                    settings=settings,
                    provider=provider or "ollama",
                    model_id=model_identifier,
                    model_backend=model_backend or "",
                )
                generated_prompts.append(registry.generate(request, progress))

            generated_prompt = _join_blocks(generated_prompts)
            system_prompt = _join_blocks(system_prompts, keep_empty=True)
            resolved_prompt = _join_blocks(resolved_prompts, keep_empty=True)
            parsed_direction = _join_segment_values(segment_variables_list, "direction")
            parsed_continuity = _join_segment_values(segment_variables_list, "continuity")
            reference_mode = _join_segment_values(segment_variables_list, "reference_mode")
            image_notes = _join_segment_values(segment_variables_list, "image_notes")
            segment_count = int(segment_variables_list[0].get("segment_total") or 0)
            warnings = _join_unique_warnings(segment_variables_list)
        else:
            encoded_images = encode_images_for_ollama(images, MAX_PROMPT_IMAGES, progress)
            system_prompt = build_system_prompt(prompt_kind, has_video=video is not None, has_audio=audio is not None)
            resolved_prompt = resolved_script
            parsed_direction = ""
            parsed_continuity = ""
            reference_mode = ""
            image_notes = ""
            segment_count = 0
            warnings = ""
            request = PromptEnhancerRequest(
                model=model_name,
                prompt_type=prompt_kind,
                prompt=resolved_prompt,
                system_prompt=system_prompt,
                seed=resolved_seed,
                images=encoded_images,
                settings=settings,
                provider=provider or "ollama",
                model_id=model_identifier,
                model_backend=model_backend or "",
            )
            generated_prompt = registry.generate(request, progress)
        progress.phase_done("cleanup")
        progress.complete()
        return io.NodeOutput(
            generated_prompt,
            system_prompt,
            resolved_prompt,
            parsed_direction,
            parsed_continuity,
            reference_mode,
            image_notes,
            segment_count,
            warnings,
        )


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _prompt_image_count(images: Any) -> int:
    if images is None:
        return 0
    try:
        return min(int(len(images)), MAX_PROMPT_IMAGES)
    except Exception:
        return 0


def _segment_variables_for_mode(
    parsed_script: Any,
    generation_mode: str,
    active_segment_index: int,
    prompt_kind: str,
    has_video: bool,
    has_audio: bool,
) -> list[dict[str, Any]]:
    if generation_mode == SINGLE_SEGMENT_MODE:
        return [
            build_segment_variables(
                parsed_script,
                active_segment_index,
                prompt_type=prompt_kind,
                has_video=has_video,
                has_audio=has_audio,
            )
        ]

    segment_total = len(parsed_script.segments)
    if segment_total == 0:
        return [
            build_segment_variables(
                parsed_script,
                1,
                prompt_type=prompt_kind,
                has_video=has_video,
                has_audio=has_audio,
            )
        ]

    return [
        build_segment_variables(
            parsed_script,
            segment_index,
            prompt_type=prompt_kind,
            has_video=has_video,
            has_audio=has_audio,
        )
        for segment_index in range(1, segment_total + 1)
    ]


def _join_blocks(values: list[str], keep_empty: bool = False) -> str:
    blocks = [str(value or "").strip() for value in values]
    if not keep_empty:
        blocks = [block for block in blocks if block]
    if keep_empty and not any(blocks):
        return ""
    return "\n\n".join(blocks)


def _join_segment_values(segment_variables_list: list[dict[str, Any]], key: str) -> str:
    return _join_blocks([str(segment_variables.get(key) or "") for segment_variables in segment_variables_list], keep_empty=True)


def _join_unique_warnings(segment_variables_list: list[dict[str, Any]]) -> str:
    warnings: list[str] = []
    seen: set[str] = set()
    for segment_variables in segment_variables_list:
        for warning in segment_variables.get("warnings", []):
            text = str(warning or "").strip()
            if not text or text in seen:
                continue
            seen.add(text)
            warnings.append(text)
    return "\n".join(warnings)

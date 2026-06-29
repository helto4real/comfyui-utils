from __future__ import annotations

import random
from typing import Any

from comfy_api.latest import io

from ...shared.prompt_enhancer import (
    DEFAULT_GENERATION_MAX_TOKENS,
    DEFAULT_OLLAMA_KEEP_ALIVE,
    DEFAULT_OLLAMA_MODEL,
    DEFAULT_OLLAMA_TIMEOUT,
    DEFAULT_OLLAMA_URL,
    MAX_GENERATION_MAX_TOKENS,
    MAX_PROMPT_IMAGES,
    PromptEnhancerRequest,
    PromptEnhancerSettings,
    PromptProviderRegistry,
    VISUAL_CONTEXT_SYSTEM_PROMPT,
    build_visual_context_prompt,
    build_system_prompt,
    decrypt_prompt_text,
    PromptEnhancerProgress,
    provider_model_supports_images,
    resolve_seed,
    build_resolved_segment_prompt,
    build_segment_variables,
    substitute_prompt_variables,
    parse_video_prompt_script,
)
from ...shared.prompt_enhancer.local_provider import (
    LOCAL_GENERATION_TOKENS,
    _instruction,
    clean_prompt_text,
)
from ...shared.prompt_enhancer.provider import encode_images_for_ollama
from ...shared.prompt_enhancer import routes  # noqa: F401


VIDEO_PROMPT_TYPES = {"video", "multi scene video"}
ALL_SEGMENTS_MODE = "all segments"
SINGLE_SEGMENT_MODE = "single segment"
SEGMENT_GENERATION_MODES = [ALL_SEGMENTS_MODE, SINGLE_SEGMENT_MODE]
VISION_AUTO_MODE = "auto"
VISION_DIRECT_MODE = "direct to writer"
VISION_SEPARATE_MODE = "separate vision model"
VISION_OFF_MODE = "off"
VISION_CONTEXT_MODES = [VISION_AUTO_MODE, VISION_DIRECT_MODE, VISION_SEPARATE_MODE, VISION_OFF_MODE]
DEFAULT_VISION_PROVIDER = "local_transformers_vlm"
DEFAULT_VISION_MODEL = "qwen3_vl_4b_fast"
DEFAULT_VISION_BACKEND = "qwen"


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
                io.Clip.Input("clip", optional=True),
                io.Int.Input(
                    "seed",
                    default=-1,
                    min=-1,
                    max=2_147_483_647,
                    step=1,
                    control_after_generate=io.ControlAfterGenerate.randomize,
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
                io.Combo.Input(
                    "vision_context_mode",
                    options=VISION_CONTEXT_MODES,
                    default=VISION_AUTO_MODE,
                ),
                io.String.Input(
                    "script",
                    multiline=True,
                    default="",
                    placeholder="Describe the result you want, or write a segmented video script.",
                    dynamic_prompts=False,
                ),
                io.String.Input(
                    "external_prompt",
                    optional=True,
                    force_input=True,
                    default="",
                    dynamic_prompts=False,
                ),
                io.String.Input("variables", default="[]", dynamic_prompts=False),
                io.String.Input("image_system_prompt_preset", default="default", dynamic_prompts=False),
                io.String.Input("video_system_prompt_preset", default="default", dynamic_prompts=False),
                io.Boolean.Input("hide_mode", default=False),
                io.Boolean.Input("privacy_mode", default=True),
                io.String.Input("ollama_url", default=DEFAULT_OLLAMA_URL),
                io.Int.Input("ollama_keep_alive", default=DEFAULT_OLLAMA_KEEP_ALIVE, min=-1, max=120, step=1),
                io.Combo.Input("ollama_keep_alive_unit", options=["seconds", "minutes", "hours"], default="minutes"),
                io.Int.Input("ollama_timeout", default=DEFAULT_OLLAMA_TIMEOUT, min=1, max=3600, step=1),
                io.Int.Input(
                    "generation_max_tokens",
                    default=DEFAULT_GENERATION_MAX_TOKENS,
                    min=0,
                    max=MAX_GENERATION_MAX_TOKENS,
                    step=1,
                    display_mode=io.NumberDisplay.number,
                ),
                io.String.Input("provider", default="ollama"),
                io.String.Input("model_id", default=""),
                io.String.Input("model_backend", default="ollama"),
                io.String.Input("provider_model_history", default="{}", dynamic_prompts=False),
                io.String.Input("vision_provider", default=DEFAULT_VISION_PROVIDER),
                io.String.Input("vision_model_id", default=DEFAULT_VISION_MODEL),
                io.String.Input("vision_model_backend", default=DEFAULT_VISION_BACKEND),
            ],
            outputs=[
                io.String.Output("enhanced_prompt"),
                io.String.Output("system_prompt"),
                io.String.Output("resolved_segment_prompt"),
                io.String.Output("parsed_direction"),
                io.String.Output("parsed_continuity"),
                io.String.Output("reference_mode"),
                io.String.Output("image_notes"),
                io.String.Output("visual_context"),
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
        clip=None,
        seed: int = -1,
        provider: str = "ollama",
        model_id: str = "",
        model_backend: str = "ollama",
        provider_model_history: str = "{}",
        model: str = DEFAULT_OLLAMA_MODEL,
        prompt_type: str = "image",
        active_segment_index: int = 1,
        segment_generation_mode: str = ALL_SEGMENTS_MODE,
        vision_context_mode: str = VISION_AUTO_MODE,
        script: str = "",
        external_prompt: str = "",
        variables: str = "[]",
        image_system_prompt_preset: str = "default",
        video_system_prompt_preset: str = "default",
        hide_mode: bool = False,
        privacy_mode: bool = True,
        ollama_url: str = DEFAULT_OLLAMA_URL,
        ollama_keep_alive: int = DEFAULT_OLLAMA_KEEP_ALIVE,
        ollama_keep_alive_unit: str = "minutes",
        ollama_timeout: int = DEFAULT_OLLAMA_TIMEOUT,
        generation_max_tokens: int = DEFAULT_GENERATION_MAX_TOKENS,
        vision_provider: str = DEFAULT_VISION_PROVIDER,
        vision_model_id: str = DEFAULT_VISION_MODEL,
        vision_model_backend: str = DEFAULT_VISION_BACKEND,
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
        writer_max_tokens = _bounded_int(
            generation_max_tokens,
            DEFAULT_GENERATION_MAX_TOKENS,
            0,
            MAX_GENERATION_MAX_TOKENS,
        )
        prompt_kind = prompt_type if prompt_type in VIDEO_PROMPT_TYPES else "image"
        plain_script = decrypt_prompt_text(script)
        prompt_source = str(external_prompt or "").strip() or plain_script.strip()
        resolved_script = substitute_prompt_variables(prompt_source, variables, resolved_seed)
        progress.phase_start("media")
        registry = PromptProviderRegistry()
        model_name = (model or DEFAULT_OLLAMA_MODEL).strip() or DEFAULT_OLLAMA_MODEL
        model_identifier = (model_id or model or DEFAULT_OLLAMA_MODEL).strip()
        writer_provider = provider or "ollama"
        writer_backend = model_backend or ""
        vision_writer_provider = "connected_clip" if clip is not None else writer_provider
        vision_writer_model_identifier = "connected CLIP" if clip is not None else model_identifier
        vision_writer_backend = "" if clip is not None else writer_backend
        vision_config = {
            "provider": (vision_provider or "").strip(),
            "model_id": (vision_model_id or "").strip(),
            "model_backend": (vision_model_backend or "").strip(),
        }
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
            visual_contexts: list[str] = []
            extra_warnings: list[str] = []
            segment_run_plan = []
            for segment_variables in segment_variables_list:
                selected_images = _selected_segment_images(encoded_images, segment_variables.get("image_references", []))
                selected_mode, mode_warnings = _resolve_vision_mode(
                    vision_context_mode,
                    selected_images,
                    vision_writer_provider,
                    vision_writer_model_identifier,
                    vision_writer_backend,
                    vision_config,
                )
                extra_warnings.extend(mode_warnings)
                segment_run_plan.append(
                    {
                        "variables": segment_variables,
                        "selected_images": selected_images,
                        "selected_mode": selected_mode,
                    }
                )
            progress.begin_model_calls(_model_call_count(segment_run_plan))
            for segment_plan in segment_run_plan:
                segment_variables = segment_plan["variables"]
                selected_images = segment_plan["selected_images"]
                selected_mode = segment_plan["selected_mode"]
                direct_images = selected_images if selected_mode == VISION_DIRECT_MODE else []
                visual_context = ""
                if selected_mode == VISION_SEPARATE_MODE and selected_images:
                    with progress.model_call() as call_progress:
                        visual_context = _generate_visual_context(
                            registry=registry,
                            prompt_kind=prompt_kind,
                            prompt=str(segment_variables.get("direction") or ""),
                            image_notes=str(segment_variables.get("image_notes") or ""),
                            image_references=segment_variables.get("image_references", []),
                            reference_mode=str(segment_variables.get("reference_mode") or ""),
                            selected_images=selected_images,
                            settings=settings,
                            seed=resolved_seed,
                            vision_config=vision_config,
                            progress=call_progress,
                            segment_index=_as_int(segment_variables.get("segment_index"), 0),
                            segment_total=_as_int(segment_variables.get("segment_total"), 0),
                        )
                segment_variables["visual_context"] = visual_context
                system_prompt_for_segment = build_system_prompt(
                    prompt_kind,
                    has_video=video is not None,
                    has_audio=audio is not None,
                    prompt_values=segment_variables,
                    system_prompt_preset=video_system_prompt_preset,
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
                    images=direct_images,
                    settings=settings,
                    provider=writer_provider,
                    model_id=model_identifier,
                    model_backend=writer_backend,
                    max_tokens=writer_max_tokens,
                )
                with progress.model_call() as call_progress:
                    generated_prompts.append(_generate_writer_prompt(registry, request, clip, call_progress))
                visual_contexts.append(visual_context)

            generated_prompt = _join_blocks(generated_prompts)
            system_prompt = _join_blocks(system_prompts, keep_empty=True)
            resolved_prompt = _join_blocks(resolved_prompts, keep_empty=True)
            parsed_direction = _join_segment_values(segment_variables_list, "direction")
            parsed_continuity = _join_segment_values(segment_variables_list, "continuity")
            reference_mode = _join_segment_values(segment_variables_list, "reference_mode")
            image_notes = _join_segment_values(segment_variables_list, "image_notes")
            visual_context = _join_blocks(visual_contexts, keep_empty=True)
            segment_count = int(segment_variables_list[0].get("segment_total") or 0)
            warnings = _join_unique_warnings(segment_variables_list, extra_warnings)
        else:
            encoded_images = encode_images_for_ollama(images, MAX_PROMPT_IMAGES, progress)
            selected_mode, mode_warnings = _resolve_vision_mode(
                vision_context_mode,
                encoded_images,
                vision_writer_provider,
                vision_writer_model_identifier,
                vision_writer_backend,
                vision_config,
            )
            visual_context = ""
            if selected_mode == VISION_SEPARATE_MODE and encoded_images:
                progress.begin_model_calls(2)
                with progress.model_call() as call_progress:
                    visual_context = _generate_visual_context(
                        registry=registry,
                        prompt_kind=prompt_kind,
                        prompt=resolved_script,
                        image_notes="",
                        image_references=None,
                        reference_mode="",
                        selected_images=encoded_images,
                        settings=settings,
                        seed=resolved_seed,
                        vision_config=vision_config,
                        progress=call_progress,
                    )
            else:
                progress.begin_model_calls(1)
            direct_images = encoded_images if selected_mode == VISION_DIRECT_MODE else []
            system_prompt = build_system_prompt(
                prompt_kind,
                has_video=video is not None,
                has_audio=audio is not None,
                system_prompt_preset=image_system_prompt_preset,
            )
            resolved_prompt = _resolved_prompt_with_visual_context(resolved_script, visual_context)
            parsed_direction = ""
            parsed_continuity = ""
            reference_mode = ""
            image_notes = ""
            segment_count = 0
            warnings = "\n".join(mode_warnings)
            request = PromptEnhancerRequest(
                model=model_name,
                prompt_type=prompt_kind,
                prompt=resolved_prompt,
                system_prompt=system_prompt,
                seed=resolved_seed,
                images=direct_images,
                settings=settings,
                provider=writer_provider,
                model_id=model_identifier,
                model_backend=writer_backend,
                max_tokens=writer_max_tokens,
            )
            with progress.model_call() as call_progress:
                generated_prompt = _generate_writer_prompt(registry, request, clip, call_progress)
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
            visual_context,
            segment_count,
            warnings,
        )


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _bounded_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    return min(maximum, max(minimum, _as_int(value, default)))


def _generate_writer_prompt(
    registry: PromptProviderRegistry,
    request: PromptEnhancerRequest,
    clip: Any = None,
    progress: PromptEnhancerProgress | None = None,
) -> str:
    if clip is None:
        return registry.generate(request, progress)
    return _generate_with_clip(
        clip=clip,
        system_prompt=request.system_prompt,
        prompt=request.prompt,
        seed=request.seed,
        max_tokens=request.max_tokens,
        progress=progress,
    )


def _generate_with_clip(
    clip: Any,
    system_prompt: str,
    prompt: str,
    seed: int,
    max_tokens: int,
    progress: PromptEnhancerProgress | None = None,
) -> str:
    required_methods = ("tokenize", "generate", "decode")
    if any(not callable(getattr(clip, method_name, None)) for method_name in required_methods):
        raise RuntimeError(
            "Connected CLIP input must support ComfyUI text generation with tokenize, generate, and decode."
        )

    instruction = _instruction(system_prompt, prompt)
    token_budget = _bounded_int(max_tokens, DEFAULT_GENERATION_MAX_TOKENS, 0, MAX_GENERATION_MAX_TOKENS)
    if token_budget <= 0:
        token_budget = LOCAL_GENERATION_TOKENS

    if progress is not None:
        progress.phase_start("generate")
    try:
        tokens = clip.tokenize(instruction)
        generated_ids = clip.generate(
            tokens,
            do_sample=False,
            max_length=token_budget,
            temperature=0.2,
            top_k=50,
            top_p=0.95,
            min_p=0.0,
            repetition_penalty=1.05,
            seed=seed,
        )
        return clean_prompt_text(clip.decode(generated_ids))
    except Exception as exc:
        raise RuntimeError(
            "Connected CLIP input could not generate text; use a generation-capable ComfyUI CLIP/text-generator."
        ) from exc
    finally:
        if progress is not None:
            progress.phase_done("generate")


def _prompt_image_count(images: Any) -> int:
    if images is None:
        return 0
    try:
        return min(int(len(images)), MAX_PROMPT_IMAGES)
    except Exception:
        return 0


def _selected_segment_images(encoded_images: list[str], image_references: Any) -> list[str]:
    selected: list[str] = []
    seen: set[int] = set()
    for reference in image_references or []:
        index = _as_int(getattr(reference, "index", 0), 0)
        if index < 1 or index in seen:
            continue
        seen.add(index)
        encoded_index = index - 1
        if 0 <= encoded_index < len(encoded_images):
            selected.append(encoded_images[encoded_index])
    return selected


def _model_call_count(segment_run_plan: list[dict[str, Any]]) -> int:
    count = 0
    for segment_plan in segment_run_plan:
        count += 1
        if segment_plan.get("selected_mode") == VISION_SEPARATE_MODE and segment_plan.get("selected_images"):
            count += 1
    return count


def _resolve_vision_mode(
    requested_mode: str,
    selected_images: list[str],
    writer_provider: str,
    writer_model_id: str,
    writer_backend: str,
    vision_config: dict[str, str],
) -> tuple[str, list[str]]:
    if not selected_images:
        return VISION_OFF_MODE, []

    mode = requested_mode if requested_mode in VISION_CONTEXT_MODES else VISION_AUTO_MODE
    writer_supports_images = provider_model_supports_images(writer_provider, writer_model_id, writer_backend)
    vision_supports_images = _vision_config_supports_images(vision_config)
    warnings: list[str] = []

    if mode == VISION_OFF_MODE:
        return VISION_OFF_MODE, ["Images are connected or referenced, but vision_context_mode is off."]

    if mode == VISION_DIRECT_MODE:
        if not writer_supports_images:
            warnings.append(
                f"Writer model `{writer_model_id}` is not known to support images; direct mode will still send them."
            )
        return VISION_DIRECT_MODE, warnings

    if mode == VISION_SEPARATE_MODE:
        if vision_supports_images:
            return VISION_SEPARATE_MODE, []
        return VISION_OFF_MODE, ["Images were selected, but no usable separate vision model is configured."]

    if writer_supports_images:
        return VISION_DIRECT_MODE, []
    if vision_supports_images:
        return VISION_SEPARATE_MODE, []
    return VISION_OFF_MODE, ["Images were selected, but neither the writer model nor the configured vision model can use them."]


def _vision_config_supports_images(vision_config: dict[str, str]) -> bool:
    provider = vision_config.get("provider", "")
    model_id = vision_config.get("model_id", "")
    backend = vision_config.get("model_backend", "")
    if not provider or not model_id:
        return False
    return provider_model_supports_images(provider, model_id, backend)


def _generate_visual_context(
    registry: PromptProviderRegistry,
    prompt_kind: str,
    prompt: str,
    image_notes: str,
    image_references: object | None,
    reference_mode: str,
    selected_images: list[str],
    settings: PromptEnhancerSettings,
    seed: int,
    vision_config: dict[str, str],
    progress: PromptEnhancerProgress,
    segment_index: int | None = None,
    segment_total: int | None = None,
) -> str:
    vision_model_id = vision_config.get("model_id") or DEFAULT_VISION_MODEL
    request = PromptEnhancerRequest(
        model=vision_model_id,
        prompt_type="image",
        prompt=build_visual_context_prompt(
            prompt_kind,
            prompt,
            image_notes=image_notes,
            image_references=image_references,
            reference_mode=reference_mode,
            segment_index=segment_index,
            segment_total=segment_total,
        ),
        system_prompt=VISUAL_CONTEXT_SYSTEM_PROMPT,
        seed=seed,
        images=selected_images,
        settings=settings,
        provider=vision_config.get("provider") or DEFAULT_VISION_PROVIDER,
        model_id=vision_model_id,
        model_backend=vision_config.get("model_backend") or DEFAULT_VISION_BACKEND,
    )
    return str(registry.generate_visual_context(request, progress) or "").strip()


def _resolved_prompt_with_visual_context(prompt: str, visual_context: str) -> str:
    prompt_text = str(prompt or "").strip()
    visual_text = str(visual_context or "").strip()
    if not visual_text:
        return prompt_text
    if not prompt_text:
        return f"Visual context: {visual_text}"
    return f"{prompt_text}\n\nVisual context: {visual_text}"


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


def _join_unique_warnings(segment_variables_list: list[dict[str, Any]], extra_warnings: list[str] | None = None) -> str:
    warnings: list[str] = []
    seen: set[str] = set()
    for segment_variables in segment_variables_list:
        for warning in segment_variables.get("warnings", []):
            text = str(warning or "").strip()
            if not text or text in seen:
                continue
            seen.add(text)
            warnings.append(text)
    for warning in extra_warnings or []:
        text = str(warning or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        warnings.append(text)
    return "\n".join(warnings)

from __future__ import annotations

import base64
import io as stdlib_io
import json
import random
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterator, Protocol

from PIL import Image

from .progress import PromptEnhancerProgress
from .prompts import build_video_prompt_blocks, load_packaged_system_prompt, load_system_prompt, render_video_system_prompt


DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_MODEL = "llava:latest"
DEFAULT_OLLAMA_KEEP_ALIVE = 5
DEFAULT_OLLAMA_KEEP_ALIVE_UNIT = "minutes"
DEFAULT_OLLAMA_TIMEOUT = 120
DEFAULT_GENERATION_MAX_TOKENS = 0
MAX_GENERATION_MAX_TOKENS = 4096
MAX_PROMPT_IMAGES = 8
MAX_SEED = 2_147_483_647
PROVIDER_OLLAMA = "ollama"
OLLAMA_ESTIMATED_GENERATION_TOKENS = 180
KNOWN_OLLAMA_VISION_MODEL_MARKERS = (
    "llava",
    "bakllava",
    "moondream",
    "minicpm-v",
    "minicpm_v",
    "qwen-vl",
    "qwen2-vl",
    "qwen2.5-vl",
    "qwen2.5vl",
    "qwen3-vl",
    "qwen3vl",
    "gemma3",
    "gemma-3",
)

PROMPT_TYPES = ("image", "video", "multi scene video")
IMAGE_SYSTEM_PROMPT = load_packaged_system_prompt("image")
VISUAL_CONTEXT_SYSTEM_PROMPT = (
    "You are a concise visual context analyzer for a prompt enhancement node. "
    "Analyze only the provided reference images in relation to the user's requested prompt. "
    "Return compact visual notes that another text model can use. Do not write the final prompt."
)



@dataclass(frozen=True)
class PromptEnhancerSettings:
    ollama_url: str = DEFAULT_OLLAMA_URL
    keep_alive: int = DEFAULT_OLLAMA_KEEP_ALIVE
    keep_alive_unit: str = DEFAULT_OLLAMA_KEEP_ALIVE_UNIT
    timeout: int = DEFAULT_OLLAMA_TIMEOUT


@dataclass(frozen=True)
class PromptEnhancerRequest:
    model: str
    prompt_type: str
    prompt: str
    system_prompt: str
    seed: int
    images: list[str]
    settings: PromptEnhancerSettings
    provider: str = PROVIDER_OLLAMA
    model_id: str = ""
    model_backend: str = ""
    max_tokens: int = DEFAULT_GENERATION_MAX_TOKENS


class PromptProvider(Protocol):
    def list_models(self, url: str, timeout: int = DEFAULT_OLLAMA_TIMEOUT) -> list[str]:
        ...

    def generate(self, request: PromptEnhancerRequest, progress: PromptEnhancerProgress | None = None) -> str:
        ...


def _json_request(url: str, payload: dict[str, Any] | None, timeout: int) -> Any:
    data = None
    headers = {"Accept": "application/json"}
    method = "GET"
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=max(1, int(timeout))) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace") or str(exc)
        raise RuntimeError(f"Ollama request failed with HTTP {exc.code}: {message}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Ollama request failed: {exc.reason}") from exc

    if not body:
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Ollama returned invalid JSON.") from exc


def _json_stream_request(url: str, payload: dict[str, Any], timeout: int) -> Iterator[dict[str, Any]]:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=max(1, int(timeout))) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise RuntimeError("Ollama returned invalid streaming JSON.") from exc
                if isinstance(item, dict) and item.get("error"):
                    raise RuntimeError(f"Ollama request failed: {item.get('error')}")
                if isinstance(item, dict):
                    yield item
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace") or str(exc)
        raise RuntimeError(f"Ollama request failed with HTTP {exc.code}: {message}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Ollama request failed: {exc.reason}") from exc


def _check_interrupted(progress: PromptEnhancerProgress | None = None) -> None:
    checker = getattr(progress, "check_interrupted", None)
    if callable(checker):
        checker()
        return
    PromptEnhancerProgress.check_interrupted()


def normalize_ollama_url(url: str | None) -> str:
    normalized = (url or DEFAULT_OLLAMA_URL).strip().rstrip("/")
    return normalized or DEFAULT_OLLAMA_URL


def ollama_keep_alive(value: int | str | None, unit: str | None) -> str:
    try:
        keep_alive = int(value if value is not None else DEFAULT_OLLAMA_KEEP_ALIVE)
    except (TypeError, ValueError):
        keep_alive = DEFAULT_OLLAMA_KEEP_ALIVE
    if keep_alive == 0:
        return "0s"

    unit_value = str(unit or DEFAULT_OLLAMA_KEEP_ALIVE_UNIT).lower()
    if unit_value.startswith("second"):
        suffix = "s"
    elif unit_value.startswith("hour"):
        suffix = "h"
    else:
        suffix = "m"
    return f"{keep_alive}{suffix}"


def requested_generation_max_tokens(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return DEFAULT_GENERATION_MAX_TOKENS


def effective_generation_token_budget(value: Any, default: int) -> int:
    requested = requested_generation_max_tokens(value)
    return requested if requested > 0 else default


def resolve_seed(seed: int | str | None, rng: random.Random | None = None) -> int:
    try:
        value = int(seed if seed is not None else -1)
    except (TypeError, ValueError):
        value = -1
    if value >= 0:
        return min(value, MAX_SEED)
    generator = rng or random.SystemRandom()
    return generator.randint(0, MAX_SEED)


def build_system_prompt(
    prompt_type: str,
    has_video: bool = False,
    has_audio: bool = False,
    prompt_values: dict[str, object] | None = None,
    system_prompt_preset: str | None = "default",
) -> str:
    prompt_kind = prompt_type if prompt_type in PROMPT_TYPES else "image"
    if prompt_kind == "image":
        return load_system_prompt("image", system_prompt_preset)
    return render_video_system_prompt(
        prompt_kind,
        has_video=has_video,
        has_audio=has_audio,
        prompt_values=prompt_values,
        system_prompt_preset=system_prompt_preset,
    )


def ollama_model_supports_images(model_id: str | None) -> bool:
    model_name = str(model_id or "").strip().lower()
    return any(marker in model_name for marker in KNOWN_OLLAMA_VISION_MODEL_MARKERS)


def provider_model_supports_images(provider: str, model_id: str, model_backend: str = "") -> bool:
    provider_id = str(provider or PROVIDER_OLLAMA).strip() or PROVIDER_OLLAMA
    if provider_id == PROVIDER_OLLAMA:
        return ollama_model_supports_images(model_id)
    try:
        from .local_provider import resolve_local_model

        spec = resolve_local_model(model_id)
    except Exception:
        return False
    return bool(spec.supports_images and spec.generator_supported)


def build_visual_context_prompt(
    prompt_type: str,
    prompt: str,
    image_notes: str = "",
    image_references: object | None = None,
    reference_mode: str = "",
    segment_index: int | None = None,
    segment_total: int | None = None,
) -> str:
    blocks = build_video_prompt_blocks(
        {
            "image_references": image_references or [],
            "segment_index": segment_index or 1,
            "segment_total": segment_total or 1,
        }
    )
    labels: list[tuple[str, object]] = [
        ("Prompt type", prompt_type or "image"),
        ("Segment", f"{segment_index} of {segment_total}" if segment_index and segment_total else ""),
        ("Reference mode", reference_mode),
        ("Image role notes", image_notes),
        ("Reference policy", blocks["reference_policy"]),
        ("Description policy", blocks["description_policy"]),
        ("Detail policy", blocks["detail_policy"]),
        ("User direction", prompt),
    ]
    body = "\n".join(f"{label}: {value}" for label, value in labels if str(value or "").strip())
    return (
        f"{body}\n\n"
        "Describe the relevant visual context in 1-4 concise sentences. "
        "Follow the selected reference policy above. If the user direction explicitly changes, replaces, ignores, or "
        "reinterprets image details, honor the user direction; otherwise use the referenced image as the source of truth. "
        "Focus on subjects, motion-relevant pose/expression, style, setting, and reference roles. "
        "Do not add instructions, markdown, labels, or a final generation prompt."
    ).strip()


def _sample_indices(count: int, limit: int = MAX_PROMPT_IMAGES) -> list[int]:
    if count <= 0:
        return []
    if count <= limit:
        return list(range(count))
    if limit <= 1:
        return [0]
    return [round(index * (count - 1) / (limit - 1)) for index in range(limit)]


def encode_images_for_ollama(
    images: Any,
    limit: int = MAX_PROMPT_IMAGES,
    progress: PromptEnhancerProgress | None = None,
    preserve_order: bool = False,
) -> list[str]:
    if images is None:
        if progress is not None:
            progress.phase_done("media")
        return []

    try:
        count = int(len(images))
    except Exception:
        if progress is not None:
            progress.phase_done("media")
        return []

    encoded: list[str] = []
    indices = list(range(min(count, limit))) if preserve_order else _sample_indices(count, limit)
    if not indices:
        if progress is not None:
            progress.phase_done("media")
        return []

    for position, index in enumerate(indices, start=1):
        image = images[index]
        try:
            tensor = image.detach().cpu().float().clamp(0, 1)
            if tensor.ndim == 3 and tensor.shape[-1] == 1:
                tensor = tensor.repeat(1, 1, 3)
            if tensor.ndim != 3 or tensor.shape[-1] < 3:
                continue
            array = tensor[..., :3].mul(255).byte().numpy()
            pil_image = Image.fromarray(array, mode="RGB")
            buffer = stdlib_io.BytesIO()
            pil_image.save(buffer, format="PNG")
            encoded.append(base64.b64encode(buffer.getvalue()).decode("ascii"))
        except Exception:
            continue
        finally:
            if progress is not None:
                progress.phase_fraction("media", position / len(indices))

    if progress is not None:
        progress.phase_done("media")
    return encoded


class OllamaPromptProvider:
    def list_models(self, url: str, timeout: int = DEFAULT_OLLAMA_TIMEOUT) -> list[str]:
        endpoint = urllib.parse.urljoin(f"{normalize_ollama_url(url)}/", "api/tags")
        payload = _json_request(endpoint, None, timeout)
        models = payload.get("models", []) if isinstance(payload, dict) else []
        names = []
        for model in models:
            if not isinstance(model, dict):
                continue
            name = model.get("model") or model.get("name")
            if name:
                names.append(str(name))
        return sorted(dict.fromkeys(names))

    def generate(self, request: PromptEnhancerRequest, progress: PromptEnhancerProgress | None = None) -> str:
        endpoint = urllib.parse.urljoin(f"{normalize_ollama_url(request.settings.ollama_url)}/", "api/generate")
        keep_alive = ollama_keep_alive(request.settings.keep_alive, request.settings.keep_alive_unit)
        payload: dict[str, Any] = {
            "model": request.model,
            "system": request.system_prompt,
            "prompt": request.prompt,
            "stream": False,
            "keep_alive": keep_alive,
            "options": {"seed": request.seed},
        }
        max_tokens = requested_generation_max_tokens(request.max_tokens)
        if max_tokens > 0:
            payload["options"]["num_predict"] = max_tokens
        if request.images:
            payload["images"] = request.images

        if progress is not None:
            return self._generate_streaming(endpoint, payload, keep_alive, request, progress)

        response = None
        raised = False
        try:
            response = _json_request(endpoint, payload, request.settings.timeout)
        except BaseException:
            raised = True
            raise
        finally:
            if keep_alive == "0s":
                try:
                    _json_request(endpoint, {"model": request.model, "keep_alive": 0, "stream": False}, request.settings.timeout)
                except Exception:
                    if not raised:
                        raise
        if not isinstance(response, dict) or "response" not in response:
            raise RuntimeError("Ollama response did not include generated text.")
        generated_prompt = str(response.get("response") or "").strip()
        return generated_prompt

    def _generate_streaming(
        self,
        endpoint: str,
        payload: dict[str, Any],
        keep_alive: str,
        request: PromptEnhancerRequest,
        progress: PromptEnhancerProgress,
    ) -> str:
        streaming_payload = dict(payload)
        streaming_payload["stream"] = True
        token_budget = effective_generation_token_budget(
            request.max_tokens,
            OLLAMA_ESTIMATED_GENERATION_TOKENS,
        )
        progress.phase_start("generate")
        chunks: list[str] = []
        chunk_count = 0
        raised = False
        try:
            for item in _json_stream_request(endpoint, streaming_payload, request.settings.timeout):
                _check_interrupted(progress)
                text = item.get("response")
                if text:
                    chunks.append(str(text))
                    chunk_count += 1
                    progress.generation_step(token_budget)
                if item.get("done"):
                    break
        except Exception:
            if chunks:
                raise
            fallback_payload = dict(payload)
            fallback_payload["stream"] = False
            response = _json_request(endpoint, fallback_payload, request.settings.timeout)
            if not isinstance(response, dict) or "response" not in response:
                raise RuntimeError("Ollama response did not include generated text.")
            chunks = [str(response.get("response") or "")]
            chunk_count = token_budget
        except BaseException:
            raised = True
            raise
        finally:
            if keep_alive == "0s":
                try:
                    progress.phase_start("release")
                    _json_request(endpoint, {"model": request.model, "keep_alive": 0, "stream": False}, request.settings.timeout)
                    progress.phase_done("release")
                except Exception:
                    if not raised:
                        raise

        if chunk_count:
            progress.generation_tokens(chunk_count, max(chunk_count, token_budget))
        progress.phase_done("generate")
        generated_prompt = "".join(chunks).strip()
        return generated_prompt


class PromptProviderRegistry:
    def generate(self, request: PromptEnhancerRequest, progress: PromptEnhancerProgress | None = None) -> str:
        provider = (request.provider or PROVIDER_OLLAMA).strip() or PROVIDER_OLLAMA
        if provider == PROVIDER_OLLAMA:
            return OllamaPromptProvider().generate(request, progress)
        from .local_provider import LocalPromptProvider

        return LocalPromptProvider().generate(request, progress)

    def generate_visual_context(
        self,
        request: PromptEnhancerRequest,
        progress: PromptEnhancerProgress | None = None,
    ) -> str:
        return self.generate(request, progress)

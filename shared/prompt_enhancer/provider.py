from __future__ import annotations

import base64
import io as stdlib_io
import json
import random
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from PIL import Image


DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_MODEL = "llava:latest"
DEFAULT_OLLAMA_KEEP_ALIVE = 5
DEFAULT_OLLAMA_KEEP_ALIVE_UNIT = "minutes"
DEFAULT_OLLAMA_TIMEOUT = 120
MAX_PROMPT_IMAGES = 8
MAX_SEED = 2_147_483_647

PROMPT_TYPES = ("image", "video", "multi scene video")


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


class PromptProvider(Protocol):
    def list_models(self, url: str, timeout: int = DEFAULT_OLLAMA_TIMEOUT) -> list[str]:
        ...

    def generate(self, request: PromptEnhancerRequest) -> str:
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


def normalize_ollama_url(url: str | None) -> str:
    normalized = (url or DEFAULT_OLLAMA_URL).strip().rstrip("/")
    return normalized or DEFAULT_OLLAMA_URL


def ollama_keep_alive(value: int | str | None, unit: str | None) -> str:
    try:
        keep_alive = int(value if value is not None else DEFAULT_OLLAMA_KEEP_ALIVE)
    except (TypeError, ValueError):
        keep_alive = DEFAULT_OLLAMA_KEEP_ALIVE
    unit_value = str(unit or DEFAULT_OLLAMA_KEEP_ALIVE_UNIT).lower()
    suffix = "h" if unit_value.startswith("hour") else "m"
    return f"{keep_alive}{suffix}"


def resolve_seed(seed: int | str | None, rng: random.Random | None = None) -> int:
    try:
        value = int(seed if seed is not None else -1)
    except (TypeError, ValueError):
        value = -1
    if value >= 0:
        return min(value, MAX_SEED)
    generator = rng or random.SystemRandom()
    return generator.randint(0, MAX_SEED)


def build_system_prompt(prompt_type: str, has_video: bool = False, has_audio: bool = False) -> str:
    prompt_kind = prompt_type if prompt_type in PROMPT_TYPES else "image"
    focus = {
        "image": "a single high-quality image generation prompt",
        "video": "a concise video generation prompt with subject, action, camera, lighting, and motion",
        "multi scene video": "a multi-scene video prompt with clear scene beats and visual continuity",
    }[prompt_kind]

    notes = []
    if has_video:
        notes.append("Video input is connected but v1 does not send video bytes to Ollama.")
    if has_audio:
        notes.append("Audio input is connected but v1 does not send audio bytes to Ollama.")
    media_note = "\n".join(notes) if notes else "Only connected image tensors are sent as visual context."

    return (
        "You are a prompt enhancement assistant for ComfyUI.\n"
        f"Create {focus} from the user request and any attached images.\n"
        "Return only the final enhanced prompt. Do not include explanations, markdown, headings, or quotes.\n"
        "Preserve important user intent while adding concrete visual detail, composition, style, and constraints.\n"
        f"{media_note}"
    )


def _sample_indices(count: int, limit: int = MAX_PROMPT_IMAGES) -> list[int]:
    if count <= 0:
        return []
    if count <= limit:
        return list(range(count))
    if limit <= 1:
        return [0]
    return [round(index * (count - 1) / (limit - 1)) for index in range(limit)]


def encode_images_for_ollama(images: Any, limit: int = MAX_PROMPT_IMAGES) -> list[str]:
    if images is None:
        return []

    try:
        count = int(len(images))
    except Exception:
        return []

    encoded: list[str] = []
    for index in _sample_indices(count, limit):
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

    def generate(self, request: PromptEnhancerRequest) -> str:
        endpoint = urllib.parse.urljoin(f"{normalize_ollama_url(request.settings.ollama_url)}/", "api/generate")
        payload: dict[str, Any] = {
            "model": request.model,
            "system": request.system_prompt,
            "prompt": request.prompt,
            "stream": False,
            "keep_alive": ollama_keep_alive(request.settings.keep_alive, request.settings.keep_alive_unit),
            "options": {"seed": request.seed},
        }
        if request.images:
            payload["images"] = request.images

        response = _json_request(endpoint, payload, request.settings.timeout)
        if not isinstance(response, dict) or "response" not in response:
            raise RuntimeError("Ollama response did not include generated text.")
        return str(response.get("response") or "").strip()

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

IMAGE_SYSTEM_PROMPT = """You are an expert prompt enhancer for ComfyUI image generation workflows.

Your task is to transform the user's text instruction, and any optional provided image references, into one optimized image-generation prompt.

You are not generating an image. You only output the final enhanced prompt.

## Core behavior

Create a clear, detailed, visually rich prompt that improves the user's original request while preserving their intent.

Use the user's instruction as the highest priority source of truth.

If images are provided, analyze them only in relation to the user's request. Use the images as visual reference material, not as something to describe blindly.

If no images are provided, rely entirely on the user's text and expand it into a high-quality image prompt.

Do not ask questions. Make the best possible interpretation from the available text and images.

Do not explain what you are doing.

Do not output markdown, headings, bullets, comments, alternatives, or analysis.

Output only the final optimized prompt.

## Image handling

When one or more images are provided, decide how they should influence the prompt based on the user's instruction.

If the user asks to preserve, use, reference, match, continue, restyle, edit, or base the result on the image, then include relevant visual details from the image.

If the user provides images of people as references, describe the people in useful visual detail, including:

* apparent age range
* face shape
* skin tone
* hair color, length, and style
* facial hair if present
* glasses or distinctive accessories
* build and body type
* clothing and outfit details
* visible pose, expression, and attitude
* distinctive but respectful identifying visual traits

When describing people, avoid guessing identity, name, ethnicity, nationality, profession, personality, or private traits unless the user explicitly provides them.

If the user asks to change something about a person's appearance, the user's requested change overrides the image. For example, if the image shows short hair but the user asks for long hair, describe long hair in the final prompt.

If multiple reference images are provided, combine them according to the user's request:

* If images show the same subject, preserve consistency across them.
* If images show different subjects, describe each subject separately and clearly.
* If images provide different elements, such as character, pose, outfit, background, lighting, or style, use each image for its intended role.

Do not mention "the reference image" unless it helps the downstream image model. Prefer direct visual descriptions.

## Text-only handling

If no image is provided, create an optimized prompt from the user's text.

Preserve the subject, action, setting, mood, style, composition, and important constraints from the user.

Expand missing details only when they naturally support the request.

Add useful artistic and photographic details such as:

* subject description
* environment
* composition
* camera angle
* lens or focal length when appropriate
* lighting
* mood
* color palette
* texture and material details
* depth of field
* cinematic or photographic style
* realism level
* image quality descriptors

Do not add random elements that change the user's intent.

## Detail expansion

When the user asks for a "detailed prompt", "improve this", "make it better", "enhance", or gives a minimal idea, enrich the scene with tasteful, coherent details.

Add details that improve visual quality, clarity, composition, and model guidance.

Prefer concrete visual language over abstract adjectives.

Weak:
beautiful, amazing, awesome, cool

Better:
soft golden-hour rim light, shallow depth of field, natural skin texture, polished wooden table, rain-slick street reflecting neon signs, cinematic 50mm eye-level composition

## Prompt quality rules

The final prompt should be specific, visual, and directly usable in an image-generation node.

Use natural language, not keyword spam.

Avoid contradictions.

Avoid overloading the prompt with too many unrelated styles.

Avoid vague filler.

Avoid excessive repetition.

Keep the prompt focused on what should appear in the image.

Use present tense.

Prefer positive descriptions of what should be generated.

If the user requests a known style, genre, camera look, artistic medium, or rendering style, incorporate it clearly.

If the user requests realism, emphasize realistic anatomy, natural proportions, believable lighting, accurate hands, realistic skin texture, and physically plausible materials.

If the user requests a cinematic look, include shot type, camera angle, lighting direction, atmosphere, lens feel, and composition.

If the user requests product, architecture, UI, character design, concept art, fashion, food, landscape, or portrait imagery, adapt the prompt to that domain.

## Person and character consistency

For people and characters, make the prompt consistent and unambiguous.

Describe each person once in a compact but detailed way.

Use stable references such as "the man", "the woman", "the older man", "the young woman", "the character", or names only if the user provided them.

If the user wants likeness preserved from an image, include:
preserve the same facial structure, hairstyle, skin tone, build, expression style, and recognizable visual features while adapting only the requested changes.

If the user changes clothing, pose, setting, age appearance, hairstyle, or mood, apply the change clearly.

Do not sexualize people unless the user explicitly requests an adult, allowed, non-exploitative style. Keep the prompt respectful and non-explicit by default.

## Composition and camera guidance

When useful, include:

* shot type: close-up, portrait, medium shot, full-body shot, wide shot, establishing shot
* camera angle: eye-level, low angle, high angle, over-the-shoulder, three-quarter view
* lens feel: 35mm, 50mm, 85mm portrait lens, macro lens, telephoto compression
* framing: centered composition, rule of thirds, symmetrical framing, leading lines
* focus: sharp subject focus, shallow depth of field, background bokeh
* lighting: softbox, golden hour, diffused daylight, neon glow, moonlight, volumetric light, rim light
* atmosphere: mist, rain, dust, smoke, warm interior glow, cinematic haze

Only include camera and lens details when they improve the request.

## Style handling

Match the user's desired style.

Examples:

* photorealistic
* cinematic
* editorial fashion photography
* documentary photography
* fantasy concept art
* anime style
* watercolor illustration
* oil painting
* 3D render
* isometric design
* cyberpunk
* noir
* vintage film
* luxury commercial photography

If no style is specified, choose a style that best fits the request, usually high-quality photorealistic or cinematic realism unless the subject suggests otherwise.

## Output format

Output one single enhanced prompt.

Do not include a negative prompt unless the user explicitly asks for one.

Do not include parameter syntax unless the user explicitly asks for a specific model format.

Do not include explanations, comments, options, or notes.

Do not say "Here is the enhanced prompt".

Only output the prompt itself.

## Safety and realism defaults

Unless the user requests otherwise, avoid:

* nudity
* explicit sexual content
* graphic violence
* hateful or degrading content
* exploitative depictions
* illegal activity instructions
* identifying private people beyond visible image features
* claiming real identity from an image

For realistic people, include:
natural anatomy, realistic hands, believable facial expression, accurate proportions, coherent lighting, realistic skin texture.

## Final instruction

Always produce the strongest possible image-generation prompt from the user's text and optional image references, preserving user intent, applying requested changes over image details, and adding coherent visual detail that improves the final image."""


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
    if prompt_kind == "image":
        return IMAGE_SYSTEM_PROMPT

    focus = {
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

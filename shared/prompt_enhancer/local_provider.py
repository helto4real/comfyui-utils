from __future__ import annotations

import base64
import gc
import importlib.util
import io
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from PIL import Image

from .progress import PromptEnhancerProgress
from .provider import DEFAULT_OLLAMA_KEEP_ALIVE, DEFAULT_OLLAMA_KEEP_ALIVE_UNIT, ollama_keep_alive, ollama_model_supports_images

try:
    import folder_paths
except Exception:  # noqa: BLE001 - tests can import outside ComfyUI.
    folder_paths = None


PROVIDER_LOCAL_TRANSFORMERS = "local_transformers_vlm"
PROVIDER_LOCAL_LLAMA_CPP = "local_llama_cpp_vlm"
PROVIDER_LOCAL_TEXT_GENERATOR = "local_text_generator"
PROVIDER_FALLBACK = "fallback"

QWEN_DEPS = ("transformers", "huggingface_hub", "accelerate", "qwen_vl_utils")
FLORENCE_DEPS = ("transformers", "huggingface_hub", "accelerate", "torchvision")
LLAMA_CPP_DEPS = ("llama_cpp", "huggingface_hub")
GEMMA_SAFETENSORS_DEPS = ("transformers", "huggingface_hub", "accelerate")

GEMMA4_E4B_FP8_URL = (
    "https://huggingface.co/Comfy-Org/gemma-4/blob/main/"
    "text_encoders/gemma4_e4b_it_fp8_scaled.safetensors"
)
GEMMA4_E4B_UNCENSORED_Q8_GGUF_URL = (
    "https://huggingface.co/HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/blob/main/"
    "Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf"
)
GEMMA4_E4B_UNCENSORED_MMPROJ_URL = (
    "https://huggingface.co/HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive/blob/main/"
    "mmproj-Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-f16.gguf"
)

CONFIG_DIR = Path(__file__).resolve().parents[2] / "config" / "prompt enhancer"
PROVIDER_SETTINGS_FILE = CONFIG_DIR / "provider_settings.json"
LOCAL_GENERATION_TOKENS = 180


@dataclass(frozen=True)
class LocalModelSpec:
    alias: str
    repo_id: str
    provider: str
    backend: str
    model_subdir: str
    dependencies: tuple[str, ...] = ()
    file_urls: tuple[str, ...] = ()
    supports_images: bool = False
    generator_supported: bool = True


@dataclass(frozen=True)
class LocalModelFile:
    url: str
    repo_id: str
    revision: str
    filename: str


class LocalProviderError(RuntimeError):
    """Readable local-provider error surfaced through the node/UI."""


MODEL_REGISTRY: dict[str, LocalModelSpec] = {
    "qwen3_vl_8b_quality": LocalModelSpec(
        "qwen3_vl_8b_quality",
        "Qwen/Qwen3-VL-8B-Instruct",
        PROVIDER_LOCAL_TRANSFORMERS,
        "qwen",
        "VLM",
        QWEN_DEPS,
        supports_images=True,
    ),
    "qwen3_vl_4b_fast": LocalModelSpec(
        "qwen3_vl_4b_fast",
        "Qwen/Qwen3-VL-4B-Instruct",
        PROVIDER_LOCAL_TRANSFORMERS,
        "qwen",
        "VLM",
        QWEN_DEPS,
        supports_images=True,
    ),
    "qwen3_vl_4b_unredacted": LocalModelSpec(
        "qwen3_vl_4b_unredacted",
        "prithivMLmods/Qwen3-VL-4B-Instruct-abliterated-v1",
        PROVIDER_LOCAL_TRANSFORMERS,
        "qwen",
        "VLM",
        QWEN_DEPS,
        supports_images=True,
    ),
    "qwen3_vl_8b_nsfw_caption": LocalModelSpec(
        "qwen3_vl_8b_nsfw_caption",
        "monkeyslikebananas/Qwen3-VL-8B-NSFW-Caption-V4.5",
        PROVIDER_LOCAL_TRANSFORMERS,
        "qwen",
        "VLM",
        QWEN_DEPS,
        supports_images=True,
    ),
    "florence2_fast_caption": LocalModelSpec(
        "florence2_fast_caption",
        "MiaoshouAI/Florence-2-base-PromptGen-v2.0",
        PROVIDER_LOCAL_TRANSFORMERS,
        "florence",
        "LLM",
        FLORENCE_DEPS,
        supports_images=True,
    ),
    "gemma4_e4b_uncensored_gguf_q8": LocalModelSpec(
        "gemma4_e4b_uncensored_gguf_q8",
        "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive",
        PROVIDER_LOCAL_LLAMA_CPP,
        "llama_cpp_vision",
        "VLM/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive",
        LLAMA_CPP_DEPS,
        (GEMMA4_E4B_UNCENSORED_Q8_GGUF_URL, GEMMA4_E4B_UNCENSORED_MMPROJ_URL),
        supports_images=True,
    ),
    "gemma4_e4b_it_fp8_scaled": LocalModelSpec(
        "gemma4_e4b_it_fp8_scaled",
        "Comfy-Org/gemma-4",
        PROVIDER_LOCAL_TEXT_GENERATOR,
        "gemma_safetensors",
        "text_encoders",
        GEMMA_SAFETENSORS_DEPS,
        (GEMMA4_E4B_FP8_URL,),
        generator_supported=False,
    ),
    "fallback_text_backend": LocalModelSpec(
        "fallback_text_backend",
        "local/fallback-text-backend",
        PROVIDER_FALLBACK,
        "fallback",
        "",
    ),
}

_LOADED_MODELS: dict[str, dict[str, Any]] = {}


def settings_path(base_dir: str | os.PathLike[str] | None = None) -> Path:
    return Path(base_dir) / PROVIDER_SETTINGS_FILE.name if base_dir is not None else PROVIDER_SETTINGS_FILE


def _write_private_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    try:
        os.chmod(tmp_path, 0o600)
    except OSError:
        pass
    tmp_path.replace(path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def load_provider_settings(base_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    path = settings_path(base_dir)
    if not path.exists():
        return {"version": 1, "hf_token": ""}
    try:
        payload = json.loads(path.read_text(encoding="utf-8") or "{}")
    except Exception:
        return {"version": 1, "hf_token": ""}
    return {"version": 1, "hf_token": str(payload.get("hf_token") or "")}


def save_hf_token(token: str, base_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    token = str(token or "").strip()
    if not token:
        return clear_hf_token(base_dir)
    _write_private_json(settings_path(base_dir), {"version": 1, "hf_token": token})
    return provider_settings_status(base_dir)


def clear_hf_token(base_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    settings_path(base_dir).unlink(missing_ok=True)
    return provider_settings_status(base_dir)


def env_hf_token() -> str:
    return str(os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN") or "").strip()


def configured_hf_token(base_dir: str | os.PathLike[str] | None = None) -> str:
    return str(load_provider_settings(base_dir).get("hf_token") or "").strip()


def hf_auth_token(base_dir: str | os.PathLike[str] | None = None) -> str | None:
    return configured_hf_token(base_dir) or env_hf_token() or None


def provider_settings_status(base_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    configured = bool(configured_hf_token(base_dir))
    env_available = bool(env_hf_token())
    if configured:
        auth_source = "configured"
    elif env_available:
        auth_source = "environment"
    else:
        auth_source = "anonymous"
    return {
        "ok": True,
        "configPath": str(settings_path(base_dir)),
        "tokenConfigured": configured,
        "envTokenAvailable": env_available,
        "authSource": auth_source,
    }


def _models_dir() -> Path:
    if folder_paths is not None and getattr(folder_paths, "models_dir", None):
        return Path(folder_paths.models_dir)
    return Path.cwd() / "models"


def parse_hf_file_url(url: str) -> LocalModelFile:
    parsed = urlparse(str(url or "").strip())
    parts = [unquote(part) for part in parsed.path.split("/") if part]
    if parsed.netloc != "huggingface.co" or len(parts) < 5 or parts[2] != "blob":
        raise LocalProviderError(f"Unsupported Hugging Face file URL: {url}")
    filename = "/".join(parts[4:])
    if not filename:
        raise LocalProviderError(f"Hugging Face file URL is missing a filename: {url}")
    return LocalModelFile(
        url=url,
        repo_id=f"{parts[0]}/{parts[1]}",
        revision=parts[3],
        filename=filename,
    )


def model_files_for(spec: LocalModelSpec) -> list[LocalModelFile]:
    return [parse_hf_file_url(url) for url in spec.file_urls]


def model_file_path_for(spec: LocalModelSpec, model_file: LocalModelFile) -> Path:
    if spec.backend == "gemma_safetensors":
        return _models_dir() / model_file.filename
    return _models_dir() / spec.model_subdir / model_file.filename


def model_file_paths_for(spec: LocalModelSpec) -> list[Path]:
    return [model_file_path_for(spec, model_file) for model_file in model_files_for(spec)]


def model_path_for(spec: LocalModelSpec) -> Path | None:
    if spec.backend == "fallback":
        return None
    if spec.file_urls:
        paths = model_file_paths_for(spec)
        if spec.backend == "gemma_safetensors":
            return paths[0] if paths else None
        return _models_dir() / spec.model_subdir
    return _models_dir() / spec.model_subdir / spec.repo_id.rsplit("/", 1)[-1]


def model_downloaded(spec: LocalModelSpec) -> bool:
    if spec.backend == "fallback":
        return True
    if spec.file_urls:
        paths = model_file_paths_for(spec)
        return bool(paths) and all(path.exists() for path in paths)
    path = model_path_for(spec)
    return bool(path and path.exists())


def missing_dependencies(spec: LocalModelSpec) -> list[str]:
    return [name for name in spec.dependencies if importlib.util.find_spec(name) is None]


def resolve_local_model(alias: str | None) -> LocalModelSpec:
    key = alias or "fallback_text_backend"
    if key not in MODEL_REGISTRY:
        raise LocalProviderError(f"Unknown Prompt Enhancer local model: {key}")
    return MODEL_REGISTRY[key]


def local_model_statuses() -> list[dict[str, Any]]:
    models = []
    for spec in MODEL_REGISTRY.values():
        path = model_path_for(spec)
        missing = missing_dependencies(spec)
        downloaded = model_downloaded(spec)
        if not spec.generator_supported:
            status = "unsupported_generator"
        elif spec.backend == "fallback":
            status = "ready"
        elif missing:
            status = "missing_dependencies"
        elif downloaded:
            status = "downloaded"
        else:
            status = "not_downloaded"
        models.append(
            {
                "provider": spec.provider,
                "model_id": spec.alias,
                "alias": spec.alias,
                "label": spec.alias,
                "repo_id": spec.repo_id,
                "backend": spec.backend,
                "downloaded": downloaded,
                "loaded": spec.alias in _LOADED_MODELS,
                "local_path": str(path) if path else "",
                "file_urls": list(spec.file_urls),
                "local_files": [str(file_path) for file_path in model_file_paths_for(spec)] if spec.file_urls else [],
                "missing_dependencies": missing,
                "supports_images": spec.supports_images,
                "generator_supported": spec.generator_supported,
                "status": status,
            }
        )
    return models


def provider_catalog(ollama_models: list[str] | None = None, ollama_error: str = "") -> dict[str, Any]:
    models = [
        {
            "provider": "ollama",
            "model_id": str(model),
            "alias": str(model),
            "label": str(model),
            "repo_id": "",
            "backend": "ollama",
            "downloaded": True,
            "loaded": False,
            "local_path": "",
            "file_urls": [],
            "local_files": [],
            "missing_dependencies": [],
            "supports_images": ollama_model_supports_images(str(model)),
            "generator_supported": True,
            "status": "remote",
        }
        for model in (ollama_models or [])
        if str(model or "").strip()
    ]
    models.extend(local_model_statuses())
    return {
        "ok": True,
        "providers": [
            {"id": "ollama", "label": "Ollama"},
            {"id": PROVIDER_LOCAL_TRANSFORMERS, "label": "Local Transformers VLM"},
            {"id": PROVIDER_LOCAL_LLAMA_CPP, "label": "Local llama.cpp VLM"},
            {"id": PROVIDER_LOCAL_TEXT_GENERATOR, "label": "Local text generator"},
            {"id": PROVIDER_FALLBACK, "label": "Fallback"},
        ],
        "models": models,
        "ollama_error": ollama_error,
    }


def ensure_model_downloaded(spec: LocalModelSpec, progress: PromptEnhancerProgress | None = None) -> Path | None:
    path = model_path_for(spec)
    if path is None:
        if progress is not None:
            progress.phase_done("download")
        return None
    if model_downloaded(spec):
        if progress is not None:
            progress.phase_done("download")
        return path
    missing = missing_dependencies(spec)
    if missing:
        raise LocalProviderError(f"Model '{spec.alias}' requires optional packages: {', '.join(missing)}")
    try:
        from huggingface_hub import hf_hub_download, snapshot_download
    except Exception as exc:  # noqa: BLE001
        raise LocalProviderError("Local model downloads require optional package: huggingface_hub") from exc

    if spec.file_urls:
        files = list(zip(model_files_for(spec), model_file_paths_for(spec), strict=True))
        for position, (model_file, target_path) in enumerate(files, start=1):
            if target_path.exists():
                if progress is not None:
                    progress.phase_fraction("download", position / len(files))
                continue
            target_path.parent.mkdir(parents=True, exist_ok=True)
            local_dir = _models_dir() if spec.backend == "gemma_safetensors" else (_models_dir() / spec.model_subdir)
            local_dir.mkdir(parents=True, exist_ok=True)
            hf_hub_download(
                repo_id=model_file.repo_id,
                filename=model_file.filename,
                revision=model_file.revision,
                local_dir=str(local_dir),
                local_dir_use_symlinks=False,
                token=hf_auth_token(),
            )
            if not target_path.exists():
                raise LocalProviderError(f"Downloaded '{model_file.url}' but expected file was not found at {target_path}")
            if progress is not None:
                progress.phase_fraction("download", position / len(files))
        return path

    path.parent.mkdir(parents=True, exist_ok=True)
    if progress is not None:
        progress.phase_start("download")
    snapshot_download(
        repo_id=spec.repo_id,
        local_dir=str(path),
        local_dir_use_symlinks=False,
        token=hf_auth_token(),
    )
    if progress is not None:
        progress.phase_done("download")
    return path


def download_local_model(alias: str | None) -> dict[str, Any]:
    spec = resolve_local_model(alias)
    if not spec.generator_supported:
        raise LocalProviderError(f"Model '{spec.alias}' is not a standalone prompt-generating model.")
    path = ensure_model_downloaded(spec)
    return {"ok": True, "model": spec.alias, "local_path": str(path) if path else "", "models": local_model_statuses()}


def unload_local_model(alias: str | None = None) -> dict[str, Any]:
    keys = [resolve_local_model(alias).alias] if alias else list(_LOADED_MODELS.keys())
    unloaded = []
    torch_modules = []
    for key in keys:
        loaded = _LOADED_MODELS.pop(key, None)
        if not loaded:
            continue
        unloaded.append(key)
        torch_module = loaded.get("torch")
        if torch_module is not None:
            torch_modules.append(torch_module)
        loaded.clear()

    gc.collect()
    for torch_module in torch_modules:
        _clear_torch_cuda_cache(torch_module)
    return {"ok": True, "unloaded": unloaded, "models": local_model_statuses()}


def _clear_torch_cuda_cache(torch_module: Any) -> None:
    cuda = getattr(torch_module, "cuda", None)
    try:
        if cuda is not None and callable(getattr(cuda, "is_available", None)) and cuda.is_available():
            cuda.empty_cache()
            ipc_collect = getattr(cuda, "ipc_collect", None)
            if callable(ipc_collect):
                ipc_collect()
    except Exception:
        pass


def local_vram_preflight() -> None:
    try:
        import comfy.model_management as model_management  # type: ignore[import-not-found]
    except Exception:
        model_management = None
    if model_management is not None:
        for hook_name in ("unload_all_models", "cleanup_models", "soft_empty_cache"):
            hook = getattr(model_management, hook_name, None)
            if callable(hook):
                try:
                    hook()
                except Exception:
                    pass
    gc.collect()
    try:
        import torch

        _clear_torch_cuda_cache(torch)
    except Exception:
        pass


def _decode_base64_image(encoded: str) -> Image.Image | None:
    try:
        with Image.open(io.BytesIO(base64.b64decode(str(encoded)))) as image:
            return image.convert("RGB")
    except Exception:
        return None


def decode_request_images(images: list[str]) -> list[Image.Image]:
    decoded = []
    for encoded in images or []:
        image = _decode_base64_image(encoded)
        if image is not None:
            decoded.append(image)
    return decoded


def _image_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _instruction(system_prompt: str, prompt: str) -> str:
    return f"{str(system_prompt or '').strip()}\n\nUser prompt:\n{str(prompt or '').strip()}".strip()


def clean_prompt_text(value: Any) -> str:
    import re

    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r"^(prompt|caption|description)\s*:\s*", "", text, flags=re.I).strip()
    return text.strip(" \t\r\n\"'")


def fallback_enhance_prompt(prompt: str, prompt_type: str = "image") -> str:
    text = clean_prompt_text(prompt)
    if not text:
        return ""
    if prompt_type == "multi scene video":
        suffix = "multi-scene video prompt with clear chronology, motion, camera direction, and transitions"
    elif prompt_type == "video":
        suffix = "video prompt with present-tense action, camera movement, temporal motion, and sound cues"
    else:
        suffix = "image prompt with concrete subject, composition, lighting, visual style, and atmosphere"
    return clean_prompt_text(f"{text}. Refined as a {suffix}.")


class LocalPromptProvider:
    def generate(self, request: Any, progress: PromptEnhancerProgress | None = None) -> str:
        spec = resolve_local_model(getattr(request, "model_id", "") or getattr(request, "model", ""))
        if not spec.generator_supported:
            raise LocalProviderError(
                f"Model '{spec.alias}' is a ComfyUI text-encoder checkpoint, not a standalone prompt-generating model."
            )
        if spec.backend == "fallback":
            if progress is not None:
                progress.phase_done("download")
                progress.phase_done("load")
                progress.phase_start("generate")
                progress.phase_done("generate")
            result = fallback_enhance_prompt(getattr(request, "prompt", ""), getattr(request, "prompt_type", "image"))
            _release_local_model_if_needed(spec, request, progress)
            return result

        path = ensure_model_downloaded(spec, progress)
        if path is None:
            if progress is not None:
                progress.phase_done("load")
                progress.phase_start("generate")
                progress.phase_done("generate")
            result = fallback_enhance_prompt(getattr(request, "prompt", ""), getattr(request, "prompt_type", "image"))
            _release_local_model_if_needed(spec, request, progress)
            return result
        if progress is not None:
            progress.phase_start("load")
        local_vram_preflight()
        instruction = _instruction(getattr(request, "system_prompt", ""), getattr(request, "prompt", ""))
        images = decode_request_images(getattr(request, "images", []) or [])
        if spec.backend == "qwen":
            result = clean_prompt_text(_generate_qwen(spec, path, images, instruction, progress))
            _release_local_model_if_needed(spec, request, progress)
            return result
        if spec.backend == "florence":
            if not images:
                if progress is not None:
                    progress.phase_done("load")
                    progress.phase_start("generate")
                    progress.phase_done("generate")
                result = fallback_enhance_prompt(getattr(request, "prompt", ""), getattr(request, "prompt_type", "image"))
                _release_local_model_if_needed(spec, request, progress)
                return result
            result = clean_prompt_text(_generate_florence(spec, path, images[0], instruction, progress))
            _release_local_model_if_needed(spec, request, progress)
            return result
        if spec.backend == "llama_cpp_vision":
            result = clean_prompt_text(_generate_llama_cpp_vision(spec, path, images, instruction, progress))
            _release_local_model_if_needed(spec, request, progress)
            return result
        raise LocalProviderError(f"Unsupported local Prompt Enhancer backend: {spec.backend}")


def _release_local_model_if_needed(
    spec: LocalModelSpec,
    request: Any,
    progress: PromptEnhancerProgress | None = None,
) -> None:
    settings = getattr(request, "settings", None)
    keep_alive = ollama_keep_alive(
        getattr(settings, "keep_alive", DEFAULT_OLLAMA_KEEP_ALIVE),
        getattr(settings, "keep_alive_unit", DEFAULT_OLLAMA_KEEP_ALIVE_UNIT),
    )
    if keep_alive != "0s":
        return
    if progress is not None:
        progress.phase_start("release")
    if spec.alias in _LOADED_MODELS:
        unload_local_model(spec.alias)
    if progress is not None:
        progress.phase_done("release")


def _load_qwen_model(spec: LocalModelSpec, path: Path) -> dict[str, Any]:
    if spec.alias in _LOADED_MODELS:
        return _LOADED_MODELS[spec.alias]
    import torch
    from transformers import AutoProcessor

    try:
        from transformers import Qwen3VLForConditionalGeneration

        model_cls = Qwen3VLForConditionalGeneration if "Qwen3-VL" in spec.repo_id else None
    except Exception:  # noqa: BLE001
        model_cls = None
    if model_cls is None:
        from transformers import AutoModelForVision2Seq

        model_cls = AutoModelForVision2Seq

    model = model_cls.from_pretrained(
        str(path),
        torch_dtype="auto",
        device_map="auto",
        attn_implementation="sdpa",
    ).eval()
    processor = AutoProcessor.from_pretrained(str(path), trust_remote_code=True)
    loaded = {"model": model, "processor": processor, "torch": torch}
    _LOADED_MODELS[spec.alias] = loaded
    return loaded


def _generate_qwen(
    spec: LocalModelSpec,
    path: Path,
    images: list[Image.Image],
    instruction: str,
    progress: PromptEnhancerProgress | None = None,
) -> str:
    loaded = _load_qwen_model(spec, path)
    if progress is not None:
        progress.phase_done("load")
        progress.phase_start("generate")
    model = loaded["model"]
    processor = loaded["processor"]
    torch = loaded["torch"]
    content: list[dict[str, Any]] = []
    for index, image in enumerate(images, start=1):
        content.append({"type": "text", "text": f"Reference image {index}:"})
        content.append({"type": "image", "image": image})
    content.append({"type": "text", "text": instruction})
    chat = processor.apply_chat_template([{"role": "user", "content": content}], tokenize=False, add_generation_prompt=True)
    inputs = processor(text=[chat], images=images or None, padding=True, return_tensors="pt")
    device = next(model.parameters()).device
    model_inputs = {key: value.to(device) if torch.is_tensor(value) else value for key, value in inputs.items()}
    input_len = model_inputs["input_ids"].shape[-1]
    stopping_criteria = _generation_progress_criteria(progress, input_len, LOCAL_GENERATION_TOKENS)
    generate_kwargs = {
        **model_inputs,
        "max_new_tokens": LOCAL_GENERATION_TOKENS,
        "do_sample": False,
        "repetition_penalty": 1.05,
    }
    if stopping_criteria is not None:
        generate_kwargs["stopping_criteria"] = stopping_criteria
    outputs = model.generate(**generate_kwargs)
    if progress is not None:
        progress.phase_done("generate")
    return processor.batch_decode(outputs[:, input_len:], skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]


def _load_florence_model(spec: LocalModelSpec, path: Path) -> dict[str, Any]:
    if spec.alias in _LOADED_MODELS:
        return _LOADED_MODELS[spec.alias]
    import torch
    from transformers import AutoModelForCausalLM, AutoProcessor

    model = AutoModelForCausalLM.from_pretrained(str(path), trust_remote_code=True, torch_dtype="auto").eval()
    if torch.cuda.is_available():
        model = model.to("cuda")
    processor = AutoProcessor.from_pretrained(str(path), trust_remote_code=True)
    loaded = {"model": model, "processor": processor, "torch": torch}
    _LOADED_MODELS[spec.alias] = loaded
    return loaded


def _generate_florence(
    spec: LocalModelSpec,
    path: Path,
    image: Image.Image,
    instruction: str,
    progress: PromptEnhancerProgress | None = None,
) -> str:
    loaded = _load_florence_model(spec, path)
    if progress is not None:
        progress.phase_done("load")
        progress.phase_start("generate")
    model = loaded["model"]
    processor = loaded["processor"]
    torch = loaded["torch"]
    inputs = processor(text=instruction, images=image, return_tensors="pt")
    device = next(model.parameters()).device
    inputs = {key: value.to(device) if torch.is_tensor(value) else value for key, value in inputs.items()}
    input_ids = inputs.get("input_ids")
    input_len = int(input_ids.shape[-1]) if input_ids is not None and hasattr(input_ids, "shape") else 0
    stopping_criteria = _generation_progress_criteria(progress, input_len, LOCAL_GENERATION_TOKENS)
    generate_kwargs = {**inputs, "max_new_tokens": LOCAL_GENERATION_TOKENS, "do_sample": False}
    if stopping_criteria is not None:
        generate_kwargs["stopping_criteria"] = stopping_criteria
    outputs = model.generate(**generate_kwargs)
    if progress is not None:
        progress.phase_done("generate")
    return processor.batch_decode(outputs, skip_special_tokens=True)[0]


def _generation_progress_criteria(
    progress: PromptEnhancerProgress | None,
    prompt_token_count: int,
    max_new_tokens: int,
) -> Any | None:
    if progress is None:
        return None
    try:
        from transformers import StoppingCriteria, StoppingCriteriaList
    except Exception:
        return None

    class ProgressCriteria(StoppingCriteria):
        def __call__(self, input_ids, scores, **kwargs):  # noqa: ANN001, ANN003
            try:
                generated = max(0, int(input_ids.shape[-1]) - int(prompt_token_count))
            except Exception:
                generated = 0
            progress.generation_tokens(generated, max_new_tokens)
            return False

    return StoppingCriteriaList([ProgressCriteria()])


def _llama_cpp_model_paths(spec: LocalModelSpec, path: Path) -> tuple[Path, Path]:
    ggufs = sorted(path.glob("*.gguf")) if path.exists() else []
    model_path = next((item for item in ggufs if "mmproj" not in item.name.lower()), None)
    mmproj_path = next((item for item in ggufs if "mmproj" in item.name.lower()), None)
    if model_path is None or mmproj_path is None:
        raise LocalProviderError(f"Model '{spec.alias}' requires both a main GGUF and an mmproj GGUF in {path}.")
    return model_path, mmproj_path


def _load_llama_cpp_vision_model(spec: LocalModelSpec, path: Path) -> dict[str, Any]:
    if spec.alias in _LOADED_MODELS:
        return _LOADED_MODELS[spec.alias]
    model_path, mmproj_path = _llama_cpp_model_paths(spec, path)
    try:
        from llama_cpp import Llama
        from llama_cpp.llama_chat_format import Llava15ChatHandler
    except Exception as exc:  # noqa: BLE001
        raise LocalProviderError(f"Model '{spec.alias}' requires optional package: llama-cpp-python") from exc

    chat_handler = Llava15ChatHandler(clip_model_path=str(mmproj_path))
    model = Llama(model_path=str(model_path), chat_handler=chat_handler, n_ctx=8192, n_gpu_layers=-1, verbose=False)
    loaded = {"model": model, "chat_handler": chat_handler, "model_path": model_path, "mmproj_path": mmproj_path}
    _LOADED_MODELS[spec.alias] = loaded
    return loaded


def _generate_llama_cpp_vision(
    spec: LocalModelSpec,
    path: Path,
    images: list[Image.Image],
    instruction: str,
    progress: PromptEnhancerProgress | None = None,
) -> str:
    loaded = _load_llama_cpp_vision_model(spec, path)
    if progress is not None:
        progress.phase_done("load")
        progress.phase_start("generate")
    model = loaded["model"]
    content: list[dict[str, Any]] = []
    for index, image in enumerate(images, start=1):
        content.append({"type": "text", "text": f"Reference image {index}:"})
        content.append({"type": "image_url", "image_url": {"url": _image_data_url(image)}})
    content.append({"type": "text", "text": instruction})
    payload = {
        "messages": [{"role": "user", "content": content}],
        "max_tokens": LOCAL_GENERATION_TOKENS,
        "temperature": 0.2,
        "top_p": 0.95,
    }
    if progress is not None:
        chunks: list[str] = []
        try:
            for item in model.create_chat_completion(**payload, stream=True):
                text = _llama_cpp_chunk_text(item)
                if text:
                    chunks.append(text)
                    progress.generation_step(LOCAL_GENERATION_TOKENS)
            progress.phase_done("generate")
            return "".join(chunks)
        except Exception:
            if chunks:
                raise
    response = model.create_chat_completion(**payload)
    if progress is not None:
        progress.phase_done("generate")
    choices = response.get("choices") if isinstance(response, dict) else None
    if choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                return str(message.get("content") or "")
            return str(first.get("text") or "")
    return str(response or "")


def _llama_cpp_chunk_text(item: Any) -> str:
    choices = item.get("choices") if isinstance(item, dict) else None
    if not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if isinstance(delta, dict):
        return str(delta.get("content") or "")
    return str(first.get("text") or "")

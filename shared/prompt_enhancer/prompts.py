from __future__ import annotations

from pathlib import Path


PACKAGE_DIR = Path(__file__).resolve().parents[2]
DEFAULT_PROMPT_DIR = Path(__file__).resolve().parent / "defaults"
USER_PROMPT_DIR = PACKAGE_DIR / "config" / "prompt enhancer"

PROMPT_FILES = {
    "image": "image_system_prompt.txt",
    "video": "video_system_prompt.txt",
}

VIDEO_FOCUS = {
    "video": "a concise video generation prompt with subject, action, camera, lighting, and motion",
    "multi scene video": "a multi-scene video prompt with clear scene beats and visual continuity",
}

DEFAULT_VIDEO_PROMPT_VALUES = {
    "rating": "SFW",
    "segment_index": 1,
    "segment_total": 1,
    "direction": "",
    "continuity": "",
    "reference_mode": "none",
    "image_notes": "",
    "style": "",
    "camera": "",
    "duration": "",
    "continuity_mode": "",
    "start_image_description": "",
    "end_guidance_image_description": "",
    "character_reference_description": "",
    "style_reference_description": "",
}


def normalize_prompt_kind(kind: str | None) -> str:
    prompt_kind = str(kind or "").strip().lower()
    if prompt_kind not in PROMPT_FILES:
        raise ValueError("Unknown system prompt kind.")
    return prompt_kind


def default_prompt_path(kind: str) -> Path:
    return DEFAULT_PROMPT_DIR / PROMPT_FILES[normalize_prompt_kind(kind)]


def user_prompt_path(kind: str) -> Path:
    return USER_PROMPT_DIR / PROMPT_FILES[normalize_prompt_kind(kind)]


def load_default_system_prompt(kind: str) -> str:
    return default_prompt_path(kind).read_text(encoding="utf-8")


def load_user_system_prompt(kind: str) -> str | None:
    prompt_kind = normalize_prompt_kind(kind)
    override_path = user_prompt_path(prompt_kind)
    if override_path.exists():
        try:
            prompt = override_path.read_text(encoding="utf-8")
            if prompt.strip():
                return prompt
        except OSError:
            pass
    return None


def load_system_prompt(kind: str) -> str:
    prompt_kind = normalize_prompt_kind(kind)
    return load_user_system_prompt(prompt_kind) or load_default_system_prompt(prompt_kind)


def system_prompt_payload(kind: str) -> dict[str, object]:
    prompt_kind = normalize_prompt_kind(kind)
    user_prompt = load_user_system_prompt(prompt_kind)
    default_prompt = load_default_system_prompt(prompt_kind)
    return {
        "kind": prompt_kind,
        "prompt": user_prompt or default_prompt,
        "default_prompt": default_prompt,
        "is_default": user_prompt is None,
    }


def save_system_prompt(kind: str, prompt: str | None) -> dict[str, object]:
    prompt_kind = normalize_prompt_kind(kind)
    text = str(prompt or "")
    if not text.strip():
        raise ValueError("System prompt cannot be blank.")
    USER_PROMPT_DIR.mkdir(parents=True, exist_ok=True)
    user_prompt_path(prompt_kind).write_text(text, encoding="utf-8")
    return system_prompt_payload(prompt_kind)


def reset_system_prompt(kind: str) -> dict[str, object]:
    prompt_kind = normalize_prompt_kind(kind)
    override_path = user_prompt_path(prompt_kind)
    if override_path.exists():
        override_path.unlink()
    return system_prompt_payload(prompt_kind)


def render_video_system_prompt(
    prompt_type: str,
    has_video: bool = False,
    has_audio: bool = False,
    prompt_values: dict[str, object] | None = None,
) -> str:
    prompt_kind = prompt_type if prompt_type in VIDEO_FOCUS else "video"
    notes = []
    if has_video:
        notes.append("Video input is connected but is not sent as video bytes to the prompt provider.")
    if has_audio:
        notes.append("Audio input is connected but is not sent as audio bytes to the prompt provider.")
    media_note = "\n".join(notes) if notes else "Only connected image tensors are sent as visual context."
    values = {
        **DEFAULT_VIDEO_PROMPT_VALUES,
        "focus": VIDEO_FOCUS[prompt_kind],
        "media_note": media_note,
    }
    values.update(prompt_values or {})

    template = load_system_prompt("video")
    try:
        return template.format(**values)
    except (KeyError, ValueError):
        return load_default_system_prompt("video").format(**values)

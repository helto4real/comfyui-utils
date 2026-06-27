from __future__ import annotations

import json
from pathlib import Path
from typing import Any


PACKAGE_DIR = Path(__file__).resolve().parents[2]
DEFAULT_PROMPT_DIR = Path(__file__).resolve().parent / "defaults"
USER_PROMPT_DIR = PACKAGE_DIR / "config" / "prompt enhancer"
PRESET_STORE_FILENAME = "system_prompt_presets.json"
DEFAULT_PROMPT_ID = "default"

PROMPT_FILES = {
    "image": "image_system_prompt.txt",
    "video": "video_system_prompt.txt",
}

DEFAULT_PROMPT_NAMES = {
    "image": "Default image",
    "video": "Default video",
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
    "visual_context": "",
    "style": "",
    "camera": "",
    "duration": "",
    "continuity_mode": "",
    "start_image_description": "",
    "end_guidance_image_description": "",
    "character_reference_description": "",
    "segment_policy": "",
    "reference_policy": "",
    "description_policy": "",
    "detail_policy": "",
    "output_policy": "",
    "style_reference_description": "",
}

REFERENCE_ROLE_POLICIES = {
    "start": {
        False: (
            "Use the start image as the opening-state reference. Begin from the visible pose, placement, "
            "setting, and composition when describing the user's action. Do not produce a full static image "
            "description unless needed for action clarity."
        ),
        True: (
            "Describe the full visible opening frame first: environment, background, lighting, composition, "
            "visible subjects, setting, sky, landscape, objects, and important visible details. Then describe "
            "the user's action starting from that exact frame."
        ),
    },
    "end": {
        False: (
            "Use the end image as a target state. Shape the motion so the segment naturally resolves toward "
            "the visible final pose, expression, framing, or scene condition."
        ),
        True: (
            "Describe the visible target final state first, including the subject, setting, and details the "
            "motion should resolve toward. Then describe the action that reaches that state."
        ),
    },
    "character": {
        False: (
            "Use the character image as a reference for consistent visible traits, recognizable appearance, "
            "body language, and expression style. Do not fully describe the reference image."
        ),
        True: (
            "Visually introduce the referenced subject before the action. If this subject is new to the segment, "
            "describe the subject before any action, even in later segments. Then apply the user's requested "
            "action using those visible traits."
        ),
    },
    "style": {
        False: (
            "Use the style image only as visual style guidance: lighting, color, texture, camera feel, and mood. "
            "Do not copy unrelated subject matter."
        ),
        True: (
            "Describe the visible style reference first: lighting, color, texture, camera feel, and mood. "
            "Then apply that style to the user's requested action."
        ),
    },
    "pose": {
        False: (
            "Use the pose image as guidance for body position, gesture, and framing while describing the action."
        ),
        True: (
            "Describe the pose reference first: body position, gesture, framing, and visible movement cues. "
            "Then adapt the user's requested action from that pose."
        ),
    },
    "setting": {
        False: (
            "Use the setting image as context for location, layout, atmosphere, and environmental details while "
            "keeping the action primary."
        ),
        True: (
            "Describe the setting reference first: location, layout, atmosphere, lighting, and important visible "
            "environment details. Then place the user's requested action inside that setting."
        ),
    },
    "motion": {
        False: (
            "Use the motion reference for useful movement, posture, direction, and timing cues while describing "
            "the user's requested action."
        ),
        True: (
            "Describe the motion reference first: posture, direction, timing, and visible movement cues. "
            "Then use those cues to shape the user's requested action."
        ),
    },
}

DESCRIBED_DETAIL_POLICY = (
    "For described people, include visible details such as apparent age range, skin tone, face shape, facial "
    "features, hair, clothing, posture, and expression. If multiple people are central, describe each person "
    "separately with stable labels. For described animals, include coat color, size, ears, tail, face or muzzle, "
    "body shape, posture, and gait. Do not infer identity, ethnicity, or other private traits from images unless "
    "the user explicitly provides them."
)

COMMON_OUTPUT_POLICY = (
    "Output exactly one enhanced video prompt. Use present tense and chronological visible action. Do not include "
    "headings, bullets, explanations, markdown, or quotes around the whole prompt."
)


def normalize_prompt_kind(kind: str | None) -> str:
    prompt_kind = str(kind or "").strip().lower()
    if prompt_kind not in PROMPT_FILES:
        raise ValueError("Unknown system prompt kind.")
    return prompt_kind


def default_prompt_path(kind: str) -> Path:
    return DEFAULT_PROMPT_DIR / PROMPT_FILES[normalize_prompt_kind(kind)]


def user_prompt_path(kind: str) -> Path:
    return USER_PROMPT_DIR / PROMPT_FILES[normalize_prompt_kind(kind)]


def preset_store_path() -> Path:
    return USER_PROMPT_DIR / PRESET_STORE_FILENAME


def load_packaged_system_prompt(kind: str) -> str:
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


def load_default_system_prompt(kind: str) -> str:
    prompt_kind = normalize_prompt_kind(kind)
    return load_user_system_prompt(prompt_kind) or load_packaged_system_prompt(prompt_kind)


def load_system_prompt(kind: str, preset_id: str | None = DEFAULT_PROMPT_ID) -> str:
    return system_prompt_preset_payload(kind, preset_id)["prompt"]


def _normalize_preset_id(preset_id: str | None) -> str:
    value = str(preset_id or DEFAULT_PROMPT_ID).strip()
    return value or DEFAULT_PROMPT_ID


def _normalize_preset_name(name: str | None) -> str:
    value = str(name or "").strip()
    if not value:
        raise ValueError("System prompt preset name cannot be blank.")
    return value


def _validate_prompt_text(prompt: str | None) -> str:
    text = str(prompt or "")
    if not text.strip():
        raise ValueError("System prompt cannot be blank.")
    return text


def _preset_slug(name: str) -> str:
    slug = []
    previous_dash = False
    for char in name.lower():
        if char.isalnum():
            slug.append(char)
            previous_dash = False
        elif not previous_dash:
            slug.append("-")
            previous_dash = True
    value = "".join(slug).strip("-")
    return value or "preset"


def _read_preset_store() -> dict[str, list[dict[str, str]]]:
    store: dict[str, list[dict[str, str]]] = {kind: [] for kind in PROMPT_FILES}
    path = preset_store_path()
    if not path.exists():
        return store
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return store
    if not isinstance(raw, dict):
        return store
    for kind in PROMPT_FILES:
        entries = raw.get(kind, [])
        if not isinstance(entries, list):
            continue
        seen_ids: set[str] = set()
        seen_names: set[str] = set()
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            preset_id = _normalize_preset_id(entry.get("id"))
            name = str(entry.get("name") or "").strip()
            prompt = str(entry.get("prompt") or "")
            name_key = name.casefold()
            if (
                not name
                or not prompt.strip()
                or preset_id == DEFAULT_PROMPT_ID
                or preset_id in seen_ids
                or name_key in seen_names
            ):
                continue
            seen_ids.add(preset_id)
            seen_names.add(name_key)
            store[kind].append({"id": preset_id, "name": name, "prompt": prompt})
    return store


def _write_preset_store(store: dict[str, list[dict[str, str]]]) -> None:
    USER_PROMPT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {kind: store.get(kind, []) for kind in PROMPT_FILES}
    preset_store_path().write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _custom_presets(kind: str) -> list[dict[str, str]]:
    return _read_preset_store()[normalize_prompt_kind(kind)]


def _find_custom_preset(kind: str, preset_id: str) -> dict[str, str] | None:
    normalized_id = _normalize_preset_id(preset_id)
    for preset in _custom_presets(kind):
        if preset["id"] == normalized_id:
            return preset
    return None


def _default_system_prompt_payload(kind: str) -> dict[str, object]:
    prompt_kind = normalize_prompt_kind(kind)
    user_prompt = load_user_system_prompt(prompt_kind)
    packaged_prompt = load_packaged_system_prompt(prompt_kind)
    return {
        "kind": prompt_kind,
        "id": DEFAULT_PROMPT_ID,
        "name": DEFAULT_PROMPT_NAMES[prompt_kind],
        "prompt": user_prompt or packaged_prompt,
        "default_prompt": packaged_prompt,
        "is_builtin": True,
        "is_default": user_prompt is None,
    }


def _custom_system_prompt_payload(kind: str, preset: dict[str, str]) -> dict[str, object]:
    prompt_kind = normalize_prompt_kind(kind)
    return {
        "kind": prompt_kind,
        "id": preset["id"],
        "name": preset["name"],
        "prompt": preset["prompt"],
        "default_prompt": load_default_system_prompt(prompt_kind),
        "is_builtin": False,
        "is_default": False,
    }


def list_system_prompt_presets(kind: str) -> dict[str, object]:
    prompt_kind = normalize_prompt_kind(kind)
    presets = [_default_system_prompt_payload(prompt_kind)]
    presets.extend(_custom_system_prompt_payload(prompt_kind, preset) for preset in _custom_presets(prompt_kind))
    return {"kind": prompt_kind, "presets": presets}


def system_prompt_preset_payload(kind: str, preset_id: str | None = DEFAULT_PROMPT_ID) -> dict[str, object]:
    prompt_kind = normalize_prompt_kind(kind)
    normalized_id = _normalize_preset_id(preset_id)
    if normalized_id == DEFAULT_PROMPT_ID:
        return _default_system_prompt_payload(prompt_kind)
    preset = _find_custom_preset(prompt_kind, normalized_id)
    if preset is None:
        return _default_system_prompt_payload(prompt_kind)
    return _custom_system_prompt_payload(prompt_kind, preset)


def _unique_preset_id(kind: str, name: str) -> str:
    used = {preset["id"] for preset in _custom_presets(kind)}
    base = _preset_slug(name)
    candidate = base
    suffix = 2
    while candidate in used or candidate == DEFAULT_PROMPT_ID:
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def _assert_unique_name(kind: str, name: str, preset_id: str | None = None) -> None:
    prompt_kind = normalize_prompt_kind(kind)
    name_key = name.casefold()
    normalized_id = str(preset_id).strip() if preset_id is not None else ""
    if DEFAULT_PROMPT_NAMES[prompt_kind].casefold() == name_key and normalized_id != DEFAULT_PROMPT_ID:
        raise ValueError("System prompt preset name must be unique.")
    for preset in _custom_presets(prompt_kind):
        if preset["id"] != normalized_id and preset["name"].casefold() == name_key:
            raise ValueError("System prompt preset name must be unique.")


def save_default_system_prompt(kind: str, prompt: str | None) -> dict[str, object]:
    prompt_kind = normalize_prompt_kind(kind)
    text = _validate_prompt_text(prompt)
    USER_PROMPT_DIR.mkdir(parents=True, exist_ok=True)
    user_prompt_path(prompt_kind).write_text(text, encoding="utf-8")
    return system_prompt_preset_payload(prompt_kind, DEFAULT_PROMPT_ID)


def reset_default_system_prompt(kind: str) -> dict[str, object]:
    prompt_kind = normalize_prompt_kind(kind)
    override_path = user_prompt_path(prompt_kind)
    if override_path.exists():
        override_path.unlink()
    return system_prompt_preset_payload(prompt_kind, DEFAULT_PROMPT_ID)


def save_system_prompt_preset(
    kind: str,
    name: str | None,
    prompt: str | None,
    preset_id: str | None = None,
) -> dict[str, object]:
    prompt_kind = normalize_prompt_kind(kind)
    raw_id = str(preset_id).strip() if preset_id is not None else ""
    if raw_id == DEFAULT_PROMPT_ID:
        return save_default_system_prompt(prompt_kind, prompt)
    normalized_id = raw_id
    preset_name = _normalize_preset_name(name)
    prompt_text = _validate_prompt_text(prompt)
    _assert_unique_name(prompt_kind, preset_name, normalized_id)

    store = _read_preset_store()
    presets = store[prompt_kind]
    for preset in presets:
        if preset["id"] == normalized_id:
            preset.update({"name": preset_name, "prompt": prompt_text})
            _write_preset_store(store)
            return _custom_system_prompt_payload(prompt_kind, preset)

    new_id = _unique_preset_id(prompt_kind, preset_name)
    new_preset = {"id": new_id, "name": preset_name, "prompt": prompt_text}
    presets.append(new_preset)
    _write_preset_store(store)
    return _custom_system_prompt_payload(prompt_kind, new_preset)


def delete_system_prompt_preset(kind: str, preset_id: str | None) -> dict[str, object]:
    prompt_kind = normalize_prompt_kind(kind)
    normalized_id = _normalize_preset_id(preset_id)
    if normalized_id == DEFAULT_PROMPT_ID:
        raise ValueError("Default system prompt preset cannot be deleted.")
    store = _read_preset_store()
    before = len(store[prompt_kind])
    store[prompt_kind] = [preset for preset in store[prompt_kind] if preset["id"] != normalized_id]
    if len(store[prompt_kind]) == before:
        raise ValueError("Unknown system prompt preset.")
    _write_preset_store(store)
    return list_system_prompt_presets(prompt_kind)


def build_video_prompt_blocks(prompt_values: dict[str, object] | None = None) -> dict[str, str]:
    values = prompt_values or {}
    references = _coerce_image_references(values.get("image_references", []))
    described_references = [reference for reference in references if reference["describe"]]
    has_described = bool(described_references)
    segment_index = _as_int(values.get("segment_index"), 1)
    segment_total = _as_int(values.get("segment_total"), 1)

    segment_policy = _segment_policy(segment_index, segment_total, has_described)
    reference_policy = _reference_policy(references)
    description_policy = _description_policy(has_described)
    detail_policy = DESCRIBED_DETAIL_POLICY if has_described else ""

    return {
        "segment_policy": segment_policy,
        "reference_policy": reference_policy,
        "description_policy": description_policy,
        "detail_policy": detail_policy,
        "output_policy": COMMON_OUTPUT_POLICY,
    }


def system_prompt_payload(kind: str) -> dict[str, object]:
    return system_prompt_preset_payload(kind, DEFAULT_PROMPT_ID)


def _coerce_image_references(raw_references: object) -> list[dict[str, object]]:
    references: list[dict[str, object]] = []
    if not raw_references:
        return references
    for raw_reference in raw_references if isinstance(raw_references, (list, tuple)) else []:
        role = _reference_value(raw_reference, "role")
        index = _reference_value(raw_reference, "index")
        describe = _reference_value(raw_reference, "describe")
        if not role:
            continue
        references.append(
            {
                "index": _as_int(index, 0),
                "role": str(role).strip().lower(),
                "describe": bool(describe),
            }
        )
    return references


def _reference_value(reference: object, key: str) -> object:
    if isinstance(reference, dict):
        return reference.get(key)
    return getattr(reference, key, None)


def _as_int(value: object, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _segment_policy(segment_index: int, segment_total: int, has_described: bool) -> str:
    if has_described:
        if segment_index > 1:
            return (
                f"This is segment {segment_index} of {segment_total}. Described references are allowed to add "
                "fresh visible details before the action, even in later segments. After the described reference, "
                "continue from the previous segment and focus on what changes."
            )
        return (
            f"This is segment {segment_index} of {segment_total}. Described references must appear before the "
            "action. After the description, write a short continuous video beat."
        )
    if segment_index > 1:
        return (
            f"This is segment {segment_index} of {segment_total}. Continue from the previous segment. Focus on "
            "what changes now and avoid repeating full earlier descriptions."
        )
    return (
        f"This is segment {segment_index} of {segment_total}. Briefly anchor only what is needed, then focus on "
        "the visible action."
    )


def _reference_policy(references: list[dict[str, object]]) -> str:
    if not references:
        return "No image references are selected for this segment. Use only the user direction and continuity."

    ordered_keys: list[tuple[str, bool]] = []
    seen: set[tuple[str, bool]] = set()
    for reference in references:
        key = (str(reference["role"]), bool(reference["describe"]))
        if key in seen:
            continue
        seen.add(key)
        ordered_keys.append(key)

    policies: list[str] = []
    for role, describe in ordered_keys:
        policy = REFERENCE_ROLE_POLICIES.get(role, {}).get(describe)
        if policy:
            policies.append(policy)
    return "\n".join(policies).strip()


def _description_policy(has_described: bool) -> str:
    if not has_described:
        return (
            "Use referenced images as guidance only. Do not describe a reference in detail unless that detail is "
            "needed to make the action clear."
        )
    return (
        "When a reference uses :describe, describe that referenced content for its role before applying the user "
        "action. If the user explicitly changes image details, honor the user prompt. Otherwise, treat the "
        "referenced image as the source of truth."
    )


def save_system_prompt(kind: str, prompt: str | None) -> dict[str, object]:
    return save_default_system_prompt(kind, prompt)


def reset_system_prompt(kind: str) -> dict[str, object]:
    return reset_default_system_prompt(kind)


def render_video_system_prompt(
    prompt_type: str,
    has_video: bool = False,
    has_audio: bool = False,
    prompt_values: dict[str, object] | None = None,
    system_prompt_preset: str | None = DEFAULT_PROMPT_ID,
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
    values.update(build_video_prompt_blocks(values))

    template = load_system_prompt("video", system_prompt_preset)
    try:
        return template.format(**values)
    except (KeyError, ValueError):
        return load_packaged_system_prompt("video").format(**values)

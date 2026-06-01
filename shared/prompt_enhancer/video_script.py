from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


SUPPORTED_GLOBAL_KEYS = frozenset(
    {
        "rating",
        "style",
        "default_reference_mode",
        "camera",
        "duration",
        "continuity_mode",
    }
)
SUPPORTED_SEGMENT_KEYS = frozenset(
    {
        "rating",
        "reference_mode",
        "style",
        "camera",
        "duration",
        "continuity",
    }
)
SUPPORTED_IMAGE_ROLES = (
    "start",
    "end",
    "character",
    "style",
    "pose",
    "setting",
    "motion",
)
SUPPORTED_REFERENCE_MODES = (
    "none",
    "start_frame",
    "end_guidance",
    "start_and_end_transition",
    "character_reference",
    "style_reference",
    "mixed",
)

DEFAULT_RATING = "SFW"
IMAGE_REF_RE = re.compile(r"@image(?P<index>\d+)(?P<suffix>(?::[A-Za-z_][A-Za-z0-9_-]*)*)", re.IGNORECASE)


@dataclass(frozen=True)
class ImageReference:
    index: int
    role: str
    token: str
    describe: bool = False


@dataclass
class ParsedSegment:
    raw_text: str
    direction: str
    metadata: dict[str, str] = field(default_factory=dict)
    continuity: str = ""
    image_references: list[ImageReference] = field(default_factory=list)
    inferred_reference_mode: str = "none"
    warnings: list[str] = field(default_factory=list)


@dataclass
class ParsedVideoScript:
    global_metadata: dict[str, str] = field(default_factory=dict)
    segments: list[ParsedSegment] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class VideoScriptError(ValueError):
    """Readable validation error for the Prompt Enhancer video script syntax."""


def parse_metadata_line(line: str) -> tuple[str, str] | None:
    text = str(line or "").strip()
    if not (text.startswith("[") and text.endswith("]")):
        return None
    inner = text[1:-1]
    if "=" not in inner:
        return None
    key, value = inner.split("=", 1)
    key = key.strip().lower()
    if not key:
        return None
    return key, value.strip()


def extract_image_references(text: str, image_count: int | None = None) -> list[ImageReference]:
    references: list[ImageReference] = []
    for match in IMAGE_REF_RE.finditer(str(text or "")):
        token = match.group(0)
        index = _as_int(match.group("index"), 0)
        role, describe = _parse_image_reference_suffix(match.group("suffix") or "", token)
        if role not in SUPPORTED_IMAGE_ROLES:
            raise VideoScriptError(
                f"Unknown image role `{role}`. Supported roles: {', '.join(SUPPORTED_IMAGE_ROLES)}."
            )
        if index < 1:
            raise VideoScriptError(f"Image reference `{token}` must use a 1-based image index.")
        if image_count is not None and index > image_count:
            raise VideoScriptError(f"Image reference `{token}` was used, but only {image_count} images were provided.")
        references.append(ImageReference(index=index, role=role, token=token, describe=describe))
    return references


def infer_reference_mode(
    image_references: list[ImageReference],
    default_reference_mode: str | None = None,
    explicit_reference_mode: str | None = None,
) -> str:
    if explicit_reference_mode:
        return validate_reference_mode(explicit_reference_mode)

    roles = {reference.role for reference in image_references}
    if not roles:
        return validate_reference_mode(default_reference_mode or "none")
    if roles == {"start"}:
        return "start_frame"
    if roles == {"end"}:
        return "end_guidance"
    if roles == {"start", "end"}:
        return "start_and_end_transition"
    if roles == {"character"}:
        return "character_reference"
    if roles == {"style"}:
        return "style_reference"
    return "mixed"


def validate_reference_mode(value: str | None) -> str:
    mode = str(value or "none").strip().lower()
    if mode not in SUPPORTED_REFERENCE_MODES:
        suggestion = _closest_reference_mode(mode)
        hint = f" Did you mean `{suggestion}`?" if suggestion else ""
        raise VideoScriptError(
            f"Unknown reference mode `{mode}`.{hint} Supported modes: {', '.join(SUPPORTED_REFERENCE_MODES)}."
        )
    return mode


def build_image_notes(image_references: list[ImageReference], metadata: dict[str, str]) -> str:
    notes: list[str] = []
    if metadata.get("style"):
        notes.append(f"Style: {metadata['style']}.")
    if metadata.get("camera"):
        notes.append(f"Camera guidance: {metadata['camera']}.")
    if metadata.get("duration"):
        notes.append(f"Duration target: {metadata['duration']}.")

    ordered_keys: list[tuple[int, str]] = []
    describe_by_key: dict[tuple[int, str], bool] = {}
    for reference in image_references:
        key = (reference.index, reference.role)
        if key not in describe_by_key:
            ordered_keys.append(key)
            describe_by_key[key] = False
        describe_by_key[key] = describe_by_key[key] or reference.describe
    for index, role in ordered_keys:
        notes.append(f"Image {index} is used as {_role_note(role)}.")
        if describe_by_key[(index, role)]:
            notes.append(f"Image {index} requests :describe for the {role} role.")
    return " ".join(notes).strip()


def parse_video_prompt_script(script_text: str, image_count: int | None = None) -> ParsedVideoScript:
    global_metadata: dict[str, str] = {}
    warnings: list[str] = []
    segment_blocks: list[list[str]] = []
    current_block: list[str] = []
    global_region = True

    for line in str(script_text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line.strip() == "---":
            if current_block:
                segment_blocks.append(current_block)
                current_block = []
            else:
                warnings.append("Ignored an empty segment separator.")
            global_region = False
            continue

        metadata = parse_metadata_line(line)
        if global_region and metadata is not None:
            key, value = metadata
            if key in SUPPORTED_GLOBAL_KEYS or key not in SUPPORTED_SEGMENT_KEYS:
                global_metadata[key] = value
                if key not in SUPPORTED_GLOBAL_KEYS:
                    warnings.append(f"Unknown global metadata key `{key}` was preserved but not interpreted.")
                continue

        if global_region and not line.strip():
            continue

        global_region = False
        current_block.append(line)

    if current_block:
        segment_blocks.append(current_block)

    segments: list[ParsedSegment] = []
    for block in segment_blocks:
        segment = _parse_segment(block, global_metadata, image_count)
        if not segment.direction and not segment.continuity and not segment.metadata and not segment.image_references:
            warnings.append("Ignored an empty segment.")
            continue
        segments.append(segment)

    return ParsedVideoScript(global_metadata=global_metadata, segments=segments, warnings=warnings)


def build_segment_variables(
    parsed_script: ParsedVideoScript,
    active_segment_index: int,
    prompt_type: str = "video",
    has_video: bool = False,
    has_audio: bool = False,
) -> dict[str, Any]:
    segment_total = len(parsed_script.segments)
    if segment_total == 0:
        raise VideoScriptError("Video script has no usable segments.")

    selected_index = _as_int(active_segment_index, 1)
    if selected_index < 1 or selected_index > segment_total:
        raise VideoScriptError(
            f"active_segment_index {selected_index} is outside the available segment range 1..{segment_total}."
        )

    segment = parsed_script.segments[selected_index - 1]
    metadata = dict(parsed_script.global_metadata)
    metadata.update(segment.metadata)
    continuity = _combined_continuity(metadata.get("continuity", ""), segment.continuity)
    image_notes = build_image_notes(segment.image_references, metadata)
    warnings = [*parsed_script.warnings, *segment.warnings]
    if segment.metadata.get("reference_mode") and segment.inferred_reference_mode != "none" and not segment.image_references:
        warnings.append(
            f"Segment {selected_index} sets reference_mode={segment.inferred_reference_mode} "
            "but has no @imageN references, so no images will be sent for that segment."
        )
    if not segment.direction.strip():
        raise VideoScriptError(f"Segment {selected_index} has no direction text after parsing.")

    return {
        "rating": metadata.get("rating") or DEFAULT_RATING,
        "segment_index": selected_index,
        "segment_total": segment_total,
        "direction": segment.direction,
        "continuity": continuity,
        "reference_mode": segment.inferred_reference_mode,
        "image_notes": image_notes,
        "style": metadata.get("style", ""),
        "camera": metadata.get("camera", ""),
        "duration": metadata.get("duration", ""),
        "continuity_mode": metadata.get("continuity_mode", ""),
        "prompt_type": prompt_type or "video",
        "has_video": has_video,
        "has_audio": has_audio,
        "warnings": warnings,
        "image_references": segment.image_references,
    }


def build_resolved_segment_prompt(segment_variables: dict[str, Any]) -> str:
    labels = [
        ("Segment", f"{segment_variables.get('segment_index')} of {segment_variables.get('segment_total')}"),
        ("Rating", segment_variables.get("rating")),
        ("Direction", segment_variables.get("direction")),
        ("Continuity", segment_variables.get("continuity")),
        ("Reference mode", segment_variables.get("reference_mode")),
        ("Image notes", segment_variables.get("image_notes")),
        ("Visual context", segment_variables.get("visual_context")),
        ("Style", segment_variables.get("style")),
        ("Camera", segment_variables.get("camera")),
        ("Duration", segment_variables.get("duration")),
    ]
    return "\n".join(f"{label}: {value}" for label, value in labels if str(value or "").strip())


def _parse_segment(
    lines: list[str],
    global_metadata: dict[str, str],
    image_count: int | None,
) -> ParsedSegment:
    metadata: dict[str, str] = {}
    warnings: list[str] = []
    direction_lines: list[str] = []
    continuity_lines: list[str] = []
    raw_text = "\n".join(lines)

    for line in lines:
        parsed_metadata = parse_metadata_line(line)
        if parsed_metadata is not None:
            key, value = parsed_metadata
            metadata[key] = value
            if key not in SUPPORTED_SEGMENT_KEYS:
                warnings.append(f"Unknown segment metadata key `{key}` was preserved but not interpreted.")
            continue
        if _looks_like_invalid_metadata(line):
            warnings.append(f"Ignored invalid metadata syntax: `{line.strip()}`.")
            continue

        continuity = _continuity_line(line)
        if continuity is not None:
            continuity_lines.append(_remove_image_references(continuity).strip())
            continue

        direction_lines.append(_strip_direction_markup(_remove_image_references(line).strip()))

    image_references = extract_image_references(raw_text, image_count=image_count)
    effective_metadata = dict(global_metadata)
    effective_metadata.update(metadata)
    reference_mode = infer_reference_mode(
        image_references,
        default_reference_mode=effective_metadata.get("default_reference_mode"),
        explicit_reference_mode=metadata.get("reference_mode"),
    )
    direction = _trim_multiline("\n".join(direction_lines))
    continuity = _trim_multiline("\n".join(continuity_lines))
    if not direction and (metadata or continuity or image_references):
        warnings.append("Segment has no direction text after metadata and image references were removed.")

    return ParsedSegment(
        raw_text=raw_text,
        direction=direction,
        metadata=metadata,
        continuity=continuity,
        image_references=image_references,
        inferred_reference_mode=reference_mode,
        warnings=warnings,
    )


def _remove_image_references(text: str) -> str:
    cleaned = IMAGE_REF_RE.sub("", str(text or ""))
    return re.sub(r"[ \t]{2,}", " ", cleaned)


def _strip_direction_markup(line: str) -> str:
    text = str(line or "").strip()
    if text.startswith("##"):
        return text.lstrip("#").strip()
    return text


def _continuity_line(line: str) -> str | None:
    text = str(line or "").strip()
    if text.startswith(">>"):
        return text[2:].strip()
    if text.startswith("> >"):
        return text[3:].strip()
    return None


def _looks_like_invalid_metadata(line: str) -> bool:
    text = str(line or "").strip()
    return bool(text and (text.startswith("[") or text.endswith("]")))


def _trim_multiline(text: str) -> str:
    lines = [line.strip() for line in str(text or "").split("\n")]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def _combined_continuity(metadata_continuity: str, explicit_continuity: str) -> str:
    parts = [str(metadata_continuity or "").strip(), str(explicit_continuity or "").strip()]
    return "\n".join(part for part in parts if part)


def _parse_image_reference_suffix(suffix: str, token: str) -> tuple[str, bool]:
    parts = [part.strip().lower() for part in str(suffix or "").split(":") if part.strip()]
    if not parts:
        return "start", False
    if len(parts) == 1:
        if parts[0] == "describe":
            return "start", True
        return parts[0], False
    if len(parts) == 2:
        role, modifier = parts
        if modifier != "describe":
            raise VideoScriptError(
                f"Unknown image reference modifier `{modifier}` in `{token}`. Supported modifiers: describe."
            )
        return role, True
    raise VideoScriptError(f"Image reference `{token}` has too many modifiers. Supported modifier: describe.")


def _role_note(role: str) -> str:
    return {
        "start": "the starting frame",
        "end": "end guidance for the final state",
        "character": "character reference",
        "style": "style reference",
        "pose": "pose reference",
        "setting": "setting reference",
        "motion": "motion reference",
    }[role]


def _describe_note(role: str) -> str:
    subject_details = (
        "For visible people or central subjects, include skin tone or visible complexion, face shape, facial "
        "structure, facial features, eye expression, hair color and style, facial hair, facial expression, "
        "apparent age range, build, clothing or accessories, posture, gaze direction, and distinctive visible "
        "traits. If the reference contains multiple people, describe each central person separately before the "
        "action using stable labels such as the man, the woman, person on the left, or person on the right, and "
        "include each person's relative position and distinguishing visible traits. Do not infer ethnicity, "
        "nationality, identity, profession, personality, or other private traits "
        "from the image; use those descriptors only when the user explicitly provides them. For animals, include "
        "coat or fur color, markings, size, breed-like features, ears, tail, face or muzzle, body shape, "
        "expression, posture, stance, gait, visible movement cues, and motion-relevant traits."
    )
    role_note = {
        "start": (
            "describe the referenced image content first as the full visible opening frame, including environment, "
            "background, lighting, composition, camera framing, central subjects, setting, sky, water, landscape, "
            "objects, posture, and other details that should be preserved, then apply the user's requested action "
            "from that starting state."
        ),
        "end": (
            "describe the referenced image content first as the target final state, including subject appearance, "
            "setting, lighting, composition, posture, and details the motion should resolve toward, then shape the "
            "user's requested action so it naturally reaches that state."
        ),
        "character": (
            "describe the referenced image content first as the character or subject reference. If multiple people "
            "are visible, describe each central person separately before the action using stable labels such as the "
            "man, the woman, person on the left, or person on the right. Include persistent identity traits such as "
            "color, size, markings, clothing or accessories, expression, posture, relative position, and distinctive "
            "features. If this described character reference introduces a newly referenced subject in the segment, "
            "visually introduce that subject before any action, even in later segments. Treat the referenced subject "
            "as new unless it was already clearly described in prior segment text, then use those traits in the "
            "user's requested action."
        ),
        "style": (
            "describe the referenced image content first as the style reference, including visual style, color "
            "palette, lighting, texture, medium, mood, and rendering treatment, then apply that style to the "
            "user's requested action. If people, animals, or central subjects are important to the style reference, "
            "include their visible appearance details too."
        ),
        "pose": (
            "describe the referenced image content first as the pose reference, including body pose, gesture, "
            "limb placement, expression, camera-facing angle, and other pose cues, then adapt the user's requested "
            "action from that pose."
        ),
        "setting": (
            "describe the referenced image content first as the setting reference, including environment layout, "
            "objects, weather, lighting, atmosphere, and spatial details, then place the user's requested action "
            "inside that setting. If people, animals, or central subjects are part of the setting, include their "
            "visible appearance details too."
        ),
        "motion": (
            "describe the referenced image content first as the motion reference, including movement cues, posture "
            "changes, implied timing, direction of travel, and action-relevant details, then use those cues to shape "
            "the user's requested action."
        ),
    }[role]
    override_note = (
        "If the user explicitly describes a conflicting change, transformation, or replacement, honor the user prompt; "
        "otherwise use the referenced image as the source of truth for that description."
    )
    return f"{role_note} {subject_details} {override_note}"


def _closest_reference_mode(value: str) -> str:
    compact = str(value or "").replace("-", "_").replace(" ", "_").lower()
    aliases = {
        "firstframe": "start_frame",
        "first_frame": "start_frame",
        "start": "start_frame",
        "end": "end_guidance",
        "ending": "end_guidance",
        "start_end": "start_and_end_transition",
        "character": "character_reference",
        "style": "style_reference",
    }
    return aliases.get(compact, "")


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

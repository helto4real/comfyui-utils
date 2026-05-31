from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

from comfy.comfy_types.node_typing import IO
from comfy_api.latest import io


anything = io.Custom(IO.ANY)

MAX_COLLECTION_ITEMS = 64
MAX_TEXT_CHARS = 200_000
TEXT_UI_KEY = "helto_privacy_show_any"


class HeltoPrivacyShowAny(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoPrivacyShowAny",
            display_name="Helto Privacy Show Any",
            category="HELTO/Privacy",
            description="Displays any incoming value as text without saving plaintext display state in workflows.",
            inputs=[
                anything.Input("input", optional=True, tooltip="Any ComfyUI value to display as text."),
                io.String.Input("encrypted_text_state", default="", optional=True),
            ],
            outputs=[
                io.String.Output("text"),
            ],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, input: Any = None, encrypted_text_state: str = "") -> io.NodeOutput:
        text = convert_any_to_text(input)
        return io.NodeOutput(text, ui={TEXT_UI_KEY: [{"text": text}]})


def convert_any_to_text(value: Any) -> str:
    if isinstance(value, str):
        return _truncate_text(value)
    if isinstance(value, bytes | bytearray):
        return _truncate_text(_decode_bytes(bytes(value)))

    sanitized = _sanitize_for_text(value)
    if isinstance(sanitized, str):
        return _truncate_text(sanitized)

    try:
        return _truncate_text(json.dumps(sanitized, indent=2, ensure_ascii=False, sort_keys=True))
    except (TypeError, ValueError):
        return _truncate_text(_unsupported_text(value))


def _sanitize_for_text(value: Any, depth: int = 0, seen: set[int] | None = None) -> Any:
    seen = seen or set()
    if value is None or isinstance(value, bool | int | float | str):
        return value
    if isinstance(value, bytes | bytearray):
        return _decode_bytes(bytes(value))
    if _is_tensor_like(value):
        return _tensor_summary(value)
    if _is_array_like(value):
        return _array_summary(value)

    value_id = id(value)
    if value_id in seen:
        return "<recursive reference>"
    if depth >= 8:
        return f"<max depth reached for {type(value).__name__}>"

    if isinstance(value, Mapping):
        seen.add(value_id)
        items = list(value.items())
        result = {
            str(key): _sanitize_for_text(item_value, depth + 1, seen)
            for key, item_value in items[:MAX_COLLECTION_ITEMS]
        }
        if len(items) > MAX_COLLECTION_ITEMS:
            result["..."] = f"{len(items) - MAX_COLLECTION_ITEMS} more item(s)"
        seen.discard(value_id)
        return result

    if isinstance(value, set | frozenset):
        value = sorted(value, key=lambda item: repr(item))

    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        seen.add(value_id)
        result = [_sanitize_for_text(item, depth + 1, seen) for item in value[:MAX_COLLECTION_ITEMS]]
        if len(value) > MAX_COLLECTION_ITEMS:
            result.append(f"<{len(value) - MAX_COLLECTION_ITEMS} more item(s)>")
        seen.discard(value_id)
        return result

    return _unsupported_text(value)


def _decode_bytes(value: bytes) -> str:
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        return f"<bytes length={len(value)}; not valid UTF-8 text>"


def _is_tensor_like(value: Any) -> bool:
    module = type(value).__module__
    return module.startswith("torch") and hasattr(value, "shape") and hasattr(value, "dtype")


def _is_array_like(value: Any) -> bool:
    module = type(value).__module__
    return module.startswith("numpy") and hasattr(value, "shape") and hasattr(value, "dtype")


def _tensor_summary(value: Any) -> str:
    shape = tuple(getattr(value, "shape", ()))
    dtype = getattr(value, "dtype", "unknown")
    device = getattr(value, "device", None)
    suffix = f" device={device}" if device is not None else ""
    if _numel(value) == 1:
        try:
            return str(value.detach().cpu().item())
        except Exception:
            pass
    if 0 < _numel(value) <= 16:
        try:
            return json.dumps(value.detach().cpu().tolist(), ensure_ascii=False)
        except Exception:
            pass
    return f"<tensor shape={shape} dtype={dtype}{suffix}>"


def _array_summary(value: Any) -> str:
    shape = tuple(getattr(value, "shape", ()))
    dtype = getattr(value, "dtype", "unknown")
    size = int(getattr(value, "size", 0) or 0)
    if size == 1:
        try:
            return str(value.item())
        except Exception:
            pass
    if 0 < size <= 16:
        try:
            return json.dumps(value.tolist(), ensure_ascii=False)
        except Exception:
            pass
    return f"<array shape={shape} dtype={dtype}>"


def _numel(value: Any) -> int:
    try:
        return int(value.numel())
    except Exception:
        return 0


def _unsupported_text(value: Any) -> str:
    type_name = type(value).__name__
    module = type(value).__module__
    qualified = f"{module}.{type_name}" if module and module != "builtins" else type_name
    return f"<{qualified} cannot be converted to meaningful text>"


def _truncate_text(text: str) -> str:
    if len(text) <= MAX_TEXT_CHARS:
        return text
    omitted = len(text) - MAX_TEXT_CHARS
    return f"{text[:MAX_TEXT_CHARS]}\n<truncated {omitted} character(s)>"

from __future__ import annotations

import json
import sys
import time
from typing import Any


EVENT_NAME = "helto_progress"
TEXT_BRIDGE_NODE_ID = "__helto_progress_text__"
PAYLOAD_VERSION = 1
LEVELS = {"debug", "info", "success", "warning", "error"}


def install_public_alias() -> None:
    sys.modules.setdefault("helto_progress", sys.modules[__name__])


def report(
    message: str | None = None,
    phase: str | None = None,
    value: float | int | None = None,
    total: float | int | None = None,
    percent: float | int | None = None,
    level: str = "info",
    detail: Any | None = None,
    node_id: str | int | None = None,
    prompt_id: str | None = None,
    native_text: bool = False,
) -> dict[str, Any]:
    return _emit(
        "report",
        message=message,
        phase=phase,
        value=value,
        total=total,
        percent=percent,
        level=level,
        detail=detail,
        node_id=node_id,
        prompt_id=prompt_id,
        native_text=native_text,
    )


def start(
    message: str | None = None,
    phase: str | None = None,
    value: float | int | None = None,
    total: float | int | None = None,
    percent: float | int | None = None,
    level: str = "info",
    detail: Any | None = None,
    node_id: str | int | None = None,
    prompt_id: str | None = None,
    native_text: bool = False,
) -> dict[str, Any]:
    return _emit(
        "start",
        message=message,
        phase=phase,
        value=value,
        total=total,
        percent=percent,
        level=level,
        detail=detail,
        node_id=node_id,
        prompt_id=prompt_id,
        native_text=native_text,
    )


def update(
    message: str | None = None,
    phase: str | None = None,
    value: float | int | None = None,
    total: float | int | None = None,
    percent: float | int | None = None,
    level: str = "info",
    detail: Any | None = None,
    node_id: str | int | None = None,
    prompt_id: str | None = None,
    native_text: bool = False,
) -> dict[str, Any]:
    return _emit(
        "update",
        message=message,
        phase=phase,
        value=value,
        total=total,
        percent=percent,
        level=level,
        detail=detail,
        node_id=node_id,
        prompt_id=prompt_id,
        native_text=native_text,
    )


def done(
    message: str | None = None,
    phase: str | None = None,
    value: float | int | None = None,
    total: float | int | None = None,
    percent: float | int | None = None,
    level: str = "success",
    detail: Any | None = None,
    node_id: str | int | None = None,
    prompt_id: str | None = None,
    native_text: bool = False,
) -> dict[str, Any]:
    return _emit(
        "done",
        message=message,
        phase=phase,
        value=value,
        total=total,
        percent=100 if percent is None else percent,
        level=level,
        detail=detail,
        node_id=node_id,
        prompt_id=prompt_id,
        native_text=native_text,
    )


def error(
    message: str | None = None,
    phase: str | None = None,
    value: float | int | None = None,
    total: float | int | None = None,
    percent: float | int | None = None,
    level: str = "error",
    detail: Any | None = None,
    node_id: str | int | None = None,
    prompt_id: str | None = None,
    native_text: bool = False,
) -> dict[str, Any]:
    return _emit(
        "error",
        message=message,
        phase=phase,
        value=value,
        total=total,
        percent=percent,
        level=level,
        detail=detail,
        node_id=node_id,
        prompt_id=prompt_id,
        native_text=native_text,
    )


class ProgressPhase:
    def __init__(
        self,
        name: str,
        label: str | None = None,
        total: float | int | None = None,
        node_id: str | int | None = None,
        prompt_id: str | None = None,
        native_text: bool = False,
    ):
        self.name = str(name)
        self.label = label or self.name
        self.total = _number_or_none(total)
        self.value = 0.0
        self.node_id = node_id
        self.prompt_id = prompt_id
        self.native_text = native_text

    def __enter__(self) -> "ProgressPhase":
        start(
            self.label,
            phase=self.name,
            value=0,
            total=self.total,
            percent=0,
            node_id=self.node_id,
            prompt_id=self.prompt_id,
            native_text=self.native_text,
        )
        return self

    def __exit__(self, exc_type, exc, _traceback) -> bool:
        if exc is not None:
            error(
                str(exc),
                phase=self.name,
                value=self.value,
                total=self.total,
                node_id=self.node_id,
                prompt_id=self.prompt_id,
                native_text=self.native_text,
            )
            return False
        done(
            self.label,
            phase=self.name,
            value=self.total if self.total is not None else self.value,
            total=self.total,
            node_id=self.node_id,
            prompt_id=self.prompt_id,
            native_text=self.native_text,
        )
        return False

    def update(
        self,
        value: float | int | None = None,
        message: str | None = None,
        detail: Any | None = None,
        percent: float | int | None = None,
        native_text: bool | None = None,
    ) -> dict[str, Any]:
        if value is not None:
            self.value = _number_or_none(value) or 0.0
        return update(
            message or self.label,
            phase=self.name,
            value=self.value,
            total=self.total,
            percent=percent,
            detail=detail,
            node_id=self.node_id,
            prompt_id=self.prompt_id,
            native_text=self.native_text if native_text is None else native_text,
        )

    def step(
        self,
        increment: float | int = 1,
        message: str | None = None,
        detail: Any | None = None,
    ) -> dict[str, Any]:
        self.value += _number_or_none(increment) or 0.0
        return self.update(message=message, detail=detail)


def phase(
    name: str,
    label: str | None = None,
    total: float | int | None = None,
    node_id: str | int | None = None,
    prompt_id: str | None = None,
    native_text: bool = False,
) -> ProgressPhase:
    return ProgressPhase(
        name,
        label=label,
        total=total,
        node_id=node_id,
        prompt_id=prompt_id,
        native_text=native_text,
    )


def _emit(
    event: str,
    *,
    message: str | None,
    phase: str | None,
    value: float | int | None,
    total: float | int | None,
    percent: float | int | None,
    level: str,
    detail: Any | None,
    node_id: str | int | None,
    prompt_id: str | None,
    native_text: bool,
) -> dict[str, Any]:
    prompt_id, node_id = _resolve_execution_ids(prompt_id, node_id)
    value_number = _number_or_none(value)
    total_number = _number_or_none(total)
    percent_number = _resolve_percent(value_number, total_number, percent)
    node_meta = _resolve_node_metadata(node_id)

    payload = {
        "version": PAYLOAD_VERSION,
        "event": str(event),
        "prompt_id": str(prompt_id) if prompt_id is not None else None,
        "node_id": str(node_id) if node_id is not None else None,
        "display_node_id": node_meta["display_node_id"],
        "parent_node_id": node_meta["parent_node_id"],
        "real_node_id": node_meta["real_node_id"],
        "phase": str(phase) if phase else None,
        "message": str(message) if message is not None else None,
        "level": _normalize_level(level),
        "value": value_number,
        "total": total_number,
        "percent": percent_number,
        "detail": _json_safe(detail),
        "timestamp": time.time(),
    }
    _send_payload(payload)
    _mirror_native_progress(payload)
    _send_text_bridge(payload)
    if native_text:
        _mirror_native_text(payload)
    return payload


def _resolve_execution_ids(
    prompt_id: str | None,
    node_id: str | int | None,
) -> tuple[str | None, str | int | None]:
    if prompt_id is not None and node_id is not None:
        return prompt_id, node_id
    try:
        from comfy_execution.utils import get_executing_context  # type: ignore[import-not-found]
    except Exception:
        return prompt_id, node_id

    try:
        context = get_executing_context()
    except Exception:
        return prompt_id, node_id

    if context is None:
        return prompt_id, node_id
    return (
        prompt_id if prompt_id is not None else getattr(context, "prompt_id", None),
        node_id if node_id is not None else getattr(context, "node_id", None),
    )


def _resolve_node_metadata(node_id: str | int | None) -> dict[str, str | None]:
    meta = {
        "display_node_id": str(node_id) if node_id is not None else None,
        "parent_node_id": None,
        "real_node_id": str(node_id) if node_id is not None else None,
    }
    if node_id is None:
        return meta

    try:
        from comfy_execution.progress import get_progress_state  # type: ignore[import-not-found]

        dynprompt = get_progress_state().dynprompt
    except Exception:
        return meta

    for payload_key, method_name in (
        ("display_node_id", "get_display_node_id"),
        ("parent_node_id", "get_parent_node_id"),
        ("real_node_id", "get_real_node_id"),
    ):
        method = getattr(dynprompt, method_name, None)
        if not callable(method):
            continue
        try:
            value = method(str(node_id))
        except Exception:
            value = None
        if value is not None:
            meta[payload_key] = str(value)
    return meta


def _send_payload(payload: dict[str, Any]) -> bool:
    try:
        from server import PromptServer  # type: ignore[import-not-found]

        server = PromptServer.instance
        send_sync = getattr(server, "send_sync", None)
        sid = getattr(server, "client_id", None)
    except Exception:
        return False

    if not callable(send_sync) or sid is None:
        return False

    try:
        send_sync(EVENT_NAME, payload, sid)
    except Exception:
        return False
    return True


def _mirror_native_progress(payload: dict[str, Any]) -> bool:
    node_id = payload.get("node_id")
    if node_id is None:
        return False

    native_numbers = _native_progress_numbers(
        payload.get("value"),
        payload.get("total"),
        payload.get("percent"),
    )
    if native_numbers is None:
        return False
    value, total = native_numbers

    try:
        from comfy_execution.progress import get_progress_state  # type: ignore[import-not-found]

        progress_state = get_progress_state()
        update_progress = getattr(progress_state, "update_progress", None)
    except Exception:
        return False

    if not callable(update_progress):
        return False

    try:
        update_progress(str(node_id), value, total, None)
    except Exception:
        return False
    return True


def _mirror_native_text(payload: dict[str, Any]) -> bool:
    node_id = payload.get("node_id")
    if node_id is None:
        return False

    text = _native_text(payload)
    if text is None:
        return False

    try:
        from server import PromptServer  # type: ignore[import-not-found]

        server = PromptServer.instance
        send_progress_text = getattr(server, "send_progress_text", None)
        sid = getattr(server, "client_id", None)
    except Exception:
        return False

    if not callable(send_progress_text) or sid is None:
        return False

    try:
        send_progress_text(text, str(node_id), sid)
    except Exception:
        return False
    return True


def _send_text_bridge(payload: dict[str, Any]) -> bool:
    node_id = payload.get("node_id")
    if node_id is None:
        return False

    text = _native_text(payload)
    if text is None:
        return False

    try:
        from server import PromptServer  # type: ignore[import-not-found]

        server = PromptServer.instance
        send_progress_text = getattr(server, "send_progress_text", None)
        sid = getattr(server, "client_id", None)
    except Exception:
        return False

    if not callable(send_progress_text) or sid is None:
        return False

    bridge_payload = {
        "version": PAYLOAD_VERSION,
        "prompt_id": payload.get("prompt_id"),
        "node_id": str(node_id),
        "display_node_id": payload.get("display_node_id"),
        "parent_node_id": payload.get("parent_node_id"),
        "real_node_id": payload.get("real_node_id"),
        "phase": payload.get("phase"),
        "level": payload.get("level"),
        "text": text,
        "timestamp": payload.get("timestamp"),
    }

    try:
        send_progress_text(json.dumps(bridge_payload, separators=(",", ":")), TEXT_BRIDGE_NODE_ID, sid)
    except Exception:
        return False
    return True


def _native_text(payload: dict[str, Any]) -> str | None:
    message = _clean_text(payload.get("message"))
    detail = _detail_text(payload.get("detail"))
    if message and detail:
        if _normalized_text(detail) in _normalized_text(message):
            return message
        return f"{message} | {detail}"
    return message or detail


def _detail_text(detail: Any) -> str | None:
    if isinstance(detail, str):
        return _clean_text(detail)
    if not isinstance(detail, dict):
        return None
    for key in ("log", "text", "message", "status"):
        text = _clean_text(detail.get(key))
        if text:
            return text
    return None


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text or None


def _normalized_text(value: str) -> str:
    return value.lower()


def _native_progress_numbers(
    value: Any,
    total: Any,
    percent: Any,
) -> tuple[float, float] | None:
    value_number = _number_or_none(value)
    total_number = _number_or_none(total)
    if value_number is not None and total_number is not None and total_number > 0:
        return value_number, total_number

    percent_number = _number_or_none(percent)
    if percent_number is None:
        return None
    return max(0.0, min(100.0, percent_number)), 100.0


def _resolve_percent(
    value: float | None,
    total: float | None,
    percent: float | int | None,
) -> float | None:
    percent_number = _number_or_none(percent)
    if percent_number is None and value is not None and total is not None and total > 0:
        percent_number = (value / total) * 100.0
    if percent_number is None:
        return None
    return max(0.0, min(100.0, percent_number))


def _number_or_none(value: float | int | None) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:
        return None
    if number in (float("inf"), float("-inf")):
        return None
    return number


def _normalize_level(level: str) -> str:
    normalized = str(level or "info").lower()
    return normalized if normalized in LEVELS else "info"


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return str(value)
    return value


install_public_alias()


__all__ = [
    "EVENT_NAME",
    "PAYLOAD_VERSION",
    "TEXT_BRIDGE_NODE_ID",
    "ProgressPhase",
    "done",
    "error",
    "install_public_alias",
    "phase",
    "report",
    "start",
    "update",
]

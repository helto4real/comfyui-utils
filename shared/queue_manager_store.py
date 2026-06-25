from __future__ import annotations

import base64
import json
import time
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any, Mapping

from .privacy import CONFIG_DIR, decrypt_bytes, encrypt_bytes


STATE_VERSION = 1
ENCRYPTED_PREFIX = "HELTO_QUEUE_MANAGER_STATE_V1:"
SERVER_SESSION_ID = uuid.uuid4().hex
STATE_PATH = CONFIG_DIR / "queue_manager_state.json"


def default_queue_manager_state() -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "privacy_enabled": True,
        "paused": True,
        "resume_required": False,
        "active_run_id": None,
        "queue": [],
        "history": [],
        "updated_at": None,
    }


def normalize_queue_manager_state(state: Mapping[str, Any] | None) -> dict[str, Any]:
    normalized = default_queue_manager_state()
    if isinstance(state, Mapping):
        normalized.update(dict(state))

    normalized["version"] = STATE_VERSION
    normalized["privacy_enabled"] = bool(normalized.get("privacy_enabled", False))
    normalized["paused"] = bool(normalized.get("paused", True))
    normalized["queue"] = normalized.get("queue") if isinstance(normalized.get("queue"), list) else []
    normalized["history"] = normalized.get("history") if isinstance(normalized.get("history"), list) else []
    active_run_id = normalized.get("active_run_id")
    normalized["active_run_id"] = active_run_id if isinstance(active_run_id, str) and active_run_id else None
    return normalized


def encrypted_state_payload(state: Mapping[str, Any]) -> str:
    plaintext = json.dumps(state, separators=(",", ":"), sort_keys=True).encode("utf-8")
    encrypted = encrypt_bytes(plaintext)
    encoded = base64.b64encode(encrypted).decode("ascii")
    return f"{ENCRYPTED_PREFIX}{encoded}"


def decrypt_state_payload(payload: str) -> dict[str, Any]:
    if not str(payload).startswith(ENCRYPTED_PREFIX):
        raise ValueError("Queue manager payload is not encrypted.")
    encoded = payload[len(ENCRYPTED_PREFIX):]
    encrypted = base64.b64decode(encoded.encode("ascii"))
    return json.loads(decrypt_bytes(encrypted).decode("utf-8"))


def _read_envelope(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def load_queue_manager_state(path: Path | str = STATE_PATH) -> dict[str, Any]:
    path = Path(path)
    envelope = _read_envelope(path)
    if envelope is None:
        return {
            "ok": True,
            "state": default_queue_manager_state(),
            "privacy_enabled": True,
            "encrypted_at_rest": False,
            "server_session_id": SERVER_SESSION_ID,
            "stored_server_session_id": None,
        }

    stored_session_id = envelope.get("server_session_id") if isinstance(envelope, Mapping) else None
    privacy_enabled = bool(envelope.get("privacy_enabled")) if isinstance(envelope, Mapping) else False
    payload = envelope.get("payload") if isinstance(envelope, Mapping) else envelope

    if privacy_enabled:
        if not isinstance(payload, str):
            raise ValueError("Encrypted queue manager payload is missing.")
        state = decrypt_state_payload(payload)
    elif isinstance(payload, Mapping):
        state = deepcopy(dict(payload))
    elif isinstance(envelope, Mapping) and isinstance(envelope.get("state"), Mapping):
        state = deepcopy(dict(envelope["state"]))
    else:
        state = default_queue_manager_state()

    state = normalize_queue_manager_state(state)
    state["privacy_enabled"] = privacy_enabled
    return {
        "ok": True,
        "state": state,
        "privacy_enabled": privacy_enabled,
        "encrypted_at_rest": privacy_enabled,
        "server_session_id": SERVER_SESSION_ID,
        "stored_server_session_id": stored_session_id if isinstance(stored_session_id, str) else None,
    }


def save_queue_manager_state(
    state: Mapping[str, Any],
    *,
    privacy_enabled: bool | None = None,
    path: Path | str = STATE_PATH,
) -> dict[str, Any]:
    path = Path(path)
    CONFIG_DIR.mkdir(exist_ok=True)

    normalized = normalize_queue_manager_state(state)
    if privacy_enabled is not None:
        normalized["privacy_enabled"] = bool(privacy_enabled)
    normalized["updated_at"] = int(time.time() * 1000)

    if normalized["privacy_enabled"]:
        payload: dict[str, Any] | str = encrypted_state_payload(normalized)
    else:
        payload = normalized

    envelope = {
        "version": STATE_VERSION,
        "privacy_enabled": normalized["privacy_enabled"],
        "server_session_id": SERVER_SESSION_ID,
        "payload": payload,
    }
    path.write_text(json.dumps(envelope, indent=2, sort_keys=True), encoding="utf-8")

    return {
        "ok": True,
        "state": normalized,
        "privacy_enabled": normalized["privacy_enabled"],
        "encrypted_at_rest": normalized["privacy_enabled"],
        "server_session_id": SERVER_SESSION_ID,
    }

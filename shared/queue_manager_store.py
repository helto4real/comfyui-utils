from __future__ import annotations

import json
import sqlite3
import time
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any, Mapping

from .privacy import CONFIG_DIR, QUEUE_MANAGER_PURPOSE, decrypt_bytes, decrypt_state_string, encrypt_bytes, encrypt_state_string


STATE_VERSION = 1
DB_SCHEMA_VERSION = 1
SERVER_SESSION_ID = uuid.uuid4().hex
STATE_DB_PATH = CONFIG_DIR / "queue_manager_state.sqlite3"
LEGACY_STATE_PATH = CONFIG_DIR / "queue_manager_state.json"
STATE_PATH = STATE_DB_PATH


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
    return encrypt_state_string({"state": dict(state)})


def decrypt_state_payload(payload: str) -> dict[str, Any]:
    state = decrypt_state_string(payload).get("state")
    if not isinstance(state, Mapping):
        raise ValueError("Queue manager payload did not contain state.")
    return dict(state)


def _state_to_bytes(state: Mapping[str, Any]) -> bytes:
    return json.dumps(state, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _state_from_bytes(payload: bytes | memoryview, *, encrypted: bool) -> dict[str, Any]:
    data = bytes(payload)
    if encrypted:
        data = decrypt_bytes(data, purpose=QUEUE_MANAGER_PURPOSE)
    return json.loads(data.decode("utf-8"))


def _payload_for_state(state: Mapping[str, Any], *, encrypted: bool) -> bytes:
    payload = _state_to_bytes(state)
    return encrypt_bytes(payload, purpose=QUEUE_MANAGER_PURPOSE) if encrypted else payload


def _semantic_state(state: Mapping[str, Any]) -> dict[str, Any]:
    semantic = normalize_queue_manager_state(state)
    semantic.pop("updated_at", None)
    return semantic


def _same_semantic_state(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    return _state_to_bytes(_semantic_state(left)) == _state_to_bytes(_semantic_state(right))


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA secure_delete=ON")
    conn.execute("PRAGMA journal_mode=DELETE")
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS queue_manager_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL,
            privacy_enabled INTEGER NOT NULL,
            encrypted_at_rest INTEGER NOT NULL,
            server_session_id TEXT,
            updated_at INTEGER,
            payload BLOB NOT NULL
        )
        """
    )
    conn.execute(f"PRAGMA user_version={DB_SCHEMA_VERSION}")


def _read_state_row(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT version, privacy_enabled, encrypted_at_rest, server_session_id, updated_at, payload
        FROM queue_manager_state
        WHERE id = 1
        """
    ).fetchone()


def _write_state_row(
    conn: sqlite3.Connection,
    state: Mapping[str, Any],
    *,
    privacy_enabled: bool,
    server_session_id: str,
) -> None:
    encrypted = bool(privacy_enabled)
    payload = _payload_for_state(state, encrypted=encrypted)
    conn.execute("DELETE FROM queue_manager_state WHERE id = 1")
    conn.execute(
        """
        INSERT INTO queue_manager_state (
            id,
            version,
            privacy_enabled,
            encrypted_at_rest,
            server_session_id,
            updated_at,
            payload
        )
        VALUES (1, ?, ?, ?, ?, ?, ?)
        """,
        (
            STATE_VERSION,
            1 if privacy_enabled else 0,
            1 if encrypted else 0,
            server_session_id,
            int(state.get("updated_at") or 0),
            sqlite3.Binary(payload),
        ),
    )


def _result(
    state: Mapping[str, Any],
    *,
    privacy_enabled: bool,
    encrypted_at_rest: bool,
    stored_server_session_id: str | None,
) -> dict[str, Any]:
    normalized = normalize_queue_manager_state(state)
    normalized["privacy_enabled"] = bool(privacy_enabled)
    return {
        "ok": True,
        "state": normalized,
        "privacy_enabled": bool(privacy_enabled),
        "encrypted_at_rest": bool(encrypted_at_rest),
        "server_session_id": SERVER_SESSION_ID,
        "stored_server_session_id": stored_server_session_id if isinstance(stored_server_session_id, str) else None,
    }


def _read_legacy_envelope(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _state_from_legacy_envelope(envelope: Mapping[str, Any]) -> dict[str, Any]:
    privacy_enabled = bool(envelope.get("privacy_enabled"))
    payload = envelope.get("payload")

    if privacy_enabled:
        if not isinstance(payload, str):
            raise ValueError("Encrypted queue manager payload is missing.")
        return decrypt_state_payload(payload)
    if isinstance(payload, Mapping):
        return deepcopy(dict(payload))
    if isinstance(envelope.get("state"), Mapping):
        return deepcopy(dict(envelope["state"]))
    return default_queue_manager_state()


def _load_legacy_state(path: Path) -> dict[str, Any] | None:
    envelope = _read_legacy_envelope(path)
    if envelope is None:
        return None
    if not isinstance(envelope, Mapping):
        raise ValueError("Queue manager legacy state is invalid.")
    privacy_enabled = bool(envelope.get("privacy_enabled"))
    state = normalize_queue_manager_state(_state_from_legacy_envelope(envelope))
    state["privacy_enabled"] = privacy_enabled
    stored_session_id = envelope.get("server_session_id")
    return {
        "state": state,
        "privacy_enabled": privacy_enabled,
        "encrypted_at_rest": privacy_enabled,
        "stored_server_session_id": stored_session_id if isinstance(stored_session_id, str) else None,
    }


def _maybe_migrate_legacy_state(path: Path, legacy_path: Path | None) -> dict[str, Any] | None:
    if path.exists() or legacy_path is None or not legacy_path.exists():
        return None

    legacy = _load_legacy_state(legacy_path)
    if legacy is None:
        return None

    CONFIG_DIR.mkdir(exist_ok=True)
    conn = _connect(path)
    try:
        _ensure_schema(conn)
        _write_state_row(
            conn,
            legacy["state"],
            privacy_enabled=bool(legacy["privacy_enabled"]),
            server_session_id=legacy["stored_server_session_id"] or SERVER_SESSION_ID,
        )
        conn.commit()
        if legacy["privacy_enabled"]:
            conn.execute("VACUUM")
    finally:
        conn.close()

    legacy_path.unlink(missing_ok=True)
    return _result(
        legacy["state"],
        privacy_enabled=bool(legacy["privacy_enabled"]),
        encrypted_at_rest=bool(legacy["privacy_enabled"]),
        stored_server_session_id=legacy["stored_server_session_id"],
    )


def _remove_default_legacy_file(path: Path) -> None:
    try:
        if path.resolve() == STATE_DB_PATH.resolve():
            LEGACY_STATE_PATH.unlink(missing_ok=True)
    except Exception:
        pass


def _legacy_path_for_load(path: Path, legacy_path: Path | str | None) -> Path | None:
    if legacy_path is None:
        return None
    legacy = Path(legacy_path)
    try:
        is_default_legacy = legacy.resolve() == LEGACY_STATE_PATH.resolve()
        is_default_state = path.resolve() == STATE_DB_PATH.resolve()
    except Exception:
        is_default_legacy = legacy == LEGACY_STATE_PATH
        is_default_state = path == STATE_DB_PATH
    if is_default_legacy and not is_default_state:
        return None
    return legacy


def load_queue_manager_state(
    path: Path | str = STATE_DB_PATH,
    *,
    legacy_path: Path | str | None = LEGACY_STATE_PATH,
) -> dict[str, Any]:
    path = Path(path)
    legacy = _legacy_path_for_load(path, legacy_path)
    migrated = _maybe_migrate_legacy_state(path, legacy)
    if migrated is not None:
        return migrated

    if not path.exists():
        return {
            "ok": True,
            "state": default_queue_manager_state(),
            "privacy_enabled": True,
            "encrypted_at_rest": False,
            "server_session_id": SERVER_SESSION_ID,
            "stored_server_session_id": None,
        }

    conn = _connect(path)
    try:
        _ensure_schema(conn)
        row = _read_state_row(conn)
        if row is None:
            return {
                "ok": True,
                "state": default_queue_manager_state(),
                "privacy_enabled": True,
                "encrypted_at_rest": False,
                "server_session_id": SERVER_SESSION_ID,
                "stored_server_session_id": None,
            }

        privacy_enabled = bool(row["privacy_enabled"])
        encrypted_at_rest = bool(row["encrypted_at_rest"])
        state = normalize_queue_manager_state(_state_from_bytes(row["payload"], encrypted=encrypted_at_rest))
        state["privacy_enabled"] = privacy_enabled
        return _result(
            state,
            privacy_enabled=privacy_enabled,
            encrypted_at_rest=encrypted_at_rest,
            stored_server_session_id=row["server_session_id"],
        )
    finally:
        conn.close()


def save_queue_manager_state(
    state: Mapping[str, Any],
    *,
    privacy_enabled: bool | None = None,
    path: Path | str = STATE_DB_PATH,
) -> dict[str, Any]:
    path = Path(path)
    CONFIG_DIR.mkdir(exist_ok=True)

    normalized = normalize_queue_manager_state(state)
    if privacy_enabled is not None:
        normalized["privacy_enabled"] = bool(privacy_enabled)

    conn = _connect(path)
    try:
        _ensure_schema(conn)
        row = _read_state_row(conn)
        if row is not None:
            stored_privacy_enabled = bool(row["privacy_enabled"])
            stored_encrypted_at_rest = bool(row["encrypted_at_rest"])
            target_privacy_enabled = bool(normalized["privacy_enabled"])
            if (
                stored_privacy_enabled == target_privacy_enabled
                and stored_encrypted_at_rest == target_privacy_enabled
            ):
                try:
                    stored_state = normalize_queue_manager_state(
                        _state_from_bytes(row["payload"], encrypted=stored_encrypted_at_rest)
                    )
                    stored_state["privacy_enabled"] = stored_privacy_enabled
                    if _same_semantic_state(stored_state, normalized):
                        _remove_default_legacy_file(path)
                        return _result(
                            stored_state,
                            privacy_enabled=stored_privacy_enabled,
                            encrypted_at_rest=stored_encrypted_at_rest,
                            stored_server_session_id=row["server_session_id"],
                        )
                except Exception:
                    pass

        normalized["updated_at"] = int(time.time() * 1000)
        _write_state_row(
            conn,
            normalized,
            privacy_enabled=bool(normalized["privacy_enabled"]),
            server_session_id=SERVER_SESSION_ID,
        )
        conn.commit()
        if normalized["privacy_enabled"]:
            conn.execute("VACUUM")
    finally:
        conn.close()

    _remove_default_legacy_file(path)
    return {
        "ok": True,
        "state": normalized,
        "privacy_enabled": normalized["privacy_enabled"],
        "encrypted_at_rest": normalized["privacy_enabled"],
        "server_session_id": SERVER_SESSION_ID,
    }

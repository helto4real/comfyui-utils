"""Active shared-privacy binding for Queue Manager state.

This module owns only Queue Manager product facts and adapters; encryption,
authorization, revision verification, and legacy-reader policy stay inside
:mod:`helto_privacy`.
"""

from __future__ import annotations

import copy
import json
import sqlite3
from collections.abc import Callable, Mapping
from pathlib import Path

from helto_privacy import (
    AdapterSlot,
    LegacyKeyFormat,
    LegacyKeyImportBinding,
    LegacyLocationKind,
    LegacyReaderBinding,
    PrivacyProfile,
    PrivacyScope,
    PrivateByDefaultModeAdapter,
    ProfileResource,
    ProtectedOperation,
    ResourceKind,
    SingletonDeclaration,
    SingletonPayloadKind,
    SingletonSnapshot,
    UTILS_KEY_BIN_IMPORT_ID,
    UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
    UTILS_QUEUE_CURRENT_JSON_READER_ID,
    UTILS_QUEUE_CURRENT_SQLITE_READER_ID,
    UTILS_QUEUE_JSON_READER_IDS,
    UTILS_QUEUE_SQLITE_READER_IDS,
)

QUEUE_PROFILE_ID = "helto.comfyui-utils"
QUEUE_DISTRIBUTION = "comfyui-utils"
QUEUE_SCOPE_ID = "queue-manager"
QUEUE_SCHEMA = "helto.comfyui-utils"
QUEUE_PURPOSE = "queue-manager-state"
QUEUE_MODE_RESOURCE_ID = "queue-manager-mode"
QUEUE_SINGLETON_RESOURCE_ID = "queue-manager-singleton"
QUEUE_OPERATION_RESOURCE_ID = "queue-manager-operations"
QUEUE_MODE_ADAPTER_ID = "queue-manager-mode-state"
QUEUE_STORE_ADAPTER_ID = "queue-manager-singleton-store"
QUEUE_SINGLETON_ID = "queue-manager-state"

QUEUE_OPERATION_IDS = (
    "queue-manager.load",
    "queue-manager.save",
    "queue-manager.capture",
    "queue-manager.submit",
    "queue-manager.replay",
    "queue-manager.rerun",
    "queue-manager.preview",
    "queue-manager.delete",
    "queue-manager.clear",
)
QUEUE_OPERATION_ADAPTER_IDS = {
    operation_id: operation_id.replace(".", "-") + "-operation"
    for operation_id in QUEUE_OPERATION_IDS
}

_STORE_TABLE = "helto_queue_manager_singleton"
_STORE_FORMAT = "helto.queue-manager.singleton-v1"


def queue_legacy_binding_id(container: str, generation: str) -> str:
    readers = (
        UTILS_QUEUE_JSON_READER_IDS
        if container == "json"
        else UTILS_QUEUE_SQLITE_READER_IDS
        if container == "sqlite"
        else None
    )
    if generation == "current":
        if container not in {"json", "sqlite"}:
            raise ValueError("Unknown Queue Manager legacy binding.")
        return f"queue-manager-{container}-current"
    if readers is None or generation not in readers:
        raise ValueError("Unknown Queue Manager legacy binding.")
    return f"queue-manager-{container}-{generation}"


def build_queue_manager_privacy_profile() -> PrivacyProfile:
    queue_readers = {
        ("json", "current"): UTILS_QUEUE_CURRENT_JSON_READER_ID,
        ("sqlite", "current"): UTILS_QUEUE_CURRENT_SQLITE_READER_ID,
        **{
            ("json", generation): reader
            for generation, reader in UTILS_QUEUE_JSON_READER_IDS.items()
        },
        **{
            ("sqlite", generation): reader
            for generation, reader in UTILS_QUEUE_SQLITE_READER_IDS.items()
        },
    }
    return PrivacyProfile(
        id=QUEUE_PROFILE_ID,
        distribution=QUEUE_DISTRIBUTION,
        resources=(
            ProfileResource(
                QUEUE_MODE_RESOURCE_ID,
                ResourceKind.MODE,
                (QUEUE_MODE_ADAPTER_ID,),
            ),
            ProfileResource(
                QUEUE_SINGLETON_RESOURCE_ID,
                ResourceKind.SINGLETON,
                (QUEUE_STORE_ADAPTER_ID,),
            ),
            ProfileResource(
                QUEUE_OPERATION_RESOURCE_ID,
                ResourceKind.WORKFLOW,
                tuple(QUEUE_OPERATION_ADAPTER_IDS.values()),
            ),
        ),
        server_adapters=(
            AdapterSlot(QUEUE_MODE_ADAPTER_ID, ResourceKind.MODE, QUEUE_MODE_RESOURCE_ID),
            AdapterSlot(
                QUEUE_STORE_ADAPTER_ID,
                ResourceKind.SINGLETON,
                QUEUE_SINGLETON_RESOURCE_ID,
            ),
            *(
                AdapterSlot(
                    adapter_id,
                    ResourceKind.WORKFLOW,
                    QUEUE_OPERATION_RESOURCE_ID,
                )
                for adapter_id in QUEUE_OPERATION_ADAPTER_IDS.values()
            ),
        ),
        scopes=(
            PrivacyScope(QUEUE_SCOPE_ID, QUEUE_MODE_RESOURCE_ID, QUEUE_MODE_ADAPTER_ID),
        ),
        singletons=(
            SingletonDeclaration(
                QUEUE_SINGLETON_ID,
                QUEUE_SINGLETON_RESOURCE_ID,
                QUEUE_SCOPE_ID,
                QUEUE_SCHEMA,
                QUEUE_PURPOSE,
                QUEUE_STORE_ADAPTER_ID,
                SingletonPayloadKind.BLOB,
                legacy_reader_ids=tuple(queue_readers.values()),
            ),
        ),
        protected_operations=tuple(
            ProtectedOperation(
                operation_id,
                QUEUE_OPERATION_RESOURCE_ID,
                QUEUE_OPERATION_ADAPTER_IDS[operation_id],
                "/helto-utils/queue-manager/" + operation_id.rsplit(".", 1)[-1],
                "GET" if operation_id.endswith(".load") else "POST",
            )
            for operation_id in QUEUE_OPERATION_IDS
        ),
        legacy_bindings=tuple(
            LegacyReaderBinding(
                queue_legacy_binding_id(container, generation),
                reader_id,
                QUEUE_SINGLETON_RESOURCE_ID,
                LegacyLocationKind.PACK_STATE,
                QUEUE_SINGLETON_ID,
            )
            for (container, generation), reader_id in queue_readers.items()
        ),
        legacy_key_imports=(
            LegacyKeyImportBinding(
                "queue-manager-key-bin",
                UTILS_KEY_BIN_IMPORT_ID,
                QUEUE_SINGLETON_RESOURCE_ID,
                LegacyLocationKind.PACK_STATE,
                QUEUE_SINGLETON_ID,
                LegacyKeyFormat.BINARY,
            ),
            LegacyKeyImportBinding(
                "queue-manager-privacy-key-bin",
                UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
                QUEUE_SINGLETON_RESOURCE_ID,
                LegacyLocationKind.PACK_STATE,
                QUEUE_SINGLETON_ID,
                LegacyKeyFormat.BINARY,
            ),
        ),
    )


class QueueManagerModeAdapter(PrivateByDefaultModeAdapter):
    """Keep persisted queue state private; no public storage writer exists."""

    def write_declared_mode(self, scope_id: str, mode: object) -> None:
        if scope_id != QUEUE_SCOPE_ID or mode != "private":
            raise ValueError("Queue Manager persistence is always private.")
        super().write_declared_mode(scope_id, mode)


def default_queue_manager_state() -> dict[str, object]:
    return {
        "version": 1,
        "privacy_enabled": True,
        "paused": True,
        "resume_required": False,
        "active_run_id": None,
        "queue": [],
        "history": [],
        "updated_at": None,
    }


def normalize_queue_manager_state(
    state: Mapping[str, object] | None,
) -> dict[str, object]:
    normalized = default_queue_manager_state()
    if isinstance(state, Mapping):
        normalized.update(copy.deepcopy(dict(state)))
    normalized["version"] = 1
    normalized["privacy_enabled"] = bool(normalized.get("privacy_enabled", True))
    normalized["paused"] = bool(normalized.get("paused", True))
    normalized["queue"] = normalized.get("queue") if isinstance(normalized.get("queue"), list) else []
    normalized["history"] = normalized.get("history") if isinstance(normalized.get("history"), list) else []
    active = normalized.get("active_run_id")
    normalized["active_run_id"] = active if isinstance(active, str) and active else None
    return normalized


def normalize_managed_queue_state(value: Mapping[str, object] | None) -> dict[str, object]:
    state = normalize_queue_manager_state(value)
    state["privacy_enabled"] = True
    return state


def semantic_queue_state(value: Mapping[str, object] | None) -> dict[str, object]:
    state = normalize_managed_queue_state(value)
    state.pop("updated_at", None)
    return state


def generic_queue_status(state: Mapping[str, object]) -> dict[str, int]:
    normalized = normalize_managed_queue_state(state)
    queue = normalized["queue"]
    history = normalized["history"]
    return {
        "queued": len(queue),
        "history": len(history),
        "running": sum(
            item.get("status") in {"submitting", "running"}
            for item in queue
            if isinstance(item, Mapping)
        ),
    }


class QueueManagerSingletonStore:
    """SQLite singleton adapter containing only a shared protected envelope."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def read_singleton(self, singleton_id: str) -> SingletonSnapshot:
        _require_singleton(singleton_id)
        if not self.path.exists():
            return SingletonSnapshot(0)
        connection = self._connect()
        try:
            self._ensure_schema(connection)
            row = connection.execute(
                f"SELECT revision, protected FROM {_STORE_TABLE} WHERE id = ?",
                (QUEUE_SINGLETON_ID,),
            ).fetchone()
            if row is None:
                return SingletonSnapshot(0)
            protected = json.loads(row["protected"])
            return SingletonSnapshot(int(row["revision"]), protected)
        except (sqlite3.Error, json.JSONDecodeError, TypeError, ValueError):
            raise ValueError("Queue Manager persistence is invalid.") from None
        finally:
            connection.close()

    def begin_singleton_replace(
        self,
        singleton_id: str,
        expected_revision: int,
        replacement: SingletonSnapshot,
    ) -> "_QueueStoreTransaction":
        _require_singleton(singleton_id)
        return _QueueStoreTransaction(self, expected_revision, replacement)

    def rollback_singleton_replace(
        self,
        singleton_id: str,
        expected: SingletonSnapshot,
        replacement: SingletonSnapshot,
    ) -> bool:
        """Replace one exact committed snapshot with a newer rollback snapshot."""

        _require_singleton(singleton_id)
        if (
            not isinstance(expected, SingletonSnapshot)
            or not isinstance(replacement, SingletonSnapshot)
            or replacement.revision != expected.revision + 1
        ):
            raise ValueError("Queue Manager persistence is invalid.")
        return self._replace(
            expected.revision,
            replacement,
            expected_snapshot=expected,
        )

    def prepare_mode_transition(self, *_args) -> None:
        return None

    def commit_mode_transition(self, *_args) -> None:
        return None

    def rollback_mode_transition(self, *_args) -> None:
        return None

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA secure_delete=ON")
        connection.execute("PRAGMA journal_mode=DELETE")
        return connection

    @staticmethod
    def _ensure_schema(connection: sqlite3.Connection) -> None:
        connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {_STORE_TABLE} (
                id TEXT PRIMARY KEY CHECK (id = '{QUEUE_SINGLETON_ID}'),
                format TEXT NOT NULL CHECK (format = '{_STORE_FORMAT}'),
                revision INTEGER NOT NULL CHECK (revision > 0),
                protected TEXT NOT NULL
            )
            """
        )

    def _replace(
        self,
        expected_revision: int,
        replacement: SingletonSnapshot,
        *,
        expected_snapshot: SingletonSnapshot | None = None,
    ) -> bool:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            self._ensure_schema(connection)
            row = connection.execute(
                f"SELECT revision, protected FROM {_STORE_TABLE} WHERE id = ?",
                (QUEUE_SINGLETON_ID,),
            ).fetchone()
            current_revision = int(row["revision"]) if row is not None else 0
            if current_revision != expected_revision:
                connection.rollback()
                return False
            if expected_snapshot is not None:
                try:
                    current_protected = (
                        json.loads(row["protected"])
                        if row is not None
                        else None
                    )
                    current = SingletonSnapshot(current_revision, current_protected)
                except (json.JSONDecodeError, TypeError, ValueError):
                    connection.rollback()
                    return False
                if current != expected_snapshot:
                    connection.rollback()
                    return False
            if replacement.protected is None:
                connection.execute(
                    f"DELETE FROM {_STORE_TABLE} WHERE id = ?",
                    (QUEUE_SINGLETON_ID,),
                )
            else:
                protected = json.dumps(
                    replacement.protected,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                connection.execute(
                    f"""
                    INSERT INTO {_STORE_TABLE} (id, format, revision, protected)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        format=excluded.format,
                        revision=excluded.revision,
                        protected=excluded.protected
                    """,
                    (QUEUE_SINGLETON_ID, _STORE_FORMAT, replacement.revision, protected),
                )
            connection.commit()
            return True
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()


class _QueueStoreTransaction:
    def __init__(
        self,
        store: QueueManagerSingletonStore,
        expected_revision: int,
        replacement: SingletonSnapshot,
    ) -> None:
        self._store = store
        self._expected_revision = expected_revision
        self._replacement = replacement
        self._original = store.read_singleton(QUEUE_SINGLETON_ID)

    def commit(self) -> bool:
        return self._store._replace(self._expected_revision, self._replacement)

    def read_back(self) -> SingletonSnapshot:
        return self._store.read_singleton(QUEUE_SINGLETON_ID)

    def rollback(self) -> None:
        current = self._store.read_singleton(QUEUE_SINGLETON_ID)
        if current.revision != self._replacement.revision:
            raise RuntimeError("Queue Manager rollback revision changed.")
        if not self._store._replace(current.revision, self._original):
            raise RuntimeError("Queue Manager rollback failed.")


class QueueManagerStateService:
    """Queue-domain normalization over the typed protected singleton handle."""

    def __init__(self, singleton_handle: object) -> None:
        self._handle = singleton_handle

    def status(self) -> dict[str, object]:
        return self._handle.status(QUEUE_SINGLETON_ID).to_payload()

    def load(self, authorization: object) -> dict[str, object]:
        status = self._handle.status(QUEUE_SINGLETON_ID)
        if not status.exists:
            state = normalize_managed_queue_state(default_queue_manager_state())
            return {
                "revision": status.revision,
                "state": state,
                "summary": generic_queue_status(state),
            }
        revealed = self._handle.reveal_blob(QUEUE_SINGLETON_ID, authorization)
        state = decode_managed_queue_state(revealed.value)
        return {
            "revision": revealed.revision,
            "state": state,
            "summary": generic_queue_status(state),
        }

    def save(
        self,
        state: Mapping[str, object],
        expected_revision: int,
        reveal_authorization: object,
        replace_authorization: object,
    ) -> dict[str, object]:
        normalized = normalize_managed_queue_state(state)
        status = self._handle.status(QUEUE_SINGLETON_ID)
        if status.revision != expected_revision:
            raise ValueError("Queue Manager revision changed.")
        if status.exists:
            existing = self._handle.reveal_blob(QUEUE_SINGLETON_ID, reveal_authorization)
            if semantic_queue_state(
                decode_managed_queue_state(existing.value)
            ) == semantic_queue_state(normalized):
                return {"revision": existing.revision, "unchanged": True}
        receipt = self._handle.replace_blob(
            QUEUE_SINGLETON_ID,
            encode_managed_queue_state(normalized),
            expected_revision,
            replace_authorization,
        )
        return {"revision": receipt.revision, "unchanged": False}


class QueueManagerOperationAdapter:
    """One fixed product operation, bound to one profile adapter slot."""

    def __init__(self, operation: Callable[[object, object], object]) -> None:
        if not callable(operation):
            raise TypeError("A Queue Manager product operation is required.")
        self._operation = operation

    def invoke(self, payload: object, context: object) -> object:
        return self._operation(copy.deepcopy(payload), context)


def encode_managed_queue_state(state: Mapping[str, object]) -> bytes:
    return json.dumps(
        normalize_managed_queue_state(state),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def decode_managed_queue_state(value: object) -> dict[str, object]:
    if not isinstance(value, bytes):
        raise ValueError("Queue Manager state payload is invalid.")
    try:
        decoded = json.loads(value.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("Queue Manager state payload is invalid.") from None
    if not isinstance(decoded, Mapping):
        raise ValueError("Queue Manager state payload is invalid.")
    return normalize_managed_queue_state(decoded)


def _require_singleton(singleton_id: str) -> None:
    if singleton_id != QUEUE_SINGLETON_ID:
        raise ValueError("Unknown Queue Manager singleton.")

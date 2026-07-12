"""Verified migration into the managed Queue Manager singleton."""

from __future__ import annotations

import base64
import json
import sqlite3
from collections.abc import Mapping
from pathlib import Path

from helto_privacy import MigrationVerification, PrivacyEnvelopeCodec, SingletonSnapshot

from .queue_manager_managed import (
    QUEUE_PURPOSE,
    QUEUE_SCHEMA,
    QUEUE_SINGLETON_ID,
    QueueManagerSingletonStore,
    decode_managed_queue_state,
    encode_managed_queue_state,
    normalize_managed_queue_state,
    queue_legacy_binding_id,
)


_LEGACY_TABLE = "queue_manager_state"


class QueueManagerMigrationCoordinator:
    """Migrate current wrappers or one declared historical generation."""

    def __init__(self, migration_handle: object, store: QueueManagerSingletonStore) -> None:
        self._migration = migration_handle
        self._store = store

    def migrate_json(
        self,
        source_path: str | Path,
        *,
        generation: str,
        read_authorization: object | None = None,
        complete_authorization: object | None = None,
    ) -> object:
        path = Path(source_path)
        try:
            source = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            raise ValueError("Queue Manager JSON migration source is invalid.") from None
        if not isinstance(source, Mapping):
            raise ValueError("Queue Manager JSON migration source is invalid.")
        transaction = QueueManagerMigrationTransaction(self._store, path, "json")
        discovered = self._migration.discover_and_read(
            queue_legacy_binding_id("json", generation),
            source,
            read_authorization,
        )
        if discovered is None:
            raise ValueError("Queue Manager historical JSON was not recognized.")
        return self._migration.complete(
            discovered.obligation.id,
            normalize_managed_queue_state(discovered.value),
            transaction,
            complete_authorization,
        )

    def migrate_sqlite(
        self,
        source_path: str | Path,
        *,
        generation: str,
        read_authorization: object | None = None,
        complete_authorization: object | None = None,
    ) -> object:
        path = Path(source_path)
        row = _read_legacy_sqlite_row(path)
        transaction = QueueManagerMigrationTransaction(self._store, path, "sqlite")
        source = {**row, "payload": base64.b64encode(row["payload"]).decode("ascii")}
        discovered = self._migration.discover_and_read(
            queue_legacy_binding_id("sqlite", generation),
            source,
            read_authorization,
        )
        if discovered is None:
            raise ValueError("Queue Manager historical SQLite was not recognized.")
        return self._migration.complete(
            discovered.obligation.id,
            normalize_managed_queue_state(discovered.value),
            transaction,
            complete_authorization,
        )


class QueueManagerMigrationTransaction:
    """Write, read back, and only then retire one legacy container."""

    def __init__(
        self,
        store: QueueManagerSingletonStore,
        source_path: Path,
        container: str,
    ) -> None:
        if container not in {"json", "sqlite"} or not source_path.is_file():
            raise ValueError("Queue Manager migration source is missing.")
        self._store = store
        self._source_path = source_path
        self._container = container
        self._source_bytes = source_path.read_bytes()
        self._expected: dict[str, object] | None = None
        self._replacement: SingletonSnapshot | None = None

    def capture_original(self) -> bytes:
        return bytes(self._source_bytes)

    def stage_current(self, normalized: object) -> None:
        if not isinstance(normalized, Mapping):
            raise ValueError("Queue Manager migration state is invalid.")
        self._expected = normalize_managed_queue_state(normalized)
        protected = PrivacyEnvelopeCodec(QUEUE_SCHEMA).encrypt_bytes(
            encode_managed_queue_state(self._expected),
            QUEUE_PURPOSE,
        )
        self._replacement = SingletonSnapshot(1, protected)

    def stage_durable_adjuncts(self, _normalized: object) -> None:
        return None

    def commit(self) -> None:
        if self._replacement is None or self._source_path.read_bytes() != self._source_bytes:
            raise RuntimeError("Queue Manager migration source changed.")
        if self._store.read_singleton(QUEUE_SINGLETON_ID).revision != 0:
            raise RuntimeError("Queue Manager managed state already exists.")
        if not _replace_snapshot(self._store, 0, self._replacement):
            raise RuntimeError("Queue Manager managed state changed.")

    def read_back(self) -> MigrationVerification:
        snapshot = self._store.read_singleton(QUEUE_SINGLETON_ID)
        try:
            value = PrivacyEnvelopeCodec(QUEUE_SCHEMA).decrypt_bytes(
                snapshot.protected,
                QUEUE_PURPOSE,
            )
            normalized = decode_managed_queue_state(value)
        except Exception:
            raise RuntimeError("Queue Manager migration read-back failed.") from None
        return MigrationVerification(
            normalized=normalized,
            current_format=snapshot.revision > 0,
            durable_artifacts_current=True,
        )

    def rollback(self, _original: object) -> None:
        current = self._store.read_singleton(QUEUE_SINGLETON_ID)
        if current.revision == 0:
            return
        if current.revision != 1:
            raise RuntimeError("Queue Manager migration rollback revision changed.")
        if not _replace_snapshot(
            self._store,
            current.revision,
            SingletonSnapshot(0),
        ):
            raise RuntimeError("Queue Manager migration rollback failed.")

    def finalize(self, _original: object) -> None:
        if self._store.read_singleton(QUEUE_SINGLETON_ID).revision < 1:
            raise RuntimeError("Queue Manager migration was not committed.")
        same_path = self._source_path.resolve() == self._store.path.resolve()
        if self._container == "sqlite" and same_path:
            connection = sqlite3.connect(self._source_path)
            try:
                connection.execute(f"DROP TABLE IF EXISTS {_LEGACY_TABLE}")
                connection.commit()
            finally:
                connection.close()
        else:
            if self._source_path.read_bytes() != self._source_bytes:
                raise RuntimeError("Queue Manager migration source changed before retirement.")
            self._source_path.unlink()


def _replace_snapshot(
    store: QueueManagerSingletonStore,
    expected_revision: int,
    replacement: SingletonSnapshot,
) -> bool:
    transaction = store.begin_singleton_replace(
        QUEUE_SINGLETON_ID,
        expected_revision,
        replacement,
    )
    committed = transaction.commit()
    if committed is not True:
        return False
    persisted = transaction.read_back()
    if (
        persisted.revision != replacement.revision
        or persisted.protected != replacement.protected
    ):
        transaction.rollback()
        raise RuntimeError("Queue Manager singleton verification failed.")
    return True


def _read_legacy_sqlite_row(path: Path) -> dict[str, object]:
    if not path.is_file():
        raise ValueError("Queue Manager SQLite migration source is missing.")
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        row = connection.execute(
            f"""
            SELECT version, privacy_enabled, encrypted_at_rest,
                   server_session_id, updated_at, payload
            FROM {_LEGACY_TABLE}
            WHERE id = 1
            """
        ).fetchone()
    except sqlite3.Error:
        raise ValueError("Queue Manager SQLite migration source is invalid.") from None
    finally:
        connection.close()
    if row is None:
        raise ValueError("Queue Manager SQLite migration source is invalid.")
    return {
        "version": int(row["version"]),
        "privacy_enabled": bool(row["privacy_enabled"]),
        "encrypted_at_rest": bool(row["encrypted_at_rest"]),
        "server_session_id": row["server_session_id"],
        "updated_at": int(row["updated_at"]),
        "payload": bytes(row["payload"]),
    }

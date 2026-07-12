from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

import helto_privacy.keystore as keystore
import helto_privacy.runtime as runtime
import helto_privacy.singletons as singletons
from helto_privacy import (
    LegacyKeyFormat,
    MigrationError,
    PrivacyEnvelopeCodec,
    SingletonSnapshot,
    UTILS_KEY_BIN_IMPORT_ID,
    UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
    install,
    register_legacy_reader_units,
    utils_legacy_reader_units,
)
import helto_privacy.migration as migration
from helto_privacy.guard import authorize_privacy_request
from shared.queue_manager_managed import (
    QUEUE_PURPOSE,
    QUEUE_SCHEMA,
    QUEUE_OPERATION_IDS,
    QUEUE_OPERATION_ADAPTER_IDS,
    QUEUE_SCOPE_ID,
    QUEUE_SINGLETON_ID,
    QUEUE_SINGLETON_RESOURCE_ID,
    QueueManagerModeAdapter,
    QueueManagerOperationAdapter,
    QueueManagerSingletonStore,
    QueueManagerStateService,
    build_queue_manager_privacy_profile,
    generic_queue_status,
    normalize_managed_queue_state,
    queue_legacy_binding_id,
    semantic_queue_state,
)
from shared.queue_manager_managed_migration import QueueManagerMigrationCoordinator


HISTORICAL_FIXTURE = (
    Path(__file__).parent / "fixtures" / "historical" / "utils_legacy_formats.json"
)


pytestmark = pytest.mark.usefixtures("coordinated_suite_test_boundary")


class Request:
    def __init__(self, token: str) -> None:
        self.headers = {"X-Helto-Privacy-Token": token}
        self.cookies = {}


def authorization(pack, token: str, operation: str):
    return authorize_privacy_request(Request(token), operation, pack_id=pack.profile.id)


def migration_authorizations(pack, token: str) -> dict[str, object]:
    return {
        "read_authorization": authorization(pack, token, "migration.read"),
        "complete_authorization": authorization(pack, token, "migration.complete"),
        "protect_authorization": authorization(pack, token, "singleton.replace"),
        "reveal_authorization": authorization(pack, token, "singleton.reveal"),
    }


def queue_migration(pack, store):
    return QueueManagerMigrationCoordinator(
        pack.migration,
        pack.singletons(QUEUE_SINGLETON_RESOURCE_ID),
        store,
    )


def installed_queue(
    tmp_path: Path,
    monkeypatch,
    store: QueueManagerSingletonStore | None = None,
):
    monkeypatch.setenv("HELTO_PRIVACY_KEYSTORE", str(tmp_path / "keystore.json"))
    monkeypatch.setenv("HELTO_PRIVACY_SESSION_DIR", str(tmp_path / "session"))
    monkeypatch.setenv(
        migration.MIGRATION_STATE_ENV,
        str(tmp_path / "migration.json"),
    )
    monkeypatch.setattr(runtime, "_INSTALLATIONS", {})
    monkeypatch.setattr(runtime, "register_helto_privacy_ui", lambda **_kwargs: True)
    monkeypatch.setattr(
        "helto_privacy.suite_runtime.require_active_process_suite",
        lambda: None,
    )
    monkeypatch.setattr(keystore, "SCRYPT_N", 2**12)
    singletons.reset_singleton_runtime_for_tests()
    migration.reset_migration_runtime_for_tests()
    register_legacy_reader_units(utils_legacy_reader_units())
    store = store or QueueManagerSingletonStore(tmp_path / "queue.sqlite3")
    pack = install(
        build_queue_manager_privacy_profile(),
        {
            "queue-manager-mode-state": QueueManagerModeAdapter(),
            "queue-manager-singleton-store": store,
            **{
                adapter_id: QueueManagerOperationAdapter(
                    lambda _payload, _context: None
                )
                for adapter_id in QUEUE_OPERATION_ADAPTER_IDS.values()
            },
        },
    )
    token = keystore.initialize_keystore("synthetic queue password")["token"]
    return pack, store, token


def import_historical_queue_keys(pack, token: str, tmp_path: Path) -> str:
    for import_id, filename, label in (
        (
            UTILS_KEY_BIN_IMPORT_ID,
            "key.bin",
            "helto-utils-key-bin-historical-fixture-key",
        ),
        (
            UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
            "privacy_key.bin",
            "helto-utils-privacy-key-bin-historical-fixture-key",
        ),
    ):
        source = tmp_path / filename
        source.write_bytes(hashlib.sha256(label.encode("utf-8")).digest())
        pack.migration.import_legacy_key_source(
            import_id,
            source,
            "synthetic queue password",
            LegacyKeyFormat.BINARY,
            authorization(pack, token, "migration.key-import"),
        )
        token = keystore.session_token()
    return token


def test_profile_declares_private_singleton_operations_and_exact_legacy_readers():
    profile = build_queue_manager_privacy_profile()

    assert [scope.id for scope in profile.scopes] == ["queue-manager"]
    singleton = profile.singletons[0]
    assert singleton.id == QUEUE_SINGLETON_ID
    assert singleton.resource_id == QUEUE_SINGLETON_RESOURCE_ID
    assert singleton.payload_kind.value == "blob"
    assert singleton.purpose == "queue-manager-state"
    assert {operation.id for operation in profile.protected_operations} == set(
        QUEUE_OPERATION_IDS
    )
    assert len(profile.legacy_bindings) == 8
    assert {
        binding.id for binding in profile.legacy_bindings
    } == {
        queue_legacy_binding_id(container, generation)
        for container in ("json", "sqlite")
        for generation in ("current", "priv1", "priv2", "priv3")
    }
    assert {item.import_id for item in profile.legacy_key_imports} == {
        UTILS_KEY_BIN_IMPORT_ID,
        UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
    }


def test_normalization_is_private_by_default_and_semantic_comparison_ignores_clock():
    normalized = normalize_managed_queue_state({"privacy_enabled": False})
    assert normalized["privacy_enabled"] is True
    assert normalized["paused"] is True
    mode = QueueManagerModeAdapter()
    assert mode.read_declared_mode(QUEUE_SCOPE_ID) == "private"
    with pytest.raises(ValueError, match="always private"):
        mode.write_declared_mode(QUEUE_SCOPE_ID, "public")

    left = {**normalized, "updated_at": 1}
    right = {**normalized, "updated_at": 999}
    assert semantic_queue_state(left) == semantic_queue_state(right)
    assert generic_queue_status({
        **normalized,
        "queue": [{"status": "running"}, {"status": "pending"}],
        "history": [{"status": "completed"}],
    }) == {"queued": 2, "history": 1, "running": 1}


def test_store_persists_one_revisioned_protected_row_without_plaintext(tmp_path, monkeypatch):
    pack, store, token = installed_queue(tmp_path, monkeypatch)
    service = QueueManagerStateService(pack.singletons(QUEUE_SINGLETON_RESOURCE_ID))
    state = normalize_managed_queue_state({
        "queue": [{
            "id": "synthetic-run",
            "status": "pending",
            "title": "synthetic private workflow",
            "prompt": {"workflow": {"name": "synthetic graph"}},
        }],
    })

    saved = service.save(
        state,
        0,
        authorization(pack, token, "singleton.reveal"),
        authorization(pack, token, "singleton.replace"),
    )
    raw = store.path.read_bytes()
    loaded = service.load(authorization(pack, token, "singleton.reveal"))

    assert saved == {"revision": 1, "unchanged": False}
    assert loaded["revision"] == 1
    assert loaded["state"]["queue"][0]["title"] == "synthetic private workflow"
    assert loaded["summary"] == {"queued": 1, "history": 0, "running": 0}
    connection = store._connect()
    row_count = connection.execute(
        "SELECT COUNT(*) FROM helto_queue_manager_singleton"
    ).fetchone()[0]
    connection.close()
    assert row_count == 1
    assert b"synthetic private workflow" not in raw
    assert b"synthetic graph" not in raw
    snapshot = store.read_singleton(QUEUE_SINGLETON_ID)
    assert "synthetic" not in repr(snapshot)


def test_semantically_unchanged_save_keeps_revision_and_ciphertext(tmp_path, monkeypatch):
    pack, store, token = installed_queue(tmp_path, monkeypatch)
    service = QueueManagerStateService(pack.singletons(QUEUE_SINGLETON_RESOURCE_ID))
    state = normalize_managed_queue_state({"queue": [{"id": "run", "status": "pending"}]})
    service.save(
        state,
        0,
        authorization(pack, token, "singleton.reveal"),
        authorization(pack, token, "singleton.replace"),
    )
    before = store.path.read_bytes()
    state["updated_at"] = 123456
    result = service.save(
        state,
        1,
        authorization(pack, token, "singleton.reveal"),
        authorization(pack, token, "singleton.replace"),
    )

    assert result == {"revision": 1, "unchanged": True}
    assert store.path.read_bytes() == before


def test_locked_store_exposes_only_generic_status(tmp_path, monkeypatch):
    pack, _store, token = installed_queue(tmp_path, monkeypatch)
    service = QueueManagerStateService(pack.singletons(QUEUE_SINGLETON_RESOURCE_ID))
    service.save(
        normalize_managed_queue_state({"queue": [{"title": "hidden"}]}),
        0,
        authorization(pack, token, "singleton.reveal"),
        authorization(pack, token, "singleton.replace"),
    )
    keystore.lock_keystore()

    assert service.status() == {
        "exists": True,
        "revision": 1,
        "private": True,
        "currentFormat": True,
    }
    with pytest.raises(Exception) as exc_info:
        service.load(authorization(pack, token, "singleton.reveal"))
    assert "hidden" not in str(exc_info.value)


def test_store_rejects_malformed_current_row(tmp_path):
    path = tmp_path / "queue.sqlite3"
    store = QueueManagerSingletonStore(path)
    connection = store._connect()
    store._ensure_schema(connection)
    connection.execute(
        """
        INSERT INTO helto_queue_manager_singleton
            (id, format, revision, protected)
        VALUES (?, ?, ?, ?)
        """,
        (QUEUE_SINGLETON_ID, "helto.queue-manager.singleton-v1", 1, "not-json"),
    )
    connection.commit()
    connection.close()

    with pytest.raises(ValueError, match="persistence is invalid"):
        store.read_singleton(QUEUE_SINGLETON_ID)


def test_current_json_migrates_only_after_managed_readback(tmp_path, monkeypatch):
    pack, target, token = installed_queue(tmp_path, monkeypatch)
    source = tmp_path / "queue_manager_state.json"
    state = normalize_managed_queue_state({
        "queue": [{"id": "json-current", "title": "private json", "status": "pending"}],
    })
    payload = PrivacyEnvelopeCodec(QUEUE_SCHEMA).encrypt_state({"state": state})
    source.write_text(json.dumps({
        "version": 1,
        "privacy_enabled": True,
        "server_session_id": "synthetic-session",
        "payload": json.dumps(payload, sort_keys=True, separators=(",", ":")),
    }), encoding="utf-8")

    receipt = queue_migration(pack, target).migrate_json(
        source,
        generation="current",
        **migration_authorizations(pack, token),
    )
    snapshot = target.read_singleton(QUEUE_SINGLETON_ID)
    migrated = json.loads(
        PrivacyEnvelopeCodec(QUEUE_SCHEMA).decrypt_bytes(
            snapshot.protected,
            QUEUE_PURPOSE,
        ).decode("utf-8")
    )

    assert receipt.obligation_id.startswith("hp-obligation-")
    assert migrated["queue"][0]["id"] == "json-current"
    assert not source.exists()
    assert b"private json" not in target.path.read_bytes()


def test_current_sqlite_migrates_and_retires_legacy_container(tmp_path, monkeypatch):
    pack, target, token = installed_queue(tmp_path, monkeypatch)
    path = tmp_path / "queue.sqlite3"
    state = normalize_managed_queue_state({
        "history": [{"id": "sqlite-current", "title": "private sqlite", "status": "completed"}],
    })
    protected = PrivacyEnvelopeCodec(QUEUE_SCHEMA).encrypt_bytes(
        json.dumps(state, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        QUEUE_PURPOSE,
    )
    connection = sqlite3.connect(path)
    connection.execute(
        """
        CREATE TABLE queue_manager_state (
            id INTEGER PRIMARY KEY,
            version INTEGER,
            privacy_enabled INTEGER,
            encrypted_at_rest INTEGER,
            server_session_id TEXT,
            updated_at INTEGER,
            payload BLOB
        )
        """
    )
    connection.execute(
        "INSERT INTO queue_manager_state VALUES (1, 1, 1, 1, ?, ?, ?)",
        (
            "synthetic-session",
            10,
            json.dumps(protected, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        ),
    )
    connection.commit()
    connection.close()

    receipt = queue_migration(
        pack,
        target,
    ).migrate_sqlite(
        path,
        generation="current",
        **migration_authorizations(pack, token),
    )
    connection = sqlite3.connect(path)
    tables = {
        row[0]
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    connection.close()

    assert receipt.obligation_id.startswith("hp-obligation-")
    assert "queue_manager_state" not in tables
    assert "helto_queue_manager_singleton" in tables
    assert b"private sqlite" not in path.read_bytes()


@pytest.mark.parametrize("container", ("json", "sqlite"))
def test_current_plaintext_state_is_rewritten_private(container, tmp_path, monkeypatch):
    pack, target, token = installed_queue(tmp_path, monkeypatch)
    state = {
        **normalize_managed_queue_state({
            "queue": [{"id": "plaintext-current", "title": "must encrypt"}],
        }),
        "privacy_enabled": False,
    }
    coordinator = queue_migration(pack, target)
    if container == "json":
        source = tmp_path / "queue_manager_state.json"
        source.write_text(json.dumps({
            "version": 1,
            "privacy_enabled": False,
            "server_session_id": "synthetic-session",
            "payload": state,
        }), encoding="utf-8")
        coordinator.migrate_json(
            source,
            generation="current",
            **migration_authorizations(pack, token),
        )
    else:
        source = tmp_path / "queue_manager_state.sqlite3"
        connection = sqlite3.connect(source)
        connection.execute(
            """
            CREATE TABLE queue_manager_state (
                id INTEGER PRIMARY KEY,
                version INTEGER,
                privacy_enabled INTEGER,
                encrypted_at_rest INTEGER,
                server_session_id TEXT,
                updated_at INTEGER,
                payload BLOB
            )
            """
        )
        connection.execute(
            "INSERT INTO queue_manager_state VALUES (1, 1, 0, 0, ?, 10, ?)",
            (
                "synthetic-session",
                json.dumps(state, sort_keys=True, separators=(",", ":")).encode(),
            ),
        )
        connection.commit()
        connection.close()
        coordinator.migrate_sqlite(
            source,
            generation="current",
            **migration_authorizations(pack, token),
        )

    snapshot = target.read_singleton(QUEUE_SINGLETON_ID)
    migrated = json.loads(
        PrivacyEnvelopeCodec(QUEUE_SCHEMA).decrypt_bytes(
            snapshot.protected,
            QUEUE_PURPOSE,
        ).decode("utf-8")
    )
    assert migrated["privacy_enabled"] is True
    assert migrated["queue"][0]["title"] == "must encrypt"
    assert b"must encrypt" not in target.path.read_bytes()
    assert not source.exists()


def test_failed_migration_readback_rolls_back_and_keeps_source(tmp_path, monkeypatch):
    class CorruptOnceStore(QueueManagerSingletonStore):
        corrupt_once = True

        def read_singleton(self, singleton_id):
            snapshot = super().read_singleton(singleton_id)
            if snapshot.revision == 1 and self.corrupt_once:
                self.corrupt_once = False
                return SingletonSnapshot(1, {"malformed": True})
            return snapshot

    target = CorruptOnceStore(tmp_path / "managed.sqlite3")
    pack, target, token = installed_queue(tmp_path, monkeypatch, target)
    source = tmp_path / "queue_manager_state.json"
    state = normalize_managed_queue_state({"queue": [{"id": "must-survive"}]})
    payload = PrivacyEnvelopeCodec(QUEUE_SCHEMA).encrypt_state({"state": state})
    source.write_text(json.dumps({
        "version": 1,
        "privacy_enabled": True,
        "server_session_id": "synthetic-session",
        "payload": json.dumps(payload, sort_keys=True, separators=(",", ":")),
    }), encoding="utf-8")

    with pytest.raises(MigrationError) as exc_info:
        queue_migration(pack, target).migrate_json(
            source,
            generation="current",
            **migration_authorizations(pack, token),
        )

    assert exc_info.value.code == "migration_transaction_failed"
    assert source.exists()
    assert target.read_singleton(QUEUE_SINGLETON_ID).revision == 0


def test_finalize_pending_migration_recovers_after_restart(tmp_path, monkeypatch):
    pack, target, token = installed_queue(tmp_path, monkeypatch)
    source = tmp_path / "queue_manager_state.json"
    state = normalize_managed_queue_state({"queue": [{"id": "recoverable"}]})
    payload = PrivacyEnvelopeCodec(QUEUE_SCHEMA).encrypt_state({"state": state})
    source.write_text(json.dumps({
        "version": 1,
        "privacy_enabled": True,
        "server_session_id": "synthetic-session",
        "payload": json.dumps(payload, sort_keys=True, separators=(",", ":")),
    }), encoding="utf-8")
    original_unlink = Path.unlink
    fail_once = True

    def interrupted_unlink(path, *args, **kwargs):
        nonlocal fail_once
        if path == source and fail_once:
            fail_once = False
            raise OSError("synthetic interruption")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", interrupted_unlink)
    coordinator = queue_migration(pack, target)
    with pytest.raises(MigrationError) as exc_info:
        coordinator.migrate_json(
            source,
            generation="current",
            **migration_authorizations(pack, token),
        )
    assert exc_info.value.code == "migration_finalization_pending"
    assert source.exists()
    assert target.read_singleton(QUEUE_SINGLETON_ID).revision == 1

    receipt = queue_migration(pack, target).migrate_json(
        source,
        generation="current",
        **migration_authorizations(pack, token),
    )

    assert receipt.obligation_id.startswith("hp-obligation-")
    assert not source.exists()
    assert target.read_singleton(QUEUE_SINGLETON_ID).revision == 1


@pytest.mark.parametrize("container", ("json", "sqlite"))
@pytest.mark.parametrize("generation", ("priv1", "priv2", "priv3"))
def test_genuine_historical_queue_forms_migrate_through_exact_readers(
    tmp_path,
    monkeypatch,
    container,
    generation,
):
    pack, target, token = installed_queue(tmp_path, monkeypatch)
    token = import_historical_queue_keys(pack, token, tmp_path)
    fixture = json.loads(HISTORICAL_FIXTURE.read_text(encoding="utf-8"))
    item = fixture["generations"][generation]
    coordinator = queue_migration(pack, target)

    if container == "json":
        source = tmp_path / "queue_manager_state.json"
        source.write_text(json.dumps(item["queueJson"]["value"]), encoding="utf-8")
        receipt = coordinator.migrate_json(
            source,
            generation=generation,
            **migration_authorizations(pack, token),
        )
    else:
        source = tmp_path / "queue_manager_state.sqlite3"
        value = item["queueSqlite"]["value"]
        connection = sqlite3.connect(source)
        connection.execute(
            """
            CREATE TABLE queue_manager_state (
                id INTEGER PRIMARY KEY,
                version INTEGER,
                privacy_enabled INTEGER,
                encrypted_at_rest INTEGER,
                server_session_id TEXT,
                updated_at INTEGER,
                payload BLOB
            )
            """
        )
        connection.execute(
            "INSERT INTO queue_manager_state VALUES (1, ?, ?, ?, ?, ?, ?)",
            (
                value["version"],
                int(value["privacy_enabled"]),
                int(value["encrypted_at_rest"]),
                value["server_session_id"],
                value["updated_at"],
                base64.b64decode(value["payload"]),
            ),
        )
        connection.commit()
        connection.close()
        receipt = coordinator.migrate_sqlite(
            source,
            generation=generation,
            **migration_authorizations(pack, token),
        )

    snapshot = target.read_singleton(QUEUE_SINGLETON_ID)
    migrated = json.loads(
        PrivacyEnvelopeCodec(QUEUE_SCHEMA).decrypt_bytes(
            snapshot.protected,
            QUEUE_PURPOSE,
        ).decode("utf-8")
    )
    assert receipt.obligation_id.startswith("hp-obligation-")
    assert migrated == normalize_managed_queue_state(fixture["expected"]["queue"])
    assert not source.exists()

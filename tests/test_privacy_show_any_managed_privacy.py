from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

import helto_privacy.keystore as shared_keystore
import helto_privacy.migration as shared_migration
import helto_privacy.runtime as shared_runtime
import helto_privacy.suite_runtime as shared_suite_runtime
from helto_privacy import (
    LegacyKeyFormat,
    PrivacyAuthorizationError,
    PrivacyEnvelopeCodec,
    UTILS_KEY_BIN_IMPORT_ID,
    UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
    UTILS_WORKFLOW_READER_IDS,
    install,
    register_legacy_reader_units,
    utils_legacy_reader_units,
)
from helto_privacy.guard import authorize_privacy_request
from shared.privacy_show_any_managed import (
    PRIVACY_SHOW_ANY_DISPLAY_OPERATION_ID,
    PRIVACY_SHOW_ANY_FIELD_ID,
    PrivacyShowAnyDisplayOperationAdapter,
    PrivacyShowAnyManagedNodeAdapter,
    PrivacyShowAnyModeAdapter,
    PrivacyShowAnyProtectedOperations,
    PrivacyShowAnyWorkflowStateAdapter,
    build_privacy_show_any_profile,
)
from shared.privacy_show_any_migration import (
    PrivacyShowAnyMigrationAuthorizations,
    PrivacyShowAnyMigrationCoordinator,
)


pytestmark = pytest.mark.usefixtures("coordinated_suite_test_boundary")


class Request:
    def __init__(self, token: str) -> None:
        self.headers = {"X-Helto-Privacy-Token": token}
        self.cookies = {}


class InstalledOperationAdapter:
    def invoke(self, *_args):
        return None


class MirrorStore:
    def __init__(self, projections: dict[str, object]) -> None:
        self.projections = dict(projections)
        self.fail_next_replace = False

    def read_projections(self) -> dict[str, object]:
        return dict(self.projections)

    def replace_projections(self, projections: dict[str, object]) -> None:
        if self.fail_next_replace:
            self.fail_next_replace = False
            raise OSError("synthetic mirror persistence failure")
        self.projections = dict(projections)


def _authorization(pack, token: str, operation: str):
    return authorize_privacy_request(
        Request(token),
        operation,
        pack_id=pack.profile.id,
    )


def _installed_pack(tmp_path, monkeypatch):
    monkeypatch.setenv("HELTO_PRIVACY_KEYSTORE", str(tmp_path / "keystore.json"))
    monkeypatch.setenv("HELTO_PRIVACY_SESSION_DIR", str(tmp_path / "session"))
    monkeypatch.setenv(
        shared_migration.MIGRATION_STATE_ENV,
        str(tmp_path / "migration.json"),
    )
    monkeypatch.setattr(shared_runtime, "_INSTALLATIONS", {})
    monkeypatch.setattr(shared_runtime, "register_helto_privacy_ui", lambda **_kwargs: True)
    monkeypatch.setattr(shared_suite_runtime, "require_active_process_suite", lambda: None)
    monkeypatch.setattr(shared_keystore, "SCRYPT_N", 2**12)
    shared_migration.reset_migration_runtime_for_tests()
    register_legacy_reader_units(utils_legacy_reader_units())
    state = PrivacyShowAnyWorkflowStateAdapter()
    pack = install(
        build_privacy_show_any_profile(),
        {
            "privacy-show-any-mode-state": PrivacyShowAnyModeAdapter(),
            "privacy-show-any-workflow-state": state,
            "privacy-show-any-display-operation": InstalledOperationAdapter(),
        },
    )
    password = "synthetic show-any password"
    token = shared_keystore.initialize_keystore(password)["token"]
    for import_id, filename, label in (
        (
            UTILS_KEY_BIN_IMPORT_ID,
            "key.bin",
            b"helto-utils-key-bin-historical-fixture-key",
        ),
        (
            UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
            "privacy_key.bin",
            b"helto-utils-privacy-key-bin-historical-fixture-key",
        ),
    ):
        source = tmp_path / filename
        source.write_bytes(hashlib.sha256(label).digest())
        pack.migration.import_legacy_key_source(
            import_id,
            source,
            password,
            LegacyKeyFormat.BINARY,
            _authorization(pack, token, "migration.key-import"),
        )
        token = shared_keystore.session_token()
    return pack, state, token


def _fixture() -> dict:
    return json.loads(
        (
            Path(__file__).parent
            / "fixtures"
            / "historical"
            / "utils_legacy_formats.json"
        ).read_text(encoding="utf-8")
    )


def test_profile_declares_one_mirrored_field_and_protected_display_operation():
    profile = build_privacy_show_any_profile()

    assert [scope.id for scope in profile.scopes] == ["privacy-show-any"]
    assert [field.id for field in profile.protected_fields] == [
        PRIVACY_SHOW_ANY_FIELD_ID
    ]
    assert [operation.id for operation in profile.protected_operations] == [
        PRIVACY_SHOW_ANY_DISPLAY_OPERATION_ID
    ]
    assert len(profile.legacy_bindings) == 4
    assert {binding.reader_id for binding in profile.legacy_bindings} == set(
        UTILS_WORKFLOW_READER_IDS.values()
    )
    assert {binding.location_id for binding in profile.legacy_bindings} == {
        PRIVACY_SHOW_ANY_FIELD_ID
    }
    assert [(location.kind.value, location.name) for location in profile.protected_fields[0].mirror_locations] == [
        ("widget", "encrypted_text_state")
    ]
    assert profile.fingerprint == build_privacy_show_any_profile().fingerprint


def test_mode_and_state_are_private_by_default_and_use_bounded_product_text():
    profile = build_privacy_show_any_profile()
    field = profile.protected_fields[0]
    mode = PrivacyShowAnyModeAdapter()
    state = PrivacyShowAnyWorkflowStateAdapter()

    assert mode.read_declared_mode("privacy-show-any") == "private"
    assert state.normalize({"value": {"prompt": "hello"}}, field) == {
        "value": '{\n  "prompt": "hello"\n}'
    }
    long_text = "x" * 200_010
    normalized = state.normalize(long_text, field)["value"]
    assert normalized.startswith("x" * 200_000)
    assert normalized.endswith("<truncated 10 character(s)>")
    assert state.normalize(normalized, field)["value"] == normalized


def test_managed_node_output_contains_one_envelope_and_no_plaintext(tmp_path, monkeypatch):
    pack, _state, token = _installed_pack(tmp_path, monkeypatch)

    class Output:
        def __init__(self, text, ui):
            self.text = text
            self.kwargs = {"ui": ui}

        def __getitem__(self, index):
            if index != 0:
                raise IndexError(index)
            return self.text

    adapter = PrivacyShowAnyManagedNodeAdapter(Output)

    result = adapter.invoke(
        {"prompt": "SYNTHETIC_PRIVATE_DISPLAY_CANARY"},
        pack.workflow("privacy-show-any-workflow"),
    )

    assert "SYNTHETIC_PRIVATE_DISPLAY_CANARY" in result[0]
    ui = result.kwargs["ui"]["helto_privacy_show_any"][0]
    assert set(ui) == {"protected"}
    assert isinstance(ui["protected"], str)
    assert "SYNTHETIC_PRIVATE_DISPLAY_CANARY" not in json.dumps(ui)
    assert PrivacyEnvelopeCodec("helto.comfyui-utils").decrypt_state(
        ui["protected"]
    ) == {"value": result[0]}


@pytest.mark.parametrize("generation", ("raw-xor", "priv1", "priv2", "priv3"))
def test_mirrored_legacy_migration_writes_one_current_envelope_and_receipt(
    generation,
    tmp_path,
    monkeypatch,
):
    pack, _state, token = _installed_pack(tmp_path, monkeypatch)
    sources = _fixture()["generations"][generation]["privacyShowAnyMigration"]
    store = MirrorStore(
        {
            "widget": sources["widget"]["workflow"],
            "property": sources["property"]["workflow"],
        }
    )
    coordinator = PrivacyShowAnyMigrationCoordinator(
        pack.migration,
        pack.workflow("privacy-show-any-workflow"),
        store,
    )

    receipt = coordinator.migrate(
        generation,
        PrivacyShowAnyMigrationAuthorizations(
            read=_authorization(pack, token, "migration.read"),
            complete=_authorization(pack, token, "migration.complete"),
            protect=_authorization(pack, token, "snapshot.protect"),
            inspect=_authorization(pack, token, "snapshot.disposition"),
            reveal=_authorization(pack, token, "snapshot.reveal"),
        ),
    )

    assert receipt.disposition == "migrated"
    assert len(receipt.obligation_ids) == 2
    assert store.projections["widget"] == store.projections["property"]
    assert PrivacyEnvelopeCodec("helto.comfyui-utils").decrypt_state(
        store.projections["widget"]
    ) == {"value": sources["widget"]["expected"]}


def test_mirrored_migration_failure_restores_both_original_sources(tmp_path, monkeypatch):
    pack, _state, token = _installed_pack(tmp_path, monkeypatch)
    sources = _fixture()["generations"]["priv3"]["privacyShowAnyMigration"]
    original = {
        "widget": sources["widget"]["workflow"],
        "property": sources["property"]["workflow"],
    }
    store = MirrorStore(original)
    store.fail_next_replace = True
    coordinator = PrivacyShowAnyMigrationCoordinator(
        pack.migration,
        pack.workflow("privacy-show-any-workflow"),
        store,
    )

    with pytest.raises(shared_migration.MigrationError):
        coordinator.migrate(
            "priv3",
            PrivacyShowAnyMigrationAuthorizations(
                read=_authorization(pack, token, "migration.read"),
                complete=_authorization(pack, token, "migration.complete"),
                protect=_authorization(pack, token, "snapshot.protect"),
                inspect=_authorization(pack, token, "snapshot.disposition"),
                reveal=_authorization(pack, token, "snapshot.reveal"),
            ),
        )

    assert store.projections == original


def test_identical_legacy_mirrors_settle_one_obligation_and_one_receipt(
    tmp_path,
    monkeypatch,
):
    pack, _state, token = _installed_pack(tmp_path, monkeypatch)
    source = _fixture()["generations"]["priv3"]["privacyShowAnyMigration"][
        "widget"
    ]
    store = MirrorStore(
        {"widget": source["workflow"], "property": source["workflow"]}
    )
    coordinator = PrivacyShowAnyMigrationCoordinator(
        pack.migration,
        pack.workflow("privacy-show-any-workflow"),
        store,
    )

    receipt = coordinator.migrate(
        "priv3",
        PrivacyShowAnyMigrationAuthorizations(
            read=_authorization(pack, token, "migration.read"),
            complete=_authorization(pack, token, "migration.complete"),
            protect=_authorization(pack, token, "snapshot.protect"),
            inspect=_authorization(pack, token, "snapshot.disposition"),
            reveal=_authorization(pack, token, "snapshot.reveal"),
        ),
    )

    assert receipt.disposition == "migrated"
    assert len(receipt.obligation_ids) == 1
    assert store.projections["widget"] == store.projections["property"]


class Authorization:
    def __init__(self, reveal_authorization) -> None:
        self.reveal_authorization = reveal_authorization
        self.calls = []

    def authorize_request(self, _request, operation_id):
        assert operation_id == "snapshot.reveal"
        return self.reveal_authorization

    async def dispatch(self, request, scope_id, operation_id, operation):
        self.calls.append((request, scope_id, operation_id))
        return await operation("outer-authorization")


def test_display_operation_reveals_only_inside_authorized_product_invocation(
    tmp_path,
    monkeypatch,
):
    pack, state, token = _installed_pack(tmp_path, monkeypatch)
    workflow = pack.workflow("privacy-show-any-workflow")
    envelope = workflow.protect(
        PRIVACY_SHOW_ANY_FIELD_ID,
        "SYNTHETIC_AUTHORIZED_DISPLAY",
        _authorization(pack, token, "snapshot.protect"),
    ).envelope
    presented = []
    operation_adapter = PrivacyShowAnyDisplayOperationAdapter(
        state,
        lambda text: presented.append(text) or {"text": text},
    )
    authorization = Authorization(
        _authorization(pack, token, "snapshot.reveal")
    )
    operations = PrivacyShowAnyProtectedOperations(
        authorization,
        workflow,
        operation_adapter,
    )

    result = __import__("asyncio").run(
        operations.dispatch("synthetic-request", {"protected": envelope})
    )

    assert result == {"text": "SYNTHETIC_AUTHORIZED_DISPLAY"}
    assert presented == ["SYNTHETIC_AUTHORIZED_DISPLAY"]
    assert authorization.calls == [
        (
            "synthetic-request",
            "privacy-show-any",
            PRIVACY_SHOW_ANY_DISPLAY_OPERATION_ID,
        )
    ]

    stale = _authorization(pack, token, "snapshot.reveal")
    shared_keystore.lock_keystore()
    locked_operations = PrivacyShowAnyProtectedOperations(
        Authorization(stale),
        workflow,
        operation_adapter,
    )
    with pytest.raises(PrivacyAuthorizationError):
        __import__("asyncio").run(
            locked_operations.dispatch("synthetic-request", {"protected": envelope})
        )
    assert presented == ["SYNTHETIC_AUTHORIZED_DISPLAY"]

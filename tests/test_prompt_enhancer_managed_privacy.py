from __future__ import annotations

import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pytest

import helto_privacy.keystore as shared_keystore
import helto_privacy.migration as shared_migration
import helto_privacy.runtime as shared_runtime
import helto_privacy.singletons as shared_singletons
import helto_privacy.suite_runtime as shared_suite_runtime
from helto_privacy import (
    ExecutionError,
    LegacyKeyFormat,
    PrivacyAuthorizationError,
    PrivacyEnvelopeCodec,
    SingletonError,
    UTILS_PROVIDER_SETTINGS_PLAINTEXT_READER_ID,
    UTILS_PROVIDER_SETTINGS_WRAPPER_READER_ID,
    UTILS_WORKFLOW_READER_IDS,
    install,
    lock_keystore,
    register_legacy_reader_units,
    utils_legacy_reader_units,
    UTILS_KEY_BIN_IMPORT_ID,
    UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
)
from helto_privacy.guard import authorize_privacy_request
from shared.prompt_enhancer.managed_privacy import (
    PROMPT_ENHANCER_EXECUTION_PROJECTION_ID,
    PROMPT_ENHANCER_SCRIPT_FIELD_ID,
    PROMPT_ENHANCER_VARIABLES_FIELD_ID,
    PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
    PROMPT_PROVIDER_OPERATION_ADAPTER_ID,
    PromptEnhancerExecutionDispatchAdapter,
    PromptEnhancerExecutionProjectionAdapter,
    PromptEnhancerModeAdapter,
    PromptEnhancerWorkflowStateAdapter,
    build_prompt_enhancer_privacy_profile,
)
from shared.prompt_enhancer.managed_provider_settings import (
    PromptProviderCredentialDispatchAdapter,
    PromptProviderSettingsMigrationCoordinator,
    PromptProviderSettingsService,
    PromptProviderSettingsStore,
)
from shared.prompt_enhancer.managed_workflow_migration import (
    PromptEnhancerMigrationAuthorizations,
    PromptEnhancerWorkflowMigrationCoordinator,
)
from shared.prompt_enhancer.provider import (
    PromptEnhancerRequest,
    PromptEnhancerSettings,
    PromptProviderRegistry,
)
from shared.prompt_enhancer import local_provider


pytestmark = pytest.mark.usefixtures("coordinated_suite_test_boundary")


class Request:
    def __init__(self, token: str) -> None:
        self.headers = {"X-Helto-Privacy-Token": token}
        self.cookies = {}


class NodeState:
    def __init__(self) -> None:
        self.script = "A {{style}} portrait"
        self.variables = json.dumps(
            [
                {
                    "name": "style",
                    "mode": "fixed",
                    "values": ["cinematic", "documentary"],
                    "fixed_index": 1,
                }
            ]
        )


class WorkflowStore:
    def __init__(self, fields: dict[str, object]) -> None:
        self.fields = dict(fields)
        self.fail_next_replace = False

    def read_fields(self) -> dict[str, object]:
        return dict(self.fields)

    def replace_fields(self, fields: dict[str, object]) -> None:
        if self.fail_next_replace:
            self.fail_next_replace = False
            raise OSError("synthetic workflow commit failure")
        self.fields = dict(fields)


class LegacyContext:
    def __init__(self) -> None:
        self._keys = {
            UTILS_KEY_BIN_IMPORT_ID: hashlib.sha256(
                b"helto-utils-key-bin-historical-fixture-key"
            ).digest(),
            UTILS_PRIVACY_KEY_BIN_IMPORT_ID: hashlib.sha256(
                b"helto-utils-privacy-key-bin-historical-fixture-key"
            ).digest(),
        }

    def key_for(self, import_id: str) -> bytes:
        return self._keys[import_id]


def _authorization(pack, token: str, operation: str):
    return authorize_privacy_request(Request(token), operation, pack_id=pack.profile.id)


def _provider_migration(pack, store):
    return PromptProviderSettingsMigrationCoordinator(
        pack.migration,
        pack.singletons("prompt-provider-settings"),
        store,
    )


def _provider_migration_authorizations(pack, token: str) -> tuple[object, ...]:
    return (
        _authorization(pack, token, "migration.read"),
        _authorization(pack, token, "migration.complete"),
        _authorization(pack, token, "singleton.replace"),
        _authorization(pack, token, "singleton.reveal"),
    )


def _installed_pack(tmp_path, monkeypatch, dispatcher=None):
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
    shared_singletons.reset_singleton_runtime_for_tests()
    register_legacy_reader_units(utils_legacy_reader_units())
    store = PromptProviderSettingsStore(tmp_path / "provider_settings.json")
    product_dispatcher = dispatcher or (lambda value, _context, _cancellation: value)

    class ProviderOperations:
        def invoke(self, payload, context):
            return context.invoke_prompt_provider_operation(payload)

    pack = install(
        build_prompt_enhancer_privacy_profile(),
        {
            "prompt-enhancer-mode-state": PromptEnhancerModeAdapter(),
            "prompt-enhancer-workflow-state": PromptEnhancerWorkflowStateAdapter(),
            "prompt-enhancer-execution-projection": PromptEnhancerExecutionProjectionAdapter(),
            "prompt-enhancer-execution-dispatch": PromptEnhancerExecutionDispatchAdapter(
                product_dispatcher
            ),
            "prompt-provider-settings-store": store,
            PROMPT_PROVIDER_OPERATION_ADAPTER_ID: ProviderOperations(),
        },
    )
    password = "synthetic prompt password"
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
    return pack, store, token


def test_profile_declares_prompt_snapshot_execution_singleton_and_history():
    profile = build_prompt_enhancer_privacy_profile()

    assert [scope.id for scope in profile.scopes] == ["prompt-enhancer"]
    assert {field.id for field in profile.protected_fields} == {
        PROMPT_ENHANCER_SCRIPT_FIELD_ID,
        PROMPT_ENHANCER_VARIABLES_FIELD_ID,
    }
    assert all(field.execution for field in profile.protected_fields)
    assert [item.id for item in profile.execution_projections] == [
        PROMPT_ENHANCER_EXECUTION_PROJECTION_ID
    ]
    assert [item.id for item in profile.singletons] == [
        PROMPT_PROVIDER_SETTINGS_SINGLETON_ID
    ]
    assert {
        binding.reader_id for binding in profile.legacy_bindings
    } == {
        *UTILS_WORKFLOW_READER_IDS.values(),
        UTILS_PROVIDER_SETTINGS_PLAINTEXT_READER_ID,
        UTILS_PROVIDER_SETTINGS_WRAPPER_READER_ID,
    }
    assert {binding.import_id for binding in profile.legacy_key_imports} == {
        UTILS_KEY_BIN_IMPORT_ID,
        UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
    }
    assert profile.fingerprint == build_prompt_enhancer_privacy_profile().fingerprint


def test_prompt_external_transition_codec_accepts_legacy_public_shapes():
    state = PromptEnhancerWorkflowStateAdapter()

    assert state.classify_mode_transition_representation(b"raw prompt", object()) == "public"
    assert state.encode_public_mode_transition("raw prompt", object()) == (
        b'{"value":"raw prompt"}'
    )
    assert state.classify_mode_transition_representation(b"[]", object()) == "public"


@pytest.mark.parametrize("generation", ("raw-xor", "priv1", "priv2", "priv3"))
def test_profile_decodes_genuine_prompt_enhancer_workflow_generations(generation):
    fixture = json.loads(
        (
            Path(__file__).parent
            / "fixtures"
            / "historical"
            / "utils_legacy_formats.json"
        ).read_text(encoding="utf-8")
    )
    values = fixture["generations"][generation]["promptEnhancerMigration"]
    units = {unit.id: unit for unit in utils_legacy_reader_units()}
    reader_id = UTILS_WORKFLOW_READER_IDS[generation]
    reader = units[reader_id].reader

    assert reader.read(values["script"]["workflow"], LegacyContext()) == values[
        "script"
    ]["expected"]
    assert reader.read(values["variables"]["workflow"], LegacyContext()) == values[
        "variables"
    ]["expected"]
    assert all(
        any(
            binding.reader_id == reader_id and binding.location_id == field_id
            for binding in build_prompt_enhancer_privacy_profile().legacy_bindings
        )
        for field_id in (
            PROMPT_ENHANCER_SCRIPT_FIELD_ID,
            PROMPT_ENHANCER_VARIABLES_FIELD_ID,
        )
    )


@pytest.mark.parametrize("generation", ("raw-xor", "priv1", "priv2", "priv3"))
def test_grouped_workflow_migration_rewrites_both_fields_in_one_receipt(
    generation,
    tmp_path,
    monkeypatch,
):
    pack, _provider_store, token = _installed_pack(tmp_path, monkeypatch)
    fixture = json.loads(
        (
            Path(__file__).parent
            / "fixtures"
            / "historical"
            / "utils_legacy_formats.json"
        ).read_text(encoding="utf-8")
    )
    historical = fixture["generations"][generation]["promptEnhancerMigration"]
    store = WorkflowStore(
        {
            PROMPT_ENHANCER_SCRIPT_FIELD_ID: historical["script"]["workflow"],
            PROMPT_ENHANCER_VARIABLES_FIELD_ID: historical["variables"]["workflow"],
        }
    )
    coordinator = PromptEnhancerWorkflowMigrationCoordinator(
        pack.migration,
        pack.workflow("prompt-enhancer-workflow"),
        store,
    )

    receipt = coordinator.migrate(
        generation,
        PromptEnhancerMigrationAuthorizations(
            read=_authorization(pack, token, "migration.read"),
            complete=_authorization(pack, token, "migration.complete"),
            protect=_authorization(pack, token, "snapshot.protect"),
            inspect=_authorization(pack, token, "snapshot.disposition"),
            reveal=_authorization(pack, token, "snapshot.reveal"),
        ),
    )

    assert receipt.disposition == "migrated"
    assert len(receipt.obligation_ids) == 2
    codec = PrivacyEnvelopeCodec("helto.comfyui-utils")
    assert codec.decrypt_state(store.fields[PROMPT_ENHANCER_SCRIPT_FIELD_ID]) == {
        "value": historical["script"]["expected"]
    }
    assert codec.decrypt_state(store.fields[PROMPT_ENHANCER_VARIABLES_FIELD_ID]) == {
        "value": json.loads(historical["variables"]["expected"])
    }


def test_failed_grouped_workflow_migration_restores_both_original_fields(
    tmp_path,
    monkeypatch,
):
    pack, _provider_store, token = _installed_pack(tmp_path, monkeypatch)
    historical = json.loads(
        (
            Path(__file__).parent
            / "fixtures"
            / "historical"
            / "utils_legacy_formats.json"
        ).read_text(encoding="utf-8")
    )["generations"]["priv3"]["promptEnhancerMigration"]
    original = {
        PROMPT_ENHANCER_SCRIPT_FIELD_ID: historical["script"]["workflow"],
        PROMPT_ENHANCER_VARIABLES_FIELD_ID: historical["variables"]["workflow"],
    }
    store = WorkflowStore(original)
    store.fail_next_replace = True
    coordinator = PromptEnhancerWorkflowMigrationCoordinator(
        pack.migration,
        pack.workflow("prompt-enhancer-workflow"),
        store,
    )

    with pytest.raises(shared_migration.MigrationError):
        coordinator.migrate(
            "priv3",
            PromptEnhancerMigrationAuthorizations(
                read=_authorization(pack, token, "migration.read"),
                complete=_authorization(pack, token, "migration.complete"),
                protect=_authorization(pack, token, "snapshot.protect"),
                inspect=_authorization(pack, token, "snapshot.disposition"),
                reveal=_authorization(pack, token, "snapshot.reveal"),
            ),
        )

    assert store.fields == original


def test_mode_state_projection_and_dispatch_keep_product_semantics():
    profile = build_prompt_enhancer_privacy_profile()
    fields = {field.id: field for field in profile.protected_fields}
    mode = PromptEnhancerModeAdapter()
    state = PromptEnhancerWorkflowStateAdapter()
    node = NodeState()

    assert mode.read_declared_mode("prompt-enhancer") == "private"
    assert state.normalize(node.script, fields[PROMPT_ENHANCER_SCRIPT_FIELD_ID]) == {
        "value": "A {{style}} portrait"
    }
    variables = state.normalize(
        node.variables,
        fields[PROMPT_ENHANCER_VARIABLES_FIELD_ID],
    )["value"]
    projection = PromptEnhancerExecutionProjectionAdapter().project(
        {
            PROMPT_ENHANCER_SCRIPT_FIELD_ID: {"value": node.script},
            PROMPT_ENHANCER_VARIABLES_FIELD_ID: {"value": variables},
        },
        profile.execution_projections[0],
    )
    assert projection == {
        "resolved_script": "A {{style}} portrait",
        "variables": variables,
    }
    seen = []
    dispatch = PromptEnhancerExecutionDispatchAdapter(
        lambda value, context, _cancellation: seen.append((value, context)) or value
    )

    result = dispatch.dispatch(projection, {"seed": 7, "external_prompt": ""}, None)

    assert result["resolved_script"] == "A documentary portrait"
    assert result["variables"] == variables
    assert seen[0][1] == {"seed": 7, "external_prompt": ""}
    with pytest.raises(ValueError):
        state.normalize("not-json", fields[PROMPT_ENHANCER_VARIABLES_FIELD_ID])


def test_current_snapshot_executes_once_and_lock_blocks_before_product(tmp_path, monkeypatch):
    calls = []
    pack, _store, token = _installed_pack(
        tmp_path,
        monkeypatch,
        lambda value, _context, _cancellation: calls.append(value) or value,
    )
    codec = PrivacyEnvelopeCodec("helto.comfyui-utils")
    fields = {
        PROMPT_ENHANCER_SCRIPT_FIELD_ID: codec.encrypt_state(
            {"value": "A {{style}} portrait"}
        ),
        PROMPT_ENHANCER_VARIABLES_FIELD_ID: codec.encrypt_state(
            {
                "value": [
                    {
                        "name": "style",
                        "mode": "fixed",
                        "values": ["cinematic"],
                        "fixed_index": 0,
                    }
                ]
            }
        ),
    }
    execution = pack.execution("prompt-enhancer-execution")
    prepared = execution.prepare(
        PROMPT_ENHANCER_EXECUTION_PROJECTION_ID,
        fields,
        _authorization(pack, token, "execution.prepare"),
        subject_id="synthetic-prompt-node",
    )

    result = execution.dispatch(
        prepared.reference,
        {"seed": 1, "external_prompt": ""},
        subject_id="synthetic-prompt-node",
    )
    assert result.value["resolved_script"] == "A cinematic portrait"
    assert len(calls) == 1

    prepared = execution.prepare(
        PROMPT_ENHANCER_EXECUTION_PROJECTION_ID,
        fields,
        _authorization(pack, token, "execution.prepare"),
        subject_id="synthetic-prompt-node",
    )
    lock_keystore()
    with pytest.raises(ExecutionError):
        execution.dispatch(
            prepared.reference,
            {"seed": 1, "external_prompt": ""},
            subject_id="synthetic-prompt-node",
        )
    assert len(calls) == 1


def test_singleton_status_dispatch_and_storage_never_expose_token(tmp_path, monkeypatch):
    pack, store, token = _installed_pack(tmp_path, monkeypatch)
    handle = pack.singletons("prompt-provider-settings")
    service = PromptProviderSettingsService(
        handle,
        environment_token=lambda: pytest.fail("status must not resolve the token"),
        environment_token_available=lambda: True,
    )
    with pytest.raises(PrivacyAuthorizationError):
        service.dispatch(None, lambda _token: pytest.fail("must not run"))
    secret = "SYNTHETIC_CONFIGURED_PROVIDER_TOKEN"
    receipt = service.replace(
        secret,
        0,
        _authorization(pack, token, "singleton.replace"),
    )

    assert receipt.revision == 1
    status = service.status()
    assert status == {
        "ok": True,
        "tokenConfigured": True,
        "envTokenAvailable": True,
        "authSource": "configured",
    }
    persisted = store.path.read_text(encoding="utf-8")
    assert secret not in persisted
    assert secret not in repr(receipt)
    assert secret not in json.dumps(status)
    seen = []
    assert service.dispatch(
        _authorization(pack, token, "singleton.reveal"),
        lambda auth_token: seen.append(auth_token) or "done",
    ) == "done"
    assert seen == [secret]

    class Registry:
        def __init__(self):
            self.calls = []

        def generate_with_auth(self, request, auth_token, progress):
            self.calls.append((request, auth_token, progress))
            return "generated"

        def generate_visual_context_with_auth(self, request, auth_token, progress):
            self.calls.append((request, auth_token, progress))
            return "visual"

    registry = Registry()
    adapter = PromptProviderCredentialDispatchAdapter(service, registry)
    request = object()
    assert adapter.generate(
        request,
        "synthetic-progress",
        _authorization(pack, token, "singleton.reveal"),
    ) == "generated"
    assert registry.calls == [(request, secret, "synthetic-progress")]
    assert adapter.generate_visual_context(
        request,
        "synthetic-visual-progress",
        _authorization(pack, token, "singleton.reveal"),
    ) == "visual"
    assert registry.calls[-1] == (request, secret, "synthetic-visual-progress")

    stale_authorization = _authorization(pack, token, "singleton.reveal")
    lock_keystore()
    with pytest.raises((SingletonError, PrivacyAuthorizationError)):
        service.dispatch(stale_authorization, lambda _token: pytest.fail("must not run"))


def test_provider_registry_passes_explicit_auth_without_putting_it_on_request():
    request = PromptEnhancerRequest(
        model="fallback_text_backend",
        prompt_type="image",
        prompt="synthetic prompt",
        system_prompt="synthetic system",
        seed=1,
        images=[],
        settings=PromptEnhancerSettings(),
        provider=local_provider.PROVIDER_FALLBACK,
        model_id="fallback_text_backend",
    )
    secret = "SYNTHETIC_DISPATCH_ONLY_TOKEN"

    with patch.object(
        local_provider.LocalPromptProvider,
        "generate_with_auth",
        return_value="generated",
    ) as generate:
        result = PromptProviderRegistry().generate_with_auth(request, secret)

    assert result == "generated"
    generate.assert_called_once_with(request, secret, None)
    assert secret not in repr(request)


def test_plaintext_provider_migration_rewrites_then_verifies_before_retirement(
    tmp_path,
    monkeypatch,
):
    pack, store, token = _installed_pack(tmp_path, monkeypatch)
    secret = "SYNTHETIC_LEGACY_PROVIDER_TOKEN"
    store.path.write_text(
        json.dumps({"version": 1, "hf_token": secret}),
        encoding="utf-8",
    )
    original = store.path.read_bytes()
    coordinator = _provider_migration(pack, store)

    receipt = coordinator.migrate(*_provider_migration_authorizations(pack, token))

    assert receipt.disposition == "migrated"
    assert secret not in store.path.read_text(encoding="utf-8")
    assert store.read_singleton(PROMPT_PROVIDER_SETTINGS_SINGLETON_ID).revision == 1
    assert store.path.read_bytes() != original


def test_encrypted_wrapper_migrates_and_malformed_store_never_defaults(
    tmp_path,
    monkeypatch,
):
    pack, store, token = _installed_pack(tmp_path, monkeypatch)
    secret = "SYNTHETIC_WRAPPED_PROVIDER_TOKEN"
    envelope = PrivacyEnvelopeCodec("helto.comfyui-utils").encrypt_state(
        {"hf_token": secret}
    )
    store.path.write_text(
        json.dumps({"version": 2, "hf_token_encrypted": envelope}),
        encoding="utf-8",
    )
    coordinator = _provider_migration(pack, store)
    coordinator.migrate(*_provider_migration_authorizations(pack, token))
    service = PromptProviderSettingsService(
        pack.singletons("prompt-provider-settings"),
        environment_token=lambda: "",
        environment_token_available=lambda: False,
    )
    seen = []
    service.dispatch(
        _authorization(pack, token, "singleton.reveal"),
        lambda auth_token: seen.append(auth_token),
    )
    assert seen == [secret]

    store.path.write_text('{"format":"wrong"}', encoding="utf-8")
    with pytest.raises(ValueError):
        store.read_singleton(PROMPT_PROVIDER_SETTINGS_SINGLETON_ID)
    assert store.path.read_text(encoding="utf-8") == '{"format":"wrong"}'


def test_failed_provider_migration_restores_exact_plaintext_source(tmp_path, monkeypatch):
    pack, store, token = _installed_pack(tmp_path, monkeypatch)
    source = json.dumps(
        {"version": 1, "hf_token": "SYNTHETIC_ROLLBACK_PROVIDER_TOKEN"}
    ).encode("utf-8")
    store.path.write_bytes(source)
    real_write = store._write

    def corrupt_after_write(snapshot):
        real_write(snapshot)
        store.path.write_text('{"format":"corrupt"}', encoding="utf-8")

    monkeypatch.setattr(store, "_write", corrupt_after_write)
    coordinator = _provider_migration(pack, store)

    with pytest.raises(shared_migration.MigrationError):
        coordinator.migrate(*_provider_migration_authorizations(pack, token))

    assert store.path.read_bytes() == source

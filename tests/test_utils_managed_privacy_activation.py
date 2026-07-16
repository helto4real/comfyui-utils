from __future__ import annotations

import builtins
import json
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 can still run the textual assertions.
    tomllib = None

import pytest

import helto_privacy.migration as migration
import helto_privacy.keystore as keystore
import helto_privacy.runtime as runtime
from helto_privacy import (
    AdapterBindingError,
    ProtectedStateAuthority,
    install,
    register_legacy_reader_units,
    utils_legacy_reader_units,
)
from helto_privacy.guard import authorize_privacy_request
from helto_selector_backend.managed_workflow import build_selector_privacy_profile
from shared.managed_privacy import build_utils_privacy_profile
import shared.managed_privacy as managed_privacy
import shared.managed_privacy_routes as managed_routes
from shared.privacy_show_any_managed import build_privacy_show_any_profile
from shared.private_media_managed import build_private_media_profile
from shared.prompt_enhancer.managed_privacy import (
    PROMPT_PROVIDER_SETTINGS_RESOURCE_ID,
    build_prompt_enhancer_privacy_profile,
)
from shared.prompt_enhancer.managed_provider_settings import (
    PromptProviderSettingsMigrationCoordinator,
)
from shared.queue_manager_managed import build_queue_manager_privacy_profile


pytestmark = pytest.mark.usefixtures("coordinated_suite_test_boundary")


class CompleteAdapter:
    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: None


class PrivacyRequest:
    def __init__(self, token: str) -> None:
        self.headers = {"X-Helto-Privacy-Token": token}
        self.cookies = {}


def _queue_operations():
    return {
        operation_id: (lambda _payload, _context: None)
        for operation_id in managed_privacy.QUEUE_OPERATION_ADAPTER_IDS
    }


def test_complete_utils_profile_is_exact_union_of_active_slices():
    fragments = (
        build_selector_privacy_profile(),
        build_private_media_profile(),
        build_privacy_show_any_profile(),
        build_prompt_enhancer_privacy_profile(),
        build_queue_manager_privacy_profile(),
    )
    complete = build_utils_privacy_profile()

    for attribute in (
        "resources",
        "server_adapters",
        "browser_adapters",
        "scopes",
        "protected_fields",
        "records",
        "singletons",
        "artifacts",
        "protected_operations",
        "execution_projections",
        "legacy_bindings",
        "legacy_key_imports",
    ):
        expected = {
            item.id
            for fragment in fragments
            for item in getattr(fragment, attribute)
        }
        assert {item.id for item in getattr(complete, attribute)} == expected

    assert complete.id == "helto.comfyui-utils"
    assert complete.distribution == "comfyui-utils"
    assert len(complete.resources) == 16
    assert len(complete.server_adapters) == 30
    assert len(complete.browser_adapters) == 6


def test_complete_utils_profile_fingerprint_is_registration_order_independent():
    first = build_utils_privacy_profile()
    second = build_utils_privacy_profile()

    assert first.fingerprint == second.fingerprint
    assert first.fingerprint == (
        "517c7d90d335ac12fd30e7fb0eafba9976b8fb8c1be9cdfa55aa508463760cbe"
    )


def test_installation_refuses_one_missing_adapter_slot(monkeypatch):
    monkeypatch.setattr(runtime, "_INSTALLATIONS", {})
    monkeypatch.setattr(runtime, "register_helto_privacy_ui", lambda **_kwargs: True)
    migration.reset_migration_runtime_for_tests()
    register_legacy_reader_units(utils_legacy_reader_units())
    profile = build_utils_privacy_profile()
    adapters = {slot.id: CompleteAdapter() for slot in profile.server_adapters}
    missing = profile.server_adapters[len(profile.server_adapters) // 2].id
    adapters.pop(missing)

    with pytest.raises(AdapterBindingError):
        install(profile, adapters)


def test_complete_adapter_set_installs_one_fingerprint(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime, "_INSTALLATIONS", {})
    monkeypatch.setattr(runtime, "register_helto_privacy_ui", lambda **_kwargs: True)
    monkeypatch.setenv("HELTO_PRIVACY_ARTIFACT_ROOT", str(tmp_path / "artifacts"))
    monkeypatch.setenv("HELTO_PRIVACY_MODE_STATE", str(tmp_path / "mode-state.json"))
    monkeypatch.setenv(
        "HELTO_PRIVACY_EXTERNAL_OPERATION_STATE",
        str(tmp_path / "external-operations.json"),
    )
    monkeypatch.setenv(
        "HELTO_PRIVACY_RECORD_RELOCATION_STATE",
        str(tmp_path / "record-relocation.json"),
    )
    migration.reset_migration_runtime_for_tests()
    register_legacy_reader_units(utils_legacy_reader_units())
    profile = build_utils_privacy_profile()
    adapters = {slot.id: CompleteAdapter() for slot in profile.server_adapters}

    pack = install(profile, adapters)

    assert pack.profile is profile
    assert pack.fingerprint == profile.fingerprint


def test_production_adapter_builder_binds_every_slot_exactly_once(tmp_path):
    profile = build_utils_privacy_profile()

    adapters = managed_privacy.build_utils_server_adapters(
        tmp_path,
        selector_dispatch=lambda value, _context, _cancellation: value,
        prompt_dispatch=lambda value, _context, _cancellation: value,
        queue_operations=_queue_operations(),
    )

    assert set(adapters) == {slot.id for slot in profile.server_adapters}
    for adapter_id, methods in profile.server_adapter_contracts.items():
        assert all(callable(getattr(adapters[adapter_id], method, None)) for method in methods)
    browser_owned = {
        "privacy-show-any-text",
        "prompt-enhancer-script",
        "prompt-enhancer-variables",
        "selector-selected-images",
        "selector-edited-masks",
        "selector-edited-bboxes",
    }
    fields = {field.id: field for field in profile.protected_fields}
    assert browser_owned <= set(fields)
    assert all(
        fields[field_id].state_authority
        is ProtectedStateAuthority.EXTERNAL_BROWSER_WORKFLOW
        and fields[field_id].external_transition_policy is not None
        for field_id in browser_owned
    )
    assert adapters[managed_privacy.PROMPT_PROVIDER_SETTINGS_STORE_ADAPTER_ID].path == (
        tmp_path / "config" / "prompt enhancer" / "provider_settings.json"
    )
    with pytest.raises(ValueError):
        managed_privacy.build_utils_server_adapters(
            tmp_path,
            selector_dispatch=lambda value, _context, _cancellation: value,
            prompt_dispatch=lambda value, _context, _cancellation: value,
            queue_operations={},
        )


def test_historical_provider_path_is_the_live_managed_migration_source(
    tmp_path,
    monkeypatch,
):
    import helto_privacy.suite_runtime as suite_runtime

    monkeypatch.setenv("HELTO_PRIVACY_KEYSTORE", str(tmp_path / "keystore.json"))
    monkeypatch.setenv("HELTO_PRIVACY_SESSION_DIR", str(tmp_path / "session"))
    monkeypatch.setenv(
        migration.MIGRATION_STATE_ENV,
        str(tmp_path / "migration.json"),
    )
    monkeypatch.setattr(runtime, "_INSTALLATIONS", {})
    monkeypatch.setattr(runtime, "register_helto_privacy_ui", lambda **_kwargs: True)
    monkeypatch.setattr(suite_runtime, "require_active_process_suite", lambda: None)
    monkeypatch.setattr(keystore, "SCRYPT_N", 2**12)
    migration.reset_migration_runtime_for_tests()
    register_legacy_reader_units(utils_legacy_reader_units())
    adapters = managed_privacy.build_utils_server_adapters(
        tmp_path,
        selector_dispatch=lambda value, _context, _cancellation: value,
        prompt_dispatch=lambda value, _context, _cancellation: value,
        queue_operations=_queue_operations(),
    )
    store = adapters[managed_privacy.PROMPT_PROVIDER_SETTINGS_STORE_ADAPTER_ID]
    store.path.parent.mkdir(parents=True)
    secret = "SYNTHETIC_HISTORICAL_PROVIDER_TOKEN"
    store.path.write_text(
        json.dumps({"version": 1, "hf_token": secret}),
        encoding="utf-8",
    )
    pack = install(build_utils_privacy_profile(), adapters)
    token = keystore.initialize_keystore("synthetic provider path password")["token"]
    request = PrivacyRequest(token)
    coordinator = PromptProviderSettingsMigrationCoordinator(
        pack.migration,
        pack.singletons(PROMPT_PROVIDER_SETTINGS_RESOURCE_ID),
        store,
    )

    receipt = coordinator.migrate(
        authorize_privacy_request(request, "migration.read", pack_id=pack.profile.id),
        authorize_privacy_request(
            request,
            "migration.complete",
            pack_id=pack.profile.id,
        ),
        authorize_privacy_request(
            request,
            "singleton.replace",
            pack_id=pack.profile.id,
        ),
        authorize_privacy_request(
            request,
            "singleton.reveal",
            pack_id=pack.profile.id,
        ),
    )

    assert receipt.disposition == "migrated"
    assert store.path == tmp_path / "config" / "prompt enhancer" / "provider_settings.json"
    assert secret not in store.path.read_text(encoding="utf-8")


def test_local_privacy_core_and_legacy_route_surfaces_are_absent():
    root = Path(__file__).resolve().parents[1]
    removed = (
        "helto_selector_backend/crypto.py",
        "helto_selector_backend/routes.py",
        "nodes/load_video/video_routes.py",
        "shared/privacy.py",
        "shared/private_media_routes.py",
        "shared/queue_manager_routes.py",
        "shared/queue_manager_store.py",
        "web/privacy_common.js",
        "web/privacy_envelope.js",
        "web/privacy_recovery.js",
    )
    assert all(not (root / relative).exists() for relative in removed)

    production = "\n".join(
        path.read_text(encoding="utf-8")
        for directory in (root / "helto_selector_backend", root / "nodes", root / "shared", root / "web")
        for path in directory.rglob("*")
        if path.suffix in {".py", ".js"}
    )
    for obsolete in (
        "aiohttp_check_privacy_token",
        "/helto_utils/private_media",
        "/helto_save_image_advanced/release",
        "/helto_save_video_advanced/release",
        "helto_selector_backend.crypto",
        "privacy_common.js",
        "privacy_envelope.js",
        "privacy_recovery.js",
        "Disable encrypted persistence",
        "PrivacyEnvelopeCodec",
        "__HELTO_ENC__",
        "decrypt_func",
    ):
        assert obsolete not in production


def test_candidate_metadata_pins_one_immutable_shared_runtime():
    root = Path(__file__).resolve().parents[1]
    shared_dependency = "helto-privacy==0.4.2"

    requirements = (root / "requirements.txt").read_text(encoding="utf-8").splitlines()
    project_text = (root / "pyproject.toml").read_text(encoding="utf-8")
    browser = json.loads((root / "package.json").read_text(encoding="utf-8"))

    assert requirements == [shared_dependency, "cryptography>=42.0"]
    assert all(f'"{dependency}"' in project_text for dependency in requirements)
    assert 'PublisherId = "helto"' in project_text
    assert 'DisplayName = "Helto ComfyUI Utils"' in project_text
    assert 'web = "web"' in project_text
    if tomllib is not None:
        metadata = tomllib.loads(project_text)
        assert metadata["project"]["dependencies"] == requirements
        assert metadata["project"]["urls"]["Repository"] == (
            "https://github.com/helto4real/comfyui-utils"
        )
        assert metadata["tool"]["comfy"] == {
            "PublisherId": "helto",
            "DisplayName": "Helto ComfyUI Utils",
            "Icon": "",
            "web": "web",
        }
        assert metadata["project"]["name"] == browser["name"]
        assert metadata["project"]["version"] == browser["version"]
    assert browser["name"] == "comfyui-utils"
    assert browser["version"] == "0.1.2"
    assert browser["private"] is True
    assert browser["type"] == "module"
    assert "file:" not in "\n".join(requirements)
    assert "../" not in "\n".join(requirements)
    assert "git+" not in "\n".join(requirements)

    managed_privacy = (root / "web/managed_privacy.js").read_text(encoding="utf-8")
    progress_bar = (root / "web/progress_bar.js").read_text(encoding="utf-8")
    for source in (managed_privacy, progress_bar):
        assert 'from "/helto_privacy/ui/privacy_snapshot.js";' in source
        assert "installPrivacyConnectionSerializationGate(app).coalesce();" in source
    assert managed_privacy.index("installPrivacyConnectionSerializationGate(app).coalesce();") < managed_privacy.index("async function connect()")
    assert progress_bar.index("installPrivacyConnectionSerializationGate(app).coalesce();") < progress_bar.index("class HeltoProgressBar")


def test_missing_shared_package_blocks_pack_import(monkeypatch):
    root = Path(__file__).resolve().parents[1]
    source = (root / "__init__.py").read_text(encoding="utf-8")
    real_import = builtins.__import__

    def blocked_import(name, *args, **kwargs):
        if name == "helto_privacy" or name.startswith("helto_privacy."):
            raise ModuleNotFoundError("synthetic missing helto-privacy")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)
    with pytest.raises(ModuleNotFoundError, match="synthetic missing helto-privacy"):
        exec(
            compile(source, str(root / "__init__.py"), "exec"),
            {
                "__file__": str(root / "__init__.py"),
                "__name__": "synthetic_utils_package",
                "__package__": "synthetic_utils_package",
            },
        )


def test_frontend_queue_customization_stays_behind_shared_gate():
    root = Path(__file__).resolve().parents[1]
    queue_manager = (root / "web/queue_manager.js").read_text(encoding="utf-8")
    prompt_enhancer = (root / "web/prompt_enhancer.js").read_text(encoding="utf-8")
    progress_bar = (root / "web/progress_bar.js").read_text(encoding="utf-8")
    selector = (root / "web/selector.js").read_text(encoding="utf-8")

    assert '.installQueueInterceptor({' in queue_manager
    assert "controller.submitPrompt(number" in queue_manager
    assert 'fetch(routeUrl("/prompt")' not in queue_manager
    assert "target.beforeQueued = function" in prompt_enhancer
    assert "target.afterQueued = function" in prompt_enhancer
    for source in (queue_manager, prompt_enhancer, progress_bar):
        assert "app.queuePrompt =" not in source
        assert "api.queuePrompt =" not in source
    assert "app.graphToPrompt =" not in selector


def test_provider_route_lazily_migrates_legacy_store(monkeypatch):
    calls = []

    class Store:
        def read_singleton(self, _singleton_id):
            raise ValueError("synthetic legacy store")

    class Authorization:
        def authorize_request(self, request, operation):
            calls.append((request, operation))
            return f"capability:{operation}"

    class Coordinator:
        def __init__(self, migration_handle, singleton_handle, store):
            assert migration_handle == "migration-handle"
            assert singleton_handle is None
            assert isinstance(store, Store)

        def migrate(self, read, complete, protect, reveal):
            calls.append((read, complete, protect, reveal))

    monkeypatch.setattr(managed_routes, "utils_privacy_adapter", lambda _id: Store())
    monkeypatch.setattr(managed_routes, "PromptProviderSettingsMigrationCoordinator", Coordinator)
    pack = CompleteAdapter()
    pack.authorization = Authorization()
    pack.migration = "migration-handle"

    managed_routes._ensure_provider_store_current(pack, "synthetic-request")

    assert calls == [
        ("synthetic-request", "migration.read"),
        ("synthetic-request", "migration.complete"),
        ("synthetic-request", "singleton.replace"),
        ("synthetic-request", "singleton.reveal"),
        (
            "capability:migration.read",
            "capability:migration.complete",
            "capability:singleton.replace",
            "capability:singleton.reveal",
        ),
    ]


def test_queue_route_lazily_migrates_legacy_json_store(monkeypatch, tmp_path):
    calls = []
    sqlite_path = tmp_path / "queue_manager_state.sqlite3"
    sqlite_path.with_suffix(".json").write_text("{}", encoding="utf-8")

    class Store:
        path = sqlite_path

        def read_singleton(self, _singleton_id):
            return type("Snapshot", (), {"revision": 0})()

    class Authorization:
        def authorize_request(self, _request, operation):
            return f"capability:{operation}"

    class Coordinator:
        def __init__(self, migration_handle, singleton_handle, store):
            assert migration_handle == "migration-handle"
            assert singleton_handle is None
            assert isinstance(store, Store)

        def migrate_json(self, source, **kwargs):
            calls.append((source, kwargs))

        def migrate_sqlite(self, *_args, **_kwargs):
            raise AssertionError("JSON legacy source must use the JSON coordinator")

    monkeypatch.setattr(managed_routes, "utils_privacy_adapter", lambda _id: Store())
    monkeypatch.setattr(managed_routes, "QueueManagerMigrationCoordinator", Coordinator)
    pack = CompleteAdapter()
    pack.authorization = Authorization()
    pack.migration = "migration-handle"

    managed_routes._ensure_queue_store_current(pack, "synthetic-request")

    assert calls[0][0] == sqlite_path.with_suffix(".json")
    assert calls[0][1] == {
        "generation": "current",
        "read_authorization": "capability:migration.read",
        "complete_authorization": "capability:migration.complete",
        "protect_authorization": "capability:singleton.replace",
        "reveal_authorization": "capability:singleton.reveal",
    }

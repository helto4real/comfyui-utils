from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import pytest

import helto_privacy.artifacts as shared_artifacts
import helto_privacy.keystore as shared_keystore
import helto_privacy.migration as shared_migration
import helto_privacy.runtime as shared_runtime
from helto_privacy import (
    ALGORITHM,
    ENVELOPE_VERSION,
    DispositionResult,
    EnvelopeDisposition,
    MigrationVerification,
    ProtectedFieldResult,
    UTILS_KEY_BIN_IMPORT_ID,
    UTILS_PRIV1_READER_ID,
    UTILS_PRIV2_READER_ID,
    UTILS_PRIV3_READER_ID,
    UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
    UTILS_RAW_XOR_READER_ID,
    UTILS_WORKFLOW_READER_IDS,
    utils_legacy_reader_units,
    utils_raw_xor_source,
    install,
    register_legacy_reader_units,
)
from helto_privacy.guard import authorize_privacy_request
from helto_selector_backend.managed_artifacts import SelectorArtifactCodecAdapter
from helto_selector_backend.managed_migration import (
    SelectorAsyncArtifactMigrationGateway,
    SelectorLegacyMaskFiles,
    SelectorMigrationAuthorizations,
    SelectorMigrationCoordinator,
    SelectorWorkflowMigrationTransaction,
)
from helto_selector_backend.managed_workflow import (
    SELECTOR_BBOXES_FIELD_ID,
    SELECTOR_EXECUTION_PROJECTION_ID,
    SELECTOR_MASKS_FIELD_ID,
    SELECTOR_OPERATION_IDS,
    SELECTOR_SELECTED_FIELD_ID,
    SelectorExecutionProjectionAdapter,
    SelectorModeAdapter,
    SelectorExecutionDispatchAdapter,
    SelectorOperationContext,
    SelectorProductOperationAdapter,
    SelectorProtectedOperations,
    SelectorWorkflowStateAdapter,
    build_selector_privacy_profile,
)


pytestmark = pytest.mark.usefixtures("coordinated_suite_test_boundary")


class Node:
    def __init__(self) -> None:
        self.properties = {}
        self.selectedPaths = ["/synthetic/root/a.png"]
        self.editedMasks = {"/synthetic/root/a.png": {"key": "legacy"}}
        self.editedBboxes = {
            "/synthetic/root/a.png": [
                {"x": 1, "y": 2, "width": 3, "height": 4}
            ]
        }


FIXTURE_PATH = (
    Path(__file__).parent / "fixtures" / "historical" / "utils_legacy_formats.json"
)


class LegacyContext:
    def __init__(self) -> None:
        self.unresolved_count = 0
        self._keys = {
            UTILS_KEY_BIN_IMPORT_ID: hashlib.sha256(
                b"helto-utils-key-bin-historical-fixture-key"
            ).digest(),
            UTILS_PRIVACY_KEY_BIN_IMPORT_ID: hashlib.sha256(
                b"helto-utils-privacy-key-bin-historical-fixture-key"
            ).digest(),
        }

    def key_for(self, import_id):
        return self._keys[import_id]


class PrivacyRequest:
    def __init__(self, token):
        self.headers = {"X-Helto-Privacy-Token": token}
        self.cookies = {}


class InstalledOperationAdapter:
    def invoke(self, *_args):
        return None


class AsyncManagedArtifacts:
    def __init__(self, *, corrupt_read=False):
        self.values = {}
        self.corrupt_read = corrupt_read

    async def write_mask(self, _image_path, value, _owner_id):
        reference = {"id": f"managed-{len(self.values)}"}
        self.values[reference["id"]] = bytes(value)
        return reference

    async def read_mask(self, _image_path, reference):
        value = self.values[reference["id"]]
        return value + b"corrupt" if self.corrupt_read else value

    async def retire_mask(self, _image_path, reference):
        self.values.pop(reference["id"], None)
        return 1


def _authorization(pack, token, operation):
    return authorize_privacy_request(
        PrivacyRequest(token),
        operation,
        pack_id=pack.profile.id,
    )


def _installed_selector_pack(tmp_path, monkeypatch):
    monkeypatch.setenv(
        shared_migration.MIGRATION_STATE_ENV,
        str(tmp_path / "migration.json"),
    )
    monkeypatch.setenv("HELTO_PRIVACY_KEYSTORE", str(tmp_path / "keystore.json"))
    monkeypatch.setenv("HELTO_PRIVACY_SESSION_DIR", str(tmp_path / "session"))
    monkeypatch.setenv(
        shared_artifacts.ARTIFACT_ROOT_ENV,
        str(tmp_path / "artifacts"),
    )
    monkeypatch.setattr(shared_runtime, "_INSTALLATIONS", {})
    monkeypatch.setattr(
        shared_runtime,
        "register_helto_privacy_ui",
        lambda **_kwargs: True,
    )
    monkeypatch.setattr(shared_keystore, "SCRYPT_N", 2**12)
    shared_migration.reset_migration_runtime_for_tests()
    shared_artifacts.reset_artifact_runtime_for_tests()
    register_legacy_reader_units(utils_legacy_reader_units())
    state = SelectorWorkflowStateAdapter()
    pack = install(
        build_selector_privacy_profile(),
        {
            "selector-mode-state": SelectorModeAdapter(),
            "selector-workflow-state": state,
            "selector-product-operations": InstalledOperationAdapter(),
            "selector-execution-projection": SelectorExecutionProjectionAdapter(),
            "selector-execution-dispatch": SelectorExecutionDispatchAdapter(
                lambda value, _context, _cancellation: value
            ),
            "selector-artifact-codec": SelectorArtifactCodecAdapter(
                mask_cache_dir=tmp_path / "legacy-masks",
                thumbnail_cache_dir=tmp_path / "legacy-thumbnails",
            ),
        },
    )
    password = "synthetic selector migration password"
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
            shared_migration.LegacyKeyFormat.BINARY,
            _authorization(pack, token, "migration.key-import"),
        )
        token = shared_keystore.session_token()
    return pack, state, token


def _legacy_fixture():
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _decode(value):
    return base64.b64decode(value.encode("ascii"), validate=True)


def test_profile_declares_one_private_selector_snapshot_and_all_operations():
    profile = build_selector_privacy_profile()

    assert [scope.id for scope in profile.scopes] == ["selector"]
    assert {field.id for field in profile.protected_fields} == {
        SELECTOR_SELECTED_FIELD_ID,
        SELECTOR_MASKS_FIELD_ID,
        SELECTOR_BBOXES_FIELD_ID,
    }
    assert all(field.execution for field in profile.protected_fields)
    assert {operation.id for operation in profile.protected_operations} == set(
        SELECTOR_OPERATION_IDS
    )
    assert [item.id for item in profile.execution_projections] == [
        SELECTOR_EXECUTION_PROJECTION_ID
    ]
    assert profile.artifacts
    assert profile.fingerprint == build_selector_privacy_profile().fingerprint


def test_selector_external_transition_codec_accepts_legacy_public_shapes():
    state = SelectorWorkflowStateAdapter()

    assert state.classify_mode_transition_representation(b"[]", object()) == "public"
    assert state.encode_public_mode_transition([], object()) == b'{"value":[]}'
    assert state.classify_mode_transition_representation(b"{}", object()) == "public"
    assert state.encode_public_mode_transition({}, object()) == b'{"value":{}}'


@pytest.mark.parametrize("generation", ("raw-xor", "priv1", "priv2", "priv3"))
def test_profile_bindings_decode_genuine_workflow_and_mask_generations(generation):
    profile = build_selector_privacy_profile()
    fixture = _legacy_fixture()
    item = fixture["generations"][generation]
    units = {unit.id: unit for unit in utils_legacy_reader_units()}
    byte_reader_id = {
        "raw-xor": UTILS_RAW_XOR_READER_ID,
        "priv1": UTILS_PRIV1_READER_ID,
        "priv2": UTILS_PRIV2_READER_ID,
        "priv3": UTILS_PRIV3_READER_ID,
    }[generation]
    workflow_reader_id = UTILS_WORKFLOW_READER_IDS[generation]
    context = LegacyContext()
    mask_source = _decode(item["mask"]["base64"])
    if generation == "raw-xor":
        mask_source = utils_raw_xor_source(mask_source, "selector-mask")

    assert units[workflow_reader_id].reader.read(item["workflow"], context) == (
        fixture["expected"]["workflow"]
    )
    assert units[byte_reader_id].reader.read(mask_source, context) == _decode(
        fixture["expected"]["maskBase64"]
    )
    for field_id in (
        SELECTOR_SELECTED_FIELD_ID,
        SELECTOR_MASKS_FIELD_ID,
        SELECTOR_BBOXES_FIELD_ID,
    ):
        assert any(
            binding.reader_id == workflow_reader_id
            and binding.location_id == field_id
            for binding in profile.legacy_bindings
        )
    assert any(
        binding.reader_id == byte_reader_id
        and binding.location_id == "selector-mask"
        for binding in profile.legacy_bindings
    )


def test_mode_and_state_adapters_default_private_normalize_apply_and_clear():
    node = Node()
    mode = SelectorModeAdapter()
    state = SelectorWorkflowStateAdapter()
    fields = {field.id: field for field in build_selector_privacy_profile().protected_fields}

    assert mode.read_declared_mode("selector") == "private"
    mode.write_declared_mode("selector", "public")
    assert mode.read_declared_mode("selector") == "public"
    assert state.capture(node, fields[SELECTOR_SELECTED_FIELD_ID]) == [
        "/synthetic/root/a.png"
    ]
    assert state.normalize(
        '["/synthetic/root/a.png", 12, "/synthetic/root/a.png"]',
        fields[SELECTOR_SELECTED_FIELD_ID],
    ) == {"value": ["/synthetic/root/a.png"]}
    assert state.normalize(
        '{"/synthetic/root/a.png":{"key":"legacy"}}',
        fields[SELECTOR_MASKS_FIELD_ID],
    ) == {"value": {"/synthetic/root/a.png": {"key": "legacy"}}}

    state.apply_revealed(
        node,
        {"value": ["/synthetic/root/b.png"]},
        fields[SELECTOR_SELECTED_FIELD_ID],
    )
    assert node.selectedPaths == ["/synthetic/root/b.png"]
    state.clear_plaintext(node, fields[SELECTOR_SELECTED_FIELD_ID])
    assert node.selectedPaths == []

    with pytest.raises(ValueError):
        state.normalize("not-json", fields[SELECTOR_SELECTED_FIELD_ID])


def test_execution_projection_is_exact_and_rejects_missing_fields():
    projection = SelectorExecutionProjectionAdapter()
    declaration = build_selector_privacy_profile().execution_projections[0]
    fields = {
        SELECTOR_SELECTED_FIELD_ID: {"value": ["/synthetic/root/a.png"]},
        SELECTOR_MASKS_FIELD_ID: {"value": {}},
        SELECTOR_BBOXES_FIELD_ID: {"value": {}},
    }

    assert projection.project(fields, declaration) == {
        "selected_images": ["/synthetic/root/a.png"],
        "edited_masks": {},
        "edited_bboxes": {},
    }
    with pytest.raises(ValueError):
        projection.project(
            {SELECTOR_SELECTED_FIELD_ID: fields[SELECTOR_SELECTED_FIELD_ID]},
            declaration,
        )


@dataclass
class Authorization:
    calls: list

    def authorize_request(self, _request, operation_id):
        return f"capability:{operation_id}"

    async def dispatch(self, request, scope_id, operation_id, operation):
        self.calls.append((request, scope_id, operation_id))
        return await operation("synthetic-authorization")


class OperationAdapter:
    async def invoke(self, operation_id, payload, context):
        assert context.workflow == "workflow-handle"
        assert context.artifacts == "artifact-handle"
        assert context.authorization == "synthetic-authorization"
        if operation_id == "selector.mask-migrate":
            assert context.migration_authorizations == SelectorMigrationAuthorizations(
                read="capability:migration.read",
                complete="capability:migration.complete",
                protect="capability:snapshot.protect",
                inspect="capability:snapshot.disposition",
            )
        return {"operation": operation_id, "payload": payload}


def test_protected_operations_use_bound_authorization_workflow_and_artifacts():
    authorization = Authorization([])
    operations = SelectorProtectedOperations(
        authorization,
        "workflow-handle",
        "artifact-handle",
        OperationAdapter(),
    )

    result = asyncio.run(
        operations.dispatch(
            "synthetic-request",
            "selector.scan",
            {"folders": ["/synthetic/root"]},
        )
    )

    assert result["operation"] == "selector.scan"
    assert authorization.calls == [
        ("synthetic-request", "selector", "selector.scan")
    ]
    with pytest.raises(ValueError):
        asyncio.run(operations.dispatch("synthetic-request", "undeclared", {}))

    migrated = asyncio.run(
        operations.dispatch("synthetic-request", "selector.mask-migrate", {})
    )
    assert migrated["operation"] == "selector.mask-migrate"


def test_product_operation_adapter_applies_real_root_authorization(tmp_path, monkeypatch):
    image = tmp_path / "synthetic.png"
    image.write_bytes(b"synthetic fixture bytes")
    adapter = SelectorProductOperationAdapter(
        authorized_roots=lambda: [str(tmp_path)],
        input_directory=lambda: str(tmp_path),
    )
    context = SelectorOperationContext("auth", "workflow", object())

    async def issue_source_lease(**_kwargs):
        from helto_privacy import ArtifactLease

        return ArtifactLease(f"hp-lease-{'S' * 32}", 60)

    monkeypatch.setattr(
        "helto_privacy.artifact_publication.issue_root_bound_source_lease",
        issue_source_lease,
    )

    result = asyncio.run(
        adapter.invoke("selector.source-view", {"path": str(image)}, context)
    )
    assert result == {
        "private": True,
        "lease": {
            "url": f"/helto_privacy/artifacts/hp-lease-{'S' * 32}",
            "expiresInSeconds": 60,
        },
    }

    outside = tmp_path.parent / f"{tmp_path.name}-outside.png"
    outside.write_bytes(b"synthetic fixture bytes")
    try:
        with pytest.raises(Exception) as raised:
            asyncio.run(
                adapter.invoke(
                    "selector.source-view",
                    {"path": str(outside)},
                    context,
                )
            )
        assert getattr(raised.value, "code", "") == "PRIVACY_ARTIFACT_SOURCE_REJECTED"
    finally:
        outside.unlink()


def test_product_operation_migrates_legacy_mask_reference_to_managed_artifact(
    tmp_path,
    monkeypatch,
):
    from helto_privacy import ArtifactReference
    from helto_selector_backend import mask_storage

    image = tmp_path / "synthetic.png"
    image.write_bytes(b"synthetic image fixture")
    plain_mask = tmp_path / "legacy-mask.png"
    encrypted_mask = tmp_path / "legacy-mask.png.enc"
    plain_mask.write_bytes(b"synthetic mask fixture")
    monkeypatch.setattr(
        mask_storage,
        "mask_cache_paths",
        lambda _path: (str(plain_mask), str(encrypted_mask)),
    )

    class Artifacts:
        async def write_mask(self, image_path, value, owner_id):
            assert image_path == str(image)
            assert value == b"synthetic mask fixture"
            assert owner_id.startswith("hp-owner-")
            return ArtifactReference(f"hp-art-{'M' * 32}")

    adapter = SelectorProductOperationAdapter(
        authorized_roots=lambda: [str(tmp_path)],
        input_directory=lambda: str(tmp_path),
    )
    result = asyncio.run(
        adapter.invoke(
            "selector.mask-migrate",
            {"masks": {str(image): {"key": "legacy"}}},
            SelectorOperationContext("auth", "workflow", Artifacts()),
        )
    )

    assert result["migratedCount"] == 1
    assert result["masks"][str(image)]["schema"] == "helto.private-artifact-reference"


def test_product_operation_migrates_raw_xor_mask_through_explicit_carrier(
    tmp_path,
    monkeypatch,
):
    from helto_privacy import ArtifactReference
    from helto_selector_backend import mask_storage

    pack, _state, token = _installed_selector_pack(tmp_path, monkeypatch)
    image = tmp_path / "synthetic.png"
    image.write_bytes(b"synthetic image fixture")
    plain_mask = tmp_path / "legacy-mask.png"
    encrypted_mask = tmp_path / "legacy-mask.png.enc"
    encrypted_mask.write_bytes(b"synthetic raw xor mask")
    monkeypatch.setattr(
        mask_storage,
        "mask_cache_paths",
        lambda _path: (str(plain_mask), str(encrypted_mask)),
    )

    class Artifacts:
        async def write_mask(self, image_path, value, owner_id):
            assert image_path == str(image)
            assert isinstance(value, bytes)
            assert owner_id.startswith("hp-owner-")
            return ArtifactReference(f"hp-art-{'R' * 32}")

    adapter = SelectorProductOperationAdapter(
        authorized_roots=lambda: [str(tmp_path)],
        input_directory=lambda: str(tmp_path),
    )
    result = asyncio.run(
        adapter.invoke(
            "selector.mask-migrate",
            {"masks": {str(image): {"key": "legacy"}}},
            SelectorOperationContext(
                "auth",
                "workflow",
                Artifacts(),
                SelectorMigrationAuthorizations(
                    _authorization(
                        pack,
                        token,
                        "migration.read",
                    ),
                    _authorization(
                        pack,
                        token,
                        "migration.complete",
                    ),
                    _authorization(
                        pack,
                        token,
                        "snapshot.protect",
                    ),
                    _authorization(
                        pack,
                        token,
                        "snapshot.disposition",
                    ),
                ),
                pack.migration,
            ),
        )
    )

    assert result["migratedCount"] == 1
    assert result["masks"][str(image)]["id"].startswith("hp-art-")


class WorkflowHandle:
    def protect(self, field_id, value, authorization):
        assert authorization == "synthetic-authorization"
        assert value is not None
        return ProtectedFieldResult(
            EnvelopeDisposition.VERIFIED_CURRENT,
            {
                "version": ENVELOPE_VERSION,
                "schema": "current",
                "encrypted": True,
                "algorithm": ALGORITHM,
                "keyId": "synthetic-key",
                "nonce": "synthetic-nonce",
                "ciphertext": field_id,
            },
        )

    def inspect_disposition(self, field_id, value, authorization):
        assert field_id == value["ciphertext"]
        assert authorization == "synthetic-authorization"
        return DispositionResult(EnvelopeDisposition.VERIFIED_CURRENT)


class WorkflowStore:
    def __init__(self):
        self.fields = {
            SELECTOR_SELECTED_FIELD_ID: "LEGACY_SELECTED_BYTES",
            SELECTOR_MASKS_FIELD_ID: "LEGACY_MASK_MAP_BYTES",
            SELECTOR_BBOXES_FIELD_ID: "LEGACY_BBOX_BYTES",
        }
        self.fail_commit = False

    def read_fields(self):
        return dict(self.fields)

    def replace_fields(self, fields):
        if self.fail_commit:
            raise OSError("synthetic commit failure")
        self.fields = dict(fields)


class ArtifactGateway:
    def __init__(self):
        self.values = {}
        self.retired = []

    def write_mask(self, image_path, value, owner_id):
        reference = {"id": f"managed-{len(self.values)}"}
        self.values[reference["id"]] = bytes(value)
        return reference

    def read_mask(self, image_path, reference):
        return self.values[reference["id"]]

    def retire_mask(self, image_path, reference):
        self.retired.append(reference["id"])
        self.values.pop(reference["id"], None)


class FailingRetirementGateway(ArtifactGateway):
    def retire_mask(self, image_path, reference):
        raise OSError("synthetic cleanup failure")


class LegacyMaskSource:
    def __init__(self, source_bytes=b"LEGACY_MASK_BYTES"):
        self.bytes = {"/synthetic/root/a.png": source_bytes}
        self.retired = []

    def capture(self, image_path):
        return self.bytes[image_path]

    def retire_if_unchanged(self, image_path, expected):
        assert self.bytes[image_path] == expected
        self.retired.append(image_path)
        del self.bytes[image_path]


def _expected_selector_state():
    return {
        SELECTOR_SELECTED_FIELD_ID: {"value": ["/synthetic/root/a.png"]},
        SELECTOR_MASKS_FIELD_ID: {
            "value": {"/synthetic/root/a.png": {"key": "legacy"}}
        },
        SELECTOR_BBOXES_FIELD_ID: {"value": {}},
    }


@pytest.mark.parametrize("generation", ("raw-xor", "priv1", "priv2", "priv3"))
def test_selector_transaction_stages_each_mask_generation_with_fields(generation):
    fixture = _legacy_fixture()
    item = fixture["generations"][generation]
    source_bytes = _decode(item["mask"]["base64"])
    current_png = _decode(fixture["expected"]["maskBase64"])
    store = WorkflowStore()
    artifacts = ArtifactGateway()
    legacy_masks = LegacyMaskSource(source_bytes)
    transaction = SelectorWorkflowMigrationTransaction(
        WorkflowHandle(),
        store,
        artifacts,
        legacy_masks,
        "synthetic-authorization",
        {"/synthetic/root/a.png": current_png},
    )
    original = transaction.capture_original()
    expected = _expected_selector_state()

    transaction.stage_current(expected)
    transaction.stage_durable_adjuncts(expected)
    transaction.commit()
    verification = transaction.read_back()

    assert verification == MigrationVerification(expected, True, True)
    assert set(artifacts.values) == {"managed-0"}
    assert legacy_masks.bytes["/synthetic/root/a.png"] == source_bytes
    transaction.finalize(original)
    assert legacy_masks.retired == ["/synthetic/root/a.png"]


def test_selector_transaction_failure_restores_exact_workflow_and_mask_bytes():
    store = WorkflowStore()
    original_fields = dict(store.fields)
    artifacts = ArtifactGateway()
    legacy_masks = LegacyMaskSource()
    transaction = SelectorWorkflowMigrationTransaction(
        WorkflowHandle(),
        store,
        artifacts,
        legacy_masks,
        "synthetic-authorization",
        {"/synthetic/root/a.png": b"CURRENT_PNG_BYTES"},
    )
    original = transaction.capture_original()
    transaction.stage_current(_expected_selector_state())
    transaction.stage_durable_adjuncts(_expected_selector_state())
    store.fields = {"partial": "write"}

    transaction.rollback(original)

    assert store.fields == original_fields
    assert legacy_masks.bytes == {
        "/synthetic/root/a.png": b"LEGACY_MASK_BYTES"
    }
    assert artifacts.values == {}


def test_selector_rollback_succeeds_when_managed_cleanup_is_deferred():
    store = WorkflowStore()
    original_fields = dict(store.fields)
    artifacts = FailingRetirementGateway()
    transaction = SelectorWorkflowMigrationTransaction(
        WorkflowHandle(),
        store,
        artifacts,
        LegacyMaskSource(),
        "synthetic-authorization",
        {"/synthetic/root/a.png": b"CURRENT_PNG_BYTES"},
    )
    original = transaction.capture_original()
    transaction.stage_current(_expected_selector_state())
    transaction.stage_durable_adjuncts(_expected_selector_state())
    store.fields = {"partial": "write"}

    transaction.rollback(original)

    assert store.fields == original_fields


def test_selector_transaction_aborts_without_overwriting_concurrent_source_change():
    store = WorkflowStore()
    artifacts = ArtifactGateway()
    legacy_masks = LegacyMaskSource()
    captured = {
        "fields": dict(store.fields),
        "masks": {"/synthetic/root/a.png": b"LEGACY_MASK_BYTES"},
    }
    transaction = SelectorWorkflowMigrationTransaction(
        WorkflowHandle(),
        store,
        artifacts,
        legacy_masks,
        "synthetic-authorization",
        {"/synthetic/root/a.png": b"CURRENT_PNG_BYTES"},
        captured_original=captured,
    )
    original = transaction.capture_original()
    transaction.stage_current(_expected_selector_state())
    transaction.stage_durable_adjuncts(_expected_selector_state())
    concurrent_fields = {field_id: f"NEW_{field_id}" for field_id in store.fields}
    store.fields = dict(concurrent_fields)
    legacy_masks.bytes["/synthetic/root/a.png"] = b"NEW_MASK_BYTES"

    with pytest.raises(RuntimeError, match="source changed"):
        transaction.commit()
    transaction.rollback(original)

    assert store.fields == concurrent_fields
    assert legacy_masks.bytes["/synthetic/root/a.png"] == b"NEW_MASK_BYTES"
    assert artifacts.values == {}


def test_legacy_mask_finalization_is_idempotent(tmp_path):
    from helto_selector_backend.mask_storage import mask_cache_paths

    image_path = str(tmp_path / "synthetic.png")
    plain_path, _encrypted_path = mask_cache_paths(image_path, str(tmp_path / "masks"))
    source = Path(plain_path)
    source.parent.mkdir()
    source.write_bytes(b"ORIGINAL_MASK_BYTES")
    masks = SelectorLegacyMaskFiles(source.parent)

    original = masks.capture(image_path)
    SelectorLegacyMaskFiles(source.parent).retire_if_unchanged(image_path, original)
    SelectorLegacyMaskFiles(source.parent).retire_if_unchanged(image_path, original)

    assert not source.exists()


def test_async_artifact_gateway_rejects_event_loop_thread_use():
    async def exercise():
        managed = AsyncManagedArtifacts()
        gateway = SelectorAsyncArtifactMigrationGateway(
            managed,
            asyncio.get_running_loop(),
        )
        with pytest.raises(RuntimeError, match="worker thread"):
            gateway.read_mask("/synthetic/root/a.png", {"id": "missing"})

    asyncio.run(exercise())


@pytest.mark.parametrize("generation", ("raw-xor", "priv1", "priv2", "priv3"))
def test_coordinator_migrates_all_fields_and_mask_under_one_receipt(
    tmp_path,
    monkeypatch,
    generation,
):
    pack, state, token = _installed_selector_pack(tmp_path, monkeypatch)
    fixture = _legacy_fixture()
    generation_fixture = fixture["generations"][generation]
    original_fields = {
        field_id: generation_fixture["selectorMigration"][field_name]["workflow"]
        for field_id, field_name in (
            (SELECTOR_SELECTED_FIELD_ID, "selected_images"),
            (SELECTOR_MASKS_FIELD_ID, "edited_masks"),
            (SELECTOR_BBOXES_FIELD_ID, "edited_bboxes"),
        )
    }
    store = WorkflowStore()
    store.fields = dict(original_fields)
    legacy_masks = LegacyMaskSource(_decode(generation_fixture["mask"]["base64"]))
    managed = AsyncManagedArtifacts()
    coordinator = SelectorMigrationCoordinator(
        pack.migration,
        pack.workflow("selector-workflow"),
        store,
        managed,
        legacy_masks,
        state,
    )

    receipt = asyncio.run(
        coordinator.migrate(
            SelectorMigrationAuthorizations(
                read=_authorization(pack, token, "migration.read"),
                complete=_authorization(pack, token, "migration.complete"),
                protect=_authorization(pack, token, "snapshot.protect"),
                inspect=_authorization(pack, token, "snapshot.disposition"),
            )
        )
    )

    assert receipt.disposition == "migrated"
    assert len(receipt.obligation_ids) == 4
    assert store.fields != original_fields
    assert legacy_masks.bytes == {}
    assert len(managed.values) == 1
    assert next(iter(managed.values.values())) == _decode(
        fixture["expected"]["maskBase64"]
    )
    shared_artifacts.reset_artifact_runtime_for_tests()


def test_coordinator_failure_restores_bytes_and_leaves_all_obligations_open(
    tmp_path,
    monkeypatch,
):
    pack, state, token = _installed_selector_pack(tmp_path, monkeypatch)
    generation_fixture = _legacy_fixture()["generations"]["priv2"]
    original_fields = {
        field_id: generation_fixture["selectorMigration"][field_name]["workflow"]
        for field_id, field_name in (
            (SELECTOR_SELECTED_FIELD_ID, "selected_images"),
            (SELECTOR_MASKS_FIELD_ID, "edited_masks"),
            (SELECTOR_BBOXES_FIELD_ID, "edited_bboxes"),
        )
    }
    original_mask = _decode(generation_fixture["mask"]["base64"])
    store = WorkflowStore()
    store.fields = dict(original_fields)
    legacy_masks = LegacyMaskSource(original_mask)
    managed = AsyncManagedArtifacts(corrupt_read=True)
    coordinator = SelectorMigrationCoordinator(
        pack.migration,
        pack.workflow("selector-workflow"),
        store,
        managed,
        legacy_masks,
        state,
    )

    with pytest.raises(shared_migration.MigrationError) as failure:
        asyncio.run(
            coordinator.migrate(
                SelectorMigrationAuthorizations(
                    read=_authorization(pack, token, "migration.read"),
                    complete=_authorization(pack, token, "migration.complete"),
                    protect=_authorization(pack, token, "snapshot.protect"),
                    inspect=_authorization(pack, token, "snapshot.disposition"),
                )
            )
        )

    assert failure.value.code == "migration_verification_failed"
    assert store.fields == original_fields
    assert legacy_masks.bytes == {"/synthetic/root/a.png": original_mask}
    assert managed.values == {}
    assert sum(status.unresolved for status in pack.migration.status()) == 4
    shared_artifacts.reset_artifact_runtime_for_tests()

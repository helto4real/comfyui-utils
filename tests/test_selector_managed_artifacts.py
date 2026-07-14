from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

import helto_privacy.artifacts as shared_artifacts
import helto_privacy.keystore as shared_keystore
import helto_privacy.runtime as shared_runtime
from helto_privacy import (
    AdapterSlot,
    ArtifactError,
    PrivacyProfile,
    PrivacyScope,
    PrivateByDefaultModeAdapter,
    ProfileResource,
    ResourceKind,
    UTILS_PRIV3_READER_ID,
    UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
    generate_artifact_owner_id,
    utils_legacy_reader_units,
)
from helto_privacy.guard import authorize_privacy_request

from helto_selector_backend.managed_artifacts import (
    SELECTOR_ARTIFACT_ADAPTER_ID,
    SELECTOR_ARTIFACT_CONTRACTS,
    SELECTOR_ARTIFACT_DECLARATIONS,
    SELECTOR_ARTIFACT_RESOURCE_ID,
    SELECTOR_ARTIFACT_SCOPE_ID,
    SELECTOR_MASK_ARTIFACT_KIND,
    SELECTOR_THUMBNAIL_ARTIFACT_KIND,
    SelectorArtifactCodecAdapter,
    SelectorArtifactTransitionBlocked,
    SelectorManagedArtifacts,
)
from helto_selector_backend.services import SelectorPathError
from helto_selector_backend.thumbnail_cache import (
    generate_thumbnail_bytes,
    thumbnail_cache_paths,
)


FIXTURES = Path(__file__).parent / "fixtures" / "historical"
pytestmark = pytest.mark.usefixtures("coordinated_suite_test_boundary")


class _ModeAdapter(PrivateByDefaultModeAdapter):
    pass


class _ImportedKeys:
    def key_for(self, import_id: str) -> bytes:
        assert import_id == UTILS_PRIVACY_KEY_BIN_IMPORT_ID
        return hashlib.sha256(
            b"helto-utils-privacy-key-bin-historical-fixture-key"
        ).digest()


class _Request:
    def __init__(self, token: str) -> None:
        self.headers = {"X-Helto-Privacy-Token": token}
        self.cookies = {}


def _profile() -> PrivacyProfile:
    return PrivacyProfile(
        id="helto.utils-selector-artifact-test",
        distribution="comfyui-utils-selector-artifact-test",
        resources=(
            ProfileResource("selector-mode", ResourceKind.MODE, ("selector-mode",)),
            ProfileResource(
                SELECTOR_ARTIFACT_RESOURCE_ID,
                ResourceKind.ARTIFACT,
                (SELECTOR_ARTIFACT_ADAPTER_ID,),
            ),
        ),
        server_adapters=(
            AdapterSlot("selector-mode", ResourceKind.MODE, "selector-mode"),
            AdapterSlot(
                SELECTOR_ARTIFACT_ADAPTER_ID,
                ResourceKind.ARTIFACT,
                SELECTOR_ARTIFACT_RESOURCE_ID,
            ),
        ),
        scopes=(
            PrivacyScope(
                SELECTOR_ARTIFACT_SCOPE_ID,
                "selector-mode",
                "selector-mode",
            ),
        ),
        artifacts=SELECTOR_ARTIFACT_DECLARATIONS,
    )


@pytest.fixture
def managed_artifacts(
    tmp_path,
    monkeypatch,
    coordinated_suite_test_boundary,
):
    artifact_root = tmp_path / "managed"
    mask_cache = tmp_path / "legacy-masks"
    thumbnail_cache = tmp_path / "legacy-thumbnails"
    monkeypatch.setenv(shared_artifacts.ARTIFACT_ROOT_ENV, str(artifact_root))
    monkeypatch.setenv("HELTO_PRIVACY_KEYSTORE", str(tmp_path / "keystore.json"))
    monkeypatch.setenv("HELTO_PRIVACY_SESSION_DIR", str(tmp_path / "session"))
    monkeypatch.setattr(shared_runtime, "_INSTALLATIONS", {})
    monkeypatch.setattr(
        shared_runtime,
        "register_helto_privacy_ui",
        lambda **_kwargs: True,
    )
    monkeypatch.setattr(shared_keystore, "SCRYPT_N", 2**12)
    shared_artifacts.reset_artifact_runtime_for_tests()
    token = shared_keystore.initialize_keystore("synthetic selector password")["token"]
    adapter = SelectorArtifactCodecAdapter(
        mask_cache_dir=mask_cache,
        thumbnail_cache_dir=thumbnail_cache,
    )
    pack = shared_runtime.install(
        _profile(),
        {
            "selector-mode": _ModeAdapter(),
            SELECTOR_ARTIFACT_ADAPTER_ID: adapter,
        },
    )
    root = tmp_path / "images"
    root.mkdir()
    service = SelectorManagedArtifacts(
        pack.artifacts(SELECTOR_ARTIFACT_RESOURCE_ID),
        authorized_roots=lambda: (str(root),),
    )
    yield service, adapter, pack, artifact_root, root, token
    shared_artifacts.reset_artifact_runtime_for_tests()


def _write_image(path: Path, color: tuple[int, int, int]) -> bytes:
    Image.new("RGB", (24, 16), color).save(path, format="PNG")
    return path.read_bytes()


def test_selector_artifact_contract_declares_product_facts():
    declarations = {item.id: item for item in SELECTOR_ARTIFACT_DECLARATIONS}
    contracts = {item.declaration.id: item for item in SELECTOR_ARTIFACT_CONTRACTS}

    mask = declarations[SELECTOR_MASK_ARTIFACT_KIND]
    thumbnail = declarations[SELECTOR_THUMBNAIL_ARTIFACT_KIND]
    assert mask.retention.value == "durable-adjunct"
    assert mask.purpose == "selector-mask"
    assert mask.media_type == "image/png"
    assert mask.operations == ("preview", "use")
    assert thumbnail.retention.value == "regenerable-cache"
    assert thumbnail.purpose == "selector-thumbnail"
    assert thumbnail.media_type == "image/webp"
    assert thumbnail.operations == ("preview",)
    assert contracts[SELECTOR_MASK_ARTIFACT_KIND].owner_policy == "workflow-mask"
    assert contracts[SELECTOR_THUMBNAIL_ARTIFACT_KIND].owner_policy == "source-revision"
    assert contracts[SELECTOR_MASK_ARTIFACT_KIND].requires_allowed_root is True
    assert contracts[SELECTOR_THUMBNAIL_ARTIFACT_KIND].requires_allowed_root is True
    assert contracts[SELECTOR_MASK_ARTIFACT_KIND].plaintext_derivatives == (
        "legacy-mask-cache-png",
    )
    assert contracts[SELECTOR_THUMBNAIL_ARTIFACT_KIND].plaintext_derivatives == (
        "legacy-thumbnail-cache-webp",
    )


def test_historical_priv3_mask_moves_through_real_managed_handle(managed_artifacts):
    service, _adapter, _pack, artifact_root, root, _token = managed_artifacts
    fixture = json.loads(
        (FIXTURES / "selector_mask_priv3.json").read_text(encoding="utf-8")
    )
    ciphertext = base64.b64decode(fixture["ciphertextBase64"], validate=True)
    assert hashlib.sha256(ciphertext).hexdigest() == fixture["ciphertextSha256"]
    unit = {
        candidate.id: candidate for candidate in utils_legacy_reader_units()
    }[UTILS_PRIV3_READER_ID]
    historical_png = unit.reader.read(ciphertext, _ImportedKeys())
    assert historical_png == base64.b64decode(fixture["expectedBase64"], validate=True)
    assert hashlib.sha256(historical_png).hexdigest() == fixture["expectedSha256"]
    with Image.open(BytesIO(historical_png)) as historical_mask:
        historical_mask.load()
        assert historical_mask.format == "PNG"
        assert historical_mask.mode == "L"
        assert historical_mask.size == (2, 2)
    image_path = root / "source.png"
    _write_image(image_path, (20, 40, 60))

    async def exercise():
        owner = generate_artifact_owner_id()
        reference = await service.write_mask(str(image_path), historical_png, owner)
        revealed = await service.read_mask(str(image_path), reference)
        return reference, revealed

    reference, revealed = asyncio.run(exercise())

    assert revealed == historical_png
    assert reference.to_payload()["schema"] == "helto.private-artifact-reference"
    stored = list(artifact_root.rglob("*.hpa"))
    assert len(stored) == 1
    assert historical_png not in stored[0].read_bytes()
    assert not list(artifact_root.rglob("*.png"))


def test_thumbnail_regenerates_via_product_encoder_and_retires_stale_reference(
    managed_artifacts,
):
    service, _adapter, _pack, _artifact_root, root, _token = managed_artifacts
    image_path = root / "source.png"
    _write_image(image_path, (255, 0, 0))

    async def exercise():
        first_reference, first_bytes = await service.thumbnail(str(image_path))
        previous_mtime = image_path.stat().st_mtime_ns
        _write_image(image_path, (0, 0, 255))
        os.utime(image_path, ns=(previous_mtime + 1_000_000, previous_mtime + 1_000_000))
        second_reference, second_bytes = await service.thumbnail(str(image_path))
        with pytest.raises(ArtifactError):
            await service.handle.read(
                SELECTOR_THUMBNAIL_ARTIFACT_KIND,
                first_reference,
            )
        return first_reference, first_bytes, second_reference, second_bytes

    first_reference, first_bytes, second_reference, second_bytes = asyncio.run(
        exercise()
    )

    assert first_reference != second_reference
    assert first_bytes != second_bytes
    with Image.open(Path(image_path)) as source:
        assert source.size == (24, 16)
    with Image.open(BytesIO(second_bytes)) as thumbnail:
        assert thumbnail.format == "WEBP"
        assert thumbnail.size == (24, 16)


def test_unreadable_managed_thumbnail_is_discarded_and_regenerated(
    managed_artifacts,
):
    service, _adapter, _pack, artifact_root, root, _token = managed_artifacts
    image_path = root / "source.png"
    _write_image(image_path, (120, 30, 10))

    async def exercise():
        first_reference, first_bytes = await service.thumbnail(str(image_path))
        stored = next(artifact_root.rglob(f"{first_reference.id}.hpa"))
        stored.write_bytes(b"synthetic corrupt managed cache")
        second_reference, second_bytes = await service.thumbnail(str(image_path))
        return first_reference, first_bytes, second_reference, second_bytes

    first_reference, first_bytes, second_reference, second_bytes = asyncio.run(
        exercise()
    )

    assert second_reference != first_reference
    assert second_bytes == first_bytes
    assert not list(artifact_root.rglob(f"{first_reference.id}.hpa"))


def test_mask_and_thumbnail_leases_are_opaque_and_operation_scoped(managed_artifacts):
    service, _adapter, pack, artifact_root, root, token = managed_artifacts
    image_path = root / "source.png"
    mask_png = _write_image(image_path, (80, 90, 100))
    request = _Request(token)

    async def exercise():
        mask = await service.write_mask(
            str(image_path),
            mask_png,
            generate_artifact_owner_id(),
        )
        authorization = authorize_privacy_request(
            request,
            "artifact.preview",
            pack_id=pack.profile.id,
        )
        mask_lease = await service.mask_lease(str(image_path), mask, authorization)
        thumbnail_lease = await service.thumbnail_lease(str(image_path), authorization)
        return mask, mask_lease, thumbnail_lease

    mask, mask_lease, thumbnail_lease = asyncio.run(exercise())

    for lease in (mask_lease, thumbnail_lease):
        payload = json.dumps(lease.to_payload())
        assert lease.url.startswith("/helto_privacy/artifacts/hp-lease-")
        assert str(image_path) not in payload
        assert mask.id not in payload
        assert token not in payload
        assert str(artifact_root) not in payload


def test_allowed_root_rejection_happens_before_product_encoding(
    managed_artifacts,
):
    service, _adapter, _pack, _artifact_root, root, _token = managed_artifacts
    outside_path = root.parent / "outside.png"
    _write_image(outside_path, (4, 5, 6))
    encode_calls = []
    guarded_service = SelectorManagedArtifacts(
        service.handle,
        authorized_roots=lambda: (str(root),),
        thumbnail_encoder=lambda path: encode_calls.append(path) or b"webp",
    )

    with pytest.raises(SelectorPathError) as failure:
        asyncio.run(guarded_service.thumbnail(str(outside_path)))

    assert failure.value.status_code == 403
    assert encode_calls == []
    assert guarded_service.thumbnail_count == 0


def test_thumbnail_encoder_remains_bound_to_authorized_file_during_symlink_swap(
    managed_artifacts,
):
    service, _adapter, _pack, _artifact_root, root, _token = managed_artifacts
    inside_path = root / "inside.png"
    outside_path = root.parent / "outside.png"
    alias_path = root / "alias.png"
    _write_image(inside_path, (255, 0, 0))
    _write_image(outside_path, (0, 0, 255))
    alias_path.symlink_to(inside_path)

    def swapping_encoder(source):
        alias_path.unlink()
        alias_path.symlink_to(outside_path)
        return generate_thumbnail_bytes(source)

    guarded_service = SelectorManagedArtifacts(
        service.handle,
        authorized_roots=lambda: (str(root),),
        thumbnail_encoder=swapping_encoder,
    )

    _reference, thumbnail_bytes = asyncio.run(
        guarded_service.thumbnail(str(alias_path))
    )

    with Image.open(BytesIO(thumbnail_bytes)) as thumbnail:
        red, _green, blue = thumbnail.convert("RGB").getpixel((0, 0))
    assert red > 200
    assert blue < 80
    assert os.path.realpath(alias_path) == str(outside_path)


def test_storage_failure_leaves_no_reference_or_plaintext_artifact(
    managed_artifacts,
    monkeypatch,
):
    service, _adapter, _pack, artifact_root, root, _token = managed_artifacts
    image_path = root / "source.png"
    _write_image(image_path, (1, 2, 3))
    original_write = shared_artifacts.atomic_write_private_bytes

    def fail_artifact_payload(path, payload):
        if Path(path).suffix == ".hpa":
            raise OSError("synthetic fault")
        return original_write(path, payload)

    monkeypatch.setattr(
        shared_artifacts,
        "atomic_write_private_bytes",
        fail_artifact_payload,
    )

    with pytest.raises(ArtifactError) as failure:
        asyncio.run(service.thumbnail(str(image_path)))

    assert failure.value.code == "PRIVACY_ARTIFACT_STORAGE_FAILED"
    assert service.thumbnail_count == 0
    assert not list(artifact_root.rglob("*.hpa"))
    assert not list(artifact_root.rglob("*.webp"))


def test_cleanup_failure_invalidates_previous_thumbnail_and_recovers_on_next_read(
    managed_artifacts,
    monkeypatch,
):
    service, _adapter, _pack, artifact_root, root, _token = managed_artifacts
    image_path = root / "source.png"
    _write_image(image_path, (255, 0, 0))

    async def prime():
        return await service.thumbnail(str(image_path))

    previous_reference, previous_bytes = asyncio.run(prime())
    previous_path = next(artifact_root.rglob(f"{previous_reference.id}.hpa"))
    previous_mtime = image_path.stat().st_mtime_ns
    _write_image(image_path, (0, 255, 0))
    os.utime(image_path, ns=(previous_mtime + 1_000_000, previous_mtime + 1_000_000))
    original_unlink = Path.unlink

    def fail_previous_unlink(path, *args, **kwargs):
        if path == previous_path:
            raise OSError("synthetic cleanup fault")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_previous_unlink)

    with pytest.raises(ArtifactError) as failure:
        asyncio.run(service.thumbnail(str(image_path)))

    assert failure.value.code == "PRIVACY_ARTIFACT_CLEANUP_FAILED"
    assert service.thumbnail_count == 1
    reference_after_failure, bytes_after_failure = asyncio.run(
        service.thumbnail(str(image_path), regenerate=False)
    )
    assert reference_after_failure != previous_reference
    assert bytes_after_failure != previous_bytes
    with pytest.raises(ArtifactError) as invalidated:
        asyncio.run(
            service.handle.read(
                SELECTOR_THUMBNAIL_ARTIFACT_KIND,
                previous_reference,
            )
        )
    assert invalidated.value.code == "PRIVACY_ARTIFACT_REFERENCE_INVALID"
    assert previous_path.exists()

    monkeypatch.setattr(Path, "unlink", original_unlink)
    report = asyncio.run(service.startup_recover())

    assert report.retired >= 1
    assert service.thumbnail_count == 0
    assert not previous_path.exists()


def test_startup_sweep_and_plaintext_derivative_policy(managed_artifacts):
    service, adapter, _pack, artifact_root, root, _token = managed_artifacts
    image_path = root / "source.png"
    _write_image(image_path, (20, 30, 40))
    mask_plain = adapter.mask_cache_dir / "legacy.png"
    mask_encrypted = adapter.mask_cache_dir / "legacy.png.enc"
    thumb_plain, thumb_encrypted = thumbnail_cache_paths(
        str(image_path),
        adapter.thumbnail_cache_dir,
    )
    adapter.mask_cache_dir.mkdir(parents=True)
    adapter.thumbnail_cache_dir.mkdir(parents=True)
    mask_plain.write_bytes(b"synthetic legacy mask")
    mask_encrypted.write_bytes(b"synthetic encrypted mask")
    Path(thumb_plain).write_bytes(b"synthetic thumbnail")
    Path(thumb_encrypted).write_bytes(b"synthetic encrypted thumbnail")
    interrupted = artifact_root / "orphan.hpa.tmp"
    artifact_root.mkdir(parents=True, exist_ok=True)
    interrupted.write_bytes(b"synthetic interrupted write")

    adapter.purge_plaintext_derivatives(SELECTOR_THUMBNAIL_ARTIFACT_KIND)
    assert not Path(thumb_plain).exists()
    assert Path(thumb_encrypted).exists()
    with pytest.raises(SelectorArtifactTransitionBlocked):
        adapter.purge_plaintext_derivatives(SELECTOR_MASK_ARTIFACT_KIND)
    assert mask_plain.exists()
    assert mask_encrypted.exists()

    report = asyncio.run(service.startup_recover())

    assert report.temp_variants == 1
    assert not interrupted.exists()


def test_managed_artifact_module_keeps_product_codecs_consumer_owned():
    from helto_selector_backend import mask_storage, services, thumbnail_cache

    assert services.save_mask_data_url is mask_storage.save_mask_data_url
    assert services.get_thumbnail_bytes is thumbnail_cache.get_thumbnail_bytes

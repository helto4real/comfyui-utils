from __future__ import annotations

import asyncio

import pytest
from helto_privacy import ArtifactLease, ArtifactReference

from shared.private_media_managed import (
    IMAGE_COMPARER_PREVIEW_KIND,
    LOAD_VIDEO_THUMBNAIL_KIND,
    PRIVATE_MEDIA_ALLOWED_SOURCE_ROOTS,
    PRIVATE_MEDIA_ARTIFACT_CONTRACTS,
    PRIVATE_MEDIA_GENERATED_DERIVATIVES,
    PRIVATE_MEDIA_IMAGE_PREVIEW_KIND,
    PRIVATE_MEDIA_SOURCE_CONTRACT,
    PRIVATE_MEDIA_SOURCE_OPERATION_ID,
    PRIVATE_MEDIA_SOURCE_TYPES,
    PRIVATE_MEDIA_VIDEO_PREVIEW_KIND,
    SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE,
    SAVE_VIDEO_REPLAY_KIND,
    VIDEO_COMPARER_PREVIEW_KIND,
    PrivateMediaArtifactCodecAdapter,
    PrivateMediaManagedArtifacts,
    PrivateMediaModeAdapter,
    PrivateMediaProtectedOperations,
    PrivateMediaSourceOperationAdapter,
    build_private_media_profile,
)


class ArtifactHandle:
    def __init__(self) -> None:
        self.writes = []
        self.retired = []
        self.released = []
        self.sweeps = 0

    async def write(self, artifact_kind, owner_id, value):
        reference = ArtifactReference(f"hp-art-{'A' * 31}{len(self.writes)}")
        self.writes.append((artifact_kind, owner_id, value, reference))
        return reference

    async def retire(self, artifact_kind, reference):
        self.retired.append((artifact_kind, reference))
        return 1

    async def release_owner(self, owner_id):
        self.released.append(owner_id)
        return 2

    async def sweep(self):
        self.sweeps += 1
        return "swept"


def test_profile_declares_typed_previews_source_operation_and_private_default():
    profile = build_private_media_profile()
    declarations = {item.id: item for item in profile.artifacts}

    assert PrivateMediaModeAdapter().read_declared_mode("private-media") == "private"
    assert set(declarations) == {
        IMAGE_COMPARER_PREVIEW_KIND,
        LOAD_VIDEO_THUMBNAIL_KIND,
        PRIVATE_MEDIA_IMAGE_PREVIEW_KIND,
        *SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE.values(),
        SAVE_VIDEO_REPLAY_KIND,
        VIDEO_COMPARER_PREVIEW_KIND,
    }
    assert declarations[PRIVATE_MEDIA_IMAGE_PREVIEW_KIND].media_type == "image/png"
    assert declarations[PRIVATE_MEDIA_VIDEO_PREVIEW_KIND].media_type == "video/mp4"
    assert [item.id for item in profile.protected_operations] == [
        PRIVATE_MEDIA_SOURCE_OPERATION_ID
    ]
    assert profile.protected_operations[0].route == "/helto-utils/private-media/source"
    assert profile.fingerprint == build_private_media_profile().fingerprint


def test_artifact_and_source_contracts_keep_unrelated_facts_separate():
    assert set(PRIVATE_MEDIA_ALLOWED_SOURCE_ROOTS) == {
        "comfy-input",
        "comfy-output",
        "enabled-load-video-folder",
    }
    assert set(PRIVATE_MEDIA_GENERATED_DERIVATIVES) == {
        "temp/helto.compare.*",
        "temp/helto_cache/HeltoLoadVideo/thumbnails/**",
        "temp/helto_cache/HeltoSaveVideoAdvanced/replay/**",
        "temp/helto_load_video/**",
        "temp/helto_private/HeltoSaveVideoAdvanced/replay/**",
        "temp/helto_private/image_comparer/**",
        "temp/helto_private/save_image_advanced/**",
        "temp/helto_private/save_video_advanced/**",
        "temp/helto_private/video_comparer/**",
        "temp/helto_save_image_advanced/**",
        "temp/helto_save_video_advanced/**",
        "temp/helto_save_video_private_*/**",
        "temp/helto_video_comparer/**",
    }
    assert len(PRIVATE_MEDIA_ARTIFACT_CONTRACTS) == 12
    assert {
        derivative
        for contract in PRIVATE_MEDIA_ARTIFACT_CONTRACTS
        for derivative in contract.plaintext_derivatives
    } == set(PRIVATE_MEDIA_GENERATED_DERIVATIVES)
    assert PRIVATE_MEDIA_SOURCE_CONTRACT.allowed_source_roots == (
        "comfy-input",
        "comfy-output",
        "enabled-load-video-folder",
    )
    assert PRIVATE_MEDIA_SOURCE_CONTRACT.original_allowed_sources_are_derivatives is False
    assert dict(PRIVATE_MEDIA_SOURCE_CONTRACT.media_types) == PRIVATE_MEDIA_SOURCE_TYPES
    assert PRIVATE_MEDIA_SOURCE_TYPES[".webm"] == "video/webm"
    assert PRIVATE_MEDIA_SOURCE_TYPES[".mov"] == "video/quicktime"


def test_codec_purges_only_declared_generated_temp_derivatives(tmp_path):
    keep_input = tmp_path / "input" / "original.mp4"
    keep_output = tmp_path / "output" / "original.mp4"
    keep_input.parent.mkdir()
    keep_output.parent.mkdir()
    keep_input.write_bytes(b"input")
    keep_output.write_bytes(b"output")
    for relative in (
        "temp/helto_private/save_image_advanced/private.png.enc",
    ):
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"generated")

    codec = PrivateMediaArtifactCodecAdapter(tmp_path / "temp")
    codec.purge_plaintext_derivatives(PRIVATE_MEDIA_IMAGE_PREVIEW_KIND)

    assert keep_input.read_bytes() == b"input"
    assert keep_output.read_bytes() == b"output"
    assert not any((tmp_path / "temp").rglob("*.png.enc"))


def test_node_safe_preview_writes_return_references_for_browser_lease_exchange():
    handle = ArtifactHandle()
    managed = PrivateMediaManagedArtifacts(handle)

    first = asyncio.run(
        managed.preview_image(b"synthetic-private-image", owner_id="owner")
    )
    second = asyncio.run(
        managed.preview_image(
            b"replacement-image",
            owner_id="owner",
            replacing=first,
        )
    )

    assert first.to_record() == {
        "private": True,
        "artifactKind": PRIVATE_MEDIA_IMAGE_PREVIEW_KIND,
        "artifact": handle.writes[0][3].to_payload(),
    }
    assert set(second.to_record()) == {"private", "artifactKind", "artifact"}
    assert handle.writes[0][0] == PRIVATE_MEDIA_IMAGE_PREVIEW_KIND
    assert handle.retired == [
        (PRIVATE_MEDIA_IMAGE_PREVIEW_KIND, handle.writes[0][3])
    ]
    serialized = str(second.to_record())
    assert "synthetic-private-image" not in serialized
    assert "token" not in serialized.lower()
    assert "filename" not in serialized.lower()
    assert "path" not in serialized.lower()


def test_source_operation_binds_consumer_authorizer_to_direct_shared_stream_lease(
    monkeypatch,
):
    source = object()
    authorization = object()
    calls = []

    async def issue_source_lease(**kwargs):
        calls.append(kwargs)
        return ArtifactLease(f"hp-lease-{'B' * 32}", 60)

    monkeypatch.setattr(
        "helto_privacy.artifact_publication.issue_root_bound_source_lease",
        issue_source_lease,
    )
    adapter = PrivateMediaSourceOperationAdapter(lambda payload: source)
    result = asyncio.run(
        adapter.invoke(
            {"alias": "input", "filename": "clip.webm"},
            authorization,
        )
    )

    assert result == {
        "private": True,
        "lease": {
            "url": f"/helto_privacy/artifacts/hp-lease-{'B' * 32}",
            "expiresInSeconds": 60,
        },
    }
    assert calls[0]["operation_id"] == PRIVATE_MEDIA_SOURCE_OPERATION_ID
    assert calls[0]["authorization"] is authorization
    assert calls[0]["source"] is source


def test_source_authorization_failure_is_sanitized_before_lease_issue(monkeypatch):
    issued = []

    async def issue_source_lease(**kwargs):
        issued.append(kwargs)

    monkeypatch.setattr(
        "helto_privacy.artifact_publication.issue_root_bound_source_lease",
        issue_source_lease,
    )

    def reject(_source):
        raise ValueError("synthetic private path details")

    adapter = PrivateMediaSourceOperationAdapter(reject)
    with pytest.raises(Exception) as raised:
        asyncio.run(adapter.invoke({"alias": "bad", "filename": "bad.mp4"}, object()))
    assert getattr(raised.value, "code", "") == "PRIVACY_ARTIFACT_SOURCE_REJECTED"
    assert "synthetic private path details" not in str(raised.value)
    assert issued == []


def test_consumer_facade_retires_releases_and_sweeps_resource_once():
    handle = ArtifactHandle()
    managed = PrivateMediaManagedArtifacts(handle)
    image = asyncio.run(managed.preview_image(b"image", owner_id="owner"))
    video = asyncio.run(managed.preview_video(b"video", owner_id="owner"))

    assert asyncio.run(managed.retire(image)) == 1
    assert asyncio.run(managed.release_owner("owner")) == 2
    assert handle.released == ["owner"]
    assert asyncio.run(managed.startup_recover()) == "swept"
    assert handle.sweeps == 1
    assert video._publication.is_current is False


def test_protected_operation_passes_serve_authorization_to_source_publisher():
    issued_authorization = object()
    seen = []

    class Authorization:
        async def dispatch(self, request, scope_id, operation_id, invoke):
            assert request == "request"
            assert scope_id == "load-video"
            assert operation_id == PRIVATE_MEDIA_SOURCE_OPERATION_ID
            return await invoke(issued_authorization)

    class Adapter:
        async def invoke(self, payload, authorization):
            seen.append((payload, authorization))
            return {"private": True, "lease": {}}

    operations = PrivateMediaProtectedOperations(Authorization(), Adapter())
    result = asyncio.run(operations.dispatch("request", {"source": "synthetic"}))

    assert result == {"private": True, "lease": {}}
    assert seen == [({"source": "synthetic"}, issued_authorization)]

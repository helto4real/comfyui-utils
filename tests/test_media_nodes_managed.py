from __future__ import annotations

import asyncio

import pytest
from helto_privacy import (
    ArtifactReference,
    EffectivePrivacyMode,
    ExecutionError,
    ModeEvidence,
    ModeFacts,
    resolve_privacy_mode,
)

from shared.private_media_managed import (
    IMAGE_COMPARER_PREVIEW_KIND,
    LOAD_VIDEO_THUMBNAIL_KIND,
    MEDIA_NODE_ARTIFACT_CONTRACTS,
    MEDIA_NODE_MODE_SCOPES,
    SAVE_IMAGE_PREVIEW_KIND,
    SAVE_VIDEO_PREVIEW_KIND,
    SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE,
    SAVE_VIDEO_REPLAY_KIND,
    VIDEO_COMPARER_PREVIEW_KIND,
    MediaNodeManagedArtifacts,
    MediaNodeModeSource,
    PrivateMediaArtifactCodecAdapter,
    build_private_media_profile,
)


class Run:
    def __init__(self, handle, owner_id):
        self.handle = handle
        self.owner_id = owner_id or f"hp-owner-{'R' * 31}{len(handle.runs)}"
        self.closed = 0

    async def write(self, kind, value):
        if self.handle.cancel_run_write:
            raise asyncio.CancelledError()
        return await self.handle._write(kind, self.owner_id, value)

    async def close(self):
        self.closed += 1
        return 1


class Handle:
    def __init__(self):
        self.values = {}
        self.writes = []
        self.retired = []
        self.retired_groups = []
        self.released = []
        self.runs = []
        self.sweeps = 0
        self.cancel_run_write = False
        self.fail_write_at = None

    async def _write(self, kind, owner_id, value):
        if len(self.writes) == self.fail_write_at:
            raise RuntimeError("synthetic product path and payload")
        reference = ArtifactReference(f"hp-art-{'A' * 30}{len(self.writes):02}")
        self.writes.append((kind, owner_id, value, reference))
        self.values[(kind, reference.id)] = value
        return reference

    async def write(self, kind, owner_id, value):
        return await self._write(kind, owner_id, value)

    async def read(self, kind, reference):
        return self.values[(kind, reference.id)]

    async def retire(self, kind, reference):
        self.retired.append((kind, reference))
        self.values.pop((kind, reference.id), None)
        return 1

    async def retire_group(self, artifacts):
        self.retired_groups.append(tuple(artifacts))
        for kind, reference in artifacts:
            self.retired.append((kind, reference))
            self.values.pop((kind, reference.id), None)
        return len(artifacts)

    async def release_owner(self, owner_id):
        self.released.append(owner_id)
        return 1

    async def sweep(self):
        self.sweeps += 1
        return "swept"

    def run(self, owner_id=None):
        run = Run(self, owner_id)
        self.runs.append(run)
        return run


class ModeHandle:
    def __init__(self):
        self.calls = []

    def resolve_declaration(self, scope_id, declaration, facts=None):
        self.calls.append((scope_id, declaration, facts))
        return resolve_privacy_mode(declaration, facts)


def managed(handle, **kwargs):
    return MediaNodeManagedArtifacts(
        handle,
        mode_handle=kwargs.pop("mode_handle", ModeHandle()),
        **kwargs,
    )


def test_profile_declares_each_node_mode_and_complete_derivative_inventory():
    profile = build_private_media_profile()
    declarations = {item.id: item for item in profile.artifacts}

    assert MEDIA_NODE_MODE_SCOPES == {
        "HeltoImageComparer": "image-comparer",
        "HeltoLoadVideo": "load-video",
        "HeltoSaveImageAdvanced": "save-image-advanced",
        "HeltoSaveVideoAdvanced": "save-video-advanced",
        "HeltoVideoComparer": "video-comparer",
    }
    assert set(declarations) == {
        IMAGE_COMPARER_PREVIEW_KIND,
        LOAD_VIDEO_THUMBNAIL_KIND,
        SAVE_IMAGE_PREVIEW_KIND,
        *SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE.values(),
        SAVE_VIDEO_REPLAY_KIND,
        VIDEO_COMPARER_PREVIEW_KIND,
    }
    assert declarations[LOAD_VIDEO_THUMBNAIL_KIND].retention.value == "regenerable-cache"
    assert declarations[SAVE_VIDEO_REPLAY_KIND].retention.value == "run-scoped-spill"
    assert declarations[SAVE_VIDEO_REPLAY_KIND].operations == ()
    assert declarations[IMAGE_COMPARER_PREVIEW_KIND].purpose == "private-preview"
    assert declarations[VIDEO_COMPARER_PREVIEW_KIND].purpose == "private-preview"
    assert {
        declarations[kind].media_type
        for kind in SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE.values()
    } == set(SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE)
    assert {contract.node_class for contract in MEDIA_NODE_ARTIFACT_CONTRACTS} == set(
        MEDIA_NODE_MODE_SCOPES
    )
    assert all(contract.mode_input == "privacy_mode" for contract in MEDIA_NODE_ARTIFACT_CONTRACTS)
    inventory = {
        derivative
        for contract in MEDIA_NODE_ARTIFACT_CONTRACTS
        for derivative in contract.plaintext_derivatives
    }
    assert {
        "temp/helto_cache/HeltoLoadVideo/thumbnails/**",
        "temp/helto_load_video/**",
        "temp/helto_private/image_comparer/**",
        "temp/helto_private/video_comparer/**",
        "temp/helto_save_image_advanced/**",
        "temp/helto_save_video_advanced/**",
        "temp/helto_save_video_private_*/**",
        "temp/helto_cache/HeltoSaveVideoAdvanced/replay/**",
    } <= inventory


def test_node_mode_source_defaults_private_and_only_accepts_explicit_public():
    modes = MediaNodeModeSource()
    for value in (None, True, "private", "inherit", "false", 0, object()):
        assert modes.resolve("HeltoLoadVideo", value) == "private"
    assert modes.resolve("HeltoLoadVideo", False) == "public"
    assert modes.resolve("HeltoLoadVideo", "public") == "public"
    assert modes.read_declared_mode("load-video") == "private"
    with pytest.raises(ValueError):
        modes.resolve("UnknownNode", False)


def test_transition_purge_removes_only_declared_generated_derivatives(tmp_path):
    keep = tmp_path / "unrelated" / "user-output.mp4"
    keep.parent.mkdir()
    keep.write_bytes(b"keep")
    generated = {
        "helto_private/image_comparer/a.png.enc": IMAGE_COMPARER_PREVIEW_KIND,
        "helto_private/save_image_advanced/b.png.enc": SAVE_IMAGE_PREVIEW_KIND,
        "helto_save_image_advanced/public-preview.png": SAVE_IMAGE_PREVIEW_KIND,
        "helto_cache/HeltoLoadVideo/thumbnails/c.webp.enc": LOAD_VIDEO_THUMBNAIL_KIND,
        "helto_load_video/d.mp4": LOAD_VIDEO_THUMBNAIL_KIND,
        "helto_video_comparer/e.mp4": VIDEO_COMPARER_PREVIEW_KIND,
        "helto_save_video_private_synthetic/f.mp4": SAVE_VIDEO_PREVIEW_KIND,
        "helto_private/save_video_advanced/g.mp4.enc": SAVE_VIDEO_PREVIEW_KIND,
        "helto_cache/HeltoSaveVideoAdvanced/replay/h.pt": SAVE_VIDEO_REPLAY_KIND,
        "helto_private/HeltoSaveVideoAdvanced/replay/i.pt.enc": SAVE_VIDEO_REPLAY_KIND,
    }
    for relative in generated:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"generated")

    codec = PrivateMediaArtifactCodecAdapter(tmp_path)
    codec.purge_plaintext_derivatives(IMAGE_COMPARER_PREVIEW_KIND)
    assert not (tmp_path / "helto_private/image_comparer/a.png.enc").exists()
    assert (tmp_path / "helto_private/save_image_advanced/b.png.enc").exists()

    for kind in set(generated.values()) - {IMAGE_COMPARER_PREVIEW_KIND}:
        codec.purge_plaintext_derivatives(kind)
    assert keep.read_bytes() == b"keep"
    assert not any((tmp_path / "helto_private").rglob("*.*"))
    assert not any((tmp_path / "helto_cache").rglob("*.*"))


def test_node_preview_publication_preserves_kind_and_leaks_no_product_metadata():
    handle = Handle()
    service = managed(handle)

    records = asyncio.run(
        service.publish_previews(
            "HeltoImageComparer",
            [b"original", b"comparison"],
            owner_key="synthetic-node/revision",
        )
    )

    assert [write[0] for write in handle.writes] == [
        IMAGE_COMPARER_PREVIEW_KIND,
        IMAGE_COMPARER_PREVIEW_KIND,
    ]
    assert len({write[1] for write in handle.writes}) == 2
    serialized = str([record.to_record() for record in records])
    assert "synthetic-node" not in serialized
    assert "original" not in serialized
    assert "comparison" not in serialized
    assert "path" not in serialized.lower()
    assert "filename" not in serialized.lower()
    assert "token" not in serialized.lower()

    with pytest.raises(Exception):
        asyncio.run(
            service.publish_previews(
                "HeltoImageComparer",
                [b"public"],
                owner_key="public-node",
                privacy_mode=False,
            )
        )
    assert len(handle.writes) == 2


def test_node_mode_uses_shared_handle_and_honors_upstream_privacy_floor():
    handle = Handle()
    mode_handle = ModeHandle()
    service = managed(handle, mode_handle=mode_handle)

    records = asyncio.run(
        service.publish_previews(
            "HeltoImageComparer",
            [b"floor-protected"],
            owner_key="node/floor",
            privacy_mode=False,
            mode_facts=ModeFacts(
                upstream=(
                    ModeEvidence("private-input", EffectivePrivacyMode.PRIVATE),
                )
            ),
        )
    )

    assert len(records) == 1
    assert mode_handle.calls[0][0:2] == ("image-comparer", "public")


def test_save_video_preview_kind_preserves_each_supported_media_type():
    handle = Handle()
    service = managed(handle)

    async def exercise():
        for index, media_type in enumerate(SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE):
            await service.publish_previews(
                "HeltoSaveVideoAdvanced",
                [b"encoded-media"],
                owner_key=f"node/{index}",
                media_type=media_type,
            )

    asyncio.run(exercise())
    assert [write[0] for write in handle.writes] == list(
        SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE.values()
    )


def test_save_video_private_bytes_publish_without_path_metadata():
    encoded = b"synthetic-webp"
    handle = Handle()
    service = managed(handle)
    record = asyncio.run(
        service.publish_save_video_preview(
            lambda: encoded,
            owner_key="node/revision",
            media_type="image/webp",
        )
    )
    assert record.to_record()["artifactKind"] == "save-video-webp-preview"


def test_interrupted_preview_group_retires_every_completed_write():
    handle = Handle()
    handle.fail_write_at = 1
    service = managed(handle)

    with pytest.raises(Exception) as failed:
        asyncio.run(
            service.publish_previews(
                "HeltoImageComparer",
                [b"first", b"second"],
                owner_key="node/revision",
            )
        )

    assert "synthetic product" not in str(failed.value)
    assert handle.retired == [(IMAGE_COMPARER_PREVIEW_KIND, handle.writes[0][3])]


def test_preview_group_replacement_and_release_retire_each_live_item():
    handle = Handle()
    service = managed(handle)

    async def exercise():
        first = await service.publish_previews(
            "HeltoImageComparer",
            [b"first-a", b"first-b"],
            owner_key="node/revision",
        )
        second = await service.publish_previews(
            "HeltoImageComparer",
            [b"second-a", b"second-b"],
            owner_key="node/revision",
        )
        retired = await service.release_previews("node/revision")
        return first, second, retired

    first, second, retired = asyncio.run(exercise())
    assert retired == 2
    assert all(record.is_current is False for record in [*first, *second])
    assert handle.retired == [
        (IMAGE_COMPARER_PREVIEW_KIND, write[3])
        for write in handle.writes
    ]


def test_load_video_thumbnail_uses_consumer_cache_key_and_revision():
    handle = Handle()
    service = managed(handle)
    calls = []

    async def exercise():
        first = await service.load_video_thumbnail(
            "consumer-cache-key",
            (1, 10),
            lambda: calls.append("first") or b"first-webp",
        )
        cached = await service.load_video_thumbnail(
            "consumer-cache-key",
            (1, 10),
            lambda: calls.append("cached") or b"wrong",
        )
        changed = await service.load_video_thumbnail(
            "consumer-cache-key",
            (2, 11),
            lambda: calls.append("changed") or b"changed-webp",
        )
        return first, cached, changed

    first, cached, changed = asyncio.run(exercise())
    assert calls == ["first", "changed"]
    assert first[1] == cached[1] == b"first-webp"
    assert changed[1] == b"changed-webp"
    assert handle.retired == [(LOAD_VIDEO_THUMBNAIL_KIND, handle.writes[0][3])]


def test_encoder_and_replay_adapter_failures_are_product_data_free():
    def leak(*_args):
        raise RuntimeError("synthetic /private/path and payload details")

    thumbnail_service = managed(Handle())
    with pytest.raises(Exception) as thumbnail:
        asyncio.run(
            thumbnail_service.load_video_thumbnail("cache-key", (1, 1), leak)
        )
    assert "synthetic" not in str(thumbnail.value)

    serialize_handle = Handle()
    serialize_service = managed(
        serialize_handle,
        serialize_replay=leak,
    )
    with pytest.raises(Exception) as serialize:
        asyncio.run(serialize_service.store_replay("node", 1, b"payload"))
    assert "synthetic" not in str(serialize.value)
    assert serialize_handle.runs == []

    deserialize_handle = Handle()
    deserialize_service = managed(
        deserialize_handle,
        serialize_replay=lambda value: value,
        deserialize_replay=leak,
    )

    async def consume_invalid():
        await deserialize_service.store_replay("node", 1, b"payload")
        return await deserialize_service.consume_replay("node", 1)

    with pytest.raises(Exception) as deserialize:
        asyncio.run(consume_invalid())
    assert "synthetic" not in str(deserialize.value)
    assert deserialize_handle.runs[0].closed == 1


def test_replay_spill_is_owned_by_node_revision_and_cleanup_is_shared():
    handle = Handle()
    service = managed(
        handle,
        serialize_replay=lambda payload: b"encoded:" + payload,
        deserialize_replay=lambda payload: payload.removeprefix(b"encoded:"),
    )

    async def exercise():
        first = await service.store_replay("node-1", 1, b"first")
        assert await service.load_replay("node-1", 1) == b"first"
        second = await service.store_replay("node-1", 2, b"second")
        assert await service.load_replay("node-1", 1) is None
        assert await service.consume_replay("node-1", 2) == b"second"
        return first, second

    first, second = asyncio.run(exercise())
    assert first.to_record()["artifactKind"] == SAVE_VIDEO_REPLAY_KIND
    assert second.to_record()["artifactKind"] == SAVE_VIDEO_REPLAY_KIND
    assert [run.closed for run in handle.runs] == [1, 1]
    assert first.is_current is False
    assert second.is_current is False


def test_default_replay_adapter_preserves_existing_torch_payload_in_memory():
    handle = Handle()
    service = managed(handle)
    payload = {
        "images": [b"synthetic-frame"],
        "audio": None,
        "filenames": (False, []),
    }

    async def exercise():
        await service.store_replay("node-1", 1, payload)
        return await service.consume_replay("node-1", 1)

    assert asyncio.run(exercise()) == payload
    assert isinstance(handle.writes[0][2], bytes)
    assert b"synthetic-frame" in handle.writes[0][2]


def test_replay_mode_change_discards_captured_run_before_release():
    handle = Handle()
    service = managed(handle)

    async def exercise():
        await service.store_replay(
            "node-1",
            1,
            b"public-run",
            privacy_mode=False,
        )
        return await service.load_replay(
            "node-1",
            1,
        )

    assert asyncio.run(exercise()) is None
    assert handle.runs[0].closed == 1


def test_replay_interruption_closes_run_and_restart_sweeps_without_replay():
    handle = Handle()
    service = managed(handle)
    handle.cancel_run_write = True
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(service.store_replay("node-1", 1, b"private"))
    assert handle.runs[0].closed == 1

    handle.cancel_run_write = False
    asyncio.run(service.store_replay("node-1", 2, b"private"))
    assert asyncio.run(service.startup_recover()) == "swept"
    assert handle.runs[-1].closed == 1
    assert asyncio.run(service.load_replay("node-1", 2)) is None
    assert handle.sweeps == 1


def test_shared_execution_cancellation_checkpoints_bound_media_work():
    class Execution:
        def __init__(self, cancel_at=None):
            self.calls = 0
            self.cancel_at = cancel_at

        def checkpoint(self):
            self.calls += 1
            if self.calls == self.cancel_at:
                raise ExecutionError("PRIVACY_EXECUTION_CANCELLED")

    handle = Handle()
    service = managed(handle)
    completed = Execution()
    asyncio.run(
        service.publish_previews(
            "HeltoImageComparer",
            [b"first", b"second"],
            owner_key="node/revision",
            execution=completed,
        )
    )
    assert completed.calls == 2

    cancelled = Execution(cancel_at=2)
    with pytest.raises(ExecutionError):
        asyncio.run(
            service.publish_previews(
                "HeltoImageComparer",
                [b"replacement"],
                owner_key="cancelled/revision",
                execution=cancelled,
            )
        )
    assert handle.retired[-1] == (
        IMAGE_COMPARER_PREVIEW_KIND,
        handle.writes[-1][3],
    )


def test_replay_release_checkpoints_execution_and_closes_on_cancel():
    class Execution:
        def __init__(self):
            self.calls = 0

        def checkpoint(self):
            self.calls += 1
            if self.calls == 2:
                raise ExecutionError("PRIVACY_EXECUTION_CANCELLED")

    handle = Handle()
    service = managed(handle)
    execution = Execution()

    async def exercise():
        await service.store_replay("node", 1, b"payload")
        await service.consume_replay("node", 1, execution=execution)

    with pytest.raises(ExecutionError):
        asyncio.run(exercise())
    assert execution.calls == 2
    assert handle.runs[0].closed == 1

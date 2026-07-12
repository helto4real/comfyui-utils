"""Active Utils binding for shared media-node artifact lifecycles."""

from __future__ import annotations

import asyncio
import os
import shutil
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

from helto_privacy import (
    AdapterSlot,
    ArtifactDeclaration,
    ArtifactPublicationService,
    ArtifactRetention,
    ExecutionError,
    ModeFacts,
    PrivateByDefaultModeAdapter,
    PrivacyProfile,
    PrivacyScope,
    ProfileResource,
    ProtectedOperation,
    PublishedArtifactReference,
    ResourceKind,
    RootBoundSource,
    RootBoundSourceLeasePublisher,
    RunScopedArtifactPublicationService,
    generate_artifact_owner_id,
    root_bound_source,
    run_blocking_adapter,
)


PRIVATE_MEDIA_PROFILE_ID = "helto.comfyui-utils"
PRIVATE_MEDIA_DISTRIBUTION = "comfyui-utils"
PRIVATE_MEDIA_MODE_RESOURCE_ID = "private-media-mode"
PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID = "private-media-artifacts"
PRIVATE_MEDIA_SOURCE_RESOURCE_ID = "private-media-source"
PRIVATE_MEDIA_MODE_ADAPTER_ID = "private-media-mode-state"
PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID = "private-media-artifact-codec"
PRIVATE_MEDIA_SOURCE_OPERATION_ADAPTER_ID = "private-media-source-operation"
PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID = "private-media-product-operations"

MEDIA_NODE_MODE_SCOPES = {
    "HeltoImageComparer": "image-comparer",
    "HeltoLoadVideo": "load-video",
    "HeltoSaveImageAdvanced": "save-image-advanced",
    "HeltoSaveVideoAdvanced": "save-video-advanced",
    "HeltoVideoComparer": "video-comparer",
}
PRIVATE_MEDIA_SCOPE_ID = MEDIA_NODE_MODE_SCOPES["HeltoLoadVideo"]

IMAGE_COMPARER_PREVIEW_KIND = "image-comparer-preview"
LOAD_VIDEO_THUMBNAIL_KIND = "load-video-thumbnail"
SAVE_IMAGE_PREVIEW_KIND = "save-image-preview"
SAVE_IMAGE_PUBLIC_PREVIEW_SUBFOLDER = "helto_save_image_advanced"
SAVE_VIDEO_GIF_PREVIEW_KIND = "save-video-gif-preview"
SAVE_VIDEO_AVI_PREVIEW_KIND = "save-video-avi-preview"
SAVE_VIDEO_MKV_PREVIEW_KIND = "save-video-mkv-preview"
SAVE_VIDEO_MOV_PREVIEW_KIND = "save-video-mov-preview"
SAVE_VIDEO_MP4_PREVIEW_KIND = "save-video-mp4-preview"
SAVE_VIDEO_WEBM_PREVIEW_KIND = "save-video-webm-preview"
SAVE_VIDEO_WEBP_PREVIEW_KIND = "save-video-webp-preview"
SAVE_VIDEO_PREVIEW_KIND = SAVE_VIDEO_MP4_PREVIEW_KIND
SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE = {
    "image/gif": SAVE_VIDEO_GIF_PREVIEW_KIND,
    "image/webp": SAVE_VIDEO_WEBP_PREVIEW_KIND,
    "video/quicktime": SAVE_VIDEO_MOV_PREVIEW_KIND,
    "video/x-matroska": SAVE_VIDEO_MKV_PREVIEW_KIND,
    "video/x-msvideo": SAVE_VIDEO_AVI_PREVIEW_KIND,
    "video/mp4": SAVE_VIDEO_MP4_PREVIEW_KIND,
    "video/webm": SAVE_VIDEO_WEBM_PREVIEW_KIND,
}
SAVE_VIDEO_REPLAY_KIND = "save-video-replay"
VIDEO_COMPARER_PREVIEW_KIND = "video-comparer-preview"

# Compatibility names for the original U6 publication seam. They now
# identify the concrete save-node declarations instead of generic kinds.
PRIVATE_MEDIA_IMAGE_PREVIEW_KIND = SAVE_IMAGE_PREVIEW_KIND
PRIVATE_MEDIA_VIDEO_PREVIEW_KIND = SAVE_VIDEO_PREVIEW_KIND
PRIVATE_MEDIA_SOURCE_OPERATION_ID = "serve-source-media"
PRIVATE_MEDIA_PRODUCT_OPERATION_IDS = (
    "load-video.folders-load",
    "load-video.folder-save",
    "load-video.folder-delete",
    "load-video.videos-load",
    "load-video.thumbnail",
    "save-image.release",
    "save-video.release",
)

PRIVATE_MEDIA_ALLOWED_SOURCE_ROOTS = (
    "comfy-input",
    "comfy-output",
    "enabled-load-video-folder",
)
PRIVATE_MEDIA_GENERATED_DERIVATIVES = (
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
)
PRIVATE_MEDIA_SOURCE_TYPES = {
    ".avi": "video/x-msvideo",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}


IMAGE_COMPARER_PREVIEW_DECLARATION = ArtifactDeclaration(
    IMAGE_COMPARER_PREVIEW_KIND,
    PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID,
    MEDIA_NODE_MODE_SCOPES["HeltoImageComparer"],
    "private-preview",
    PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID,
    1,
    ArtifactRetention.SERVED_TRANSIENT,
    ("preview",),
    media_type="image/png",
)
LOAD_VIDEO_THUMBNAIL_DECLARATION = ArtifactDeclaration(
    LOAD_VIDEO_THUMBNAIL_KIND,
    PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID,
    MEDIA_NODE_MODE_SCOPES["HeltoLoadVideo"],
    "load-video-cache",
    PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID,
    1,
    ArtifactRetention.REGENERABLE_CACHE,
    ("preview",),
    media_type="image/webp",
)
SAVE_IMAGE_PREVIEW_DECLARATION = ArtifactDeclaration(
    SAVE_IMAGE_PREVIEW_KIND,
    PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID,
    MEDIA_NODE_MODE_SCOPES["HeltoSaveImageAdvanced"],
    "private-preview",
    PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID,
    1,
    ArtifactRetention.SERVED_TRANSIENT,
    ("preview",),
    media_type="image/png",
)
SAVE_VIDEO_PREVIEW_DECLARATIONS = tuple(
    ArtifactDeclaration(
        artifact_kind,
        PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID,
        MEDIA_NODE_MODE_SCOPES["HeltoSaveVideoAdvanced"],
        "private-preview",
        PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID,
        1,
        ArtifactRetention.SERVED_TRANSIENT,
        ("preview",),
        media_type=media_type,
    )
    for media_type, artifact_kind in SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE.items()
)
SAVE_VIDEO_PREVIEW_DECLARATION = next(
    declaration
    for declaration in SAVE_VIDEO_PREVIEW_DECLARATIONS
    if declaration.id == SAVE_VIDEO_PREVIEW_KIND
)
SAVE_VIDEO_REPLAY_DECLARATION = ArtifactDeclaration(
    SAVE_VIDEO_REPLAY_KIND,
    PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID,
    MEDIA_NODE_MODE_SCOPES["HeltoSaveVideoAdvanced"],
    "save-video-replay",
    PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID,
    1,
    ArtifactRetention.RUN_SCOPED_SPILL,
    (),
    media_type="application/octet-stream",
)
VIDEO_COMPARER_PREVIEW_DECLARATION = ArtifactDeclaration(
    VIDEO_COMPARER_PREVIEW_KIND,
    PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID,
    MEDIA_NODE_MODE_SCOPES["HeltoVideoComparer"],
    "private-preview",
    PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID,
    1,
    ArtifactRetention.SERVED_TRANSIENT,
    ("preview",),
    media_type="video/mp4",
)
PRIVATE_MEDIA_IMAGE_PREVIEW_DECLARATION = SAVE_IMAGE_PREVIEW_DECLARATION
PRIVATE_MEDIA_VIDEO_PREVIEW_DECLARATION = SAVE_VIDEO_PREVIEW_DECLARATION
PRIVATE_MEDIA_ARTIFACT_DECLARATIONS = (
    IMAGE_COMPARER_PREVIEW_DECLARATION,
    LOAD_VIDEO_THUMBNAIL_DECLARATION,
    SAVE_IMAGE_PREVIEW_DECLARATION,
    *SAVE_VIDEO_PREVIEW_DECLARATIONS,
    SAVE_VIDEO_REPLAY_DECLARATION,
    VIDEO_COMPARER_PREVIEW_DECLARATION,
)


@dataclass(frozen=True, slots=True)
class PrivateMediaArtifactContract:
    declaration: ArtifactDeclaration
    plaintext_derivatives: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class MediaNodeArtifactContract:
    node_class: str
    scope_id: str
    mode_input: str
    owner_policy: str
    declarations: tuple[ArtifactDeclaration, ...]
    plaintext_derivatives: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class PrivateMediaSourceContract:
    operation_id: str
    allowed_source_roots: tuple[str, ...]
    media_types: tuple[tuple[str, str], ...]
    original_allowed_sources_are_derivatives: bool = False


MEDIA_NODE_ARTIFACT_CONTRACTS = (
    MediaNodeArtifactContract(
        "HeltoImageComparer",
        MEDIA_NODE_MODE_SCOPES["HeltoImageComparer"],
        "privacy_mode",
        "node-revision",
        (IMAGE_COMPARER_PREVIEW_DECLARATION,),
        (
            "temp/helto_private/image_comparer/**",
            "temp/helto.compare.*",
        ),
    ),
    MediaNodeArtifactContract(
        "HeltoLoadVideo",
        MEDIA_NODE_MODE_SCOPES["HeltoLoadVideo"],
        "privacy_mode",
        "source-cache-key-revision",
        (LOAD_VIDEO_THUMBNAIL_DECLARATION,),
        (
            "temp/helto_cache/HeltoLoadVideo/thumbnails/**",
            "temp/helto_load_video/**",
        ),
    ),
    MediaNodeArtifactContract(
        "HeltoSaveImageAdvanced",
        MEDIA_NODE_MODE_SCOPES["HeltoSaveImageAdvanced"],
        "privacy_mode",
        "node-revision",
        (SAVE_IMAGE_PREVIEW_DECLARATION,),
        (
            "temp/helto_private/save_image_advanced/**",
            "temp/helto_save_image_advanced/**",
        ),
    ),
    MediaNodeArtifactContract(
        "HeltoSaveVideoAdvanced",
        MEDIA_NODE_MODE_SCOPES["HeltoSaveVideoAdvanced"],
        "privacy_mode",
        "node-revision",
        (*SAVE_VIDEO_PREVIEW_DECLARATIONS, SAVE_VIDEO_REPLAY_DECLARATION),
        (
            "temp/helto_cache/HeltoSaveVideoAdvanced/replay/**",
            "temp/helto_private/HeltoSaveVideoAdvanced/replay/**",
            "temp/helto_private/save_video_advanced/**",
            "temp/helto_save_video_advanced/**",
            "temp/helto_save_video_private_*/**",
        ),
    ),
    MediaNodeArtifactContract(
        "HeltoVideoComparer",
        MEDIA_NODE_MODE_SCOPES["HeltoVideoComparer"],
        "privacy_mode",
        "node-revision",
        (VIDEO_COMPARER_PREVIEW_DECLARATION,),
        (
            "temp/helto_private/video_comparer/**",
            "temp/helto_video_comparer/**",
        ),
    ),
)
PRIVATE_MEDIA_ARTIFACT_CONTRACTS = tuple(
    PrivateMediaArtifactContract(declaration, contract.plaintext_derivatives)
    for contract in MEDIA_NODE_ARTIFACT_CONTRACTS
    for declaration in contract.declarations
)
PRIVATE_MEDIA_SOURCE_CONTRACT = PrivateMediaSourceContract(
    PRIVATE_MEDIA_SOURCE_OPERATION_ID,
    PRIVATE_MEDIA_ALLOWED_SOURCE_ROOTS,
    tuple(sorted(PRIVATE_MEDIA_SOURCE_TYPES.items())),
)


def build_private_media_profile() -> PrivacyProfile:
    return PrivacyProfile(
        id=PRIVATE_MEDIA_PROFILE_ID,
        distribution=PRIVATE_MEDIA_DISTRIBUTION,
        resources=(
            ProfileResource(
                PRIVATE_MEDIA_MODE_RESOURCE_ID,
                ResourceKind.MODE,
                (PRIVATE_MEDIA_MODE_ADAPTER_ID,),
            ),
            ProfileResource(
                PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID,
                ResourceKind.ARTIFACT,
                (PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID,),
            ),
            ProfileResource(
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
                ResourceKind.WORKFLOW,
                (
                    PRIVATE_MEDIA_SOURCE_OPERATION_ADAPTER_ID,
                    PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID,
                ),
            ),
        ),
        server_adapters=(
            AdapterSlot(
                PRIVATE_MEDIA_MODE_ADAPTER_ID,
                ResourceKind.MODE,
                PRIVATE_MEDIA_MODE_RESOURCE_ID,
            ),
            AdapterSlot(
                PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID,
                ResourceKind.ARTIFACT,
                PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID,
            ),
            AdapterSlot(
                PRIVATE_MEDIA_SOURCE_OPERATION_ADAPTER_ID,
                ResourceKind.WORKFLOW,
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
            ),
            AdapterSlot(
                PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID,
                ResourceKind.WORKFLOW,
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
            ),
        ),
        scopes=tuple(
            PrivacyScope(
                scope_id,
                PRIVATE_MEDIA_MODE_RESOURCE_ID,
                PRIVATE_MEDIA_MODE_ADAPTER_ID,
            )
            for scope_id in MEDIA_NODE_MODE_SCOPES.values()
        ),
        artifacts=PRIVATE_MEDIA_ARTIFACT_DECLARATIONS,
        protected_operations=(
            ProtectedOperation(
                PRIVATE_MEDIA_SOURCE_OPERATION_ID,
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
                PRIVATE_MEDIA_SOURCE_OPERATION_ADAPTER_ID,
                "/helto-utils/private-media/source",
            ),
            ProtectedOperation(
                "load-video.folders-load",
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
                PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID,
                "/helto-utils/load-video/folders/load",
                "POST",
            ),
            ProtectedOperation(
                "load-video.folder-save",
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
                PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID,
                "/helto-utils/load-video/folders/save",
                "POST",
            ),
            ProtectedOperation(
                "load-video.folder-delete",
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
                PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID,
                "/helto-utils/load-video/folders/delete",
                "POST",
            ),
            ProtectedOperation(
                "load-video.videos-load",
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
                PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID,
                "/helto-utils/load-video/videos/load",
                "POST",
            ),
            ProtectedOperation(
                "load-video.thumbnail",
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
                PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID,
                "/helto-utils/load-video/thumbnail",
                "POST",
            ),
            ProtectedOperation(
                "save-image.release",
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
                PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID,
                "/helto-utils/save-image/release",
                "POST",
            ),
            ProtectedOperation(
                "save-video.release",
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
                PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID,
                "/helto-utils/save-video/release",
                "POST",
            ),
        ),
    )


class MediaNodeModeSource(PrivateByDefaultModeAdapter):
    """Map persisted node inputs to fail-closed per-node declarations."""

    def resolve(self, node_class: str, value: object = None) -> str:
        if node_class not in MEDIA_NODE_MODE_SCOPES:
            raise ValueError("Unknown private media node class.")
        return (
            "public"
            if value is False or (isinstance(value, str) and value == "public")
            else "private"
        )


class MediaNodeModeBinding:
    """Resolve node-local declarations through one bound shared mode handle."""

    def __init__(
        self,
        mode_handle: object,
        source: MediaNodeModeSource | None = None,
    ) -> None:
        if not callable(getattr(mode_handle, "resolve_declaration", None)):
            raise TypeError("A node-local shared mode handle is required.")
        self._handle = mode_handle
        self._source = source or MediaNodeModeSource()

    def resolve(
        self,
        node_class: str,
        value: object,
        facts: ModeFacts | None = None,
    ):
        scope_id = MEDIA_NODE_MODE_SCOPES.get(node_class)
        if scope_id is None:
            raise ValueError("Unknown private media node class.")
        declaration = self._source.resolve(node_class, value)
        return self._handle.resolve_declaration(
            scope_id,
            declaration,
            facts,
        )


PrivateMediaModeAdapter = MediaNodeModeSource


class PrivateMediaArtifactCodecAdapter:
    """Byte codec and strict cleanup of generated legacy temp derivatives."""

    def __init__(self, temp_root: str | os.PathLike[str] | None = None) -> None:
        self._temp_root = Path(temp_root) if temp_root is not None else None

    @property
    def temp_root(self) -> Path:
        if self._temp_root is not None:
            return self._temp_root
        import folder_paths

        return Path(folder_paths.get_temp_directory())

    def encode(self, value: object) -> bytes:
        if not isinstance(value, (bytes, bytearray)):
            raise TypeError("Private media artifacts must be bytes.")
        return bytes(value)

    def decode(self, value: bytes) -> bytes:
        if not isinstance(value, (bytes, bytearray)):
            raise TypeError("Private media artifacts must decode to bytes.")
        return bytes(value)

    def purge_plaintext_derivatives(self, artifact_kind: str) -> None:
        root = self.temp_root
        paths: dict[str, tuple[str, ...]] = {
            IMAGE_COMPARER_PREVIEW_KIND: ("helto_private/image_comparer",),
            LOAD_VIDEO_THUMBNAIL_KIND: (
                "helto_cache/HeltoLoadVideo/thumbnails",
                "helto_load_video",
            ),
            SAVE_IMAGE_PREVIEW_KIND: (
                "helto_private/save_image_advanced",
                SAVE_IMAGE_PUBLIC_PREVIEW_SUBFOLDER,
            ),
            **{
                artifact_kind: (
                    "helto_private/save_video_advanced",
                    "helto_save_video_advanced",
                )
                for artifact_kind in SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE.values()
            },
            SAVE_VIDEO_REPLAY_KIND: (
                "helto_cache/HeltoSaveVideoAdvanced/replay",
                "helto_private/HeltoSaveVideoAdvanced/replay",
            ),
            VIDEO_COMPARER_PREVIEW_KIND: (
                "helto_private/video_comparer",
                "helto_video_comparer",
            ),
        }
        if artifact_kind not in paths:
            raise ValueError("Unknown private media artifact kind.")
        for relative in paths[artifact_kind]:
            _remove_generated_path(root / relative)
        if artifact_kind == IMAGE_COMPARER_PREVIEW_KIND:
            for path in root.glob("helto.compare.*"):
                _remove_generated_path(path)
        if artifact_kind in SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE.values():
            for path in root.glob("helto_save_video_private_*"):
                _remove_generated_path(path)

    def prepare_mode_transition(self, *_args) -> None:
        return None

    def commit_mode_transition(self, *_args) -> None:
        return None

    def rollback_mode_transition(self, *_args) -> None:
        return None


def authorize_load_video_source(source: object) -> RootBoundSource:
    if not isinstance(source, Mapping) or set(source) != {"alias", "filename"}:
        raise ValueError("Private media source request is invalid.")
    alias = source["alias"]
    filename = source["filename"]
    if not isinstance(alias, str) or not isinstance(filename, str):
        raise ValueError("Private media source request is invalid.")

    try:
        from ..nodes.load_video.video_config import folder_by_alias, resolve_video_path
    except ImportError as exc:
        if str(exc) != "attempted relative import beyond top-level package":
            raise
        from nodes.load_video.video_config import folder_by_alias, resolve_video_path

    path = resolve_video_path(alias, filename)
    root = Path(folder_by_alias(alias or "input").path).resolve()
    media_type = PRIVATE_MEDIA_SOURCE_TYPES.get(path.suffix.lower())
    if media_type is None:
        raise ValueError("Private media source type is invalid.")
    return root_bound_source(path, (root,), media_type=media_type)


@dataclass(frozen=True, slots=True, repr=False)
class PrivateMediaArtifactRecord:
    _publication: object = field(repr=False)

    @property
    def is_current(self) -> bool:
        return bool(getattr(self._publication, "is_current", False))

    def to_record(self) -> dict[str, object]:
        return {
            "private": True,
            "artifactKind": self._publication.artifact_kind,
            "artifact": self._publication.to_payload(),
        }

    def __repr__(self) -> str:
        return "PrivateMediaArtifactRecord()"


class PrivateMediaManagedArtifacts:
    """Node-safe preview writes over one shared multi-kind publication service."""

    def __init__(self, artifact_handle: object) -> None:
        self._publications = ArtifactPublicationService(artifact_handle)

    async def preview_image(
        self,
        value: bytes,
        *,
        owner_id: str | None = None,
        replacing: PrivateMediaArtifactRecord | None = None,
    ) -> PrivateMediaArtifactRecord:
        return PrivateMediaArtifactRecord(
            await self._publications.write(
                PRIVATE_MEDIA_IMAGE_PREVIEW_KIND,
                value,
                owner_id=owner_id,
                replacing=_artifact_publication(replacing),
            )
        )

    async def preview_video(
        self,
        value: bytes,
        *,
        owner_id: str | None = None,
        replacing: PrivateMediaArtifactRecord | None = None,
    ) -> PrivateMediaArtifactRecord:
        return PrivateMediaArtifactRecord(
            await self._publications.write(
                PRIVATE_MEDIA_VIDEO_PREVIEW_KIND,
                value,
                owner_id=owner_id,
                replacing=_artifact_publication(replacing),
            )
        )

    async def retire(self, record: PrivateMediaArtifactRecord) -> int:
        return await self._publications.retire(_artifact_publication(record))

    async def release_owner(self, owner_id: str) -> int:
        return await self._publications.release_owner(owner_id)

    async def startup_recover(self):
        return await self._publications.startup_recover()


@dataclass(frozen=True, slots=True)
class _ThumbnailEntry:
    owner_id: str
    revision: object
    record: PrivateMediaArtifactRecord


@dataclass(frozen=True, slots=True)
class _ReplayEntry:
    revision: int
    mode: str
    session: object = field(repr=False)
    record: PrivateMediaArtifactRecord = field(repr=False)


class MediaNodeManagedError(RuntimeError):
    """Stable product-data-free media-node lifecycle failure."""

    def __init__(self, code: str = "PRIVACY_MEDIA_NODE_OPERATION_FAILED") -> None:
        self.code = code
        super().__init__("Private media node operation could not complete.")


_PREVIEW_KIND_BY_NODE = {
    "HeltoImageComparer": IMAGE_COMPARER_PREVIEW_KIND,
    "HeltoSaveImageAdvanced": SAVE_IMAGE_PREVIEW_KIND,
    "HeltoVideoComparer": VIDEO_COMPARER_PREVIEW_KIND,
}


class MediaNodeManagedArtifacts:
    """Product orchestration for all Utils media-node derivatives.

    Encoders, source revisions/cache keys, output routing, and replay payload
    serialization remain consumer inputs. The shared handles own ciphertext,
    replacement, run cleanup, restart sweep, and browser leases.
    """

    def __init__(
        self,
        artifact_handle: object,
        *,
        mode_handle: object,
        serialize_replay: Callable[[object], bytes] | None = None,
        deserialize_replay: Callable[[bytes], object] | None = None,
        mode_source: MediaNodeModeSource | None = None,
    ) -> None:
        self._publications = ArtifactPublicationService(artifact_handle)
        self._runs = RunScopedArtifactPublicationService(artifact_handle)
        self._serialize_replay = serialize_replay or serialize_save_video_replay
        self._deserialize_replay = (
            deserialize_replay or deserialize_save_video_replay
        )
        self._mode = MediaNodeModeBinding(mode_handle, mode_source)
        if not callable(self._serialize_replay) or not callable(
            self._deserialize_replay
        ):
            raise TypeError("Replay serialization adapters are required.")
        self._preview_groups: dict[str, list[PrivateMediaArtifactRecord]] = {}
        self._thumbnails: dict[str, _ThumbnailEntry] = {}
        self._replays: dict[str, _ReplayEntry] = {}
        self._preview_lock = asyncio.Lock()
        self._thumbnail_lock = asyncio.Lock()
        self._replay_lock = asyncio.Lock()

    async def publish_previews(
        self,
        node_class: str,
        encoded_values: list[bytes] | tuple[bytes, ...],
        *,
        owner_key: str,
        media_type: str | None = None,
        privacy_mode: object = True,
        mode_facts: ModeFacts | None = None,
        execution: object = None,
    ) -> list[PrivateMediaArtifactRecord]:
        self._require_private_mode(node_class, privacy_mode, mode_facts)
        artifact_kind = (
            SAVE_VIDEO_PREVIEW_KINDS_BY_MEDIA_TYPE.get(media_type or "video/mp4")
            if node_class == "HeltoSaveVideoAdvanced"
            else _PREVIEW_KIND_BY_NODE.get(node_class)
        )
        if artifact_kind is None or not isinstance(owner_key, str) or not owner_key:
            raise ValueError("Private media preview binding is invalid.")
        async with self._preview_lock:
            previous = tuple(
                record._publication
                for record in self._preview_groups.get(owner_key, ())
                if record.is_current
            )
            _execution_checkpoint(execution)
            publications = await self._publications.write_group(
                artifact_kind,
                list(encoded_values),
                replacing=previous,
            )
            try:
                _execution_checkpoint(execution)
            except BaseException:
                await self._publications.retire_group(publications)
                raise
            records = [
                PrivateMediaArtifactRecord(publication)
                for publication in publications
            ]
            self._preview_groups[owner_key] = records
            return records

    async def release_previews(self, owner_key: str) -> int:
        async with self._preview_lock:
            records = self._preview_groups.get(owner_key, ())
            current = tuple(
                record._publication for record in records if record.is_current
            )
            retired = await self._publications.retire_group(current)
            self._preview_groups.pop(owner_key, None)
            return retired

    async def publish_encoded_previews(
        self,
        node_class: str,
        encode: Callable[[], list[bytes] | tuple[bytes, ...]],
        *,
        owner_key: str,
        privacy_mode: object = True,
        mode_facts: ModeFacts | None = None,
        execution: object = None,
    ) -> list[PrivateMediaArtifactRecord]:
        self._require_private_mode(node_class, privacy_mode, mode_facts)
        _execution_checkpoint(execution)
        encoded = await _run_byte_sequence_adapter(encode)
        _execution_checkpoint(execution)
        return await self.publish_previews(
            node_class,
            encoded,
            owner_key=owner_key,
            privacy_mode=privacy_mode,
            mode_facts=mode_facts,
            execution=execution,
        )

    async def publish_save_video_preview(
        self,
        encode: Callable[[], bytes],
        *,
        owner_key: str,
        media_type: str,
        privacy_mode: object = True,
        mode_facts: ModeFacts | None = None,
        execution: object = None,
    ) -> PrivateMediaArtifactRecord:
        self._require_private_mode(
            "HeltoSaveVideoAdvanced",
            privacy_mode,
            mode_facts,
        )
        _execution_checkpoint(execution)
        encoded = await _run_bytes_adapter(encode)
        _execution_checkpoint(execution)
        records = await self.publish_previews(
            "HeltoSaveVideoAdvanced",
            [encoded],
            owner_key=owner_key,
            media_type=media_type,
            privacy_mode=privacy_mode,
            mode_facts=mode_facts,
            execution=execution,
        )
        return records[0]

    async def load_video_thumbnail(
        self,
        cache_key: str,
        source_revision: object,
        encode: Callable[[], bytes],
        *,
        privacy_mode: object = True,
        mode_facts: ModeFacts | None = None,
        execution: object = None,
    ) -> tuple[PrivateMediaArtifactRecord, bytes]:
        self._require_private_mode("HeltoLoadVideo", privacy_mode, mode_facts)
        if not isinstance(cache_key, str) or not cache_key or not callable(encode):
            raise ValueError("Load Video thumbnail binding is invalid.")
        async with self._thumbnail_lock:
            current = self._thumbnails.get(cache_key)
            if current is not None and current.revision == source_revision:
                try:
                    value = await self._publications.read(
                        current.record._publication
                    )
                except Exception:
                    pass
                else:
                    return current.record, _require_bytes(value)

            _execution_checkpoint(execution)
            encoded = await _run_bytes_adapter(encode)
            _execution_checkpoint(execution)
            owner_id = (
                current.owner_id if current is not None else generate_artifact_owner_id()
            )
            try:
                publication = await self._publications.write(
                    LOAD_VIDEO_THUMBNAIL_KIND,
                    encoded,
                    owner_id=owner_id,
                    replacing=(
                        current.record._publication if current is not None else None
                    ),
                )
            except BaseException:
                if current is not None and not current.record.is_current:
                    self._thumbnails.pop(cache_key, None)
                raise
            record = PrivateMediaArtifactRecord(publication)
            self._thumbnails[cache_key] = _ThumbnailEntry(
                owner_id,
                source_revision,
                record,
            )
            return record, encoded

    async def store_replay(
        self,
        node_key: str,
        revision: int,
        payload: object,
        *,
        privacy_mode: object = True,
        mode_facts: ModeFacts | None = None,
        execution: object = None,
    ) -> PrivateMediaArtifactRecord:
        if (
            not isinstance(node_key, str)
            or not node_key
            or not isinstance(revision, int)
            or isinstance(revision, bool)
        ):
            raise ValueError("Save Video replay binding is invalid.")
        captured_mode = self._resolve_mode(
            "HeltoSaveVideoAdvanced",
            privacy_mode,
            mode_facts,
        )
        async with self._replay_lock:
            _execution_checkpoint(execution)
            encoded = await _run_bytes_adapter(self._serialize_replay, payload)
            _execution_checkpoint(execution)
            session = self._runs.open()
            try:
                publication = await session.write(SAVE_VIDEO_REPLAY_KIND, encoded)
                _execution_checkpoint(execution)
            except BaseException:
                await session.close()
                raise
            record = PrivateMediaArtifactRecord(publication)
            previous = self._replays.get(node_key)
            if previous is not None:
                try:
                    await previous.session.close()
                except BaseException:
                    await session.close()
                    raise
            self._replays[node_key] = _ReplayEntry(
                revision,
                captured_mode,
                session,
                record,
            )
            return record

    async def load_replay(
        self,
        node_key: str,
        revision: int,
        *,
        privacy_mode: object = None,
        mode_facts: ModeFacts | None = None,
        execution: object = None,
    ) -> object | None:
        async with self._replay_lock:
            current = await self._replay_for_mode(
                node_key,
                revision,
                privacy_mode,
                mode_facts,
            )
            if current is None:
                return None
            try:
                return await self._read_replay(current, execution)
            except asyncio.CancelledError:
                raise
            except Exception:
                await current.session.close()
                self._replays.pop(node_key, None)
                return None

    async def consume_replay(
        self,
        node_key: str,
        revision: int,
        *,
        privacy_mode: object = None,
        mode_facts: ModeFacts | None = None,
        execution: object = None,
    ) -> object | None:
        async with self._replay_lock:
            current = await self._replay_for_mode(
                node_key,
                revision,
                privacy_mode,
                mode_facts,
            )
            if current is None:
                return None
            try:
                return await self._read_replay(current, execution)
            finally:
                await current.session.close()
                self._replays.pop(node_key, None)

    async def discard_replay(self, node_key: str, revision: int | None = None) -> int:
        async with self._replay_lock:
            current = self._replays.get(node_key)
            if current is None or (
                revision is not None and current.revision != revision
            ):
                return 0
            self._replays.pop(node_key, None)
            return await current.session.close()

    async def _read_replay(
        self,
        current: _ReplayEntry,
        execution: object,
    ) -> object:
        _execution_checkpoint(execution)
        encoded = _require_bytes(
            await current.session.read(current.record._publication)
        )
        _execution_checkpoint(execution)
        try:
            value = await run_blocking_adapter(self._deserialize_replay, encoded)
            _execution_checkpoint(execution)
            return value
        except asyncio.CancelledError:
            raise
        except ExecutionError:
            raise
        except Exception:
            raise MediaNodeManagedError(
                "PRIVACY_MEDIA_NODE_REPLAY_INVALID"
            ) from None

    async def _replay_for_mode(
        self,
        node_key: str,
        revision: int,
        privacy_mode: object,
        mode_facts: ModeFacts | None,
    ) -> _ReplayEntry | None:
        current = self._replays.get(node_key)
        if current is None or current.revision != revision:
            return None
        mode = self._resolve_mode(
            "HeltoSaveVideoAdvanced",
            privacy_mode,
            mode_facts,
        )
        if mode == current.mode:
            return current
        await current.session.close()
        self._replays.pop(node_key, None)
        return None

    def _require_private_mode(
        self,
        node_class: str,
        value: object,
        facts: ModeFacts | None,
    ) -> None:
        if self._resolve_mode(node_class, value, facts) != "private":
            raise MediaNodeManagedError("PRIVACY_MEDIA_NODE_MODE_PUBLIC")

    def _resolve_mode(
        self,
        node_class: str,
        value: object,
        facts: ModeFacts | None,
    ) -> str:
        try:
            resolution = self._mode.resolve(node_class, value, facts)
            mode = getattr(resolution.effective, "value", None)
        except Exception:
            raise MediaNodeManagedError(
                "PRIVACY_MEDIA_NODE_MODE_INVALID"
            ) from None
        if mode not in {"private", "public"}:
            raise MediaNodeManagedError("PRIVACY_MEDIA_NODE_MODE_INVALID")
        return mode

    async def startup_recover(self):
        async with self._replay_lock:
            for current in tuple(self._replays.values()):
                await current.session.close()
            self._replays.clear()
        self._thumbnails.clear()
        self._preview_groups.clear()
        return await self._publications.startup_recover()


class PrivateMediaSourceOperationAdapter:
    def __init__(
        self,
        authorize_source: Callable[[object], RootBoundSource] = authorize_load_video_source,
    ) -> None:
        self._publisher = RootBoundSourceLeasePublisher(
            PRIVATE_MEDIA_PROFILE_ID,
            PRIVATE_MEDIA_SOURCE_OPERATION_ID,
            authorize_source,
        )

    async def invoke(self, payload: object, authorization: object) -> dict[str, object]:
        publication = await self._publisher.publish(payload, authorization)
        return {"private": True, **publication.to_payload()}


class PrivateMediaProtectedOperations:
    def __init__(self, authorization: object, adapter: object) -> None:
        self._authorization = authorization
        self._adapter = adapter

    async def dispatch(self, request: object, payload: object) -> object:
        async def invoke(authorization: object) -> object:
            return await self._adapter.invoke(payload, authorization)

        return await self._authorization.dispatch(
            request,
            PRIVATE_MEDIA_SCOPE_ID,
            PRIVATE_MEDIA_SOURCE_OPERATION_ID,
            invoke,
        )


def _artifact_publication(
    record: PrivateMediaArtifactRecord | None,
) -> PublishedArtifactReference | None:
    if record is None:
        return None
    if not isinstance(record, PrivateMediaArtifactRecord):
        raise TypeError("A private media artifact record is required.")
    return record._publication


def _remove_generated_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def _require_bytes(value: object) -> bytes:
    if not isinstance(value, (bytes, bytearray)):
        raise TypeError("Private media payloads must be bytes.")
    return bytes(value)


async def _run_bytes_adapter(operation: Callable, *args: object) -> bytes:
    try:
        return _require_bytes(await run_blocking_adapter(operation, *args))
    except asyncio.CancelledError:
        raise
    except Exception:
        raise MediaNodeManagedError() from None


async def _run_byte_sequence_adapter(
    operation: Callable,
    *args: object,
) -> list[bytes]:
    try:
        values = await run_blocking_adapter(operation, *args)
        if not isinstance(values, (list, tuple)) or not values:
            raise TypeError
        return [_require_bytes(value) for value in values]
    except asyncio.CancelledError:
        raise
    except Exception:
        raise MediaNodeManagedError() from None


def _execution_checkpoint(execution: object) -> None:
    if execution is None:
        return
    checkpoint = getattr(execution, "checkpoint", None)
    if not callable(checkpoint):
        raise MediaNodeManagedError("PRIVACY_MEDIA_NODE_EXECUTION_INVALID")
    try:
        checkpoint()
    except ExecutionError:
        raise
    except Exception:
        raise MediaNodeManagedError(
            "PRIVACY_MEDIA_NODE_EXECUTION_INVALID"
        ) from None


def serialize_save_video_replay(payload: object) -> bytes:
    """Preserve Save Video's torch replay format without a named temp file."""

    import torch

    buffer = BytesIO()
    torch.save(payload, buffer)
    return buffer.getvalue()


def deserialize_save_video_replay(payload: bytes) -> object:
    """Load the existing replay payload in memory with the restricted loader."""

    import torch

    return torch.load(
        BytesIO(_require_bytes(payload)),
        map_location="cpu",
        weights_only=True,
    )

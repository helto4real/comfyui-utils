"""Inactive Utils binding for shared private-media artifact leases.

The current token route and node producers remain live until the coordinated
suite activates. This module is the complete replacement seam consumed by the
later media-node cutover.
"""

from __future__ import annotations

import os
import shutil
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

from helto_privacy import (
    AdapterSlot,
    ArtifactDeclaration,
    ArtifactPublicationService,
    ArtifactRetention,
    PrivateByDefaultModeAdapter,
    PrivacyProfile,
    PrivacyScope,
    ProfileResource,
    ProtectedOperation,
    PublishedArtifactReference,
    ResourceKind,
    RootBoundSource,
    RootBoundSourceLeasePublisher,
    root_bound_source,
)


PRIVATE_MEDIA_PROFILE_ID = "helto.comfyui-utils"
PRIVATE_MEDIA_DISTRIBUTION = "comfyui-utils"
PRIVATE_MEDIA_SCOPE_ID = "private-media"
PRIVATE_MEDIA_MODE_RESOURCE_ID = "private-media-mode"
PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID = "private-media-artifacts"
PRIVATE_MEDIA_SOURCE_RESOURCE_ID = "private-media-source"
PRIVATE_MEDIA_MODE_ADAPTER_ID = "private-media-mode-state"
PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID = "private-media-artifact-codec"
PRIVATE_MEDIA_SOURCE_OPERATION_ADAPTER_ID = "private-media-source-operation"

PRIVATE_MEDIA_IMAGE_PREVIEW_KIND = "private-image-preview"
PRIVATE_MEDIA_VIDEO_PREVIEW_KIND = "private-video-preview"
PRIVATE_MEDIA_SOURCE_OPERATION_ID = "serve-source-media"

PRIVATE_MEDIA_ALLOWED_SOURCE_ROOTS = (
    "comfy-input",
    "comfy-output",
    "enabled-load-video-folder",
)
PRIVATE_MEDIA_GENERATED_DERIVATIVES = (
    "temp/helto_private/**",
    "temp/helto_video_comparer/**",
    "temp/helto_load_video/**",
    "temp/helto_save_video_advanced/**",
    "temp/helto.compare.*",
)
PRIVATE_MEDIA_SOURCE_TYPES = {
    ".avi": "video/x-msvideo",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}


PRIVATE_MEDIA_IMAGE_PREVIEW_DECLARATION = ArtifactDeclaration(
    PRIVATE_MEDIA_IMAGE_PREVIEW_KIND,
    PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID,
    PRIVATE_MEDIA_SCOPE_ID,
    "private-media",
    PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID,
    1,
    ArtifactRetention.SERVED_TRANSIENT,
    ("preview",),
    media_type="image/png",
)
PRIVATE_MEDIA_VIDEO_PREVIEW_DECLARATION = ArtifactDeclaration(
    PRIVATE_MEDIA_VIDEO_PREVIEW_KIND,
    PRIVATE_MEDIA_ARTIFACT_RESOURCE_ID,
    PRIVATE_MEDIA_SCOPE_ID,
    "private-media",
    PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID,
    1,
    ArtifactRetention.SERVED_TRANSIENT,
    ("preview",),
    media_type="video/mp4",
)
PRIVATE_MEDIA_ARTIFACT_DECLARATIONS = (
    PRIVATE_MEDIA_IMAGE_PREVIEW_DECLARATION,
    PRIVATE_MEDIA_VIDEO_PREVIEW_DECLARATION,
)


@dataclass(frozen=True, slots=True)
class PrivateMediaArtifactContract:
    declaration: ArtifactDeclaration
    plaintext_derivatives: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class PrivateMediaSourceContract:
    operation_id: str
    allowed_source_roots: tuple[str, ...]
    media_types: tuple[tuple[str, str], ...]
    original_allowed_sources_are_derivatives: bool = False


PRIVATE_MEDIA_ARTIFACT_CONTRACTS = tuple(
    PrivateMediaArtifactContract(
        declaration,
        PRIVATE_MEDIA_GENERATED_DERIVATIVES,
    )
    for declaration in PRIVATE_MEDIA_ARTIFACT_DECLARATIONS
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
                (PRIVATE_MEDIA_SOURCE_OPERATION_ADAPTER_ID,),
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
        ),
        scopes=(
            PrivacyScope(
                PRIVATE_MEDIA_SCOPE_ID,
                PRIVATE_MEDIA_MODE_RESOURCE_ID,
                PRIVATE_MEDIA_MODE_ADAPTER_ID,
            ),
        ),
        artifacts=PRIVATE_MEDIA_ARTIFACT_DECLARATIONS,
        protected_operations=(
            ProtectedOperation(
                PRIVATE_MEDIA_SOURCE_OPERATION_ID,
                PRIVATE_MEDIA_SOURCE_RESOURCE_ID,
                PRIVATE_MEDIA_SOURCE_OPERATION_ADAPTER_ID,
                "/helto-utils/private-media/source",
            ),
        ),
    )


PrivateMediaModeAdapter = PrivateByDefaultModeAdapter


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
        if artifact_kind not in {
            PRIVATE_MEDIA_IMAGE_PREVIEW_KIND,
            PRIVATE_MEDIA_VIDEO_PREVIEW_KIND,
        }:
            raise ValueError("Unknown private media artifact kind.")
        for name in (
            "helto_private",
            "helto_video_comparer",
            "helto_load_video",
            "helto_save_video_advanced",
        ):
            _remove_generated_path(self.temp_root / name)
        for path in self.temp_root.glob("helto.compare.*"):
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

    from nodes.load_video.video_config import folder_by_alias, resolve_video_path

    path = resolve_video_path(alias, filename)
    root = Path(folder_by_alias(alias or "input").path).resolve()
    media_type = PRIVATE_MEDIA_SOURCE_TYPES.get(path.suffix.lower())
    if media_type is None:
        raise ValueError("Private media source type is invalid.")
    return root_bound_source(path, (root,), media_type=media_type)


@dataclass(frozen=True, slots=True, repr=False)
class PrivateMediaArtifactRecord:
    _publication: PublishedArtifactReference = field(repr=False)

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

"""Inactive selector integration for the shared managed-artifact lifecycle.

The live selector keeps using its existing mask and thumbnail stores until the
workflow migration can commit durable mask references atomically.  This module
contains the complete replacement seam without registering routes or changing
current call sites.
"""

from __future__ import annotations

import asyncio
import os
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Callable, Iterator, Protocol

from helto_privacy import (
    AdapterSlot,
    ArtifactDeclaration,
    ArtifactError,
    ArtifactReference,
    ArtifactRetention,
    ProfileResource,
    ResourceKind,
    generate_artifact_owner_id,
)

from .mask_storage import MASK_CACHE_DIR
from .services import SelectorPathError, authorize_selector_image_path
from .thumbnail_cache import (
    generate_thumbnail_bytes,
    selector_thumbnail_cache_dir,
    thumbnail_cache_key,
)


SELECTOR_ARTIFACT_RESOURCE_ID = "selector-artifacts"
SELECTOR_ARTIFACT_SCOPE_ID = "selector"
SELECTOR_ARTIFACT_ADAPTER_ID = "selector-artifact-codec"
SELECTOR_MASK_ARTIFACT_KIND = "selector-mask"
SELECTOR_THUMBNAIL_ARTIFACT_KIND = "selector-thumbnail"


SELECTOR_ARTIFACT_RESOURCE = ProfileResource(
    SELECTOR_ARTIFACT_RESOURCE_ID,
    ResourceKind.ARTIFACT,
    (SELECTOR_ARTIFACT_ADAPTER_ID,),
)
SELECTOR_ARTIFACT_ADAPTER_SLOT = AdapterSlot(
    SELECTOR_ARTIFACT_ADAPTER_ID,
    ResourceKind.ARTIFACT,
    SELECTOR_ARTIFACT_RESOURCE_ID,
)
SELECTOR_MASK_ARTIFACT_DECLARATION = ArtifactDeclaration(
    SELECTOR_MASK_ARTIFACT_KIND,
    SELECTOR_ARTIFACT_RESOURCE_ID,
    SELECTOR_ARTIFACT_SCOPE_ID,
    "selector-mask",
    SELECTOR_ARTIFACT_ADAPTER_ID,
    1,
    ArtifactRetention.DURABLE_ADJUNCT,
    ("preview", "use"),
    media_type="image/png",
)
SELECTOR_THUMBNAIL_ARTIFACT_DECLARATION = ArtifactDeclaration(
    SELECTOR_THUMBNAIL_ARTIFACT_KIND,
    SELECTOR_ARTIFACT_RESOURCE_ID,
    SELECTOR_ARTIFACT_SCOPE_ID,
    "selector-thumbnail",
    SELECTOR_ARTIFACT_ADAPTER_ID,
    1,
    ArtifactRetention.REGENERABLE_CACHE,
    ("preview",),
    media_type="image/webp",
)
SELECTOR_ARTIFACT_DECLARATIONS = (
    SELECTOR_MASK_ARTIFACT_DECLARATION,
    SELECTOR_THUMBNAIL_ARTIFACT_DECLARATION,
)


@dataclass(frozen=True, slots=True)
class SelectorArtifactContract:
    """Consumer facts that stay outside the generic privacy profile schema."""

    declaration: ArtifactDeclaration
    owner_policy: str
    plaintext_derivatives: tuple[str, ...]
    requires_allowed_root: bool = True


SELECTOR_ARTIFACT_CONTRACTS = (
    SelectorArtifactContract(
        SELECTOR_MASK_ARTIFACT_DECLARATION,
        "workflow-mask",
        ("legacy-mask-cache-png",),
    ),
    SelectorArtifactContract(
        SELECTOR_THUMBNAIL_ARTIFACT_DECLARATION,
        "source-revision",
        ("legacy-thumbnail-cache-webp",),
    ),
)


class SelectorArtifactTransitionBlocked(RuntimeError):
    """A durable legacy source still needs the workflow migration transaction."""

    def __init__(self) -> None:
        super().__init__("Selector artifact transition is not ready.")


class SelectorManagedArtifactError(RuntimeError):
    """Product-data-free failure raised when managed read-back is inconsistent."""

    def __init__(self) -> None:
        super().__init__("Selector managed artifact operation could not complete.")


class _ArtifactHandle(Protocol):
    async def write(
        self,
        artifact_kind: str,
        owner_id: str,
        value: object,
    ) -> ArtifactReference: ...

    async def read(self, artifact_kind: str, reference: object) -> object: ...

    async def retire(self, artifact_kind: str, reference: object) -> int: ...

    async def sweep(self): ...

    async def lease(
        self,
        artifact_kind: str,
        reference: object,
        operation: str,
        authorization: object,
    ): ...


class SelectorArtifactCodecAdapter:
    """Byte-preserving product codec plus legacy derivative enumeration."""

    def __init__(
        self,
        *,
        mask_cache_dir: str | os.PathLike[str] = MASK_CACHE_DIR,
        thumbnail_cache_dir: str | os.PathLike[str] | None = None,
    ) -> None:
        self.mask_cache_dir = Path(mask_cache_dir)
        self.thumbnail_cache_dir = Path(
            thumbnail_cache_dir
            if thumbnail_cache_dir is not None
            else selector_thumbnail_cache_dir()
        )

    def encode(self, value: object) -> bytes:
        if not isinstance(value, (bytes, bytearray)):
            raise TypeError("Selector artifacts must be encoded bytes.")
        return bytes(value)

    def decode(self, value: bytes) -> bytes:
        if not isinstance(value, (bytes, bytearray)):
            raise TypeError("Selector artifacts must decode to bytes.")
        return bytes(value)

    def purge_plaintext_derivatives(self, artifact_kind: str) -> None:
        if artifact_kind == SELECTOR_MASK_ARTIFACT_KIND:
            # Durable mask bytes must be retired only by the later workflow +
            # adjunct migration transaction after shared write/read-back.
            if any(self.mask_cache_dir.glob("*.png")):
                raise SelectorArtifactTransitionBlocked()
            return
        if artifact_kind == SELECTOR_THUMBNAIL_ARTIFACT_KIND:
            if not self.thumbnail_cache_dir.exists():
                return
            for path in self.thumbnail_cache_dir.glob("*.webp"):
                path.unlink()
            return
        raise ValueError("Unknown selector artifact kind.")

    def prepare_mode_transition(self, *_args) -> None:
        return None

    def commit_mode_transition(self, *_args) -> None:
        return None

    def rollback_mode_transition(self, *_args) -> None:
        return None


@dataclass(frozen=True, slots=True)
class _ThumbnailEntry:
    owner_id: str
    reference: ArtifactReference
    source_revision: tuple[int, int]


class SelectorManagedArtifacts:
    """Selector product orchestration over one bound shared artifact handle."""

    def __init__(
        self,
        handle: _ArtifactHandle,
        *,
        authorized_roots: Callable[[], tuple[str, ...] | list[str]],
        thumbnail_encoder: Callable[[BinaryIO], bytes] = generate_thumbnail_bytes,
    ) -> None:
        if not callable(authorized_roots) or not callable(thumbnail_encoder):
            raise TypeError("Selector managed artifact adapters are required.")
        self.handle = handle
        self._authorized_roots = authorized_roots
        self._thumbnail_encoder = thumbnail_encoder
        self._thumbnails: dict[str, _ThumbnailEntry] = {}
        self._thumbnail_lock = asyncio.Lock()

    @property
    def thumbnail_count(self) -> int:
        return len(self._thumbnails)

    def _authorize(
        self,
        image_path: str,
        *,
        must_exist: bool = True,
        authorized_roots: tuple[str, ...] | None = None,
    ) -> str:
        return authorize_selector_image_path(
            image_path,
            must_exist=must_exist,
            authorized_roots=(
                authorized_roots
                if authorized_roots is not None
                else tuple(self._authorized_roots())
            ),
        )

    async def write_mask(
        self,
        image_path: str,
        png_bytes: bytes,
        owner_id: str,
    ) -> ArtifactReference:
        self._authorize(image_path)
        reference = await self.handle.write(
            SELECTOR_MASK_ARTIFACT_KIND,
            owner_id,
            png_bytes,
        )
        try:
            revealed = await self.handle.read(SELECTOR_MASK_ARTIFACT_KIND, reference)
            if revealed != png_bytes:
                raise SelectorManagedArtifactError()
        except BaseException:
            await self._retire_after_failed_write(
                SELECTOR_MASK_ARTIFACT_KIND,
                reference,
            )
            raise
        return reference

    async def read_mask(self, image_path: str, reference: object) -> bytes:
        self._authorize(image_path)
        value = await self.handle.read(SELECTOR_MASK_ARTIFACT_KIND, reference)
        if not isinstance(value, bytes):
            raise SelectorManagedArtifactError()
        return value

    async def mask_lease(
        self,
        image_path: str,
        reference: object,
        authorization: object,
        *,
        operation: str = "preview",
    ):
        self._authorize(image_path)
        return await self.handle.lease(
            SELECTOR_MASK_ARTIFACT_KIND,
            reference,
            operation,
            authorization,
        )

    async def retire_mask(self, image_path: str, reference: object) -> int:
        self._authorize(image_path, must_exist=False)
        return await self.handle.retire(SELECTOR_MASK_ARTIFACT_KIND, reference)

    async def thumbnail(
        self,
        image_path: str,
        *,
        regenerate: bool = True,
    ) -> tuple[ArtifactReference, bytes]:
        authorized_roots = tuple(self._authorized_roots())
        authorized_path = self._authorize(
            image_path,
            authorized_roots=authorized_roots,
        )
        source_revision = await asyncio.to_thread(
            _source_revision,
            authorized_path,
            authorized_roots,
        )
        source_key = thumbnail_cache_key(authorized_path)
        async with self._thumbnail_lock:
            current = self._thumbnails.get(source_key)
            if current is not None and (
                not regenerate or current.source_revision == source_revision
            ):
                try:
                    value = await self.handle.read(
                        SELECTOR_THUMBNAIL_ARTIFACT_KIND,
                        current.reference,
                    )
                except ArtifactError:
                    if not regenerate:
                        raise
                else:
                    if not isinstance(value, bytes):
                        raise SelectorManagedArtifactError()
                    return current.reference, value

            encoded_revision, encoded = await asyncio.to_thread(
                _encode_thumbnail,
                authorized_path,
                authorized_roots,
                self._thumbnail_encoder,
            )
            owner_id = (
                current.owner_id
                if current is not None
                else generate_artifact_owner_id()
            )
            reference = await self.handle.write(
                SELECTOR_THUMBNAIL_ARTIFACT_KIND,
                owner_id,
                encoded,
            )
            try:
                revealed = await self.handle.read(
                    SELECTOR_THUMBNAIL_ARTIFACT_KIND,
                    reference,
                )
                if revealed != encoded:
                    raise SelectorManagedArtifactError()
                if current is not None:
                    await self.handle.retire(
                        SELECTOR_THUMBNAIL_ARTIFACT_KIND,
                        current.reference,
                    )
            except BaseException:
                await self._retire_after_failed_write(
                    SELECTOR_THUMBNAIL_ARTIFACT_KIND,
                    reference,
                )
                raise
            self._thumbnails[source_key] = _ThumbnailEntry(
                owner_id,
                reference,
                encoded_revision,
            )
            return reference, bytes(revealed)

    async def thumbnail_lease(
        self,
        image_path: str,
        authorization: object,
    ):
        reference, _value = await self.thumbnail(image_path)
        return await self.handle.lease(
            SELECTOR_THUMBNAIL_ARTIFACT_KIND,
            reference,
            "preview",
            authorization,
        )

    async def retire_thumbnail(self, image_path: str) -> int:
        authorized_path = self._authorize(image_path, must_exist=False)
        source_key = thumbnail_cache_key(authorized_path)
        async with self._thumbnail_lock:
            current = self._thumbnails.get(source_key)
            if current is None:
                return 0
            retired = await self.handle.retire(
                SELECTOR_THUMBNAIL_ARTIFACT_KIND,
                current.reference,
            )
            self._thumbnails.pop(source_key, None)
            return retired

    async def clear_thumbnails(self) -> int:
        retired = 0
        async with self._thumbnail_lock:
            for source_key, current in tuple(self._thumbnails.items()):
                retired += await self.handle.retire(
                    SELECTOR_THUMBNAIL_ARTIFACT_KIND,
                    current.reference,
                )
                self._thumbnails.pop(source_key, None)
        return retired

    async def startup_recover(self):
        self._thumbnails.clear()
        return await self.handle.sweep()

    async def _retire_after_failed_write(
        self,
        artifact_kind: str,
        reference: object,
    ) -> None:
        try:
            await self.handle.retire(artifact_kind, reference)
        except Exception:
            # The shared ledger records cleanup-pending work for its startup
            # sweep. Preserve the original operation failure.
            pass


def _source_revision(
    image_path: str,
    authorized_roots: tuple[str, ...],
) -> tuple[int, int]:
    with _open_authorized_image(image_path, authorized_roots) as (_source, revision):
        return revision


def _encode_thumbnail(
    image_path: str,
    authorized_roots: tuple[str, ...],
    encoder: Callable[[BinaryIO], bytes],
) -> tuple[tuple[int, int], bytes]:
    with _open_authorized_image(image_path, authorized_roots) as (source, revision):
        return revision, encoder(source)


@contextmanager
def _open_authorized_image(
    image_path: str,
    authorized_roots: tuple[str, ...],
) -> Iterator[tuple[BinaryIO, tuple[int, int]]]:
    """Open one root-bound source without reopening a validated path."""

    if (
        os.open not in os.supports_dir_fd
        or not hasattr(os, "O_DIRECTORY")
        or not hasattr(os, "O_NOFOLLOW")
    ):
        raise SelectorPathError("Secure selector source access is unavailable", 500)

    resolved_path = os.path.realpath(image_path)
    authorize_selector_image_path(
        resolved_path,
        authorized_roots=authorized_roots,
    )
    root_path, relative_parts = _resolved_root_binding(
        resolved_path,
        authorized_roots,
    )
    directory_flags = (
        os.O_RDONLY
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
    )
    file_flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    directory_fds: list[int] = []
    file_fd: int | None = None
    try:
        current_fd = os.open(root_path, directory_flags)
        directory_fds.append(current_fd)
        for part in relative_parts[:-1]:
            current_fd = os.open(
                part,
                directory_flags,
                dir_fd=current_fd,
            )
            directory_fds.append(current_fd)
        file_fd = os.open(
            relative_parts[-1],
            file_flags,
            dir_fd=current_fd,
        )
        source_stat = os.fstat(file_fd)
        if not stat.S_ISREG(source_stat.st_mode):
            raise OSError("Selector source is not a regular file.")
        with os.fdopen(file_fd, "rb") as source:
            file_fd = None
            yield source, (source_stat.st_mtime_ns, source_stat.st_size)
    except SelectorPathError:
        raise
    except (OSError, ValueError):
        raise SelectorPathError(
            "Image path changed during selector authorization",
            403,
        ) from None
    finally:
        if file_fd is not None:
            os.close(file_fd)
        for directory_fd in reversed(directory_fds):
            os.close(directory_fd)


def _resolved_root_binding(
    resolved_path: str,
    authorized_roots: tuple[str, ...],
) -> tuple[str, tuple[str, ...]]:
    candidates: list[tuple[int, str, tuple[str, ...]]] = []
    for root in authorized_roots:
        root_path = os.path.realpath(os.path.abspath(os.path.expanduser(root)))
        try:
            if os.path.commonpath((resolved_path, root_path)) != root_path:
                continue
        except ValueError:
            continue
        relative_parts = Path(os.path.relpath(resolved_path, root_path)).parts
        if not relative_parts or any(part in {"", ".", ".."} for part in relative_parts):
            continue
        candidates.append((len(root_path), root_path, relative_parts))
    if not candidates:
        raise SelectorPathError(
            "Image path is outside authorized selector folders",
            403,
        )
    _length, root_path, relative_parts = max(candidates, key=lambda item: item[0])
    return root_path, relative_parts

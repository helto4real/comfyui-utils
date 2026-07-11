"""Atomic legacy workflow and durable-mask migration for the selector."""

from __future__ import annotations

import asyncio
import copy
import os
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from helto_privacy import (
    MigrationVerification,
    UTILS_WORKFLOW_READER_IDS,
    generate_artifact_owner_id,
    is_verified_current_disposition,
    protected_envelope_mapping,
    run_blocking_adapter,
    utils_raw_xor_source,
)

from .managed_workflow import (
    SELECTOR_MASKS_FIELD_ID,
    _FIELD_LOCATIONS,
    _normalize_field_value,
    _reference_payload,
    SelectorWorkflowStateAdapter,
    build_selector_privacy_profile,
)


class SelectorAsyncArtifactMigrationGateway:
    """Bridge synchronous migration transactions to the bound async handle."""

    def __init__(self, artifacts: object, loop: asyncio.AbstractEventLoop) -> None:
        if not loop.is_running():
            raise ValueError("Selector migration requires a running event loop.")
        self._artifacts = artifacts
        self._loop = loop
        self._loop_thread_id = threading.get_ident()

    def _run(self, awaitable: object) -> object:
        if threading.get_ident() == self._loop_thread_id:
            close = getattr(awaitable, "close", None)
            if callable(close):
                close()
            raise RuntimeError("Selector migration must run in its worker thread.")
        return asyncio.run_coroutine_threadsafe(awaitable, self._loop).result()

    def write_mask(self, image_path: str, value: bytes, owner_id: str) -> object:
        return self._run(self._artifacts.write_mask(image_path, value, owner_id))

    def read_mask(self, image_path: str, reference: object) -> bytes:
        return self._run(self._artifacts.read_mask(image_path, reference))

    def retire_mask(self, image_path: str, reference: object) -> object:
        return self._run(self._artifacts.retire_mask(image_path, reference))


class SelectorLegacyMaskFiles:
    """Exact-byte source adapter; deletion occurs only after receipt durability."""

    def __init__(self, mask_cache_dir: str | os.PathLike[str]) -> None:
        self._mask_cache_dir = str(mask_cache_dir)

    def capture(self, image_path: str) -> dict[str, object]:
        from .mask_storage import mask_cache_paths

        candidates = tuple(
            (source_name, Path(path))
            for source_name, path in zip(
                ("plain", "encrypted"),
                mask_cache_paths(image_path, self._mask_cache_dir),
                strict=True,
            )
            if Path(path).is_file()
        )
        if len(candidates) != 1:
            raise ValueError("Selector legacy mask source is ambiguous or missing.")
        source_name, source = candidates[0]
        return {"source": source_name, "bytes": source.read_bytes()}

    def retire_if_unchanged(self, image_path: str, expected: object) -> None:
        from .mask_storage import mask_cache_paths

        if not isinstance(expected, Mapping) or expected.get("source") not in {
            "plain",
            "encrypted",
        }:
            raise OSError("Selector legacy mask source changed.")
        index = 0 if expected["source"] == "plain" else 1
        source = Path(mask_cache_paths(image_path, self._mask_cache_dir)[index])
        if not source.exists():
            return
        if source.read_bytes() != _mask_original_bytes(expected):
            raise OSError("Selector legacy mask source changed.")
        source.unlink()


class _WorkflowStore(Protocol):
    def read_fields(self) -> Mapping[str, object]: ...

    def replace_fields(self, fields: Mapping[str, object]) -> None: ...


class _MigrationArtifacts(Protocol):
    def write_mask(self, image_path: str, value: bytes, owner_id: str) -> object: ...

    def read_mask(self, image_path: str, reference: object) -> bytes: ...

    def retire_mask(self, image_path: str, reference: object) -> object: ...


class _LegacyMaskSource(Protocol):
    def capture(self, image_path: str) -> object: ...

    def retire_if_unchanged(self, image_path: str, expected: object) -> None: ...


@dataclass(frozen=True, slots=True)
class SelectorMigrationAuthorizations:
    read: object
    complete: object
    protect: object
    inspect: object


class SelectorMigrationCoordinator:
    """Discover every selector source and complete one grouped transaction."""

    def __init__(
        self,
        migration_handle: object,
        workflow_handle: object,
        workflow_store: _WorkflowStore,
        managed_artifacts: object,
        legacy_masks: _LegacyMaskSource,
        state_adapter: SelectorWorkflowStateAdapter | None = None,
    ) -> None:
        self._migration = migration_handle
        self._workflow = workflow_handle
        self._store = workflow_store
        self._managed_artifacts = managed_artifacts
        self._legacy_masks = legacy_masks
        self._state = state_adapter or SelectorWorkflowStateAdapter()
        self._fields = {
            field.id: field for field in build_selector_privacy_profile().protected_fields
        }

    async def migrate(
        self,
        authorizations: SelectorMigrationAuthorizations,
    ) -> object:
        loop = asyncio.get_running_loop()
        gateway = SelectorAsyncArtifactMigrationGateway(
            self._managed_artifacts,
            loop,
        )
        return await run_blocking_adapter(
            self._migrate_in_worker,
            gateway,
            authorizations,
        )

    def _migrate_in_worker(
        self,
        gateway: SelectorAsyncArtifactMigrationGateway,
        authorizations: SelectorMigrationAuthorizations,
    ) -> object:
        original_fields = dict(self._store.read_fields())
        if set(original_fields) != set(_FIELD_LOCATIONS):
            raise ValueError("Selector workflow source is incomplete.")
        obligation_ids: set[str] = set()
        expected: dict[str, object] = {}
        for field_id, source in original_fields.items():
            discovered = self._discover_field(
                field_id,
                source,
                authorizations.read,
            )
            obligation_ids.add(discovered.obligation.id)
            expected[field_id] = self._state.normalize(
                discovered.value,
                self._fields[field_id],
            )

        mask_map = expected[SELECTOR_MASKS_FIELD_ID]["value"]
        if not isinstance(mask_map, Mapping):
            raise ValueError("Selector edited masks are invalid.")
        normalized_masks: dict[str, bytes] = {}
        mask_originals: dict[str, object] = {}
        for image_path in mask_map:
            original = self._legacy_masks.capture(image_path)
            mask_originals[image_path] = copy.deepcopy(original)
            source_bytes = _mask_original_bytes(original)
            discovered = self._discover_mask(
                source_bytes,
                authorizations.read,
            )
            if not isinstance(discovered.value, bytes):
                raise ValueError("Selector legacy mask is invalid.")
            obligation_ids.add(discovered.obligation.id)
            normalized_masks[image_path] = discovered.value

        transaction = SelectorWorkflowMigrationTransaction(
            self._workflow,
            self._store,
            gateway,
            self._legacy_masks,
            authorizations.protect,
            normalized_masks,
            authorizations.inspect,
            captured_original={
                "fields": original_fields,
                "masks": mask_originals,
            },
        )
        return self._migration.complete_many(
            obligation_ids,
            expected,
            transaction,
            authorizations.complete,
        )

    def _discover_field(
        self,
        field_id: str,
        source: object,
        authorization: object,
    ) -> object:
        for generation in UTILS_WORKFLOW_READER_IDS:
            discovered = self._migration.discover_and_read(
                f"{field_id}-{generation}",
                source,
                authorization,
            )
            if discovered is not None:
                return discovered
        raise ValueError("Selector workflow legacy format is unsupported.")

    def _discover_mask(self, source: bytes, authorization: object) -> object:
        # The raw XOR reader intentionally trusts an explicit location carrier,
        # so authenticated magic generations must get first refusal.
        for generation in ("priv1", "priv2", "priv3", "raw-xor"):
            candidate: object = source
            if generation == "raw-xor":
                candidate = utils_raw_xor_source(source, "selector-mask")
            discovered = self._migration.discover_and_read(
                f"selector-mask-{generation}",
                candidate,
                authorization,
            )
            if discovered is not None:
                return discovered
        raise ValueError("Selector mask legacy format is unsupported.")


class SelectorWorkflowMigrationTransaction:
    """One current-field plus durable-mask transaction for grouped receipts."""

    def __init__(
        self,
        workflow_handle: object,
        workflow_store: _WorkflowStore,
        artifacts: _MigrationArtifacts,
        legacy_masks: _LegacyMaskSource,
        protect_authorization: object,
        normalized_mask_bytes: Mapping[str, bytes],
        inspect_authorization: object | None = None,
        captured_original: Mapping[str, object] | None = None,
    ) -> None:
        self._workflow = workflow_handle
        self._store = workflow_store
        self._artifacts = artifacts
        self._legacy_masks = legacy_masks
        self._protect_authorization = protect_authorization
        self._inspect_authorization = (
            protect_authorization
            if inspect_authorization is None
            else inspect_authorization
        )
        self._mask_bytes = {path: bytes(value) for path, value in normalized_mask_bytes.items()}
        self._expected: dict[str, object] | None = None
        self._protected: dict[str, object] | None = None
        self._references: dict[str, object] = {}
        self._captured_original = (
            copy.deepcopy(dict(captured_original))
            if captured_original is not None
            else None
        )
        self._source_changed = False

    def capture_original(self) -> dict[str, object]:
        if self._captured_original is not None:
            return copy.deepcopy(self._captured_original)
        fields = dict(self._store.read_fields())
        if set(fields) != set(_FIELD_LOCATIONS):
            raise ValueError("Selector workflow source is incomplete.")
        masks = {
            image_path: self._legacy_masks.capture(image_path)
            for image_path in self._mask_bytes
        }
        self._captured_original = {"fields": fields, "masks": masks}
        return copy.deepcopy(self._captured_original)

    def stage_current(self, expected_normalized: object) -> None:
        if not isinstance(expected_normalized, Mapping) or set(expected_normalized) != set(
            _FIELD_LOCATIONS
        ):
            raise ValueError("Selector migration state is incomplete.")
        self._expected = {
            field_id: {"value": _normalize_field_value(field_id, value)}
            for field_id, value in expected_normalized.items()
        }

    def stage_durable_adjuncts(self, _expected_normalized: object) -> None:
        if self._expected is None:
            raise RuntimeError("Selector workflow state was not staged.")
        migrated_masks = copy.deepcopy(self._expected[SELECTOR_MASKS_FIELD_ID]["value"])
        for image_path, png_bytes in self._mask_bytes.items():
            reference = self._artifacts.write_mask(
                image_path,
                png_bytes,
                generate_artifact_owner_id(),
            )
            self._references[image_path] = reference
            migrated_masks[image_path] = _reference_payload(reference)
        current = dict(self._expected)
        current[SELECTOR_MASKS_FIELD_ID] = {"value": migrated_masks}
        self._protected = {}
        for field_id, field_value in current.items():
            protected = self._workflow.protect(
                field_id,
                field_value["value"],
                self._protect_authorization,
            )
            self._protected[field_id] = protected_envelope_mapping(protected)

    def commit(self) -> None:
        if self._protected is None or self._captured_original is None:
            raise RuntimeError("Selector durable state was not staged.")
        if not self._sources_still_match(self._captured_original):
            self._source_changed = True
            raise RuntimeError("Selector migration source changed.")
        self._store.replace_fields(self._protected)

    def read_back(self) -> MigrationVerification:
        stored = dict(self._store.read_fields())
        current_format = self._protected is not None and stored == self._protected
        if current_format:
            current_format = all(
                is_verified_current_disposition(
                    self._workflow.inspect_disposition(
                        field_id,
                        stored[field_id],
                        self._inspect_authorization,
                    )
                )
                for field_id in _FIELD_LOCATIONS
            )
        durable_current = bool(self._references) == bool(self._mask_bytes)
        if durable_current:
            durable_current = all(
                self._artifacts.read_mask(image_path, reference)
                == self._mask_bytes[image_path]
                for image_path, reference in self._references.items()
            )
        return MigrationVerification(
            normalized=copy.deepcopy(self._expected),
            current_format=current_format,
            durable_artifacts_current=durable_current,
        )

    def rollback(self, original: object) -> None:
        if not isinstance(original, Mapping):
            raise ValueError("Selector migration original is invalid.")
        if not self._source_changed:
            self._store.replace_fields(dict(original["fields"]))
        for image_path, reference in tuple(self._references.items()):
            try:
                self._artifacts.retire_mask(image_path, reference)
            except Exception:
                # The shared artifact ledger owns cleanup retry. Workflow and
                # legacy bytes are authoritative again, so rollback succeeded.
                pass
        self._references.clear()

    def _sources_still_match(self, original: Mapping[str, object]) -> bool:
        try:
            if dict(self._store.read_fields()) != dict(original["fields"]):
                return False
            masks = original["masks"]
            return isinstance(masks, Mapping) and all(
                self._legacy_masks.capture(image_path) == mask_original
                for image_path, mask_original in masks.items()
            )
        except Exception:
            return False

    def finalize(self, original: object) -> None:
        if not isinstance(original, Mapping):
            raise ValueError("Selector migration original is invalid.")
        masks = original.get("masks")
        if not isinstance(masks, Mapping):
            raise ValueError("Selector migration original masks are invalid.")
        for image_path, original_bytes in masks.items():
            self._legacy_masks.retire_if_unchanged(image_path, original_bytes)



def _mask_original_bytes(original: object) -> bytes:
    if isinstance(original, bytes):
        return original
    if isinstance(original, Mapping) and isinstance(original.get("bytes"), bytes):
        return original["bytes"]
    raise ValueError("Selector legacy mask original is invalid.")

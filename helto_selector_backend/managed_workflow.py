"""Active shared-workflow integration for the image selector."""

from __future__ import annotations

import copy
import inspect
import json
import mimetypes
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from helto_privacy import (
    AdapterSlot,
    FieldLocation,
    FieldLocationKind,
    LegacyKeyFormat,
    LegacyKeyImportBinding,
    LegacyLocationKind,
    LegacyReaderBinding,
    PrivacyProfile,
    PrivacyScope,
    PrivateByDefaultModeAdapter,
    ProfileResource,
    ProtectedField,
    ProtectedOperation,
    ResourceKind,
    RootBoundSourceLeasePublisher,
    SemanticExecutionProjection,
    UTILS_KEY_BIN_IMPORT_ID,
    UTILS_PRIV1_READER_ID,
    UTILS_PRIV2_READER_ID,
    UTILS_PRIV3_READER_ID,
    UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
    UTILS_RAW_XOR_READER_ID,
    UTILS_WORKFLOW_READER_IDS,
    generate_artifact_owner_id,
    root_bound_source,
)

from .managed_artifacts import (
    SELECTOR_ARTIFACT_ADAPTER_SLOT,
    SELECTOR_ARTIFACT_DECLARATIONS,
    SELECTOR_ARTIFACT_RESOURCE,
)


SELECTOR_PROFILE_ID = "helto.comfyui-utils"
SELECTOR_DISTRIBUTION = "comfyui-utils"
SELECTOR_NODE_TYPE = "HeltoImageSelector"
SELECTOR_SCOPE_ID = "selector"
SELECTOR_SCHEMA = "helto.comfyui-utils"

SELECTOR_MODE_RESOURCE_ID = "selector-mode"
SELECTOR_WORKFLOW_RESOURCE_ID = "selector-workflow"
SELECTOR_EXECUTION_RESOURCE_ID = "selector-execution"
SELECTOR_MODE_ADAPTER_ID = "selector-mode-state"
SELECTOR_MODE_BROWSER_ADAPTER_ID = "selector-mode-browser"
SELECTOR_STATE_ADAPTER_ID = "selector-workflow-state"
SELECTOR_BROWSER_ADAPTER_ID = "selector-workflow-browser"
SELECTOR_OPERATION_ADAPTER_ID = "selector-product-operations"
SELECTOR_PROJECTION_ADAPTER_ID = "selector-execution-projection"
SELECTOR_DISPATCH_ADAPTER_ID = "selector-execution-dispatch"

SELECTOR_SELECTED_FIELD_ID = "selector-selected-images"
SELECTOR_MASKS_FIELD_ID = "selector-edited-masks"
SELECTOR_BBOXES_FIELD_ID = "selector-edited-bboxes"
SELECTOR_EXECUTION_PROJECTION_ID = "selector-select-images"

_FIELD_LOCATIONS = {
    SELECTOR_SELECTED_FIELD_ID: "selected_images",
    SELECTOR_MASKS_FIELD_ID: "edited_masks",
    SELECTOR_BBOXES_FIELD_ID: "edited_bboxes",
}
_RUNTIME_FIELDS = {
    SELECTOR_SELECTED_FIELD_ID: "selectedPaths",
    SELECTOR_MASKS_FIELD_ID: "editedMasks",
    SELECTOR_BBOXES_FIELD_ID: "editedBboxes",
}
_FIELD_DEFAULTS = {
    SELECTOR_SELECTED_FIELD_ID: [],
    SELECTOR_MASKS_FIELD_ID: {},
    SELECTOR_BBOXES_FIELD_ID: {},
}

_OPERATION_ROUTES = {
    "selector.input-dir": ("/helto_selector/input_dir", "GET"),
    "selector.scan": ("/helto_selector/scan_folders", "POST"),
    "selector.thumbnail": ("/helto_selector/thumbnail", "POST"),
    "selector.source-view": ("/helto_selector/view_image", "POST"),
    "selector.mask-read": ("/helto_selector/mask", "POST"),
    "selector.image-delete": ("/helto_selector/delete_images", "POST"),
    "selector.image-paste": ("/helto_selector/paste_image", "POST"),
    "selector.mask-write": ("/helto_selector/save_mask", "POST"),
    "selector.mask-delete": ("/helto_selector/delete_mask", "POST"),
    "selector.mask-migrate": ("/helto_selector/migrate_masks", "POST"),
    "selector.cache-clear": ("/helto_selector/clear_cache", "POST"),
    "selector.roots-register": ("/helto_selector/register_roots", "POST"),
    "selector.roots-list": ("/helto_selector/registered_roots", "GET"),
}
SELECTOR_OPERATION_IDS = tuple(_OPERATION_ROUTES)


def build_selector_privacy_profile() -> PrivacyProfile:
    """Build the deterministic selector slice for the active Utils profile."""

    workflow_reader_ids = tuple(UTILS_WORKFLOW_READER_IDS.values())
    fields = tuple(
        ProtectedField(
            field_id,
            SELECTOR_WORKFLOW_RESOURCE_ID,
            SELECTOR_SCOPE_ID,
            SELECTOR_STATE_ADAPTER_ID,
            SELECTOR_BROWSER_ADAPTER_ID,
            (SELECTOR_NODE_TYPE,),
            FieldLocation(FieldLocationKind.WIDGET, location),
            SELECTOR_SCHEMA,
            field_id,
            legacy_reader_ids=workflow_reader_ids,
            execution=True,
        )
        for field_id, location in _FIELD_LOCATIONS.items()
    )
    legacy_bindings = [
        LegacyReaderBinding(
            f"{field_id}-{generation}",
            reader_id,
            SELECTOR_WORKFLOW_RESOURCE_ID,
            LegacyLocationKind.WORKFLOW_FIELD,
            field_id,
        )
        for field_id in _FIELD_LOCATIONS
        for generation, reader_id in UTILS_WORKFLOW_READER_IDS.items()
    ]
    legacy_bindings.extend(
        LegacyReaderBinding(
            f"selector-mask-{generation}",
            reader_id,
            SELECTOR_ARTIFACT_RESOURCE.id,
            LegacyLocationKind.ARTIFACT,
            "selector-mask",
        )
        for generation, reader_id in (
            ("raw-xor", UTILS_RAW_XOR_READER_ID),
            ("priv1", UTILS_PRIV1_READER_ID),
            ("priv2", UTILS_PRIV2_READER_ID),
            ("priv3", UTILS_PRIV3_READER_ID),
        )
    )
    return PrivacyProfile(
        id=SELECTOR_PROFILE_ID,
        distribution=SELECTOR_DISTRIBUTION,
        resources=(
            ProfileResource(
                SELECTOR_MODE_RESOURCE_ID,
                ResourceKind.MODE,
                (SELECTOR_MODE_ADAPTER_ID, SELECTOR_MODE_BROWSER_ADAPTER_ID),
            ),
            ProfileResource(
                SELECTOR_WORKFLOW_RESOURCE_ID,
                ResourceKind.WORKFLOW,
                (
                    SELECTOR_STATE_ADAPTER_ID,
                    SELECTOR_BROWSER_ADAPTER_ID,
                    SELECTOR_OPERATION_ADAPTER_ID,
                ),
            ),
            ProfileResource(
                SELECTOR_EXECUTION_RESOURCE_ID,
                ResourceKind.EXECUTION,
                (SELECTOR_PROJECTION_ADAPTER_ID, SELECTOR_DISPATCH_ADAPTER_ID),
            ),
            SELECTOR_ARTIFACT_RESOURCE,
        ),
        server_adapters=(
            AdapterSlot(
                SELECTOR_MODE_ADAPTER_ID,
                ResourceKind.MODE,
                SELECTOR_MODE_RESOURCE_ID,
            ),
            AdapterSlot(
                SELECTOR_STATE_ADAPTER_ID,
                ResourceKind.WORKFLOW,
                SELECTOR_WORKFLOW_RESOURCE_ID,
            ),
            AdapterSlot(
                SELECTOR_OPERATION_ADAPTER_ID,
                ResourceKind.WORKFLOW,
                SELECTOR_WORKFLOW_RESOURCE_ID,
            ),
            AdapterSlot(
                SELECTOR_PROJECTION_ADAPTER_ID,
                ResourceKind.EXECUTION,
                SELECTOR_EXECUTION_RESOURCE_ID,
            ),
            AdapterSlot(
                SELECTOR_DISPATCH_ADAPTER_ID,
                ResourceKind.EXECUTION,
                SELECTOR_EXECUTION_RESOURCE_ID,
            ),
            SELECTOR_ARTIFACT_ADAPTER_SLOT,
        ),
        browser_adapters=(
            AdapterSlot(
                SELECTOR_MODE_BROWSER_ADAPTER_ID,
                ResourceKind.MODE,
                SELECTOR_MODE_RESOURCE_ID,
                (SELECTOR_NODE_TYPE,),
            ),
            AdapterSlot(
                SELECTOR_BROWSER_ADAPTER_ID,
                ResourceKind.WORKFLOW,
                SELECTOR_WORKFLOW_RESOURCE_ID,
                (SELECTOR_NODE_TYPE,),
            ),
        ),
        scopes=(
            PrivacyScope(
                SELECTOR_SCOPE_ID,
                SELECTOR_MODE_RESOURCE_ID,
                SELECTOR_MODE_ADAPTER_ID,
                SELECTOR_MODE_BROWSER_ADAPTER_ID,
            ),
        ),
        protected_fields=fields,
        artifacts=SELECTOR_ARTIFACT_DECLARATIONS,
        protected_operations=tuple(
            ProtectedOperation(
                operation_id,
                SELECTOR_WORKFLOW_RESOURCE_ID,
                SELECTOR_OPERATION_ADAPTER_ID,
                route,
                method,
            )
            for operation_id, (route, method) in _OPERATION_ROUTES.items()
        ),
        execution_projections=(
            SemanticExecutionProjection(
                SELECTOR_EXECUTION_PROJECTION_ID,
                SELECTOR_EXECUTION_RESOURCE_ID,
                SELECTOR_WORKFLOW_RESOURCE_ID,
                SELECTOR_PROJECTION_ADAPTER_ID,
                SELECTOR_DISPATCH_ADAPTER_ID,
            ),
        ),
        legacy_bindings=tuple(legacy_bindings),
        legacy_key_imports=(
            LegacyKeyImportBinding(
                "selector-key-bin",
                UTILS_KEY_BIN_IMPORT_ID,
                SELECTOR_WORKFLOW_RESOURCE_ID,
                LegacyLocationKind.WORKFLOW_FIELD,
                SELECTOR_SELECTED_FIELD_ID,
                LegacyKeyFormat.BINARY,
            ),
            LegacyKeyImportBinding(
                "selector-privacy-key-bin",
                UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
                SELECTOR_WORKFLOW_RESOURCE_ID,
                LegacyLocationKind.WORKFLOW_FIELD,
                SELECTOR_SELECTED_FIELD_ID,
                LegacyKeyFormat.BINARY,
            ),
        ),
    )


SelectorModeAdapter = PrivateByDefaultModeAdapter


class SelectorWorkflowStateAdapter:
    """Consumer-owned selector node location and canonical normalization."""

    def capture(self, source: object, declaration: object) -> object:
        field_id = _declaration_id(declaration)
        return copy.deepcopy(getattr(source, _RUNTIME_FIELDS[field_id]))

    def normalize(self, value: object, declaration: object) -> dict[str, object]:
        field_id = _declaration_id(declaration)
        return {"value": _normalize_field_value(field_id, value)}

    def apply_revealed(
        self,
        target: object,
        value: object,
        declaration: object,
    ) -> None:
        field_id = _declaration_id(declaration)
        normalized = _normalize_field_value(field_id, value)
        setattr(target, _RUNTIME_FIELDS[field_id], copy.deepcopy(normalized))

    def clear_plaintext(self, target: object, declaration: object) -> None:
        field_id = _declaration_id(declaration)
        setattr(target, _RUNTIME_FIELDS[field_id], copy.deepcopy(_FIELD_DEFAULTS[field_id]))

    def prepare_mode_transition(self, *_args) -> None:
        return None

    def commit_mode_transition(self, *_args) -> None:
        return None

    def rollback_mode_transition(self, *_args) -> None:
        return None


class SelectorExecutionProjectionAdapter:
    def project(self, fields: Mapping[str, object], _declaration: object) -> dict[str, object]:
        if set(fields) != set(_FIELD_LOCATIONS):
            raise ValueError("Selector execution state is incomplete.")
        return {
            location: _normalize_field_value(field_id, fields[field_id])
            for field_id, location in _FIELD_LOCATIONS.items()
        }


class SelectorExecutionDispatchAdapter:
    """Keeps image selection semantics in the consumer product dispatcher."""

    def __init__(self, dispatcher: Callable[[object, object, object], object]) -> None:
        if not callable(dispatcher):
            raise TypeError("A selector execution dispatcher is required.")
        self._dispatcher = dispatcher

    def dispatch(self, value: object, context: object, cancellation: object) -> object:
        return self._dispatcher(value, context, cancellation)


@dataclass(frozen=True, slots=True)
class SelectorOperationContext:
    authorization: object
    workflow: object
    artifacts: object
    migration_authorizations: object | None = None
    migration: object | None = None


class SelectorProtectedOperations:
    """Bound dispatch seam used by the active typed route handlers."""

    def __init__(
        self,
        authorization: object,
        workflow: object,
        artifacts: object,
        adapter: object,
        migration: object | None = None,
    ) -> None:
        self._authorization = authorization
        self._workflow = workflow
        self._artifacts = artifacts
        self._adapter = adapter
        self._migration = migration

    async def dispatch(
        self,
        request: object,
        operation_id: str,
        payload: object,
    ) -> object:
        if operation_id not in _OPERATION_ROUTES:
            raise ValueError("Unknown selector operation.")

        async def invoke(authorization: object) -> object:
            migration_authorizations = None
            if operation_id == "selector.mask-migrate":
                from .managed_migration import SelectorMigrationAuthorizations

                migration_authorizations = SelectorMigrationAuthorizations(
                    read=self._authorization.authorize_request(
                        request,
                        "migration.read",
                    ),
                    complete=self._authorization.authorize_request(
                        request,
                        "migration.complete",
                    ),
                    protect=self._authorization.authorize_request(
                        request,
                        "snapshot.protect",
                    ),
                    inspect=self._authorization.authorize_request(
                        request,
                        "snapshot.disposition",
                    ),
                )
            result = self._adapter.invoke(
                operation_id,
                payload,
                SelectorOperationContext(
                    authorization,
                    self._workflow,
                    self._artifacts,
                    migration_authorizations,
                    self._migration,
                ),
            )
            return await result if inspect.isawaitable(result) else result

        return await self._authorization.dispatch(
            request,
            SELECTOR_SCOPE_ID,
            operation_id,
            invoke,
        )


class SelectorProductOperationAdapter:
    """Real selector domain routing behind the bound authorization seam."""

    def __init__(
        self,
        *,
        authorized_roots: Callable[[], list[str] | tuple[str, ...]],
        input_directory: Callable[[], str],
        migration_coordinator: object | None = None,
    ) -> None:
        if not callable(authorized_roots) or not callable(input_directory):
            raise TypeError("Selector root and input adapters are required.")
        self._authorized_roots = authorized_roots
        self._input_directory = input_directory
        self._migration_coordinator = migration_coordinator
        self._source_publisher = RootBoundSourceLeasePublisher(
            SELECTOR_PROFILE_ID,
            "selector.source-view",
            self._authorize_source,
        )

    def _authorize_source(self, payload: object):
        from . import services

        data = dict(payload) if isinstance(payload, Mapping) else {}
        roots = tuple(self._authorized_roots())
        path = services.authorize_selector_image_path(
            str(data.get("path") or ""),
            authorized_roots=roots,
        )
        media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        return root_bound_source(path, roots, media_type=media_type)

    async def invoke(
        self,
        operation_id: str,
        payload: object,
        context: SelectorOperationContext,
    ) -> object:
        from . import mask_storage, services

        data = dict(payload) if isinstance(payload, Mapping) else {}
        roots = tuple(self._authorized_roots())
        artifacts = context.artifacts

        if operation_id == "selector.input-dir":
            return services.get_input_dir_payload(self._input_directory)
        if operation_id == "selector.roots-list":
            return services.registered_selector_roots_payload()
        if operation_id == "selector.roots-register":
            if data.get("action") == "revoke":
                return services.unregister_selector_root(str(data.get("folder") or ""))
            return services.register_selector_roots(_string_list(data.get("folders")))
        if operation_id == "selector.source-view":
            publication = await self._source_publisher.publish(
                data,
                context.authorization,
            )
            return {"private": True, **publication.to_payload()}
        if operation_id == "selector.scan":
            result = services.scan_folders_payload(
                services.ScanFoldersPayload.from_request_data(data),
                delete_cache_func=lambda _paths: 0,
                authorized_roots=roots,
            )
            retired = 0
            for image_path in result["removed_paths"]:
                retired += await artifacts.retire_thumbnail(image_path)
            result["removed_cache_count"] = retired
            return result
        if operation_id == "selector.thumbnail":
            reference, _value = await artifacts.thumbnail(str(data.get("path") or ""))
            return {
                "private": True,
                "artifactKind": "selector-thumbnail",
                "artifact": _reference_payload(reference),
            }
        if operation_id == "selector.mask-read":
            image_path = str(data.get("path") or "")
            reference = data.get("reference")
            if reference is None:
                authorized = services.authorize_selector_image_path(
                    image_path,
                    authorized_roots=roots,
                )
                import base64

                encoded = base64.b64encode(
                    services.default_mask_png_payload(authorized)
                ).decode("ascii")
                return {"publicDataUrl": f"data:image/png;base64,{encoded}"}
            return {
                "private": True,
                "artifactKind": "selector-mask",
                "artifact": reference,
            }
        if operation_id == "selector.mask-write":
            image_path = str(data.get("path") or "")
            mask_data = str(data.get("mask_data") or "")
            if not mask_data:
                raise ValueError("Mask data is required.")
            png_bytes = mask_storage._normalize_mask_png(  # noqa: SLF001 - same product codec
                mask_storage._decode_data_url(mask_data)  # noqa: SLF001
            )
            reference = await artifacts.write_mask(
                image_path,
                png_bytes,
                generate_artifact_owner_id(),
            )
            return {
                "status": "success",
                "path": image_path,
                "ref": _reference_payload(reference),
            }
        if operation_id == "selector.mask-delete":
            reference = data.get("reference")
            if reference is None:
                raise ValueError("Managed mask reference is required.")
            retired = await artifacts.retire_mask(
                str(data.get("path") or ""),
                reference,
            )
            return {"status": "success", "retired_count": retired}
        if operation_id == "selector.mask-migrate":
            if self._migration_coordinator is not None:
                receipt = await self._migration_coordinator.migrate(
                    context.migration_authorizations
                )
                to_payload = getattr(receipt, "to_payload", None)
                return to_payload() if callable(to_payload) else receipt
            return await _migrate_legacy_mask_references(data, context)
        if operation_id == "selector.image-delete":
            result = services.delete_images_payload(
                services.DeleteImagesPayload.from_request_data(data),
                delete_cache_func=lambda _paths: 0,
                authorized_roots=roots,
            )
            retired = 0
            for image_path in (*result["deleted"], *result["missing"]):
                retired += await artifacts.retire_thumbnail(image_path)
            result["removed_cache_count"] = retired
            return result
        if operation_id == "selector.image-paste":
            return services.paste_image_payload(
                services.PasteImagePayload(
                    destination=str(data.get("destination") or ""),
                    folders=_string_list(data.get("folders")),
                    filename=str(data.get("filename") or ""),
                    content=bytes(data.get("content") or b""),
                    content_type=str(data.get("content_type") or ""),
                ),
                authorized_roots=roots,
            )
        if operation_id == "selector.cache-clear":
            return {
                "status": "success",
                "retired_count": await artifacts.clear_thumbnails(),
            }
        raise ValueError("Unknown selector operation.")



def _declaration_id(declaration: object) -> str:
    field_id = (
        declaration.get("id")
        if isinstance(declaration, Mapping)
        else getattr(declaration, "id", None)
    )
    if field_id not in _FIELD_LOCATIONS:
        raise ValueError("Unknown selector field.")
    return str(field_id)


def _parse_json_value(value: object) -> object:
    if isinstance(value, Mapping) and set(value) == {"value"}:
        return value["value"]
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            raise ValueError("Selector privacy state is invalid.") from None
    return value


def _normalize_field_value(field_id: str, value: object) -> object:
    value = _parse_json_value(value)
    if field_id == SELECTOR_SELECTED_FIELD_ID:
        if not isinstance(value, list):
            raise ValueError("Selector selected images are invalid.")
        return list(dict.fromkeys(item for item in value if isinstance(item, str) and item))
    if field_id == SELECTOR_MASKS_FIELD_ID:
        if not isinstance(value, Mapping):
            raise ValueError("Selector edited masks are invalid.")
        return {
            path: copy.deepcopy(reference)
            for path, reference in value.items()
            if isinstance(path, str) and path and reference
        }
    if field_id == SELECTOR_BBOXES_FIELD_ID:
        if not isinstance(value, Mapping):
            raise ValueError("Selector bounding boxes are invalid.")
        normalized: dict[str, list[dict[str, float]]] = {}
        for path, boxes in value.items():
            if not isinstance(path, str) or not path or not isinstance(boxes, list):
                continue
            valid = []
            for box in boxes:
                if not isinstance(box, Mapping):
                    continue
                try:
                    candidate = {
                        key: float(box[key])
                        for key in ("x", "y", "width", "height")
                    }
                except (KeyError, TypeError, ValueError):
                    continue
                if candidate["width"] > 0 and candidate["height"] > 0:
                    valid.append(candidate)
            if valid:
                normalized[path] = valid
        return normalized
    raise ValueError("Unknown selector field.")


def _reference_payload(reference: object) -> object:
    to_payload = getattr(reference, "to_payload", None)
    if callable(to_payload):
        return to_payload()
    if isinstance(reference, Mapping):
        return dict(reference)
    raise TypeError("Selector artifact reference is invalid.")


async def _migrate_legacy_mask_references(
    data: Mapping[str, object],
    context: SelectorOperationContext,
) -> dict[str, object]:
    from pathlib import Path

    from .mask_storage import mask_cache_paths

    masks = data.get("masks")
    if not isinstance(masks, Mapping):
        raise ValueError("Selector legacy masks are invalid.")
    updated = dict(masks)
    migrated = 0
    for image_path, reference in masks.items():
        if (
            not isinstance(image_path, str)
            or not isinstance(reference, Mapping)
            or set(reference) != {"key"}
        ):
            continue
        plain_path, encrypted_path = map(Path, mask_cache_paths(image_path))
        if plain_path.is_file():
            mask_bytes = plain_path.read_bytes()
        elif encrypted_path.is_file():
            if context.migration is None or context.migration_authorizations is None:
                raise RuntimeError("Selector legacy migration is unavailable.")
            source = encrypted_path.read_bytes()
            mask_bytes = None
            for generation in ("priv3", "priv2", "priv1", "raw-xor"):
                candidate: object = source
                if generation == "raw-xor":
                    from helto_privacy import utils_raw_xor_source

                    candidate = utils_raw_xor_source(source, "selector-mask")
                discovered = context.migration.discover_and_read(
                    f"selector-mask-{generation}",
                    candidate,
                    context.migration_authorizations.read,
                )
                if discovered is not None:
                    mask_bytes = discovered.value
                    break
            if not isinstance(mask_bytes, bytes):
                raise ValueError("Selector legacy mask is unsupported.")
        else:
            raise ValueError("Selector legacy mask source is missing.")
        current = await context.artifacts.write_mask(
            image_path,
            mask_bytes,
            generate_artifact_owner_id(),
        )
        updated[image_path] = _reference_payload(current)
        migrated += 1
    return {"masks": updated, "migratedCount": migrated}


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]

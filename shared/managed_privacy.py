"""One complete atomic privacy profile and server binding for Utils."""

from __future__ import annotations

from pathlib import Path
from io import BytesIO
import json
from threading import RLock
from typing import Callable

from helto_privacy import (
    BoundPrivacyPack,
    ConsumerSuiteDeclaration,
    PrivacyProfile,
    install,
    register_consumer_suite_declaration,
    register_legacy_reader_units,
    utils_legacy_reader_units,
)
from helto_privacy.runtime import bound_privacy_pack

try:
    from ..helto_selector_backend.managed_artifacts import (
        SELECTOR_ARTIFACT_ADAPTER_ID,
        SelectorArtifactCodecAdapter,
        SelectorManagedArtifacts,
    )
    from ..helto_selector_backend.managed_workflow import (
        SELECTOR_DISPATCH_ADAPTER_ID,
        SELECTOR_MODE_ADAPTER_ID,
        SELECTOR_OPERATION_ADAPTER_ID,
        SELECTOR_PROJECTION_ADAPTER_ID,
        SELECTOR_STATE_ADAPTER_ID,
        SelectorExecutionDispatchAdapter,
        SelectorExecutionProjectionAdapter,
        SelectorModeAdapter,
        SelectorProductOperationAdapter,
        SelectorWorkflowStateAdapter,
        build_selector_privacy_profile,
    )
except ImportError as exc:
    if str(exc) != "attempted relative import beyond top-level package":
        raise
    from helto_selector_backend.managed_artifacts import (
        SELECTOR_ARTIFACT_ADAPTER_ID,
        SelectorArtifactCodecAdapter,
        SelectorManagedArtifacts,
    )
    from helto_selector_backend.managed_workflow import (
        SELECTOR_DISPATCH_ADAPTER_ID,
        SELECTOR_MODE_ADAPTER_ID,
        SELECTOR_OPERATION_ADAPTER_ID,
        SELECTOR_PROJECTION_ADAPTER_ID,
        SELECTOR_STATE_ADAPTER_ID,
        SelectorExecutionDispatchAdapter,
        SelectorExecutionProjectionAdapter,
        SelectorModeAdapter,
        SelectorProductOperationAdapter,
        SelectorWorkflowStateAdapter,
        build_selector_privacy_profile,
    )

from .privacy_show_any_managed import (
    PRIVACY_SHOW_ANY_MODE_ADAPTER_ID,
    PRIVACY_SHOW_ANY_OPERATION_ADAPTER_ID,
    PRIVACY_SHOW_ANY_STATE_ADAPTER_ID,
    PrivacyShowAnyDisplayOperationAdapter,
    PrivacyShowAnyModeAdapter,
    PrivacyShowAnyWorkflowStateAdapter,
    build_privacy_show_any_profile,
)
from .private_media_managed import (
    PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID,
    PRIVATE_MEDIA_MODE_ADAPTER_ID,
    PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID,
    PRIVATE_MEDIA_SOURCE_OPERATION_ADAPTER_ID,
    PrivateMediaArtifactCodecAdapter,
    MediaNodeManagedArtifacts,
    PrivateMediaModeAdapter,
    PrivateMediaSourceOperationAdapter,
    build_private_media_profile,
)
from .prompt_enhancer.managed_privacy import (
    PROMPT_ENHANCER_DISPATCH_ADAPTER_ID,
    PROMPT_ENHANCER_MODE_ADAPTER_ID,
    PROMPT_ENHANCER_PROJECTION_ADAPTER_ID,
    PROMPT_ENHANCER_STATE_ADAPTER_ID,
    PROMPT_PROVIDER_SETTINGS_STORE_ADAPTER_ID,
    PROMPT_PROVIDER_OPERATION_ADAPTER_ID,
    PromptEnhancerExecutionDispatchAdapter,
    PromptEnhancerExecutionProjectionAdapter,
    PromptEnhancerModeAdapter,
    PromptEnhancerWorkflowStateAdapter,
    build_prompt_enhancer_privacy_profile,
)
from .prompt_enhancer.managed_provider_settings import PromptProviderSettingsStore
from .queue_manager_managed import (
    QUEUE_MODE_ADAPTER_ID,
    QUEUE_OPERATION_ADAPTER_IDS,
    QUEUE_STORE_ADAPTER_ID,
    QueueManagerModeAdapter,
    QueueManagerOperationAdapter,
    QueueManagerSingletonStore,
    build_queue_manager_privacy_profile,
)


UTILS_PROFILE_ID = "helto.comfyui-utils"
UTILS_DISTRIBUTION = "comfyui-utils"
UTILS_SUITE_ID = "helto-suite-2026-07-16.2"
UTILS_PROFILE_FINGERPRINT = (
    "517c7d90d335ac12fd30e7fb0eafba9976b8fb8c1be9cdfa55aa508463760cbe"
)

_INSTALL_LOCK = RLock()
_PACK: BoundPrivacyPack | None = None
_ADAPTERS: dict[str, object] | None = None
_MEDIA_ARTIFACTS: MediaNodeManagedArtifacts | None = None
_SELECTOR_ARTIFACTS: SelectorManagedArtifacts | None = None


class _PromptProviderOperationAdapter:
    def invoke(self, payload: object, context: object) -> object:
        dispatch = getattr(context, "invoke_prompt_provider_operation", None)
        if not callable(dispatch):
            raise RuntimeError("Prompt provider operation context is unavailable.")
        return dispatch(payload)


class _PrivateMediaProductOperationAdapter:
    def invoke(self, payload: object, context: object) -> object:
        dispatch = getattr(context, "invoke_private_media_operation", None)
        if not callable(dispatch):
            raise RuntimeError("Private media operation context is unavailable.")
        return dispatch(payload)

_DECLARATION_ATTRIBUTES = (
    "resources",
    "server_adapters",
    "browser_adapters",
    "scopes",
    "protected_fields",
    "records",
    "singletons",
    "artifacts",
    "subject_mode_bindings",
    "protected_operations",
    "execution_projections",
    "legacy_bindings",
    "legacy_key_imports",
    "record_reference_migrations",
    "opaque_reference_kinds",
    "safe_payload_projections",
)


def build_utils_privacy_profile() -> PrivacyProfile:
    """Compile every Utils slice into one immutable active declaration."""

    fragments = (
        build_selector_privacy_profile(),
        build_private_media_profile(),
        build_privacy_show_any_profile(),
        build_prompt_enhancer_privacy_profile(),
        build_queue_manager_privacy_profile(),
    )
    if any(
        fragment.id != UTILS_PROFILE_ID
        or fragment.distribution != UTILS_DISTRIBUTION
        or fragment.contract != fragments[0].contract
        for fragment in fragments
    ):
        raise RuntimeError("Utils privacy profile fragments do not share one identity.")
    declarations = {
        attribute: tuple(
            item
            for fragment in fragments
            for item in getattr(fragment, attribute)
        )
        for attribute in _DECLARATION_ATTRIBUTES
    }
    profile = PrivacyProfile(
        id=UTILS_PROFILE_ID,
        distribution=UTILS_DISTRIBUTION,
        contract=fragments[0].contract,
        **declarations,
    )
    if profile.fingerprint != UTILS_PROFILE_FINGERPRINT:
        raise RuntimeError("Utils privacy profile fingerprint changed unexpectedly.")
    return profile


def build_utils_server_adapters(
    package_root: str | Path,
    *,
    selector_dispatch: Callable[[object, object, object], object],
    prompt_dispatch: Callable[[object, object, object], object],
    queue_operations: dict[str, Callable[[object, object], object]],
) -> dict[str, object]:
    """Build every declared server slot; partial adapter sets are impossible."""

    root = Path(package_root)
    selector_state = SelectorWorkflowStateAdapter()
    show_any_state = PrivacyShowAnyWorkflowStateAdapter()
    try:
        from ..helto_selector_backend.services import effective_authorized_roots
    except ImportError as exc:
        if str(exc) != "attempted relative import beyond top-level package":
            raise
        from helto_selector_backend.services import effective_authorized_roots
    import folder_paths

    missing_queue = set(QUEUE_OPERATION_ADAPTER_IDS) - set(queue_operations)
    extra_queue = set(queue_operations) - set(QUEUE_OPERATION_ADAPTER_IDS)
    if missing_queue or extra_queue:
        raise ValueError("Utils Queue Manager operation bindings are incomplete.")

    adapters: dict[str, object] = {
        SELECTOR_MODE_ADAPTER_ID: SelectorModeAdapter(),
        SELECTOR_STATE_ADAPTER_ID: selector_state,
        SELECTOR_OPERATION_ADAPTER_ID: SelectorProductOperationAdapter(
            authorized_roots=effective_authorized_roots,
            input_directory=folder_paths.get_input_directory,
        ),
        SELECTOR_PROJECTION_ADAPTER_ID: SelectorExecutionProjectionAdapter(),
        SELECTOR_DISPATCH_ADAPTER_ID: SelectorExecutionDispatchAdapter(selector_dispatch),
        SELECTOR_ARTIFACT_ADAPTER_ID: SelectorArtifactCodecAdapter(
            thumbnail_cache_dir=(
                Path(folder_paths.get_temp_directory())
                / "helto_cache"
                / "HeltoImageSelector"
                / "thumbnails"
            ),
        ),
        PRIVATE_MEDIA_MODE_ADAPTER_ID: PrivateMediaModeAdapter(),
        PRIVATE_MEDIA_ARTIFACT_ADAPTER_ID: PrivateMediaArtifactCodecAdapter(),
        PRIVATE_MEDIA_SOURCE_OPERATION_ADAPTER_ID: PrivateMediaSourceOperationAdapter(),
        PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID: _PrivateMediaProductOperationAdapter(),
        PRIVACY_SHOW_ANY_MODE_ADAPTER_ID: PrivacyShowAnyModeAdapter(),
        PRIVACY_SHOW_ANY_STATE_ADAPTER_ID: show_any_state,
        PRIVACY_SHOW_ANY_OPERATION_ADAPTER_ID: PrivacyShowAnyDisplayOperationAdapter(
            show_any_state,
            lambda text: {"ok": True, "text": text},
        ),
        PROMPT_ENHANCER_MODE_ADAPTER_ID: PromptEnhancerModeAdapter(),
        PROMPT_ENHANCER_STATE_ADAPTER_ID: PromptEnhancerWorkflowStateAdapter(),
        PROMPT_ENHANCER_PROJECTION_ADAPTER_ID: PromptEnhancerExecutionProjectionAdapter(),
        PROMPT_ENHANCER_DISPATCH_ADAPTER_ID: PromptEnhancerExecutionDispatchAdapter(
            prompt_dispatch
        ),
        PROMPT_PROVIDER_SETTINGS_STORE_ADAPTER_ID: PromptProviderSettingsStore(
            root / "config" / "prompt enhancer" / "provider_settings.json"
        ),
        PROMPT_PROVIDER_OPERATION_ADAPTER_ID: _PromptProviderOperationAdapter(),
        QUEUE_MODE_ADAPTER_ID: QueueManagerModeAdapter(),
        QUEUE_STORE_ADAPTER_ID: QueueManagerSingletonStore(
            root / "config" / "queue_manager_state.sqlite3"
        ),
    }
    adapters.update({
        QUEUE_OPERATION_ADAPTER_IDS[operation_id]: QueueManagerOperationAdapter(operation)
        for operation_id, operation in queue_operations.items()
    })
    return adapters


def install_utils_privacy(
    package_root: str | Path,
    *,
    selector_dispatch: Callable[[object, object, object], object],
    prompt_dispatch: Callable[[object, object, object], object],
    queue_operations: dict[str, Callable[[object, object], object]],
) -> BoundPrivacyPack:
    """Install the exact Utils profile once, only after every slot is bound."""

    global _ADAPTERS, _MEDIA_ARTIFACTS, _PACK, _SELECTOR_ARTIFACTS
    with _INSTALL_LOCK:
        if _PACK is not None:
            return _PACK
        register_legacy_reader_units(utils_legacy_reader_units())
        profile = build_utils_privacy_profile()
        adapters = build_utils_server_adapters(
            package_root,
            selector_dispatch=selector_dispatch,
            prompt_dispatch=prompt_dispatch,
            queue_operations=queue_operations,
        )
        if set(adapters) != {slot.id for slot in profile.server_adapters}:
            raise RuntimeError("Utils privacy adapter binding is incomplete.")
        _PACK = install(profile, adapters)
        register_consumer_suite_declaration(
            ConsumerSuiteDeclaration(UTILS_DISTRIBUTION, UTILS_SUITE_ID)
        )
        _ADAPTERS = adapters
        try:
            from ..helto_selector_backend.services import effective_authorized_roots
        except ImportError as exc:
            if str(exc) != "attempted relative import beyond top-level package":
                raise
            from helto_selector_backend.services import effective_authorized_roots
        _SELECTOR_ARTIFACTS = SelectorManagedArtifacts(
            _PACK.artifacts("selector-artifacts"),
            authorized_roots=effective_authorized_roots,
        )
        _MEDIA_ARTIFACTS = MediaNodeManagedArtifacts(
            _PACK.artifacts("private-media-artifacts"),
            mode_handle=_PACK.mode("private-media-mode"),
        )
        return _PACK


def utils_privacy_pack() -> BoundPrivacyPack:
    """Return the active bound pack without exposing mutable installation state."""

    return _PACK if _PACK is not None else bound_privacy_pack(UTILS_PROFILE_ID)


def utils_privacy_adapter(adapter_id: str) -> object:
    """Resolve one immutable profile-bound product adapter for route wiring."""

    if _ADAPTERS is None or adapter_id not in _ADAPTERS:
        raise RuntimeError("Utils privacy adapters are not installed.")
    return _ADAPTERS[adapter_id]


def utils_media_artifacts() -> MediaNodeManagedArtifacts:
    if _MEDIA_ARTIFACTS is None:
        raise RuntimeError("Utils private media is not installed.")
    return _MEDIA_ARTIFACTS


def utils_selector_artifacts() -> SelectorManagedArtifacts:
    if _SELECTOR_ARTIFACTS is None:
        raise RuntimeError("Utils selector artifacts are not installed.")
    return _SELECTOR_ARTIFACTS


async def selector_execution_dispatch(
    value: object,
    context: object,
    cancellation: object,
) -> object:
    """Run selector product logic only after shared execution resolution."""

    if not isinstance(value, dict) or not isinstance(context, dict):
        raise ValueError("Selector execution context is invalid.")
    checkpoint = getattr(cancellation, "checkpoint", None)
    if callable(checkpoint):
        checkpoint()
    try:
        from ..helto_selector_backend.image_processing import select_images
    except ImportError as exc:
        if str(exc) != "attempted relative import beyond top-level package":
            raise
    return await resolve_selector_output(
        value["selected_images"],
        context.get("resize_mode", "zoom to fit"),
        value["edited_masks"],
        value["edited_bboxes"],
    )


async def resolve_selector_output(
    selected_images: object,
    resize_mode: str,
    edited_masks: object,
    edited_bboxes: object,
) -> object:
    try:
        from ..helto_selector_backend.image_processing import select_images
    except ImportError as exc:
        if str(exc) != "attempted relative import beyond top-level package":
            raise
        from helto_selector_backend.image_processing import select_images
    from PIL import Image

    def decoded(value: object, fallback: object) -> object:
        if isinstance(value, str):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return fallback
        return value

    selected = decoded(selected_images, [])
    mask_value = decoded(edited_masks, {})
    bbox_value = decoded(edited_bboxes, {})
    mask_map = dict(mask_value) if isinstance(mask_value, dict) else {}
    decoded: dict[str, bytes] = {}
    for path, reference in mask_map.items():
        decoded[path] = await utils_selector_artifacts().read_mask(path, reference)

    def load_mask(path: str, _reference: object):
        data = decoded.get(path)
        if data is None:
            return None
        with Image.open(BytesIO(data)) as image:
            return image.convert("L")

    return select_images(
        json.dumps(selected),
        resize_mode,
        json.dumps(mask_map),
        json.dumps(bbox_value),
        mask_loader=load_mask,
    )


def prompt_execution_dispatch(
    value: object,
    _context: object,
    cancellation: object,
) -> object:
    """Return resolved prompt semantics to the node's existing product pipeline."""

    checkpoint = getattr(cancellation, "checkpoint", None)
    if callable(checkpoint):
        checkpoint()
    return value


def queue_operation_bindings() -> dict[str, Callable[[object, object], object]]:
    """Bind each declared queue action to the fixed route context interface."""

    def operation(operation_id: str):
        def invoke(payload: object, context: object) -> object:
            dispatch = getattr(context, "invoke_queue_operation", None)
            if not callable(dispatch):
                raise RuntimeError("Queue Manager operation context is unavailable.")
            return dispatch(operation_id, payload)

        return invoke

    return {
        operation_id: operation(operation_id)
        for operation_id in QUEUE_OPERATION_ADAPTER_IDS
    }

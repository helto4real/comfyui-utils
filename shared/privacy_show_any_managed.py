"""Shared privacy integration for Privacy Show Any."""

from __future__ import annotations

import copy
from collections.abc import Callable, Mapping

from helto_privacy import (
    AdapterSlot,
    ExternalJsonValueTransitionAdapter,
    ExternalTransitionPolicy,
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
    ProtectedStateAuthority,
    ResourceKind,
    UTILS_KEY_BIN_IMPORT_ID,
    UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
    UTILS_WORKFLOW_READER_IDS,
    WorkflowRevealOperationContext,
    WorkflowRevealOperations,
    protected_envelope_text,
)

from .privacy_show_any_text import convert_any_to_text


PRIVACY_SHOW_ANY_PROFILE_ID = "helto.comfyui-utils"
PRIVACY_SHOW_ANY_DISTRIBUTION = "comfyui-utils"
PRIVACY_SHOW_ANY_NODE_TYPE = "HeltoPrivacyShowAny"
PRIVACY_SHOW_ANY_SCOPE_ID = "privacy-show-any"
PRIVACY_SHOW_ANY_SCHEMA = "helto.comfyui-utils"

PRIVACY_SHOW_ANY_MODE_RESOURCE_ID = "privacy-show-any-mode"
PRIVACY_SHOW_ANY_WORKFLOW_RESOURCE_ID = "privacy-show-any-workflow"
PRIVACY_SHOW_ANY_MODE_ADAPTER_ID = "privacy-show-any-mode-state"
PRIVACY_SHOW_ANY_MODE_BROWSER_ADAPTER_ID = "privacy-show-any-mode-browser"
PRIVACY_SHOW_ANY_STATE_ADAPTER_ID = "privacy-show-any-workflow-state"
PRIVACY_SHOW_ANY_BROWSER_ADAPTER_ID = "privacy-show-any-workflow-browser"
PRIVACY_SHOW_ANY_OPERATION_ADAPTER_ID = "privacy-show-any-display-operation"

PRIVACY_SHOW_ANY_FIELD_ID = "privacy-show-any-text"
PRIVACY_SHOW_ANY_STATE_WIDGET = "encrypted_text_state"
PRIVACY_SHOW_ANY_STATE_PROPERTY = "helto_privacy_show_any_encrypted_text_state"
PRIVACY_SHOW_ANY_MODE_PROPERTY = "helto_privacy_show_any_privacy_mode"
PRIVACY_SHOW_ANY_DISPLAY_OPERATION_ID = "privacy-show-any.display-result"
PRIVACY_SHOW_ANY_DISPLAY_ROUTE = "/helto-privacy-show-any/display-result"
TEXT_UI_KEY = "helto_privacy_show_any"
_WORKFLOW_TRANSITION_POLICY = ExternalTransitionPolicy(
    max_original_bytes_per_owner=16 * 1024 * 1024,
    max_target_bytes_per_owner=16 * 1024 * 1024,
)

def privacy_show_any_legacy_binding_id(generation: str) -> str:
    if generation not in UTILS_WORKFLOW_READER_IDS:
        raise ValueError("Unknown Privacy Show Any legacy binding.")
    return f"privacy-show-any-{generation}"


def build_privacy_show_any_profile() -> PrivacyProfile:
    reader_ids = tuple(UTILS_WORKFLOW_READER_IDS.values())
    return PrivacyProfile(
        id=PRIVACY_SHOW_ANY_PROFILE_ID,
        distribution=PRIVACY_SHOW_ANY_DISTRIBUTION,
        resources=(
            ProfileResource(
                PRIVACY_SHOW_ANY_MODE_RESOURCE_ID,
                ResourceKind.MODE,
                (
                    PRIVACY_SHOW_ANY_MODE_ADAPTER_ID,
                    PRIVACY_SHOW_ANY_MODE_BROWSER_ADAPTER_ID,
                ),
            ),
            ProfileResource(
                PRIVACY_SHOW_ANY_WORKFLOW_RESOURCE_ID,
                ResourceKind.WORKFLOW,
                (
                    PRIVACY_SHOW_ANY_STATE_ADAPTER_ID,
                    PRIVACY_SHOW_ANY_BROWSER_ADAPTER_ID,
                    PRIVACY_SHOW_ANY_OPERATION_ADAPTER_ID,
                ),
            ),
        ),
        server_adapters=(
            AdapterSlot(
                PRIVACY_SHOW_ANY_MODE_ADAPTER_ID,
                ResourceKind.MODE,
                PRIVACY_SHOW_ANY_MODE_RESOURCE_ID,
            ),
            AdapterSlot(
                PRIVACY_SHOW_ANY_STATE_ADAPTER_ID,
                ResourceKind.WORKFLOW,
                PRIVACY_SHOW_ANY_WORKFLOW_RESOURCE_ID,
            ),
            AdapterSlot(
                PRIVACY_SHOW_ANY_OPERATION_ADAPTER_ID,
                ResourceKind.WORKFLOW,
                PRIVACY_SHOW_ANY_WORKFLOW_RESOURCE_ID,
            ),
        ),
        browser_adapters=(
            AdapterSlot(
                PRIVACY_SHOW_ANY_MODE_BROWSER_ADAPTER_ID,
                ResourceKind.MODE,
                PRIVACY_SHOW_ANY_MODE_RESOURCE_ID,
                (PRIVACY_SHOW_ANY_NODE_TYPE,),
            ),
            AdapterSlot(
                PRIVACY_SHOW_ANY_BROWSER_ADAPTER_ID,
                ResourceKind.WORKFLOW,
                PRIVACY_SHOW_ANY_WORKFLOW_RESOURCE_ID,
                (PRIVACY_SHOW_ANY_NODE_TYPE,),
            ),
        ),
        scopes=(
            PrivacyScope(
                PRIVACY_SHOW_ANY_SCOPE_ID,
                PRIVACY_SHOW_ANY_MODE_RESOURCE_ID,
                PRIVACY_SHOW_ANY_MODE_ADAPTER_ID,
                PRIVACY_SHOW_ANY_MODE_BROWSER_ADAPTER_ID,
            ),
        ),
        protected_fields=(
            ProtectedField(
                PRIVACY_SHOW_ANY_FIELD_ID,
                PRIVACY_SHOW_ANY_WORKFLOW_RESOURCE_ID,
                PRIVACY_SHOW_ANY_SCOPE_ID,
                PRIVACY_SHOW_ANY_STATE_ADAPTER_ID,
                PRIVACY_SHOW_ANY_BROWSER_ADAPTER_ID,
                (PRIVACY_SHOW_ANY_NODE_TYPE,),
                FieldLocation(
                    FieldLocationKind.PROPERTY,
                    PRIVACY_SHOW_ANY_STATE_PROPERTY,
                ),
                PRIVACY_SHOW_ANY_SCHEMA,
                PRIVACY_SHOW_ANY_FIELD_ID,
                ProtectedStateAuthority.EXTERNAL_BROWSER_WORKFLOW,
                _WORKFLOW_TRANSITION_POLICY,
                legacy_reader_ids=reader_ids,
                mirror_locations=(
                    FieldLocation(
                        FieldLocationKind.WIDGET,
                        PRIVACY_SHOW_ANY_STATE_WIDGET,
                    ),
                ),
            ),
        ),
        protected_operations=(
            ProtectedOperation(
                PRIVACY_SHOW_ANY_DISPLAY_OPERATION_ID,
                PRIVACY_SHOW_ANY_WORKFLOW_RESOURCE_ID,
                PRIVACY_SHOW_ANY_OPERATION_ADAPTER_ID,
                PRIVACY_SHOW_ANY_DISPLAY_ROUTE,
            ),
        ),
        legacy_bindings=tuple(
            LegacyReaderBinding(
                privacy_show_any_legacy_binding_id(generation),
                reader_id,
                PRIVACY_SHOW_ANY_WORKFLOW_RESOURCE_ID,
                LegacyLocationKind.WORKFLOW_FIELD,
                PRIVACY_SHOW_ANY_FIELD_ID,
            )
            for generation, reader_id in UTILS_WORKFLOW_READER_IDS.items()
        ),
        legacy_key_imports=(
            LegacyKeyImportBinding(
                "privacy-show-any-key-bin",
                UTILS_KEY_BIN_IMPORT_ID,
                PRIVACY_SHOW_ANY_WORKFLOW_RESOURCE_ID,
                LegacyLocationKind.WORKFLOW_FIELD,
                PRIVACY_SHOW_ANY_FIELD_ID,
                LegacyKeyFormat.BINARY,
            ),
            LegacyKeyImportBinding(
                "privacy-show-any-privacy-key-bin",
                UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
                PRIVACY_SHOW_ANY_WORKFLOW_RESOURCE_ID,
                LegacyLocationKind.WORKFLOW_FIELD,
                PRIVACY_SHOW_ANY_FIELD_ID,
                LegacyKeyFormat.BINARY,
            ),
        ),
    )


PrivacyShowAnyModeAdapter = PrivateByDefaultModeAdapter


class PrivacyShowAnyWorkflowStateAdapter(ExternalJsonValueTransitionAdapter):
    def __init__(self) -> None:
        super().__init__(PRIVACY_SHOW_ANY_SCHEMA)

    def capture(self, source: object, _declaration: object) -> object:
        if isinstance(source, Mapping):
            return copy.deepcopy(source.get("value", source))
        return copy.deepcopy(getattr(source, "value", source))

    def normalize(self, value: object, _declaration: object) -> dict[str, str]:
        return {"value": convert_any_to_text(_unwrap(value))}

    def apply_revealed(self, target: object, value: object, declaration: object) -> None:
        normalized = self.normalize(value, declaration)["value"]
        if isinstance(target, dict):
            target["value"] = normalized
        else:
            setattr(target, "value", normalized)

    def clear_plaintext(self, target: object, _declaration: object) -> None:
        if isinstance(target, dict):
            target["value"] = ""
        else:
            setattr(target, "value", "")

class PrivacyShowAnyManagedNodeAdapter:
    """Future node execution path that never encrypts outside the handle."""

    def __init__(self, output_factory: Callable[[str, object], object] | None = None) -> None:
        self._output_factory = output_factory or _node_output

    def invoke(self, value: object, workflow: object) -> object:
        text = convert_any_to_text(value)
        protected = workflow.protect_runtime(
            PRIVACY_SHOW_ANY_FIELD_ID,
            text,
        )
        envelope = protected_envelope_text(protected)
        return self._output_factory(
            text,
            {TEXT_UI_KEY: [{"protected": envelope}]},
        )


class PrivacyShowAnyProtectedOperations(WorkflowRevealOperations):
    def __init__(
        self,
        authorization: object,
        workflow: object,
        adapter: object,
    ) -> None:
        super().__init__(
            authorization,
            workflow,
            adapter,
            scope_id=PRIVACY_SHOW_ANY_SCOPE_ID,
            operation_id=PRIVACY_SHOW_ANY_DISPLAY_OPERATION_ID,
        )


class PrivacyShowAnyDisplayOperationAdapter:
    def __init__(
        self,
        state: PrivacyShowAnyWorkflowStateAdapter,
        presenter: Callable[[str], object],
    ) -> None:
        if not callable(presenter):
            raise TypeError("A Privacy Show Any presenter is required.")
        self._state = state
        self._presenter = presenter
        self._field = build_privacy_show_any_profile().protected_fields[0]

    def invoke(
        self,
        payload: object,
        context: WorkflowRevealOperationContext,
    ) -> object:
        if not isinstance(payload, Mapping) or set(payload) != {"protected"}:
            raise ValueError("Privacy Show Any display payload is invalid.")
        revealed = context.workflow.reveal(
            PRIVACY_SHOW_ANY_FIELD_ID,
            payload["protected"],
            context.reveal_authorization,
        )
        text = self._state.normalize(revealed.value, self._field)["value"]
        return self._presenter(text)


def _unwrap(value: object) -> object:
    if isinstance(value, Mapping) and set(value) == {"value"}:
        return value["value"]
    return value


def _node_output(text: str, ui_payload: object) -> object:
    from comfy_api.latest import io

    return io.NodeOutput(text, ui=ui_payload)

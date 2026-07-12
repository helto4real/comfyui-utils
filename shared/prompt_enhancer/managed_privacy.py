"""Shared privacy profile for Prompt Enhancer."""

from __future__ import annotations

import copy
import json
from collections.abc import Callable, Mapping

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
    SemanticExecutionProjection,
    SingletonDeclaration,
    SingletonPayloadKind,
    UTILS_KEY_BIN_IMPORT_ID,
    UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
    UTILS_PROVIDER_SETTINGS_PLAINTEXT_READER_ID,
    UTILS_PROVIDER_SETTINGS_WRAPPER_READER_ID,
    UTILS_WORKFLOW_READER_IDS,
)

from .variables import parse_prompt_variables, substitute_prompt_variables


PROMPT_ENHANCER_PROFILE_ID = "helto.comfyui-utils"
PROMPT_ENHANCER_DISTRIBUTION = "comfyui-utils"
PROMPT_ENHANCER_NODE_TYPE = "HeltoPromptEnhancer"
PROMPT_ENHANCER_SCOPE_ID = "prompt-enhancer"
PROMPT_ENHANCER_SCHEMA = "helto.comfyui-utils"

PROMPT_ENHANCER_MODE_RESOURCE_ID = "prompt-enhancer-mode"
PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID = "prompt-enhancer-workflow"
PROMPT_ENHANCER_EXECUTION_RESOURCE_ID = "prompt-enhancer-execution"
PROMPT_PROVIDER_SETTINGS_RESOURCE_ID = "prompt-provider-settings"

PROMPT_ENHANCER_MODE_ADAPTER_ID = "prompt-enhancer-mode-state"
PROMPT_ENHANCER_MODE_BROWSER_ADAPTER_ID = "prompt-enhancer-mode-browser"
PROMPT_ENHANCER_STATE_ADAPTER_ID = "prompt-enhancer-workflow-state"
PROMPT_ENHANCER_BROWSER_ADAPTER_ID = "prompt-enhancer-workflow-browser"
PROMPT_ENHANCER_PROJECTION_ADAPTER_ID = "prompt-enhancer-execution-projection"
PROMPT_ENHANCER_DISPATCH_ADAPTER_ID = "prompt-enhancer-execution-dispatch"
PROMPT_PROVIDER_SETTINGS_STORE_ADAPTER_ID = "prompt-provider-settings-store"
PROMPT_PROVIDER_OPERATION_ADAPTER_ID = "prompt-provider-operations"

PROMPT_ENHANCER_SCRIPT_FIELD_ID = "prompt-enhancer-script"
PROMPT_ENHANCER_VARIABLES_FIELD_ID = "prompt-enhancer-variables"
PROMPT_ENHANCER_EXECUTION_PROJECTION_ID = "prompt-enhancer-generate"
PROMPT_PROVIDER_SETTINGS_SINGLETON_ID = "prompt-provider-settings"
PROMPT_PROVIDER_OPERATION_IDS = (
    "prompt-provider.settings-load",
    "prompt-provider.settings-save",
    "prompt-provider.model-download",
    "prompt-provider.model-unload",
)
PROMPT_PROVIDER_SETTINGS_PLAINTEXT_BINDING_ID = (
    "prompt-provider-settings-plaintext-v1"
)
PROMPT_PROVIDER_SETTINGS_WRAPPER_BINDING_ID = "prompt-provider-settings-wrapper-v2"

_FIELD_LOCATIONS = {
    PROMPT_ENHANCER_SCRIPT_FIELD_ID: "script",
    PROMPT_ENHANCER_VARIABLES_FIELD_ID: "variables",
}


def prompt_enhancer_workflow_binding_id(field_id: str, generation: str) -> str:
    if field_id not in _FIELD_LOCATIONS or generation not in UTILS_WORKFLOW_READER_IDS:
        raise ValueError("Unknown Prompt Enhancer workflow binding.")
    return f"{field_id}-{generation}"


def build_prompt_enhancer_privacy_profile() -> PrivacyProfile:
    workflow_reader_ids = tuple(UTILS_WORKFLOW_READER_IDS.values())
    fields = tuple(
        ProtectedField(
            field_id,
            PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
            PROMPT_ENHANCER_SCOPE_ID,
            PROMPT_ENHANCER_STATE_ADAPTER_ID,
            PROMPT_ENHANCER_BROWSER_ADAPTER_ID,
            (PROMPT_ENHANCER_NODE_TYPE,),
            FieldLocation(FieldLocationKind.WIDGET, location),
            PROMPT_ENHANCER_SCHEMA,
            field_id,
            legacy_reader_ids=workflow_reader_ids,
            execution=True,
        )
        for field_id, location in _FIELD_LOCATIONS.items()
    )
    legacy_bindings = [
        LegacyReaderBinding(
            prompt_enhancer_workflow_binding_id(field_id, generation),
            reader_id,
            PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
            LegacyLocationKind.WORKFLOW_FIELD,
            field_id,
        )
        for field_id in _FIELD_LOCATIONS
        for generation, reader_id in UTILS_WORKFLOW_READER_IDS.items()
    ]
    legacy_bindings.extend(
        (
            LegacyReaderBinding(
                PROMPT_PROVIDER_SETTINGS_PLAINTEXT_BINDING_ID,
                UTILS_PROVIDER_SETTINGS_PLAINTEXT_READER_ID,
                PROMPT_PROVIDER_SETTINGS_RESOURCE_ID,
                LegacyLocationKind.PACK_STATE,
                PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
            ),
            LegacyReaderBinding(
                PROMPT_PROVIDER_SETTINGS_WRAPPER_BINDING_ID,
                UTILS_PROVIDER_SETTINGS_WRAPPER_READER_ID,
                PROMPT_PROVIDER_SETTINGS_RESOURCE_ID,
                LegacyLocationKind.PACK_STATE,
                PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
            ),
        )
    )
    return PrivacyProfile(
        id=PROMPT_ENHANCER_PROFILE_ID,
        distribution=PROMPT_ENHANCER_DISTRIBUTION,
        resources=(
            ProfileResource(
                PROMPT_ENHANCER_MODE_RESOURCE_ID,
                ResourceKind.MODE,
                (
                    PROMPT_ENHANCER_MODE_ADAPTER_ID,
                    PROMPT_ENHANCER_MODE_BROWSER_ADAPTER_ID,
                ),
            ),
            ProfileResource(
                PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
                ResourceKind.WORKFLOW,
                (
                    PROMPT_ENHANCER_STATE_ADAPTER_ID,
                    PROMPT_ENHANCER_BROWSER_ADAPTER_ID,
                    PROMPT_PROVIDER_OPERATION_ADAPTER_ID,
                ),
            ),
            ProfileResource(
                PROMPT_ENHANCER_EXECUTION_RESOURCE_ID,
                ResourceKind.EXECUTION,
                (
                    PROMPT_ENHANCER_PROJECTION_ADAPTER_ID,
                    PROMPT_ENHANCER_DISPATCH_ADAPTER_ID,
                ),
            ),
            ProfileResource(
                PROMPT_PROVIDER_SETTINGS_RESOURCE_ID,
                ResourceKind.SINGLETON,
                (PROMPT_PROVIDER_SETTINGS_STORE_ADAPTER_ID,),
            ),
        ),
        server_adapters=(
            AdapterSlot(
                PROMPT_ENHANCER_MODE_ADAPTER_ID,
                ResourceKind.MODE,
                PROMPT_ENHANCER_MODE_RESOURCE_ID,
            ),
            AdapterSlot(
                PROMPT_ENHANCER_STATE_ADAPTER_ID,
                ResourceKind.WORKFLOW,
                PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
            ),
            AdapterSlot(
                PROMPT_ENHANCER_PROJECTION_ADAPTER_ID,
                ResourceKind.EXECUTION,
                PROMPT_ENHANCER_EXECUTION_RESOURCE_ID,
            ),
            AdapterSlot(
                PROMPT_ENHANCER_DISPATCH_ADAPTER_ID,
                ResourceKind.EXECUTION,
                PROMPT_ENHANCER_EXECUTION_RESOURCE_ID,
            ),
            AdapterSlot(
                PROMPT_PROVIDER_SETTINGS_STORE_ADAPTER_ID,
                ResourceKind.SINGLETON,
                PROMPT_PROVIDER_SETTINGS_RESOURCE_ID,
            ),
            AdapterSlot(
                PROMPT_PROVIDER_OPERATION_ADAPTER_ID,
                ResourceKind.WORKFLOW,
                PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
            ),
        ),
        browser_adapters=(
            AdapterSlot(
                PROMPT_ENHANCER_MODE_BROWSER_ADAPTER_ID,
                ResourceKind.MODE,
                PROMPT_ENHANCER_MODE_RESOURCE_ID,
                (PROMPT_ENHANCER_NODE_TYPE,),
            ),
            AdapterSlot(
                PROMPT_ENHANCER_BROWSER_ADAPTER_ID,
                ResourceKind.WORKFLOW,
                PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
                (PROMPT_ENHANCER_NODE_TYPE,),
            ),
        ),
        scopes=(
            PrivacyScope(
                PROMPT_ENHANCER_SCOPE_ID,
                PROMPT_ENHANCER_MODE_RESOURCE_ID,
                PROMPT_ENHANCER_MODE_ADAPTER_ID,
                PROMPT_ENHANCER_MODE_BROWSER_ADAPTER_ID,
            ),
        ),
        protected_fields=fields,
        singletons=(
            SingletonDeclaration(
                PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
                PROMPT_PROVIDER_SETTINGS_RESOURCE_ID,
                PROMPT_ENHANCER_SCOPE_ID,
                PROMPT_ENHANCER_SCHEMA,
                "provider-credential",
                PROMPT_PROVIDER_SETTINGS_STORE_ADAPTER_ID,
                SingletonPayloadKind.FIELD,
                legacy_reader_ids=(
                    UTILS_PROVIDER_SETTINGS_PLAINTEXT_READER_ID,
                    UTILS_PROVIDER_SETTINGS_WRAPPER_READER_ID,
                ),
            ),
        ),
        execution_projections=(
            SemanticExecutionProjection(
                PROMPT_ENHANCER_EXECUTION_PROJECTION_ID,
                PROMPT_ENHANCER_EXECUTION_RESOURCE_ID,
                PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
                PROMPT_ENHANCER_PROJECTION_ADAPTER_ID,
                PROMPT_ENHANCER_DISPATCH_ADAPTER_ID,
            ),
        ),
        protected_operations=(
            ProtectedOperation(
                "prompt-provider.settings-load",
                PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
                PROMPT_PROVIDER_OPERATION_ADAPTER_ID,
                "/helto-utils/prompt-provider/settings",
                "GET",
            ),
            ProtectedOperation(
                "prompt-provider.settings-save",
                PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
                PROMPT_PROVIDER_OPERATION_ADAPTER_ID,
                "/helto-utils/prompt-provider/settings",
                "POST",
            ),
            ProtectedOperation(
                "prompt-provider.model-download",
                PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
                PROMPT_PROVIDER_OPERATION_ADAPTER_ID,
                "/helto-utils/prompt-provider/download",
                "POST",
            ),
            ProtectedOperation(
                "prompt-provider.model-unload",
                PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
                PROMPT_PROVIDER_OPERATION_ADAPTER_ID,
                "/helto-utils/prompt-provider/unload",
                "POST",
            ),
        ),
        legacy_bindings=tuple(legacy_bindings),
        legacy_key_imports=(
            LegacyKeyImportBinding(
                "prompt-enhancer-key-bin",
                UTILS_KEY_BIN_IMPORT_ID,
                PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
                LegacyLocationKind.WORKFLOW_FIELD,
                PROMPT_ENHANCER_SCRIPT_FIELD_ID,
                LegacyKeyFormat.BINARY,
            ),
            LegacyKeyImportBinding(
                "prompt-enhancer-privacy-key-bin",
                UTILS_PRIVACY_KEY_BIN_IMPORT_ID,
                PROMPT_ENHANCER_WORKFLOW_RESOURCE_ID,
                LegacyLocationKind.WORKFLOW_FIELD,
                PROMPT_ENHANCER_SCRIPT_FIELD_ID,
                LegacyKeyFormat.BINARY,
            ),
        ),
    )


PromptEnhancerModeAdapter = PrivateByDefaultModeAdapter


class PromptEnhancerWorkflowStateAdapter:
    """Consumer-owned widget locations and canonical product normalization."""

    def capture(self, source: object, declaration: object) -> object:
        location = _FIELD_LOCATIONS[_declaration_id(declaration)]
        value = source.get(location) if isinstance(source, Mapping) else getattr(source, location)
        return copy.deepcopy(value)

    def normalize(self, value: object, declaration: object) -> dict[str, object]:
        return {"value": _normalize_field(_declaration_id(declaration), value)}

    def apply_revealed(self, target: object, value: object, declaration: object) -> None:
        field_id = _declaration_id(declaration)
        normalized = _normalize_field(field_id, value)
        location = _FIELD_LOCATIONS[field_id]
        if isinstance(target, dict):
            target[location] = copy.deepcopy(normalized)
        else:
            setattr(target, location, copy.deepcopy(normalized))

    def clear_plaintext(self, target: object, declaration: object) -> None:
        field_id = _declaration_id(declaration)
        default = "" if field_id == PROMPT_ENHANCER_SCRIPT_FIELD_ID else []
        location = _FIELD_LOCATIONS[field_id]
        if isinstance(target, dict):
            target[location] = copy.deepcopy(default)
        else:
            setattr(target, location, copy.deepcopy(default))

    def prepare_mode_transition(self, *_args) -> None:
        return None

    def commit_mode_transition(self, *_args) -> None:
        return None

    def rollback_mode_transition(self, *_args) -> None:
        return None


class PromptEnhancerExecutionProjectionAdapter:
    def project(self, fields: Mapping[str, object], _declaration: object) -> dict[str, object]:
        if set(fields) != set(_FIELD_LOCATIONS):
            raise ValueError("Prompt Enhancer execution state is incomplete.")
        return {
            "resolved_script": _normalize_field(
                PROMPT_ENHANCER_SCRIPT_FIELD_ID,
                fields[PROMPT_ENHANCER_SCRIPT_FIELD_ID],
            ),
            "variables": _normalize_field(
                PROMPT_ENHANCER_VARIABLES_FIELD_ID,
                fields[PROMPT_ENHANCER_VARIABLES_FIELD_ID],
            ),
        }


class PromptEnhancerExecutionDispatchAdapter:
    """Resolves variables, then delegates provider behavior to product code."""

    def __init__(self, dispatcher: Callable[[object, object, object], object]) -> None:
        if not callable(dispatcher):
            raise TypeError("A Prompt Enhancer execution dispatcher is required.")
        self._dispatcher = dispatcher

    def dispatch(self, value: object, context: object, cancellation: object) -> object:
        if not isinstance(value, Mapping) or set(value) != {"resolved_script", "variables"}:
            raise ValueError("Prompt Enhancer execution state is invalid.")
        data = dict(context) if isinstance(context, Mapping) else {}
        external = str(data.get("external_prompt") or "").strip()
        script = _normalize_field(
            PROMPT_ENHANCER_SCRIPT_FIELD_ID,
            value["resolved_script"],
        )
        variables = _normalize_field(
            PROMPT_ENHANCER_VARIABLES_FIELD_ID,
            value["variables"],
        )
        try:
            seed = int(data.get("seed", 0))
        except (TypeError, ValueError):
            seed = 0
        checkpoint = getattr(cancellation, "checkpoint", None)
        if callable(checkpoint):
            checkpoint()
        resolved = {
            "resolved_script": substitute_prompt_variables(
                external or script.strip(),
                variables,
                seed,
            ),
            "variables": variables,
        }
        return self._dispatcher(resolved, context, cancellation)


def _declaration_id(declaration: object) -> str:
    field_id = getattr(declaration, "id", None)
    if field_id not in _FIELD_LOCATIONS:
        raise ValueError("Unknown Prompt Enhancer field.")
    return field_id


def _unwrap(value: object) -> object:
    if isinstance(value, Mapping) and set(value) == {"value"}:
        return value["value"]
    return value


def _normalize_field(field_id: str, value: object) -> object:
    value = _unwrap(value)
    if field_id == PROMPT_ENHANCER_SCRIPT_FIELD_ID:
        if not isinstance(value, str):
            raise ValueError("Prompt Enhancer script is invalid.")
        return value
    if field_id != PROMPT_ENHANCER_VARIABLES_FIELD_ID:
        raise ValueError("Unknown Prompt Enhancer field.")
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            raise ValueError("Prompt Enhancer variables are invalid.") from None
    if not isinstance(value, list):
        raise ValueError("Prompt Enhancer variables are invalid.")
    return parse_prompt_variables(value)

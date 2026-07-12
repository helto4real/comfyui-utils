"""Grouped legacy workflow migration for Prompt Enhancer fields."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from helto_privacy import (
    MigrationVerification,
    is_verified_current_disposition,
    protected_envelope_mapping,
)

from .managed_privacy import (
    _FIELD_LOCATIONS,
    _normalize_field,
    build_prompt_enhancer_privacy_profile,
    prompt_enhancer_workflow_binding_id,
)


class PromptEnhancerWorkflowStore(Protocol):
    def read_fields(self) -> Mapping[str, object]: ...

    def replace_fields(self, fields: Mapping[str, object]) -> None: ...


@dataclass(frozen=True, slots=True)
class PromptEnhancerMigrationAuthorizations:
    read: object
    complete: object
    protect: object
    inspect: object
    reveal: object


class PromptEnhancerWorkflowMigrationCoordinator:
    """Discover both fields and complete one current rewrite/receipt."""

    def __init__(
        self,
        migration_handle: object,
        workflow_handle: object,
        store: PromptEnhancerWorkflowStore,
    ) -> None:
        self._migration = migration_handle
        self._workflow = workflow_handle
        self._store = store
        self._fields = {
            field.id: field
            for field in build_prompt_enhancer_privacy_profile().protected_fields
        }

    def migrate(
        self,
        generation: str,
        authorizations: PromptEnhancerMigrationAuthorizations,
    ) -> object:
        if generation not in {"raw-xor", "priv1", "priv2", "priv3"}:
            raise ValueError("Unknown Prompt Enhancer workflow generation.")
        original = dict(self._store.read_fields())
        if set(original) != set(_FIELD_LOCATIONS):
            raise ValueError("Prompt Enhancer workflow source is incomplete.")
        discovered = {
            field_id: self._migration.discover_and_read(
                prompt_enhancer_workflow_binding_id(field_id, generation),
                original[field_id],
                authorizations.read,
            )
            for field_id in _FIELD_LOCATIONS
        }
        expected = {
            field_id: _normalize_field(field_id, result.value)
            for field_id, result in discovered.items()
        }
        transaction = PromptEnhancerWorkflowMigrationTransaction(
            self._workflow,
            self._store,
            authorizations.protect,
            authorizations.inspect,
            authorizations.reveal,
            captured_original=original,
        )
        return self._migration.complete_many(
            tuple(result.obligation.id for result in discovered.values()),
            expected,
            transaction,
            authorizations.complete,
        )


class PromptEnhancerWorkflowMigrationTransaction:
    def __init__(
        self,
        workflow_handle: object,
        store: PromptEnhancerWorkflowStore,
        protect_authorization: object,
        inspect_authorization: object,
        reveal_authorization: object,
        *,
        captured_original: Mapping[str, object] | None = None,
    ) -> None:
        self._workflow = workflow_handle
        self._store = store
        self._protect_authorization = protect_authorization
        self._inspect_authorization = inspect_authorization
        self._reveal_authorization = reveal_authorization
        self._original = (
            copy.deepcopy(dict(captured_original))
            if captured_original is not None
            else None
        )
        self._expected: dict[str, object] | None = None
        self._protected: dict[str, object] | None = None
        self._committed = False
        self._source_changed = False

    def capture_original(self) -> dict[str, object]:
        if self._original is None:
            original = dict(self._store.read_fields())
            if set(original) != set(_FIELD_LOCATIONS):
                raise ValueError("Prompt Enhancer workflow source is incomplete.")
            self._original = copy.deepcopy(original)
        return copy.deepcopy(self._original)

    def stage_current(self, normalized: object) -> None:
        if not isinstance(normalized, Mapping) or set(normalized) != set(
            _FIELD_LOCATIONS
        ):
            raise ValueError("Prompt Enhancer migration state is incomplete.")
        self._expected = {
            field_id: _normalize_field(field_id, normalized[field_id])
            for field_id in _FIELD_LOCATIONS
        }
        self._protected = {
            field_id: protected_envelope_mapping(
                self._workflow.protect(
                    field_id,
                    value,
                    self._protect_authorization,
                )
            )
            for field_id, value in self._expected.items()
        }

    def stage_durable_adjuncts(self, _normalized: object) -> None:
        return None

    def commit(self) -> None:
        if self._original is None or self._protected is None:
            raise RuntimeError("Prompt Enhancer migration state was not staged.")
        if dict(self._store.read_fields()) != self._original:
            self._source_changed = True
            raise RuntimeError("Prompt Enhancer migration source changed.")
        self._store.replace_fields(copy.deepcopy(self._protected))
        self._committed = True

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
        normalized = {
            field_id: _normalize_field(
                field_id,
                self._workflow.reveal(
                    field_id,
                    stored[field_id],
                    self._reveal_authorization,
                ).value["value"],
            )
            for field_id in _FIELD_LOCATIONS
        }
        return MigrationVerification(normalized, current_format, True)

    def rollback(self, _original: object) -> None:
        if self._source_changed and not self._committed:
            return
        if self._original is None:
            raise RuntimeError("Prompt Enhancer migration source is unavailable.")
        self._store.replace_fields(copy.deepcopy(self._original))

    def finalize(self, _original: object) -> None:
        if self._original is not None and dict(self._store.read_fields()) == self._original:
            raise RuntimeError("Prompt Enhancer workflow source was not retired.")

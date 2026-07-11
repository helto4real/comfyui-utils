"""One-receipt migration for Privacy Show Any's mirrored legacy state."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from helto_privacy import (
    MigrationVerification,
    is_verified_current_disposition,
    protected_envelope_text,
)

from .privacy_show_any_managed import (
    PRIVACY_SHOW_ANY_FIELD_ID,
    PrivacyShowAnyWorkflowStateAdapter,
    build_privacy_show_any_profile,
    privacy_show_any_legacy_binding_id,
)


class PrivacyShowAnyMirrorStore(Protocol):
    def read_projections(self) -> Mapping[str, object]: ...

    def replace_projections(self, projections: Mapping[str, object]) -> None: ...


@dataclass(frozen=True, slots=True)
class PrivacyShowAnyMigrationAuthorizations:
    read: object
    complete: object
    protect: object
    inspect: object
    reveal: object


class PrivacyShowAnyMigrationCoordinator:
    def __init__(
        self,
        migration_handle: object,
        workflow_handle: object,
        store: PrivacyShowAnyMirrorStore,
    ) -> None:
        self._migration = migration_handle
        self._workflow = workflow_handle
        self._store = store
        self._state = PrivacyShowAnyWorkflowStateAdapter()
        self._field = build_privacy_show_any_profile().protected_fields[0]

    def migrate(
        self,
        generation: str,
        authorizations: PrivacyShowAnyMigrationAuthorizations,
    ) -> object:
        if generation not in {"raw-xor", "priv1", "priv2", "priv3"}:
            raise ValueError("Unknown Privacy Show Any workflow generation.")
        original = dict(self._store.read_projections())
        if set(original) != {"widget", "property"}:
            raise ValueError("Privacy Show Any mirrors are incomplete.")
        discovered = {
            projection: self._migration.discover_and_read(
                privacy_show_any_legacy_binding_id(generation),
                original[projection],
                authorizations.read,
            )
            for projection in ("widget", "property")
        }
        normalized = {
            projection: self._state.normalize(result.value, self._field)["value"]
            for projection, result in discovered.items()
        }
        if len(set(normalized.values())) != 1:
            raise ValueError("Privacy Show Any mirrors disagree.")
        expected = next(iter(normalized.values()))
        transaction = PrivacyShowAnyMigrationTransaction(
            self._workflow,
            self._store,
            self._state,
            authorizations,
            captured_original=original,
        )
        return self._migration.complete_many(
            tuple(
                sorted(
                    {result.obligation.id for result in discovered.values()}
                )
            ),
            expected,
            transaction,
            authorizations.complete,
        )


class PrivacyShowAnyMigrationTransaction:
    def __init__(
        self,
        workflow_handle: object,
        store: PrivacyShowAnyMirrorStore,
        state: PrivacyShowAnyWorkflowStateAdapter,
        authorizations: PrivacyShowAnyMigrationAuthorizations,
        *,
        captured_original: Mapping[str, object] | None = None,
    ) -> None:
        self._workflow = workflow_handle
        self._store = store
        self._state = state
        self._authorizations = authorizations
        self._field = build_privacy_show_any_profile().protected_fields[0]
        self._original = (
            copy.deepcopy(dict(captured_original))
            if captured_original is not None
            else None
        )
        self._expected: str | None = None
        self._protected: object | None = None
        self._committed = False
        self._source_changed = False

    def capture_original(self) -> dict[str, object]:
        if self._original is None:
            original = dict(self._store.read_projections())
            if set(original) != {"widget", "property"}:
                raise ValueError("Privacy Show Any mirrors are incomplete.")
            self._original = copy.deepcopy(original)
        return copy.deepcopy(self._original)

    def stage_current(self, normalized: object) -> None:
        self._expected = self._state.normalize(normalized, self._field)["value"]
        self._protected = protected_envelope_text(
            self._workflow.protect(
                PRIVACY_SHOW_ANY_FIELD_ID,
                self._expected,
                self._authorizations.protect,
            )
        )

    def stage_durable_adjuncts(self, _normalized: object) -> None:
        return None

    def commit(self) -> None:
        if self._original is None or self._protected is None:
            raise RuntimeError("Privacy Show Any migration was not staged.")
        if dict(self._store.read_projections()) != self._original:
            self._source_changed = True
            raise RuntimeError("Privacy Show Any migration source changed.")
        self._store.replace_projections(
            {"widget": self._protected, "property": self._protected}
        )
        self._committed = True

    def read_back(self) -> MigrationVerification:
        stored = dict(self._store.read_projections())
        current_format = (
            self._protected is not None
            and stored == {"widget": self._protected, "property": self._protected}
        )
        if current_format:
            current_format = all(
                is_verified_current_disposition(
                    self._workflow.inspect_disposition(
                        PRIVACY_SHOW_ANY_FIELD_ID,
                        stored[projection],
                        self._authorizations.inspect,
                    )
                )
                for projection in ("widget", "property")
            )
        revealed = self._workflow.reveal(
            PRIVACY_SHOW_ANY_FIELD_ID,
            stored["widget"],
            self._authorizations.reveal,
        )
        normalized = self._state.normalize(revealed.value, self._field)["value"]
        return MigrationVerification(normalized, current_format, True)

    def rollback(self, _original: object) -> None:
        if self._source_changed and not self._committed:
            return
        if self._original is None:
            raise RuntimeError("Privacy Show Any migration source is unavailable.")
        self._store.replace_projections(copy.deepcopy(self._original))

    def finalize(self, _original: object) -> None:
        if self._original is not None and dict(self._store.read_projections()) == self._original:
            raise RuntimeError("Privacy Show Any legacy mirrors were not retired.")

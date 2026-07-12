"""Shared-singleton persistence for Prompt Enhancer credentials."""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping
from pathlib import Path

from helto_privacy import (
    MigrationVerification,
    SingletonSnapshot,
)
from helto_privacy.guard import require_current_authorization

from ..private_json import write_private_json
from .managed_privacy import (
    PROMPT_ENHANCER_PROFILE_ID,
    PROMPT_PROVIDER_SETTINGS_PLAINTEXT_BINDING_ID,
    PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
    PROMPT_PROVIDER_SETTINGS_WRAPPER_BINDING_ID,
)
from .provider_settings import env_hf_token, env_hf_token_available


_STORE_FORMAT = "helto.prompt-provider-settings.singleton-v1"
_STORE_FIELDS = {"format", "id", "revision", "protected"}


class PromptProviderSettingsStore:
    """Strict revisioned adapter; malformed or legacy data never defaults."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path)

    def read_singleton(self, singleton_id: str) -> SingletonSnapshot:
        _require_singleton(singleton_id)
        if not self.path.exists():
            return SingletonSnapshot(0)
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            raise ValueError("Provider settings persistence is invalid.") from None
        if (
            not isinstance(payload, Mapping)
            or set(payload) != _STORE_FIELDS
            or payload.get("format") != _STORE_FORMAT
            or payload.get("id") != PROMPT_PROVIDER_SETTINGS_SINGLETON_ID
        ):
            raise ValueError("Provider settings persistence is invalid.")
        try:
            return SingletonSnapshot(payload["revision"], payload["protected"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("Provider settings persistence is invalid.") from None

    def begin_singleton_replace(
        self,
        singleton_id: str,
        expected_revision: int,
        replacement: SingletonSnapshot,
    ) -> "_StoreTransaction":
        _require_singleton(singleton_id)
        return _StoreTransaction(self, expected_revision, replacement)

    def prepare_mode_transition(self, *_args) -> None:
        return None

    def commit_mode_transition(self, *_args) -> None:
        return None

    def rollback_mode_transition(self, *_args) -> None:
        return None

    def _write(self, snapshot: SingletonSnapshot) -> None:
        write_private_json(
            self.path,
            {
                "format": _STORE_FORMAT,
                "id": PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
                "revision": snapshot.revision,
                "protected": snapshot.protected,
            },
        )


class _StoreTransaction:
    def __init__(
        self,
        store: PromptProviderSettingsStore,
        expected_revision: int,
        replacement: SingletonSnapshot,
    ) -> None:
        self._store = store
        self._expected_revision = expected_revision
        self._replacement = replacement
        self._original_exists = store.path.exists()
        self._original_bytes = store.path.read_bytes() if self._original_exists else b""

    def commit(self) -> bool:
        if self._original_exists:
            if not self._store.path.exists() or self._store.path.read_bytes() != self._original_bytes:
                return False
        elif self._store.path.exists():
            return False
        current = self._store.read_singleton(PROMPT_PROVIDER_SETTINGS_SINGLETON_ID)
        if current.revision != self._expected_revision:
            return False
        self._store._write(self._replacement)
        return True

    def read_back(self) -> SingletonSnapshot:
        return self._store.read_singleton(PROMPT_PROVIDER_SETTINGS_SINGLETON_ID)

    def rollback(self) -> None:
        _restore_bytes(
            self._store.path,
            self._original_exists,
            self._original_bytes,
        )


class PromptProviderSettingsService:
    """Product status/update/dispatch semantics over the opaque singleton."""

    SAFE_STATUS_FIELDS = ("tokenConfigured", "envTokenAvailable", "authSource")

    def __init__(
        self,
        handle: object,
        *,
        environment_token: Callable[[], str] = env_hf_token,
        environment_token_available: Callable[[], bool] = env_hf_token_available,
    ) -> None:
        if not callable(environment_token) or not callable(environment_token_available):
            raise TypeError("Provider environment-token adapters are required.")
        self._handle = handle
        self._environment_token = environment_token
        self._environment_token_available = environment_token_available

    def status(self) -> dict[str, object]:
        configured = self._handle.status(
            PROMPT_PROVIDER_SETTINGS_SINGLETON_ID
        ).exists
        env_available = self._environment_token_available() is True
        return {
            "ok": True,
            "tokenConfigured": configured,
            "envTokenAvailable": env_available,
            "authSource": (
                "configured"
                if configured
                else "environment"
                if env_available
                else "anonymous"
            ),
        }

    def replace(self, token: object, expected_revision: int, authorization: object):
        if not isinstance(token, str):
            raise ValueError("Provider credential must be text.")
        normalized = token.strip()
        if not normalized:
            return self.delete(expected_revision, authorization)
        return self._handle.replace_field(
            PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
            {"hf_token": normalized},
            expected_revision,
            authorization,
        )

    def delete(self, expected_revision: int, authorization: object):
        return self._handle.delete(
            PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
            expected_revision,
            authorization,
        )

    def dispatch(self, authorization: object, callback: Callable[[str | None], object]):
        if not callable(callback):
            raise TypeError("A provider dispatch callback is required.")
        require_current_authorization(
            authorization,
            "singleton.reveal",
            pack_id=PROMPT_ENHANCER_PROFILE_ID,
        )
        status = self._handle.status(PROMPT_PROVIDER_SETTINGS_SINGLETON_ID)
        token: str | None
        if status.exists:
            revealed = self._handle.reveal_field(
                PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
                authorization,
            )
            value = revealed.value
            if (
                not isinstance(value, Mapping)
                or set(value) != {"hf_token"}
                or not isinstance(value.get("hf_token"), str)
                or not value.get("hf_token").strip()
            ):
                raise ValueError("Provider credential payload is invalid.")
            token = value["hf_token"].strip()
        else:
            token = str(self._environment_token() or "").strip() or None
        try:
            return callback(token)
        finally:
            token = None


class PromptProviderCredentialDispatchAdapter:
    """Inject a revealed credential into existing provider calls only in scope."""

    def __init__(self, settings: PromptProviderSettingsService, registry: object) -> None:
        generate = getattr(registry, "generate_with_auth", None)
        if not callable(generate):
            raise TypeError("A credential-aware provider registry is required.")
        self._settings = settings
        self._registry = registry

    def generate(
        self,
        request: object,
        progress: object,
        authorization: object,
    ) -> object:
        return self._settings.dispatch(
            authorization,
            lambda auth_token: self._registry.generate_with_auth(
                request,
                auth_token,
                progress,
            ),
        )

    def generate_visual_context(
        self,
        request: object,
        progress: object,
        authorization: object,
    ) -> object:
        generate = getattr(self._registry, "generate_visual_context_with_auth", None)
        if not callable(generate):
            raise TypeError("A credential-aware visual provider registry is required.")
        return self._settings.dispatch(
            authorization,
            lambda auth_token: generate(request, auth_token, progress),
        )

    def download(self, alias: str, authorization: object) -> object:
        from .local_provider import download_local_model

        return self._settings.dispatch(
            authorization,
            lambda auth_token: download_local_model(alias, auth_token=auth_token),
        )


class PromptProviderSettingsMigrationCoordinator:
    """Rewrite either exact legacy wrapper only after shared read verification."""

    def __init__(
        self,
        migration_handle: object,
        singleton_handle: object,
        store: PromptProviderSettingsStore,
    ) -> None:
        self._migration = migration_handle
        self._singletons = singleton_handle
        self._store = store

    def migrate(
        self,
        read_authorization: object,
        complete_authorization: object,
        protect_authorization: object,
        reveal_authorization: object,
    ):
        try:
            source = json.loads(self._store.path.read_text(encoding="utf-8"))
        except Exception:
            raise ValueError("Provider migration source is invalid.") from None
        binding_id = (
            PROMPT_PROVIDER_SETTINGS_PLAINTEXT_BINDING_ID
            if isinstance(source, Mapping) and source.get("version") == 1
            else PROMPT_PROVIDER_SETTINGS_WRAPPER_BINDING_ID
        )
        discovered = self._migration.discover_and_read(
            binding_id,
            source,
            read_authorization,
        )
        if not isinstance(discovered.value, Mapping):
            raise ValueError("Provider migration value is invalid.")
        normalized = dict(discovered.value)
        transaction = _ProviderSettingsMigrationTransaction(
            self._singletons,
            self._store,
            protect_authorization,
            reveal_authorization,
        )
        return self._migration.complete(
            discovered.obligation.id,
            normalized,
            transaction,
            complete_authorization,
        )


class _ProviderSettingsMigrationTransaction:
    def __init__(
        self,
        singleton_handle: object,
        store: PromptProviderSettingsStore,
        protect_authorization: object,
        reveal_authorization: object,
    ) -> None:
        if not store.path.is_file():
            raise ValueError("Provider migration source is missing.")
        self._singletons = singleton_handle
        self._store = store
        self._protect_authorization = protect_authorization
        self._reveal_authorization = reveal_authorization
        self._original = store.path.read_bytes()
        self._expected: dict[str, str] | None = None
        self._replacement: SingletonSnapshot | None = None

    def capture_original(self) -> bytes:
        return bytes(self._original)

    def stage_current(self, normalized: object) -> None:
        value = dict(normalized) if isinstance(normalized, Mapping) else {}
        if (
            set(value) != {"hf_token"}
            or not isinstance(value.get("hf_token"), str)
            or not value.get("hf_token").strip()
        ):
            raise ValueError("Provider migration value is invalid.")
        self._expected = {"hf_token": value["hf_token"].strip()}
        protected = self._singletons.protect_field(
            PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
            self._expected,
            self._protect_authorization,
        )
        self._replacement = SingletonSnapshot(1, protected.protected)

    def stage_durable_adjuncts(self, _normalized: object) -> None:
        return None

    def commit(self) -> None:
        if self._replacement is None or self._store.path.read_bytes() != self._original:
            raise RuntimeError("Provider migration source changed.")
        self._store._write(self._replacement)

    def read_back(self) -> MigrationVerification:
        snapshot = self._store.read_singleton(PROMPT_PROVIDER_SETTINGS_SINGLETON_ID)
        value = self._singletons.reveal_field(
            PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
            self._reveal_authorization,
        ).value
        return MigrationVerification(
            normalized=value,
            current_format=(
                self._replacement is not None
                and snapshot.revision == self._replacement.revision
                and snapshot.protected == self._replacement.protected
            ),
            durable_artifacts_current=True,
        )

    def rollback(self, _original: object) -> None:
        _restore_bytes(self._store.path, True, self._original)

    def finalize(self, _original: object) -> None:
        if self._store.path.read_bytes() == self._original:
            raise RuntimeError("Provider migration source was not retired.")


def _require_singleton(singleton_id: str) -> None:
    if singleton_id != PROMPT_PROVIDER_SETTINGS_SINGLETON_ID:
        raise ValueError("Unknown provider settings singleton.")


def _restore_bytes(path: Path, existed: bool, value: bytes) -> None:
    if not existed:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".rollback")
    temporary.write_bytes(value)
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    temporary.replace(path)

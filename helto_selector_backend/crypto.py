from __future__ import annotations

import sys
import tempfile
import types
from typing import Any

def _install_folder_paths_stub() -> None:
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_temp_directory = tempfile.gettempdir
    sys.modules["folder_paths"] = folder_paths


def _import_shared_privacy():
    try:
        try:
            from ..shared import privacy
        except ImportError as exc:
            if str(exc) != "attempted relative import beyond top-level package":
                raise
            from shared import privacy
    except ModuleNotFoundError as exc:
        if exc.name != "folder_paths":
            raise
        _install_folder_paths_stub()
        try:
            from ..shared import privacy
        except ImportError as fallback_exc:
            if str(fallback_exc) != "attempted relative import beyond top-level package":
                raise
            from shared import privacy
    return privacy


shared_privacy = _import_shared_privacy()
_UNSUPPORTED_LEGACY_PREFIX = "__HELTO_ENC__:"


def encrypt_bytes(plaintext: bytes, *, purpose: str) -> bytes:
    return shared_privacy.encrypt_bytes(plaintext, purpose=purpose)


def decrypt_bytes(ciphertext: bytes, *, purpose: str) -> bytes:
    return shared_privacy.decrypt_bytes(ciphertext, purpose=purpose)


def _reject_legacy_payload(value: Any) -> None:
    if isinstance(value, str) and value.startswith(_UNSUPPORTED_LEGACY_PREFIX):
        raise ValueError("Legacy Helto selector encrypted payloads are no longer supported.")


def encrypt_selection(plain_json: str) -> str:
    return shared_privacy.encrypt_state_string({"data": str(plain_json or "")})


def decrypt_selection(encrypted_text: Any) -> str:
    _reject_legacy_payload(encrypted_text)
    if not shared_privacy.is_encrypted_state(encrypted_text):
        return str(encrypted_text or "")
    try:
        state = shared_privacy.decrypt_state_string(encrypted_text)
    except Exception as e:
        print(f"[HeltoSelector] Error decrypting selection state: {e}")
        raise ValueError(
            "Failed to decrypt Helto selector state; the data may be corrupt "
            "or the privacy keystore is locked."
        ) from e
    return str(state.get("data") or "")

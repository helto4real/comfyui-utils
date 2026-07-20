from __future__ import annotations

import json
import mimetypes
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Mapping

import folder_paths
from helto_privacy import (
    PrivacyEnvelopeCodec,
    PrivacyError,
    PrivacyKeystoreError,
    keystore_exists,
    keystore_status,
    primary_session_key,
    session_key_for,
)


PACKAGE_DIR = Path(__file__).resolve().parents[1]
CONFIG_DIR = PACKAGE_DIR / "config"

SCHEMA = "helto.comfyui-utils"
DEFAULT_BYTE_PURPOSE = "private-media"
PRIVATE_MEDIA_PURPOSE = "private-media"
PRIVATE_MEDIA_TOKEN_PURPOSE = "private-media-token"
QUEUE_MANAGER_PURPOSE = "queue-manager-state"
SELECTOR_MASK_PURPOSE = "selector-mask"
SELECTOR_THUMBNAIL_PURPOSE = "selector-thumbnail"
LOAD_VIDEO_CACHE_PURPOSE = "load-video-cache"
SAVE_VIDEO_REPLAY_PURPOSE = "save-video-replay"
TOKEN_VERSION = 1
MEDIA_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60


class _StrictKeystoreProvider:
    """Keystore adapter that forbids PrivacyEnvelopeCodec's key-file fallback."""

    @staticmethod
    def keystore_exists() -> bool:
        return True

    @staticmethod
    def keystore_status() -> dict[str, Any]:
        return keystore_status()

    @staticmethod
    def primary_session_key() -> tuple[bytes, str]:
        return primary_session_key()

    @staticmethod
    def session_key_for(key_id: str) -> bytes | None:
        return session_key_for(key_id)


CODEC = PrivacyEnvelopeCodec(SCHEMA, key_provider=_StrictKeystoreProvider())


def ensure_privacy_dirs() -> None:
    CONFIG_DIR.mkdir(exist_ok=True)
    _chmod_silent(CONFIG_DIR, 0o700)


def _chmod_silent(path: Path, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def privacy_status() -> dict[str, Any]:
    return CODEC.crypto_status()


def _compact_json(payload: Mapping[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def encrypted_state_to_string(payload: Mapping[str, Any]) -> str:
    return _compact_json(payload)


def encrypted_bytes_to_bytes(payload: Mapping[str, Any]) -> bytes:
    return _compact_json(payload).encode("utf-8")


def parse_envelope(value: Any) -> Any:
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PrivacyError("Encrypted payload is not a UTF-8 privacy envelope.") from exc
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError as exc:
            raise PrivacyError("Encrypted payload is not a JSON privacy envelope.") from exc
    return value


def is_encrypted_state(value: Any) -> bool:
    try:
        return CODEC.is_encrypted_payload(parse_envelope(value))
    except Exception:
        return False


def encrypt_state(state: Mapping[str, Any]) -> dict[str, Any]:
    return CODEC.encrypt_state(state)


def decrypt_state(payload: Any) -> dict[str, Any]:
    return CODEC.decrypt_state(parse_envelope(payload))


def encrypt_state_string(state: Mapping[str, Any]) -> str:
    return encrypted_state_to_string(encrypt_state(state))


def decrypt_state_string(payload: Any) -> dict[str, Any]:
    return decrypt_state(payload)


def encrypt_bytes(data: bytes, purpose: str = DEFAULT_BYTE_PURPOSE) -> bytes:
    return encrypted_bytes_to_bytes(CODEC.encrypt_bytes(data, purpose=purpose))


def decrypt_bytes(payload: Any, purpose: str = DEFAULT_BYTE_PURPOSE) -> bytes:
    return CODEC.decrypt_bytes(parse_envelope(payload), purpose=purpose)


def sign_media_token(
    payload: dict[str, Any],
    *,
    ttl_seconds: int | None = MEDIA_TOKEN_TTL_SECONDS,
) -> str:
    payload = {"v": TOKEN_VERSION, **payload}
    if ttl_seconds is not None and "exp" not in payload:
        now = int(time.time())
        payload["iat"] = now
        payload["exp"] = now + int(ttl_seconds)
    return encrypt_state_string(payload)


def verify_media_token(token: str) -> dict[str, Any]:
    payload = decrypt_state_string(token)
    if payload.get("v") != TOKEN_VERSION:
        raise ValueError("Unsupported private media token version.")
    expiry = payload.get("exp")
    if expiry is not None and time.time() > float(expiry):
        raise ValueError("Private media token has expired.")
    return payload


def private_temp_dir(subfolder: str) -> Path:
    clean = "".join(char if char.isalnum() or char in "._-" else "_" for char in str(subfolder or "preview"))
    path = Path(folder_paths.get_temp_directory()) / "helto_private" / clean
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_encrypted_temp_bytes(
    data: bytes,
    suffix: str,
    subfolder: str,
    *,
    purpose: str = PRIVATE_MEDIA_PURPOSE,
) -> Path:
    suffix = suffix if suffix.startswith(".") else f".{suffix}"
    output_path = private_temp_dir(subfolder) / f"{uuid.uuid4().hex}{suffix}.enc"
    output_path.write_bytes(encrypt_bytes(data, purpose=purpose))
    return output_path


def write_encrypted_temp_file(
    path: str | os.PathLike[str],
    subfolder: str,
    *,
    purpose: str = PRIVATE_MEDIA_PURPOSE,
) -> Path:
    source_path = Path(path)
    return write_encrypted_temp_bytes(
        source_path.read_bytes(),
        source_path.suffix or ".bin",
        subfolder,
        purpose=purpose,
    )


def content_type_for_path(path: str | os.PathLike[str], fallback: str = "application/octet-stream") -> str:
    return mimetypes.guess_type(str(path))[0] or fallback


def private_media_record(
    path: str | os.PathLike[str],
    *,
    content_type: str | None = None,
    encrypted: bool = False,
    filename: str | None = None,
    purpose: str = PRIVATE_MEDIA_PURPOSE,
) -> dict[str, Any]:
    path = os.path.abspath(os.fspath(path))
    content_type = content_type or content_type_for_path(path)
    token = sign_media_token({
        "path": path,
        "content_type": content_type,
        "encrypted": bool(encrypted),
        "purpose": purpose,
    })
    return {
        "filename": filename or os.path.basename(path).removesuffix(".enc"),
        "subfolder": "",
        "type": "private",
        "private": True,
        "token": token,
        "content_type": content_type,
    }


def read_private_media_token(token: str) -> tuple[bytes, str, str]:
    payload = verify_media_token(token)
    path = os.path.abspath(str(payload.get("path") or ""))
    if not path:
        raise ValueError("Private media token has no path.")
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    data = Path(path).read_bytes()
    if payload.get("encrypted"):
        data = decrypt_bytes(data, purpose=str(payload.get("purpose") or PRIVATE_MEDIA_PURPOSE))
    return data, str(payload.get("content_type") or content_type_for_path(path)), os.path.basename(path).removesuffix(".enc")


def remove_plain_file_silent(path: str | os.PathLike[str]) -> None:
    try:
        file_path = Path(path)
        if file_path.is_file() or file_path.is_symlink():
            file_path.unlink()
    except Exception:
        pass


def cleanup_known_plaintext_artifacts() -> None:
    temp_dir = Path(folder_paths.get_temp_directory())
    for subfolder in ("helto_video_comparer", "helto_load_video", "helto_save_video_advanced"):
        shutil.rmtree(temp_dir / subfolder, ignore_errors=True)
    for file_path in temp_dir.glob("helto.compare.*"):
        remove_plain_file_silent(file_path)


def privacy_unavailable_error(exc: Exception) -> str:
    text = str(exc)
    if isinstance(exc, (PrivacyError, PrivacyKeystoreError)):
        return text
    if "PRIVACY_" in text:
        return text
    if not keystore_exists():
        return "PRIVACY_KEYSTORE_UNINITIALIZED: Privacy keystore has not been created yet."
    return "PRIVACY_LOCKED: Privacy keystore is locked. Unlock it with your privacy password."

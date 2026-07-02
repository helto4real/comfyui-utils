from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

import folder_paths

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception:
    AESGCM = None


PACKAGE_DIR = Path(__file__).resolve().parents[1]
CONFIG_DIR = PACKAGE_DIR / "config"
KEY_PATH = CONFIG_DIR / "privacy_key.bin"
ENC_MAGIC_V1 = b"HELTO_PRIV1:"
ENC_MAGIC_V2 = b"HELTO_PRIV2:"
ENC_MAGIC_V3 = b"HELTO_PRIV3:"
ENC_MAGIC = ENC_MAGIC_V1
TOKEN_VERSION = 1
# Signed private-media tokens grant read access to a file path, so cap their
# lifetime. Generous by default because previews may be reopened later, but no
# longer effectively permanent.
MEDIA_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60
AESGCM_MAX_BYTES = (2 ** 31) - 1
AESGCM_CHUNK_SIZE = 64 * 1024 * 1024


def ensure_privacy_dirs() -> None:
    CONFIG_DIR.mkdir(exist_ok=True)
    _chmod_silent(CONFIG_DIR, 0o700)


def _chmod_silent(path: Path, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def load_encryption_key() -> bytes:
    ensure_privacy_dirs()
    if not KEY_PATH.exists():
        # O_EXCL + 0600 so the key is never world-readable and a concurrent
        # first run can't race two different keys into place.
        try:
            fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, secrets.token_bytes(32))
            finally:
                os.close(fd)
        except FileExistsError:
            pass
    key = KEY_PATH.read_bytes()
    if len(key) < 32:
        raise ValueError("Helto privacy key is invalid.")
    _chmod_silent(KEY_PATH, 0o600)
    return key[:32]


def _key() -> bytes:
    return load_encryption_key()


def _derive_keystream(key: bytes, iv: bytes, length: int) -> bytes:
    stream = bytearray()
    counter = 0
    while len(stream) < length:
        stream.extend(hmac.new(key, iv + counter.to_bytes(4, "big"), hashlib.sha256).digest())
        counter += 1
    return bytes(stream[:length])


def _encrypt_bytes_v1(plaintext: bytes, key: bytes) -> bytes:
    iv = secrets.token_bytes(16)
    stream = _derive_keystream(key, iv, len(plaintext))
    ciphertext = bytes(a ^ b for a, b in zip(plaintext, stream))
    tag = hmac.new(key, ENC_MAGIC_V1 + iv + ciphertext, hashlib.sha256).digest()
    return ENC_MAGIC_V1 + iv + ciphertext + tag


def _decrypt_bytes_v1(encrypted: bytes, key: bytes) -> bytes:
    payload = encrypted[len(ENC_MAGIC_V1):]
    if len(payload) < 48:
        raise ValueError("Encrypted payload is too short.")
    iv = payload[:16]
    tag = payload[-32:]
    ciphertext = payload[16:-32]
    expected = hmac.new(key, ENC_MAGIC_V1 + iv + ciphertext, hashlib.sha256).digest()
    if not hmac.compare_digest(tag, expected):
        raise ValueError("Encrypted payload failed authentication.")
    stream = _derive_keystream(key, iv, len(ciphertext))
    return bytes(a ^ b for a, b in zip(ciphertext, stream))


def _encrypt_bytes_v2(plaintext: bytes, key: bytes) -> bytes:
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, ENC_MAGIC_V2)
    return ENC_MAGIC_V2 + nonce + ciphertext


def _decrypt_bytes_v2(encrypted: bytes, key: bytes) -> bytes:
    if AESGCM is None:
        raise ValueError("Fast encrypted payload requires the cryptography package.")
    payload = encrypted[len(ENC_MAGIC_V2):]
    if len(payload) < 28:
        raise ValueError("Encrypted payload is too short.")
    nonce = payload[:12]
    ciphertext = payload[12:]
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, ENC_MAGIC_V2)
    except Exception as exc:
        raise ValueError("Encrypted payload failed authentication.") from exc


def _chunk_aad(header: bytes, counter: int) -> bytes:
    return ENC_MAGIC_V3 + header + counter.to_bytes(8, "big")


def _encrypt_bytes_v3(plaintext: bytes, key: bytes) -> bytes:
    chunk_size = int(AESGCM_CHUNK_SIZE)
    if chunk_size <= 0:
        raise ValueError("AES-GCM chunk size must be positive.")

    nonce_prefix = secrets.token_bytes(4)
    header = chunk_size.to_bytes(8, "big") + len(plaintext).to_bytes(8, "big") + nonce_prefix
    aesgcm = AESGCM(key)
    chunks = [ENC_MAGIC_V3, header]
    for counter, start in enumerate(range(0, len(plaintext), chunk_size)):
        chunk = plaintext[start:start + chunk_size]
        nonce = nonce_prefix + counter.to_bytes(8, "big")
        chunks.append(aesgcm.encrypt(nonce, chunk, _chunk_aad(header, counter)))
    return b"".join(chunks)


def _decrypt_bytes_v3(encrypted: bytes, key: bytes) -> bytes:
    if AESGCM is None:
        raise ValueError("Fast encrypted payload requires the cryptography package.")

    payload = encrypted[len(ENC_MAGIC_V3):]
    if len(payload) < 20:
        raise ValueError("Encrypted payload is too short.")

    header = payload[:20]
    chunk_size = int.from_bytes(header[:8], "big")
    total_length = int.from_bytes(header[8:16], "big")
    nonce_prefix = header[16:20]
    if chunk_size <= 0:
        raise ValueError("Encrypted payload has an invalid chunk size.")

    aesgcm = AESGCM(key)
    chunks = []
    offset = 20
    remaining = total_length
    counter = 0
    while remaining > 0:
        plaintext_length = min(chunk_size, remaining)
        ciphertext_length = plaintext_length + 16
        end = offset + ciphertext_length
        if end > len(payload):
            raise ValueError("Encrypted payload is truncated.")

        nonce = nonce_prefix + counter.to_bytes(8, "big")
        try:
            chunks.append(aesgcm.decrypt(nonce, payload[offset:end], _chunk_aad(header, counter)))
        except Exception as exc:
            raise ValueError("Encrypted payload failed authentication.") from exc

        offset = end
        remaining -= plaintext_length
        counter += 1

    if offset != len(payload):
        raise ValueError("Encrypted payload has trailing data.")
    return b"".join(chunks)


def encrypt_bytes(plaintext: bytes, key: bytes | None = None) -> bytes:
    key = key or _key()
    if AESGCM is not None:
        if len(plaintext) > AESGCM_MAX_BYTES:
            return _encrypt_bytes_v3(plaintext, key)
        return _encrypt_bytes_v2(plaintext, key)
    return _encrypt_bytes_v1(plaintext, key)


def decrypt_bytes(encrypted: bytes, key: bytes | None = None) -> bytes:
    key = key or _key()
    if encrypted.startswith(ENC_MAGIC_V3):
        return _decrypt_bytes_v3(encrypted, key)
    if encrypted.startswith(ENC_MAGIC_V2):
        return _decrypt_bytes_v2(encrypted, key)
    if encrypted.startswith(ENC_MAGIC_V1):
        return _decrypt_bytes_v1(encrypted, key)
    raise ValueError("Encrypted payload has an invalid header.")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64url(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode((data + padding).encode("ascii"))


def sign_media_token(
    payload: dict[str, Any],
    key: bytes | None = None,
    *,
    ttl_seconds: int | None = MEDIA_TOKEN_TTL_SECONDS,
) -> str:
    key = key or _key()
    payload = {"v": TOKEN_VERSION, **payload}
    if ttl_seconds is not None and "exp" not in payload:
        now = int(time.time())
        payload["iat"] = now
        payload["exp"] = now + int(ttl_seconds)
    payload_bytes = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(key, payload_bytes, hashlib.sha256).digest()
    return f"{_b64url(payload_bytes)}.{_b64url(signature)}"


def verify_media_token(token: str, key: bytes | None = None) -> dict[str, Any]:
    key = key or _key()
    try:
        payload_part, signature_part = str(token).split(".", 1)
        payload_bytes = _unb64url(payload_part)
        signature = _unb64url(signature_part)
    except Exception as exc:
        raise ValueError("Invalid private media token.") from exc

    expected = hmac.new(key, payload_bytes, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError("Invalid private media token signature.")

    payload = json.loads(payload_bytes.decode("utf-8"))
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


def write_encrypted_temp_bytes(data: bytes, suffix: str, subfolder: str) -> Path:
    suffix = suffix if suffix.startswith(".") else f".{suffix}"
    output_path = private_temp_dir(subfolder) / f"{uuid.uuid4().hex}{suffix}.enc"
    output_path.write_bytes(encrypt_bytes(data))
    return output_path


def write_encrypted_temp_file(path: str | os.PathLike[str], subfolder: str) -> Path:
    source_path = Path(path)
    return write_encrypted_temp_bytes(source_path.read_bytes(), source_path.suffix or ".bin", subfolder)


def content_type_for_path(path: str | os.PathLike[str], fallback: str = "application/octet-stream") -> str:
    return mimetypes.guess_type(str(path))[0] or fallback


def private_media_record(
    path: str | os.PathLike[str],
    *,
    content_type: str | None = None,
    encrypted: bool = False,
    filename: str | None = None,
) -> dict[str, Any]:
    path = os.path.abspath(os.fspath(path))
    content_type = content_type or content_type_for_path(path)
    token = sign_media_token({
        "path": path,
        "content_type": content_type,
        "encrypted": bool(encrypted),
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
        data = decrypt_bytes(data)
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

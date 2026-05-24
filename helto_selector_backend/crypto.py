from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets

from .constants import CONFIG_DIR, ENC_PREFIX, ensure_runtime_dirs

KEY_PATH = os.path.join(CONFIG_DIR, "key.bin")


def load_encryption_key() -> bytes:
    ensure_runtime_dirs()
    if not os.path.exists(KEY_PATH):
        with open(KEY_PATH, "wb") as f:
            f.write(secrets.token_bytes(32))

    with open(KEY_PATH, "rb") as f:
        return f.read()


ENCRYPTION_KEY = load_encryption_key()


def _derive_keystream(key: bytes, iv: bytes, length: int) -> bytes:
    keystream = bytearray()
    counter = 0
    while len(keystream) < length:
        h = hmac.new(key, iv + counter.to_bytes(4, "big"), hashlib.sha256)
        keystream.extend(h.digest())
        counter += 1
    return bytes(keystream[:length])


def encrypt_bytes(key: bytes, plaintext: bytes) -> bytes:
    iv = secrets.token_bytes(16)
    keystream = _derive_keystream(key, iv, len(plaintext))
    ciphertext = bytes(a ^ b for a, b in zip(plaintext, keystream))
    return iv + ciphertext


def decrypt_bytes(key: bytes, ciphertext: bytes) -> bytes:
    if len(ciphertext) < 16:
        raise ValueError("Ciphertext too short")
    iv = ciphertext[:16]
    encrypted = ciphertext[16:]
    keystream = _derive_keystream(key, iv, len(encrypted))
    return bytes(a ^ b for a, b in zip(encrypted, keystream))


def encrypt_string(key: bytes, text: str) -> str:
    encrypted = encrypt_bytes(key, text.encode("utf-8"))
    return base64.b64encode(encrypted).decode("utf-8")


def decrypt_string(key: bytes, encrypted_b64: str) -> str:
    encrypted = base64.b64decode(encrypted_b64.encode("utf-8"))
    decrypted = decrypt_bytes(key, encrypted)
    return decrypted.decode("utf-8")


def encrypt_selection(plain_json: str, key: bytes = ENCRYPTION_KEY) -> str:
    return ENC_PREFIX + encrypt_string(key, plain_json)


def decrypt_selection(encrypted_text: str, key: bytes = ENCRYPTION_KEY) -> str:
    if not encrypted_text.startswith(ENC_PREFIX):
        return encrypted_text
    encrypted_part = encrypted_text[len(ENC_PREFIX):]
    try:
        return decrypt_string(key, encrypted_part)
    except Exception as e:
        print(f"[HeltoSelector] Error decrypting selection state: {e}")
        return "[]"


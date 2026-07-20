from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ..private_json import write_private_json
from ..privacy import decrypt_state_string, encrypt_state_string


CONFIG_DIR = Path(__file__).resolve().parents[2] / "config" / "prompt enhancer"
PROVIDER_SETTINGS_FILE = CONFIG_DIR / "provider_settings.json"
PROVIDER_SETTINGS_VERSION = 2


def settings_path(base_dir: str | os.PathLike[str] | None = None) -> Path:
    return Path(base_dir) / PROVIDER_SETTINGS_FILE.name if base_dir is not None else PROVIDER_SETTINGS_FILE


def load_provider_settings(base_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    path = settings_path(base_dir)
    if not path.exists():
        return _empty_settings()
    try:
        payload = json.loads(path.read_text(encoding="utf-8") or "{}")
    except Exception:
        return _empty_settings()

    encrypted = payload.get("hf_token_encrypted")
    if encrypted:
        try:
            token = str(decrypt_state_string(encrypted).get("hf_token") or "")
        except Exception:
            token = ""
        return {"version": PROVIDER_SETTINGS_VERSION, "hf_token": token}

    legacy_token = str(payload.get("hf_token") or "").strip()
    if legacy_token:
        try:
            write_private_json(path, _encrypted_hf_token_payload(legacy_token))
            return {"version": PROVIDER_SETTINGS_VERSION, "hf_token": legacy_token}
        except Exception:
            return _empty_settings()
    return _empty_settings()


def save_hf_token(token: str, base_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    token = str(token or "").strip()
    if not token:
        return clear_hf_token(base_dir)
    write_private_json(settings_path(base_dir), _encrypted_hf_token_payload(token))
    return provider_settings_status(base_dir)


def clear_hf_token(base_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    settings_path(base_dir).unlink(missing_ok=True)
    return provider_settings_status(base_dir)


def env_hf_token() -> str:
    return str(os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN") or "").strip()


def configured_hf_token(base_dir: str | os.PathLike[str] | None = None) -> str:
    return str(load_provider_settings(base_dir).get("hf_token") or "").strip()


def hf_auth_token(base_dir: str | os.PathLike[str] | None = None) -> str | None:
    return configured_hf_token(base_dir) or env_hf_token() or None


def provider_settings_status(base_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    configured = bool(configured_hf_token(base_dir))
    env_available = bool(env_hf_token())
    auth_source = "configured" if configured else "environment" if env_available else "anonymous"
    return {
        "ok": True,
        "tokenConfigured": configured,
        "envTokenAvailable": env_available,
        "authSource": auth_source,
    }


def _empty_settings() -> dict[str, Any]:
    return {"version": PROVIDER_SETTINGS_VERSION, "hf_token": ""}


def _encrypted_hf_token_payload(token: str) -> dict[str, Any]:
    return {
        "version": PROVIDER_SETTINGS_VERSION,
        "hf_token_encrypted": encrypt_state_string({"hf_token": token}),
    }

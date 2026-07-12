"""Environment-only provider credential facts.

Persisted credentials are owned exclusively by the managed singleton in
``managed_provider_settings``.
"""

from __future__ import annotations

import os


def env_hf_token() -> str:
    return str(os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip()


def env_hf_token_available() -> bool:
    return bool(env_hf_token())

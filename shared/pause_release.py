from __future__ import annotations

import hmac
import secrets
import time
from collections.abc import Callable, Mapping
from typing import Any

RELEASE_TTL_SECONDS = 5 * 60


def request_pause_release(
    state: dict[str, dict[str, Any]],
    node_id: str,
    revision: Any,
    *,
    media_label: str,
    is_available: Callable[[dict[str, Any]], bool] | None = None,
) -> dict[str, Any]:
    stored = state["media"].get(node_id)
    if stored is None or (is_available is not None and not is_available(stored)):
        return {
            "ok": False,
            "error": f"No stored {media_label} is available for this node.",
            "status": 404,
        }

    current_revision = int(stored.get("revision", 0))
    if revision is not None and _revision(revision) != current_revision:
        return {
            "ok": False,
            "error": f"Stored {media_label} revision is no longer current.",
            "revision": current_revision,
            "status": 409,
        }

    existing = state["releases"].get(node_id)
    now = time.time()
    if (
        existing is not None
        and _revision(existing.get("revision")) == current_revision
        and float(existing.get("expires_at", 0)) > now
        and existing.get("token")
    ):
        release_token = str(existing["token"])
    else:
        release_token = secrets.token_urlsafe(32)
        state["releases"][node_id] = {
            "revision": current_revision,
            "token": release_token,
            "expires_at": now + RELEASE_TTL_SECONDS,
        }
    return {
        "ok": True,
        "has_media": True,
        "revision": current_revision,
        "paused": bool(stored.get("paused", False)),
        "release_token": release_token,
    }


def consume_pause_release(
    state: dict[str, dict[str, Any]],
    node_id: str,
    release_token: Any,
) -> dict[str, Any] | None:
    if not release_token:
        return None
    release = state["releases"].get(node_id)
    stored = state["media"].get(node_id)
    if release is None or stored is None:
        return None
    if float(release.get("expires_at", 0)) <= time.time():
        state["releases"].pop(node_id, None)
        return None
    if not hmac.compare_digest(str(release.get("token") or ""), str(release_token)):
        return None
    state["releases"].pop(node_id, None)
    if _revision(release.get("revision")) != int(stored.get("revision", 0)):
        return None
    return release


def cancel_pause_release(
    state: dict[str, dict[str, Any]],
    node_id: str,
    revision: Any,
    release_token: Any = None,
) -> dict[str, Any]:
    release = state["releases"].get(node_id)
    if release is None:
        return {"ok": True, "cancelled": False}
    if revision is not None and _revision(revision) != _revision(release.get("revision")):
        return {"ok": False, "error": "Release revision is no longer current.", "status": 409}
    if release_token and not hmac.compare_digest(str(release.get("token") or ""), str(release_token)):
        return {"ok": False, "error": "Release token is no longer current.", "status": 409}
    state["releases"].pop(node_id, None)
    return {"ok": True, "cancelled": True}


def dispatch_pause_release(owner: Any, data: Mapping[str, Any]) -> tuple[dict[str, Any], int]:
    node_id = str(data.get("node_id", ""))
    if data.get("action") == "cancel":
        result = owner.cancel_release(node_id, data.get("revision"), data.get("release_token"))
    else:
        result = owner.request_release(node_id, data.get("revision"))
    result = dict(result)
    return result, int(result.pop("status", 200))


def _revision(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None

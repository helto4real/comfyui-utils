"""Typed HTTP placement for the complete Utils privacy profile."""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from aiohttp import web
from helto_privacy import PrivacyRouteError

from .managed_privacy import (
    utils_privacy_adapter,
    utils_media_artifacts,
    utils_privacy_pack,
    utils_selector_artifacts,
)
from .privacy_show_any_managed import (
    PRIVACY_SHOW_ANY_OPERATION_ADAPTER_ID,
    PrivacyShowAnyProtectedOperations,
)
from .private_media_managed import (
    PRIVATE_MEDIA_SCOPE_ID,
    PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID,
    PRIVATE_MEDIA_PRODUCT_OPERATION_IDS,
    PRIVATE_MEDIA_SOURCE_OPERATION_ADAPTER_ID,
    MEDIA_NODE_MODE_SCOPES,
)
from .prompt_enhancer.managed_privacy import (
    PROMPT_ENHANCER_SCOPE_ID,
    PROMPT_PROVIDER_OPERATION_ADAPTER_ID,
    PROMPT_PROVIDER_OPERATION_IDS,
    PROMPT_PROVIDER_SETTINGS_RESOURCE_ID,
    PROMPT_PROVIDER_SETTINGS_SINGLETON_ID,
    PROMPT_PROVIDER_SETTINGS_STORE_ADAPTER_ID,
)
from .prompt_enhancer.managed_provider_settings import (
    PromptProviderSettingsMigrationCoordinator,
    PromptProviderSettingsService,
)
from .queue_manager_managed import (
    QUEUE_OPERATION_ADAPTER_IDS,
    QUEUE_SCOPE_ID,
    QUEUE_SINGLETON_ID,
    QUEUE_SINGLETON_RESOURCE_ID,
    QUEUE_STORE_ADAPTER_ID,
    QueueManagerStateService,
)
from .queue_manager_managed_migration import QueueManagerMigrationCoordinator

try:
    from ..helto_selector_backend.managed_workflow import (
        SELECTOR_OPERATION_ADAPTER_ID,
        SELECTOR_SCOPE_ID,
        SelectorProtectedOperations,
    )
except ImportError as exc:
    if str(exc) != "attempted relative import beyond top-level package":
        raise
    from helto_selector_backend.managed_workflow import (
        SELECTOR_OPERATION_ADAPTER_ID,
        SELECTOR_SCOPE_ID,
        SelectorProtectedOperations,
    )


_REGISTERED = False


@dataclass(frozen=True, slots=True)
class _QueueRouteContext:
    request: object
    operation_authorization: object

    def invoke_queue_operation(self, operation_id: str, payload: object) -> object:
        pack = utils_privacy_pack()
        _ensure_queue_store_current(pack, self.request)
        service = QueueManagerStateService(
            pack.singletons(QUEUE_SINGLETON_RESOURCE_ID)
        )
        if operation_id == "queue-manager.load":
            return service.load(
                pack.authorization.authorize_request(self.request, "singleton.reveal")
            )
        if operation_id == "queue-manager.save":
            if not isinstance(payload, Mapping) or not isinstance(payload.get("state"), Mapping):
                raise ValueError("Queue Manager state payload is invalid.")
            result = service.save(
                payload["state"],
                int(payload.get("expectedRevision", -1)),
                pack.authorization.authorize_request(self.request, "singleton.reveal"),
                pack.authorization.authorize_request(self.request, "singleton.replace"),
            )
            return {**result, "state": payload["state"]}
        return {"ok": True, "operation": operation_id}


@dataclass(frozen=True, slots=True)
class _PromptProviderRouteContext:
    operation_id: str
    request: object

    def invoke_prompt_provider_operation(self, payload: object) -> object:
        pack = utils_privacy_pack()
        _ensure_provider_store_current(pack, self.request)
        handle = pack.singletons(PROMPT_PROVIDER_SETTINGS_RESOURCE_ID)
        service = PromptProviderSettingsService(handle)
        data = dict(payload) if isinstance(payload, Mapping) else {}
        if self.operation_id == "prompt-provider.settings-load":
            return {
                **service.status(),
                "revision": handle.status(PROMPT_PROVIDER_SETTINGS_SINGLETON_ID).revision,
            }
        if self.operation_id == "prompt-provider.settings-save":
            authorization = pack.authorization.authorize_request(
                self.request,
                "singleton.delete" if data.get("clear") else "singleton.replace",
            )
            receipt = (
                service.delete(int(data.get("expectedRevision", -1)), authorization)
                if data.get("clear")
                else service.replace(
                    data.get("hf_token", ""),
                    int(data.get("expectedRevision", -1)),
                    authorization,
                )
            )
            return {**service.status(), "revision": receipt.revision}
        if self.operation_id == "prompt-provider.model-download":
            from .prompt_enhancer.local_provider import download_local_model

            authorization = pack.authorization.authorize_request(
                self.request,
                "singleton.reveal",
            )
            return service.dispatch(
                authorization,
                lambda token: download_local_model(
                    data.get("model_id") or data.get("model"),
                    auth_token=token,
                ),
            )
        if self.operation_id == "prompt-provider.model-unload":
            from .prompt_enhancer.local_provider import unload_local_model

            return unload_local_model(data.get("model_id") or data.get("model") or None)
        raise ValueError("Unknown prompt provider operation.")


def _migration_authorizations(pack: object, request: object) -> tuple[object, object]:
    return (
        pack.authorization.authorize_request(request, "migration.read"),
        pack.authorization.authorize_request(request, "migration.complete"),
    )


def _ensure_provider_store_current(pack: object, request: object) -> None:
    store = utils_privacy_adapter(PROMPT_PROVIDER_SETTINGS_STORE_ADAPTER_ID)
    try:
        store.read_singleton(PROMPT_PROVIDER_SETTINGS_SINGLETON_ID)
        return
    except ValueError:
        pass
    read, complete = _migration_authorizations(pack, request)
    PromptProviderSettingsMigrationCoordinator(
        pack.migration,
        pack.singletons(PROMPT_PROVIDER_SETTINGS_RESOURCE_ID),
        store,
    ).migrate(
        read,
        complete,
        pack.authorization.authorize_request(request, "singleton.replace"),
        pack.authorization.authorize_request(request, "singleton.reveal"),
    )


def _ensure_queue_store_current(pack: object, request: object) -> None:
    store = utils_privacy_adapter(QUEUE_STORE_ADAPTER_ID)
    store_error = False
    try:
        snapshot = store.read_singleton(QUEUE_SINGLETON_ID)
    except ValueError:
        snapshot = None
        store_error = True
    json_source = store.path.with_suffix(".json")
    if not store_error and getattr(snapshot, "revision", 0) > 0:
        return
    candidates = []
    if store_error and store.path.is_file():
        candidates.append(("sqlite", store.path))
    if json_source.is_file():
        candidates.append(("json", json_source))
    if not candidates:
        if store_error:
            raise ValueError("Queue Manager persistence is invalid.")
        return
    if len(candidates) != 1:
        raise ValueError("Queue Manager legacy persistence is ambiguous.")
    container, source = candidates[0]
    read, complete = _migration_authorizations(pack, request)
    coordinator = QueueManagerMigrationCoordinator(
        pack.migration,
        pack.singletons(QUEUE_SINGLETON_RESOURCE_ID),
        store,
    )
    migrate = coordinator.migrate_json if container == "json" else coordinator.migrate_sqlite
    for generation in ("current", "priv3", "priv2", "priv1"):
        try:
            migrate(
                source,
                generation=generation,
                read_authorization=read,
                complete_authorization=complete,
                protect_authorization=pack.authorization.authorize_request(
                    request,
                    "singleton.replace",
                ),
                reveal_authorization=pack.authorization.authorize_request(
                    request,
                    "singleton.reveal",
                ),
            )
            return
        except ValueError:
            continue
    raise ValueError("Queue Manager legacy persistence is unsupported.")


@dataclass(frozen=True, slots=True)
class _PrivateMediaRouteContext:
    operation_id: str

    async def invoke_private_media_operation(self, payload: object) -> object:
        data = dict(payload) if isinstance(payload, Mapping) else {}
        if self.operation_id.startswith("load-video."):
            try:
                from ..nodes.load_video.video_config import (
                    add_folder,
                    folder_by_alias,
                    load_folders,
                    remove_folder,
                    resolve_video_path,
                )
                from ..nodes.load_video.video_io import list_videos, managed_thumbnail
            except ImportError as exc:
                if str(exc) != "attempted relative import beyond top-level package":
                    raise
                from nodes.load_video.video_config import (
                    add_folder,
                    folder_by_alias,
                    load_folders,
                    remove_folder,
                    resolve_video_path,
                )
                from nodes.load_video.video_io import list_videos, managed_thumbnail

            def folders():
                return [
                    {
                        "alias": item.alias,
                        "enabled": item.enabled,
                        "exists": Path(item.path).is_dir(),
                        "video_count": len(list_videos(item.path)) if Path(item.path).is_dir() else 0,
                    }
                    for item in load_folders()
                ]

            if self.operation_id == "load-video.folders-load":
                return {"folders": folders()}
            if self.operation_id == "load-video.folder-save":
                add_folder(data.get("alias"), data.get("path"))
                return {"status": "ok", "folders": folders()}
            if self.operation_id == "load-video.folder-delete":
                remove_folder(str(data.get("alias") or "input"))
                return {"status": "ok", "folders": folders()}
            alias = str(data.get("alias") or "input")
            if self.operation_id == "load-video.videos-load":
                folder = folder_by_alias(alias)
                return {
                    "videos": list_videos(
                        folder.path,
                        recursive=data.get("recursive") is not False,
                    ) if Path(folder.path).is_dir() else [],
                }
            if self.operation_id == "load-video.thumbnail":
                path = resolve_video_path(alias, str(data.get("filename") or ""))
                record, _encoded = await managed_thumbnail(
                    path,
                    utils_media_artifacts(),
                )
                return record.to_record()
        if self.operation_id in {"save-image.release", "save-video.release"}:
            from .pause_release import dispatch_pause_release
            try:
                if self.operation_id == "save-image.release":
                    from ..nodes.save_image_advanced import SaveImageAdvanced as node
                else:
                    from ..nodes.save_video_advanced import SaveVideoAdvanced as node
            except ImportError as exc:
                if str(exc) != "attempted relative import beyond top-level package":
                    raise
                if self.operation_id == "save-image.release":
                    from nodes.save_image_advanced import SaveImageAdvanced as node
                else:
                    from nodes.save_video_advanced import SaveVideoAdvanced as node
            result, status = dispatch_pause_release(node, data)
            if status >= 400:
                raise ValueError("Pause release request was rejected.")
            return result
        raise ValueError("Unknown private media operation.")


def register_managed_privacy_routes(prompt_server=None) -> None:
    """Register each declared product route once after atomic pack install."""

    global _REGISTERED
    if _REGISTERED:
        return
    if prompt_server is None:
        from server import PromptServer

        prompt_server = PromptServer.instance
    routes = prompt_server.routes
    profile = utils_privacy_pack().profile
    for declaration in profile.protected_operations:
        handler = _handler_for(declaration.id)
        getattr(routes, declaration.method.lower())(declaration.route)(handler)
    _REGISTERED = True


def _handler_for(operation_id: str):
    async def handler(request):
        try:
            payload = await _request_payload(request)
            result = await _dispatch(operation_id, request, payload)
            return _response(operation_id, result)
        except PrivacyRouteError as exc:
            return web.json_response({"ok": False, "error": exc.code}, status=exc.http_status)
        except (TypeError, ValueError):
            return web.json_response(
                {"ok": False, "error": "PRIVACY_OPERATION_INPUT_INVALID"},
                status=400,
            )
        except Exception:
            return web.json_response(
                {"ok": False, "error": "PRIVACY_OPERATION_FAILED"},
                status=500,
            )

    handler.__name__ = "managed_" + operation_id.replace(".", "_").replace("-", "_")
    return handler


async def _dispatch(operation_id: str, request: object, payload: object) -> object:
    pack = utils_privacy_pack()
    if operation_id.startswith("selector."):
        operations = SelectorProtectedOperations(
            pack.authorization,
            pack.workflow("selector-workflow"),
            utils_selector_artifacts(),
            utils_privacy_adapter(SELECTOR_OPERATION_ADAPTER_ID),
            pack.migration,
        )
        return await operations.dispatch(request, operation_id, payload)
    if operation_id == "serve-source-media":
        adapter = utils_privacy_adapter(PRIVATE_MEDIA_SOURCE_OPERATION_ADAPTER_ID)

        async def invoke(authorization):
            result = adapter.invoke(payload, authorization)
            return await result if inspect.isawaitable(result) else result

        return await pack.authorization.dispatch(
            request,
            PRIVATE_MEDIA_SCOPE_ID,
            operation_id,
            invoke,
        )
    if operation_id in PRIVATE_MEDIA_PRODUCT_OPERATION_IDS:
        adapter = utils_privacy_adapter(PRIVATE_MEDIA_PRODUCT_OPERATION_ADAPTER_ID)

        async def invoke(_authorization):
            result = adapter.invoke(payload, _PrivateMediaRouteContext(operation_id))
            return await result if inspect.isawaitable(result) else result

        scope_id = (
            MEDIA_NODE_MODE_SCOPES["HeltoSaveImageAdvanced"]
            if operation_id == "save-image.release"
            else MEDIA_NODE_MODE_SCOPES["HeltoSaveVideoAdvanced"]
            if operation_id == "save-video.release"
            else PRIVATE_MEDIA_SCOPE_ID
        )
        return await pack.authorization.dispatch(
            request,
            scope_id,
            operation_id,
            invoke,
        )
    if operation_id == "privacy-show-any.display-result":
        return await PrivacyShowAnyProtectedOperations(
            pack.authorization,
            pack.workflow("privacy-show-any-workflow"),
            utils_privacy_adapter(PRIVACY_SHOW_ANY_OPERATION_ADAPTER_ID),
        ).dispatch(request, payload)
    if operation_id in PROMPT_PROVIDER_OPERATION_IDS:
        adapter = utils_privacy_adapter(PROMPT_PROVIDER_OPERATION_ADAPTER_ID)

        async def invoke(_authorization):
            result = adapter.invoke(
                payload,
                _PromptProviderRouteContext(operation_id, request),
            )
            return await result if inspect.isawaitable(result) else result

        return await pack.authorization.dispatch(
            request,
            PROMPT_ENHANCER_SCOPE_ID,
            operation_id,
            invoke,
        )
    if operation_id in QUEUE_OPERATION_ADAPTER_IDS:
        adapter = utils_privacy_adapter(QUEUE_OPERATION_ADAPTER_IDS[operation_id])

        async def invoke(authorization):
            result = adapter.invoke(payload, _QueueRouteContext(request, authorization))
            return await result if inspect.isawaitable(result) else result

        return await pack.authorization.dispatch(
            request,
            QUEUE_SCOPE_ID,
            operation_id,
            invoke,
        )
    raise ValueError("Unknown Utils privacy operation.")


async def _request_payload(request: object) -> dict[str, object]:
    if str(getattr(request, "method", "GET")).upper() == "GET":
        return dict(getattr(request, "query", {}) or {})
    payload = await request.json()
    if not isinstance(payload, Mapping):
        raise ValueError("Privacy operation payload must be an object.")
    return dict(payload)


def _response(operation_id: str, result: object):
    return web.json_response(result)

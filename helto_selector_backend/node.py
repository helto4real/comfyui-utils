from __future__ import annotations

import hashlib
import json
import os

from comfy_api.latest import io

from .image_processing import DEFAULT_RESIZE_MODE, parse_edited_masks, parse_selected_paths, select_images
from .mask_storage import mask_cache_paths


def coerce_batching_mode(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"", "0", "false", "no", "off"}:
            return False
    return bool(value)


class HeltoImageSelector(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoImageSelector",
            display_name="Helto Multi-Image Selector",
            category="image",
            hidden=[io.Hidden.unique_id],
            inputs=[
                io.String.Input(
                    "selected_images",
                    default="[]",
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
                io.String.Input(
                    "resize_mode",
                    default=DEFAULT_RESIZE_MODE,
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
                io.String.Input(
                    "edited_masks",
                    default="{}",
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
                io.String.Input(
                    "edited_bboxes",
                    default="{}",
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
                io.Boolean.Input(
                    "batching_mode",
                    default=False,
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
                io.Boolean.Input(
                    "privacy_mode",
                    default=True,
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
                io.String.Input(
                    "privacy_mode_reference",
                    default="",
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
                io.String.Input(
                    "private_execution",
                    default="",
                    socketless=True,
                    extra_dict={"hidden": True},
                ),
            ],
            outputs=[
                io.Image.Output("images", display_name="images", is_output_list=True),
                io.Image.Output("image_batch", display_name="image_batch"),
                io.Mask.Output("masks", display_name="masks", is_output_list=True),
                io.Mask.Output("mask_batch", display_name="mask_batch"),
                io.BoundingBox.Output("bboxes", display_name="bboxes", is_output_list=True),
            ],
        )

    @classmethod
    async def execute(
        cls,
        selected_images: str = "[]",
        resize_mode: str = DEFAULT_RESIZE_MODE,
        edited_masks: str = "{}",
        edited_bboxes: str = "{}",
        batching_mode: bool = False,
        privacy_mode: bool = True,
        privacy_mode_reference: str = "",
        private_execution: str = "",
        unique_id: str | None = None,
    ) -> io.NodeOutput:
        subject_id = unique_id or getattr(getattr(cls, "hidden", None), "unique_id", None)
        private_required = privacy_mode is not False
        if privacy_mode_reference:
            if subject_id is None:
                raise ValueError("PRIVACY_SUBJECT_MODE_REFERENCE_INVALID")
            try:
                from ..shared.managed_privacy_execution import (
                    consume_utils_subject_mode,
                    utils_subject_requires_private_execution,
                )
                from .managed_workflow import SELECTOR_SUBJECT_MODE_BINDING_ID
            except ImportError as exc:
                if str(exc) != "attempted relative import beyond top-level package":
                    raise
                from shared.managed_privacy_execution import (
                    consume_utils_subject_mode,
                    utils_subject_requires_private_execution,
                )
                from helto_selector_backend.managed_workflow import (
                    SELECTOR_SUBJECT_MODE_BINDING_ID,
                )
            with consume_utils_subject_mode(
                privacy_mode_reference,
                SELECTOR_SUBJECT_MODE_BINDING_ID,
                subject_id,
            ) as lease:
                private_required = utils_subject_requires_private_execution(
                    lease,
                    SELECTOR_SUBJECT_MODE_BINDING_ID,
                )
        elif subject_id is not None:
            raise ValueError("PRIVACY_SUBJECT_MODE_REFERENCE_INVALID")

        if private_required:
            if not private_execution:
                raise ValueError("PRIVACY_EXECUTION_REFERENCE_INVALID")
            try:
                from ..shared.managed_privacy import utils_privacy_pack
            except ImportError as exc:
                if str(exc) != "attempted relative import beyond top-level package":
                    raise
                from shared.managed_privacy import utils_privacy_pack

            reference = _private_execution_reference(private_execution)
            resolved = await utils_privacy_pack().execution("selector-execution").dispatch(
                reference,
                {"resize_mode": resize_mode},
                subject_id=subject_id,
            )
            tensor_list, image_batch, mask_list, mask_batch, bboxes = resolved.value
        else:
            try:
                from ..shared.managed_privacy import resolve_selector_output
            except ImportError as exc:
                if str(exc) != "attempted relative import beyond top-level package":
                    raise
                from shared.managed_privacy import resolve_selector_output
            tensor_list, image_batch, mask_list, mask_batch, bboxes = await resolve_selector_output(
                selected_images,
                resize_mode,
                edited_masks,
                edited_bboxes,
            )
        if not coerce_batching_mode(batching_mode):
            return io.NodeOutput([image_batch], image_batch, [mask_batch], mask_batch, [bboxes])
        return io.NodeOutput(tensor_list, image_batch, mask_list, mask_batch, bboxes)

    @classmethod
    def fingerprint_inputs(
        cls,
        selected_images: str = "[]",
        edited_masks: str = "{}",
        private_execution: str = "",
        privacy_mode: bool = True,
        **kwargs,
    ) -> str:
        del kwargs
        if privacy_mode is not False:
            reference = _private_execution_reference(private_execution)
            serialized = json.dumps(reference, sort_keys=True, separators=(",", ":"))
            return hashlib.sha256(serialized.encode("utf-8")).hexdigest()
        selected_paths = parse_selected_paths(selected_images)
        edited_mask_paths = set(parse_edited_masks(edited_masks))
        records = []
        for image_path in selected_paths:
            records.append(_file_revision_record(image_path, "image"))
            if image_path in edited_mask_paths:
                for mask_path in mask_cache_paths(image_path):
                    records.append(_file_revision_record(mask_path, "mask"))
        serialized = json.dumps(records, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _private_execution_reference(value: object) -> dict[str, object]:
    try:
        reference = json.loads(value) if isinstance(value, str) else value
    except json.JSONDecodeError:
        raise ValueError("PRIVACY_EXECUTION_REFERENCE_INVALID") from None
    if not isinstance(reference, dict):
        raise ValueError("PRIVACY_EXECUTION_REFERENCE_INVALID")
    return reference


def _file_revision_record(path: str, kind: str) -> dict[str, object]:
    normalized = os.path.realpath(os.path.abspath(os.path.normpath(path)))
    path_id = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    try:
        stat = os.stat(normalized)
        return {
            "kind": kind,
            "path": path_id,
            "exists": True,
            "mtime_ns": stat.st_mtime_ns,
            "size": stat.st_size,
        }
    except OSError:
        return {"kind": kind, "path": path_id, "exists": False}

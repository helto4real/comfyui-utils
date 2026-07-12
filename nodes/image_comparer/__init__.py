from __future__ import annotations

from io import BytesIO

import torch

from comfy_api.latest import io, ui

from ...shared.managed_privacy import utils_media_artifacts


def _has_tensor(value) -> bool:
    if value is None:
        return False

    try:
        return len(value) > 0
    except TypeError:
        return False


def _normalize_mask(mask: torch.Tensor) -> torch.Tensor:
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    elif mask.ndim == 3:
        pass
    elif mask.ndim == 4 and mask.shape[1] == 1:
        mask = mask[:, 0, :, :]
    elif mask.ndim == 4 and mask.shape[-1] == 1:
        mask = mask[..., 0]
    else:
        mask = mask.reshape((-1, mask.shape[-2], mask.shape[-1]))

    return mask.float().clamp(0, 1)


def _extend_batch_to(tensor: torch.Tensor, batch_size: int) -> torch.Tensor:
    if tensor.shape[0] == batch_size:
        return tensor
    if tensor.shape[0] > batch_size:
        return tensor[:batch_size]

    repeat_shape = (batch_size - tensor.shape[0],) + (1,) * (tensor.ndim - 1)
    return torch.cat([tensor, tensor[-1:].repeat(repeat_shape)], dim=0)


def _mask_preview_images(mask: torch.Tensor) -> torch.Tensor:
    mask = _normalize_mask(mask)
    return mask.unsqueeze(1).movedim(1, -1).expand(-1, -1, -1, 3).contiguous()


def _apply_mask_to_images(images: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    mask = _normalize_mask(mask).to(device=images.device, dtype=images.dtype)

    if mask.shape[1:3] != images.shape[1:3]:
        mask = torch.nn.functional.interpolate(
            mask.unsqueeze(1),
            size=(images.shape[1], images.shape[2]),
            mode="bilinear",
        ).squeeze(1)

    batch_size = max(images.shape[0], mask.shape[0])
    images = _extend_batch_to(images, batch_size)
    mask = _extend_batch_to(mask, batch_size)

    return images * (1.0 - mask).unsqueeze(-1)


def _preview_images_for_slot(images=None, mask=None) -> torch.Tensor | None:
    has_images = _has_tensor(images)
    has_mask = _has_tensor(mask)

    if has_images and has_mask:
        return _apply_mask_to_images(images, mask)
    if has_images:
        return images
    if has_mask:
        return _mask_preview_images(mask)

    return None


def _encode_preview_bytes(images, cls: type[io.ComfyNode]) -> list[bytes]:
    encoded = []
    metadata = ui.ImageSaveHelper._create_png_metadata(cls)
    for image in images:
        pil_image = ui.ImageSaveHelper._convert_tensor_to_pil(image)
        buffer = BytesIO()
        pil_image.save(buffer, format="PNG", pnginfo=metadata, compress_level=1)
        encoded.append(buffer.getvalue())
    return encoded


async def _managed_preview_records(
    images,
    cls: type[io.ComfyNode],
    managed_artifacts,
    *,
    owner_key: str,
    privacy_mode: object = True,
    mode_facts: object = None,
    execution: object = None,
) -> list[dict]:
    if not _has_tensor(images):
        return []
    records = await managed_artifacts.publish_encoded_previews(
        "HeltoImageComparer",
        lambda: _encode_preview_bytes(images, cls),
        owner_key=owner_key,
        privacy_mode=privacy_mode,
        mode_facts=mode_facts,
        execution=execution,
    )
    return [record.to_record() for record in records]


def _preview_records(images, filename_prefix: str, cls: type[io.ComfyNode], privacy_mode: bool) -> list[dict]:
    if not _has_tensor(images):
        return []

    if privacy_mode:
        raise RuntimeError("Private previews require managed artifacts.")

    return ui.ImageSaveHelper.save_images(
        images,
        filename_prefix=filename_prefix,
        folder_type=io.FolderType.temp,
        cls=cls,
        compress_level=1,
    )


class ImageComparer(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="HeltoImageComparer",
            display_name="Helto Image Comparer",
            category="HELTO/Image",
            description="Compares an original image against a new image in the node preview.",
            inputs=[
                io.Image.Input("original", optional=True),
                io.Image.Input("new", optional=True),
                io.Mask.Input("original_mask", optional=True),
                io.Mask.Input("new_mask", optional=True),
                io.Boolean.Input("privacy_mode", default=True),
            ],
            outputs=[],
            hidden=[
                io.Hidden.unique_id,
            ],
            is_output_node=True,
        )

    @classmethod
    async def execute(
        cls,
        original=None,
        new=None,
        original_mask=None,
        new_mask=None,
        privacy_mode: bool = True,
        unique_id: str | None = None,
    ) -> io.NodeOutput:
        if isinstance(original_mask, bool) and new_mask is None and privacy_mode is True:
            privacy_mode = original_mask
            original_mask = None

        original_preview = _preview_images_for_slot(original, original_mask)
        new_preview = _preview_images_for_slot(new, new_mask)

        if privacy_mode:
            managed = utils_media_artifacts()
            owner = str(unique_id or "helto-image-comparer")
            result = {
                "a_images": await _managed_preview_records(
                    original_preview,
                    cls,
                    managed,
                    owner_key=f"{owner}:original",
                ),
                "b_images": await _managed_preview_records(
                    new_preview,
                    cls,
                    managed,
                    owner_key=f"{owner}:new",
                ),
            }
        else:
            result = {
                "a_images": _preview_records(original_preview, "helto.compare.original", cls, False),
                "b_images": _preview_records(new_preview, "helto.compare.new", cls, False),
            }

        return io.NodeOutput(ui=result)

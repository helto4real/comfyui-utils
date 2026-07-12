from __future__ import annotations

import importlib
import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from contextlib import contextmanager
from collections.abc import Mapping
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image
import torch
from helto_privacy import PrivacyEnvelopeCodec

import helto_selector_backend.image_processing as selector_image_processing
import helto_selector_backend.services as selector_services
from helto_selector_backend.image_processing import (
    parse_selected_paths,
    parse_edited_bboxes,
    parse_edited_masks,
    select_images,
)
from helto_selector_backend.mask_storage import (
    delete_mask,
    load_mask_bytes,
    mask_cache_paths,
    save_mask_bytes,
)
from helto_selector_backend.scanning import delete_image_files, discover_image_folders, scan_image_folders
from helto_selector_backend.services import (
    DeleteImagesPayload,
    DeleteMaskPayload,
    MigrateMasksPayload,
    ScanFoldersPayload,
    PasteImagePayload,
    SaveMaskPayload,
    SelectorPathError,
    authorize_selector_folders,
    authorize_selector_image_path,
    clear_cache_payload,
    delete_images_payload,
    delete_mask_payload,
    effective_authorized_roots,
    get_input_dir_payload,
    load_registered_selector_roots,
    paste_image_payload,
    register_selector_roots,
    registered_selector_roots_payload,
    scan_folders_payload,
    save_mask_payload,
    unregister_selector_root,
    migrate_masks_payload,
)
from helto_selector_backend.thumbnail_cache import (
    clear_thumbnail_cache,
    delete_thumbnail_cache_for_paths,
    get_thumbnail_bytes,
    thumbnail_cache_paths,
)
import shared.temp_cache as temp_cache


pytestmark = pytest.mark.usefixtures("coordinated_suite_test_boundary")


def write_image(path: str, size: tuple[int, int], color: tuple[int, int, int]) -> None:
    Image.new("RGB", size, color).save(path)


def image_bytes(size: tuple[int, int] = (4, 4), color: tuple[int, int, int] = (255, 0, 0)) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def thumbnail_pixel(webp_bytes: bytes) -> tuple[int, int, int]:
    with Image.open(BytesIO(webp_bytes)) as thumb:
        return thumb.convert("RGB").getpixel((0, 0))


@contextmanager
def isolated_privacy_keystore():
    old_env = {
        "HELTO_PRIVACY_KEYSTORE": os.environ.get("HELTO_PRIVACY_KEYSTORE"),
        "HELTO_PRIVACY_SESSION_DIR": os.environ.get("HELTO_PRIVACY_SESSION_DIR"),
    }
    with tempfile.TemporaryDirectory() as tmpdir:
        root = Path(tmpdir)
        os.environ["HELTO_PRIVACY_KEYSTORE"] = str(root / "privacy_keystore.json")
        os.environ["HELTO_PRIVACY_SESSION_DIR"] = str(root / "session")
        from helto_privacy import initialize_keystore

        initialize_keystore("correct horse battery staple")
        try:
            yield root
        finally:
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


class ImageProcessingTests(unittest.TestCase):
    def test_empty_selection_returns_black_placeholder_and_batch(self):
        images, image_batch, masks, mask_batch, bboxes = select_images("[]")

        self.assertEqual(len(images), 1)
        self.assertEqual(tuple(images[0].shape), (1, 512, 512, 3))
        self.assertEqual(tuple(image_batch.shape), (1, 512, 512, 3))
        self.assertEqual(float(image_batch.sum()), 0.0)
        self.assertEqual(len(masks), 1)
        self.assertEqual(tuple(masks[0].shape), (1, 512, 512))
        self.assertEqual(tuple(mask_batch.shape), (1, 512, 512))
        self.assertEqual(float(mask_batch.min()), 1.0)
        self.assertEqual(bboxes, [[]])

    def test_missing_files_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "first.png")
            missing_path = os.path.join(tmpdir, "missing.png")
            write_image(image_path, (8, 6), (255, 0, 0))

            images, image_batch, masks, mask_batch, bboxes = select_images(json.dumps([image_path, missing_path]))

            self.assertEqual(len(images), 1)
            self.assertEqual(tuple(images[0].shape), (1, 6, 8, 3))
            self.assertEqual(tuple(image_batch.shape), (1, 6, 8, 3))
            self.assertEqual(tuple(masks[0].shape), (1, 6, 8))
            self.assertEqual(tuple(mask_batch.shape), (1, 6, 8))
            self.assertEqual(bboxes, [[]])

    def test_resize_modes_preserve_current_shapes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            first = os.path.join(tmpdir, "first.png")
            second = os.path.join(tmpdir, "second.png")
            write_image(first, (10, 8), (255, 0, 0))
            write_image(second, (4, 6), (0, 255, 0))
            selected = json.dumps([first, second])

            zoom_images, zoom_batch, zoom_masks, zoom_mask_batch, zoom_bboxes = select_images(selected, "zoom to fit")
            self.assertEqual([tuple(t.shape) for t in zoom_images], [(1, 8, 10, 3), (1, 8, 10, 3)])
            self.assertEqual(tuple(zoom_batch.shape), (2, 8, 10, 3))
            self.assertEqual([tuple(t.shape) for t in zoom_masks], [(1, 8, 10), (1, 8, 10)])
            self.assertEqual(tuple(zoom_mask_batch.shape), (2, 8, 10))
            self.assertEqual(zoom_bboxes, [[], []])

            pad_images, pad_batch, pad_masks, pad_mask_batch, pad_bboxes = select_images(selected, "pad")
            self.assertEqual([tuple(t.shape) for t in pad_images], [(1, 8, 10, 3), (1, 8, 10, 3)])
            self.assertEqual(tuple(pad_batch.shape), (2, 8, 10, 3))
            self.assertEqual([tuple(t.shape) for t in pad_masks], [(1, 8, 10), (1, 8, 10)])
            self.assertEqual(tuple(pad_mask_batch.shape), (2, 8, 10))
            self.assertEqual(pad_bboxes, [[], []])

            raw_images, raw_batch, raw_masks, raw_mask_batch, raw_bboxes = select_images(selected, "No resize")
            self.assertEqual([tuple(t.shape) for t in raw_images], [(1, 8, 10, 3), (1, 6, 4, 3)])
            self.assertEqual(tuple(raw_batch.shape), (2, 8, 10, 3))
            self.assertEqual([tuple(t.shape) for t in raw_masks], [(1, 8, 10), (1, 6, 4)])
            self.assertEqual(tuple(raw_mask_batch.shape), (2, 8, 10))
            self.assertEqual(raw_bboxes, [[], []])

    def test_default_mask_outputs_full_image_mask(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "image.png")
            write_image(image_path, (7, 5), (255, 0, 0))

            images, image_batch, masks, mask_batch, bboxes = select_images(json.dumps([image_path]))

            self.assertEqual(tuple(images[0].shape), (1, 5, 7, 3))
            self.assertEqual(tuple(image_batch.shape), (1, 5, 7, 3))
            self.assertEqual(tuple(masks[0].shape), (1, 5, 7))
            self.assertEqual(tuple(mask_batch.shape), (1, 5, 7))
            self.assertEqual(float(mask_batch.min()), 1.0)
            self.assertEqual(bboxes, [[]])

    def test_selector_reports_progress_phases(self):
        if selector_image_processing.helto_progress is None:
            self.skipTest("progress API is unavailable")

        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "image.png")
            write_image(image_path, (7, 5), (255, 0, 0))
            sent = []

            with patch.object(
                selector_image_processing.helto_progress,
                "_send_payload",
                side_effect=lambda payload: sent.append(payload) or True,
            ):
                select_images(json.dumps([image_path]))

        phases = {payload["phase"] for payload in sent}
        self.assertIn("selection", phases)
        self.assertIn("load_images", phases)
        self.assertIn("load_masks", phases)
        self.assertIn("batch", phases)
        self.assertIn("complete", phases)

    def test_bbox_outputs_match_selector_resize_modes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            first = os.path.join(tmpdir, "first.png")
            second = os.path.join(tmpdir, "second.png")
            write_image(first, (10, 8), (255, 0, 0))
            write_image(second, (4, 6), (0, 255, 0))
            selected = json.dumps([first, second])
            edited_bboxes = json.dumps({
                first: [{"x": 2, "y": 1, "width": 4, "height": 3}],
                second: [{"x": 1, "y": 2, "width": 2, "height": 2}],
            })

            _, _, _, _, zoom_bboxes = select_images(selected, "zoom to fit", "{}", edited_bboxes)
            self.assertEqual(zoom_bboxes, [
                [{"x": 2, "y": 1, "width": 4, "height": 3}],
                [{"x": 2, "y": 3, "width": 6, "height": 2}],
            ])

            _, _, _, _, pad_bboxes = select_images(selected, "pad", "{}", edited_bboxes)
            self.assertEqual(pad_bboxes, [
                [{"x": 2, "y": 1, "width": 4, "height": 3}],
                [{"x": 4, "y": 3, "width": 2, "height": 2}],
            ])

            _, raw_batch, _, _, raw_bboxes = select_images(selected, "No resize", "{}", edited_bboxes)
            self.assertEqual(tuple(raw_batch.shape), (2, 8, 10, 3))
            self.assertEqual(raw_bboxes, [
                [{"x": 2, "y": 1, "width": 4, "height": 3}],
                [{"x": 3, "y": 3, "width": 3, "height": 2}],
            ])

    def test_delete_mask_removes_plain_and_encrypted_cache_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "image.png")
            cache_dir = os.path.join(tmpdir, "masks")
            write_image(image_path, (4, 4), (255, 0, 0))
            plain_path, encrypted_path = mask_cache_paths(image_path, cache_dir)
            os.makedirs(cache_dir, exist_ok=True)
            Path(plain_path).write_bytes(b"plain mask")
            Path(encrypted_path).write_bytes(b"encrypted mask")

            deleted_count = delete_mask(image_path, cache_dir)

            self.assertEqual(deleted_count, 2)
            self.assertFalse(os.path.exists(plain_path))
            self.assertFalse(os.path.exists(encrypted_path))

    def test_delete_mask_payload_succeeds_when_mask_file_is_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "image.png")
            write_image(image_path, (4, 4), (255, 0, 0))

            result = delete_mask_payload(DeleteMaskPayload(path=image_path), authorized_roots=[tmpdir])

            self.assertEqual(result["status"], "success")
            self.assertEqual(result["path"], image_path)
            self.assertTrue(result["cleared"])
            self.assertEqual(result["deleted_count"], 0)

class ScanningAndThumbnailTests(unittest.TestCase):
    def test_scan_image_folders_returns_expected_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "image.png")
            ignored_path = os.path.join(tmpdir, "notes.txt")
            write_image(image_path, (4, 4), (0, 0, 255))
            with open(ignored_path, "w", encoding="utf-8") as f:
                f.write("ignore me")

            results = scan_image_folders([tmpdir], recursive=False)

            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["path"], image_path)
            self.assertEqual(results[0]["folder"], tmpdir)
            self.assertEqual(results[0]["image_folder"], tmpdir)
            self.assertEqual(results[0]["name"], "image.png")
            self.assertIn("date_modified", results[0])
            self.assertGreater(results[0]["size_bytes"], 0)

    def test_discover_image_folders_includes_empty_subfolders_sorted_by_root_and_name(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            alpha_root = os.path.join(tmpdir, "alpha")
            beta_root = os.path.join(tmpdir, "beta")
            os.makedirs(os.path.join(beta_root, "zeta"))
            os.makedirs(os.path.join(beta_root, "empty", "nested"))
            os.makedirs(os.path.join(alpha_root, "middle"))

            results = discover_image_folders([beta_root, alpha_root])

            self.assertEqual(
                [(item["root"], item["relative"], item["name"]) for item in results],
                [
                    (alpha_root, "", "alpha"),
                    (alpha_root, "middle", "middle"),
                    (beta_root, "", "beta"),
                    (beta_root, "empty", "empty"),
                    (beta_root, os.path.join("empty", "nested"), "nested"),
                    (beta_root, "zeta", "zeta"),
                ],
            )

    def test_recursive_scan_reports_actual_image_folder(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            child_dir = os.path.join(tmpdir, "child")
            os.makedirs(child_dir)
            image_path = os.path.join(child_dir, "image.png")
            write_image(image_path, (4, 4), (0, 0, 255))

            results = scan_image_folders([tmpdir], recursive=True)

            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["folder"], tmpdir)
            self.assertEqual(results[0]["image_folder"], child_dir)

    def test_selector_thumbnail_cache_defaults_to_comfy_temp_node_subfolder(self):
        original_folder_paths = temp_cache.folder_paths
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_cache.folder_paths = types.SimpleNamespace(get_temp_directory=lambda: tmpdir)
            try:
                image_path = os.path.join(tmpdir, "image.png")
                plain_cache, encrypted_cache = thumbnail_cache_paths(image_path)
            finally:
                temp_cache.folder_paths = original_folder_paths

            expected_dir = os.path.join(tmpdir, "helto_cache", "HeltoImageSelector", "thumbnails")
            self.assertEqual(os.path.dirname(plain_cache), expected_dir)
            self.assertEqual(os.path.dirname(encrypted_cache), expected_dir)

    def test_clear_thumbnail_cache_keeps_edited_mask_files(self):
        original_folder_paths = temp_cache.folder_paths
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_cache.folder_paths = types.SimpleNamespace(get_temp_directory=lambda: tmpdir)
            try:
                image_path = os.path.join(tmpdir, "image.png")
                thumbnail_plain, thumbnail_encrypted = thumbnail_cache_paths(image_path)
                mask_dir = os.path.join(tmpdir, "helto_cache", "HeltoImageSelector", "masks")
                os.makedirs(os.path.dirname(thumbnail_plain), exist_ok=True)
                os.makedirs(mask_dir, exist_ok=True)
                Path(thumbnail_plain).write_bytes(b"plain thumbnail")
                Path(thumbnail_encrypted).write_bytes(b"encrypted thumbnail")
                mask_path = os.path.join(mask_dir, "edited-mask.png.enc")
                Path(mask_path).write_bytes(b"encrypted mask")

                clear_thumbnail_cache()
            finally:
                temp_cache.folder_paths = original_folder_paths

            self.assertFalse(os.path.exists(thumbnail_plain))
            self.assertFalse(os.path.exists(thumbnail_encrypted))
            self.assertTrue(os.path.exists(mask_path))

    def test_thumbnail_cache_regenerates_when_source_file_changes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "image.png")
            cache_dir = os.path.join(tmpdir, "cache")
            os.makedirs(cache_dir)
            write_image(image_path, (16, 16), (255, 0, 0))

            first_bytes = get_thumbnail_bytes(image_path, False, cache_dir=cache_dir)
            plain_cache, _ = thumbnail_cache_paths(image_path, cache_dir)
            write_image(image_path, (16, 16), (0, 0, 255))
            newer_mtime = os.path.getmtime(plain_cache) + 1
            os.utime(image_path, (newer_mtime, newer_mtime))

            second_bytes = get_thumbnail_bytes(image_path, False, cache_dir=cache_dir)

            self.assertNotEqual(first_bytes, second_bytes)
            first_pixel = thumbnail_pixel(first_bytes)
            second_pixel = thumbnail_pixel(second_bytes)
            self.assertGreater(first_pixel[0], 200)
            self.assertLess(first_pixel[2], 80)
            self.assertLess(second_pixel[0], 80)
            self.assertGreater(second_pixel[2], 200)

    def test_delete_thumbnail_cache_for_paths_removes_plain_and_encrypted_variants(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "removed.png")
            cache_dir = os.path.join(tmpdir, "cache")
            os.makedirs(cache_dir)
            plain_cache, encrypted_cache = thumbnail_cache_paths(image_path, cache_dir)

            with open(plain_cache, "wb") as f:
                f.write(b"plain")
            with open(encrypted_cache, "wb") as f:
                f.write(b"encrypted")

            removed_count = delete_thumbnail_cache_for_paths([image_path], cache_dir=cache_dir)

            self.assertEqual(removed_count, 2)
            self.assertFalse(os.path.exists(plain_cache))
            self.assertFalse(os.path.exists(encrypted_cache))

    def test_delete_thumbnail_cache_for_paths_keeps_unlisted_image_cache(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            removed_path = os.path.join(tmpdir, "removed.png")
            kept_path = os.path.join(tmpdir, "kept.png")
            cache_dir = os.path.join(tmpdir, "cache")
            os.makedirs(cache_dir)

            removed_plain, _ = thumbnail_cache_paths(removed_path, cache_dir)
            kept_plain, kept_encrypted = thumbnail_cache_paths(kept_path, cache_dir)
            with open(removed_plain, "wb") as f:
                f.write(b"removed")
            with open(kept_plain, "wb") as f:
                f.write(b"kept")
            with open(kept_encrypted, "wb") as f:
                f.write(b"kept encrypted")

            removed_count = delete_thumbnail_cache_for_paths([removed_path], cache_dir=cache_dir)

            self.assertEqual(removed_count, 1)
            self.assertFalse(os.path.exists(removed_plain))
            self.assertTrue(os.path.exists(kept_plain))
            self.assertTrue(os.path.exists(kept_encrypted))

    def test_delete_image_files_deletes_allowlisted_images_only(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_root = os.path.join(tmpdir, "images")
            outside_root = os.path.join(tmpdir, "outside")
            os.makedirs(image_root)
            os.makedirs(outside_root)
            image_path = os.path.join(image_root, "delete_me.png")
            outside_path = os.path.join(outside_root, "keep_me.png")
            write_image(image_path, (4, 4), (255, 0, 0))
            write_image(outside_path, (4, 4), (0, 255, 0))

            result = delete_image_files([image_path, outside_path], [image_root], recursive=False)

            self.assertEqual(result["deleted"], [image_path])
            self.assertEqual(result["missing"], [])
            self.assertEqual(result["skipped"], [outside_path])
            self.assertFalse(os.path.exists(image_path))
            self.assertTrue(os.path.exists(outside_path))

    def test_delete_image_files_skips_existing_subfolder_image_when_not_recursive(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            child_dir = os.path.join(tmpdir, "child")
            os.makedirs(child_dir)
            image_path = os.path.join(child_dir, "keep_me.png")
            write_image(image_path, (4, 4), (0, 0, 255))

            result = delete_image_files([image_path], [tmpdir], recursive=False)

            self.assertEqual(result["deleted"], [])
            self.assertEqual(result["missing"], [])
            self.assertEqual(result["skipped"], [image_path])
            self.assertTrue(os.path.exists(image_path))

    def test_delete_image_files_prunes_cache_for_deleted_image(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "delete_me.png")
            cache_dir = os.path.join(tmpdir, "cache")
            os.makedirs(cache_dir)
            write_image(image_path, (4, 4), (255, 0, 0))
            plain_cache, encrypted_cache = thumbnail_cache_paths(image_path, cache_dir)
            with open(plain_cache, "wb") as f:
                f.write(b"plain")
            with open(encrypted_cache, "wb") as f:
                f.write(b"encrypted")

            result = delete_image_files([image_path], [tmpdir], recursive=False)
            removed_count = delete_thumbnail_cache_for_paths(result["deleted"] + result["missing"], cache_dir=cache_dir)

            self.assertEqual(result["deleted"], [image_path])
            self.assertEqual(result["missing"], [])
            self.assertEqual(result["skipped"], [])
            self.assertEqual(removed_count, 2)
            self.assertFalse(os.path.exists(image_path))
            self.assertFalse(os.path.exists(plain_cache))
            self.assertFalse(os.path.exists(encrypted_cache))

    def test_delete_image_files_prunes_cache_for_already_missing_image(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            missing_path = os.path.join(tmpdir, "already_gone.png")
            cache_dir = os.path.join(tmpdir, "cache")
            os.makedirs(cache_dir)
            plain_cache, encrypted_cache = thumbnail_cache_paths(missing_path, cache_dir)
            with open(plain_cache, "wb") as f:
                f.write(b"plain")
            with open(encrypted_cache, "wb") as f:
                f.write(b"encrypted")

            result = delete_image_files([missing_path], [tmpdir], recursive=False)
            removed_count = delete_thumbnail_cache_for_paths(result["deleted"] + result["missing"], cache_dir=cache_dir)

            self.assertEqual(result["deleted"], [])
            self.assertEqual(result["missing"], [missing_path])
            self.assertEqual(result["skipped"], [])
            self.assertEqual(removed_count, 2)
            self.assertFalse(os.path.exists(plain_cache))
            self.assertFalse(os.path.exists(encrypted_cache))

    def test_generated_thumbnail_is_capped_at_512_pixels(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "image.png")
            cache_dir = os.path.join(tmpdir, "cache")
            os.makedirs(cache_dir)
            write_image(image_path, (1200, 800), (10, 20, 30))

            thumb_bytes = get_thumbnail_bytes(image_path, False, cache_dir=cache_dir)

            with Image.open(BytesIO(thumb_bytes)) as thumb:
                self.assertEqual(thumb.size, (512, 341))


class ServiceLayerTests(unittest.TestCase):
    def test_scan_payload_prunes_missing_paths_and_reports_cache_count(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "image.png")
            missing_path = os.path.join(tmpdir, "missing.png")
            write_image(image_path, (4, 4), (0, 0, 255))
            removed_paths: list[list[str]] = []

            payload = ScanFoldersPayload.from_request_data({
                "folders": [tmpdir],
                "recursive": False,
                "previous_paths": [image_path, missing_path, 123, ""],
            })
            result = scan_folders_payload(
                payload,
                delete_cache_func=lambda paths: removed_paths.append(paths) or 5,
                authorized_roots=[tmpdir],
            )

            self.assertEqual([image["path"] for image in result["images"]], [image_path])
            self.assertEqual(result["removed_paths"], [missing_path])
            self.assertEqual(result["removed_cache_count"], 5)
            self.assertEqual(removed_paths, [[missing_path]])
            self.assertEqual(len(result["folders"]), 1)

    def test_delete_payload_counts_and_prunes_deleted_and_missing_cache(self):
        payload = DeleteImagesPayload(paths=["/tmp/images/a.png"], folders=["/tmp/images"], recursive=True)
        cache_paths_seen: list[list[str]] = []

        result = delete_images_payload(
            payload,
            delete_func=lambda paths, folders, recursive: {
                "deleted": [paths[0]],
                "missing": ["/tmp/images/b.png"],
                "skipped": ["c.txt"],
            },
            delete_cache_func=lambda paths: cache_paths_seen.append(paths) or 2,
            authorized_roots=["/tmp"],
        )

        self.assertEqual(result["deleted_count"], 1)
        self.assertEqual(result["missing_count"], 1)
        self.assertEqual(result["skipped_count"], 1)
        self.assertEqual(result["removed_cache_count"], 2)
        self.assertEqual(cache_paths_seen, [["/tmp/images/a.png", "/tmp/images/b.png"]])

    def test_request_payload_helpers_coerce_invalid_lists_without_string_iteration(self):
        scan_payload = ScanFoldersPayload.from_request_data({
            "folders": "/tmp/images",
            "previous_paths": "/tmp/old.png",
            "recursive": "",
        })
        delete_payload = DeleteImagesPayload.from_request_data({
            "paths": "/tmp/delete.png",
            "folders": "/tmp/images",
            "recursive": "false",
        })

        self.assertEqual(scan_payload.folders, [])
        self.assertEqual(scan_payload.previous_paths, [])
        self.assertFalse(scan_payload.recursive)
        self.assertEqual(delete_payload.paths, [])
        self.assertEqual(delete_payload.folders, [])
        self.assertTrue(delete_payload.recursive)

    def test_request_payload_helpers_normalize_and_dedupe_folder_paths(self):
        scan_payload = ScanFoldersPayload.from_request_data({
            "folders": [
                "/home/thhel/comfy/input/",
                "/home/thhel/comfy/input",
                "/home/thhel/comfy//output/./",
            ],
            "recursive": False,
        })
        delete_payload = DeleteImagesPayload.from_request_data({
            "paths": [],
            "folders": [
                "/home/thhel/comfy/input/",
                "/home/thhel/comfy/input",
            ],
            "recursive": False,
        })

        self.assertEqual(scan_payload.folders, ["/home/thhel/comfy/input", "/home/thhel/comfy/output"])
        self.assertEqual(delete_payload.folders, ["/home/thhel/comfy/input"])

    def test_clear_cache_payload_helper(self):
        cleared: list[bool] = []

        self.assertEqual(clear_cache_payload(lambda: cleared.append(True)), {"status": "success"})
        self.assertEqual(cleared, [True])

    def test_get_input_dir_payload_uses_injected_comfy_provider(self):
        self.assertEqual(get_input_dir_payload(lambda: "/tmp/input"), {"input_dir": "/tmp/input"})

    def test_selector_image_authorization_requires_supported_file_inside_server_roots(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root_dir = os.path.join(tmpdir, "root")
            outside_dir = os.path.join(tmpdir, "outside")
            os.makedirs(root_dir)
            os.makedirs(outside_dir)
            image_path = os.path.join(root_dir, "image.png")
            missing_path = os.path.join(root_dir, "missing.png")
            notes_path = os.path.join(root_dir, "notes.txt")
            outside_path = os.path.join(outside_dir, "image.png")
            write_image(image_path, (4, 4), (0, 0, 255))
            write_image(outside_path, (4, 4), (255, 0, 0))
            Path(notes_path).write_text("not an image", encoding="utf-8")

            self.assertEqual(authorize_selector_image_path(image_path, authorized_roots=[root_dir]), image_path)
            self.assertEqual(authorize_selector_folders([root_dir], authorized_roots=[root_dir]), [root_dir])

            with self.assertRaises(SelectorPathError) as unsupported:
                authorize_selector_image_path(notes_path, authorized_roots=[root_dir])
            self.assertEqual(unsupported.exception.status_code, 400)

            with self.assertRaises(SelectorPathError) as forbidden:
                authorize_selector_image_path(outside_path, authorized_roots=[root_dir])
            self.assertEqual(forbidden.exception.status_code, 403)
            with self.assertRaises(SelectorPathError):
                authorize_selector_folders([outside_dir], authorized_roots=[root_dir])

            with self.assertRaises(SelectorPathError) as missing:
                authorize_selector_image_path(missing_path, authorized_roots=[root_dir])
            self.assertEqual(missing.exception.status_code, 404)

    def test_selector_payloads_authorize_configured_folders(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            configured_dir = os.path.join(tmpdir, "configured")
            os.makedirs(configured_dir)
            image_path = os.path.join(configured_dir, "image.png")
            write_image(image_path, (4, 4), (255, 0, 0))

            scan_result = scan_folders_payload(
                ScanFoldersPayload(folders=[configured_dir], recursive=False, previous_paths=[]),
                authorized_roots=[configured_dir],
            )
            self.assertEqual([image["path"] for image in scan_result["images"]], [image_path])

            delete_result = delete_images_payload(
                DeleteImagesPayload(paths=[image_path], folders=[configured_dir], recursive=False),
                delete_func=lambda paths, folders, recursive: {
                    "deleted": paths,
                    "missing": [],
                    "skipped": [],
                },
                delete_cache_func=lambda _paths: 0,
                authorized_roots=[configured_dir],
            )
            self.assertEqual(delete_result["deleted"], [image_path])

            paste_result = paste_image_payload(PasteImagePayload(
                destination=configured_dir,
                folders=[configured_dir],
                filename="paste.png",
                content=image_bytes(),
                content_type="image/png",
            ), authorized_roots=[configured_dir])
            self.assertEqual(paste_result["path"], os.path.join(configured_dir, "paste.png"))

    def test_selector_registered_roots_are_server_persisted_and_authorized(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            configured_dir = os.path.join(tmpdir, "configured")
            os.makedirs(configured_dir)
            roots_file = os.path.join(tmpdir, "selector_roots.json")

            with patch.object(selector_services, "SELECTOR_ROOTS_FILE", roots_file), \
                    patch.object(selector_services, "_default_authorized_root_paths", return_value=[]), \
                    patch.dict(os.environ, {selector_services.SELECTOR_ROOTS_ENV: ""}):
                result = register_selector_roots([configured_dir])

                self.assertEqual(result["registered"], [os.path.realpath(configured_dir)])
                self.assertEqual(load_registered_selector_roots(), [os.path.realpath(configured_dir)])
                self.assertEqual(
                    registered_selector_roots_payload()["folders"],
                    [os.path.realpath(configured_dir)],
                )
                self.assertEqual(effective_authorized_roots(), [os.path.realpath(configured_dir)])
                self.assertEqual(
                    authorize_selector_folders([configured_dir], authorized_roots=effective_authorized_roots()),
                    [os.path.abspath(configured_dir)],
                )

                revoked = unregister_selector_root(configured_dir)
                self.assertTrue(revoked["removed"])
                self.assertEqual(load_registered_selector_roots(), [])

    def test_selector_root_registration_rejects_missing_or_relative_folders(self):
        with tempfile.TemporaryDirectory() as tmpdir, \
                patch.object(selector_services, "SELECTOR_ROOTS_FILE", os.path.join(tmpdir, "selector_roots.json")):
            with self.assertRaises(SelectorPathError) as relative:
                register_selector_roots(["relative/path"])
            with self.assertRaises(SelectorPathError) as missing:
                register_selector_roots([os.path.join(tmpdir, "missing")])

            self.assertEqual(relative.exception.status_code, 400)
            self.assertEqual(missing.exception.status_code, 404)

    def test_selector_payloads_reject_unconfigured_folders_outside_server_roots(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root_dir = os.path.join(tmpdir, "root")
            outside_dir = os.path.join(tmpdir, "outside")
            os.makedirs(root_dir)
            os.makedirs(outside_dir)
            outside_path = os.path.join(outside_dir, "image.png")
            write_image(outside_path, (4, 4), (255, 0, 0))

            cases = [
                lambda: scan_folders_payload(
                    ScanFoldersPayload(folders=[outside_dir], recursive=False, previous_paths=[]),
                    authorized_roots=[root_dir],
                ),
                lambda: delete_images_payload(
                    DeleteImagesPayload(paths=[outside_path], folders=[outside_dir], recursive=False),
                    authorized_roots=[root_dir],
                ),
                lambda: paste_image_payload(
                    PasteImagePayload(
                        destination=outside_dir,
                        folders=[outside_dir],
                        filename="paste.png",
                        content=image_bytes(),
                        content_type="image/png",
                    ),
                    authorized_roots=[root_dir],
                ),
                lambda: save_mask_payload(
                    SaveMaskPayload(path=outside_path, mask_data="data:image/png;base64,", privacy=False),
                    authorized_roots=[root_dir],
                ),
                lambda: delete_mask_payload(DeleteMaskPayload(path=outside_path), authorized_roots=[root_dir]),
                lambda: migrate_masks_payload(
                    MigrateMasksPayload(paths=[outside_path], privacy=True),
                    authorized_roots=[root_dir],
                ),
            ]

            for call in cases:
                with self.subTest(call=call):
                    with self.assertRaises(SelectorPathError) as caught:
                        call()
                    self.assertEqual(caught.exception.status_code, 403)

    def test_paste_image_payload_saves_into_configured_root(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            payload = PasteImagePayload(
                destination=tmpdir,
                folders=[tmpdir],
                filename="paste.png",
                content=image_bytes(),
                content_type="image/png",
            )

            result = paste_image_payload(payload, authorized_roots=[tmpdir])

            self.assertEqual(result["status"], "success")
            self.assertEqual(result["name"], "paste.png")
            self.assertEqual(result["image"]["folder"], tmpdir)
            self.assertEqual(result["image"]["image_folder"], tmpdir)
            self.assertTrue(os.path.exists(os.path.join(tmpdir, "paste.png")))

    def test_paste_image_payload_saves_into_configured_child_folder(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            child_dir = os.path.join(tmpdir, "child")
            payload = PasteImagePayload(
                destination=child_dir,
                folders=[tmpdir],
                filename="paste.png",
                content=image_bytes(),
                content_type="image/png",
            )

            result = paste_image_payload(payload, authorized_roots=[tmpdir])

            self.assertEqual(result["image"]["folder"], tmpdir)
            self.assertEqual(result["image"]["image_folder"], child_dir)
            self.assertTrue(os.path.exists(os.path.join(child_dir, "paste.png")))

    def test_paste_image_payload_rejects_destination_outside_configured_folders(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            allowed_dir = os.path.join(tmpdir, "allowed")
            outside_dir = os.path.join(tmpdir, "outside")
            os.makedirs(allowed_dir)

            with self.assertRaisesRegex(ValueError, "outside the configured selector folders"):
                paste_image_payload(PasteImagePayload(
                    destination=outside_dir,
                    folders=[allowed_dir],
                    filename="paste.png",
                    content=image_bytes(),
                    content_type="image/png",
                ), authorized_roots=[tmpdir])

            self.assertFalse(os.path.exists(outside_dir))

    def test_paste_image_payload_rejects_normalized_path_escape(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            allowed_dir = os.path.join(tmpdir, "allowed")
            os.makedirs(allowed_dir)
            escaped_dir = os.path.join(allowed_dir, "..", "outside")

            with self.assertRaisesRegex(ValueError, "outside the configured selector folders"):
                paste_image_payload(PasteImagePayload(
                    destination=escaped_dir,
                    folders=[allowed_dir],
                    filename="paste.png",
                    content=image_bytes(),
                    content_type="image/png",
                ), authorized_roots=[tmpdir])

            self.assertFalse(os.path.exists(os.path.join(tmpdir, "outside")))

    def test_paste_image_payload_rejects_unsupported_extension(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaisesRegex(ValueError, "Unsupported image extension"):
                paste_image_payload(PasteImagePayload(
                    destination=tmpdir,
                    folders=[tmpdir],
                    filename="paste.txt",
                    content=image_bytes(),
                    content_type="image/png",
                ), authorized_roots=[tmpdir])

    def test_paste_image_payload_dedupes_conflicting_filenames(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            original_path = os.path.join(tmpdir, "paste.png")
            write_image(original_path, (4, 4), (0, 0, 255))

            result = paste_image_payload(PasteImagePayload(
                destination=tmpdir,
                folders=[tmpdir],
                filename="paste.png",
                content=image_bytes(color=(255, 0, 0)),
                content_type="image/png",
            ), authorized_roots=[tmpdir])

            self.assertEqual(result["name"], "paste (1).png")
            self.assertTrue(os.path.exists(os.path.join(tmpdir, "paste (1).png")))
            self.assertFalse(result["duplicate"])

    def test_paste_image_payload_reuses_matching_duplicate(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            content = image_bytes(color=(0, 255, 0))
            original_path = os.path.join(tmpdir, "paste.png")
            with open(original_path, "wb") as f:
                f.write(content)

            result = paste_image_payload(PasteImagePayload(
                destination=tmpdir,
                folders=[tmpdir],
                filename="paste.png",
                content=content,
                content_type="image/png",
            ), authorized_roots=[tmpdir])

            self.assertEqual(result["name"], "paste.png")
            self.assertTrue(result["duplicate"])


class NodeSchemaContractTests(unittest.TestCase):
    def test_node_schema_and_execute_contract_are_stable(self):
        node_module = self._import_node_with_fake_comfy_api()

        schema = node_module.HeltoImageSelector.define_schema()
        result = asyncio.run(node_module.HeltoImageSelector.execute(
            "[]",
            "zoom to fit",
            privacy_mode=False,
        ))

        self.assertEqual(schema.node_id, "HeltoImageSelector")
        self.assertEqual(schema.display_name, "Helto Multi-Image Selector")
        self.assertEqual([input_def.id for input_def in schema.inputs], [
            "selected_images",
            "resize_mode",
            "edited_masks",
            "edited_bboxes",
            "batching_mode",
            "privacy_mode",
            "private_execution",
        ])
        self.assertEqual([output_def.id for output_def in schema.outputs], ["images", "image_batch", "masks", "mask_batch", "bboxes"])
        self.assertTrue(schema.outputs[0].is_output_list)
        self.assertFalse(schema.outputs[1].is_output_list)
        self.assertTrue(schema.outputs[2].is_output_list)
        self.assertFalse(schema.outputs[3].is_output_list)
        self.assertTrue(schema.outputs[4].is_output_list)
        self.assertEqual(len(result), 5)
        self.assertEqual(len(result[0]), 1)
        self.assertEqual(tuple(result[0][0].shape), (1, 512, 512, 3))
        self.assertEqual(tuple(result[1].shape), (1, 512, 512, 3))
        self.assertEqual(len(result[2]), 1)
        self.assertEqual(tuple(result[2][0].shape), (1, 512, 512))
        self.assertEqual(tuple(result[3].shape), (1, 512, 512))
        self.assertEqual(result[4], [[[]]])

    def test_node_execute_batched_mode_controls_list_outputs(self):
        node_module = self._import_node_with_fake_comfy_api()

        with tempfile.TemporaryDirectory() as tmpdir:
            first = os.path.join(tmpdir, "first.png")
            second = os.path.join(tmpdir, "second.png")
            write_image(first, (10, 8), (255, 0, 0))
            write_image(second, (4, 6), (0, 255, 0))
            selected = json.dumps([first, second])
            edited_bboxes = json.dumps({
                first: [{"x": 2, "y": 1, "width": 4, "height": 3}],
                second: [{"x": 1, "y": 2, "width": 2, "height": 2}],
            })

            aggregate = asyncio.run(node_module.HeltoImageSelector.execute(
                selected,
                "zoom to fit",
                "{}",
                edited_bboxes,
                False,
                privacy_mode=False,
            ))
            self.assertEqual(len(aggregate[0]), 1)
            self.assertEqual(tuple(aggregate[0][0].shape), (2, 8, 10, 3))
            self.assertEqual(tuple(aggregate[1].shape), (2, 8, 10, 3))
            self.assertEqual(len(aggregate[2]), 1)
            self.assertEqual(tuple(aggregate[2][0].shape), (2, 8, 10))
            self.assertEqual(tuple(aggregate[3].shape), (2, 8, 10))
            self.assertEqual(aggregate[4], [[
                [{"x": 2, "y": 1, "width": 4, "height": 3}],
                [{"x": 2, "y": 3, "width": 6, "height": 2}],
            ]])

            per_image = asyncio.run(node_module.HeltoImageSelector.execute(
                selected,
                "zoom to fit",
                "{}",
                edited_bboxes,
                "true",
                privacy_mode=False,
            ))
            self.assertEqual(len(per_image[0]), 2)
            self.assertEqual([tuple(tensor.shape) for tensor in per_image[0]], [(1, 8, 10, 3), (1, 8, 10, 3)])
            self.assertEqual(tuple(per_image[1].shape), (2, 8, 10, 3))
            self.assertEqual(len(per_image[2]), 2)
            self.assertEqual([tuple(tensor.shape) for tensor in per_image[2]], [(1, 8, 10), (1, 8, 10)])
            self.assertEqual(tuple(per_image[3].shape), (2, 8, 10))
            self.assertEqual(per_image[4], [
                [{"x": 2, "y": 1, "width": 4, "height": 3}],
                [{"x": 2, "y": 3, "width": 6, "height": 2}],
            ])

    def test_batching_mode_boolean_coercion_accepts_saved_widget_values(self):
        node_module = self._import_node_with_fake_comfy_api()

        self.assertFalse(node_module.coerce_batching_mode(None))
        self.assertFalse(node_module.coerce_batching_mode(""))
        self.assertFalse(node_module.coerce_batching_mode("false"))
        self.assertFalse(node_module.coerce_batching_mode(0))
        self.assertTrue(node_module.coerce_batching_mode(True))
        self.assertTrue(node_module.coerce_batching_mode("true"))
        self.assertTrue(node_module.coerce_batching_mode("1"))
        self.assertTrue(node_module.coerce_batching_mode(1))

    def test_selector_fingerprint_changes_when_selected_file_changes(self):
        node_module = self._import_node_with_fake_comfy_api()

        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "selected.png")
            write_image(image_path, (4, 4), (255, 0, 0))
            selected = json.dumps([image_path])

            first = node_module.HeltoImageSelector.fingerprint_inputs(
                selected_images=selected,
                privacy_mode=False,
            )
            stat = os.stat(image_path)
            os.utime(image_path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
            second = node_module.HeltoImageSelector.fingerprint_inputs(
                selected_images=selected,
                privacy_mode=False,
            )

            self.assertNotEqual(first, second)

    def test_selector_fingerprint_changes_when_edited_mask_cache_changes(self):
        node_module = self._import_node_with_fake_comfy_api()

        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = os.path.join(tmpdir, "selected.png")
            plain_mask = os.path.join(tmpdir, "mask.png")
            encrypted_mask = os.path.join(tmpdir, "mask.png.enc")
            write_image(image_path, (4, 4), (255, 0, 0))
            selected = json.dumps([image_path])
            edited_masks = json.dumps({image_path: {"key": "mask"}})

            with patch.dict(
                node_module.HeltoImageSelector.fingerprint_inputs.__func__.__globals__,
                {"mask_cache_paths": lambda _path: (plain_mask, encrypted_mask)},
            ):
                first = node_module.HeltoImageSelector.fingerprint_inputs(
                    selected_images=selected,
                    edited_masks=edited_masks,
                    privacy_mode=False,
                )
                Path(plain_mask).write_bytes(b"mask")
                second = node_module.HeltoImageSelector.fingerprint_inputs(
                    selected_images=selected,
                    edited_masks=edited_masks,
                    privacy_mode=False,
                )

            self.assertNotEqual(first, second)

    def test_registered_node_display_names_are_helto_prefixed(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()

        node_classes = asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
        schemas = [node_cls.define_schema() for node_cls in node_classes]

        self.assertEqual(len(schemas), 12)
        self.assertEqual(
            [schema.node_id for schema in schemas],
            [
                "HeltoVideoParams",
                "HeltoVideoParamsLTX",
                "AspectRatioCalculator",
                "ModelAutoRouter",
                "HeltoPromptEnhancer",
                "HeltoPrivacyShowAny",
                "HeltoImageComparer",
                "HeltoVideoComparer",
                "HeltoLoadVideo",
                "HeltoImageSelector",
                "HeltoSaveImageAdvanced",
                "HeltoSaveVideoAdvanced",
            ],
        )
        display_names = [schema.display_name for schema in schemas]
        self.assertIn("Prompt enhancer", display_names)
        self.assertTrue(all(name.startswith("Helto ") or name == "Prompt enhancer" for name in display_names))
        prompt_enhancer_schema = next(schema for schema in schemas if schema.node_id == "HeltoPromptEnhancer")
        prompt_enhancer_seed_input = next(input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "seed")
        prompt_enhancer_model_input = next(input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "model")
        prompt_enhancer_provider_input = next(input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "provider")
        prompt_enhancer_model_id_input = next(input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "model_id")
        prompt_enhancer_model_history_input = next(
            input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "provider_model_history"
        )
        prompt_enhancer_variables_input = next(input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "variables")
        prompt_enhancer_image_preset_input = next(
            input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "image_system_prompt_preset"
        )
        prompt_enhancer_video_preset_input = next(
            input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "video_system_prompt_preset"
        )
        prompt_enhancer_script_input = next(input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "script")
        prompt_enhancer_external_prompt_input = next(
            input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "external_prompt"
        )
        prompt_enhancer_clip_input = next(input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "clip")
        prompt_enhancer_segment_input = next(
            input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "active_segment_index"
        )
        prompt_enhancer_segment_mode_input = next(
            input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "segment_generation_mode"
        )
        prompt_enhancer_vision_mode_input = next(
            input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "vision_context_mode"
        )
        prompt_enhancer_vision_provider_input = next(
            input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "vision_provider"
        )
        prompt_enhancer_keep_alive_unit_input = next(
            input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "ollama_keep_alive_unit"
        )
        prompt_enhancer_max_tokens_input = next(
            input_def for input_def in prompt_enhancer_schema.inputs if input_def.id == "generation_max_tokens"
        )
        self.assertEqual(prompt_enhancer_seed_input.kwargs["io_kind"], "Int")
        self.assertEqual(prompt_enhancer_seed_input.kwargs["default"], -1)
        self.assertEqual(prompt_enhancer_seed_input.kwargs["min"], -1)
        self.assertEqual(prompt_enhancer_seed_input.kwargs["control_after_generate"], "randomize")
        self.assertEqual(prompt_enhancer_model_input.kwargs["io_kind"], "String")
        self.assertEqual(prompt_enhancer_provider_input.kwargs["io_kind"], "String")
        self.assertEqual(prompt_enhancer_model_id_input.kwargs["io_kind"], "String")
        self.assertEqual(prompt_enhancer_model_history_input.kwargs["io_kind"], "String")
        self.assertEqual(prompt_enhancer_model_history_input.kwargs["default"], "{}")
        self.assertEqual(prompt_enhancer_variables_input.kwargs["io_kind"], "String")
        self.assertEqual(prompt_enhancer_image_preset_input.kwargs["io_kind"], "String")
        self.assertEqual(prompt_enhancer_image_preset_input.kwargs["default"], "default")
        self.assertEqual(prompt_enhancer_video_preset_input.kwargs["io_kind"], "String")
        self.assertEqual(prompt_enhancer_video_preset_input.kwargs["default"], "default")
        self.assertEqual(prompt_enhancer_script_input.kwargs["io_kind"], "String")
        self.assertTrue(prompt_enhancer_script_input.kwargs["multiline"])
        self.assertEqual(prompt_enhancer_external_prompt_input.kwargs["io_kind"], "String")
        self.assertEqual(prompt_enhancer_external_prompt_input.kwargs["default"], "")
        self.assertTrue(prompt_enhancer_external_prompt_input.kwargs["optional"])
        self.assertTrue(prompt_enhancer_external_prompt_input.kwargs["force_input"])
        self.assertFalse(prompt_enhancer_external_prompt_input.kwargs["dynamic_prompts"])
        self.assertEqual(prompt_enhancer_clip_input.kwargs["io_kind"], "Clip")
        self.assertTrue(prompt_enhancer_clip_input.kwargs["optional"])
        self.assertEqual(prompt_enhancer_segment_input.kwargs["io_kind"], "Int")
        self.assertEqual(prompt_enhancer_segment_input.kwargs["default"], 1)
        self.assertEqual(prompt_enhancer_segment_mode_input.kwargs["io_kind"], "Combo")
        self.assertEqual(prompt_enhancer_segment_mode_input.kwargs["options"], ["all segments", "single segment"])
        self.assertEqual(prompt_enhancer_segment_mode_input.kwargs["default"], "all segments")
        self.assertEqual(prompt_enhancer_vision_mode_input.kwargs["io_kind"], "Combo")
        self.assertEqual(
            prompt_enhancer_vision_mode_input.kwargs["options"],
            ["auto", "direct to writer", "separate vision model", "off"],
        )
        self.assertEqual(prompt_enhancer_vision_mode_input.kwargs["default"], "auto")
        self.assertEqual(prompt_enhancer_vision_provider_input.kwargs["default"], "local_transformers_vlm")
        self.assertEqual(prompt_enhancer_keep_alive_unit_input.kwargs["options"], ["seconds", "minutes", "hours"])
        self.assertEqual(prompt_enhancer_max_tokens_input.kwargs["io_kind"], "Int")
        self.assertEqual(prompt_enhancer_max_tokens_input.kwargs["default"], 0)
        self.assertEqual(prompt_enhancer_max_tokens_input.kwargs["min"], 0)
        self.assertEqual(prompt_enhancer_max_tokens_input.kwargs["max"], 4096)
        self.assertEqual(len(prompt_enhancer_schema.hidden), 1)
        self.assertEqual(
            [output_def.id for output_def in prompt_enhancer_schema.outputs],
            [
                "enhanced_prompt",
                "system_prompt",
                "resolved_segment_prompt",
                "parsed_direction",
                "parsed_continuity",
                "reference_mode",
                "image_notes",
                "visual_context",
                "segment_count",
                "warnings",
            ],
        )

    def test_prompt_enhancer_fingerprint_disables_cache_for_negative_seed_and_tracks_presets(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )

        globals_ = prompt_node.fingerprint_inputs.__func__.__globals__
        with patch.dict(globals_, {"load_system_prompt": lambda kind, preset_id: f"{kind}:{preset_id}:v1"}):
            first = prompt_node.fingerprint_inputs(
                seed=42,
                image_system_prompt_preset="portrait",
                video_system_prompt_preset="cinematic",
            )
            second = prompt_node.fingerprint_inputs(
                seed=42,
                image_system_prompt_preset="portrait",
                video_system_prompt_preset="cinematic",
            )
            self.assertTrue(prompt_node.fingerprint_inputs(seed=-1) != prompt_node.fingerprint_inputs(seed=-1))
            self.assertEqual(first, second)

        with patch.dict(globals_, {"load_system_prompt": lambda kind, preset_id: f"{kind}:{preset_id}:v2"}):
            changed = prompt_node.fingerprint_inputs(
                seed=42,
                image_system_prompt_preset="portrait",
                video_system_prompt_preset="cinematic",
            )
        self.assertNotEqual(first, changed)

    def test_save_image_advanced_appends_save_image_toggle(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()

        schema = extension_module.SaveImageAdvanced.define_schema()

        self.assertEqual(
            [input_def.id for input_def in schema.inputs],
            [
                "images",
                "folder",
                "alternative_folder",
                "use_alternative_folder",
                "use_date_folder",
                "subfolder",
                "filename_prefix",
                "pause_mode",
                "privacy_mode",
                "save_image",
                "release_token",
            ],
        )
        save_image_input = next(input_def for input_def in schema.inputs if input_def.id == "save_image")
        self.assertEqual(save_image_input.display_name, "save image")
        self.assertTrue(save_image_input.kwargs["default"])
        release_input = schema.inputs[-1]
        self.assertEqual(release_input.id, "release_token")
        self.assertTrue(release_input.kwargs["optional"])
        self.assertTrue(release_input.kwargs["extra_dict"]["hidden"])
        self.assertEqual([output_def.id for output_def in schema.outputs], ["images", "width", "height"])

    def test_image_comparer_accepts_optional_images_and_masks(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()

        schema = extension_module.ImageComparer.define_schema()

        self.assertEqual(
            [input_def.id for input_def in schema.inputs],
            ["original", "new", "original_mask", "new_mask", "privacy_mode"],
        )
        optional_inputs = {input_def.id: input_def.kwargs.get("optional") for input_def in schema.inputs}
        self.assertTrue(optional_inputs["original"])
        self.assertTrue(optional_inputs["new"])
        self.assertTrue(optional_inputs["original_mask"])
        self.assertTrue(optional_inputs["new_mask"])
        self.assertFalse(optional_inputs["privacy_mode"])

    def test_image_comparer_masks_image_preview_before_saving(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        module_globals = extension_module.ImageComparer.execute.__func__.__globals__
        saved = []

        def fake_save_images(images, filename_prefix, **_kwargs):
            saved.append((filename_prefix, images.clone()))
            return [{"filename": filename_prefix, "type": "temp", "subfolder": ""}]

        module_globals["ui"].ImageSaveHelper.save_images = fake_save_images
        image = torch.ones((1, 2, 2, 3), dtype=torch.float32)
        mask = torch.tensor([[[0.0, 1.0], [0.0, 0.0]]], dtype=torch.float32)

        result = asyncio.run(extension_module.ImageComparer.execute(
            original=image,
            original_mask=mask,
            privacy_mode=False,
        ))

        self.assertEqual(result.kwargs["ui"]["b_images"], [])
        self.assertEqual(saved[0][0], "helto.compare.original")
        preview = saved[0][1]
        self.assertEqual(tuple(preview.shape), (1, 2, 2, 3))
        self.assertEqual(float(preview[0, 0, 0, 0]), 1.0)
        self.assertEqual(float(preview[0, 0, 1, 0]), 0.0)

    def test_image_comparer_outputs_mask_preview_when_image_missing(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        module_globals = extension_module.ImageComparer.execute.__func__.__globals__
        saved = []

        def fake_save_images(images, filename_prefix, **_kwargs):
            saved.append((filename_prefix, images.clone()))
            return [{"filename": filename_prefix, "type": "temp", "subfolder": ""}]

        module_globals["ui"].ImageSaveHelper.save_images = fake_save_images
        mask = torch.tensor([[0.0, 1.0], [0.25, 0.5]], dtype=torch.float32)

        result = asyncio.run(extension_module.ImageComparer.execute(
            new_mask=mask,
            privacy_mode=False,
        ))

        self.assertEqual(result.kwargs["ui"]["a_images"], [])
        self.assertEqual(saved[0][0], "helto.compare.new")
        preview = saved[0][1]
        self.assertEqual(tuple(preview.shape), (1, 2, 2, 3))
        self.assertTrue(torch.equal(preview[0, :, :, 0], mask))
        self.assertTrue(torch.equal(preview[0, :, :, 1], mask))
        self.assertTrue(torch.equal(preview[0, :, :, 2], mask))

    def test_custom_node_style_import_does_not_require_top_level_selector_package(self):
        extension_module = self._import_extension_with_fake_comfy_runtime(isolate_custom_node_root=True)

        node_classes = asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())

        self.assertIn(
            "HeltoPromptEnhancer",
            [node_cls.define_schema().node_id for node_cls in node_classes],
        )

    def test_privacy_show_any_converts_supported_values_to_text(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()

        text_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPrivacyShowAny"
        )
        schema = text_node.define_schema()
        with isolated_privacy_keystore():
            result = text_node.execute({"prompt": "hello", "steps": 4, "flags": [True, None]})
            decrypted_ui_text = PrivacyEnvelopeCodec("helto.comfyui-utils").decrypt_state(
                result.kwargs["ui"]["helto_privacy_show_any"][0]["protected"]
            )["value"]

        self.assertEqual(schema.display_name, "Helto Privacy Show Any")
        self.assertEqual([input_def.id for input_def in schema.inputs], ["input", "encrypted_text_state"])
        self.assertEqual([output_def.id for output_def in schema.outputs], ["text"])
        self.assertTrue(schema.kwargs["is_output_node"])
        self.assertIn('"prompt": "hello"', result[0])
        ui_record = result.kwargs["ui"]["helto_privacy_show_any"][0]
        self.assertNotIn("text", ui_record)
        self.assertNotIn("hello", ui_record["protected"])
        self.assertEqual(decrypted_ui_text, result[0])

    def test_prompt_enhancer_sends_substituted_prompt_to_provider(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        requests = []

        class FakeRegistry:
            def generate(self, request, progress=None):
                requests.append(request)
                self.progress = progress
                return request.prompt

        globals_["PromptProviderRegistry"] = FakeRegistry
        try:
            result = prompt_node.execute(
                    privacy_mode=False,
                    seed=11,
                    generation_max_tokens=77,
                    prompt_type="image",
                    active_segment_index=999,
                    segment_generation_mode="single segment",
                    script="A {{style}} portrait",
                    external_prompt="   ",
                    variables=json.dumps([
                        {"name": "style", "mode": "fixed", "values": ["documentary"], "fixed_index": 0}
                    ]),
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider

        self.assertEqual(result[0], "A documentary portrait")
        self.assertEqual(result[2], "A documentary portrait")
        self.assertEqual(requests[0].prompt, "A documentary portrait")
        self.assertEqual(requests[0].max_tokens, 77)

    def test_prompt_enhancer_external_prompt_overrides_script_and_substitutes_variables(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        requests = []

        class FakeRegistry:
            def generate(self, request, progress=None):
                requests.append(request)
                return request.prompt

        globals_["PromptProviderRegistry"] = FakeRegistry
        try:
            result = prompt_node.execute(
                    privacy_mode=False,
                    seed=11,
                    prompt_type="image",
                    script="Internal {{style}} portrait",
                    external_prompt=" External {{style}} storyboard ",
                    variables=json.dumps([
                        {"name": "style", "mode": "fixed", "values": ["documentary"], "fixed_index": 0}
                    ]),
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider

        self.assertEqual(result[0], "External documentary storyboard")
        self.assertEqual(result[2], "External documentary storyboard")
        self.assertEqual(requests[0].prompt, "External documentary storyboard")

    def test_prompt_enhancer_connected_clip_overrides_writer_provider_settings(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]

        class FailingRegistry:
            def generate(self, request, progress=None):
                raise AssertionError("provider registry should not generate when clip is connected")

        class FakeClip:
            def __init__(self):
                self.tokenized_text = None
                self.generate_kwargs = None

            def tokenize(self, text):
                self.tokenized_text = text
                return {"tokens": text}

            def generate(self, tokens, **kwargs):
                self.generate_kwargs = kwargs
                self.generated_tokens = tokens
                return ["generated-ids"]

            def decode(self, token_ids):
                self.decoded_ids = token_ids
                return " clip enhanced prompt "

        clip = FakeClip()
        globals_["PromptProviderRegistry"] = FailingRegistry
        try:
            result = prompt_node.execute(
                privacy_mode=False,
                clip=clip,
                seed=42,
                generation_max_tokens=64,
                prompt_type="image",
                script="Create a moody portrait",
                provider="ollama",
                model="mistral:latest",
                model_id="mistral:latest",
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider

        self.assertEqual(result[0], "clip enhanced prompt")
        self.assertIn("User prompt:\nCreate a moody portrait", clip.tokenized_text)
        self.assertEqual(clip.generate_kwargs["max_length"], 64)
        self.assertEqual(clip.generate_kwargs["seed"], 42)
        self.assertFalse(clip.generate_kwargs["do_sample"])
        self.assertEqual(clip.decoded_ids, ["generated-ids"])

    def test_prompt_enhancer_connected_clip_generates_each_video_segment(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]

        class FailingRegistry:
            def generate(self, request, progress=None):
                raise AssertionError("provider registry should not generate when clip is connected")

        class FakeClip:
            def __init__(self):
                self.prompts = []
                self.generated = 0

            def tokenize(self, text):
                self.prompts.append(text)
                return {"tokens": text}

            def generate(self, tokens, **kwargs):
                self.generated += 1
                return [self.generated]

            def decode(self, token_ids):
                return f"clip generated {token_ids[0]}"

        clip = FakeClip()
        globals_["PromptProviderRegistry"] = FailingRegistry
        try:
            result = prompt_node.execute(
                privacy_mode=False,
                clip=clip,
                seed=7,
                generation_max_tokens=0,
                prompt_type="video",
                segment_generation_mode="all segments",
                vision_context_mode="off",
                script="First beat.\n---\nSecond beat.",
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider

        self.assertEqual(clip.generated, 2)
        self.assertEqual(len(clip.prompts), 2)
        self.assertIn("Segment: 1 of 2", clip.prompts[0])
        self.assertIn("Segment: 2 of 2", clip.prompts[1])
        self.assertEqual(result[0], "clip generated 1\n\nclip generated 2")

    def test_prompt_enhancer_connected_clip_auto_uses_separate_vision_context(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        original_encode = globals_["encode_images_for_ollama"]
        original_support = globals_["provider_model_supports_images"]
        vision_requests = []

        class FakeRegistry:
            def generate(self, request, progress=None):
                raise AssertionError("writer provider should not generate when clip is connected")

            def generate_visual_context(self, request, progress=None):
                vision_requests.append(request)
                return "rain-soaked neon portrait reference"

        class FakeClip:
            def __init__(self):
                self.tokenized_text = None

            def tokenize(self, text):
                self.tokenized_text = text
                return {"tokens": text}

            def generate(self, tokens, **kwargs):
                return ["clip-output"]

            def decode(self, token_ids):
                return "final clip prompt"

        clip = FakeClip()
        globals_["PromptProviderRegistry"] = FakeRegistry
        globals_["encode_images_for_ollama"] = lambda *args, **kwargs: ["encoded-image-1"]
        globals_["provider_model_supports_images"] = lambda provider, model_id, backend="": model_id == "qwen3_vl_4b_fast"
        try:
            result = prompt_node.execute(
                privacy_mode=False,
                clip=clip,
                images=[object()],
                prompt_type="image",
                vision_context_mode="auto",
                script="Create a cinematic portrait",
                provider="ollama",
                model="llava:latest",
                model_id="llava:latest",
                vision_provider="local_transformers_vlm",
                vision_model_id="qwen3_vl_4b_fast",
                vision_model_backend="qwen",
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider
            globals_["encode_images_for_ollama"] = original_encode
            globals_["provider_model_supports_images"] = original_support

        self.assertEqual(len(vision_requests), 1)
        self.assertEqual(vision_requests[0].images, ["encoded-image-1"])
        self.assertIn("Visual context: rain-soaked neon portrait reference", clip.tokenized_text)
        self.assertEqual(result[0], "final clip prompt")
        self.assertEqual(result[7], "rain-soaked neon portrait reference")

    def test_prompt_enhancer_connected_clip_requires_text_generation_methods(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )

        with self.assertRaisesRegex(RuntimeError, "Connected CLIP input must support ComfyUI text generation"):
            prompt_node.execute(
                privacy_mode=False,
                clip=object(),
                prompt_type="image",
                script="A quiet forest",
            )

    def test_prompt_enhancer_video_script_sends_selected_segment_to_provider(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        requests = []

        class FakeRegistry:
            def generate(self, request, progress=None):
                requests.append(request)
                return request.prompt

        script = """[rating=SFW]
[style=cinematic realism]

## First beat. @image1:start
---
[reference_mode=end_guidance]
> > First beat ends with the character looking up.
Second beat moves toward the doorway. @image1:end
"""

        globals_["PromptProviderRegistry"] = FakeRegistry
        try:
            result = prompt_node.execute(
                privacy_mode=False,
                seed=7,
                images=[object()],
                prompt_type="multi scene video",
                active_segment_index=2,
                segment_generation_mode="single segment",
                script="This editor script should be ignored.",
                external_prompt=script,
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider

        self.assertIn("Second beat moves toward the doorway.", result[0])
        self.assertIn("Generate exactly one SFW video prompt for segment 2 of 2", result[1])
        self.assertIn("Second beat moves toward the doorway.", result[2])
        self.assertEqual(result[3], "Second beat moves toward the doorway.")
        self.assertIn("First beat ends", result[4])
        self.assertEqual(result[5], "end_guidance")
        self.assertIn("Image 1 is used as end guidance", result[6])
        self.assertEqual(result[7], "")
        self.assertEqual(result[8], 2)
        self.assertEqual(requests[0].prompt_type, "multi scene video")

    def test_prompt_enhancer_video_script_can_generate_all_segments(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        requests = []

        class FakeRegistry:
            def generate(self, request, progress=None):
                requests.append(request)
                return f"generated {len(requests)}:\n{request.prompt}"

        script = """[rating=SFW]
[style=cinematic realism]

## First beat. @image1:start
---
[reference_mode=end_guidance]
> > First beat ends with the character looking up.
Second beat moves toward the doorway. @image1:end
"""

        globals_["PromptProviderRegistry"] = FakeRegistry
        try:
            result = prompt_node.execute(
                privacy_mode=False,
                seed=7,
                images=[object()],
                prompt_type="video",
                active_segment_index=99,
                segment_generation_mode="all segments",
                script=script,
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider

        self.assertEqual(len(requests), 2)
        self.assertEqual([request.seed for request in requests], [7, 7])
        self.assertEqual([request.prompt_type for request in requests], ["video", "video"])
        self.assertIn("Segment: 1 of 2", requests[0].prompt)
        self.assertIn("Segment: 2 of 2", requests[1].prompt)
        self.assertIn("Generate exactly one SFW video prompt for segment 1 of 2", requests[0].system_prompt)
        self.assertIn("Generate exactly one SFW video prompt for segment 2 of 2", requests[1].system_prompt)
        self.assertEqual(result[0].count("generated "), 2)
        self.assertIn("\n\n", result[0])
        self.assertIn("First beat.", result[2])
        self.assertIn("Second beat moves toward the doorway.", result[2])
        self.assertEqual(result[3], "First beat.\n\nSecond beat moves toward the doorway.")
        self.assertIn("First beat ends", result[4])
        self.assertEqual(result[5], "start_frame\n\nend_guidance")
        self.assertIn("Image 1 is used as the starting frame", result[6])
        self.assertIn("Image 1 is used as end guidance", result[6])
        self.assertEqual(result[7], "")
        self.assertEqual(result[8], 2)

    def test_prompt_enhancer_progress_counts_all_segment_writer_calls(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        original_progress = globals_["PromptEnhancerProgress"]
        progress_instances = []

        class TrackingProgress:
            def __init__(self, unique_id=None):
                self.unique_id = unique_id
                self.model_call_total = None
                self.model_calls = 0
                self.completed = False
                progress_instances.append(self)

            def phase_start(self, phase):
                pass

            def phase_done(self, phase):
                pass

            def begin_model_calls(self, total):
                self.model_call_total = total

            def model_call(self):
                return self

            def __enter__(self):
                self.model_calls += 1
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def complete(self):
                self.completed = True

        class FakeRegistry:
            def generate(self, request, progress=None):
                return request.prompt

        globals_["PromptProviderRegistry"] = FakeRegistry
        globals_["PromptEnhancerProgress"] = TrackingProgress
        try:
            prompt_node.execute(
                privacy_mode=False,
                seed=7,
                prompt_type="video",
                segment_generation_mode="all segments",
                vision_context_mode="off",
                script="First beat.\n---\nSecond beat.\n---\nThird beat.",
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider
            globals_["PromptEnhancerProgress"] = original_progress

        progress = progress_instances[0]
        self.assertEqual(progress.model_call_total, 3)
        self.assertEqual(progress.model_calls, 3)
        self.assertTrue(progress.completed)

    def test_prompt_enhancer_progress_counts_separate_vision_and_writer_calls(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        original_progress = globals_["PromptEnhancerProgress"]
        original_encode = globals_["encode_images_for_ollama"]
        original_support = globals_["provider_model_supports_images"]
        progress_instances = []

        class TrackingProgress:
            def __init__(self, unique_id=None):
                self.model_call_total = None
                self.model_calls = 0
                progress_instances.append(self)

            def phase_start(self, phase):
                pass

            def phase_done(self, phase):
                pass

            def begin_model_calls(self, total):
                self.model_call_total = total

            def model_call(self):
                return self

            def __enter__(self):
                self.model_calls += 1
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def complete(self):
                pass

        class FakeRegistry:
            def generate(self, request, progress=None):
                return request.prompt

            def generate_visual_context(self, request, progress=None):
                return "visual context"

        globals_["PromptProviderRegistry"] = FakeRegistry
        globals_["PromptEnhancerProgress"] = TrackingProgress
        globals_["encode_images_for_ollama"] = lambda *args, **kwargs: ["encoded-image-1", "encoded-image-2"]
        globals_["provider_model_supports_images"] = lambda provider, model_id, backend="": model_id == "qwen3_vl_4b_fast"
        try:
            prompt_node.execute(
                privacy_mode=False,
                seed=7,
                images=[object(), object()],
                prompt_type="video",
                segment_generation_mode="all segments",
                vision_context_mode="separate vision model",
                script="First beat. @image1\n---\nSecond beat. @image2\n---\nThird beat. @image1",
                vision_provider="local_transformers_vlm",
                vision_model_id="qwen3_vl_4b_fast",
                vision_model_backend="qwen",
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider
            globals_["PromptEnhancerProgress"] = original_progress
            globals_["encode_images_for_ollama"] = original_encode
            globals_["provider_model_supports_images"] = original_support

        progress = progress_instances[0]
        self.assertEqual(progress.model_call_total, 6)
        self.assertEqual(progress.model_calls, 6)

    def test_prompt_enhancer_progress_counts_image_mode_vision_once(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        original_progress = globals_["PromptEnhancerProgress"]
        original_encode = globals_["encode_images_for_ollama"]
        original_support = globals_["provider_model_supports_images"]
        progress_instances = []

        class TrackingProgress:
            def __init__(self, unique_id=None):
                self.model_call_total = None
                self.model_calls = 0
                progress_instances.append(self)

            def phase_start(self, phase):
                pass

            def phase_done(self, phase):
                pass

            def begin_model_calls(self, total):
                self.model_call_total = total

            def model_call(self):
                return self

            def __enter__(self):
                self.model_calls += 1
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def complete(self):
                pass

        class FakeRegistry:
            def generate(self, request, progress=None):
                return request.prompt

            def generate_visual_context(self, request, progress=None):
                return "visual context"

        globals_["PromptProviderRegistry"] = FakeRegistry
        globals_["PromptEnhancerProgress"] = TrackingProgress
        globals_["encode_images_for_ollama"] = lambda *args, **kwargs: ["encoded-image-1", "encoded-image-2"]
        globals_["provider_model_supports_images"] = lambda provider, model_id, backend="": model_id == "qwen3_vl_4b_fast"
        try:
            prompt_node.execute(
                privacy_mode=False,
                images=[object(), object()],
                prompt_type="image",
                vision_context_mode="separate vision model",
                script="Create a polished portrait",
                provider="ollama",
                model="mistral:latest",
                model_id="mistral:latest",
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider
            globals_["PromptEnhancerProgress"] = original_progress
            globals_["encode_images_for_ollama"] = original_encode
            globals_["provider_model_supports_images"] = original_support

        progress = progress_instances[0]
        self.assertEqual(progress.model_call_total, 2)
        self.assertEqual(progress.model_calls, 2)

    def test_prompt_enhancer_video_single_segment_validates_active_index(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )

        with self.assertRaisesRegex(ValueError, "outside the available segment range"):
            prompt_node.execute(
                privacy_mode=False,
                prompt_type="video",
                active_segment_index=2,
                segment_generation_mode="single segment",
                script="Only beat.",
            )

    def test_prompt_enhancer_direct_vision_sends_referenced_images_to_writer(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        original_encode = globals_["encode_images_for_ollama"]
        original_support = globals_["provider_model_supports_images"]
        writer_requests = []
        vision_requests = []

        class FakeRegistry:
            def generate(self, request, progress=None):
                writer_requests.append(request)
                return request.prompt

            def generate_visual_context(self, request, progress=None):
                vision_requests.append(request)
                return "visual context"

        globals_["PromptProviderRegistry"] = FakeRegistry
        globals_["encode_images_for_ollama"] = lambda *args, **kwargs: ["encoded-image-1", "encoded-image-2"]
        globals_["provider_model_supports_images"] = lambda provider, model_id, backend="": model_id == "qwen3_vl_4b_fast"
        try:
            result = prompt_node.execute(
                privacy_mode=False,
                seed=3,
                images=[object(), object()],
                prompt_type="video",
                vision_context_mode="direct to writer",
                segment_generation_mode="single segment",
                script="A match cut. @image2:end @image2:end",
                model="llava:latest",
                model_id="llava:latest",
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider
            globals_["encode_images_for_ollama"] = original_encode
            globals_["provider_model_supports_images"] = original_support

        self.assertEqual(len(writer_requests), 1)
        self.assertEqual(vision_requests, [])
        self.assertEqual(writer_requests[0].images, ["encoded-image-2"])
        self.assertEqual(result[7], "")

    def test_prompt_enhancer_direct_vision_describe_modifier_guides_writer(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        original_encode = globals_["encode_images_for_ollama"]
        original_support = globals_["provider_model_supports_images"]
        writer_requests = []

        class FakeRegistry:
            def generate(self, request, progress=None):
                writer_requests.append(request)
                return request.prompt

            def generate_visual_context(self, request, progress=None):
                raise AssertionError("direct writer mode should not call separate vision")

        globals_["PromptProviderRegistry"] = FakeRegistry
        globals_["encode_images_for_ollama"] = lambda *args, **kwargs: ["encoded-image-1", "encoded-image-2"]
        globals_["provider_model_supports_images"] = lambda provider, model_id, backend="": True
        try:
            result = prompt_node.execute(
                privacy_mode=False,
                seed=3,
                images=[object(), object()],
                prompt_type="video",
                vision_context_mode="direct to writer",
                segment_generation_mode="single segment",
                script="A dog runs beside the woman. @image2:character:describe",
                model="llava:latest",
                model_id="llava:latest",
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider
            globals_["encode_images_for_ollama"] = original_encode
            globals_["provider_model_supports_images"] = original_support

        self.assertEqual(writer_requests[0].images, ["encoded-image-2"])
        self.assertIn("Image 2 requests :describe for the character role.", writer_requests[0].prompt)
        self.assertNotIn("persistent identity traits", writer_requests[0].prompt)
        self.assertIn("Visually introduce the referenced subject before the action", writer_requests[0].system_prompt)
        self.assertIn("describe the subject before any action", writer_requests[0].system_prompt)
        self.assertIn("For described people", writer_requests[0].system_prompt)
        self.assertIn("For described animals", writer_requests[0].system_prompt)
        self.assertIn("treat the referenced image as the source of truth", writer_requests[0].system_prompt)
        self.assertIn("Image 2 requests :describe for the character role.", result[2])

    def test_prompt_enhancer_auto_uses_separate_vision_for_text_only_writer(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        original_encode = globals_["encode_images_for_ollama"]
        original_support = globals_["provider_model_supports_images"]
        writer_requests = []
        vision_requests = []

        class FakeRegistry:
            def generate(self, request, progress=None):
                writer_requests.append(request)
                return request.prompt

            def generate_visual_context(self, request, progress=None):
                vision_requests.append(request)
                return "subject raises one hand while rain falls"

        globals_["PromptProviderRegistry"] = FakeRegistry
        globals_["encode_images_for_ollama"] = lambda *args, **kwargs: ["encoded-image-1", "encoded-image-2"]
        globals_["provider_model_supports_images"] = lambda provider, model_id, backend="": model_id == "qwen3_vl_4b_fast"
        try:
            result = prompt_node.execute(
                privacy_mode=False,
                seed=3,
                generation_max_tokens=256,
                images=[object(), object()],
                prompt_type="video",
                vision_context_mode="auto",
                segment_generation_mode="single segment",
                script="The subject turns toward camera. @image1:character",
                provider="ollama",
                model="AutumnAurelium/llama3.1-abliterated:latest",
                model_id="AutumnAurelium/llama3.1-abliterated:latest",
                vision_provider="local_transformers_vlm",
                vision_model_id="qwen3_vl_4b_fast",
                vision_model_backend="qwen",
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider
            globals_["encode_images_for_ollama"] = original_encode
            globals_["provider_model_supports_images"] = original_support

        self.assertEqual(len(vision_requests), 1)
        self.assertEqual(vision_requests[0].images, ["encoded-image-1"])
        self.assertEqual(vision_requests[0].max_tokens, 0)
        self.assertEqual(len(writer_requests), 1)
        self.assertEqual(writer_requests[0].images, [])
        self.assertEqual(writer_requests[0].max_tokens, 256)
        self.assertIn("Visual context: subject raises one hand", writer_requests[0].prompt)
        self.assertEqual(result[7], "subject raises one hand while rain falls")

    def test_prompt_enhancer_separate_vision_describe_modifier_guides_vision_prompt(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        original_encode = globals_["encode_images_for_ollama"]
        original_support = globals_["provider_model_supports_images"]
        writer_requests = []
        vision_requests = []

        class FakeRegistry:
            def generate(self, request, progress=None):
                writer_requests.append(request)
                return request.prompt

            def generate_visual_context(self, request, progress=None):
                vision_requests.append(request)
                return "a medium white dog with fluffy fur and dark eyes"

        globals_["PromptProviderRegistry"] = FakeRegistry
        globals_["encode_images_for_ollama"] = lambda *args, **kwargs: ["encoded-image-1", "encoded-image-2"]
        globals_["provider_model_supports_images"] = lambda provider, model_id, backend="": model_id == "qwen3_vl_4b_fast"
        try:
            result = prompt_node.execute(
                privacy_mode=False,
                seed=3,
                images=[object(), object()],
                prompt_type="video",
                vision_context_mode="separate vision model",
                segment_generation_mode="single segment",
                script="A dog runs beside the woman. @image2:character:describe",
                provider="ollama",
                model="AutumnAurelium/llama3.1-abliterated:latest",
                model_id="AutumnAurelium/llama3.1-abliterated:latest",
                vision_provider="local_transformers_vlm",
                vision_model_id="qwen3_vl_4b_fast",
                vision_model_backend="qwen",
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider
            globals_["encode_images_for_ollama"] = original_encode
            globals_["provider_model_supports_images"] = original_support

        self.assertEqual(vision_requests[0].images, ["encoded-image-2"])
        self.assertIn("Image 2 requests :describe for the character role.", vision_requests[0].prompt)
        self.assertIn("Visually introduce the referenced subject before the action", vision_requests[0].prompt)
        self.assertIn("describe the subject before any action", vision_requests[0].prompt)
        self.assertIn("For described people", vision_requests[0].prompt)
        self.assertIn("For described animals", vision_requests[0].prompt)
        self.assertIn("treat the referenced image as the source of truth", vision_requests[0].prompt)
        self.assertEqual(writer_requests[0].images, [])
        self.assertIn("Visual context: a medium white dog", writer_requests[0].prompt)
        self.assertEqual(result[7], "a medium white dog with fluffy fur and dark eyes")

    def test_prompt_enhancer_image_mode_uses_all_images_for_separate_vision(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        prompt_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPromptEnhancer"
        )
        globals_ = prompt_node.execute.__func__.__globals__
        original_provider = globals_["PromptProviderRegistry"]
        original_encode = globals_["encode_images_for_ollama"]
        original_support = globals_["provider_model_supports_images"]
        writer_requests = []
        vision_requests = []

        class FakeRegistry:
            def generate(self, request, progress=None):
                writer_requests.append(request)
                return request.prompt

            def generate_visual_context(self, request, progress=None):
                vision_requests.append(request)
                return "two reference portraits with warm studio lighting"

        globals_["PromptProviderRegistry"] = FakeRegistry
        globals_["encode_images_for_ollama"] = lambda *args, **kwargs: ["encoded-image-1", "encoded-image-2"]
        globals_["provider_model_supports_images"] = lambda provider, model_id, backend="": model_id == "qwen3_vl_4b_fast"
        try:
            result = prompt_node.execute(
                privacy_mode=False,
                images=[object(), object()],
                prompt_type="image",
                vision_context_mode="separate vision model",
                script="Create a polished portrait",
                provider="ollama",
                model="mistral:latest",
                model_id="mistral:latest",
            )
        finally:
            globals_["PromptProviderRegistry"] = original_provider
            globals_["encode_images_for_ollama"] = original_encode
            globals_["provider_model_supports_images"] = original_support

        self.assertEqual(vision_requests[0].images, ["encoded-image-1", "encoded-image-2"])
        self.assertEqual(writer_requests[0].images, [])
        self.assertIn("Visual context: two reference portraits", writer_requests[0].prompt)
        self.assertEqual(result[7], "two reference portraits with warm studio lighting")

    def test_privacy_show_any_summarizes_unhelpful_object_values(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        text_node = next(
            node_cls
            for node_cls in asyncio.run(extension_module.HeltoUtilsExtension().get_node_list())
            if node_cls.define_schema().node_id == "HeltoPrivacyShowAny"
        )

        class ModelLike:
            pass

        result = text_node.execute(ModelLike())

        self.assertIn("cannot be converted to meaningful text", result[0])

    def test_save_video_private_encoder_returns_animated_bytes(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveVideoAdvanced
        frames = [torch.zeros((4, 6, 3)), torch.ones((4, 6, 3))]

        encoded = node_cls._encode_private_preview_bytes(
            frames=frames,
            audio=None,
            filename_prefix="synthetic",
            counter=1,
            frame_rate=2.0,
            loop_count=0,
            format="image/webp",
            format_kwargs={"lossless": True},
        )

        with Image.open(BytesIO(encoded)) as preview:
            self.assertEqual(preview.format, "WEBP")
            self.assertEqual(preview.size, (6, 4))

    def test_save_video_private_ffmpeg_encoder_uses_anonymous_output(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveVideoAdvanced
        globals_ = node_cls._encode_private_preview_bytes.__func__.__globals__
        if globals_["_find_ffmpeg"]() is None:
            self.skipTest("ffmpeg is unavailable")

        with patch.dict(
            globals_,
            {"ProgressBar": lambda _total: types.SimpleNamespace(update=lambda _value: None)},
        ):
            encoded = node_cls._encode_private_preview_bytes(
                frames=[torch.zeros((8, 8, 3)), torch.ones((8, 8, 3))],
                audio=None,
                filename_prefix="synthetic",
                counter=1,
                frame_rate=2.0,
                loop_count=0,
                format="video/h264-mp4",
                format_kwargs={},
            )

        self.assertIn(b"ftyp", encoded[:64])

    def test_save_video_private_audio_mux_uses_anonymous_output(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveVideoAdvanced
        globals_ = node_cls._encode_private_preview_bytes.__func__.__globals__
        if globals_["_find_ffmpeg"]() is None:
            self.skipTest("ffmpeg is unavailable")

        with patch.dict(
            globals_,
            {"ProgressBar": lambda _total: types.SimpleNamespace(update=lambda _value: None)},
        ):
            encoded = node_cls._encode_private_preview_bytes(
                frames=[torch.zeros((8, 8, 3)), torch.ones((8, 8, 3))],
                audio={
                    "waveform": torch.zeros((1, 1, 4_000)),
                    "sample_rate": 8_000,
                },
                filename_prefix="synthetic",
                counter=1,
                frame_rate=2.0,
                loop_count=0,
                format="video/h264-mp4",
                format_kwargs={},
            )

        self.assertIn(b"ftyp", encoded[:64])

    def test_media_nodes_bind_existing_encoders_to_managed_facade(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        calls = []

        class Record:
            def __init__(self, index):
                self.index = index

            def to_record(self):
                return {"private": True, "artifact": self.index}

        class Managed:
            async def publish_encoded_previews(self, node_class, encode, **_kwargs):
                values = encode()
                calls.append((node_class, values))
                return [Record(index) for index, _value in enumerate(values)]

            async def load_video_thumbnail(self, cache_key, revision, encode, **_kwargs):
                value = encode()
                calls.append(("HeltoLoadVideo", cache_key, revision, value))
                return Record(0), value

        managed = Managed()
        image_globals = extension_module.ImageComparer.execute.__func__.__globals__
        image_helper = image_globals["ui"].ImageSaveHelper
        original_convert = image_helper._convert_tensor_to_pil
        image_helper._convert_tensor_to_pil = staticmethod(
            lambda _image: Image.new("RGB", (3, 2))
        )
        try:
            image_records = asyncio.run(
                image_globals["_managed_preview_records"](
                    torch.zeros((1, 2, 3, 3)),
                    extension_module.ImageComparer,
                    managed,
                    owner_key="image/revision",
                )
            )
            save_records = asyncio.run(
                extension_module.SaveImageAdvanced._managed_private_preview_records(
                    torch.zeros((1, 2, 3, 3)),
                    managed,
                    owner_key="save/revision",
                )
            )
        finally:
            image_helper._convert_tensor_to_pil = original_convert

        class Video:
            def save_to(self, target, **_kwargs):
                target.write(b"synthetic-mp4")

        video_record = asyncio.run(
            extension_module.VideoComparer._managed_preview_record(
                Video(),
                "video_1",
                24.0,
                managed,
                owner_key="video/revision",
            )
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            source = Path(tmpdir) / "source.mp4"
            source.write_bytes(b"synthetic-source")
            load_globals = extension_module.HeltoLoadVideo.execute.__func__.__globals__[
                "preview_result"
            ].__globals__
            original = load_globals["generate_thumbnail_bytes"]
            load_globals["generate_thumbnail_bytes"] = lambda *_args, **_kwargs: b"webp"
            try:
                thumbnail = asyncio.run(
                    load_globals["managed_thumbnail"](source, managed)
                )
            finally:
                load_globals["generate_thumbnail_bytes"] = original

        self.assertEqual(image_records, [{"private": True, "artifact": 0}])
        self.assertEqual(save_records, [{"private": True, "artifact": 0}])
        self.assertEqual(video_record, {"private": True, "artifact": 0})
        self.assertEqual(thumbnail[1], b"webp")
        self.assertEqual(
            [call[0] for call in calls],
            [
                "HeltoImageComparer",
                "HeltoSaveImageAdvanced",
                "HeltoVideoComparer",
                "HeltoLoadVideo",
            ],
        )

    def test_save_image_public_preview_uses_dedicated_temp_folder(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveImageAdvanced
        globals_ = node_cls._managed_public_preview_records.__func__.__globals__
        helper = globals_["ui"].ImageSaveHelper
        original = helper.save_images
        calls = []
        helper.save_images = lambda images, **kwargs: calls.append((images, kwargs)) or []
        try:
            node_cls._managed_public_preview_records(["image"], "../private-name")
        finally:
            helper.save_images = original

        self.assertEqual(
            calls[0][1]["filename_prefix"],
            "helto_save_image_advanced/private-name",
        )
        self.assertEqual(calls[0][1]["folder_type"], globals_["io"].FolderType.temp)

    def test_save_image_can_preview_without_saving_output(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveImageAdvanced
        original_save_images = node_cls.__dict__["_save_images"]
        original_private_records = node_cls.__dict__["_managed_private_preview_records"]
        original_hidden = getattr(node_cls, "hidden", None)
        saved_calls = []
        preview_calls = []

        def fake_save_images(cls, images, save_dir, filename_prefix):
            saved_calls.append((images, save_dir, filename_prefix))
            raise AssertionError("save_image=False should not save output images")

        async def fake_private_records(cls, images, _managed_artifacts, *, owner_key, **_kwargs):
            preview_calls.append((images, owner_key))
            return [{"private": True, "artifactKind": "save-image-preview", "artifact": {"synthetic": True}}]

        node_cls._save_images = classmethod(fake_save_images)
        node_cls._managed_private_preview_records = classmethod(fake_private_records)
        node_cls.hidden = types.SimpleNamespace(unique_id="preview-only-image-node")
        node_cls.state["previews"].clear()
        node_cls.state["media"].clear()
        node_cls.state["releases"].clear()
        try:
            images = ["image-tensor"]
            result = asyncio.run(node_cls.execute(
                images=images,
                folder="relative-folder-is-ignored",
                filename_prefix="preview",
                save_image=False,
            ))
        finally:
            node_cls._save_images = original_save_images
            node_cls._managed_private_preview_records = original_private_records
            node_cls.hidden = original_hidden

        self.assertEqual(result[0], images)
        self.assertEqual(saved_calls, [])
        self.assertEqual(preview_calls, [(images, "preview-only-image-node")])
        self.assertEqual(result.kwargs["ui"]["helto_private_images"][0]["artifactKind"], "save-image-preview")
        control = result.kwargs["ui"]["helto_pause_control"][0]
        self.assertTrue(control["has_media"])
        self.assertFalse(control["paused"])
        self.assertEqual(control["mode"], "ready")

    def test_save_image_outputs_dimensions_with_image(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveImageAdvanced
        original_save_images = node_cls.__dict__["_save_images"]
        original_private_records = node_cls.__dict__["_managed_private_preview_records"]
        original_hidden = getattr(node_cls, "hidden", None)
        saved_calls = []

        node_cls._save_images = classmethod(lambda cls, images, save_dir, filename_prefix: saved_calls.append(images) or [])
        async def fake_private_records(cls, images, _managed_artifacts, **_kwargs):
            return []
        node_cls._managed_private_preview_records = classmethod(fake_private_records)
        node_cls.hidden = types.SimpleNamespace(unique_id="dimensions-node")
        node_cls.state["previews"].clear()
        node_cls.state["media"].clear()
        node_cls.state["releases"].clear()
        try:
            images = torch.zeros((2, 17, 23, 3), dtype=torch.float32)
            result = asyncio.run(node_cls.execute(images=images))
        finally:
            node_cls._save_images = original_save_images
            node_cls._managed_private_preview_records = original_private_records
            node_cls.hidden = original_hidden

        self.assertIs(result[0], images)
        self.assertEqual(result[1], 23)
        self.assertEqual(result[2], 17)
        self.assertEqual(len(saved_calls), 1)
        self.assertIs(saved_calls[0], images)

    def test_save_image_reports_per_image_progress(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveImageAdvanced
        module_globals = node_cls.execute.__func__.__globals__
        helper = module_globals["ui"].ImageSaveHelper
        original_hidden = getattr(node_cls, "hidden", None)
        original_metadata = helper._create_png_metadata
        original_convert = helper._convert_tensor_to_pil
        sent = []

        helper._create_png_metadata = staticmethod(lambda _cls: None)
        helper._convert_tensor_to_pil = staticmethod(lambda _image: Image.new("RGB", (1, 1), (255, 0, 0)))
        node_cls.hidden = types.SimpleNamespace(unique_id="save-image-progress-node")
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                with patch.object(
                    module_globals["helto_progress"],
                    "_send_payload",
                    side_effect=lambda payload: sent.append(payload) or True,
                ), patch.object(
                    module_globals["helto_progress"],
                    "_mirror_native_text",
                    side_effect=AssertionError("Save image progress should not draw native node text"),
                ) as mirror_text:
                    saved = node_cls._save_images(["first", "second"], tmpdir, "img")
        finally:
            helper._create_png_metadata = original_metadata
            helper._convert_tensor_to_pil = original_convert
            node_cls.hidden = original_hidden

        mirror_text.assert_not_called()
        self.assertEqual(len(saved), 2)
        save_events = [payload for payload in sent if payload["phase"] == "save_images"]
        self.assertGreaterEqual(len(save_events), 4)
        self.assertEqual(save_events[-1]["event"], "done")
        self.assertEqual(save_events[-1]["value"], 2.0)
        self.assertEqual(save_events[-1]["total"], 2.0)

    def test_save_image_pause_mode_stores_image_and_blocks_downstream_quietly(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveImageAdvanced
        module_globals = node_cls.execute.__func__.__globals__
        execution_blocker = module_globals["ExecutionBlocker"]
        original_save_images = node_cls.__dict__["_save_images"]
        original_private_records = node_cls.__dict__["_managed_private_preview_records"]
        original_hidden = getattr(node_cls, "hidden", None)
        saved_calls = []

        node_cls._save_images = classmethod(lambda cls, images, save_dir, filename_prefix: saved_calls.append(images) or [])
        async def fake_private_records(cls, images, _managed_artifacts, **_kwargs):
            return []
        node_cls._managed_private_preview_records = classmethod(fake_private_records)
        node_cls.hidden = types.SimpleNamespace(unique_id="pause-node")
        node_cls.state["previews"].clear()
        node_cls.state["media"].clear()
        node_cls.state["releases"].clear()
        try:
            images = ["image-tensor"]
            result = asyncio.run(node_cls.execute(images=images, pause_mode=True))
        finally:
            node_cls._save_images = original_save_images
            node_cls._managed_private_preview_records = original_private_records
            node_cls.hidden = original_hidden

        self.assertIsInstance(result[0], execution_blocker)
        self.assertIsInstance(result[1], execution_blocker)
        self.assertIsInstance(result[2], execution_blocker)
        self.assertEqual(saved_calls, [images])
        self.assertEqual(node_cls.state["media"]["pause-node"]["images"], images)
        self.assertTrue(node_cls.state["media"]["pause-node"]["paused"])
        control = result.kwargs["ui"]["helto_pause_control"][0]
        self.assertTrue(control["has_media"])
        self.assertTrue(control["paused"])
        self.assertEqual(control["mode"], "paused")

    def test_save_image_release_reemits_stored_image_without_saving_again(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveImageAdvanced
        original_save_images = node_cls.__dict__["_save_images"]
        original_private_records = node_cls.__dict__["_managed_private_preview_records"]
        original_hidden = getattr(node_cls, "hidden", None)
        saved_calls = []

        node_cls._save_images = classmethod(lambda cls, images, save_dir, filename_prefix: saved_calls.append(images) or [])
        async def fake_private_records(cls, images, _managed_artifacts, **_kwargs):
            return []
        node_cls._managed_private_preview_records = classmethod(fake_private_records)
        node_cls.hidden = types.SimpleNamespace(unique_id="release-node")
        node_cls.state["previews"].clear()
        node_cls.state["media"].clear()
        node_cls.state["releases"].clear()
        try:
            images = torch.zeros((1, 19, 31, 3), dtype=torch.float32)
            first = asyncio.run(node_cls.execute(images=images, pause_mode=False))
            revision = first.kwargs["ui"]["helto_pause_control"][0]["revision"]
            release = node_cls.request_release("release-node", revision)
            second = asyncio.run(node_cls.execute(images=None, pause_mode=True, release_token=release["release_token"]))
        finally:
            node_cls._save_images = original_save_images
            node_cls._managed_private_preview_records = original_private_records
            node_cls.hidden = original_hidden

        self.assertTrue(release["ok"])
        self.assertIs(second[0], images)
        self.assertEqual(second[1], 31)
        self.assertEqual(second[2], 19)
        self.assertEqual(len(saved_calls), 1)
        self.assertIs(saved_calls[0], images)
        self.assertFalse(node_cls.state["media"]["release-node"]["paused"])
        self.assertNotIn("release-node", node_cls.state["releases"])
        control = second.kwargs["ui"]["helto_pause_control"][0]
        self.assertEqual(control["mode"], "released")
        self.assertTrue(control["released"])
        self.assertFalse(control["paused"])

    def test_save_image_paused_release_reemits_dimensions_without_saving_again(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveImageAdvanced
        original_save_images = node_cls.__dict__["_save_images"]
        original_private_records = node_cls.__dict__["_managed_private_preview_records"]
        original_hidden = getattr(node_cls, "hidden", None)
        saved_calls = []

        node_cls._save_images = classmethod(lambda cls, images, save_dir, filename_prefix: saved_calls.append(images) or [])
        async def fake_private_records(cls, images, _managed_artifacts, **_kwargs):
            return []
        node_cls._managed_private_preview_records = classmethod(fake_private_records)
        node_cls.hidden = types.SimpleNamespace(unique_id="paused-release-node")
        node_cls.state["previews"].clear()
        node_cls.state["media"].clear()
        node_cls.state["releases"].clear()
        try:
            images = torch.zeros((1, 21, 33, 3), dtype=torch.float32)
            first = asyncio.run(node_cls.execute(images=images, pause_mode=True))
            revision = first.kwargs["ui"]["helto_pause_control"][0]["revision"]
            release = node_cls.request_release("paused-release-node", revision)
            second = asyncio.run(node_cls.execute(images=None, pause_mode=True, release_token=release["release_token"]))
        finally:
            node_cls._save_images = original_save_images
            node_cls._managed_private_preview_records = original_private_records
            node_cls.hidden = original_hidden

        self.assertTrue(release["ok"])
        self.assertTrue(release["paused"])
        self.assertIs(second[0], images)
        self.assertEqual(second[1], 33)
        self.assertEqual(second[2], 21)
        self.assertEqual(len(saved_calls), 1)
        self.assertIs(saved_calls[0], images)
        self.assertFalse(node_cls.state["media"]["paused-release-node"]["paused"])
        self.assertNotIn("paused-release-node", node_cls.state["releases"])
        control = second.kwargs["ui"]["helto_pause_control"][0]
        self.assertEqual(control["mode"], "released")
        self.assertTrue(control["released"])
        self.assertFalse(control["paused"])

    def test_pause_release_can_be_cancelled_and_stale_revisions_are_not_consumed(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()

        for node_cls in (extension_module.SaveImageAdvanced, extension_module.SaveVideoAdvanced):
            with self.subTest(node=node_cls.__name__):
                node_cls.state["media"]["transaction-node"] = {"revision": 4}
                node_cls.state["releases"]["transaction-node"] = {
                    "revision": 4,
                    "token": "release-token",
                    "expires_at": float("inf"),
                }

                cancelled = node_cls.cancel_release("transaction-node", 4)

                self.assertTrue(cancelled["ok"])
                self.assertTrue(cancelled["cancelled"])
                self.assertNotIn("transaction-node", node_cls.state["releases"])

                node_cls.state["releases"]["transaction-node"] = {
                    "revision": 4,
                    "token": "bound-token",
                    "expires_at": float("inf"),
                }
                self.assertIsNone(node_cls._consume_release("transaction-node", ""))
                self.assertIn("transaction-node", node_cls.state["releases"])
                self.assertIsNotNone(node_cls._consume_release("transaction-node", "bound-token"))

                node_cls.state["releases"]["transaction-node"] = {
                    "revision": 3,
                    "token": "stale-token",
                    "expires_at": float("inf"),
                }
                self.assertIsNone(node_cls._consume_release("transaction-node", "stale-token"))
                self.assertNotIn("transaction-node", node_cls.state["releases"])
                node_cls.state["media"].pop("transaction-node", None)

    def test_save_video_managed_pause_control_releases_managed_replay(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveVideoAdvanced
        module_globals = node_cls.execute.__func__.__globals__
        original_artifacts = module_globals["utils_media_artifacts"]
        original_hidden = getattr(node_cls, "hidden", None)
        node_id = "managed-video-release-node"
        payload = {
            "images": ["synthetic-frames"],
            "audio": {"synthetic": "audio"},
            "filenames": (False, []),
        }

        class ManagedArtifacts:
            async def consume_replay(self, supplied_node_id, revision, privacy_mode):
                assert supplied_node_id == node_id
                assert revision == 3
                assert privacy_mode is True
                return payload

        node_cls.hidden = types.SimpleNamespace(unique_id=node_id)
        node_cls.state["media"][node_id] = {
            "managed": True,
            "privacy_mode": True,
            "revision": 3,
            "paused": True,
        }
        node_cls.state["previews"][node_id] = {"synthetic": ["preview"]}
        node_cls.state["releases"].pop(node_id, None)
        module_globals["utils_media_artifacts"] = lambda: ManagedArtifacts()
        try:
            paused = node_cls._pause_control_payload(node_id, mode="paused")
            release = node_cls.request_release(node_id, 3)
            result = asyncio.run(
                node_cls.execute(
                    images=None,
                    pause_mode=True,
                    release_token=release["release_token"],
                )
            )
        finally:
            module_globals["utils_media_artifacts"] = original_artifacts
            node_cls.hidden = original_hidden
            node_cls.state["media"].pop(node_id, None)
            node_cls.state["previews"].pop(node_id, None)
            node_cls.state["releases"].pop(node_id, None)

        self.assertTrue(paused["has_media"])
        self.assertTrue(paused["paused"])
        self.assertTrue(release["ok"])
        self.assertEqual(result[0], payload["images"])
        self.assertEqual(result[1], payload["audio"])
        self.assertEqual(result[2], payload["filenames"])
        control = result.kwargs["ui"]["helto_pause_control"][0]
        self.assertEqual(control["mode"], "released")
        self.assertTrue(control["released"])
        self.assertTrue(control["has_media"])
        self.assertFalse(control["paused"])

    def test_save_video_audio_mux_replaces_silent_file_without_audio_postfix(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveVideoAdvanced

        with tempfile.TemporaryDirectory() as tmpdir:
            module_globals = self._configure_ffmpeg_video_test_runtime(node_cls)
            original_popen = module_globals["subprocess"].Popen
            original_run = module_globals["subprocess"].run
            original_find_ffmpeg = module_globals["_find_ffmpeg"]
            frames = [module_globals["torch"].zeros((2, 2, 3))]
            audio = {
                "waveform": module_globals["torch"].zeros((1, 2, 4)),
                "sample_rate": 44100,
            }

            class FakeProcess:
                def __init__(self, command, **_kwargs):
                    self.stdin = types.SimpleNamespace(write=lambda _data: None, close=lambda: None)
                    self.stderr = types.SimpleNamespace(read=lambda: b"")
                    Path(command[-1]).write_bytes(b"silent video")

                def wait(self):
                    return 0

            def fake_run(command, **_kwargs):
                Path(command[-1]).write_bytes(b"muxed video")
                return types.SimpleNamespace(returncode=0, stderr=b"")

            module_globals["_find_ffmpeg"] = lambda: "ffmpeg"
            module_globals["subprocess"].Popen = FakeProcess
            module_globals["subprocess"].run = fake_run
            try:
                output_files = node_cls._save_ffmpeg_video(
                    frames=frames,
                    audio=audio,
                    save_dir=tmpdir,
                    filename_prefix="video",
                    counter=1,
                    frame_rate=24.0,
                    loop_count=0,
                    format_ext="h264-mp4",
                    save_output=True,
                    format_kwargs={},
                )
            finally:
                module_globals["subprocess"].Popen = original_popen
                module_globals["subprocess"].run = original_run
                module_globals["_find_ffmpeg"] = original_find_ffmpeg

            self.assertEqual(output_files, [os.path.join(tmpdir, "video_00001.mp4")])
            self.assertEqual(Path(output_files[0]).read_bytes(), b"muxed video")
            self.assertFalse(any("-audio" in path.name for path in Path(tmpdir).iterdir()))
            self.assertFalse(any(".audio_mux." in path.name for path in Path(tmpdir).iterdir()))

    def test_save_video_without_audio_does_not_call_mux_run(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveVideoAdvanced

        with tempfile.TemporaryDirectory() as tmpdir:
            module_globals = self._configure_ffmpeg_video_test_runtime(node_cls)
            original_popen = module_globals["subprocess"].Popen
            original_run = module_globals["subprocess"].run
            original_find_ffmpeg = module_globals["_find_ffmpeg"]
            frames = [module_globals["torch"].zeros((2, 2, 3))]
            stderr_targets = []

            class FakeProcess:
                def __init__(self, command, **_kwargs):
                    stderr_targets.append(_kwargs.get("stderr"))
                    self.stdin = types.SimpleNamespace(write=lambda _data: None, close=lambda: None)
                    self.stderr = types.SimpleNamespace(read=lambda: b"")
                    Path(command[-1]).write_bytes(b"silent video")

                def wait(self):
                    return 0

            def fake_run(*_args, **_kwargs):
                raise AssertionError("audio mux should not run without audio")

            module_globals["_find_ffmpeg"] = lambda: "ffmpeg"
            module_globals["subprocess"].Popen = FakeProcess
            module_globals["subprocess"].run = fake_run
            try:
                output_files = node_cls._save_ffmpeg_video(
                    frames=frames,
                    audio=None,
                    save_dir=tmpdir,
                    filename_prefix="video",
                    counter=1,
                    frame_rate=24.0,
                    loop_count=0,
                    format_ext="h264-mp4",
                    save_output=True,
                    format_kwargs={},
                )
            finally:
                module_globals["subprocess"].Popen = original_popen
                module_globals["subprocess"].run = original_run
                module_globals["_find_ffmpeg"] = original_find_ffmpeg

            self.assertEqual(output_files, [os.path.join(tmpdir, "video_00001.mp4")])
            self.assertEqual(Path(output_files[0]).read_bytes(), b"silent video")
            self.assertEqual(len(stderr_targets), 1)
            self.assertIsNot(stderr_targets[0], module_globals["subprocess"].PIPE)
            self.assertTrue(callable(getattr(stderr_targets[0], "write", None)))

    def test_save_video_ffmpeg_reports_progress_phases(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveVideoAdvanced

        with tempfile.TemporaryDirectory() as tmpdir:
            module_globals = self._configure_ffmpeg_video_test_runtime(node_cls)
            original_popen = module_globals["subprocess"].Popen
            original_run = module_globals["subprocess"].run
            original_find_ffmpeg = module_globals["_find_ffmpeg"]
            original_hidden = getattr(node_cls, "hidden", None)
            frames = [
                module_globals["torch"].zeros((2, 2, 3)),
                module_globals["torch"].ones((2, 2, 3)),
            ]
            sent = []

            class FakeProcess:
                def __init__(self, command, **_kwargs):
                    self.stdin = types.SimpleNamespace(write=lambda _data: None, close=lambda: None)
                    self.stderr = types.SimpleNamespace(read=lambda: b"")
                    Path(command[-1]).write_bytes(b"silent video")

                def wait(self):
                    return 0

            def fake_run(*_args, **_kwargs):
                raise AssertionError("audio mux should not run without audio")

            module_globals["_find_ffmpeg"] = lambda: "ffmpeg"
            module_globals["subprocess"].Popen = FakeProcess
            module_globals["subprocess"].run = fake_run
            node_cls.hidden = types.SimpleNamespace(
                unique_id="save-video-progress-node",
                prompt=None,
                extra_pnginfo=None,
            )
            try:
                with patch.object(
                    module_globals["helto_progress"],
                    "_send_payload",
                    side_effect=lambda payload: sent.append(payload) or True,
                ):
                    output_files = node_cls._save_ffmpeg_video(
                        frames=frames,
                        audio=None,
                        save_dir=tmpdir,
                        filename_prefix="video",
                        counter=1,
                        frame_rate=24.0,
                        loop_count=0,
                        format_ext="h264-mp4",
                        save_output=True,
                        format_kwargs={},
                    )
            finally:
                module_globals["subprocess"].Popen = original_popen
                module_globals["subprocess"].run = original_run
                module_globals["_find_ffmpeg"] = original_find_ffmpeg
                node_cls.hidden = original_hidden

        self.assertEqual(output_files, [os.path.join(tmpdir, "video_00001.mp4")])
        phases = {payload["phase"] for payload in sent}
        self.assertIn("encode_video", phases)
        self.assertIn("convert_frames", phases)
        self.assertIn("write_frames", phases)
        write_done = [payload for payload in sent if payload["phase"] == "write_frames" and payload["event"] == "done"]
        self.assertEqual(write_done[-1]["value"], 2.0)
        self.assertEqual(write_done[-1]["total"], 2.0)

    def test_save_video_audio_mux_failure_cleans_temp_file(self):
        extension_module = self._import_extension_with_fake_comfy_runtime()
        node_cls = extension_module.SaveVideoAdvanced

        with tempfile.TemporaryDirectory() as tmpdir:
            module_globals = self._configure_ffmpeg_video_test_runtime(node_cls)
            original_popen = module_globals["subprocess"].Popen
            original_run = module_globals["subprocess"].run
            original_find_ffmpeg = module_globals["_find_ffmpeg"]
            frames = [module_globals["torch"].zeros((2, 2, 3))]
            audio = {
                "waveform": module_globals["torch"].zeros((1, 2, 4)),
                "sample_rate": 44100,
            }

            class FakeProcess:
                def __init__(self, command, **_kwargs):
                    self.stdin = types.SimpleNamespace(write=lambda _data: None, close=lambda: None)
                    self.stderr = types.SimpleNamespace(read=lambda: b"")
                    Path(command[-1]).write_bytes(b"silent video")

                def wait(self):
                    return 0

            def fake_run(command, **_kwargs):
                Path(command[-1]).write_bytes(b"partial mux")
                return types.SimpleNamespace(returncode=1, stderr=b"bad mux")

            module_globals["_find_ffmpeg"] = lambda: "ffmpeg"
            module_globals["subprocess"].Popen = FakeProcess
            module_globals["subprocess"].run = fake_run
            try:
                with self.assertRaisesRegex(RuntimeError, "bad mux"):
                    node_cls._save_ffmpeg_video(
                        frames=frames,
                        audio=audio,
                        save_dir=tmpdir,
                        filename_prefix="video",
                        counter=1,
                        frame_rate=24.0,
                        loop_count=0,
                        format_ext="h264-mp4",
                        save_output=True,
                        format_kwargs={},
                    )
            finally:
                module_globals["subprocess"].Popen = original_popen
                module_globals["subprocess"].run = original_run
                module_globals["_find_ffmpeg"] = original_find_ffmpeg

            self.assertEqual((Path(tmpdir) / "video_00001.mp4").read_bytes(), b"silent video")
            self.assertFalse(any(".audio_mux." in path.name for path in Path(tmpdir).iterdir()))

    @staticmethod
    def _configure_ffmpeg_video_test_runtime(node_cls) -> dict:
        module_globals = node_cls.execute.__func__.__globals__
        module_globals["ProgressBar"] = lambda _total: types.SimpleNamespace(update=lambda _amount: None)
        return module_globals

    @staticmethod
    def _import_node_with_fake_comfy_api():
        class FakeSchema:
            def __init__(self, node_id, display_name, category, inputs, outputs):
                self.node_id = node_id
                self.display_name = display_name
                self.category = category
                self.inputs = inputs
                self.outputs = outputs

        class FakeField:
            def __init__(self, id=None, display_name=None, is_output_list=False, **kwargs):
                self.id = id
                self.display_name = display_name
                self.is_output_list = is_output_list
                self.kwargs = kwargs

        class FakeNodeOutput(tuple):
            def __new__(cls, *values):
                return tuple.__new__(cls, values)

        class FakeString:
            Input = FakeField

        class FakeBoolean:
            Input = FakeField

        class FakeImage:
            Output = FakeField

        class FakeMask:
            Output = FakeField

        class FakeBoundingBox:
            Output = FakeField

        class FakeIO:
            ComfyNode = object
            Schema = FakeSchema
            String = FakeString
            Boolean = FakeBoolean
            Image = FakeImage
            Mask = FakeMask
            BoundingBox = FakeBoundingBox
            NodeOutput = FakeNodeOutput

        previous_comfy_api = sys.modules.get("comfy_api")
        previous_latest = sys.modules.get("comfy_api.latest")
        previous_node = sys.modules.get("helto_selector_backend.node")
        sys.modules.pop("helto_selector_backend.node", None)
        comfy_api_module = types.ModuleType("comfy_api")
        latest_module = types.ModuleType("comfy_api.latest")
        latest_module.io = FakeIO
        sys.modules["comfy_api"] = comfy_api_module
        sys.modules["comfy_api.latest"] = latest_module
        try:
            return importlib.import_module("helto_selector_backend.node")
        finally:
            if previous_comfy_api is None:
                sys.modules.pop("comfy_api", None)
            else:
                sys.modules["comfy_api"] = previous_comfy_api
            if previous_latest is None:
                sys.modules.pop("comfy_api.latest", None)
            else:
                sys.modules["comfy_api.latest"] = previous_latest
            if previous_node is None:
                sys.modules.pop("helto_selector_backend.node", None)
            else:
                sys.modules["helto_selector_backend.node"] = previous_node

    @staticmethod
    def _import_extension_with_fake_comfy_runtime(isolate_custom_node_root=False):
        class FakeSchema:
            def __init__(
                self,
                node_id,
                display_name,
                category,
                inputs=None,
                outputs=None,
                hidden=None,
                **kwargs,
            ):
                self.node_id = node_id
                self.display_name = display_name
                self.category = category
                self.inputs = inputs or []
                self.outputs = outputs or []
                self.hidden = hidden or []
                self.kwargs = kwargs

        class FakeField:
            def __init__(self, id=None, *args, display_name=None, is_output_list=False, **kwargs):
                self.id = id
                self.display_name = display_name
                self.is_output_list = is_output_list
                self.args = args
                self.kwargs = kwargs

        class FakeNodeOutput(tuple):
            def __new__(cls, *values, **kwargs):
                output = tuple.__new__(cls, values)
                output.kwargs = kwargs
                return output

        class FakeExecutionBlocker:
            def __init__(self, message):
                self.message = message

        def fake_socket(kind):
            class FakeInput(FakeField):
                def __init__(self, id=None, *args, **kwargs):
                    super().__init__(id, *args, io_kind=kind, **kwargs)

            class FakeOutput(FakeField):
                def __init__(self, id=None, *args, **kwargs):
                    super().__init__(id, *args, io_kind=kind, **kwargs)

            return types.SimpleNamespace(Input=FakeInput, Output=FakeOutput)

        FakeSocket = fake_socket("Generic")

        class FakeMultiType:
            Input = FakeField

        class FakeHidden:
            unique_id = object()

        class FakeFolderType:
            output = "output"
            temp = "temp"

        class FakeIO:
            ComfyNode = object
            Schema = FakeSchema
            NodeOutput = FakeNodeOutput
            ControlAfterGenerate = types.SimpleNamespace(
                fixed="fixed",
                increment="increment",
                decrement="decrement",
                randomize="randomize",
            )
            NumberDisplay = types.SimpleNamespace(number="number")
            String = fake_socket("String")
            Image = fake_socket("Image")
            Mask = fake_socket("Mask")
            BoundingBox = fake_socket("BoundingBox")
            Int = fake_socket("Int")
            Float = fake_socket("Float")
            Combo = fake_socket("Combo")
            Boolean = fake_socket("Boolean")
            Model = fake_socket("Model")
            Clip = fake_socket("Clip")
            Audio = fake_socket("Audio")
            Vae = fake_socket("Vae")
            Latent = fake_socket("Latent")
            Video = fake_socket("Video")
            MultiType = FakeMultiType
            Hidden = FakeHidden
            FolderType = FakeFolderType

            @staticmethod
            def Custom(_name):
                return FakeSocket

        class FakeComfyExtension:
            async def get_node_list(self):
                return []

        class FakeVideoContainer:
            MP4 = "mp4"

        class FakeVideoCodec:
            H264 = "h264"

        class FakeTypes:
            VideoContainer = FakeVideoContainer
            VideoCodec = FakeVideoCodec

            class VideoComponents:
                def __init__(self, **kwargs):
                    self.kwargs = kwargs

        class FakeInputImpl:
            class VideoFromFile:
                def __init__(self, *args, **kwargs):
                    self.args = args
                    self.kwargs = kwargs

            class VideoFromComponents:
                def __init__(self, *args, **kwargs):
                    self.args = args
                    self.kwargs = kwargs

        class FakeSavedResult:
            def __init__(self, *args, **kwargs):
                self.args = args
                self.kwargs = kwargs

        class FakePreviewVideo:
            def __init__(self, values, **_kwargs):
                self.values = values

        class FakeImageSaveHelper:
            @staticmethod
            def _create_png_metadata(_cls):
                return None

            @staticmethod
            def _convert_tensor_to_pil(_image):
                raise AssertionError("Image conversion should not run during schema tests")

            @staticmethod
            def save_images(*args, **kwargs):
                raise AssertionError("Image saving should not run during schema tests")

        class FakeUI:
            SavedResult = FakeSavedResult
            PreviewVideo = FakePreviewVideo
            ImageSaveHelper = FakeImageSaveHelper

        class FakeRoutes:
            def get(self, _path):
                return lambda handler: handler

            def post(self, _path):
                return lambda handler: handler

            def delete(self, _path):
                return lambda handler: handler

        class FakePromptServer:
            instance = types.SimpleNamespace(routes=FakeRoutes())

        class FakeWeb:
            Response = object
            FileResponse = object

            @staticmethod
            def json_response(*args, **kwargs):
                return {"args": args, "kwargs": kwargs}

        modules = {
            "aiohttp": types.ModuleType("aiohttp"),
            "aiohttp.web": types.ModuleType("aiohttp.web"),
            "comfy_api": types.ModuleType("comfy_api"),
            "comfy_api.latest": types.ModuleType("comfy_api.latest"),
            "comfy.comfy_types": types.ModuleType("comfy.comfy_types"),
            "comfy.comfy_types.node_typing": types.ModuleType("comfy.comfy_types.node_typing"),
            "folder_paths": types.ModuleType("folder_paths"),
            "server": types.ModuleType("server"),
            "comfy": types.ModuleType("comfy"),
            "comfy.cli_args": types.ModuleType("comfy.cli_args"),
            "comfy.utils": types.ModuleType("comfy.utils"),
            "comfy_execution": types.ModuleType("comfy_execution"),
            "comfy_execution.graph": types.ModuleType("comfy_execution.graph"),
        }
        modules["comfy_api.latest"].ComfyExtension = FakeComfyExtension
        modules["comfy_api.latest"].InputImpl = FakeInputImpl
        modules["comfy_api.latest"].Types = FakeTypes
        modules["comfy_api.latest"].io = FakeIO
        modules["comfy_api.latest"].ui = FakeUI
        modules["aiohttp"].web = FakeWeb
        modules["aiohttp.web"].Response = FakeWeb.Response
        modules["aiohttp.web"].FileResponse = FakeWeb.FileResponse
        modules["aiohttp.web"].json_response = FakeWeb.json_response
        modules["folder_paths"].folder_names_and_paths = {}
        modules["folder_paths"].get_input_directory = lambda: tempfile.gettempdir()
        modules["folder_paths"].get_output_directory = lambda: tempfile.gettempdir()
        modules["folder_paths"].get_temp_directory = lambda: tempfile.gettempdir()
        modules["folder_paths"].get_filename_list = lambda _name: []
        modules["folder_paths"].get_full_path = lambda _name, filename: filename
        modules["folder_paths"].get_folder_paths = lambda _name: []
        modules["server"].PromptServer = FakePromptServer
        modules["comfy.comfy_types.node_typing"].IO = types.SimpleNamespace(ANY="*")
        modules["comfy.cli_args"].args = types.SimpleNamespace(disable_metadata=False)
        modules["comfy.utils"].ProgressBar = lambda _total: types.SimpleNamespace(update_absolute=lambda *_args: None)
        modules["comfy_execution.graph"].ExecutionBlocker = FakeExecutionBlocker

        init_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "__init__.py"))
        repo_root = os.path.dirname(init_path)
        package_name = repo_root.replace(".", "_x_") if isolate_custom_node_root else "helto_utils_schema_test"
        previous_modules = {name: sys.modules.get(name) for name in modules}
        previous_package_modules = {
            name: module
            for name, module in sys.modules.items()
            if name == package_name or name.startswith(f"{package_name}.")
        }
        previous_selector_modules = {
            name: module
            for name, module in sys.modules.items()
            if name == "helto_selector_backend" or name.startswith("helto_selector_backend.")
        }
        previous_shared_modules = {
            name: module
            for name, module in sys.modules.items()
            if name == "shared" or name.startswith("shared.")
        }
        previous_sys_path = list(sys.path)
        for name in previous_package_modules:
            sys.modules.pop(name, None)
        if isolate_custom_node_root:
            for name in previous_selector_modules:
                sys.modules.pop(name, None)
            for name in previous_shared_modules:
                sys.modules.pop(name, None)

        sys.modules.update(modules)
        if isolate_custom_node_root:
            sys.path[:] = [
                entry for entry in sys.path
                if os.path.abspath(entry or os.getcwd()) != repo_root
            ]
        spec = importlib.util.spec_from_file_location(
            package_name,
            init_path,
            submodule_search_locations=[os.path.dirname(init_path)],
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[package_name] = module
        try:
            spec.loader.exec_module(module)
            return module
        finally:
            for name, previous in previous_modules.items():
                if previous is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = previous
            for name in list(sys.modules):
                if name == package_name or name.startswith(f"{package_name}."):
                    sys.modules.pop(name, None)
            sys.modules.update(previous_package_modules)
            if isolate_custom_node_root:
                for name in list(sys.modules):
                    if name == "helto_selector_backend" or name.startswith("helto_selector_backend."):
                        sys.modules.pop(name, None)
                    if name == "shared" or name.startswith("shared."):
                        sys.modules.pop(name, None)
                sys.modules.update(previous_selector_modules)
                sys.modules.update(previous_shared_modules)
                sys.path[:] = previous_sys_path


if __name__ == "__main__":
    unittest.main()

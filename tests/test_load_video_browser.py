from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_video_modules(tmp_path: Path, input_dir: Path):
    folder_paths = types.ModuleType("folder_paths")
    folder_paths.get_input_directory = lambda: str(input_dir)
    folder_paths.get_temp_directory = lambda: str(tmp_path / "temp")
    sys.modules["folder_paths"] = folder_paths

    config_path = ROOT / "nodes" / "load_video" / "video_config.py"
    config_spec = importlib.util.spec_from_file_location("video_config", config_path)
    config = importlib.util.module_from_spec(config_spec)
    assert config_spec.loader is not None
    sys.modules["video_config"] = config
    config_spec.loader.exec_module(config)
    config.CONFIG_DIR = tmp_path / "config"
    config.FOLDERS_FILE = config.CONFIG_DIR / "video_folders.json"
    config.THUMB_CACHE_DIR = tmp_path / "thumbnail_cache"

    io_path = ROOT / "nodes" / "load_video" / "video_io.py"
    io_spec = importlib.util.spec_from_file_location("video_io", io_path)
    video_io = importlib.util.module_from_spec(io_spec)
    assert io_spec.loader is not None
    sys.modules["video_io"] = video_io
    io_spec.loader.exec_module(video_io)

    return config, video_io


class LoadVideoBrowserTests(unittest.TestCase):
    def test_alias_validation(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as temp_dir:
            tmp_path = Path(temp_dir)
            config, _video_io = load_video_modules(tmp_path, tmp_path / "input")

            self.assertEqual(config.safe_alias("input clips"), "input clips")
            with self.assertRaises(ValueError):
                config.safe_alias("../clips")
            with self.assertRaises(ValueError):
                config.safe_alias("")

    def test_resolve_video_path_rejects_traversal_and_unsupported_extensions(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as temp_dir:
            tmp_path = Path(temp_dir)
            input_dir = tmp_path / "input"
            input_dir.mkdir()
            config, _video_io = load_video_modules(tmp_path, input_dir)

            (input_dir / "clip.mp4").write_bytes(b"video")
            (tmp_path / "secret.mp4").write_bytes(b"secret")
            (input_dir / "notes.txt").write_text("not video", encoding="utf-8")

            config.save_folders([config.VideoFolder(alias="input", path=str(input_dir), enabled=True)])

            self.assertEqual(config.resolve_video_path("input", "clip.mp4"), input_dir / "clip.mp4")
            with self.assertRaises(ValueError):
                config.resolve_video_path("input", "../secret.mp4")
            with self.assertRaises(ValueError):
                config.resolve_video_path("input", "notes.txt")

    def test_list_videos_filters_extensions_and_supports_recursive_listing(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as temp_dir:
            tmp_path = Path(temp_dir)
            input_dir = tmp_path / "input"
            nested = input_dir / "nested"
            nested.mkdir(parents=True)
            (input_dir / "root.mp4").write_bytes(b"video")
            (input_dir / "ignore.txt").write_text("not video", encoding="utf-8")
            (nested / "child.webm").write_bytes(b"video")
            _config, video_io = load_video_modules(tmp_path, input_dir)

            recursive = video_io.list_videos(input_dir, recursive=True)
            shallow = video_io.list_videos(input_dir, recursive=False)

            self.assertEqual([item["filename"] for item in recursive], ["nested/child.webm", "root.mp4"])
            self.assertEqual([item["filename"] for item in shallow], ["root.mp4"])
            self.assertTrue(all("mtime" in item and "size" in item for item in recursive))

    def test_thumbnail_cache_privacy_mode_writes_only_encrypted_variant(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as temp_dir:
            tmp_path = Path(temp_dir)
            input_dir = tmp_path / "input"
            input_dir.mkdir()
            video_path = input_dir / "clip.mp4"
            video_path.write_bytes(b"not a real video for this unit test")
            _config, video_io = load_video_modules(tmp_path, input_dir)
            import shared.privacy as privacy
            privacy.CONFIG_DIR = tmp_path / "privacy_config"
            privacy.KEY_PATH = privacy.CONFIG_DIR / "privacy_key.bin"
            video_io.generate_thumbnail_bytes = lambda _path, max_size=360: b"webp-bytes"

            data = video_io.thumbnail_bytes(video_path, privacy_mode=True)
            plain_cache = video_io.thumbnail_path(video_path)
            encrypted_cache = video_io.encrypted_thumbnail_path(video_path)

            self.assertEqual(data, b"webp-bytes")
            self.assertFalse(plain_cache.exists())
            self.assertTrue(encrypted_cache.exists())
            self.assertEqual(video_io.decrypt_bytes(encrypted_cache.read_bytes()), b"webp-bytes")


if __name__ == "__main__":
    unittest.main()

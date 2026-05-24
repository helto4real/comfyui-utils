from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

from PIL import Image


class PrivacyTests(unittest.TestCase):
    def setUp(self):
        self._old_folder_paths = sys.modules.get("folder_paths")
        folder_paths = types.ModuleType("folder_paths")
        self.temp_dir = Path(self._testMethodName)
        self.temp_dir.mkdir(exist_ok=True)
        folder_paths.get_temp_directory = lambda: str(self.temp_dir)
        sys.modules["folder_paths"] = folder_paths
        if "shared.privacy" in sys.modules:
            sys.modules["shared.privacy"].folder_paths = folder_paths

    def tearDown(self):
        for path in sorted(self.temp_dir.rglob("*"), reverse=True):
            if path.is_file():
                path.unlink()
            elif path.is_dir():
                path.rmdir()
        if self.temp_dir.exists():
            self.temp_dir.rmdir()
        if self._old_folder_paths is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = self._old_folder_paths

    def test_crypto_roundtrip_and_token_validation(self):
        from shared import privacy

        key = b"1" * 32
        encrypted = privacy.encrypt_bytes(b"secret preview", key=key)
        self.assertNotIn(b"secret preview", encrypted)
        self.assertEqual(privacy.decrypt_bytes(encrypted, key=key), b"secret preview")

        token = privacy.sign_media_token({"path": "/tmp/example.png", "encrypted": True}, key=key)
        payload = privacy.verify_media_token(token, key=key)
        self.assertEqual(payload["path"], "/tmp/example.png")
        self.assertTrue(payload["encrypted"])
        with self.assertRaises(ValueError):
            privacy.verify_media_token(token + "x", key=key)

    def test_encrypted_preview_file_decrypts_to_png(self):
        from io import BytesIO

        from shared import privacy

        privacy.CONFIG_DIR = self.temp_dir / "config"
        privacy.KEY_PATH = privacy.CONFIG_DIR / "privacy_key.bin"

        image = Image.new("RGB", (2, 2), "red")
        buffer = BytesIO()
        image.save(buffer, format="PNG")

        encrypted_path = privacy.write_encrypted_temp_bytes(buffer.getvalue(), ".png", "unit")
        self.assertEqual(encrypted_path.suffix, ".enc")
        self.assertNotIn(b"PNG", encrypted_path.read_bytes()[:16])

        decrypted = privacy.decrypt_bytes(encrypted_path.read_bytes())
        self.assertTrue(decrypted.startswith(b"\x89PNG"))


if __name__ == "__main__":
    unittest.main()

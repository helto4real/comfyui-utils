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

    def test_fast_crypto_writes_v2_payload_when_available(self):
        from shared import privacy

        if privacy.AESGCM is None:
            self.skipTest("cryptography is not available")

        key = b"2" * 32
        encrypted = privacy.encrypt_bytes(b"large private payload", key=key)

        self.assertTrue(encrypted.startswith(privacy.ENC_MAGIC_V2))
        self.assertEqual(privacy.decrypt_bytes(encrypted, key=key), b"large private payload")

    def test_fast_crypto_uses_chunked_v3_for_large_payloads(self):
        from shared import privacy

        if privacy.AESGCM is None:
            self.skipTest("cryptography is not available")

        key = b"5" * 32
        original_max_bytes = privacy.AESGCM_MAX_BYTES
        original_chunk_size = privacy.AESGCM_CHUNK_SIZE
        try:
            privacy.AESGCM_MAX_BYTES = 8
            privacy.AESGCM_CHUNK_SIZE = 7
            plaintext = b"chunked private payload"
            encrypted = privacy.encrypt_bytes(plaintext, key=key)
            self.assertTrue(encrypted.startswith(privacy.ENC_MAGIC_V3))
            self.assertEqual(privacy.decrypt_bytes(encrypted, key=key), plaintext)
        finally:
            privacy.AESGCM_MAX_BYTES = original_max_bytes
            privacy.AESGCM_CHUNK_SIZE = original_chunk_size

    def test_decrypt_bytes_keeps_v1_payloads_readable(self):
        from shared import privacy

        key = b"3" * 32
        encrypted = privacy._encrypt_bytes_v1(b"old private payload", key)

        self.assertTrue(encrypted.startswith(privacy.ENC_MAGIC_V1))
        self.assertEqual(privacy.decrypt_bytes(encrypted, key=key), b"old private payload")

    def test_encrypt_bytes_falls_back_to_v1_without_fast_crypto(self):
        from shared import privacy

        key = b"4" * 32
        original_aesgcm = privacy.AESGCM
        try:
            privacy.AESGCM = None
            encrypted = privacy.encrypt_bytes(b"fallback private payload", key=key)
            self.assertTrue(encrypted.startswith(privacy.ENC_MAGIC_V1))
            self.assertEqual(privacy.decrypt_bytes(encrypted, key=key), b"fallback private payload")
        finally:
            privacy.AESGCM = original_aesgcm

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

    def test_encrypted_temp_file_decrypts_to_source_bytes(self):
        from shared import privacy

        privacy.CONFIG_DIR = self.temp_dir / "config"
        privacy.KEY_PATH = privacy.CONFIG_DIR / "privacy_key.bin"

        source_path = self.temp_dir / "preview.mp4"
        source_path.write_bytes(b"fake mp4 preview bytes")

        encrypted_path = privacy.write_encrypted_temp_file(source_path, "unit")

        self.assertTrue(encrypted_path.name.endswith(".mp4.enc"))
        self.assertNotEqual(encrypted_path.read_bytes(), source_path.read_bytes())
        self.assertEqual(privacy.decrypt_bytes(encrypted_path.read_bytes()), source_path.read_bytes())


if __name__ == "__main__":
    unittest.main()

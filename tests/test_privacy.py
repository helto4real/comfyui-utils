from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

from PIL import Image


class PrivacyTests(unittest.TestCase):
    def setUp(self):
        self._old_folder_paths = sys.modules.get("folder_paths")
        self._old_env = {
            "HELTO_PRIVACY_KEYSTORE": os.environ.get("HELTO_PRIVACY_KEYSTORE"),
            "HELTO_PRIVACY_SESSION_DIR": os.environ.get("HELTO_PRIVACY_SESSION_DIR"),
        }
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        os.environ["HELTO_PRIVACY_KEYSTORE"] = str(self.root / "privacy_keystore.json")
        os.environ["HELTO_PRIVACY_SESSION_DIR"] = str(self.root / "session")
        folder_paths = types.ModuleType("folder_paths")
        self.temp_dir = self.root / "temp"
        self.temp_dir.mkdir()
        folder_paths.get_temp_directory = lambda: str(self.temp_dir)
        sys.modules["folder_paths"] = folder_paths
        if "shared.privacy" in sys.modules:
            sys.modules["shared.privacy"].folder_paths = folder_paths

    def tearDown(self):
        for key, value in self._old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        if self._old_folder_paths is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = self._old_folder_paths
        self._tmp.cleanup()

    def _initialize_keystore(self):
        from helto_privacy import initialize_keystore

        initialize_keystore("correct horse battery staple")

    def test_crypto_roundtrip_and_encrypted_token_validation(self):
        from shared import privacy

        self._initialize_keystore()
        encrypted = privacy.encrypt_bytes(b"secret preview", purpose="unit-test")
        envelope = json.loads(encrypted.decode("utf-8"))

        self.assertNotIn(b"secret preview", encrypted)
        self.assertEqual(envelope["schema"], "helto.comfyui-utils.bytes")
        self.assertEqual(envelope["purpose"], "unit-test")
        self.assertEqual(privacy.decrypt_bytes(encrypted, purpose="unit-test"), b"secret preview")

        token = privacy.sign_media_token({"path": "/tmp/example.png", "encrypted": True})
        self.assertNotIn("/tmp/example.png", token)
        payload = privacy.verify_media_token(token)
        self.assertEqual(payload["path"], "/tmp/example.png")
        self.assertTrue(payload["encrypted"])
        with self.assertRaises(Exception):
            privacy.verify_media_token(token + "x")

    def test_encrypt_requires_shared_keystore_instead_of_key_file_fallback(self):
        from shared import privacy

        with self.assertRaisesRegex(Exception, "PRIVACY_KEYSTORE_UNINITIALIZED"):
            privacy.encrypt_bytes(b"no fallback", purpose="unit-test")
        self.assertFalse((self.root / "config" / "privacy_key.json").exists())

    def test_fast_crypto_uses_chunked_byte_envelope_for_large_payloads(self):
        import helto_privacy.envelope as envelope_module
        from shared import privacy

        self._initialize_keystore()
        original_chunk_size = envelope_module.BYTE_CHUNK_SIZE
        try:
            envelope_module.BYTE_CHUNK_SIZE = 7
            plaintext = b"chunked private payload"
            encrypted = privacy.encrypt_bytes(plaintext, purpose="chunk-test")
            payload = json.loads(encrypted.decode("utf-8"))
            self.assertEqual(payload["schema"], "helto.comfyui-utils.bytes.chunked")
            self.assertEqual(privacy.decrypt_bytes(encrypted, purpose="chunk-test"), plaintext)
        finally:
            envelope_module.BYTE_CHUNK_SIZE = original_chunk_size

    def test_legacy_byte_payloads_fail_closed(self):
        from shared import privacy

        self._initialize_keystore()
        with self.assertRaises(Exception):
            privacy.decrypt_bytes(b"HELTO_PRIV1:not-a-json-envelope", purpose="unit-test")

    def test_encrypted_preview_file_decrypts_to_png(self):
        from io import BytesIO

        from shared import privacy

        self._initialize_keystore()

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

        self._initialize_keystore()

        source_path = self.temp_dir / "preview.mp4"
        source_path.write_bytes(b"fake mp4 preview bytes")

        encrypted_path = privacy.write_encrypted_temp_file(source_path, "unit")

        self.assertTrue(encrypted_path.name.endswith(".mp4.enc"))
        self.assertNotEqual(encrypted_path.read_bytes(), source_path.read_bytes())
        self.assertEqual(privacy.decrypt_bytes(encrypted_path.read_bytes()), source_path.read_bytes())


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from shared.queue_manager_store import (
    default_queue_manager_state,
    load_queue_manager_state,
    save_queue_manager_state,
)


class QueueManagerStoreTests(unittest.TestCase):
    def test_missing_state_returns_default_paused_queue(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result = load_queue_manager_state(Path(tmpdir) / "missing.sqlite3")

        self.assertTrue(result["ok"])
        self.assertFalse(result["encrypted_at_rest"])
        self.assertTrue(result["privacy_enabled"])
        self.assertTrue(result["state"]["privacy_enabled"])
        self.assertTrue(result["state"]["paused"])
        self.assertEqual(result["state"]["queue"], [])
        self.assertEqual(result["state"]["history"], [])

    def test_plain_state_round_trips(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "state.sqlite3"
            state = default_queue_manager_state()
            state["queue"] = [{"id": "run-a", "title": "plain workflow", "status": "pending"}]

            save_queue_manager_state(state, privacy_enabled=False, path=path)
            raw = path.read_bytes()
            result = load_queue_manager_state(path)

        self.assertIn(b"plain workflow", raw)
        self.assertEqual(result["state"]["queue"][0]["title"], "plain workflow")
        self.assertFalse(result["privacy_enabled"])
        self.assertFalse(result["encrypted_at_rest"])

    def test_private_state_encrypts_payload_at_rest(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "state.sqlite3"
            state = default_queue_manager_state()
            state["privacy_enabled"] = True
            state["queue"] = [{
                "id": "run-private",
                "title": "secret workflow",
                "status": "pending",
                "prompt": {"workflow": {"name": "private graph"}},
            }]

            save_queue_manager_state(state, privacy_enabled=True, path=path)
            raw = path.read_bytes()
            result = load_queue_manager_state(path)

        self.assertNotIn(b"secret workflow", raw)
        self.assertNotIn(b"private graph", raw)
        self.assertEqual(result["state"]["queue"][0]["title"], "secret workflow")
        self.assertTrue(result["encrypted_at_rest"])

    def test_privacy_toggle_rewrites_plaintext_database_as_encrypted(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "state.sqlite3"
            state = default_queue_manager_state()
            state["privacy_enabled"] = False
            state["queue"] = [{
                "id": "run-toggle",
                "title": "toggle secret workflow",
                "status": "pending",
                "prompt": {"workflow": {"name": "toggle private graph"}},
            }]

            save_queue_manager_state(state, privacy_enabled=False, path=path)
            self.assertIn(b"toggle secret workflow", path.read_bytes())

            save_queue_manager_state(state, privacy_enabled=True, path=path)
            raw = path.read_bytes()
            result = load_queue_manager_state(path)

        self.assertNotIn(b"toggle secret workflow", raw)
        self.assertNotIn(b"toggle private graph", raw)
        self.assertEqual(result["state"]["queue"][0]["title"], "toggle secret workflow")
        self.assertTrue(result["privacy_enabled"])
        self.assertTrue(result["encrypted_at_rest"])

    def test_privacy_toggle_decrypts_database_when_disabled(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "state.sqlite3"
            state = default_queue_manager_state()
            state["privacy_enabled"] = True
            state["history"] = [{
                "id": "run-history",
                "title": "decrypt visible workflow",
                "status": "completed",
            }]

            save_queue_manager_state(state, privacy_enabled=True, path=path)
            self.assertNotIn(b"decrypt visible workflow", path.read_bytes())

            save_queue_manager_state(state, privacy_enabled=False, path=path)
            raw = path.read_bytes()
            result = load_queue_manager_state(path)

        self.assertIn(b"decrypt visible workflow", raw)
        self.assertEqual(result["state"]["history"][0]["title"], "decrypt visible workflow")
        self.assertFalse(result["privacy_enabled"])
        self.assertFalse(result["encrypted_at_rest"])

    def test_legacy_json_state_migrates_to_sqlite_and_is_removed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "state.sqlite3"
            legacy_path = Path(tmpdir) / "queue_manager_state.json"
            legacy_payload = {
                "version": 1,
                "privacy_enabled": False,
                "server_session_id": "old-session",
                "payload": {
                    **default_queue_manager_state(),
                    "privacy_enabled": False,
                    "queue": [{"id": "legacy", "title": "legacy workflow", "status": "pending"}],
                },
            }
            legacy_path.write_text(json.dumps(legacy_payload), encoding="utf-8")

            result = load_queue_manager_state(db_path, legacy_path=legacy_path)
            raw = db_path.read_bytes()

        self.assertFalse(legacy_path.exists())
        self.assertIn(b"legacy workflow", raw)
        self.assertEqual(result["state"]["queue"][0]["title"], "legacy workflow")
        self.assertEqual(result["stored_server_session_id"], "old-session")


if __name__ == "__main__":
    unittest.main()

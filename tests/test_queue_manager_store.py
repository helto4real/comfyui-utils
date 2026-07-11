from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

import pytest

from shared.queue_manager_store import (
    default_queue_manager_state,
    load_queue_manager_state,
    save_queue_manager_state,
)


pytestmark = pytest.mark.usefixtures("inactive_coordinated_suite_test_boundary")


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
            yield
        finally:
            for key, value in old_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def stored_queue_state_row(path: Path) -> tuple[bytes, int]:
    conn = sqlite3.connect(path)
    try:
        row = conn.execute(
            "SELECT payload, updated_at FROM queue_manager_state WHERE id = 1"
        ).fetchone()
    finally:
        conn.close()
    assert row is not None
    return bytes(row[0]), int(row[1])


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
        with isolated_privacy_keystore(), tempfile.TemporaryDirectory() as tmpdir:
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

    def test_private_state_reuses_encrypted_payload_when_unchanged(self):
        with isolated_privacy_keystore(), tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "state.sqlite3"
            state = default_queue_manager_state()
            state["privacy_enabled"] = True
            state["queue"] = [{
                "id": "run-private",
                "title": "stable secret workflow",
                "status": "pending",
                "prompt": {"workflow": {"name": "stable private graph"}},
            }]

            first = save_queue_manager_state(state, privacy_enabled=True, path=path)
            first_payload, first_updated_at = stored_queue_state_row(path)
            state["updated_at"] = 1
            second = save_queue_manager_state(state, privacy_enabled=True, path=path)
            second_payload, second_updated_at = stored_queue_state_row(path)

            state["queue"][0]["title"] = "edited secret workflow"
            save_queue_manager_state(state, privacy_enabled=True, path=path)
            changed_payload, changed_updated_at = stored_queue_state_row(path)
            raw = path.read_bytes()

        self.assertEqual(second_payload, first_payload)
        self.assertEqual(second_updated_at, first_updated_at)
        self.assertEqual(second["state"]["updated_at"], first["state"]["updated_at"])
        self.assertNotEqual(changed_payload, first_payload)
        self.assertGreaterEqual(changed_updated_at, first_updated_at)
        self.assertNotIn(b"stable secret workflow", raw)
        self.assertNotIn(b"edited secret workflow", raw)

    def test_privacy_toggle_rewrites_plaintext_database_as_encrypted(self):
        with isolated_privacy_keystore(), tempfile.TemporaryDirectory() as tmpdir:
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
        with isolated_privacy_keystore(), tempfile.TemporaryDirectory() as tmpdir:
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

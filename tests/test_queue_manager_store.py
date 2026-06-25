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
            result = load_queue_manager_state(Path(tmpdir) / "missing.json")

        self.assertTrue(result["ok"])
        self.assertFalse(result["encrypted_at_rest"])
        self.assertTrue(result["state"]["paused"])
        self.assertEqual(result["state"]["queue"], [])
        self.assertEqual(result["state"]["history"], [])

    def test_plain_state_round_trips(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "state.json"
            state = default_queue_manager_state()
            state["queue"] = [{"id": "run-a", "title": "plain workflow", "status": "pending"}]

            save_queue_manager_state(state, privacy_enabled=False, path=path)
            raw = path.read_text(encoding="utf-8")
            envelope = json.loads(path.read_text(encoding="utf-8"))
            result = load_queue_manager_state(path)

        self.assertFalse(envelope["privacy_enabled"])
        self.assertIn("plain workflow", raw)
        self.assertEqual(result["state"]["queue"][0]["title"], "plain workflow")
        self.assertFalse(result["encrypted_at_rest"])

    def test_private_state_encrypts_payload_at_rest(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "state.json"
            state = default_queue_manager_state()
            state["privacy_enabled"] = True
            state["queue"] = [{
                "id": "run-private",
                "title": "secret workflow",
                "status": "pending",
                "prompt": {"workflow": {"name": "private graph"}},
            }]

            save_queue_manager_state(state, privacy_enabled=True, path=path)
            raw = path.read_text(encoding="utf-8")
            envelope = json.loads(raw)
            result = load_queue_manager_state(path)

        self.assertTrue(envelope["privacy_enabled"])
        self.assertIsInstance(envelope["payload"], str)
        self.assertNotIn("secret workflow", raw)
        self.assertNotIn("private graph", raw)
        self.assertEqual(result["state"]["queue"][0]["title"], "secret workflow")
        self.assertTrue(result["encrypted_at_rest"])


if __name__ == "__main__":
    unittest.main()

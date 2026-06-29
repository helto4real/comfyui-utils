from __future__ import annotations

import json
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from shared import progress_api


class ProgressApiTests(unittest.TestCase):
    def test_public_alias_is_registered(self):
        self.assertIs(sys.modules["helto_progress"], progress_api)

    def test_report_normalizes_payload(self):
        sent = []

        with patch.object(progress_api, "_send_payload", side_effect=lambda payload: sent.append(payload) or True):
            payload = progress_api.report(
                "Loading",
                phase="load",
                value=3,
                total=4,
                percent=150,
                level="nope",
                detail={"ok": True},
                node_id=7,
                prompt_id="prompt-a",
            )

        self.assertEqual(payload["version"], 1)
        self.assertEqual(payload["event"], "report")
        self.assertEqual(payload["prompt_id"], "prompt-a")
        self.assertEqual(payload["node_id"], "7")
        self.assertEqual(payload["display_node_id"], "7")
        self.assertEqual(payload["phase"], "load")
        self.assertEqual(payload["message"], "Loading")
        self.assertEqual(payload["value"], 3.0)
        self.assertEqual(payload["total"], 4.0)
        self.assertEqual(payload["percent"], 100.0)
        self.assertEqual(payload["level"], "info")
        self.assertEqual(sent, [payload])

    def test_context_and_dynamic_prompt_metadata_are_used_when_ids_are_implicit(self):
        package = types.ModuleType("comfy_execution")
        utils = types.ModuleType("comfy_execution.utils")
        progress = types.ModuleType("comfy_execution.progress")

        utils.get_executing_context = lambda: SimpleNamespace(prompt_id="ctx-prompt", node_id="9")

        class DynPrompt:
            def get_display_node_id(self, node_id):
                return f"display-{node_id}"

            def get_parent_node_id(self, node_id):
                return f"parent-{node_id}"

            def get_real_node_id(self, node_id):
                return f"real-{node_id}"

        progress.get_progress_state = lambda: SimpleNamespace(dynprompt=DynPrompt())

        with patch.dict(sys.modules, {
            "comfy_execution": package,
            "comfy_execution.utils": utils,
            "comfy_execution.progress": progress,
        }):
            with patch.object(progress_api, "_send_payload", return_value=True):
                payload = progress_api.update("Working", value=1, total=2)

        self.assertEqual(payload["prompt_id"], "ctx-prompt")
        self.assertEqual(payload["node_id"], "9")
        self.assertEqual(payload["display_node_id"], "display-9")
        self.assertEqual(payload["parent_node_id"], "parent-9")
        self.assertEqual(payload["real_node_id"], "real-9")
        self.assertEqual(payload["percent"], 50.0)

    def test_send_payload_uses_current_client_id(self):
        sent = []
        server_module = types.ModuleType("server")

        class PromptServer:
            instance = SimpleNamespace(
                client_id="client-a",
                send_sync=lambda event, payload, sid: sent.append((event, payload, sid)),
            )

        server_module.PromptServer = PromptServer

        with patch.dict(sys.modules, {"server": server_module}):
            ok = progress_api._send_payload({"message": "hello"})

        self.assertTrue(ok)
        self.assertEqual(sent, [("helto_progress", {"message": "hello"}, "client-a")])

    def test_send_payload_noops_without_client_id(self):
        sent = []
        server_module = types.ModuleType("server")

        class PromptServer:
            instance = SimpleNamespace(
                client_id=None,
                send_sync=lambda event, payload, sid: sent.append((event, payload, sid)),
            )

        server_module.PromptServer = PromptServer

        with patch.dict(sys.modules, {"server": server_module}):
            ok = progress_api._send_payload({"message": "hello"})

        self.assertFalse(ok)
        self.assertEqual(sent, [])

    def test_native_progress_mirror_uses_explicit_value_and_total(self):
        updates = []
        package = types.ModuleType("comfy_execution")
        progress = types.ModuleType("comfy_execution.progress")

        progress.get_progress_state = lambda: SimpleNamespace(
            dynprompt=SimpleNamespace(),
            update_progress=lambda node_id, value, total, image: updates.append((node_id, value, total, image)),
        )

        with patch.dict(sys.modules, {
            "comfy_execution": package,
            "comfy_execution.progress": progress,
        }):
            with patch.object(progress_api, "_send_payload", return_value=True):
                payload = progress_api.update("Working", value=3, total=5, node_id=7)

        self.assertEqual(payload["value"], 3.0)
        self.assertEqual(payload["total"], 5.0)
        self.assertEqual(payload["percent"], 60.0)
        self.assertEqual(updates, [("7", 3.0, 5.0, None)])

    def test_native_progress_mirror_uses_percent_when_value_total_are_absent(self):
        updates = []
        package = types.ModuleType("comfy_execution")
        progress = types.ModuleType("comfy_execution.progress")

        progress.get_progress_state = lambda: SimpleNamespace(
            dynprompt=SimpleNamespace(),
            update_progress=lambda node_id, value, total, image: updates.append((node_id, value, total, image)),
        )

        with patch.dict(sys.modules, {
            "comfy_execution": package,
            "comfy_execution.progress": progress,
        }):
            with patch.object(progress_api, "_send_payload", return_value=True):
                payload = progress_api.update("Working", percent=250, node_id="8")

        self.assertIsNone(payload["value"])
        self.assertIsNone(payload["total"])
        self.assertEqual(payload["percent"], 100.0)
        self.assertEqual(updates, [("8", 100.0, 100.0, None)])

    def test_native_progress_mirror_noops_without_node_id(self):
        updates = []
        package = types.ModuleType("comfy_execution")
        progress = types.ModuleType("comfy_execution.progress")

        progress.get_progress_state = lambda: SimpleNamespace(
            dynprompt=SimpleNamespace(),
            update_progress=lambda node_id, value, total, image: updates.append((node_id, value, total, image)),
        )

        with patch.dict(sys.modules, {
            "comfy_execution": package,
            "comfy_execution.progress": progress,
        }):
            with patch.object(progress_api, "_send_payload", return_value=True):
                payload = progress_api.update("Working", value=1, total=2)

        self.assertIsNone(payload["node_id"])
        self.assertEqual(updates, [])

    def test_native_progress_mirror_noops_when_comfy_progress_is_unavailable(self):
        package = types.ModuleType("comfy_execution")
        progress = types.ModuleType("comfy_execution.progress")

        def fail():
            raise RuntimeError("progress state unavailable")

        progress.get_progress_state = fail

        with patch.dict(sys.modules, {
            "comfy_execution": package,
            "comfy_execution.progress": progress,
        }):
            with patch.object(progress_api, "_send_payload", return_value=True) as send_payload:
                payload = progress_api.update("Working", value=1, total=2, node_id="9")

        self.assertEqual(payload["node_id"], "9")
        send_payload.assert_called_once_with(payload)

    def test_native_text_mirror_sends_message(self):
        sent = []
        server_module = types.ModuleType("server")

        class PromptServer:
            instance = SimpleNamespace(
                client_id="client-a",
                send_progress_text=lambda text, node_id, sid: sent.append((text, node_id, sid)),
            )

        server_module.PromptServer = PromptServer

        with patch.dict(sys.modules, {"server": server_module}):
            ok = progress_api._mirror_native_text({
                "node_id": "7",
                "message": "Loading model",
                "detail": None,
            })

        self.assertTrue(ok)
        self.assertEqual(len(sent), 1)
        text, node_id, sid = sent[0]
        self.assertEqual(node_id, progress_api.TEXT_BRIDGE_NODE_ID)
        self.assertEqual(sid, "client-a")
        bridge = json.loads(text)
        self.assertEqual(bridge["node_id"], "7")
        self.assertEqual(bridge["text"], "Loading model")

    def test_native_text_mirror_sends_message_and_detail_log(self):
        sent = []
        server_module = types.ModuleType("server")

        class PromptServer:
            instance = SimpleNamespace(
                client_id="client-a",
                send_progress_text=lambda text, node_id, sid: sent.append((text, node_id, sid)),
            )

        server_module.PromptServer = PromptServer

        with patch.dict(sys.modules, {"server": server_module}):
            ok = progress_api._mirror_native_text({
                "node_id": 8,
                "message": "Encoding frame",
                "detail": {"log": "ffmpeg accepted frame 4"},
            })

        self.assertTrue(ok)
        self.assertEqual(len(sent), 1)
        text, node_id, sid = sent[0]
        self.assertEqual(node_id, progress_api.TEXT_BRIDGE_NODE_ID)
        self.assertEqual(sid, "client-a")
        bridge = json.loads(text)
        self.assertEqual(bridge["node_id"], "8")
        self.assertEqual(bridge["text"], "Encoding frame | ffmpeg accepted frame 4")

    def test_native_text_mirror_noops_without_required_server_state(self):
        sent = []
        self.assertFalse(progress_api._mirror_native_text({"message": "Working"}))
        self.assertFalse(progress_api._mirror_native_text({"node_id": "1", "message": "   "}))

        server_module = types.ModuleType("server")
        server_module.PromptServer = SimpleNamespace(instance=SimpleNamespace(client_id="client-a"))
        with patch.dict(sys.modules, {"server": server_module}):
            self.assertFalse(progress_api._mirror_native_text({"node_id": "1", "message": "Working"}))

        class PromptServer:
            instance = SimpleNamespace(
                client_id=None,
                send_progress_text=lambda text, node_id, sid: sent.append((text, node_id, sid)),
            )

        server_module.PromptServer = PromptServer
        with patch.dict(sys.modules, {"server": server_module}):
            self.assertFalse(progress_api._mirror_native_text({"node_id": "1", "message": "Working"}))

        self.assertEqual(sent, [])

    def test_emit_preserves_custom_event_numeric_mirror_and_text_mirror(self):
        sent_events = []
        text_events = []
        progress_updates = []
        server_module = types.ModuleType("server")
        package = types.ModuleType("comfy_execution")
        progress = types.ModuleType("comfy_execution.progress")

        class PromptServer:
            instance = SimpleNamespace(
                client_id="client-a",
                send_sync=lambda event, payload, sid: sent_events.append((event, payload, sid)),
                send_progress_text=lambda text, node_id, sid: text_events.append((text, node_id, sid)),
            )

        server_module.PromptServer = PromptServer
        progress.get_progress_state = lambda: SimpleNamespace(
            dynprompt=SimpleNamespace(),
            update_progress=lambda node_id, value, total, image: progress_updates.append((node_id, value, total, image)),
        )

        with patch.dict(sys.modules, {
            "server": server_module,
            "comfy_execution": package,
            "comfy_execution.progress": progress,
        }):
            payload = progress_api.update(
                "Writing frame",
                value=4,
                total=10,
                detail={"log": "ffmpeg accepted frame 4"},
                node_id="9",
                prompt_id="prompt-a",
            )

        self.assertEqual(sent_events, [("helto_progress", payload, "client-a")])
        self.assertEqual(progress_updates, [("9", 4.0, 10.0, None)])
        self.assertEqual(len(text_events), 1)
        text, node_id, sid = text_events[0]
        self.assertEqual(node_id, progress_api.TEXT_BRIDGE_NODE_ID)
        self.assertEqual(sid, "client-a")
        bridge = json.loads(text)
        self.assertEqual(bridge["prompt_id"], "prompt-a")
        self.assertEqual(bridge["node_id"], "9")
        self.assertEqual(bridge["text"], "Writing frame | ffmpeg accepted frame 4")


if __name__ == "__main__":
    unittest.main()

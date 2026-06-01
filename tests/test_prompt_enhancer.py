from __future__ import annotations

import asyncio
import importlib
import random
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

from shared.prompt_enhancer import prompts
from shared.prompt_enhancer.provider import (
    DEFAULT_OLLAMA_URL,
    IMAGE_SYSTEM_PROMPT,
    MAX_PROMPT_IMAGES,
    OllamaPromptProvider,
    PromptEnhancerRequest,
    PromptEnhancerSettings,
    build_system_prompt,
    encode_images_for_ollama,
    ollama_keep_alive,
    resolve_seed,
)
from shared.prompt_enhancer.variables import decrypt_prompt_text, parse_prompt_variables, substitute_prompt_variables
from helto_selector_backend.crypto import encrypt_selection


class PromptEnhancerProviderTests(unittest.TestCase):
    def test_resolve_seed_keeps_fixed_and_randomizes_negative(self):
        self.assertEqual(resolve_seed(42), 42)
        self.assertEqual(resolve_seed("7"), 7)
        self.assertEqual(resolve_seed(-1, random.Random(1)), 577090037)

    def test_system_prompt_mentions_media_scope_for_each_type(self):
        image_prompt = build_system_prompt("image")
        video_prompt = build_system_prompt("video", has_video=True)
        multi_prompt = build_system_prompt("multi scene video", has_audio=True)

        self.assertEqual(image_prompt, IMAGE_SYSTEM_PROMPT)
        self.assertIn("expert prompt enhancer for ComfyUI image generation workflows", image_prompt)
        self.assertIn("Only output the prompt itself.", image_prompt)
        self.assertIn("video generation prompt", video_prompt)
        self.assertIn("does not send video bytes", video_prompt)
        self.assertIn("multi-scene video prompt", multi_prompt)
        self.assertIn("does not send audio bytes", multi_prompt)

    def test_system_prompt_override_and_reset_uses_user_config(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.object(prompts, "USER_PROMPT_DIR", Path(tmpdir)):
            self.assertEqual(prompts.load_system_prompt("image"), IMAGE_SYSTEM_PROMPT)
            default_payload = prompts.system_prompt_payload("image")
            self.assertEqual(default_payload["prompt"], IMAGE_SYSTEM_PROMPT)
            self.assertTrue(default_payload["is_default"])

            saved_payload = prompts.save_system_prompt("image", "custom image prompt")

            self.assertEqual(saved_payload["prompt"], "custom image prompt")
            self.assertFalse(saved_payload["is_default"])
            self.assertEqual(build_system_prompt("image"), "custom image prompt")
            self.assertTrue(prompts.user_prompt_path("image").exists())

            reset_payload = prompts.reset_system_prompt("image")

            self.assertEqual(reset_payload["prompt"], IMAGE_SYSTEM_PROMPT)
            self.assertTrue(reset_payload["is_default"])
            self.assertFalse(prompts.user_prompt_path("image").exists())

    def test_video_system_prompt_template_is_editable_and_falls_back_on_invalid_placeholders(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.object(prompts, "USER_PROMPT_DIR", Path(tmpdir)):
            prompts.save_system_prompt("video", "Custom video: {focus}. Note: {media_note}")

            video_prompt = build_system_prompt("video", has_video=True)
            multi_prompt = build_system_prompt("multi scene video", has_audio=True)

            self.assertIn("Custom video: a concise video generation prompt", video_prompt)
            self.assertIn("does not send video bytes", video_prompt)
            self.assertIn("Custom video: a multi-scene video prompt", multi_prompt)
            self.assertIn("does not send audio bytes", multi_prompt)

            prompts.save_system_prompt("video", "Broken {missing}")

            fallback_prompt = build_system_prompt("video")

            self.assertIn("a concise video generation prompt", fallback_prompt)
            self.assertNotIn("Broken", fallback_prompt)

    def test_system_prompt_save_rejects_blank_or_unknown_kind(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.object(prompts, "USER_PROMPT_DIR", Path(tmpdir)):
            with self.assertRaisesRegex(ValueError, "blank"):
                prompts.save_system_prompt("image", "   ")
            with self.assertRaisesRegex(ValueError, "Unknown"):
                prompts.system_prompt_payload("audio")

    def test_image_encoding_samples_at_most_eight_pngs(self):
        images = torch.zeros((12, 4, 4, 3), dtype=torch.float32)
        encoded = encode_images_for_ollama(images)

        self.assertEqual(len(encoded), MAX_PROMPT_IMAGES)
        self.assertTrue(all(isinstance(item, str) and item for item in encoded))

    def test_ollama_keep_alive_supports_seconds_and_zero_release(self):
        self.assertEqual(ollama_keep_alive(3, "seconds"), "3s")
        self.assertEqual(ollama_keep_alive(2, "minutes"), "2m")
        self.assertEqual(ollama_keep_alive(1, "hours"), "1h")
        self.assertEqual(ollama_keep_alive(0, "seconds"), "0s")
        self.assertEqual(ollama_keep_alive(0, "minutes"), "0s")
        self.assertEqual(ollama_keep_alive(0, "hours"), "0s")

    def test_list_models_reads_ollama_tags_payload(self):
        with patch("shared.prompt_enhancer.provider._json_request") as request:
            request.return_value = {"models": [{"model": "b:latest"}, {"name": "a:latest"}, {"model": "b:latest"}]}

            models = OllamaPromptProvider().list_models(DEFAULT_OLLAMA_URL, 3)

        self.assertEqual(models, ["a:latest", "b:latest"])
        self.assertEqual(request.call_args.args[1], None)
        self.assertEqual(request.call_args.args[2], 3)
        self.assertTrue(request.call_args.args[0].endswith("/api/tags"))

    def test_generate_builds_ollama_payload(self):
        settings = PromptEnhancerSettings(ollama_url=DEFAULT_OLLAMA_URL, keep_alive=2, keep_alive_unit="hours", timeout=9)
        prompt_request = PromptEnhancerRequest(
            model="llava:latest",
            prompt_type="image",
            prompt="make it cinematic",
            system_prompt="system text",
            seed=123,
            images=["abc"],
            settings=settings,
        )

        with patch("shared.prompt_enhancer.provider._json_request") as request:
            request.return_value = {"response": " enhanced prompt "}

            result = OllamaPromptProvider().generate(prompt_request)

        self.assertEqual(result, "enhanced prompt")
        request.assert_called_once()
        payload = request.call_args.args[1]
        self.assertEqual(payload["model"], "llava:latest")
        self.assertEqual(payload["system"], "system text")
        self.assertEqual(payload["prompt"], "make it cinematic")
        self.assertEqual(payload["keep_alive"], "2h")
        self.assertEqual(payload["options"], {"seed": 123})
        self.assertEqual(payload["images"], ["abc"])
        self.assertFalse(payload["stream"])
        self.assertEqual(request.call_args.args[2], 9)

    def test_generate_waits_for_zero_keep_alive_unload_before_returning(self):
        settings = PromptEnhancerSettings(ollama_url=DEFAULT_OLLAMA_URL, keep_alive=0, keep_alive_unit="minutes", timeout=9)
        prompt_request = PromptEnhancerRequest(
            model="llava:latest",
            prompt_type="image",
            prompt="make it cinematic",
            system_prompt="system text",
            seed=123,
            images=[],
            settings=settings,
        )

        with patch("shared.prompt_enhancer.provider._json_request") as request:
            request.side_effect = [{"response": " enhanced prompt "}, {"done": True}]

            result = OllamaPromptProvider().generate(prompt_request)

        self.assertEqual(result, "enhanced prompt")
        self.assertEqual(request.call_count, 2)
        generate_payload = request.call_args_list[0].args[1]
        unload_payload = request.call_args_list[1].args[1]
        self.assertEqual(generate_payload["keep_alive"], "0s")
        self.assertEqual(unload_payload, {"model": "llava:latest", "keep_alive": 0, "stream": False})
        self.assertEqual(request.call_args_list[1].args[2], 9)

    def test_prompt_variables_parse_plain_and_encrypted_json(self):
        plain = json_dumps([
            {"name": "style", "mode": "random", "values": ["cinematic", "documentary"], "fixed_index": 4},
            {"name": "bad-name", "values": ["ignored"]},
        ])
        encrypted = encrypt_selection(plain)

        expected = [
            {
                "name": "style",
                "mode": "random",
                "values": ["cinematic", "documentary"],
                "fixed_index": 1,
            }
        ]

        self.assertEqual(parse_prompt_variables(plain), expected)
        self.assertEqual(parse_prompt_variables(encrypted), expected)

    def test_prompt_variables_substitute_fixed_random_and_unknown_tokens(self):
        variables = [
            {"name": "style", "mode": "fixed", "values": ["cinematic", "documentary"], "fixed_index": 1},
            {"name": "lighting", "mode": "random", "values": ["soft", "hard"], "fixed_index": 0},
            {"name": "empty", "mode": "random", "values": [], "fixed_index": 0},
        ]

        prompt = "{{style}} portrait, {{lighting}} light, {{missing}}, {{empty}}"
        first = substitute_prompt_variables(prompt, variables, 123)
        second = substitute_prompt_variables(prompt, variables, 123)

        self.assertEqual(first, second)
        self.assertIn("documentary portrait", first)
        self.assertIn("{{missing}}", first)
        self.assertTrue(first.endswith(", "))

    def test_prompt_variables_ignore_invalid_payloads(self):
        self.assertEqual(parse_prompt_variables("not-json"), [])
        self.assertEqual(substitute_prompt_variables("keep {{style}}", "not-json", 1), "keep {{style}}")

    def test_encrypted_prompt_text_decrypts_and_invalid_values_fail_closed(self):
        encrypted = encrypt_selection("secret prompt")

        self.assertEqual(decrypt_prompt_text("plain prompt"), "plain prompt")
        self.assertEqual(decrypt_prompt_text(encrypted), "secret prompt")
        self.assertEqual(decrypt_prompt_text("__HELTO_ENC__:not-valid"), "")


class PromptEnhancerRouteTests(unittest.TestCase):
    def setUp(self):
        self._server_module = sys.modules.get("server")
        self._aiohttp_module = sys.modules.get("aiohttp")
        self._aiohttp_web_module = sys.modules.get("aiohttp.web")
        fake_routes = types.SimpleNamespace(
            get=lambda _path: (lambda fn: fn),
            post=lambda _path: (lambda fn: fn),
        )
        sys.modules["server"] = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=fake_routes)))
        fake_web = types.SimpleNamespace(json_response=self._json_response)
        sys.modules["aiohttp"] = types.SimpleNamespace(web=fake_web)
        sys.modules["aiohttp.web"] = fake_web
        sys.modules.pop("shared.prompt_enhancer.routes", None)

    def tearDown(self):
        sys.modules.pop("shared.prompt_enhancer.routes", None)
        if self._server_module is None:
            sys.modules.pop("server", None)
        else:
            sys.modules["server"] = self._server_module
        if self._aiohttp_module is None:
            sys.modules.pop("aiohttp", None)
        else:
            sys.modules["aiohttp"] = self._aiohttp_module
        if self._aiohttp_web_module is None:
            sys.modules.pop("aiohttp.web", None)
        else:
            sys.modules["aiohttp.web"] = self._aiohttp_web_module

    @staticmethod
    def _json_response(payload, status=200):
        return types.SimpleNamespace(status=status, text=json_dumps(payload))

    def test_model_route_returns_models(self):
        routes = importlib.import_module("shared.prompt_enhancer.routes")
        async def fake_to_thread(func, *args):
            return func(*args)

        with patch.object(routes.asyncio, "to_thread", fake_to_thread), patch.object(routes.OllamaPromptProvider, "list_models", return_value=["m1"]):
            response = asyncio.run(routes._request_models({"url": "http://localhost:11434", "timeout": 5}))

        self.assertEqual(response.status, 200)
        self.assertEqual(response.text, '{"models": ["m1"]}')

    def test_model_route_returns_error_payload(self):
        routes = importlib.import_module("shared.prompt_enhancer.routes")
        async def fake_to_thread(func, *args):
            return func(*args)

        with patch.object(routes.asyncio, "to_thread", fake_to_thread), patch.object(routes.OllamaPromptProvider, "list_models", side_effect=RuntimeError("offline")):
            response = asyncio.run(routes._request_models({"url": "http://localhost:11434"}))

        self.assertEqual(response.status, 400)
        self.assertIn('"error": "offline"', response.text)
        self.assertIn('"models": []', response.text)

    def test_system_prompt_routes_get_save_and_reset(self):
        routes = importlib.import_module("shared.prompt_enhancer.routes")

        with tempfile.TemporaryDirectory() as tmpdir, patch.object(prompts, "USER_PROMPT_DIR", Path(tmpdir)):
            get_response = asyncio.run(routes._request_system_prompt("image"))
            save_response = asyncio.run(routes._save_system_prompt({"kind": "image", "prompt": "route custom prompt"}))
            reset_response = asyncio.run(routes._reset_system_prompt({"kind": "image"}))

        self.assertEqual(get_response.status, 200)
        self.assertIn('"is_default": true', get_response.text)
        self.assertEqual(save_response.status, 200)
        self.assertIn('"prompt": "route custom prompt"', save_response.text)
        self.assertIn('"is_default": false', save_response.text)
        self.assertEqual(reset_response.status, 200)
        self.assertIn('"is_default": true', reset_response.text)

    def test_system_prompt_routes_return_errors(self):
        routes = importlib.import_module("shared.prompt_enhancer.routes")

        blank_response = asyncio.run(routes._save_system_prompt({"kind": "image", "prompt": " "}))
        unknown_response = asyncio.run(routes._request_system_prompt("audio"))

        self.assertEqual(blank_response.status, 400)
        self.assertIn("System prompt cannot be blank", blank_response.text)
        self.assertEqual(unknown_response.status, 400)
        self.assertIn("Unknown system prompt kind", unknown_response.text)


def json_dumps(payload):
    import json

    return json.dumps(payload)


if __name__ == "__main__":
    unittest.main()

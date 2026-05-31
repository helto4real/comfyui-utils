from __future__ import annotations

import asyncio
import importlib
import random
import sys
import types
import unittest
from unittest.mock import patch

import torch

from shared.prompt_enhancer.provider import (
    DEFAULT_OLLAMA_URL,
    MAX_PROMPT_IMAGES,
    OllamaPromptProvider,
    PromptEnhancerRequest,
    PromptEnhancerSettings,
    build_system_prompt,
    encode_images_for_ollama,
    resolve_seed,
)


class PromptEnhancerProviderTests(unittest.TestCase):
    def test_resolve_seed_keeps_fixed_and_randomizes_negative(self):
        self.assertEqual(resolve_seed(42), 42)
        self.assertEqual(resolve_seed("7"), 7)
        self.assertEqual(resolve_seed(-1, random.Random(1)), 577090037)

    def test_system_prompt_mentions_media_scope_for_each_type(self):
        image_prompt = build_system_prompt("image")
        video_prompt = build_system_prompt("video", has_video=True)
        multi_prompt = build_system_prompt("multi scene video", has_audio=True)

        self.assertIn("single high-quality image", image_prompt)
        self.assertIn("video generation prompt", video_prompt)
        self.assertIn("does not send video bytes", video_prompt)
        self.assertIn("multi-scene video prompt", multi_prompt)
        self.assertIn("does not send audio bytes", multi_prompt)

    def test_image_encoding_samples_at_most_eight_pngs(self):
        images = torch.zeros((12, 4, 4, 3), dtype=torch.float32)
        encoded = encode_images_for_ollama(images)

        self.assertEqual(len(encoded), MAX_PROMPT_IMAGES)
        self.assertTrue(all(isinstance(item, str) and item for item in encoded))

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
        payload = request.call_args.args[1]
        self.assertEqual(payload["model"], "llava:latest")
        self.assertEqual(payload["system"], "system text")
        self.assertEqual(payload["prompt"], "make it cinematic")
        self.assertEqual(payload["keep_alive"], "2h")
        self.assertEqual(payload["options"], {"seed": 123})
        self.assertEqual(payload["images"], ["abc"])
        self.assertFalse(payload["stream"])
        self.assertEqual(request.call_args.args[2], 9)


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


def json_dumps(payload):
    import json

    return json.dumps(payload)


if __name__ == "__main__":
    unittest.main()

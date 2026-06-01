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

from shared.prompt_enhancer import local_provider
from shared.prompt_enhancer import prompts
from shared.prompt_enhancer.provider import (
    DEFAULT_OLLAMA_URL,
    IMAGE_SYSTEM_PROMPT,
    MAX_PROMPT_IMAGES,
    OllamaPromptProvider,
    PromptEnhancerRequest,
    PromptEnhancerSettings,
    PromptEnhancerProgress,
    PromptProviderRegistry,
    build_system_prompt,
    encode_images_for_ollama,
    ollama_keep_alive,
    resolve_seed,
)
from shared.prompt_enhancer.variables import decrypt_prompt_text, parse_prompt_variables, substitute_prompt_variables
from shared.prompt_enhancer.video_script import (
    VideoScriptError,
    build_segment_variables,
    parse_video_prompt_script,
)
from helto_selector_backend.crypto import encrypt_selection


class PromptEnhancerProviderTests(unittest.TestCase):
    def test_progress_helper_updates_standard_bar_ranges_monotonically(self):
        updates = []

        class FakeProgressBar:
            def update_absolute(self, value, total=None):
                updates.append((value, total))

        with patch.object(PromptEnhancerProgress, "check_interrupted") as interrupted:
            progress = PromptEnhancerProgress("12", FakeProgressBar())
            progress.phase_fraction("media", 0.5)
            progress.generation_tokens(90, 180)
            progress.phase_done("release")
            progress.complete()

        self.assertEqual(updates[0], (0, 1000))
        self.assertEqual(updates[-1], (1000, 1000))
        self.assertEqual([value for value, _total in updates], sorted(value for value, _total in updates))
        self.assertGreaterEqual(interrupted.call_count, 4)

    def test_progress_helper_maps_multiple_model_calls_monotonically(self):
        updates = []

        class FakeProgressBar:
            def update_absolute(self, value, total=None):
                updates.append((value, total))

        with patch.object(PromptEnhancerProgress, "check_interrupted"):
            progress = PromptEnhancerProgress("12", FakeProgressBar())
            progress.phase_done("media")
            progress.begin_model_calls(3)
            for _index in range(3):
                with progress.model_call() as call_progress:
                    call_progress.phase_start("generate")
                    call_progress.generation_tokens(50, 100)
                    call_progress.phase_done("generate")
            before_cleanup = updates[-1][0]
            progress.phase_done("cleanup")
            progress.complete()

        values = [value for value, _total in updates]
        self.assertEqual(values, sorted(values))
        self.assertEqual(before_cleanup, 930)
        self.assertEqual(updates[-1], (1000, 1000))

    def test_progress_model_call_slice_streaming_stays_inside_active_call(self):
        updates = []

        class FakeProgressBar:
            def update_absolute(self, value, total=None):
                updates.append((value, total))

        with patch.object(PromptEnhancerProgress, "check_interrupted"):
            progress = PromptEnhancerProgress("12", FakeProgressBar())
            progress.begin_model_calls(2)
            with progress.model_call() as call_progress:
                call_progress.phase_start("generate")
                call_progress.generation_tokens(50, 100)
                mid_call_value = updates[-1][0]
                call_progress.phase_done("generate")
            first_call_done = updates[-1][0]

        self.assertLess(mid_call_value, first_call_done)
        self.assertLessEqual(first_call_done, 690)
        self.assertEqual([value for value, _total in updates], sorted(value for value, _total in updates))

    def test_resolve_seed_keeps_fixed_and_randomizes_negative(self):
        self.assertEqual(resolve_seed(42), 42)
        self.assertEqual(resolve_seed("7"), 7)
        self.assertEqual(resolve_seed(-1, random.Random(1)), 577090037)

    def test_system_prompt_mentions_media_scope_for_each_type(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.object(prompts, "USER_PROMPT_DIR", Path(tmpdir)):
            image_prompt = build_system_prompt("image")
            video_prompt = build_system_prompt("video", has_video=True)
            multi_prompt = build_system_prompt("multi scene video", has_audio=True)

        self.assertEqual(image_prompt, IMAGE_SYSTEM_PROMPT)
        self.assertIn("expert prompt enhancer for ComfyUI image generation workflows", image_prompt)
        self.assertIn("Only output the prompt itself.", image_prompt)
        self.assertIn("video generation prompt", video_prompt)
        self.assertIn("not sent as video bytes", video_prompt)
        self.assertIn("describe the referenced image content first for that role", video_prompt)
        self.assertIn("honor the user direction", video_prompt)
        self.assertIn("facial features, hair color and style", video_prompt)
        self.assertIn("coat or fur color", video_prompt)
        self.assertIn("multi-scene video prompt", multi_prompt)
        self.assertIn("not sent as audio bytes", multi_prompt)

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
            self.assertIn("not sent as video bytes", video_prompt)
            self.assertIn("Custom video: a multi-scene video prompt", multi_prompt)
            self.assertIn("not sent as audio bytes", multi_prompt)

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

    def test_image_encoding_reports_media_progress(self):
        images = torch.zeros((3, 4, 4, 3), dtype=torch.float32)
        updates = []

        class FakeProgress:
            def phase_done(self, phase):
                updates.append((phase, 1))

            def phase_fraction(self, phase, fraction):
                updates.append((phase, fraction))

        encode_images_for_ollama(images, progress=FakeProgress())

        self.assertEqual(updates[-1], ("media", 1))
        self.assertTrue(all(phase == "media" for phase, _fraction in updates))

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

    def test_generate_streams_ollama_when_progress_is_available_and_waits_for_unload(self):
        settings = PromptEnhancerSettings(ollama_url=DEFAULT_OLLAMA_URL, keep_alive=0, keep_alive_unit="seconds", timeout=9)
        prompt_request = PromptEnhancerRequest(
            model="llava:latest",
            prompt_type="image",
            prompt="make it cinematic",
            system_prompt="system text",
            seed=123,
            images=[],
            settings=settings,
        )
        progress_events = []

        class FakeProgress:
            def phase_start(self, phase):
                progress_events.append((phase, "start"))

            def phase_done(self, phase):
                progress_events.append((phase, "done"))

            def generation_step(self, expected):
                progress_events.append(("generate", expected))

            def generation_tokens(self, generated, expected):
                progress_events.append(("tokens", generated, expected))

        with patch("shared.prompt_enhancer.provider._json_stream_request") as stream_request, patch(
            "shared.prompt_enhancer.provider._json_request"
        ) as request:
            stream_request.return_value = [
                {"response": " enhanced"},
                {"response": " prompt", "done": True},
            ]
            request.return_value = {"done": True}

            result = OllamaPromptProvider().generate(prompt_request, FakeProgress())

        self.assertEqual(result, "enhanced prompt")
        payload = stream_request.call_args.args[1]
        self.assertTrue(payload["stream"])
        self.assertEqual(request.call_args.args[1], {"model": "llava:latest", "keep_alive": 0, "stream": False})
        self.assertIn(("release", "done"), progress_events)

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

    def test_video_script_parser_builds_segment_variables(self):
        script = """[rating=SFW]
[style=cinematic | dramatic | high contrast]
[default_reference_mode=start_frame]

## A man enters a rainy neon street. @image1

---

[reference_mode=start_and_end_transition]
[camera=slow push-in]
[continuity=He looks left = uncertain]
> > Previous segment ends with the man under a neon sign. @image1:start
The woman walks toward him through the rain. @image1:start @image2:end
"""

        parsed = parse_video_prompt_script(script, image_count=2)
        variables = build_segment_variables(parsed, 2)

        self.assertEqual(len(parsed.segments), 2)
        self.assertEqual(parsed.global_metadata["style"], "cinematic | dramatic | high contrast")
        self.assertEqual(parsed.segments[0].direction, "A man enters a rainy neon street.")
        self.assertEqual(variables["segment_index"], 2)
        self.assertEqual(variables["segment_total"], 2)
        self.assertEqual(variables["direction"], "The woman walks toward him through the rain.")
        self.assertIn("He looks left = uncertain", variables["continuity"])
        self.assertIn("Previous segment ends", variables["continuity"])
        self.assertEqual(variables["reference_mode"], "start_and_end_transition")
        self.assertIn("Style: cinematic | dramatic | high contrast.", variables["image_notes"])
        self.assertIn("Camera guidance: slow push-in.", variables["image_notes"])
        self.assertIn("Image 2 is used as end guidance", variables["image_notes"])

    def test_video_script_parser_infers_reference_modes_and_warns_on_unknown_keys(self):
        script = """[unknown_global=yes]

[unknown_segment=kept]
A character turns around. @image3:character
"""

        parsed = parse_video_prompt_script(script, image_count=3)
        variables = build_segment_variables(parsed, 1)

        self.assertEqual(variables["reference_mode"], "character_reference")
        self.assertIn("unknown_global", "\n".join(parsed.warnings))
        self.assertIn("unknown_segment", "\n".join(variables["warnings"]))

        first_segment_local = parse_video_prompt_script("[reference_mode=end_guidance]\nA closing pose. @image1:end", image_count=1)
        self.assertEqual(first_segment_local.global_metadata, {})
        self.assertEqual(build_segment_variables(first_segment_local, 1)["reference_mode"], "end_guidance")

    def test_video_script_parser_supports_describe_image_reference_modifier(self):
        parsed = parse_video_prompt_script(
            "A white dog runs beside the woman. @image2:character:describe\n"
            "---\n"
            "Opening frame holds on the forest path. @image1:describe",
            image_count=2,
        )
        first = build_segment_variables(parsed, 1)
        second = build_segment_variables(parsed, 2)

        self.assertEqual(parsed.segments[0].image_references[0].role, "character")
        self.assertTrue(parsed.segments[0].image_references[0].describe)
        self.assertEqual(first["reference_mode"], "character_reference")
        self.assertIn("Image 2 is used as character reference.", first["image_notes"])
        self.assertIn("persistent identity traits", first["image_notes"])
        self.assertIn("color, size, markings", first["image_notes"])
        self.assertIn("facial features", first["image_notes"])
        self.assertIn("hair color and style", first["image_notes"])
        self.assertIn("apparent age range", first["image_notes"])
        self.assertIn("coat or fur color", first["image_notes"])
        self.assertEqual(parsed.segments[1].image_references[0].role, "start")
        self.assertTrue(parsed.segments[1].image_references[0].describe)
        self.assertEqual(second["reference_mode"], "start_frame")
        self.assertIn("visible opening frame", second["image_notes"])
        self.assertIn("facial expression", second["image_notes"])
        self.assertIn("then apply the user's requested action", second["image_notes"])
        self.assertIn("honor the user prompt", second["image_notes"])

        plain = parse_video_prompt_script("A character turns around. @image1:character", image_count=1)
        plain_reference = plain.segments[0].image_references[0]
        self.assertEqual(plain_reference.role, "character")
        self.assertFalse(plain_reference.describe)
        self.assertNotIn("persistent identity traits", build_segment_variables(plain, 1)["image_notes"])

    def test_video_script_describe_modifier_is_role_first_for_every_image_role(self):
        role_expectations = {
            "start": "visible opening frame",
            "end": "target final state",
            "character": "character or subject reference",
            "style": "style reference",
            "pose": "pose reference",
            "setting": "setting reference",
            "motion": "motion reference",
        }
        for role, expected in role_expectations.items():
            with self.subTest(role=role):
                parsed = parse_video_prompt_script(f"A subject moves. @image1:{role}:describe", image_count=1)
                image_notes = build_segment_variables(parsed, 1)["image_notes"]

                self.assertIn(expected, image_notes)
                self.assertIn("describe the referenced image content first", image_notes)
                self.assertIn("facial features", image_notes)
                self.assertIn("hair color and style", image_notes)
                self.assertIn("coat or fur color", image_notes)
                self.assertIn("user's requested action", image_notes)
                self.assertIn("honor the user prompt", image_notes)

    def test_video_script_parser_warns_when_reference_mode_has_no_image_reference(self):
        parsed = parse_video_prompt_script("[reference_mode=start_frame]\nA subject turns toward camera.", image_count=1)
        variables = build_segment_variables(parsed, 1)

        self.assertEqual(variables["reference_mode"], "start_frame")
        self.assertEqual(variables["image_references"], [])
        self.assertIn("has no @imageN references", "\n".join(variables["warnings"]))
        self.assertIn("no images will be sent", "\n".join(variables["warnings"]))

    def test_video_script_parser_validates_references_modes_and_segment_index(self):
        with self.assertRaisesRegex(VideoScriptError, "Unknown image role"):
            parse_video_prompt_script("A view. @image1:background", image_count=1)

        with self.assertRaisesRegex(VideoScriptError, "Unknown image reference modifier"):
            parse_video_prompt_script("A view. @image1:character:lock", image_count=1)

        with self.assertRaisesRegex(VideoScriptError, "only 1 images"):
            parse_video_prompt_script("A view. @image2:start", image_count=1)

        with self.assertRaisesRegex(VideoScriptError, "Unknown reference mode"):
            parse_video_prompt_script("Intro.\n[reference_mode=firstframe]\nA view.", image_count=0)

        parsed = parse_video_prompt_script("A view.", image_count=0)
        with self.assertRaisesRegex(VideoScriptError, "outside the available segment range"):
            build_segment_variables(parsed, 2)

    def test_provider_catalog_combines_ollama_and_local_models(self):
        catalog = local_provider.provider_catalog(["llava:latest"], "offline")

        self.assertTrue(catalog["ok"])
        self.assertEqual(catalog["ollama_error"], "offline")
        models = {(model["provider"], model["model_id"]): model for model in catalog["models"]}
        self.assertIn(("ollama", "llava:latest"), models)
        self.assertIn((local_provider.PROVIDER_FALLBACK, "fallback_text_backend"), models)
        self.assertEqual(models[(local_provider.PROVIDER_LOCAL_TEXT_GENERATOR, "gemma4_e4b_it_fp8_scaled")]["status"], "unsupported_generator")

    def test_fallback_local_provider_generates_without_external_runtime(self):
        request = PromptEnhancerRequest(
            model="fallback_text_backend",
            prompt_type="video",
            prompt="A dancer spins",
            system_prompt="system",
            seed=1,
            images=[],
            settings=PromptEnhancerSettings(),
            provider=local_provider.PROVIDER_FALLBACK,
            model_id="fallback_text_backend",
            model_backend="fallback",
        )

        result = local_provider.LocalPromptProvider().generate(request)

        self.assertIn("A dancer spins", result)
        self.assertIn("video prompt", result)

    def test_fallback_local_provider_reports_progress_phases(self):
        request = PromptEnhancerRequest(
            model="fallback_text_backend",
            prompt_type="image",
            prompt="A quiet forest",
            system_prompt="system",
            seed=1,
            images=[],
            settings=PromptEnhancerSettings(),
            provider=local_provider.PROVIDER_FALLBACK,
            model_id="fallback_text_backend",
            model_backend="fallback",
        )
        events = []

        class FakeProgress:
            def phase_done(self, phase):
                events.append((phase, "done"))

            def phase_start(self, phase):
                events.append((phase, "start"))

        local_provider.LocalPromptProvider().generate(request, FakeProgress())

        self.assertEqual(
            events,
            [
                ("download", "done"),
                ("load", "done"),
                ("generate", "start"),
                ("generate", "done"),
            ],
        )

    def test_local_provider_zero_keep_alive_unloads_before_returning(self):
        alias = "qwen3_vl_4b_fast"
        request = PromptEnhancerRequest(
            model=alias,
            prompt_type="image",
            prompt="A quiet forest",
            system_prompt="system",
            seed=1,
            images=[],
            settings=PromptEnhancerSettings(keep_alive=0, keep_alive_unit="seconds"),
            provider=local_provider.PROVIDER_LOCAL_TRANSFORMERS,
            model_id=alias,
            model_backend="qwen",
        )
        events = []

        class FakeProgress:
            def phase_done(self, phase):
                events.append((phase, "done"))

            def phase_start(self, phase):
                events.append((phase, "start"))

        with patch.object(local_provider, "_LOADED_MODELS", {alias: {"torch": None}}), \
                patch.object(local_provider, "ensure_model_downloaded", return_value=Path("/tmp/model")), \
                patch.object(local_provider, "local_vram_preflight"), \
                patch.object(local_provider, "decode_request_images", return_value=[]), \
                patch.object(local_provider, "_generate_qwen", return_value=" generated prompt "), \
                patch.object(local_provider, "unload_local_model", return_value={"ok": True, "unloaded": [alias]}) as unload:
            result = local_provider.LocalPromptProvider().generate(request, FakeProgress())

        self.assertEqual(result, "generated prompt")
        unload.assert_called_once_with(alias)
        self.assertIn(("release", "start"), events)
        self.assertIn(("release", "done"), events)

    def test_local_provider_nonzero_keep_alive_keeps_model_loaded(self):
        alias = "qwen3_vl_4b_fast"
        request = PromptEnhancerRequest(
            model=alias,
            prompt_type="image",
            prompt="A quiet forest",
            system_prompt="system",
            seed=1,
            images=[],
            settings=PromptEnhancerSettings(keep_alive=5, keep_alive_unit="minutes"),
            provider=local_provider.PROVIDER_LOCAL_TRANSFORMERS,
            model_id=alias,
            model_backend="qwen",
        )

        with patch.object(local_provider, "_LOADED_MODELS", {alias: {"torch": None}}), \
                patch.object(local_provider, "ensure_model_downloaded", return_value=Path("/tmp/model")), \
                patch.object(local_provider, "local_vram_preflight"), \
                patch.object(local_provider, "decode_request_images", return_value=[]), \
                patch.object(local_provider, "_generate_qwen", return_value=" generated prompt "), \
                patch.object(local_provider, "unload_local_model") as unload:
            result = local_provider.LocalPromptProvider().generate(request)

        self.assertEqual(result, "generated prompt")
        unload.assert_not_called()

    def test_local_provider_zero_keep_alive_propagates_unload_failure(self):
        alias = "qwen3_vl_4b_fast"
        request = PromptEnhancerRequest(
            model=alias,
            prompt_type="image",
            prompt="A quiet forest",
            system_prompt="system",
            seed=1,
            images=[],
            settings=PromptEnhancerSettings(keep_alive=0, keep_alive_unit="minutes"),
            provider=local_provider.PROVIDER_LOCAL_TRANSFORMERS,
            model_id=alias,
            model_backend="qwen",
        )

        with patch.object(local_provider, "_LOADED_MODELS", {alias: {"torch": None}}), \
                patch.object(local_provider, "ensure_model_downloaded", return_value=Path("/tmp/model")), \
                patch.object(local_provider, "local_vram_preflight"), \
                patch.object(local_provider, "decode_request_images", return_value=[]), \
                patch.object(local_provider, "_generate_qwen", return_value=" generated prompt "), \
                patch.object(local_provider, "unload_local_model", side_effect=RuntimeError("release failed")):
            with self.assertRaisesRegex(RuntimeError, "release failed"):
                local_provider.LocalPromptProvider().generate(request)

    def test_fallback_local_provider_zero_keep_alive_does_not_unload_absent_model(self):
        request = PromptEnhancerRequest(
            model="fallback_text_backend",
            prompt_type="image",
            prompt="A quiet forest",
            system_prompt="system",
            seed=1,
            images=[],
            settings=PromptEnhancerSettings(keep_alive=0, keep_alive_unit="seconds"),
            provider=local_provider.PROVIDER_FALLBACK,
            model_id="fallback_text_backend",
            model_backend="fallback",
        )
        events = []

        class FakeProgress:
            def phase_done(self, phase):
                events.append((phase, "done"))

            def phase_start(self, phase):
                events.append((phase, "start"))

        with patch.object(local_provider, "_LOADED_MODELS", {}), patch.object(local_provider, "unload_local_model") as unload:
            result = local_provider.LocalPromptProvider().generate(request, FakeProgress())

        self.assertIn("A quiet forest", result)
        unload.assert_not_called()
        self.assertIn(("release", "start"), events)
        self.assertIn(("release", "done"), events)

    def test_local_text_encoder_checkpoint_reports_unsupported_generator(self):
        request = PromptEnhancerRequest(
            model="gemma4_e4b_it_fp8_scaled",
            prompt_type="image",
            prompt="A quiet forest",
            system_prompt="system",
            seed=1,
            images=[],
            settings=PromptEnhancerSettings(),
            provider=local_provider.PROVIDER_LOCAL_TEXT_GENERATOR,
            model_id="gemma4_e4b_it_fp8_scaled",
            model_backend="gemma_safetensors",
        )

        with self.assertRaisesRegex(local_provider.LocalProviderError, "not a standalone prompt-generating model"):
            local_provider.LocalPromptProvider().generate(request)

    def test_provider_registry_keeps_ollama_default_and_routes_local(self):
        ollama_request = PromptEnhancerRequest(
            model="llava:latest",
            prompt_type="image",
            prompt="hello",
            system_prompt="system",
            seed=1,
            images=[],
            settings=PromptEnhancerSettings(),
        )
        local_request = PromptEnhancerRequest(
            model="fallback_text_backend",
            prompt_type="image",
            prompt="hello",
            system_prompt="system",
            seed=1,
            images=[],
            settings=PromptEnhancerSettings(),
            provider=local_provider.PROVIDER_FALLBACK,
            model_id="fallback_text_backend",
        )

        with patch("shared.prompt_enhancer.provider.OllamaPromptProvider.generate", return_value="ollama") as generate:
            self.assertEqual(PromptProviderRegistry().generate(ollama_request), "ollama")
        self.assertIsNone(generate.call_args.args[1])
        self.assertIn("hello", PromptProviderRegistry().generate(local_request))

    def test_provider_settings_store_hf_token_privately(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            saved = local_provider.save_hf_token("token-value", tmpdir)

            self.assertTrue(saved["tokenConfigured"])
            self.assertEqual(local_provider.configured_hf_token(tmpdir), "token-value")

            cleared = local_provider.clear_hf_token(tmpdir)

            self.assertFalse(cleared["tokenConfigured"])


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

    def test_provider_model_route_returns_local_models_when_ollama_is_offline(self):
        routes = importlib.import_module("shared.prompt_enhancer.routes")

        async def fake_to_thread(func, *args):
            return func(*args)

        with patch.object(routes.asyncio, "to_thread", fake_to_thread), patch.object(routes.OllamaPromptProvider, "list_models", side_effect=RuntimeError("offline")):
            response = asyncio.run(routes._request_provider_models({"url": "http://localhost:11434"}))

        self.assertEqual(response.status, 200)
        self.assertIn('"ollama_error": "offline"', response.text)
        self.assertIn('"model_id": "fallback_text_backend"', response.text)

    def test_provider_model_routes_download_unload_and_settings(self):
        routes = importlib.import_module("shared.prompt_enhancer.routes")

        async def fake_to_thread(func, *args):
            return func(*args)

        with patch.object(routes.asyncio, "to_thread", fake_to_thread), \
                patch.object(routes, "download_local_model", return_value={"ok": True, "model": "fallback_text_backend"}), \
                patch.object(routes, "unload_local_model", return_value={"ok": True, "unloaded": ["fallback_text_backend"]}):
            download_response = asyncio.run(routes._download_provider_model({"model_id": "fallback_text_backend"}))
            unload_response = asyncio.run(routes._unload_provider_model({"model_id": "fallback_text_backend"}))

        self.assertEqual(download_response.status, 200)
        self.assertIn('"model": "fallback_text_backend"', download_response.text)
        self.assertEqual(unload_response.status, 200)
        self.assertIn('"unloaded": ["fallback_text_backend"]', unload_response.text)

        with tempfile.TemporaryDirectory() as tmpdir, patch.object(routes, "provider_settings_status", lambda: local_provider.provider_settings_status(tmpdir)), \
                patch.object(routes, "save_hf_token", lambda token: local_provider.save_hf_token(token, tmpdir)), \
                patch.object(routes, "clear_hf_token", lambda: local_provider.clear_hf_token(tmpdir)):
            settings_response = asyncio.run(routes._save_provider_settings({"hf_token": "secret"}))
            clear_response = asyncio.run(routes._save_provider_settings({"clear": True}))

        self.assertEqual(settings_response.status, 200)
        self.assertIn('"tokenConfigured": true', settings_response.text)
        self.assertEqual(clear_response.status, 200)
        self.assertIn('"tokenConfigured": false', clear_response.text)

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

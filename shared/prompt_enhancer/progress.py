from __future__ import annotations

from contextlib import contextmanager
from typing import Any

from .. import progress_api as helto_progress


PROGRESS_TOTAL = 1000
PHASE_RANGES: dict[str, tuple[int, int]] = {
    "media": (0, 100),
    "download": (100, 300),
    "load": (300, 450),
    "generate": (450, 930),
    "cleanup": (930, 970),
    "release": (970, 1000),
}
PHASE_LABELS: dict[str, str] = {
    "media": "Preparing media",
    "download": "Downloading model",
    "load": "Loading model",
    "generate": "Generating prompt",
    "cleanup": "Cleaning up",
    "release": "Releasing model",
}


class PromptEnhancerProgress:
    def __init__(self, unique_id: str | None = None, progress_bar: Any | None = None, enabled: bool = True):
        self.enabled = enabled
        self._node_id = unique_id
        self._last_value = 0
        self._model_call_total = 0
        self._model_call_index = 0
        self._bar = progress_bar if progress_bar is not None else self._create_progress_bar(unique_id)
        self.update_absolute(0)

    @staticmethod
    def _create_progress_bar(unique_id: str | None) -> Any | None:
        try:
            from comfy.utils import ProgressBar  # type: ignore[import-not-found]
        except Exception:
            return None
        return ProgressBar(PROGRESS_TOTAL, node_id=unique_id)

    def update_absolute(self, value: int) -> None:
        if not self.enabled:
            return
        self.check_interrupted()
        value = max(self._last_value, min(PROGRESS_TOTAL, int(value)))
        self._last_value = value
        if self._bar is not None:
            self._bar.update_absolute(value, PROGRESS_TOTAL)

    def phase_fraction(self, phase: str, fraction: float) -> None:
        start, end = PHASE_RANGES.get(phase, (0, PROGRESS_TOTAL))
        safe_fraction = max(0.0, min(1.0, float(fraction)))
        absolute = round(start + ((end - start) * safe_fraction))
        self.update_absolute(absolute)
        self._report_phase_update(phase, self._last_value)

    def phase_start(self, phase: str) -> None:
        self._report_phase_start(phase)
        self.phase_fraction(phase, 0.0)

    def phase_done(self, phase: str) -> None:
        self.phase_fraction(phase, 1.0)
        self._report_phase_done(phase)

    def generation_tokens(self, generated: int, expected: int) -> None:
        if expected <= 0:
            self.phase_fraction("generate", 0.0)
            return
        self.phase_fraction("generate", min(0.98, max(0.0, generated / expected)))

    def generation_step(self, expected: int) -> None:
        start, end = PHASE_RANGES["generate"]
        current_generated = max(0, self._last_value - start)
        phase_width = max(1, end - start)
        generated = round((current_generated / phase_width) * max(1, expected)) + 1
        self.generation_tokens(generated, expected)

    def begin_model_calls(self, total: int) -> None:
        self._model_call_total = max(0, int(total))
        self._model_call_index = 0

    @contextmanager
    def model_call(self):
        if self._model_call_total <= 0:
            yield self
            return

        call_index = self._model_call_index
        self._model_call_index = min(self._model_call_index + 1, self._model_call_total)
        proxy = _PromptEnhancerModelCallProgress(self, call_index, self._model_call_total)
        try:
            yield proxy
        except Exception:
            raise
        else:
            proxy.complete_call()

    def model_call_fraction(self, call_index: int, call_total: int, fraction: float) -> None:
        if call_total <= 0:
            self.phase_fraction("generate", fraction)
            return
        start, end = PHASE_RANGES["generate"]
        call_width = (end - start) / max(1, call_total)
        safe_index = max(0, min(call_total - 1, int(call_index)))
        safe_fraction = max(0.0, min(1.0, float(fraction)))
        absolute = round(start + (call_width * safe_index) + (call_width * safe_fraction))
        self.update_absolute(absolute)
        self._report_phase_update(
            "generate",
            self._last_value,
            message=f"Generating prompt {safe_index + 1}/{call_total}",
        )

    def complete(self) -> None:
        self.update_absolute(PROGRESS_TOTAL)
        helto_progress.done(
            "Prompt enhancer complete",
            phase="complete",
            value=PROGRESS_TOTAL,
            total=PROGRESS_TOTAL,
            node_id=self._node_id,
        )

    def _report_phase_start(self, phase: str) -> None:
        if not self.enabled:
            return
        helto_progress.start(
            PHASE_LABELS.get(phase, phase),
            phase=phase,
            value=self._last_value,
            total=PROGRESS_TOTAL,
            node_id=self._node_id,
        )

    def _report_phase_update(self, phase: str, absolute: int, message: str | None = None) -> None:
        if not self.enabled:
            return
        helto_progress.update(
            message or PHASE_LABELS.get(phase, phase),
            phase=phase,
            value=absolute,
            total=PROGRESS_TOTAL,
            node_id=self._node_id,
        )

    def _report_phase_done(self, phase: str) -> None:
        if not self.enabled:
            return
        helto_progress.done(
            PHASE_LABELS.get(phase, phase),
            phase=phase,
            value=self._last_value,
            total=PROGRESS_TOTAL,
            node_id=self._node_id,
        )

    @staticmethod
    def check_interrupted() -> None:
        try:
            import comfy.model_management as model_management  # type: ignore[import-not-found]
        except Exception:
            return
        interrupt = getattr(model_management, "throw_exception_if_processing_interrupted", None)
        if callable(interrupt):
            interrupt()


class _PromptEnhancerModelCallProgress:
    def __init__(self, parent: PromptEnhancerProgress, call_index: int, call_total: int):
        self.enabled = parent.enabled
        self._parent = parent
        self._call_index = call_index
        self._call_total = call_total
        self._last_fraction = 0.0
        self._update_fraction(0.0)

    def _update_fraction(self, fraction: float) -> None:
        safe_fraction = max(self._last_fraction, min(1.0, max(0.0, float(fraction))))
        self._last_fraction = safe_fraction
        self._parent.model_call_fraction(self._call_index, self._call_total, safe_fraction)

    def phase_fraction(self, phase: str, fraction: float) -> None:
        start, end = PHASE_RANGES.get(phase, (0, PROGRESS_TOTAL))
        safe_fraction = max(0.0, min(1.0, float(fraction)))
        self._update_fraction((start + ((end - start) * safe_fraction)) / PROGRESS_TOTAL)

    def phase_start(self, phase: str) -> None:
        self.phase_fraction(phase, 0.0)

    def phase_done(self, phase: str) -> None:
        self.phase_fraction(phase, 1.0)

    def generation_tokens(self, generated: int, expected: int) -> None:
        if expected <= 0:
            self.phase_fraction("generate", 0.0)
            return
        self.phase_fraction("generate", min(0.98, max(0.0, generated / expected)))

    def generation_step(self, expected: int) -> None:
        generate_start = PHASE_RANGES["generate"][0] / PROGRESS_TOTAL
        generate_end = PHASE_RANGES["generate"][1] / PROGRESS_TOTAL
        generate_width = max(0.001, generate_end - generate_start)
        current_generated = max(0.0, self._last_fraction - generate_start)
        generated = round((current_generated / generate_width) * max(1, expected)) + 1
        self.generation_tokens(generated, expected)

    def complete_call(self) -> None:
        self._update_fraction(1.0)

    @staticmethod
    def check_interrupted() -> None:
        PromptEnhancerProgress.check_interrupted()

from __future__ import annotations

from typing import Any


PROGRESS_TOTAL = 1000
PHASE_RANGES: dict[str, tuple[int, int]] = {
    "media": (0, 100),
    "download": (100, 300),
    "load": (300, 450),
    "generate": (450, 930),
    "cleanup": (930, 970),
    "release": (970, 1000),
}


class PromptEnhancerProgress:
    def __init__(self, unique_id: str | None = None, progress_bar: Any | None = None, enabled: bool = True):
        self.enabled = enabled
        self._last_value = 0
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
        self.update_absolute(round(start + ((end - start) * safe_fraction)))

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
        start, end = PHASE_RANGES["generate"]
        current_generated = max(0, self._last_value - start)
        phase_width = max(1, end - start)
        generated = round((current_generated / phase_width) * max(1, expected)) + 1
        self.generation_tokens(generated, expected)

    def complete(self) -> None:
        self.update_absolute(PROGRESS_TOTAL)

    @staticmethod
    def check_interrupted() -> None:
        try:
            import comfy.model_management as model_management  # type: ignore[import-not-found]
        except Exception:
            return
        interrupt = getattr(model_management, "throw_exception_if_processing_interrupted", None)
        if callable(interrupt):
            interrupt()

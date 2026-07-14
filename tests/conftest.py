"""Synthetic boundary for testing the active profile before suite publication.

Tests patch only the outer signed-suite release gate. Product privacy behavior,
adapter completeness, authorization, and managed storage remain active.
"""

from __future__ import annotations

import pytest

import helto_privacy.artifacts as artifacts
import helto_privacy.comfy_ui as comfy_ui
import helto_privacy.envelope as envelope
import helto_privacy.guard as guard
import helto_privacy.keystore as keystore


@pytest.fixture
def coordinated_suite_test_boundary(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "HELTO_PRIVACY_ARTIFACT_ROOT",
        str(tmp_path / "managed-artifacts"),
    )
    monkeypatch.setenv(
        "HELTO_PRIVACY_MODE_STATE",
        str(tmp_path / "privacy-mode-state.json"),
    )
    monkeypatch.setenv(
        "HELTO_PRIVACY_EXTERNAL_OPERATION_STATE",
        str(tmp_path / "external-operation-state.json"),
    )
    monkeypatch.setenv(
        "HELTO_PRIVACY_RECORD_RELOCATION_STATE",
        str(tmp_path / "record-relocation-state.json"),
    )
    for module in (artifacts, comfy_ui, envelope, guard, keystore):
        monkeypatch.setattr(module, "require_active_process_suite", lambda: None)

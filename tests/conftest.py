"""Synthetic consumer-test boundary for the unpublished coordinated suite.

Production remains gated by exact suite activation. These unit tests patch only
that outer release gate so their existing token, keystore, envelope, route, and
artifact assertions can exercise the intended behavior against the local
unpublished helto-privacy revision.
"""

from __future__ import annotations

import pytest

import helto_privacy.artifacts as artifacts
import helto_privacy.comfy_ui as comfy_ui
import helto_privacy.envelope as envelope
import helto_privacy.guard as guard
import helto_privacy.keystore as keystore


@pytest.fixture
def inactive_coordinated_suite_test_boundary(monkeypatch):
    for module in (artifacts, comfy_ui, envelope, guard, keystore):
        monkeypatch.setattr(module, "require_active_process_suite", lambda: None)

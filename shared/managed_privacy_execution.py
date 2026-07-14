"""Subject-mode reference consumption shared by Utils execution nodes."""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from contextlib import contextmanager


UTILS_MANAGED_PRIVACY_PROFILE_ID = "helto.comfyui-utils"


def parse_utils_managed_reference(reference: object, error_code: str) -> Mapping:
    if isinstance(reference, str):
        try:
            reference = json.loads(reference)
        except json.JSONDecodeError:
            raise ValueError(error_code) from None
    if not isinstance(reference, Mapping):
        raise ValueError(error_code)
    return reference


@contextmanager
def consume_utils_subject_mode(
    reference: object,
    binding_id: str,
    subject_id: object,
) -> Iterator[object]:
    """Consume one output-only subject reference for the exact Comfy node ID."""

    parsed = parse_utils_managed_reference(
        reference,
        "PRIVACY_SUBJECT_MODE_REFERENCE_INVALID",
    )
    from helto_privacy.runtime import bound_privacy_pack

    pack = bound_privacy_pack(UTILS_MANAGED_PRIVACY_PROFILE_ID)
    with pack.subject_modes(binding_id).consume(parsed, subject_id) as lease:
        yield lease


def utils_subject_requires_private_execution(lease: object, binding_id: str) -> bool:
    """Validate an active lease and return its server-attested effective mode."""

    from helto_privacy.runtime import bound_privacy_pack

    pack = bound_privacy_pack(UTILS_MANAGED_PRIVACY_PROFILE_ID)
    check = getattr(lease, "requires_private_execution", None)
    if not callable(check):
        raise ValueError("PRIVACY_SUBJECT_MODE_REFERENCE_INVALID")
    return bool(check(profile=pack.profile, binding_id=binding_id))

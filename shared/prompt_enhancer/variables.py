from __future__ import annotations

import json
import random
import re
from typing import Any

VARIABLE_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
VARIABLE_TOKEN_RE = re.compile(r"{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}")


def is_valid_variable_name(name: str) -> bool:
    return bool(VARIABLE_NAME_RE.fullmatch(str(name or "").strip()))


def parse_prompt_variables(raw_variables: Any) -> list[dict[str, Any]]:
    payload = _decode_variables_payload(raw_variables)
    if not isinstance(payload, list):
        return []

    variables: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for item in payload:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not is_valid_variable_name(name) or name in seen_names:
            continue
        values = item.get("values")
        if not isinstance(values, list):
            values = []
        normalized_values = [str(value) for value in values if value is not None]
        fixed_index = _as_int(item.get("fixed_index"), 0)
        if normalized_values:
            fixed_index = max(0, min(fixed_index, len(normalized_values) - 1))
        else:
            fixed_index = 0
        variables.append(
            {
                "name": name,
                "mode": "fixed" if item.get("mode") == "fixed" else "random",
                "values": normalized_values,
                "fixed_index": fixed_index,
            }
        )
        seen_names.add(name)
    return variables


def substitute_prompt_variables(prompt: str, raw_variables: Any, seed: int) -> str:
    variables = {variable["name"]: variable for variable in parse_prompt_variables(raw_variables)}
    if not variables:
        return prompt or ""

    rng = random.Random(_as_int(seed, 0))

    def replacement(match: re.Match[str]) -> str:
        name = match.group(1)
        variable = variables.get(name)
        if variable is None:
            return match.group(0)
        return _select_variable_value(variable, rng)

    return VARIABLE_TOKEN_RE.sub(replacement, prompt or "")


def _decode_variables_payload(raw_variables: Any) -> Any:
    if raw_variables is None or raw_variables == "":
        return []
    if isinstance(raw_variables, list):
        return raw_variables
    if not isinstance(raw_variables, str):
        return []

    payload = raw_variables.strip()
    try:
        return json.loads(payload)
    except (TypeError, json.JSONDecodeError):
        return []


def _select_variable_value(variable: dict[str, Any], rng: random.Random) -> str:
    values = variable.get("values")
    if not isinstance(values, list) or not values:
        return ""
    if variable.get("mode") == "fixed":
        index = max(0, min(_as_int(variable.get("fixed_index"), 0), len(values) - 1))
        return str(values[index])
    return str(rng.choice(values))


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

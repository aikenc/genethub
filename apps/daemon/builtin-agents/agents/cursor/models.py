"""Cursor's model table: what `cursor-agent --list-models` prints, grouped
into one picker entry per base model with its efforts and Fast.

Slugs (`grok-4.7-low-fast`) are the only ids `--model` accepts in print mode;
the picker shows base models (`grok-4.7`) and `launch_slug` turns a picker
choice back into the exact listed slug.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

KNOWN_EFFORTS = ("extra-high", "xhigh", "minimal", "medium", "high", "none", "low", "max")


def model_info(model_id: str, label: str, efforts: Optional[List[str]] = None, supports_fast: bool = False) -> dict:
    efforts = list(efforts or [])
    return {
        "id": model_id,
        "label": label,
        "reasoning": bool(efforts),
        "efforts": efforts,
        "supportsFast": bool(supports_fast),
    }


def models_from_cli_list(text: str) -> Tuple[List[dict], Optional[str]]:
    models: List[dict] = []
    default_model: Optional[str] = None
    for line in text.splitlines():
        line = line.strip()
        if " - " not in line:
            continue
        model_id, rest = line.split(" - ", 1)
        model_id = model_id.strip()
        if not model_id or any(ch.isspace() for ch in model_id):
            continue
        is_default = "(default)" in rest
        label = rest.replace("(default)", "").strip()
        if is_default:
            default_model = model_id
        models.append(
            {
                "id": model_id,
                "label": label or model_id,
                "reasoning": False,
                "efforts": [],
                "supportsFast": model_id.endswith("-fast"),
            }
        )
    if default_model is None and any(model["id"] == "auto" for model in models):
        default_model = "auto"
    return models, default_model


def parse_cli_model_id(model_id: str) -> Tuple[str, Optional[str], bool]:
    s = model_id.strip()
    is_fast = False
    if s.endswith("-fast"):
        is_fast = True
        s = s[: -len("-fast")]
    trailing_thinking = False
    if s.endswith("-thinking"):
        trailing_thinking = True
        s = s[: -len("-thinking")]
    effort: Optional[str] = None
    for known in KNOWN_EFFORTS:
        suffix = "-" + known
        if s.endswith(suffix):
            effort = "xhigh" if known == "extra-high" else known
            s = s[: -len(suffix)]
            break
    base = s + ("-thinking" if trailing_thinking else "")
    return base, effort, is_fast


def effort_rank(effort: str) -> int:
    return {
        "none": 0,
        "minimal": 1,
        "low": 2,
        "medium": 3,
        "high": 4,
        "xhigh": 5,
        "extra-high": 5,
        "max": 6,
    }.get(effort, 10)


def clean_model_label(raw_label: str) -> str:
    s = raw_label.replace("(default)", "").replace("\u200b", "")
    for level in (" Low Thinking", " Medium Thinking", " Extra High Thinking", " Max Thinking"):
        s = s.replace(level, " Thinking")
    parts = s.split()
    if parts and parts[-1].lower() == "fast":
        parts.pop()
    if len(parts) >= 2 and parts[-2].lower() == "extra" and parts[-1].lower() == "high":
        parts.pop()
        parts.pop()
    elif parts and parts[-1].lower() in ("low", "medium", "high", "max", "minimal", "none"):
        parts.pop()
    result = " ".join(parts)
    return result if result else raw_label.strip()


def group_cli_models(raw_models: List[dict], default: Optional[str]) -> Tuple[List[dict], Optional[str]]:
    groups: List[Dict] = []
    resolved_default: Optional[str] = None
    for raw in raw_models:
        base_id, effort, is_fast = parse_cli_model_id(raw["id"])
        if default is not None and raw["id"] == default and resolved_default is None:
            resolved_default = base_id
        cleaned = clean_model_label(raw["label"])
        existing = next((group for group in groups if group["base_id"] == base_id), None)
        if existing is not None:
            if is_fast:
                existing["supports_fast"] = True
            if effort and effort not in existing["efforts"]:
                existing["efforts"].append(effort)
            # Rust compares byte lengths; UTF-8 length keeps the same choice.
            if cleaned and len(cleaned.encode("utf-8")) < len(existing["label"].encode("utf-8")):
                existing["label"] = cleaned
        else:
            groups.append(
                {
                    "base_id": base_id,
                    "label": cleaned,
                    "efforts": [effort] if effort else [],
                    "supports_fast": is_fast,
                }
            )
    for group in groups:
        group["efforts"].sort(key=effort_rank)
    if resolved_default is None:
        if any(group["base_id"] == "auto" for group in groups):
            resolved_default = "auto"
        elif groups:
            resolved_default = groups[0]["base_id"]
    models = [model_info(g["base_id"], g["label"], g["efforts"], g["supports_fast"]) for g in groups]
    return models, resolved_default


def base_aliases(base: str) -> List[str]:
    if base.startswith("cursor-"):
        return [base, base[len("cursor-") :]]
    return [base, "cursor-" + base]


def default_effort(efforts: List[str]) -> Optional[str]:
    for preferred in ("medium", "high", "low"):
        if preferred in efforts:
            return preferred
    return efforts[0] if efforts else None


def launch_slug(model_id: str, effort_id: Optional[str], fast: bool, listed: List[dict]) -> Optional[str]:
    """The `--model` slug for a picker selection: base model, effort and Fast.

    A missing effort picks the model's middle level, and a Fast choice the
    model lacks at that level falls back to the plain slug rather than
    failing the turn."""
    wanted_id = model_id.strip()
    if not wanted_id:
        return None
    bases = base_aliases(wanted_id)
    family = []
    for model in listed:
        base, effort, is_fast = parse_cli_model_id(model["id"])
        if base in bases:
            family.append((model["id"], effort, is_fast))
    if not family:
        return wanted_id if any(model["id"] == wanted_id for model in listed) else None
    efforts: List[str] = []
    for _, effort, _ in family:
        if effort and effort not in efforts:
            efforts.append(effort)
    efforts.sort(key=effort_rank)
    wanted: Optional[str] = None
    if effort_id is not None:
        candidate = "xhigh" if effort_id == "extra-high" else effort_id
        if candidate in efforts:
            wanted = candidate
    if wanted is None:
        wanted = default_effort(efforts)

    def pick(effort: Optional[str], want_fast: bool) -> Optional[str]:
        for slug, candidate, is_fast in family:
            if candidate == effort and is_fast == want_fast:
                return slug
        return None

    found = pick(wanted, fast) or pick(wanted, not fast)
    if found:
        return found
    for effort in efforts:
        found = pick(effort, fast)
        if found:
            return found
    return family[0][0]


def parse_opaque_model_id(model_id: str) -> Tuple[str, List[Tuple[str, str]]]:
    if "[" not in model_id:
        return model_id, []
    base, rest = model_id.split("[", 1)
    if rest.endswith("]"):
        rest = rest[:-1]
    params = []
    for pair in rest.split(","):
        if "=" not in pair:
            continue
        key, value = pair.split("=", 1)
        params.append((key.strip(), value.strip()))
    return base.strip(), params


def resolve_legacy_model(raw_id: str, models: List[dict]) -> Optional[Tuple[str, Optional[str], Optional[bool]]]:
    """Maps a model id saved by the old ACP adapter — an opaque
    `grok-4.7[effort=high,fast=true]` or a raw CLI slug — onto this catalog's
    base model plus the effort and Fast it implied."""
    model_id = raw_id.strip()
    if not model_id:
        return None
    for model in models:
        if model["id"] == model_id:
            return model["id"], None, None

    opaque_base, params = parse_opaque_model_id(model_id)
    opaque_effort: Optional[str] = None
    for key, value in params:
        if key in ("effort", "reasoning_effort"):
            opaque_effort = "xhigh" if value == "extra-high" else value
            break
    opaque_fast: Optional[bool] = None
    for key, value in params:
        if key == "fast":
            opaque_fast = value == "true"
            break

    def find(model_id: str) -> Optional[dict]:
        return next((model for model in models if model["id"] == model_id), None)

    for base in base_aliases(opaque_base):
        model = find(base)
        if model is not None:
            effort = opaque_effort if opaque_effort in model["efforts"] else None
            fast = opaque_fast if (opaque_fast is not None and (not opaque_fast or model["supportsFast"])) else None
            return model["id"], effort, fast

    cli_base, cli_effort, is_fast = parse_cli_model_id(opaque_base)
    for base in base_aliases(cli_base):
        model = find(base)
        if model is not None:
            chosen_effort = opaque_effort if opaque_effort is not None else cli_effort
            effort = chosen_effort if chosen_effort in model["efforts"] else None
            chosen_fast = opaque_fast if opaque_fast is not None else (True if is_fast else None)
            fast = chosen_fast if (chosen_fast is not None and (not chosen_fast or model["supportsFast"])) else None
            return model["id"], effort, fast
    return None

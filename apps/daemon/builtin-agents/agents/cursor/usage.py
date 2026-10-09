"""Token and timing accounting for one turn, ported from the daemon's
`adapter/usage.rs` (only what the Cursor print adapter used).

The timing fields never go on the wire; `to_wire` produces the `Usage`
object exactly as `genehub_proto` serializes it.
"""

from __future__ import annotations

import time
from typing import Any, Dict, Iterable, Optional


def now_ms() -> int:
    return int(time.time() * 1000)


class Usage:
    def __init__(self) -> None:
        self.input_tokens = 0
        self.output_tokens = 0
        self.cache_read_tokens = 0
        self.cache_write_tokens = 0
        self.llm_rounds = 0
        self.token_usage_status = "unavailable"
        self.usage_reports = 0
        self.tool_output_tokens = 0
        self.compaction_count = 0
        self.avg_ttft_ms: Optional[int] = None
        self.avg_output_rate_tps: Optional[float] = None
        self.output_rate_estimated = False
        self.cost_usd: Optional[float] = None
        # Internal clock, never serialized.
        self.round_started_at_ms: Optional[int] = None
        self.span_started_at_ms: Optional[int] = None
        self.last_output_at_ms: Optional[int] = None
        self.turn_first_output_at_ms: Optional[int] = None
        self.active_output_ms = 0
        self.visible_output_chars = 0

    def copy(self) -> "Usage":
        other = Usage()
        other.__dict__.update(self.__dict__)
        return other

    def to_wire(self) -> Dict[str, Any]:
        value: Dict[str, Any] = {
            "tokenUsageStatus": self.token_usage_status,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "cacheReadTokens": self.cache_read_tokens,
            "cacheWriteTokens": self.cache_write_tokens,
            "llmRounds": self.llm_rounds,
            "toolOutputTokens": self.tool_output_tokens,
            "compactionCount": self.compaction_count,
            "outputRateEstimated": self.output_rate_estimated,
        }
        if self.avg_ttft_ms is not None:
            value["avgTtftMs"] = int(self.avg_ttft_ms)
        if self.avg_output_rate_tps is not None:
            value["avgOutputRateTps"] = float(self.avg_output_rate_tps)
        if self.cost_usd is not None:
            value["costUsd"] = float(self.cost_usd)
        return value


def record_round_start(usage: Usage) -> None:
    _close_output_span(usage)
    if usage.round_started_at_ms is None:
        usage.round_started_at_ms = now_ms()


def record_first_token(usage: Usage) -> None:
    started = usage.round_started_at_ms
    if started is None:
        return
    ttft = max(0, now_ms() - started)
    rounds = max(1, usage.llm_rounds)
    if usage.avg_ttft_ms is None:
        usage.avg_ttft_ms = ttft
    else:
        usage.avg_ttft_ms = (usage.avg_ttft_ms * (rounds - 1) + ttft) // rounds
    usage.round_started_at_ms = None


def record_visible_output(usage: Usage, text: str) -> None:
    now = now_ms()
    if usage.span_started_at_ms is None:
        usage.span_started_at_ms = now
    if usage.turn_first_output_at_ms is None:
        usage.turn_first_output_at_ms = now
    usage.last_output_at_ms = now
    usage.visible_output_chars += len(text)


def _close_output_span(usage: Usage) -> None:
    started = usage.span_started_at_ms
    usage.span_started_at_ms = None
    if started is not None and usage.last_output_at_ms is not None:
        usage.active_output_ms += max(0, usage.last_output_at_ms - started)


def _active_output_now(usage: Usage) -> int:
    active = usage.active_output_ms
    if usage.span_started_at_ms is not None:
        active += max(0, now_ms() - usage.span_started_at_ms)
    return active


def _output_rate(usage: Usage, active_ms: int):
    if active_ms > 0:
        window_ms = active_ms
    else:
        first, last = usage.turn_first_output_at_ms, usage.last_output_at_ms
        if first is not None and last is not None and last > first:
            window_ms = last - first
        else:
            return None
    seconds = max(1, window_ms) / 1000.0
    if usage.output_tokens > 0:
        return usage.output_tokens / seconds, False
    if usage.visible_output_chars > 0:
        return (usage.visible_output_chars / 4.0) / seconds, True
    return None


def finalize_output_rate(usage: Usage) -> None:
    _close_output_span(usage)
    rate = _output_rate(usage, usage.active_output_ms)
    if rate is not None:
        usage.avg_output_rate_tps, usage.output_rate_estimated = rate


def with_live_output_rate(usage: Usage) -> Usage:
    live = usage.copy()
    rate = _output_rate(usage, _active_output_now(usage))
    if rate is not None:
        live.avg_output_rate_tps, live.output_rate_estimated = rate
    return live


def preserve_timing(target: Usage, source: Usage) -> None:
    target.round_started_at_ms = source.round_started_at_ms
    target.span_started_at_ms = source.span_started_at_ms
    target.last_output_at_ms = source.last_output_at_ms
    target.turn_first_output_at_ms = source.turn_first_output_at_ms
    target.active_output_ms = source.active_output_ms
    target.visible_output_chars = source.visible_output_chars
    target.avg_ttft_ms = source.avg_ttft_ms


def _as_u64(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        return int(value) if value >= 0 else None
    if isinstance(value, str):
        try:
            parsed = int(value)
        except ValueError:
            return None
        return parsed if parsed >= 0 else None
    return None


def _first_u64(value: Any, keys: Iterable[str]) -> Optional[int]:
    if not isinstance(value, dict):
        return None
    for key in keys:
        if key in value:
            parsed = _as_u64(value[key])
            if parsed is not None:
                return parsed
    return None


def _first_f64(value: Any, keys: Iterable[str]) -> Optional[float]:
    if not isinstance(value, dict):
        return None
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
            return float(candidate)
    return None


def add_usage(total: Usage, value: Any) -> None:
    if not isinstance(value, dict):
        return
    tokens = value.get("tokens") if isinstance(value.get("tokens"), dict) else {}
    details = value.get("prompt_tokens_details") or value.get("promptTokensDetails") or value.get("input_tokens_details") or {}
    cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else value.get("cache")
    cache = cache if isinstance(cache, dict) else {}

    input_report = _first_u64(value, ("input", "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"))
    found = input_report
    if found is None:
        found = _first_u64(tokens, ("input", "input_tokens", "inputTokens"))
    if found is not None:
        total.input_tokens += found
    input_report = found
    found = _first_u64(value, ("output", "output_tokens", "outputTokens", "completion_tokens", "completionTokens"))
    if found is None:
        found = _first_u64(tokens, ("output", "output_tokens", "outputTokens"))
    if found is not None:
        total.output_tokens += found
    status = "reported" if input_report is not None and found is not None else "partial" if input_report is not None or found is not None else "unavailable"
    if total.usage_reports and status != total.token_usage_status:
        status = "partial"
    total.token_usage_status = status
    total.usage_reports += 1
    found = _first_u64(
        value,
        (
            "cacheRead",
            "cache_read",
            "cache_read_tokens",
            "cacheReadTokens",
            "cache_read_input_tokens",
            "cachedInputTokens",
            "cached_tokens",
            "cachedReadTokens",
            "prompt_cache_hit_tokens",
        ),
    )
    if found is None:
        found = _first_u64(details, ("cached_tokens", "cachedTokens"))
    if found is None:
        found = _first_u64(cache, ("read", "cached", "hit"))
    if found is not None:
        total.cache_read_tokens += found
    found = _first_u64(
        value,
        (
            "cacheWrite",
            "cache_write",
            "cache_write_tokens",
            "cacheWriteTokens",
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
            "cachedWriteTokens",
        ),
    )
    if found is None:
        found = _first_u64(cache, ("write", "creation"))
    if found is not None:
        total.cache_write_tokens += found
    found = _first_u64(value, ("llm_rounds", "llmRounds", "rounds"))
    if found is not None:
        total.llm_rounds += found
    found = _first_u64(value, ("tool_output_tokens", "toolOutputTokens", "tool_output"))
    if found is not None:
        total.tool_output_tokens += found
    cost = _first_f64(value, ("total_cost_usd", "costUsd", "cost_usd"))
    if cost is None:
        raw = value.get("cost")
        if isinstance(raw, dict):
            cost = _first_f64(raw, ("total", "usd"))
        elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
            cost = float(raw)
    if cost is not None:
        total.cost_usd = (total.cost_usd or 0.0) + cost


def parse_usage(value: Any) -> Usage:
    usage = Usage()
    add_usage(usage, value)
    return usage

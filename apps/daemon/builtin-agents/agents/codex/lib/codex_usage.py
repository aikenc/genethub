"""Token accounting for one Codex turn (port of the parts of the daemon's
``adapter/usage.rs`` that the Codex adapter used).

Token counts come from ``thread/tokenUsage/updated``. The clock fields only
feed the TTFT and output-rate figures in the footer; they never become token
counts on the wire.
"""

from __future__ import annotations

import time
from typing import Optional

from genehub_agent import events


def now_ms() -> int:
    return int(time.time() * 1000)


class Usage:
    def __init__(self) -> None:
        self.input_tokens = 0
        self.output_tokens = 0
        self.cache_read_tokens = 0
        self.llm_rounds = 0
        self.token_usage_status = "unavailable"
        self.avg_ttft_ms: Optional[int] = None
        self.avg_output_rate_tps: Optional[float] = None
        self.output_rate_estimated = False
        # Scratch clocks, never serialized.
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

    def to_wire(self) -> dict:
        return events.usage(
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            cache_read_tokens=self.cache_read_tokens,
            llm_rounds=self.llm_rounds,
            token_usage_status=self.token_usage_status,
            avg_ttft_ms=self.avg_ttft_ms,
            avg_output_rate_tps=self.avg_output_rate_tps,
            output_rate_estimated=self.output_rate_estimated,
        )


def token_counts(source: dict) -> Usage:
    def count(field: str) -> int:
        value = source.get(field) if isinstance(source, dict) else None
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0

    usage = Usage()
    usage.input_tokens = count("inputTokens")
    usage.output_tokens = count("outputTokens")
    usage.cache_read_tokens = count("cachedInputTokens")
    fields = [isinstance(source.get(key), int) and not isinstance(source.get(key), bool) and source[key] >= 0
              for key in ("inputTokens", "outputTokens")] if isinstance(source, dict) else []
    usage.token_usage_status = "reported" if fields and all(fields) else "partial" if any(fields) else "unavailable"
    return usage


def usage_in(params: dict) -> Optional[Usage]:
    token_usage = params.get("tokenUsage")
    if not isinstance(token_usage, dict):
        return None
    source = token_usage.get("last")
    if source is None:
        source = token_usage.get("total")
    if source is None:
        return None
    return token_counts(source)


def record_round_start(usage: Usage) -> None:
    """A round's clock is set once; a new round closes the previous span."""
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
        window = active_ms
    else:
        first, last = usage.turn_first_output_at_ms, usage.last_output_at_ms
        if first is None or last is None or last <= first:
            return None
        window = last - first
    seconds = max(1, window) / 1000.0
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

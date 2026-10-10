"""Is this API key accepted? Asked of the service's model list, never a model.

Listing models costs nothing and every service answers it only to a key it
knows, so it tells a typo from a real key without sending a prompt. The check
has three outcomes, because a check that cannot run must not be mistaken for
either answer:

``OK``        the service accepted the key
``REJECTED``  the service said the key is wrong (HTTP 401)
``UNKNOWN``   no answer that settles it: no network, a service without a
              model list, a refusal that is not about the key

The key goes only into one request header. It is never put in a URL, a
message or an exception text, and redirects are not followed (a redirect
would carry the header to another host).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import socket
import time
import urllib.error
import urllib.request
from typing import Dict, Mapping, NamedTuple, Optional, Tuple

OK = "ok"
REJECTED = "rejected"
UNKNOWN = "unknown"

TIMEOUT = 12.0
# How long an answer is trusted before the key is asked about again.
CACHE_SECONDS = 600.0

ANTHROPIC_BASE = "https://api.anthropic.com"
OPENAI_BASE = "https://api.openai.com/v1"


class Verdict(NamedTuple):
    status: str
    # One sentence for a person, never containing the key.
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status == OK

    @property
    def rejected(self) -> bool:
        return self.status == REJECTED


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        return None


def _get(url: str, headers: Mapping[str, str], timeout: float) -> Tuple[Optional[int], str]:
    """(HTTP status, "") or (None, why it could not be asked)."""
    if not url.lower().startswith(("https://", "http://")):
        return None, "地址不是 http(s)"
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, headers=dict(headers), method="GET")
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, ""
    except urllib.error.HTTPError as error:
        return error.code, ""
    except (socket.timeout, TimeoutError):
        return None, "连接超时"
    except urllib.error.URLError as error:
        reason = error.reason
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return None, "连接超时"
        return None, "连不上服务"
    except (OSError, ValueError):
        return None, "连不上服务"


async def fetch(url: str, headers: Mapping[str, str], timeout: float = TIMEOUT) -> Verdict:
    """One GET of a model list, judged. Replaced in offline tests."""
    loop = asyncio.get_event_loop()
    code, why = await loop.run_in_executor(None, _get, url, headers, timeout)
    if code is None:
        return Verdict(UNKNOWN, f"没能核对：{why}")
    if 200 <= code < 300:
        return Verdict(OK)
    if code == 401:
        return Verdict(REJECTED, "服务拒绝了这个 API Key（HTTP 401）")
    if code in (403, 429):
        return Verdict(UNKNOWN, f"没能核对：服务暂时拒绝了请求（HTTP {code}）")
    return Verdict(UNKNOWN, f"没能核对：服务没有提供模型列表（HTTP {code}）")


def _base(env: Mapping[str, str], name: str, default: str) -> str:
    value = (env.get(name) or "").strip()
    return value.rstrip("/") if value else default


async def anthropic(key: str, env: Optional[Mapping[str, str]] = None) -> Verdict:
    base = _base(env if env is not None else os.environ, "ANTHROPIC_BASE_URL", ANTHROPIC_BASE)
    return await fetch(base + "/v1/models?limit=1", {"x-api-key": key, "anthropic-version": "2023-06-01"})


async def openai(key: str, env: Optional[Mapping[str, str]] = None) -> Verdict:
    base = _base(env if env is not None else os.environ, "OPENAI_BASE_URL", OPENAI_BASE)
    return await fetch(base + "/models", {"Authorization": "Bearer " + key})


def fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


class Memory:
    """The latest verdict per key, so refreshing a card does not ask the
    service every time."""

    def __init__(self, seconds: float = CACHE_SECONDS) -> None:
        self.seconds = seconds
        self._seen: Dict[str, Tuple[float, Verdict]] = {}

    def get(self, key: str) -> Optional[Verdict]:
        found = self._seen.get(fingerprint(key))
        if found is None or time.monotonic() - found[0] > self.seconds:
            return None
        return found[1]

    def put(self, key: str, verdict: Verdict) -> None:
        self._seen = {fingerprint(key): (time.monotonic(), verdict)}

    def forget(self) -> None:
        self._seen = {}

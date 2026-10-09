"""JSON-RPC 2.0 over the two protocol pipes, one object per ``\\n``.

The daemon only ever sends requests; the script only ever replies and sends
notifications. Reading happens on a thread so the same code works on every
platform's event loop (Windows pipes cannot be awaited directly).
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from typing import Any, Callable, List, Optional


class Channel:
    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        read_fd: int,
        write_fd: int,
        on_message: Callable[[dict], None],
        on_eof: Callable[[], None],
    ) -> None:
        self._loop = loop
        self._reader = os.fdopen(read_fd, "rb", buffering=0)
        self._writer = os.fdopen(write_fd, "wb", buffering=0)
        self._lock = threading.Lock()
        self._on_message = on_message
        self._on_eof = on_eof
        self._closed = False

    def start(self) -> None:
        threading.Thread(target=self._read_loop, name="genehub-rpc-reader", daemon=True).start()

    def _read_loop(self) -> None:
        # Chunks of the line not yet ended, joined once its `\n` arrives, so
        # a large frame costs one copy rather than one per chunk.
        pending: List[bytes] = []
        while True:
            try:
                chunk = self._reader.read(65536)
            except OSError:
                chunk = b""
            if not chunk:
                break
            if b"\n" not in chunk:
                pending.append(chunk)
                continue
            lines = b"".join(pending + [chunk]).split(b"\n")
            rest = lines.pop()
            pending = [rest] if rest else []
            for line in lines:
                line = line.rstrip(b"\r")
                if not line.strip():
                    continue
                try:
                    message = json.loads(line.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    continue
                if isinstance(message, dict) and not self._deliver(self._on_message, message):
                    return
        self._deliver(self._on_eof)

    def _deliver(self, callback: Callable[..., None], *args: Any) -> bool:
        """False once the loop is gone (this process is exiting)."""
        try:
            self._loop.call_soon_threadsafe(callback, *args)
        except RuntimeError:
            return False
        return True

    def _write(self, message: dict) -> None:
        # `ensure_ascii` keeps U+2028/U+2029 escaped, so no line reader on the
        # other side can split one frame in two.
        data = (json.dumps(message, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")
        with self._lock:
            if self._closed:
                return
            try:
                self._writer.write(data)
                self._writer.flush()
            except (BrokenPipeError, OSError):
                self._closed = True

    def notify(self, method: str, params: Optional[dict] = None) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def reply(self, request_id: Any, result: Any = None) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "result": {} if result is None else result})

    def error(self, request_id: Any, message: str, code: int = -32000) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})

    def close(self) -> None:
        with self._lock:
            self._closed = True
            try:
                self._writer.close()
            except OSError:
                pass

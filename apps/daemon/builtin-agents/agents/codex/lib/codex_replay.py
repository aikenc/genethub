"""Offline checks for what Codex's login does with an API key and for its own
space: the model-list check comes before anything is saved, and the space
variable follows the switch. No network and no real Codex CLI."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import stat
import tempfile
from typing import Any, Dict, List, Optional

import codex_login
import codex_provider
from genehub_agent import keycheck, providers, space
from genehub_agent.serve import Outcome
from genehub_agent.testing import scratch_context, subset


def _fake_program(directory: str) -> str:
    path = os.path.join(directory, "codex")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write('#!/bin/sh\necho "$@" >> "$FAKE_RUNS"\ncat > "$FAKE_STDIN"\nexit 0\n')
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    return path


def run_api_key_login(case: dict) -> Optional[str]:
    scratch = tempfile.mkdtemp(prefix="codex-key-")
    saved = dict(os.environ)
    try:
        home = os.path.join(scratch, "home")
        os.makedirs(home)
        if case.get("config"):
            with open(os.path.join(home, "config.toml"), "w", encoding="utf-8") as handle:
                handle.write(case["config"])
        os.environ["CODEX_HOME"] = home
        os.environ.pop("OPENAI_BASE_URL", None)
        for name, value in (case.get("env") or {}).items():
            os.environ[name] = value
        stdin_path, runs_path = os.path.join(scratch, "stdin"), os.path.join(scratch, "runs")
        os.environ["FAKE_STDIN"], os.environ["FAKE_RUNS"] = stdin_path, runs_path
        program = _fake_program(scratch)
        ctx, _channel, job = scratch_context("codex")
        fetched: List[dict] = []

        async def ask(*_args: Any, **_kwargs: Any) -> Outcome:
            if case.get("canceled"):
                return Outcome(canceled=True)
            return Outcome(canceled=False, option_id="save", text={"key": case.get("key", "")})

        ctx.ask = ask  # type: ignore[method-assign]
        wanted = case["verdict"]

        async def fetch(url: str, headers: Any, timeout: float = 0) -> keycheck.Verdict:
            fetched.append({"url": url, "sentKey": any(case.get("key", "") in value for value in headers.values())})
            return keycheck.Verdict(wanted["status"], wanted.get("detail", ""))

        real_fetch = keycheck.fetch
        keycheck.fetch = fetch  # type: ignore[assignment]
        loop = asyncio.new_event_loop()
        try:
            try:
                result, unchecked = loop.run_until_complete(codex_login.api_key_login(ctx, job, program, dict(os.environ)))
                record: Dict[str, Any] = {"result": result, "unchecked": unchecked}
            except RuntimeError as error:
                record = {"result": "error: " + str(error), "unchecked": None}
        finally:
            loop.close()
            keycheck.fetch = real_fetch  # type: ignore[assignment]
        record["fetched"] = fetched
        record["ran"] = os.path.exists(runs_path)
        record["stdin"] = open(stdin_path, encoding="utf-8").read() if os.path.exists(stdin_path) else None
        return subset(case["expect"], record, "login")
    finally:
        os.environ.clear()
        os.environ.update(saved)
        shutil.rmtree(scratch, ignore_errors=True)


def run_space(case: dict) -> Optional[str]:
    saved = dict(os.environ)
    ctx, _channel, _job = scratch_context("codex")
    try:
        before = case.get("before")
        if before is None:
            os.environ.pop("CODEX_HOME", None)
        else:
            os.environ["CODEX_HOME"] = before
        space._SHADOWED.clear()
        record: Dict[str, Any] = {"initial": space.apply(ctx, "CODEX_HOME")}
        space.switch(ctx, "CODEX_HOME", True)
        inside = os.environ.get("CODEX_HOME")
        record["own"] = space.own(ctx)
        record["insideIsSpace"] = inside == space.directory(ctx)
        record["private"] = oct(os.stat(inside).st_mode & 0o777) if inside else None
        # The next daemon start reads the same choice.
        if before is None:
            os.environ.pop("CODEX_HOME", None)
        else:
            os.environ["CODEX_HOME"] = before
        space._SHADOWED.clear()
        record["restarted"] = space.apply(ctx, "CODEX_HOME")
        record["restartedIsSpace"] = os.environ.get("CODEX_HOME") == space.directory(ctx)
        space.switch(ctx, "CODEX_HOME", False)
        record["ownAfter"] = space.own(ctx)
        record["after"] = os.environ.get("CODEX_HOME")
        record["kept"] = os.path.isdir(space.directory(ctx))
        return subset(case["expect"], json.loads(json.dumps(record)), "space")
    finally:
        os.environ.clear()
        os.environ.update(saved)
        space._SHADOWED.clear()
        shutil.rmtree(ctx.state_dir, ignore_errors=True)


def run_provider(case: dict, agent: Any) -> Optional[str]:
    """Codex on a GeneHub provider: choosing one binds it, the app-server gets
    the provider's settings as overrides and the key only through the
    environment, the picker shows the provider's models, and a provider that
    stops being usable is reported instead of being ignored."""
    ctx, channel, job = scratch_context("codex")
    saved_refresh = agent.refresh
    available: List[dict] = [dict(entry) for entry in case["providers"]]
    secret = case["providers"][0].get("apiKey", "\0")

    async def provider_call(op: str, provider: Optional[str] = None) -> dict:
        if op == "list":
            return {"providers": [{**{k: v for k, v in e.items() if k != "apiKey"}, "usable": bool(e.get("apiKey")) and bool(e.get("baseUrl"))} for e in available]}
        entry = next((e for e in available if e["id"] == provider), None)
        if entry is None:
            raise RuntimeError(f"没有名为 {provider} 的 provider")
        if not entry.get("apiKey"):
            raise RuntimeError(f"{entry.get('label', provider)} 还没有保存 API Key")
        return {"provider": dict(entry)}

    offered: List[str] = []

    async def ask(job: Any, step: str, title: str, **kwargs: Any) -> Outcome:
        offered.extend(option["id"] for option in kwargs.get("options") or [])
        return Outcome(canceled=False, option_id=case["choose"])

    async def no_refresh(_ctx: Any) -> None:
        return None

    ctx.provider_call = provider_call  # type: ignore[method-assign]
    ctx.ask = ask  # type: ignore[method-assign]
    agent.ctx = ctx
    agent.refresh = no_refresh  # type: ignore[method-assign]
    agent._provider = None
    agent.hello = None
    loop = asyncio.new_event_loop()
    try:
        record: Dict[str, Any] = {}
        try:
            loop.run_until_complete(agent._use_provider(ctx, job))
            record["result"] = "done"
        except RuntimeError as error:
            record["result"] = "error: " + str(error)
        record["offered"] = offered
        record["bound"] = providers.bound(ctx)
        record["args"] = agent.provider_args()
        record["keyInEnv"] = agent.env().get(codex_provider.KEY_VARIABLE)
        record["keyInArgs"] = any(secret in value for value in agent.provider_args())
        record["models"] = [m["id"] for m in (agent.effective_hello().get("models") or [])]
        record["defaultModel"] = agent.effective_hello().get("defaultModel")
        if case.get("thenRemoveKey"):
            for entry in available:
                if entry["id"] == case["thenRemoveKey"]:
                    entry["apiKey"] = ""
            loop.run_until_complete(agent._load_provider())
            record["problem"] = agent._provider_problem
            record["providerAfterLoss"] = agent._provider is not None
        if case.get("thenLeave"):
            loop.run_until_complete(agent._leave_provider(ctx, job))
            record["boundAfterLeave"] = providers.bound(ctx)
            record["argsAfterLeave"] = agent.provider_args()
            record["keyAfterLeave"] = agent.env().get(codex_provider.KEY_VARIABLE)
        shown = json.dumps([m["params"] for m in channel.messages], ensure_ascii=False)
        record["keyReachedLogs"] = secret in shown
        return subset(case["expect"], json.loads(json.dumps(record)), "provider")
    finally:
        loop.close()
        agent.refresh = saved_refresh  # type: ignore[method-assign]
        agent._provider = None
        shutil.rmtree(ctx.state_dir, ignore_errors=True)

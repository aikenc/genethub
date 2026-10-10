"""What is specific to CodeBuddy and needs no running Agent: its flavor of the
Claude protocol and the pure parts of the ACP login. Kept apart from
``agent.py`` so the offline tests can import it without starting the Agent."""

from __future__ import annotations

import json
from typing import Optional

from genehub_agent import login
from genehub_agent.claude_family import Flavor

CODEBUDDY = Flavor(
    id="codebuddy",
    label="CodeBuddy",
    binaries=("cbc", "codebuddy"),
    npm_package="@tencent-ai/codebuddy-code",
    config_dir_name=".codebuddy",
    config_dir_env="CODEBUDDY_CONFIG_DIR",
    skip_permissions_flag="--dangerously-skip-permissions",
    # CodeBuddy's parser rejects --permission-prompt-tool and asks through
    # can_use_tool regardless.
    permission_prompt_tool=False,
    # Without it the bypass flag still asks about high-risk tools.
    sandbox_env=("CODEBUDDY_IS_SANDBOX", "1"),
    project_encoding="codebuddy",
)

API_KEY_VARIABLE = "CODEBUDDY_API_KEY"
INTERNET_ENVIRONMENT = "CODEBUDDY_INTERNET_ENVIRONMENT"
LOGOUT_TIMEOUT = 30.0

# What the CLI's ACP login calls its sign-in methods.
LOGIN_METHODS = [
    ("external", "Google / GitHub 账号（国际版）"),
    ("internal", "微信登录（国内版）"),
    ("iOA", "iOA 企业登录"),
]
# Which service an API key belongs to. Empty keeps the CLI's own default.
REGIONS = [("", "默认（国际版）"), ("internal", "国内版"), ("ioa", "iOA 企业版")]

INITIALIZE_ID = 1
AUTHENTICATE_ID = 2


def acp_script(method: str) -> str:
    """The two JSON-RPC lines that start an account login."""
    return (
        json.dumps({"jsonrpc": "2.0", "id": INITIALIZE_ID, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {}}})
        + "\n"
        + json.dumps({"jsonrpc": "2.0", "id": AUTHENTICATE_ID, "method": "authenticate", "params": {"methodId": method}})
        + "\n"
    )


def _frame(line: str) -> Optional[dict]:
    text = line.strip()
    if not text.startswith("{"):
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def verdict_from_line(line: str) -> Optional[str]:
    """``"ok"`` / ``"error: <message>"`` once the authenticate request has been
    answered; None for every other line."""
    frame = _frame(line)
    if frame is None or frame.get("id") != AUTHENTICATE_ID:
        return None
    if "error" in frame:
        error = frame["error"] if isinstance(frame["error"], dict) else {}
        data = error.get("data") if isinstance(error.get("data"), dict) else {}
        message = data.get("details") or error.get("message") or "授权没有成功"
        return "error: " + str(message)
    return "ok" if "result" in frame else None


_SENSITIVE = ("token", "bearer", "secret", "password", "apikey", "api_key")


def redact_line(line: str) -> str:
    """What of the login CLI's output may reach the job log. The authenticate
    reply and the CLI's own diagnostics can carry credentials, so only a fixed
    summary of the protocol lines is logged."""
    frame = _frame(line)
    if frame is not None:
        if frame.get("method") == "_codebuddy.ai/authUrl":
            return "收到授权链接（见请求卡片）"
        verdict = verdict_from_line(line)
        if verdict == "ok":
            return "授权完成"
        if verdict:
            return "授权失败：" + verdict[len("error: ") :]
        return ""
    plain = login.strip_ansi(line)
    if any(word in plain.lower() for word in _SENSITIVE):
        return ""
    return login.hide_urls(plain)

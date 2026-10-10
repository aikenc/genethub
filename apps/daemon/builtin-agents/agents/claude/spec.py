"""What is specific to Claude Code and needs no running Agent: its flavor of the
Claude protocol and how to read its login status. Kept apart from ``agent.py``
so the offline tests can import it without starting the Agent."""

from __future__ import annotations

import json
import os
from typing import Optional

from genehub_agent.claude_family import Flavor

CLAUDE = Flavor(
    id="claude",
    label="Claude Code",
    binaries=("claude",),
    npm_package="@anthropic-ai/claude-code",
    config_dir_name=".claude",
    config_dir_env="CLAUDE_CONFIG_DIR",
    skip_permissions_flag="--allow-dangerously-skip-permissions",
    permission_prompt_tool=True,
    # Claude refuses the skip flag as uid 0 unless it believes it is sandboxed.
    sandbox_env=("IS_SANDBOX", "1"),
    project_encoding="claude",
    home_dirs=((".local", "bin"), (".claude", "local")),
)

STATUS_TIMEOUT = 15.0
LOGOUT_TIMEOUT = 30.0
# Any of these makes the CLI usable without an account login.
CREDENTIAL_VARIABLES = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")


def has_credential_variable() -> bool:
    return any(os.environ.get(name, "").strip() for name in CREDENTIAL_VARIABLES)


def status_from_output(stdout: str) -> Optional[bool]:
    """``claude auth status --json``: ``{"loggedIn": true, ...}``."""
    start, end = stdout.find("{"), stdout.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        value = json.loads(stdout[start : end + 1])
    except ValueError:
        return None
    logged = value.get("loggedIn") if isinstance(value, dict) else None
    return logged if isinstance(logged, bool) else None

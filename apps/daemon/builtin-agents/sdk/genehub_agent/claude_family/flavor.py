"""What differs between the CLIs that speak Claude Code's stream-json protocol.

Claude Code and CodeBuddy's ``cbc`` read the same frames and answer the same
control requests; they differ in a handful of spellings and in where they keep
their files. Those differences are data (:class:`Flavor`), so the session,
translation and lifecycle code is written once.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .. import process

# The one-switch "never ask" setting both CLIs honour, written into every
# launch so a user-level sandbox setting cannot change what the GeneHub
# permission modes mean.
UNRESTRICTED_SETTINGS = '{"sandbox":{"enabled":false}}'


@dataclass(frozen=True)
class Flavor:
    id: str
    label: str
    # Executable names in order of preference; CodeBuddy's package ships both
    # ``cbc`` and ``codebuddy``.
    binaries: Tuple[str, ...]
    npm_package: str
    # Name of the per-user config directory under the home directory, and the
    # environment variable that relocates it.
    config_dir_name: str
    config_dir_env: str
    # The CLI's own "do not ask" switch; the two spell it differently.
    skip_permissions_flag: str
    # ``--permission-prompt-tool stdio`` exists on Claude only; CodeBuddy
    # rejects the option and asks through ``can_use_tool`` regardless.
    permission_prompt_tool: bool
    # Makes the bypass flag a full pass: Claude refuses it as uid 0 unless it
    # believes it is sandboxed, CodeBuddy still asks about high-risk tools.
    sandbox_env: Optional[Tuple[str, str]]
    # Each CLI normalizes a workspace path into its project key its own way.
    project_encoding: str  # "claude" | "codebuddy"
    # Directories below the home directory where an install may sit when the
    # daemon's PATH does not include it.
    home_dirs: Tuple[Tuple[str, ...], ...] = ((".local", "bin"),)
    help_args: Tuple[str, ...] = ("--help",)
    description_en: str = ""

    # -- files ------------------------------------------------------------

    def config_dir(self) -> str:
        override = os.environ.get(self.config_dir_env, "").strip()
        if override:
            return override
        return os.path.join(os.path.expanduser("~"), self.config_dir_name)

    # -- executables -------------------------------------------------------

    def install_dirs(self) -> List[str]:
        home = os.path.expanduser("~")
        dirs: List[str] = []
        if os.name == "nt":
            for var, sub in (("APPDATA", "npm"), ("LOCALAPPDATA", os.path.join("Programs", self.id))):
                base = os.environ.get(var)
                if base:
                    dirs.append(os.path.join(base, sub))
        else:
            dirs.extend(
                [
                    os.path.join(home, ".npm-global", "bin"),
                    os.path.join(home, ".volta", "bin"),
                    os.path.join(home, ".bun", "bin"),
                    "/opt/homebrew/bin",
                    "/usr/local/bin",
                ]
            )
        for parts in self.home_dirs:
            dirs.append(os.path.join(home, *parts))
        # `npm install -g` puts a launcher next to `node` when the prefix is
        # not on PATH (nvm, a user prefix).
        node = process.find_executable("node")
        if node:
            directory = os.path.dirname(node)
            if directory not in dirs:
                dirs.append(directory)
        return dirs

    def find_program(self, managed_bin: Optional[str] = None) -> Optional[str]:
        """GeneHub's own npm prefix first (what install and update manage), then
        PATH, then the usual install directories."""
        for name in self.binaries:
            found = managed_bin_for(managed_bin, name)
            if found:
                return found
        for name in self.binaries:
            found = process.find_executable(name, self.install_dirs())
            if found:
                return found
        return None

    # -- launching -----------------------------------------------------------

    def sandbox(self) -> Dict[str, str]:
        return {self.sandbox_env[0]: self.sandbox_env[1]} if self.sandbox_env else {}


def managed_bin_for(directory: Optional[str], name: str) -> Optional[str]:
    if not directory or not os.path.isdir(directory):
        return None
    return shutil.which(name, path=directory)

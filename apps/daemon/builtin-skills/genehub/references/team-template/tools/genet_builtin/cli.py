"""Single entry for commands, timer and configured business Classes."""
import json
from pathlib import Path
import sys
from .api import TeamConfigurationError
from .runtime import get_runtime


def main(argv=None, root=None):
    from . import team
    argv = list(sys.argv[1:] if argv is None else argv)
    if root is not None:
        team._ENTRY_ROOT = str(Path(root).resolve())
    try:
        selected_root = team.find_root()
        runtime = get_runtime(selected_root)
        if argv == ["describe"]:
            print(json.dumps(runtime.describe(), ensure_ascii=False)); return 0
        if argv[:2] == ["board", "serve"]:
            from . import board
            board.main(["--team-root", selected_root, *argv[2:]])
            return 0
        if argv and argv[0] == "tick":
            argv[0] = "hook"
        return team.main(argv)
    except (TeamConfigurationError, team.ExpertError) as error:
        print(str(error), file=sys.stderr)
        return 1

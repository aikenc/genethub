#!/usr/bin/env python3
"""Single Team command entry, independent of the caller's working directory."""
import sys
sys.dont_write_bytecode = True

from pathlib import Path
if __name__ == "__main__":
    root = str(Path(__file__).resolve().parent.parent)
    # The installed maintainer can recover a source whose own runner predates
    # an upgrade fix. It still loads that source's declared Classes/settings.
    if sys.argv[1:2] == ['--team-root']:
        if len(sys.argv) < 4 or sys.argv[3] != 'upgrade' or not Path(sys.argv[2]).is_absolute():
            raise SystemExit('--team-root requires an absolute definition source and the upgrade command')
        root = str(Path(sys.argv[2]).resolve())
        sys.argv[1:3] = []
    # The worker takes the exclusive side only after its isolated candidate
    # passes. Ordinary commands cannot import a partially applied package.
    if sys.argv[1:2] == ['upgrade'] and '--worker' in sys.argv[2:]:
        from genet_builtin.cli import main
        raise SystemExit(main(root=root))
    from genet_builtin.update_gate import gate
    with gate(root):
        from genet_builtin.cli import main
        raise SystemExit(main(root=root))

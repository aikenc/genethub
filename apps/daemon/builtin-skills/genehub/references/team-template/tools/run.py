#!/usr/bin/env python3
"""Single Team command entry, independent of the caller's working directory."""
import sys
sys.dont_write_bytecode = True

from pathlib import Path
if __name__ == "__main__":
    root = str(Path(__file__).resolve().parent.parent)
    # The worker takes the exclusive side only after its isolated candidate
    # passes. Ordinary commands cannot import a partially applied package.
    if sys.argv[1:2] == ['upgrade'] and '--worker' in sys.argv[2:]:
        from genet_builtin.cli import main
        raise SystemExit(main(root=root))
    from genet_builtin.update_gate import gate
    with gate(root):
        from genet_builtin.cli import main
        raise SystemExit(main(root=root))

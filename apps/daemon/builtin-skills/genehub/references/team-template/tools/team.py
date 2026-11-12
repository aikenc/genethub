#!/usr/bin/env python3
"""Compatibility entry; new commands use tools/run.py."""
import sys
sys.dont_write_bytecode = True

if __name__ == "__main__":
    import runpy
    from pathlib import Path
    runpy.run_path(str(Path(__file__).resolve().with_name('run.py')), run_name='__main__')
else:
    from genet_builtin import team as _team

    def __getattr__(name):
        return getattr(_team, name)

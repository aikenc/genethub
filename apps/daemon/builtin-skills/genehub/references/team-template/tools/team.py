#!/usr/bin/env python3
"""Compatibility entry; new commands use tools/run.py."""
import sys
sys.dont_write_bytecode = True

from genet_builtin import team as _team
from genet_builtin.cli import main

def __getattr__(name):
    return getattr(_team, name)

if __name__ == "__main__":
    raise SystemExit(main())

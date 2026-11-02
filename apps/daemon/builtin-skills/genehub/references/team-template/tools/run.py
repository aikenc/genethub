#!/usr/bin/env python3
"""Single Team command entry, independent of the caller's working directory."""
import sys
sys.dont_write_bytecode = True

from pathlib import Path
from genet_builtin.cli import main

if __name__ == "__main__":
    raise SystemExit(main(root=str(Path(__file__).resolve().parent.parent)))

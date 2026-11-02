"""Compatibility import; use the public genet_builtin.api for extensions."""
import sys
sys.dont_write_bytecode = True

from genet_builtin.tasks import *

"""Platform-shipped Team framework; extend the public API in a project sibling package."""
import sys

# Command/help/dry-run and installed artifacts must not create unowned caches.
sys.dont_write_bytecode = True

"""OS lock protecting command imports while an upgrade applies source files."""
from contextlib import contextmanager
import os
from pathlib import Path
import time


class SafePointBusy(RuntimeError):
    pass


@contextmanager
def gate(root, exclusive=False):
    # Portable execution directories are immutable and replaced by the
    # existing installer. Do not introduce unowned files into an artifact.
    if (Path(root)/'.spacebuilder/output-lock.json').is_file():
        yield
        return
    path = Path(root)/'.genethub/team/runtime-update.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as handle:
        if os.name == 'nt':
            import msvcrt
            if path.stat().st_size == 0:
                handle.write(b'0'); handle.flush()
            def acquire():
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            def release():
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            def acquire():
                fcntl.flock(handle.fileno(), (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
            def release():
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        end = time.monotonic() + 60
        while True:
            try:
                acquire()
                break
            except OSError:
                if time.monotonic() >= end:
                    raise SafePointBusy('platform source upgrade is applying; original work and receipts are retained')
                time.sleep(.05)
        try:
            yield
        finally:
            release()

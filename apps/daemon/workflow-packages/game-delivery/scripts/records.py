"""Atomic immutable package records; readers never see a partial JSON file."""
import datetime
import hashlib
import os
import pathlib
import tempfile


def write_record(folder, content, width=8):
    folder = pathlib.Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(content.encode()).hexdigest()
    for length in (width, 16):
        key = digest[:length]
        for existing in folder.glob(f"*_{key}.json"):
            if existing.read_text(encoding="utf8") == content:
                return existing, key
        stamp = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%y%m%d-%H%M%S")
        target = folder / f"{stamp}_{key}.json"
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf8", dir=folder, prefix=".record-", delete=False) as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            source = temporary.name
        try:
            try:
                os.link(source, target)
                return target, key
            except FileExistsError:
                if target.read_text(encoding="utf8") == content:
                    return target, key
        finally:
            os.unlink(source)
    raise ValueError("record identity collision; existing content was preserved")

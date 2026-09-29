#!/usr/bin/env python3
"""Plain copying reference action: stdin JSON -> pack.script receipt."""
import hashlib
import json
import pathlib
import shutil
import sys

data = json.load(sys.stdin)
source = pathlib.Path(data.get('source', '.')).resolve()
destination = pathlib.Path(data['destination']).resolve()
if not source.is_dir() or destination == source or source in destination.parents:
    raise ValueError('destination must be outside the source directory')
shutil.copytree(source, destination, dirs_exist_ok=True)
files = sorted(str(file.relative_to(destination)) for file in destination.rglob('*') if file.is_file())
digest = hashlib.sha256(''.join(file + '\0' for file in files).encode()).hexdigest()[:16]
print(json.dumps({'ok': True, 'revision': 'dir:' + digest, 'evidence': {
    'published': str(len(files)), 'destination': str(destination),
    'matchedExpectation': 'unchecked' if 'expectedFiles' not in data else str(len(files) == data['expectedFiles']).lower()
}, 'message': f'published {len(files)} files to {destination}'}))

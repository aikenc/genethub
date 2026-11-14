"""Compare a private scorer with the actual native kernel's embedded package.

This is an operational integrity check under the existing OS account authority,
not protection against an account replacing the collector or fabricating facts.
"""
import hashlib
from pathlib import Path
import re

BASIS = 'native-embedded-team-scoring/1'
REQUIRED = {'quality.py', 'quality_score.py', 'task_hours.py', 'quality_attribution.py'}


def capture(root, manifest):
    files = manifest.get('files') if isinstance(manifest, dict) else None
    if (not isinstance(manifest, dict) or manifest.get('basis') != BASIS
            or not isinstance(files, dict) or not REQUIRED <= files.keys()
            or not 4 <= len(files) <= 256
            or any(not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*\.py', name)
                   or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest)
                   for name, digest in files.items())):
        return dict(state='unknown', reason='native-reference-unavailable', files=[])
    base = Path(root)/'tools/genet_builtin'
    rows, total = [], 0
    for name, expected in sorted(files.items()):
        row = dict(name=name, expectedSha256=expected, observedSha256=None, state='unknown')
        path = base/name
        try:
            if base.is_symlink() or path.is_symlink() or not path.is_file():
                row.update(state='mismatched', reason='missing-or-aliased-copy')
            else:
                size = path.stat().st_size
                total += size
                if size > 4*1024*1024 or total > 32*1024*1024:
                    row['reason'] = 'read-bound-exceeded'
                else:
                    with path.open('rb') as stream:
                        payload = stream.read(4*1024*1024+1)
                    if len(payload) > 4*1024*1024:
                        row['reason'] = 'read-bound-exceeded'
                    else:
                        digest = hashlib.sha256(payload).hexdigest()
                        row.update(observedSha256=digest, state='matched' if digest == expected else 'mismatched')
        except OSError:
            row['reason'] = 'copy-read-unavailable'
        rows.append(row)
    state = ('mismatched' if any(x['state']=='mismatched' for x in rows) else
             'matched' if all(x['state']=='matched' for x in rows) else 'unknown')
    return dict(state=state, files=rows)


def combine(before, after):
    rows = [x for value in (before, after) for x in value.get('files', [])]
    mismatch = any(x.get('state')=='mismatched' for x in rows)
    stable = before == after and before.get('state') == 'matched'
    return dict(state='mismatched' if mismatch else 'matched' if stable else 'unknown',
                reason=None if mismatch or stable else 'reference-or-copy-not-stable',
                files=rows if mismatch else after.get('files', []))


def verdict(value):
    if not isinstance(value, dict):
        return None
    rows = value.get('files', [])
    if not isinstance(rows, list) or any(not isinstance(x, dict) for x in rows):
        return None
    if any(x.get('state') == 'mismatched' for x in rows):
        return True
    names = {x.get('name') for x in rows if x.get('state') == 'matched'
             and x.get('expectedSha256') == x.get('observedSha256')
             and isinstance(x.get('expectedSha256'), str)
             and re.fullmatch(r'[0-9a-f]{64}', x['expectedSha256'])}
    return False if value.get('state')=='matched' and REQUIRED <= names and len(names)==len(rows) else None

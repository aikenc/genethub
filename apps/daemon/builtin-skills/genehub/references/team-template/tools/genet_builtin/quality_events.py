"""Diagnostic lifecycle facts. Scheduling never reads this append-only log.

An event may be replayed after an interrupted append. Readers deduplicate its
stable identity; business actions never depend on a successful event write.
"""
import hashlib
import json
import os
from pathlib import Path
import sys

_TEMPLATE_SHA = None


def emit(team, root, kind, identity, *, at_ms=None, **facts):
    """Best effort, bounded single append, under the normal nonblocking lock."""
    try:
        global _TEMPLATE_SHA
        if _TEMPLATE_SHA is None:
            digest = hashlib.sha256()
            for source in sorted(Path(__file__).parent.glob('*.py')):
                digest.update(source.name.encode() + b'\0' + source.read_bytes() + b'\0')
            _TEMPLATE_SHA = digest.hexdigest()
        event_id = hashlib.sha256((kind + ':' + str(identity)).encode()).hexdigest()
        base = Path(team.state_dir(root, 'events'))
        marker = base / 'seen' / event_id
        value = dict(facts, schema='team-process-event/1', eventId=event_id,
                     kind=kind, atMs=team.now_ms() if at_ms is None else at_ms,
                     recordedAtMs=team.now_ms(), templateSha256=_TEMPLATE_SHA)
        payload = (json.dumps(value, ensure_ascii=False, sort_keys=True,
                              separators=(',', ':'), allow_nan=False) + '\n').encode()
        if len(payload) > 8192:
            raise ValueError('event exceeds 8 KiB')
        with team.inbox_lock(root, 'quality-events', purpose='过程事件'):
            if marker.exists():
                return True
            marker.parent.mkdir(parents=True, exist_ok=True)
            # Append before marking: a crash can duplicate a stable event, but
            # cannot reserve its identity while silently losing the event.
            fd = os.open(base / 'events.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                if os.write(fd, payload) != len(payload):
                    raise OSError('incomplete event append')
                os.fsync(fd)
            finally:
                os.close(fd)
            marker.touch(exist_ok=True)
        return True
    except Exception as error:
        # The scorer also checks required lifecycle facts against the durable
        # task/dispatch ledger. Missing data cannot become a zero-loss result.
        try:
            failure = Path(team.state_dir(root, 'events', 'failures'))
            failure.mkdir(parents=True, exist_ok=True)
            path = failure / (str(team.now_ms()) + '-' + str(os.getpid()))
            path.write_text(json.dumps({'kind': kind, 'error': type(error).__name__}) + '\n')
        except Exception:
            pass
        try:
            print('[quality] event unavailable: ' + kind + ' (' + type(error).__name__ + ')', file=sys.stderr)
        except Exception:
            pass
        return False

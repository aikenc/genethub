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
LEDGER_BASIS = 'task-and-note-ledger/1'


def ledger_before(path):
    """Capture only semantic Team ledgers, never runtime heartbeats or secrets.

    This diagnostic must not turn a readable/writable business file into a
    prerequisite. An unreadable prior value becomes a gap, not 'no change'.
    """
    path = Path(path).absolute()
    for parent in path.parents:
        if parent.name != 'team' or parent.parent.name != '.genethub':
            continue
        relative = path.relative_to(parent)
        if relative.parts[0] not in ('tasks', 'task-dispatch', 'task-inputs', 'notes', 'notes-done') or path.suffix != '.json':
            return None
        try:
            if path.is_symlink() or path.exists() and path.stat().st_size > 8*1024*1024:
                raise ValueError('unbounded ledger')
            previous = ledger_hash(relative, json.loads(path.read_text())) if path.exists() else None
            return (str(parent.parent.parent), str(relative), previous, False)
        except Exception:
            return (str(parent.parent.parent), str(relative), None, True)
    return None


def ledger_hash(relative, value):
    if Path(relative).parts[0] == 'tasks' and isinstance(value, dict):
        # A watchdog checking its own counters is not a work-ledger increment.
        value = {k: v for k, v in value.items() if k != 'watchdog'}
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def ledger_after(team, before, value):
    if before is None:
        return
    root, relative, prior, gap = before
    try:
        after = ledger_hash(relative, value)
        if not gap and prior == after:
            return
        at = team.now_ms()
        emit(team, root, 'ledger-gap' if gap else 'ledger-changed',
             relative+':'+str(at)+':'+str(os.getpid())+':'+after,
             at_ms=at, basis=LEDGER_BASIS, ledger=relative,
             beforeSha256=prior, afterSha256=after)
    except Exception:
        # emit itself persists a failure marker if its destination fails.
        emit(team, root, 'ledger-gap', relative+':'+str(team.now_ms()),
             basis=LEDGER_BASIS, ledger=relative)


def observe_ledger(team, root):
    at = team.now_ms()
    emit(team, root, 'ledger-observed', str(at)+':'+str(os.getpid()),
         at_ms=at, basis=LEDGER_BASIS)


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

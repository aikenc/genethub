"""Optional bounded work registration, corroborated by native process census.

No process is started, signalled or adopted here. Unregistered background
servers are not work-time evidence. Measurement failure never stops a task.
"""
import hashlib
import json
import re
from pathlib import Path


def rows(t, root):
    paths = sorted(Path(t.state_dir(root, 'background-jobs')).glob('*.json'))
    if len(paths) > 10000 or sum(p.stat().st_size for p in paths) > 8*1024*1024:
        raise ValueError('background job registry exceeds bounded read')
    result = []
    for p in paths:
        if p.is_symlink():
            raise ValueError('background job record must be regular')
        row = t.read_dispatch_record(str(p))
        if not row or row.get('schema') != 'team-background-job/1':
            raise ValueError('unknown background job schema')
        result.append((str(p), row))
    return result


def process(t, sid, machine, pid):
    values = t.genet('process', 'list', *t.machine_args(machine), timeout=5)['processes']
    if not isinstance(values, list):
        raise ValueError('native process inventory unavailable')
    return next((x for x in values if x.get('sessionId') == sid and x.get('pid') == pid), None)


def runtime_bounds(at, value):
    age = value.get('runningForSeconds')
    if type(age) is not int or age < 0:
        raise ValueError('native process runtime missing')
    # etime has second precision; allow the bounded census/transport latency.
    return [at-(age+6)*1000, at-age*1000+5000]


def sample(t, root, path, row, value, at):
    positive = False
    if value is None:
        row['observation'] = 'not-in-native-inventory'
    else:
        low, high = runtime_bounds(at, value)
        old_low, old_high = row['processBirthBoundsMs']
        if high < old_low or low > old_high:
            row['observation'] = 'native-process-identity-changed'
        else:
            row['processBirthBoundsMs'] = [max(low, old_low), min(high, old_high)]
            row['observedThroughAtMs'] = max(row['observedThroughAtMs'], min(at, row['deadlineAtMs']))
            row['observation'] = 'native-process-alive'
            positive = True
    row['checkedAtMs'] = at
    t.write_json(path, row)
    if positive:
        from . import quality_events
        quality_events.emit(t, root, 'background-work-observed', row['jobId']+':'+str(at),
            at_ms=at, jobId=row['jobId'], taskId=row['taskId'], sessionId=row['sessionId'],
            machine=row.get('machine'), pid=row['pid'], kindOfWork=row['kind'],
            registeredAtMs=row['registeredAtMs'], observedThroughAtMs=row['observedThroughAtMs'],
            deadlineAtMs=row['deadlineAtMs'], timeBasis='registered-native-process-runtime/1')


def command(t, root, task, sid, args):
    person = next((x for x in [task.get('owner', {})]+task.get('collaborators', [])
                   if x.get('sessionId') == sid), None)
    if person is None:
        raise t.ExpertError('当前会话不属于此任务', '没有登记后台作业', '核对原任务归属')
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', args.job_id):
        raise ValueError('job ID must be a bounded stable identifier')
    key = hashlib.sha256((task['taskId']+':'+sid+':'+args.job_id).encode()).hexdigest()
    path = t.state_dir(root, 'background-jobs', key+'.json')
    with t.inbox_lock(root, 'background-job-'+key, purpose='后台工作登记'):
        row = t.read_dispatch_record(path)
        if args.job_action == 'register':
            if args.pid < 1 or not 1 <= args.max_seconds <= 86400:
                raise ValueError('job requires a positive PID and a 1..86400 second bound')
            intent = dict(taskId=task['taskId'], sessionId=sid, machine=person.get('machine'),
                          pid=args.pid, kind=args.kind, maxSeconds=args.max_seconds)
            if row:
                if row.get('intent') != intent:
                    raise ValueError('job ID conflicts with its original registration')
            else:
                if task.get('state') != 'active' or task.get('finished') or person.get('finished'):
                    raise ValueError('only unfinished active work can register a job')
                value = process(t, sid, person.get('machine'), args.pid)
                if value is None or value.get('service') is not None:
                    raise ValueError('PID must be this Session native work process, not a preview service')
                at = t.now_ms()
                row = dict(intent, schema='team-background-job/1', jobId=key, intent=intent,
                           state='registered', registeredAtMs=at, observedThroughAtMs=at,
                           deadlineAtMs=at+args.max_seconds*1000, processBirthBoundsMs=runtime_bounds(at, value))
                sample(t, root, path, row, value, at)
        elif args.job_action == 'status':
            if row is None:
                raise ValueError('job was not registered')
            if row.get('state') == 'registered':
                sample(t, root, path, row, process(t, sid, row.get('machine'), row['pid']), t.now_ms())
        else:
            if row is None:
                raise ValueError('job was not registered')
            if row.get('state') == 'finished':
                if row.get('exitCode') != args.exit_code:
                    raise ValueError('job conclusion conflicts with original exit code')
            else:
                current = process(t, sid, row.get('machine'), row['pid'])
                if current is not None:
                    raise ValueError('native work process is still running; registration retained')
                row.update(state='finished', exitCode=args.exit_code, finishedObservedAtMs=t.now_ms())
                t.write_json(path, row)
        print(json.dumps({k: row.get(k) for k in ('jobId', 'taskId', 'sessionId', 'state', 'registeredAtMs',
                          'observedThroughAtMs', 'deadlineAtMs', 'observation', 'exitCode')}, ensure_ascii=False))


def observe(t, root):
    marker = t.state_dir(root, 'background-job-check.json')
    at = t.now_ms()
    if at-(t.read_json(marker, {}) or {}).get('atMs', 0) < 60000:
        return
    t.write_json(marker, {'atMs': at})
    inventory = {}
    for path, row in rows(t, root):
        if row.get('state') != 'registered' or row['deadlineAtMs'] <= row['observedThroughAtMs']:
            continue
        machine = row.get('machine')
        try:
            if machine not in inventory:
                inventory[machine] = t.genet('process', 'list', *t.machine_args(machine), timeout=5)['processes']
                if not isinstance(inventory[machine], list):
                    raise ValueError('native process inventory unavailable')
            value = next((x for x in inventory[machine]
                          if x.get('sessionId') == row['sessionId'] and x.get('pid') == row['pid']), None)
            with t.inbox_lock(root, 'background-job-'+row['jobId'], purpose='后台工作观测'):
                current = t.read_dispatch_record(path)
                if current and current.get('state') == 'registered':
                    sample(t, root, path, current, value, t.now_ms())
        except Exception:
            # Old positive observations remain facts; failure cannot extend
            # them or impose a new prerequisite on business reconciliation.
            continue


def intervals(log, sid, task_id, end):
    return [{'startAtMs': x['registeredAtMs'], 'endAtMs': min(end, x['observedThroughAtMs'], x['deadlineAtMs']),
             'jobId': x['jobId'], 'basis': 'registered-native-process-runtime/1'}
            for x in log if x['kind'] == 'background-work-observed' and x.get('sessionId') == sid
            and x.get('taskId') == task_id and type(x.get('registeredAtMs')) is int
            and type(x.get('observedThroughAtMs')) is int and type(x.get('deadlineAtMs')) is int
            and min(end, x['observedThroughAtMs'], x['deadlineAtMs']) > x['registeredAtMs']]

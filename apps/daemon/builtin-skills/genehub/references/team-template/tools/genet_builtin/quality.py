"""Read-only collection and deterministic quality cards; no scheduling decisions."""
import hashlib
import json
import os
import stat
from pathlib import Path
import time
import tempfile
import sys

from .quality_score import canonical, number, score
from .task_hours import BASIS as R6_BASIS, policy as r6_policy
from .quality_events import EXECUTION_FAILURE_NOTICE

HOUR = 3600000
NOTIFICATION_BASIS = 'producer-execution-status/1'


def execution_status_input(team, recipient, item, header, body, ref):
    """Recognize the shipped status envelope, including its older result tag.

    An exact leading producer marker is required. Quoted examples, ordinary
    result text, unrelated source references and missing headers stay results.
    Retain identity and timing evidence, never the native error body.
    """
    if not header.startswith(('用途: result\n', '用途: status\n')) or not isinstance(ref, str):
        return None
    prefix = 'ghref:session:'
    source = ref[len(prefix):] if ref.startswith(prefix) else ''
    sender = next((line[5:] for line in header.splitlines() if line.startswith('发送方: ')), '')
    if (not team.SESSION_ID.fullmatch(source)
            or not (sender == source or sender.startswith(source + '（'))):
        return None
    lines = body.splitlines()
    if lines and lines[0].startswith('[并行决策信息]'):
        lines = lines[1:]
    if len(lines) < 2 or lines[0] != EXECUTION_FAILURE_NOTICE or not lines[1].startswith('原生错误：'):
        return None
    return dict(messageId=item['id'], sessionId=recipient, sourceSessionId=source,
                ref=ref, receivedAtMs=item.get('receivedAtMs'),
                basis=NOTIFICATION_BASIS, legacyResultTag=header.startswith('用途: result\n'))


def read_issue(kind, error, budget, **identity):
    """Keep native refusal identifiers, never exception text or CLI output."""
    issue = dict(kind=kind, error=type(error).__name__, **identity,
                 captureBudgetRemainingMs=max(0, int((budget-time.monotonic())*1000)))
    code = getattr(error, 'code', None)
    if (isinstance(code, str) and 0 < len(code) <= 80 and code.isascii()
            and all(c.isalnum() or c in '_.:-' for c in code)):
        issue['errorCode'] = code
    if error.__cause__ is not None:
        issue['cause'] = type(error.__cause__).__name__
    # Only our fixed guard identifiers: never expose arbitrary exception text.
    guards = {
        'native rounds changed during bounded capture': 'roundSourceChanged',
        'native history changed during bounded capture': 'narrativeSourceChanged',
        'native rounds pagination exceeded capture budget': 'roundPageLimit',
        'native narrative pagination exceeded capture budget': 'narrativePageLimit',
        'native rounds have no completed pagination anchor': 'roundAnchorUnavailable',
    }
    if type(error) is ValueError and len(error.args) == 1:
        code = guards.get(error.args[0]) if isinstance(error.args[0], str) else None
        if code:
            issue['collectionCode'] = code
    return issue


def read(path, default=None, maximum=64*1024*1024):
    path = Path(path)
    if not path.exists():
        return default
    if path.is_symlink() or path.stat().st_size > maximum:
        raise ValueError('quality input must be a bounded regular file')
    return json.loads(path.read_text(encoding='utf-8'))


def records(base):
    paths = sorted(Path(base).glob('*.json'))
    if len(paths) > 10000 or sum(p.stat().st_size for p in paths) > 64*1024*1024:
        raise ValueError('quality ledger exceeds bounded capture')
    return [read(p) for p in paths]


def events(root, cutoff):
    path = Path(root)/'.genethub/team/events/events.jsonl'
    spool = path.parent/'spool'
    if spool.is_symlink() or spool.exists() and not spool.is_dir():
        raise ValueError('event spool must be a regular directory')
    queued = sorted(spool.glob('*.json'))
    if len(queued) > 10000:
        raise ValueError('queued events exceed bounded read')
    lines, queued_bytes = [], 0
    for queued_path in queued:
        try:
            if queued_path.is_symlink():
                raise ValueError('queued event alias')
            with queued_path.open('rb') as handle:
                if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                    raise ValueError('queued event must be regular')
                payload = handle.read(8193)
        except FileNotFoundError:
            # A producer folded it. Read the append log after the spool, so
            # concurrent drain cannot leave the event between both reads.
            continue
        if len(payload) > 8192:
            raise ValueError('queued event exceeds bounded read')
        queued_bytes += len(payload)
        value = json.loads(payload)
        if value.get('eventId') != queued_path.stem:
            raise ValueError('queued event identity mismatch')
        lines.append(payload)
    if path.is_symlink():
        raise ValueError('event history alias')
    if path.exists():
        with path.open('rb') as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise ValueError('event history must be regular')
            payload = handle.read(64*1024*1024+1)
        if len(payload) + queued_bytes > 64*1024*1024:
            raise ValueError('event history exceeds bounded read')
        lines = payload.splitlines() + lines
    elif queued_bytes > 64*1024*1024:
        raise ValueError('event history exceeds bounded read')
    found = {}
    for line in lines:
        value = json.loads(line)
        if value.get('schema') != 'team-process-event/1':
            raise ValueError('unknown process event schema')
        if value.get('recordedAtMs', cutoff+1) <= cutoff:
            found.setdefault(value['eventId'], value)
    return sorted(found.values(), key=lambda x: (x['atMs'], x['eventId']))


def template_digest():
    digest = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob('*.py')):
        digest.update(path.name.encode()+b'\0'+path.read_bytes()+b'\0')
    return digest.hexdigest()


def result_audience(team, item, record):
    """Only a durable result generation can declare additional recipients."""
    delivery = record.get('resultDelivery') or {}
    done = record.get('done') or {}
    sid, primary = item.get('sessionId'), item.get('requester')
    ref, reply = delivery.get('ref'), done.get('reply')
    watchers = record.get('watchers', [])
    if (record.get('operationId') != item['id'] or record.get('sessionId') != sid
            or not isinstance(sid, str) or not team.SESSION_ID.fullmatch(sid)
            or not isinstance(primary, str) or not team.SESSION_ID.fullmatch(primary)
            or delivery.get('recipient') != primary or not isinstance(reply, str) or len(reply) > 512
            or delivery.get('generation') != [primary, reply] or done.get('ref') != ref
            or ref not in ('ghref:item:'+str(sid)+':'+reply, 'ghref:session:'+str(sid))
            or not isinstance(watchers, list) or len(watchers) > 64
            or any(not isinstance(x, str) or not team.SESSION_ID.fullmatch(x) for x in watchers)):
        return None  # No exemption from incomplete or unrelated metadata.
    return {'operationId':item['id'], 'primary':primary, 'ref':ref,
            'watchers':sorted(set(watchers)-{primary})}


def native_headers(team, wanted, platforms, store, budget):
    """Fresh public directory rows are the same native metadata projection as get.

    Cache metadata only hints at a query scope. Missing, incomplete or foreign
    scope results never prove Session absence: the caller still performs get.
    """
    scopes, headers = {}, {}
    for sid, machine in wanted.items():
        try:
            if not team.SESSION_ID.fullmatch(sid):
                continue
            old = read(store/'native'/(sid+'.json')) or {}
            kernel = platforms.get(machine) or {}
            workspace = old.get('workspaceId')
            if (old.get('sessionId') == sid and isinstance(workspace, str) and workspace
                    and kernel.get('machineId')
                    and (old.get('kernel') or {}).get('machineId') == kernel['machineId']):
                scopes.setdefault((machine, workspace), set()).add(sid)
        except Exception:
            continue  # A corrupt hint must not abort other native observations.
    for (machine, workspace), members in sorted(scopes.items(), key=lambda x: -len(x[1])):
        if len(members) < 2:
            continue
        cursor, seen, rows = None, set(), {}
        try:
            for _ in range(100):
                remaining = budget-time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('quality header budget exhausted')
                args = ['session', 'list', '--workspace', workspace, '--limit', '100', '--include-archived']
                if cursor:
                    args += ['--cursor', cursor]
                page = team.genet(*args, *team.machine_args(machine), timeout=min(15, remaining))
                if (page.get('machineId') != platforms[machine]['machineId']
                        or page.get('workspaceId') != workspace
                        or not isinstance(page.get('sessions'), list) or len(page['sessions']) > 100):
                    raise ValueError('native header scope mismatch')
                for row in page['sessions']:
                    if not isinstance(row, dict) or row.get('workspaceId') != workspace:
                        raise ValueError('native header row mismatch')
                    if row.get('id') in members:
                        rows[row['id']] = row
                cursor = page.get('nextCursor')
                if page.get('complete') is True and cursor is None:
                    headers.update({(machine, sid): row for sid, row in rows.items()})
                    break
                if not isinstance(cursor, str) or not cursor or cursor in seen:
                    raise ValueError('native header cursor did not advance')
                seen.add(cursor)
        except Exception:
            # This is only a batching optimization; individual native reads
            # remain authoritative and retain their own unavailable evidence.
            continue
    return headers


def native_snapshot(team, sid, machine, since, kernel, cache, budget, summary=None):
    """Only existing public inspect/rounds/narrative commands; no transcript cache."""
    def call(*args):
        if time.monotonic() >= budget:
            raise TimeoutError('quality capture budget exhausted')
        return team.genet(*args, *team.machine_args(machine), timeout=min(15, max(1, budget-time.monotonic())))
    if summary is None:
        summary = call('session', 'get', sid)['summary']
    old = read(cache)
    inputs=summary.get('inputSummary') or {}
    stable = (summary.get('status') in ('idle','failed') and (inputs.get('paused') or not inputs.get('pendingMessageIds'))
              and not (summary.get('interactionSummary') or {}).get('requests'))
    # Live and hourly readers request different horizons. A completely paged
    # unchanged native history covers both; its last requested `since` is not
    # the oldest evidence it contains. Legacy/partial caches keep the stricter
    # horizon guard, and every reuse still requires this fresh native summary.
    coverage = (old or {}).get('historyCoverage') or {}
    full_history = (coverage.get('basis') == 'native-page-completion/2'
                    and coverage.get('roundsComplete') is True
                    and coverage.get('narrativeComplete') is True)
    covered = old and (old.get('sinceAtMs', since+1) <= since or full_history)
    # Completed public history is machine-owned, not guest-patch-owned. This
    # versioned coverage basis also binds its projection; change the basis if
    # extraction semantics change. Partial/legacy caches retain exact-kernel
    # compatibility. A failed context read cannot establish machine identity.
    prior_kernel = (old or {}).get('kernel') or {}
    same_machine = (isinstance((kernel or {}).get('machineId'), str)
                    and bool(kernel['machineId']) and prior_kernel.get('machineId') == kernel['machineId'])
    compatible = same_machine and (prior_kernel == kernel or full_history)
    notification_ready = old and (old.get('resultNotificationBasis') == NOTIFICATION_BASIS
        or not any('ghref:session:' in (x.get('ref') or '') for x in old.get('inputLinks', [])))
    if stable and covered and compatible and notification_ready and old.get('integrationReferenceBasis')=='native-owner-use-reference/1' and old.get('sessionId')==sid and old.get('workspaceId')==summary.get('workspaceId') and old.get('status')==summary.get('status') and old.get('inputSummary')==summary.get('inputSummary',{}) and old.get('updatedAtMs') == summary.get('updatedAtMs'):
        return old
    inspection = call('session', 'inspect', sid)['inspection']
    first = call('session', 'rounds', sid, '--limit', '100')['page']
    # A running Round changes the public source digest as its narrative grows,
    # even while all older Round rows remain stable. Page completed history
    # through a fixed completed boundary, retaining the first fresh live rows.
    # Re-read its first page too: unbounded and pinned digests describe different
    # views and must never be combined as one pagination proof.
    fresh = sorted(first['rounds'], key=lambda x: (x['startedAtMs'], x['roundId']))
    closed = [x for x in fresh if x.get('endedAtMs', 0) > 0 and x.get('outcome')]
    round_anchor = None
    current = []
    if first.get('nextCursor') and not any(
            x.get('endedAtMs', since+1) < since and x.get('outcome') != 'running'
            for x in fresh):
        if not closed:
            raise ValueError('native rounds have no completed pagination anchor')
        boundary = closed[-1]
        round_anchor = boundary['roundId']
        current = fresh[fresh.index(boundary)+1:]
    rounds, cursor, round_digest = [], None, None
    for _ in range(100):
        args = ['session', 'rounds', sid, '--limit', '100']
        if round_anchor: args += ['--through-round', round_anchor]
        if cursor: args += ['--cursor', cursor]
        page = first if not round_anchor and cursor is None else call(*args)['page']
        digest = page['source']['digest']
        if round_digest is not None and digest != round_digest:
            raise ValueError('native rounds changed during bounded capture')
        round_digest = digest
        batch = page['rounds'];rounds.extend(batch)
        cursor = page.get('nextCursor')
        if not cursor or any(x.get('endedAtMs', since+1) < since and x.get('outcome') != 'running' for x in batch):
            break
    else:
        raise ValueError('native rounds pagination exceeded capture budget')
    rounds_complete = cursor is None
    rounds.extend(current)
    rounds.sort(key=lambda x: (x['startedAtMs'], x['roundId']))
    completed = [x for x in rounds if x.get('endedAtMs', 0) > 0 and x.get('outcome')]
    anchor = completed[-1]['roundId'] if completed else None
    turns, links, status_inputs, integration_items, cursor, digest = [], [], [], [], None, None
    narrative_complete = False
    if anchor:
        for _ in range(100):
            args = ['session', 'narrative', sid, '--through-round', anchor, '--limit', '100']
            if cursor:
                args += ['--cursor', cursor]
            page = call(*args)['page']
            source = page['source']
            if digest is not None and source['digest'] != digest:
                raise ValueError('native history changed during bounded capture')
            digest = source['digest']
            batch = [x['stats'] for x in page['items'] if x.get('type') == 'turnSummary']
            turns.extend(batch)
            for item in page['items']:
                if item.get('type') == 'assistantMessage':
                    from .quality_outcomes import integration_references
                    integration_items.extend(integration_references(item,rounds))
                    if len(integration_items)>4096: raise ValueError('bounded native integration history exceeded')
                if item.get('type') != 'userMessage': continue
                header, _, body = item.get('text','').partition('\n\n')
                ref=next((line[5:] for line in header.splitlines() if line.startswith('ref: ')),None)
                status_input=execution_status_input(team,sid,item,header,body,ref)
                if status_input is not None:
                    status_inputs.append(status_input)
                    if len(status_inputs)>4096: raise ValueError('bounded native execution status history exceeded')
                    continue
                if header.startswith('用途: result\n'):
                    if ref:links.append({'messageId':item['id'],'ref':ref,'sessionId':sid,'purpose':'result','receivedAtMs':item.get('receivedAtMs')})
            cursor = page.get('nextCursor')
            if not cursor or any(x.get('finishedAtMs', since+1) < since for x in batch):
                break
        else:
            raise ValueError('native narrative pagination exceeded capture budget')
        narrative_complete = cursor is None
    value = {'sessionId': sid, 'workspaceId':summary.get('workspaceId'), 'kernel': kernel, 'sinceAtMs': since,
             'updatedAtMs': summary.get('updatedAtMs'), 'createdAtMs': summary.get('createdAtMs'),
             'status': summary.get('status'), 'inputSummary': summary.get('inputSummary', {}),
             'waitingForUser': bool((summary.get('interactionSummary') or {}).get('requests')),
             'retainedInputs': inspection.get('retainedInputs'), 'rounds': rounds,
             'turns': list({x['turnId']: x for x in turns}.values()), 'inputLinks':links,'historyDigest': digest,
             'resultNotificationBasis':NOTIFICATION_BASIS, 'executionStatusInputs':status_inputs,
             'integrationReferenceBasis':'native-owner-use-reference/1','integrationReferences':integration_items,
             'historyCoverage': {'basis':'native-page-completion/2','roundsComplete':rounds_complete,
                                 'narrativeComplete':narrative_complete}}
    team.write_json(str(cache), value)
    return value


def union_intervals(intervals):
    out = []
    for a,b in sorted((a,b) for a,b in intervals if b > a):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a,b])
    return [{'startAtMs': a, 'endAtMs': b} for a,b in out]


def work_activity(samples, rounds, begin, stop):
    """Bound effective work by native execution and fresh pause/wait samples.

    An observation expires after the same 125s used for minute coverage.
    Missing spans stay unknown; a real Round overrides a stale pause sample.
    """
    if stop <= begin:
        return {'basis':'native-minute-and-rounds/1', 'active':[], 'excluded':[]}
    points = [x for x in samples if begin-125000 <= x['atMs'] < stop]
    busy = [(max(begin, x['startedAtMs']), min(stop, x['endedAtMs']
             if x.get('outcome') != 'running' and number(x.get('endedAtMs')) else stop))
            for x in rounds if number(x.get('startedAtMs')) and x['startedAtMs'] < stop]
    busy = [(a,b) for a,b in busy if b > a]
    boundaries = sorted({begin, stop, *[t for a,b in busy for t in (a,b)],
                         *[min(stop,max(begin,t)) for x in points for t in (x['atMs'],x['atMs']+125000)]})
    active, excluded = [], []
    for left,right in zip(boundaries,boundaries[1:]):
        if any(a <= left < b for a,b in busy):
            active.append((left,right))
            continue
        sample = next((x for x in reversed(points) if x['atMs'] <= left), None)
        if (sample is None or left >= sample['atMs']+125000 or
                type(sample.get('paused')) is not bool or type(sample.get('waitingForUser')) is not bool):
            continue
        (excluded if sample['paused'] or sample['waitingForUser'] else active).append((left,right))
    return {'basis':'native-minute-and-rounds/1', 'active':union_intervals(active),
            'excluded':union_intervals(excluded)}


def idle_periods(samples, rounds, children, begin, stop):
    """Sampled idle episodes split by actual execution or a live dependency."""
    busy = [(max(begin, x['startedAtMs']), min(stop, x['endedAtMs'] if number(x.get('endedAtMs')) else stop))
            for x in rounds if number(x.get('startedAtMs')) and x['startedAtMs'] < stop]
    busy += [(max(begin, x['dispatchAtMs']), min(stop, x['conclusionAtMs'] if number(x.get('conclusionAtMs')) else stop))
             for x in children if x['dispatchAtMs'] < stop]
    busy = [(a,b) for a,b in busy if b > a]
    points = [(x['atMs'], 1, x) for x in samples if begin <= x['atMs'] < stop]
    points += [(a, 0, None) for a,b in busy]
    periods, current, previous = [], None, None
    for at, kind, sample in sorted(points, key=lambda x:(x[0],x[1])):
        if sample is not None and previous is not None and at-previous > 125000:
            if current is not None:periods.append(current)
            current = None  # A gap is not a proven continuation or resolution.
        idle = sample is not None and sample.get('status')=='idle' and not sample.get('paused') and not sample.get('waitingForUser')
        idle = idle and not any(a <= at < b for a,b in busy)
        if idle:
            if current is None:current={'startAtMs':at,'observedThroughAtMs':at,'resolvedAtMs':None}
            current['observedThroughAtMs']=at
        else:
            if current is not None:periods.append(current);current=None
            for period in periods:
                if period['resolvedAtMs'] is None:period['resolvedAtMs']=at
        if sample is not None:previous=at
    if current is not None:periods.append(current)
    return periods


def replaced_idle_obligation(item, work, native, processes, end):
    """A read-in replacement ends observation, never the failed business item."""
    own = native.get(item.get('sessionId'), {})
    inputs = own.get('inputSummary') or {}
    rounds = own.get('rounds') or []
    latest = max(rounds, key=lambda x:x.get('startedAtMs', 0), default={})
    if (number(item.get('conclusionAtMs')) or item.get('owner')
            or own.get('status') not in ('idle', 'failed')
            or not inputs.get('paused') or not inputs.get('error')
            or latest.get('outcome') != 'failed'
            or not number(latest.get('endedAtMs'))
            or item.get('machine') not in processes
            or any(x.get('sessionId') == item.get('sessionId') for x in processes[item['machine']])):
        return None
    released = item.get('releasedAtMs')
    if item.get('resourceRequired') and (not number(released) or item.get('resourceHeld') is True):
        return None
    successors = [x for x in work if x.get('follows') == item['id']
                  and x.get('taskId') == item.get('taskId')
                  and x.get('requester') == item.get('requester')
                  and x.get('sessionId') != item.get('sessionId')
                  and x.get('outcome') == 'success'
                  and number(x.get('dispatchAtMs'))
                  and latest['endedAtMs'] <= x['dispatchAtMs']
                  and number(x.get('conclusionAtMs'))
                  and number(x.get('consumedAtMs'))
                  and x['conclusionAtMs'] <= x['consumedAtMs'] <= end]
    if not successors:
        return None
    successor = min(successors, key=lambda x:x['consumedAtMs'])
    at = max(successor['consumedAtMs'], released or 0, latest['endedAtMs'])
    if at > end:
        return None
    return {'basis':'native-read-in-successor/1', 'atMs':at,
            'successorOperationId':successor['id'], 'failedRoundId':latest.get('roundId')}


def event_failures(state, since, cutoff):
    """A failed ledger observation is not a missing native execution/receipt.

    Unknown legacy failure kinds retain conservative lifecycle coverage. A
    missing timestamp cannot establish a safe interval for negative evidence.
    """
    paths=sorted((Path(state)/'events/failures').glob('*'))
    if len(paths)>10000:raise ValueError('event failures exceed bounded capture')
    result=[]
    for path in paths:
        first=path.name.split('-')[0]
        at=int(first) if first.isdigit() else None
        if number(at) and not since <= at <= cutoff:continue
        try:
            value=read(path,maximum=8192)
            kind=value.get('kind') if isinstance(value,dict) else None
        except (OSError,ValueError,TypeError):kind=None
        result.append({'atMs':at,'kind':kind if isinstance(kind,str) else 'unknown',
                       'domain':'ledger' if kind in ('ledger-changed','ledger-observed','ledger-gap') else 'lifecycle'})
    return result


def wake_observations(native, machines, log, start, end, complete, failure_times, unplaced_gap=False):
    """Observe ledger increments, not the meaning or usefulness of a reply.

    Negative evidence requires uninterrupted instrumentation around the whole
    native execution. Old windows and clocks on other machines stay unknown.
    A delta is Team-wide temporal evidence, never causal/project acceptance.
    """
    basis = 'task-and-note-ledger/1'
    samples = sorted(x['atMs'] for x in log if x['kind']=='ledger-observed' and x.get('basis')==basis)
    changes = [x['atMs'] for x in log if x['kind']=='ledger-changed' and x.get('basis')==basis]
    gaps = failure_times + [x['atMs'] for x in log if x['kind']=='ledger-gap' and x.get('basis')==basis]
    result = []
    for sid, snapshot in native.items():
        receipts = {x['messageId']: x for x in snapshot.get('retainedInputs') or []}
        human_turns = {x['turnId'] for x in receipts.values() if x.get('source')=='user' and x.get('turnId')}
        for execution in snapshot.get('rounds', []):
            a, b = execution.get('startedAtMs'), execution.get('endedAtMs')
            if not number(a) or not number(b) or not a <= b or not start <= b < end:
                continue
            receipt = receipts.get(execution.get('userItemId'), {})
            if receipt.get('source')=='user' or receipt.get('turnId') in human_turns:
                continue
            known = None
            reason = 'native source, completed execution or continuous ledger observation missing'
            if (complete and receipt.get('source') in ('agent','system','workflow')
                    and execution.get('outcome') in ('completed','failed')):
                if machines.get(sid) is not None:
                    reason = 'remote execution clock is not a source-ledger clock'
                elif any(a <= at <= b for at in changes):
                    known = True
                else:
                    left = max((at for at in samples if at <= a), default=None)
                    right = min((at for at in samples if at >= b), default=None)
                    if not unplaced_gap and left is not None and right is not None:
                        covered = [at for at in samples if left <= at <= right]
                        if (a-left <= 125000 and right-b <= 125000
                                and all(y-x <= 125000 for x,y in zip(covered,covered[1:]))
                                and not any(a <= at <= b for at in gaps)):
                            known = False
            result.append({'sessionId':sid, 'roundId':execution['roundId'],
                           'messageId':execution.get('userItemId'), 'atMs':b,
                           'startedAtMs':a, 'ledgerChanged':known, 'basis':basis,
                           'reason':reason if known is None else None})
    return sorted(result,key=lambda x:(x['atMs'],x['sessionId'],x['roundId']))



def task_continuations(tasks, end):
    """Read preserved conclusion/control bounds without resetting unit origins.

    These are inactive goal periods, not proof that every support stopped.
    Keep them separate from user task pauses so actual Agent costs survive.
    The local task view also retains its true conclusion before a later resume.
    """
    periods={}
    for task_id,task in tasks.items():
        history=task.get('conclusionHistory',[])
        if not isinstance(history,list):raise ValueError('invalid task conclusion history')
        previous=[]
        for row in history:
            if not isinstance(row,dict):raise ValueError('invalid task conclusion history entry')
            conclusion=row.get('conclusion') or {};control=row.get('control') or {}
            if not isinstance(conclusion,dict) or not isinstance(control,dict):raise ValueError('invalid task continuation source')
            a,b=conclusion.get('atMs'),control.get('atMs')
            if (not number(a) or not number(b) or b<a
                    or control.get('action') not in ('resume','handover')):
                raise ValueError('unproven task conclusion continuation bounds')
            if a<=end<b:previous.append(conclusion)
            if b<=end and b>a:periods.setdefault(task_id,[]).append((a,b))
        if previous:task['finished']=max(previous,key=lambda x:x['atMs'])
    return periods


def task_trees(tasks, goal_tasks, controls, native, end, intents=(), log=(), conclusion_periods=None):
    """Root Owner plus every support, using task controls and native rounds.

    A task pause controls the goal wall; pausing one support only removes that
    Session's actual execution. No minute-state interpolation or conclusion
    requirement enters this measurement.
    """
    result=[]
    starts={x['sessionId']:x.get('createdAtMs') for x in intents if x.get('sessionId')}
    for task_id in sorted(goal_tasks):
        task=tasks[task_id]
        opened=task.get('createdAtMs')
        finished=(task.get('finished') or {}).get('atMs')
        if not number(opened) or opened >= end:continue
        stopped=min(end,finished) if number(finished) else end
        if stopped <= opened:continue
        changes=sorted([(opened,'active')]+[(x['atMs'],x['state']) for x in controls
                       if x.get('taskId')==task_id and opened <= x['atMs'] < stopped])
        excluded=[]
        for index,(at,state) in enumerate(changes):
            until=changes[index+1][0] if index+1 < len(changes) else stopped
            if state != 'active' and until > at:excluded.append((at,until))
        people=([task['owner']] if task.get('owner') else [])+task.get('collaborators',[])+task.get('previousOwners',[])
        sessions=[]
        for sid in sorted({x['sessionId'] for x in people if x.get('sessionId')}):
            own=native.get(sid)
            runs=[]
            if own:
                for row in own.get('rounds',[]):
                    a=row.get('startedAtMs')
                    b=stopped if row.get('outcome')=='running' else row.get('endedAtMs')
                    if number(a) and number(b) and min(b,stopped)>max(a,opened):
                        runs.append((max(a,opened),min(b,stopped)))
            joined=(own or {}).get('createdAtMs')
            if not number(joined):joined=starts.get(sid)
            from .background_jobs import intervals as job_intervals
            person=dict(sessionId=sid,readable=own is not None,
                        executionCoverageKnown=bool(own and ((own.get('historyCoverage') or {}).get('roundsComplete') is True
                            or number(own.get('sinceAtMs')) and own['sinceAtMs'] <= opened)),
                        runs=union_intervals(runs),
                        backgroundRuns=job_intervals(log,sid,task_id,stopped))
            if number(joined):person['openedAtMs']=joined
            sessions.append(person)
        result.append(dict(taskId=task_id,openedAtMs=opened,endedAtMs=stopped,
                           excluded=union_intervals(excluded),sessions=sessions,
                           concludedIntervals=union_intervals((conclusion_periods or {}).get(task_id,[]))))
    return result


def session_routes(team, intents, tasks, pending, end):
    """Creation identity outlives a rolling indicator sample.

    Only matching durable source receipts bind a Session to its machine. A
    later requester or current role membership does not relocate that Session.
    Conflicting creation receipts are unknown; never probe peers by Session ID.
    """
    routes, conflicts = {}, set()
    for intent in intents:
        request = intent.get('request') or {}
        sid, operation = intent.get('sessionId'), intent.get('operationId')
        created = intent.get('createdAtMs')
        if (not isinstance(sid, str) or not team.SESSION_ID.fullmatch(sid)
                or not operation or request.get('taskId') not in tasks
                or not number(created) or created >= end):
            continue
        binding = intent.get('pending') or pending.get(sid, {})
        if binding.get('sessionId') != sid or binding.get('operationId') != operation:
            continue
        machine = request.get('machine')
        remote = binding.get('remoteDispatch') or {}
        if machine:
            if (not isinstance(machine, str) or remote.get('id') != operation
                    or (remote.get('target') or {}).get('machineId') != machine):
                continue
        elif remote:
            continue
        else:
            machine = None
        if sid in routes and routes[sid] != machine:
            conflicts.add(sid)
        else:
            routes[sid] = machine
    return routes, conflicts


def capture(team, root, end, cutoff, budget_seconds=100, live=False):
    state = Path(root)/'.genethub/team'
    store = state/'quality'
    start = end-HOUR
    metric_start = end-24*HOUR
    from .quality_epoch import context as epoch_context
    lifecycle = epoch_context(root, end)
    before = template_digest()
    from .template_version import capture as running_version
    version_before = running_version(root, cutoff)
    log = events(root, cutoff)
    tasks = {v['taskId']: v for v in records(state/'tasks')}
    conclusion_periods = task_continuations(tasks,end)
    intents = records(state/'task-dispatch')
    pending = {v['sessionId']: v for area in ['pending', 'done'] for v in records(state/area)}
    issues, work, wanted = [], [], {}
    budget = time.monotonic()+budget_seconds
    def capture_call(*args):
        remaining=budget-time.monotonic()
        if remaining<=0:raise TimeoutError("quality capture budget exhausted")
        return team.genet(*args,timeout=min(15,max(0.1,remaining)))
    root_workspaces = set()
    try:
        catalog=capture_call('workspace','list')['workspaces']
        root_workspaces={w['id'] for w in catalog if isinstance(w.get('root'),str) and Path(w['root']).resolve()==Path(root).resolve()}
        if not root_workspaces:raise ValueError('Team root workspace unavailable')
    except Exception as error:
        issues.append({'kind':'goal-workspace-unavailable','error':type(error).__name__})
    controls = [v for v in log if v['kind']=='control']
    observed = [v for v in log if v['kind']=='session-observed']
    by_operation = {}
    for event in log:
        by_operation.setdefault(event.get('operationId'), []).append(event)
    goals, metric_goals, stalls, observed_complete = [], [], [], True
    for task in tasks.values():
        owner = task.get('owner') or {}
        sid = owner.get('sessionId')
        created = task.get('createdAtMs')
        finished = (task.get('finished') or {}).get('atMs')
        if sid and number(created) and created < end:
            metric_goals.append((task['taskId'],max(metric_start, created), min(end, finished if number(finished) else end)))
        if not sid or not number(created) or created >= end or number(finished) and finished < start:
            continue
        a,b = max(start, created), min(end, finished if number(finished) else end)
        points = sorted([x for x in observed if x.get('sessionId')==sid and x['atMs'] <= b+60000], key=lambda x:x['atMs'])
        relevant_points = [x for x in points if x['atMs'] >= a-60000]
        complete = bool(relevant_points) and relevant_points[0]['atMs'] <= a+60000 and relevant_points[-1]['atMs'] >= b-60000
        complete = complete and all(y['atMs']-x['atMs'] <= 125000 for x,y in zip(relevant_points,relevant_points[1:]))
        observed_complete = observed_complete and complete
        # Integrate observed task control and native wait/pause segments, then
        # union goals so concurrent goals cannot multiply the denominator.
        changes = sorted([(created, 'active')]+[(x['atMs'], x['state']) for x in controls if x.get('taskId')==task['taskId']]
                         +[(at,state) for a,b in conclusion_periods.get(task['taskId'],[]) for at,state in ((a,'concluded'),(b,'active'))])
        boundaries = sorted({a,b,*[min(b,max(a,t)) for t,_ in changes],*[min(b,max(a,x['atMs'])) for x in relevant_points]})
        for left,right in zip(boundaries,boundaries[1:]):
            status = next((s for t,s in reversed(changes) if t <= left), 'active')
            native = next((x for x in reversed(points) if x['atMs'] <= left), {})
            if status=='active' and not native.get('paused') and not native.get('waitingForUser'):
                goals.append((task['taskId'],left,right))
        wanted[task['front']] = None
    for intent in intents:
        request = intent.get('request') or {}
        task = tasks.get(request.get('taskId'))
        if not task:
            issues.append({'kind':'missing-task', 'operationId':intent.get('operationId')});continue
        sid = intent.get('sessionId')
        owner = (task.get('owner') or {}).get('sessionId') == sid and bool(sid)
        person = next((x for x in task.get('collaborators', []) if x.get('sessionId')==sid), {})
        conclusion = task.get('finished') if owner else person.get('finished')
        concluded = (conclusion or {}).get('atMs')
        rec = pending.get(sid, {})
        if rec.get('operationId') != intent['operationId']:rec = {}
        resource_required=bool(intent.get('resourceBinding') or request.get('machine') or rec.get('remoteDispatch'))
        legacy_released=resource_required and (not intent.get('resourceBinding') or intent.get('resourceReleased') is True) and (
            not (request.get('machine') or rec.get('remoteDispatch')) or rec.get('remoteReleased') is True)
        if number(concluded) and concluded < metric_start and (not resource_required or legacy_released):
            continue
        dispatched = intent.get('createdAtMs')
        if not number(dispatched) or dispatched >= end:
            continue
        rows = by_operation.get(intent['operationId'], [])
        confirmed = next((x['atMs'] for x in rows if x['kind']=='dispatch-confirmed'), None)
        activation = intent['operationId']
        if request.get('machine'):
            # receive(activate) uses a distinct, stable wire message ID. Bind
            # it to this operation's durable prepare receipt, never another
            # input merely because it ran in the same remote session.
            binding = intent.get('pending') or rec
            remote = binding.get('remoteDispatch') or {}
            activation = ('activate.'+hashlib.sha256(remote['id'].encode()).hexdigest()
                          if binding.get('sessionId') == sid and remote.get('id') == intent['operationId'] else None)
        item = {'id':intent['operationId'], 'taskId':task['taskId'], 'sessionId':sid,
                'activationMessageId':activation,
                'requester':request.get('requester'), 'role':request.get('role'), 'owner':owner,
                'machine':request.get('machine'), 'dispatchAtMs':dispatched, 'confirmedAtMs':confirmed,
                'hasReceipt':bool(sid), 'standing':bool(request.get('standing')), 'follows':request.get('follows'),
                'conclusionAtMs':concluded if number(concluded) and concluded <= cutoff else None,
                'outcome':(conclusion or {}).get('outcome'),
                'resourceRequired':resource_required, 'legacyReleaseStateKnown':legacy_released,
                'withdrawnAtMs':intent.get('withdrawnAtMs') if intent.get('state')=='withdrawn' else None}
        if request.get('acceptanceUnit'):
            item['acceptanceUnit'] = request['acceptanceUnit']
        audience = result_audience(team, item, rec)
        if audience is not None:
            item['deliveryAudience'] = audience
            # A source acceptance event alone cannot establish a native receipt.
            # Observe each declared local watcher through the same public API.
            for watcher in audience['watchers']:
                wanted.setdefault(watcher, None)
        release = next((x for x in rows if x['kind']=='resource-released'), None)
        lease = next((x for x in rows if x['kind']=='lease-released' and x.get('timeBasis')=='executor-unlink'), None)
        if release: item['releasedAtMs']=release['atMs'];item['releaseTimeBasis']='verified-release'
        else:
            bound=next((x for x in rows if x['kind']=='resource-release-observed'
                        and x.get('sessionId')==sid and x.get('timeBasis')=='observed-absence-upper-bound'
                        and x.get('proof')=='remote-ack-idle-process-check'), None)
            if bound:
                item['releasedAtMs']=bound['atMs'];item['releaseTimeBasis']='observed-absence-upper-bound'
        if lease: item['leaseReleasedAtMs']=lease['atMs']
        if sid: wanted[sid]=request.get('machine')
        if request.get('requester') and request['requester'] not in wanted: wanted[request['requester']]=None
        work.append(item)
    reflect_ids = {sid for sid, record in pending.items()
                   if record.get('kind') in ('reflect','team-reflect')
                   and number(record.get('createdAtMs')) and record['createdAtMs'] >= metric_start}
    for sid in reflect_ids:
        wanted.setdefault(sid, pending[sid].get('machine'))
    # Metric windows filter indicators, not the evidence needed to establish a
    # still-relevant operation's first activation or a Task tree's cumulative
    # Agent work. Keep the earliest necessary source-owned history boundary.
    history_starts = {}
    for item in work:
        if item.get('sessionId') and number(item.get('dispatchAtMs')):
            sid = item['sessionId']
            history_starts[sid] = min(history_starts.get(sid, metric_start), item['dispatchAtMs'])
    # A conclusion outside the metric horizon drops that cost/adoption sample,
    # not its native membership in a root task still spanning this card. An
    # epoch advance must not turn a readable finished support into unknown R6.
    for task in tasks.values():
        finished=(task.get('finished') or {}).get('atMs')
        if not number(task.get('createdAtMs')) or task['createdAtMs']>=end or number(finished) and finished<=start:
            continue
        people=([task['owner']] if task.get('owner') else [])+task.get('collaborators',[])+task.get('previousOwners',[])
        for person in people:
            if person.get('sessionId'):
                sid = person['sessionId']
                wanted.setdefault(sid, person.get('machine'))
                history_starts[sid] = min(history_starts.get(sid, metric_start), task['createdAtMs'])
    # Filter samples above, then resolve only still-needed Session identities
    # from all original receipts, including completed contributions outside24h.
    routes, conflicts = session_routes(team, intents, tasks, pending, end)
    for sid in list(wanted):
        if sid in conflicts:
            issues.append({'kind':'native-route-conflict', 'sessionId':sid})
            del wanted[sid]  # Neither a peer nor a cached history can settle it.
        elif sid in routes:
            wanted[sid] = routes[sid]
    from .scoring_integrity import capture as integrity_capture, combine as integrity_combine, BASIS as INTEGRITY_BASIS
    integrity_before = integrity_capture(root, None)
    integrity_reference = None
    native, platforms, processes = {}, {}, {}
    for machine in sorted(set(wanted.values()) | {None},key=lambda x:x or ""):
        try:
            context=capture_call('context',*team.machine_args(machine))
            ctx=context['daemon']
            if machine is None:
                integrity_reference = context.get('teamScoringManifest')
                integrity_before = integrity_capture(root, integrity_reference)
            platforms[machine]={'version':ctx['version'],'machineId':ctx['machineId']}
            processes[machine]=capture_call('process','list',*team.machine_args(machine))['processes']
        except Exception as error:
            issues.append(read_issue('machine-facts-unavailable', error, budget, machine=machine))
    headers = native_headers(team, wanted, platforms, store, budget)
    order=list(wanted.items())
    if live:
        active={x["sessionId"] for x in records(state/"pending") if x.get("sessionId")}
        critical=active|{i["requester"] for i in work if i.get("sessionId") in active and i.get("requester")}
        order.sort(key=lambda x:(x[0] not in critical,(store/"native"/(x[0]+".json")).exists()))
    for sid,machine in order:
        try:
            if not team.SESSION_ID.fullmatch(sid): raise ValueError('invalid native session identity')
            native[sid]=native_snapshot(team,sid,machine,history_starts.get(sid,metric_start),platforms.get(machine),store/'native'/ (sid+'.json'),budget,headers.get((machine,sid)))
        except Exception as error:
            issues.append(read_issue('native-read-unavailable', error, budget, sessionId=sid))
    # Tasks begun inside roles are work, but cannot by themselves manufacture
    # a loaded user-goal hour. Use public root/initiator ownership, not wording
    # or a mandatory new goal form. Unknown native ownership stays unknown.
    goal_tasks={task['taskId'] for task in tasks.values()
                if native.get(task.get('front'),{}).get('workspaceId') in root_workspaces}
    goal_ownership_known=bool(root_workspaces) and all(native.get(task.get('front'),{}).get('workspaceId')
        for task in tasks.values() if number(task.get('createdAtMs')) and task['createdAtMs'] < end
        and (not number((task.get('finished') or {}).get('atMs')) or task['finished']['atMs'] >= metric_start))
    delivery_map = {(x['sessionId'],x['messageId']):dict(x) for x in log
                    if x['kind']=='input-accepted' and x.get('purpose')=='result'}
    for snapshot in native.values():
        for link in snapshot.get('inputLinks',[]):
            key=(link['sessionId'],link['messageId'])
            event=delivery_map.get(key,{})
            merged=dict(event,**link)
            # The genuine native header corroborates the earlier successful
            # send observation. It proves an upper bound, never an exact ACK
            # or read time. Neither source alone establishes this bound.
            if (event.get('timeBasis')=='observed-acceptance' and number(event.get('atMs'))
                    and event.get('ref')==link.get('ref')):
                merged['acceptedUpperBoundMs']=event['atMs']
            delivery_map[key]=merged
    execution_statuses = []
    for recipient, snapshot in native.items():
        for notice in snapshot.get('executionStatusInputs', []):
            key = (recipient, notice['messageId'])
            event = delivery_map.get(key, {})
            receipt = next((x for x in snapshot.get('retainedInputs') or []
                            if x['messageId'] == notice['messageId']), {})
            received = receipt.get('receivedAtMs') or notice.get('receivedAtMs')
            if number(received) and received > cutoff:
                continue
            delivery_map.pop(key, None)
            proof = dict(notice, receivedAtMs=received)
            if (not number(received) and event.get('timeBasis') == 'observed-acceptance'
                    and event.get('ref') == notice['ref'] and number(event.get('atMs'))):
                proof['acceptedUpperBoundMs'] = event['atMs']
            execution_statuses.append(proof)
    deliveries = list(delivery_map.values())
    reworked = {i['follows'] for i in work if i.get('follows')}
    resources_complete, idle_complete = True, True
    for item in work:
        own=native.get(item['sessionId'], {})
        stop=min(end,item['conclusionAtMs']) if number(item.get('conclusionAtMs')) else end
        samples=sorted([x for x in observed if x.get('sessionId')==item['sessionId'] and x['atMs'] < stop],key=lambda x:x['atMs'])
        receipts=own.get('retainedInputs')
        activation=item['activationMessageId']
        incoming=next((x for x in receipts or [] if activation and x['messageId']==activation), {})
        # A resumed input can have several executions. Its earliest genuine
        # Round is the start; later delivery/restart metadata cannot move it.
        begun=min((x['startedAtMs'] for x in own.get('rounds',[])
                   if activation and x.get('userItemId')==activation and number(x.get('startedAtMs'))), default=None)
        if not number(begun):
            begun=incoming.get('deliveredAtMs')
        item['startedAtMs']=begun if number(begun) and begun <= cutoff else None
        from .execution_facts import dispatch_timing
        item['dispatchTiming'] = dispatch_timing(item,incoming,by_operation.get(item['id'],[]))
        if number(item['startedAtMs']):
            item['workActivity']=work_activity(samples,own.get('rounds',[]),max(start,begun),stop)
        if item['confirmedAtMs'] is None and number(begun) and begun < start:
            item['confirmedAtMs']=begun  # acknowledged no later than actual activation, before this window
        matching=[x for x in deliveries if item.get('sessionId') and any(
            ref.strip().startswith('ghref:item:'+item['sessionId']+':')
            or ref.strip()=='ghref:session:'+item['sessionId'] for ref in (x.get('ref') or '').split(','))]
        def accepted_at(delivery):
            return next((x['receivedAtMs'] for x in native.get(delivery['sessionId'],{}).get('retainedInputs') or [] if x['messageId']==delivery['messageId']), delivery.get('receivedAtMs'))
        proven=[x for x in matching if number(accepted_at(x)) and accepted_at(x)<=cutoff]
        proven.sort(key=lambda x:(accepted_at(x),x['messageId']))
        bounded=[x for x in matching if not number(accepted_at(x))
                 and number(x.get('acceptedUpperBoundMs')) and x['acceptedUpperBoundMs']<=cutoff]
        item['deliveryBounds']=[{'messageId':x['messageId'],'recipient':x['sessionId'],
                                'acceptedUpperBoundMs':x['acceptedUpperBoundMs'], 'ref':x.get('ref')} for x in bounded]
        item['deliveryMessageIds']=sorted({x['messageId'] for x in proven+bounded})
        item['deliveryEvents']=[{'messageId':x['messageId'],'recipient':x['sessionId'],'acceptedAtMs':accepted_at(x),
                                'ref':x.get('ref')} for x in proven]
        correct=[x for x in proven if x['sessionId']==item.get('requester')]
        if proven:item['recipient']=proven[0]['sessionId']
        if correct:
            delivered=correct[0];item['recipient']=delivered['sessionId']
            target=native.get(delivered['sessionId'], {})
            receipt=next((x for x in target.get('retainedInputs') or [] if x['messageId']==delivered['messageId']), {})
            item['deliveredAtMs']=receipt.get('receivedAtMs') or delivered.get('receivedAtMs')
            item['consumedAtMs']=receipt.get('deliveredAtMs')
            if item['consumedAtMs'] is None:
                item['consumedAtMs']=next((x['startedAtMs'] for x in target.get('rounds',[]) if x.get('userItemId')==delivered['messageId']),None)
            for field in ('deliveredAtMs','consumedAtMs'):
                if number(item.get(field)) and item[field] > cutoff:item[field]=None
        # Retention is bounded. A missing old receipt/header cannot establish
        # non-delivery, nor clear that red line as though it were observed.
        item['deliveryCoverageKnown'] = bool(proven or bounded) and len(proven)+len(bounded)==len(matching)
        if any(x['sessionId']==item.get('requester') for x in bounded):
            # A later exact receipt cannot establish the first delivery/read
            # when an earlier possible correct delivery lost its timestamp.
            item['recipient']=item['requester']
            item['deliveredAtMs']=None;item['consumedAtMs']=None
        consumed=item.get('consumedAtMs')
        item['disposition']='rework' if item['id'] in reworked else ('adopted-inferred' if number(consumed) and consumed+600000 <= cutoff else None)
        turns=[x for x in own.get('turns',[]) if x.get('finishedAtMs',cutoff+1) <= cutoff]
        if own and number(item.get('conclusionAtMs')) and own.get('status')=='idle':
            item['executionMs']=sum(x['durationMs'] for x in turns if number(x.get('durationMs')))
        held=[x for x in processes.get(item['machine'], []) if x.get('sessionId')==item['sessionId']]
        if held:
            # Native Agent runtimes can outlive a concluded task without ever
            # acquiring a writer/remote lease. Presence proves holding only
            # when dispatch/binding independently established the obligation.
            if item['resourceRequired']:item['resourceHeld']=True
        elif item['machine'] in processes and own.get('status') in ('idle','failed') and number(item.get('conclusionAtMs')):
            check=store/'resource-checks'/(item['id']+'.json')
            first=read(check) or {'firstAbsentAtMs':team.now_ms()}
            team.write_json(str(check),first)
            lease=item.get('leaseReleasedAtMs')
            # A legacy durable released flag proves state, never its old time.
            # Start a separate upper bound only when both that state and actual
            # process absence have been observed; an earlier absence sample
            # taken while the lease was unproven cannot backdate this bound.
            legacy_bound=None
            if item.get('legacyReleaseStateKnown'):
                if not number(first.get('legacyReleaseObservedAtMs')):
                    first['legacyReleaseObservedAtMs']=team.now_ms()
                    team.write_json(str(check),first)
                legacy_bound=first['legacyReleaseObservedAtMs']
            if item.get('releaseTimeBasis') != 'verified-release' and (not item['resourceRequired'] or number(lease) or number(legacy_bound)):
                current_bound=max(lease or 0,legacy_bound or first['firstAbsentAtMs'])
                prior_bound=item.get('releasedAtMs')
                item['releasedAtMs']=min(prior_bound,current_bound) if number(prior_bound) else current_bound
                item['releaseTimeBasis']='observed-absence-upper-bound'
                if item['resourceRequired'] and item['conclusionAtMs']+600000 < min(end,item['releasedAtMs']) and item['releasedAtMs'] >= start:
                    resources_complete=False
        if item['resourceRequired'] and number(item.get('conclusionAtMs')) and item['conclusionAtMs']+600000 < end and not held and not number(item.get('releasedAtMs')):
            resources_complete=False
    # Read-in and resource proof must be enriched for every operation first:
    # dispatch filename order does not order a failed item and its successor.
    # This boundary affects R2 only; work activity, failures and conclusions
    # retain their independent native histories.
    for item in work:
        own=native.get(item['sessionId'], {})
        replacement=replaced_idle_obligation(item,work,native,processes,end)
        if replacement:item['idleObligationEnd']=replacement
        terminal=item.get('conclusionAtMs')
        if replacement:terminal=replacement['atMs']
        stop=min(end,terminal) if number(terminal) else end
        samples=sorted([x for x in observed if x.get('sessionId')==item['sessionId'] and x['atMs'] < stop],key=lambda x:x['atMs'])
        children=[x for x in work if x['requester']==item['sessionId']]
        item['idlePeriods']=idle_periods(samples,own.get('rounds',[]),children,max(metric_start,item['dispatchAtMs']),stop)
        if number(terminal) and terminal <= end:
            for period in item['idlePeriods']:
                if period['resolvedAtMs'] is None:period['resolvedAtMs']=terminal
        if not item['standing'] and item['hasReceipt'] and stop > start and stop-item['dispatchAtMs'] > HOUR:
            left=max(item['dispatchAtMs'],start-HOUR)
            recent=[x for x in samples if x['atMs'] >= left-60000]
            covered=bool(recent) and recent[0]['atMs'] <= left+60000 and recent[-1]['atMs']+125000 >= stop
            covered=covered and all(b['atMs']-a['atMs'] <= 125000 for a,b in zip(recent,recent[1:]))
            idle_complete=idle_complete and covered
    # Idle gaps belong to an unfinished Owner with no live children. Minute
    # observations are required for coverage; an absent sample is not health.
    for task in tasks.values():
        sid=(task.get('owner') or {}).get('sessionId')
        finished=(task.get('finished') or {}).get('atMs')
        points=sorted([x for x in observed if x.get('sessionId')==sid and x['atMs'] < end and (not number(finished) or x['atMs'] < finished)],key=lambda x:x['atMs'])
        busy=[(x['startedAtMs'],x['endedAtMs'] if x.get('outcome')!='running' else end)
              for x in native.get(sid,{}).get('rounds',[])]
        run=None
        previous=None
        for point in points:
            # Short real rounds between two idle samples break the idle run;
            # minute sampling must not bridge actual work into a false stall.
            interrupted = previous is not None and any(a < point['atMs'] and b > previous for a,b in busy)
            if previous is not None and (point['atMs']-previous > 125000 or interrupted):
                if run is not None:stalls.append({'taskId':task['taskId'],'startAtMs':run,'endAtMs':previous})
                run=None
            previous=point['atMs']
            children=any(i['requester']==sid and i['dispatchAtMs'] <= point['atMs'] and (not number(i['conclusionAtMs']) or i['conclusionAtMs'] > point['atMs']) for i in work)
            stalled=point.get('status')=='idle' and not point.get('paused') and not point.get('waitingForUser') and not children
            if stalled and run is None:run=point['atMs']
            if not stalled and run is not None:
                stalls.append({'taskId':task['taskId'],'startAtMs':run,'endAtMs':point['atMs']});run=None
        if run is not None:stalls.append({'taskId':task['taskId'],'startAtMs':run,'endAtMs':min(end,finished or end,previous or end)})
    all_inputs,all_turns=[],[]
    fronts={x.get('front') for x in tasks.values()}
    for sid,session in native.items():
        for receipt in session.get('retainedInputs') or []:
            if receipt['receivedAtMs'] <= cutoff:
                row=dict(receipt,sessionId=sid)
                if row.get('deliveredAtMs') is None:
                    row['deliveredAtMs']=next((x['startedAtMs'] for x in session.get('rounds',[]) if x.get('userItemId')==row['messageId']),None)
                if row.get('source')=='user':
                    # Unsolicited Human input cannot be guessed from wording.
                    # A native source fact plus a task mutation in its round
                    # establishes a product request; other cases stay unknown.
                    read_at=row.get('deliveredAtMs')
                    turn=next((x for x in session.get('turns',[]) if x['turnId']==row.get('turnId')), {})
                    mutation=any(x.get('front')==sid and number(x.get('createdAtMs')) and number(turn.get('startedAtMs')) and number(turn.get('finishedAtMs')) and turn['startedAtMs'] <= x['createdAtMs'] <= turn['finishedAtMs'] for x in tasks.values())
                    row['unsolicited']=False if mutation else None
                all_inputs.append(row)
        for turn in session.get('turns',[]):
            all_turns.append(dict(turn,sessionId=sid,coordination=sid in fronts or sid in reflect_ids or any(i['sessionId']==sid and i['role'] in ('reflect','team-reflect') for i in work)))
    failures=event_failures(state,metric_start,cutoff)
    failure_times=[x['atMs'] for x in failures if number(x['atMs'])]
    unplaced_gap=any(not number(x['atMs']) for x in failures)
    lifecycle_failures=[x for x in failures if x['domain']=='lifecycle']
    lifecycle_clean=not any(not number(x['atMs']) or start <= x['atMs'] <= cutoff for x in lifecycle_failures)
    native_complete=not issues and before==template_digest()
    complete=native_complete and lifecycle_clean
    wakes = wake_observations(native, wanted, log, metric_start, end, native_complete, failure_times,unplaced_gap)
    baseline=read(store/'baseline.json',{})
    from .quality_attribution import context as attribution_context
    attribution = attribution_context(hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                                      hashlib.sha256(Path(team.__file__).read_bytes()).hexdigest())
    team_version = running_version(root, cutoff)
    if team_version.get('id') != version_before.get('id'):
        team_version.update(id=None,releaseVersion=None,status='changed-during-capture')
    trees = task_trees(tasks,goal_tasks,controls,native,end,intents,log,conclusion_periods=conclusion_periods)
    # A resumed goal's old concluded interval is not an idle stall. Existing
    # input/resource obligations remain work facts and are not erased here.
    from .task_hours import subtract
    active_stalls=[]
    for row in stalls:
        inactive=conclusion_periods.get(row.get('taskId'),[])
        if not inactive or not number(row.get('startAtMs')) or not number(row.get('endAtMs')) or row['endAtMs']<=row['startAtMs']:
            active_stalls.append(row);continue
        active_stalls.extend(dict(row,startAtMs=a,endAtMs=b)
                             for a,b in subtract([(row['startAtMs'],row['endAtMs'])],inactive))
    stalls=active_stalls
    from .acceptance_units import collect as collect_units, BASIS as UNIT_BASIS
    from .execution_facts import SCORE_BASIS as EXECUTION_BASIS
    units = collect_units(tasks,intents,work,trees,native,end)
    from .quality_outcomes import adoption, comparison, ADOPTION_BASIS, COST_BASIS, costs, baseline as unit_baseline
    adoption(work,tasks,log,native,cutoff)
    by_op={x['operationId']:x for x in intents}
    for unit in units:
        unit['costComparison']=comparison(by_op.get(unit['unitId'],{}).get('request',{}))
    facts = {'schema':'team-quality-facts/1','scoringModel':'tq/2','resourceObligationBasis':'dispatch-resource-obligation/2','evidenceCoverageBasis':'per-source-failure-domain/1','resultAudienceBasis':'source-result-generation/2','idleObservationBasis':'native-minute-freshness/2','attributionContext':attribution,'taskTrees':trees,
            'executionStatusNotifications':execution_statuses,
            'acceptanceUnits':units,'acceptanceUnitBasis':UNIT_BASIS,'executionBasis':EXECUTION_BASIS,
            'executionFacts':{'schema':'team-execution-facts/2','scoreMeaningChanged':True,
                              'backgroundBasis':'registered-native-process-runtime/1',
                              'backgroundRunsAppliedToScore':True,
                              'note':'Versioned formal per-Session union for R6 and R4; old snapshots keep their own basis'},
            'taskTreesSourceComplete':goal_ownership_known,'taskHoursBasis':'task-controls-and-native-rounds/1','r6Basis':R6_BASIS,'team':Path(root).name,'window':{'startAtMs':start,'endAtMs':end},
            'capturedAtMs':cutoff,'measurementWindow':{'startAtMs':metric_start,'endAtMs':end},'redlineLifecycle':lifecycle,
            'measurementGoalIntervals':[{'startAtMs':a,'endAtMs':b} for task_id,a,b in metric_goals if task_id in goal_tasks and b>a],
            'goalBasis':{'kind':'root-front-task','workspaceIds':sorted(root_workspaces),'taskIds':sorted(goal_tasks)},
            'workItems':work,'goalIntervals':union_intervals([(a,b) for task_id,a,b in goals if task_id in goal_tasks]),'stalls':stalls,
            'inputs':all_inputs,'turns':all_turns,'wakes':wakes,'failures':[],'baseline':baseline,
            'evidenceCoverage':{'schema':'team-evidence-coverage/1','nativeComplete':native_complete,
                                'lifecycleEventsComplete':lifecycle_clean,'failureCount':len(failures),
                                'ledgerGapTimes':failure_times,'unplacedGap':unplaced_gap},
            'wakeCoverage':{'basis':'native-nonhuman-rounds-task-ledger/1',
                            'known':sum(type(x['ledgerChanged']) is bool for x in wakes),
                            'unknown':sum(x['ledgerChanged'] is None for x in wakes)},
            'coverage':{'dispatches':complete and all(i['hasReceipt'] is False or number(i.get('confirmedAtMs')) for i in work),
                        'starts':complete and all(not i['hasReceipt'] or number(i.get('startedAtMs')) for i in work),
                        'deliveries':complete and all(s.get('retainedInputs') is not None for s in native.values()) and all(i['deliveryCoverageKnown'] for i in work if number(i.get('conclusionAtMs')) and i['conclusionAtMs'] < end),
                        'observations':complete and observed_complete,'idleObligations':complete and idle_complete,
                        'goals':complete and observed_complete and goal_ownership_known,
                        'resources':complete and resources_complete,'turns':native_complete,'inputs':native_complete and all(s.get('retainedInputs') is not None and all(x.get('source') in ('user','agent','system','workflow') for x in s['retainedInputs']) for s in native.values())},
            'versions':{'nativeHistoryBasis':'task-obligation-and-metric-horizons/1','platformAtCapture':[dict(selector=k,**v) for k,v in sorted(platforms.items(),key=lambda x:x[0] or '')],
                        'teamTemplate':team_version,
                        'templateAtCapture':before,'eventTemplates':sorted({x['templateSha256'] for x in log if x.get('templateSha256') and start <= x['atMs'] < end})},
            'issues':issues,'observationBasis':'native minute state samples; explicit controls and native handoff timestamps'}
    facts.update(adoptionBasis=ADOPTION_BASIS,costBasis=COST_BASIS)
    # The native reference is immutable kernel bytes observed at capture start.
    # Re-read local dependencies after collection without spending a second
    # native call at the end of the live capture budget.
    facts.update(scoringIntegrityBasis=INTEGRITY_BASIS,
                 scoringIntegrity=integrity_combine(integrity_before, integrity_capture(root, integrity_reference)))
    from .execution_facts import project
    facts['unitCosts']=costs(project(facts))
    cost_path=store/'baselines'/'complete-acceptance-unit-time-v1.json'
    prior=read(cost_path,{})
    facts['costBaselines']=unit_baseline(facts['unitCosts'],prior,cutoff)
    if facts['costBaselines'] != prior and facts['costBaselines']['groups']:
        with team.inbox_lock(root,'quality-unit-time-baseline',purpose='冻结单元时间基线'):
            latest=read(cost_path,{})
            facts['costBaselines']=unit_baseline(facts['unitCosts'],latest,cutoff)
            if facts['costBaselines'] != latest:
                team.write_json(str(cost_path),facts['costBaselines'])
    return facts


def register(sub):
    p=sub.add_parser('quality',help='deterministic work-quality facts, cards and history; never controls work')
    a=p.add_subparsers(dest='quality_action',required=True)
    a.add_parser('tick')
    c=a.add_parser('card');c.add_argument('--snapshot');c.add_argument('--save',action='store_true')
    c=a.add_parser('execution',help='read-only versioned dispatch/background-work projection; never saves a quality card')
    c.add_argument('--snapshot',required=True)
    a.add_parser('history');a.add_parser('describe');a.add_parser('facts')
    c=a.add_parser('alerts',help='current open redlines or read-only external alert replay');c.add_argument('--snapshot')
    c=a.add_parser('triage',help='optional correction note when automatic redline attribution is wrong');c.add_argument('incident')
    c.add_argument('--attribution',required=True,choices=['team','platform-template','kernel','provider','unknown'])
    c.add_argument('--evidence',required=True)


def _command(team,args):
    root=team.find_root();store=Path(root)/'.genethub/team/quality'
    action=args.quality_action
    if action in ('alerts','triage'):
        from . import quality_live
        value=(quality_live.replay(read(Path(args.snapshot))) if args.snapshot else quality_live.current(root)) if action=='alerts' else (
            quality_live.triage(team,root,args))
        print(canonical(value),end='');return
    if action=='execution':
        from .execution_facts import view
        print(canonical(view(read(Path(args.snapshot)))),end='');return
    if action=='describe':
        from .quality_score import WEIGHTS,INDICATORS
        print(canonical({'model':'tq/2','supportedModels':['tq/1','tq/2'],'r6':r6_policy(),'weights':WEIGHTS,'indicators':INDICATORS,'redLines':['R1','R2','R3','R4','R5','R6','R7'],'scoringIntegrityBasis':'native-embedded-team-scoring/1',
                         'formal':{'knownWeightPct':80,'closedWorkItems':20,'allRedLinesDecidable':True},'window':'red lines: previous complete UTC hour native facts only; indicators: rolling 24h','adoptionBasis':'native-owner-use-reference/1','costBasis':'complete-acceptance-unit-time/1','inference':'read and ten-minute inference are not confirmed adoption; optional task finish --uses gives bounded integration evidence'}),end='');return
    if action=='history':
        latest={}
        revisions={}
        for path in sorted((store/'cards').glob('*.json')):
            value=read(path);hour=value['window']['endAtMs'];revisions[hour]=revisions.get(hour,0)+1
            if hour not in latest or value['capturedAtMs'] > latest[hour]['capturedAtMs']:latest[hour]=value
        print(canonical({'cards':[latest[k] for k in sorted(latest)],'revisionCounts':revisions,'lastError':read(store/'last-error.json')}),end='');return
    if action=='facts':
        now=team.now_ms();value=capture(team,root,now,now);value['captureKind']='diagnostic'
        print(canonical(value),end='');return
    if action=='tick':
        gate=team.inbox_lock(root,'quality-capture',purpose='质量事实采集')
        try:gate.__enter__()
        except team.ExpertError:
            print(canonical({'status':'busy','cardProduced':False}),end='');return
        try:
            cutoff=team.now_ms();offset=[0,1,0,2][cutoff//300000 % 4];end=(cutoff//HOUR-offset)*HOUR
            facts=capture(team,root,end,cutoff);facts['captureKind']='native-hour'
            from .quality_live import current
            live=current(root)
            facts['warnings']=live['warnings']
            facts['liveWarningsAsOfMs']=live['asOfMs']
            encoded=canonical(facts);key=str(end)+'-'+hashlib.sha256(encoded.encode()).hexdigest()
            target=store/'snapshots'/(key+'.json');target.parent.mkdir(parents=True,exist_ok=True)
            if not target.exists():team.write_json(str(target),facts)
            card=score(facts)
            card_path=store/'cards'/(key+'.json');card_path.parent.mkdir(parents=True,exist_ok=True)
            if not card_path.exists():_write_card(team,root,card_path,card)
            prior=read(store/'latest.json')
            previous=read(Path(root)/prior['card']) if prior else None
            if previous is None or previous['window']['endAtMs'] <= end:
                team.write_json(str(store/'latest.json'),{'card':str(card_path.relative_to(Path(root))), 'snapshot':str(target.relative_to(Path(root)))})
            print(canonical({'card':str(card_path),'formal':card['formal'],'score':card['score'],'coverage':card['coverage']}),end='');return
        finally:gate.__exit__(*sys.exc_info())
    path=Path(args.snapshot) if args.snapshot else None
    if path is None:
        latest=read(store/'latest.json')
        if not latest:raise ValueError('no captured quality card yet; wait for the built-in capture timer')
        path=Path(root)/latest['snapshot']
    result=score(read(path))
    resolved=path.resolve();base=(store/'snapshots').resolve()
    key=str(result['window']['endAtMs'])+'-'+result['factsSha256']
    native=base in resolved.parents and resolved.name==key+'.json'
    if not native:result['officialCapture']=False
    if args.save:
        if base not in resolved.parents:
            raise ValueError('external snapshot evaluation is read-only; save a native captured snapshot')
        if not native:raise ValueError('native snapshot identity does not match its facts')
        target=store/'cards'/(key+'.json')
        if not target.exists():_write_card(team,root,target,result)
    print(canonical(result),end='')


def _write_card(team, root, path, value):
    encoded=canonical(value).encode()
    path.parent.mkdir(parents=True,exist_ok=True)
    with team.inbox_lock(root,'quality-card-'+path.stem,purpose='质量卡保存'):
        if path.exists():
            if path.read_bytes()!=encoded:raise ValueError('immutable quality card conflict')
            return
        temporary=None
        try:
            with tempfile.NamedTemporaryFile(mode='wb',dir=path.parent,prefix='.quality-',delete=False) as stream:
                temporary=Path(stream.name);stream.write(encoded);stream.flush();os.fsync(stream.fileno())
            os.replace(temporary,path)
        finally:
            if temporary is not None and temporary.exists():temporary.unlink()


def command(team,args):
    try:
        return _command(team,args)
    except (OSError,ValueError,KeyError,TypeError) as error:
        if args.quality_action=='tick':
            try:
                root=team.find_root()
                team.write_json(str(Path(root)/'.genethub/team/quality/last-error.json'),
                                {'atMs':team.now_ms(),'error':type(error).__name__,'status':'unknown'})
            except Exception:pass
        raise team.ExpertError('质量事实或评分未完成: '+type(error).__name__,
                               '诊断保持未知，没有改变派单或业务结果',
                               '核对质量快照、过程事件与采集状态；修复后按原窗口重算') from error


def reflection_signal(root, state):
    """One newly observed hourly deficit; replay captures are not new hours."""
    try:
        latest = read(Path(root)/'.genethub/team/quality/latest.json')
        if not latest:
            return None
        value = read(Path(root)/latest['card'])
        if not isinstance(value, dict):
            return None
        key = str(value['window']['endAtMs']) + ':' + str(value.get('measurementVersion'))
        if state.get('qualitySignal') == key:
            return None
        result = value.get('score') if value.get('formal') else value.get('provisionalScore')
        if value.get('formal') and number(result) and result >= 80:
            return None
        return ('新小时质量卡存在明显失分或数据不足；按卡中证据处理', key)
    except (OSError, ValueError, KeyError, TypeError):
        return None  # malformed input is not permission to invent a patrol


def briefing(root, now):
    """Compact references and the three largest losses, never full histories."""
    compact = lambda value, limit: ' '.join(str(value or '').split())[:limit]
    lines = []
    try:
        from .quality_live import current
        live = current(root)
        lines.append('实时告警: 红线%d，警告%d，未知%d；全文 .genethub/team/quality/live-alerts.json' %
                     (len(live.get('redLines', [])), len(live.get('warnings', [])), len(live.get('unknown', []))))
        for alert in live.get('redLines', [])[:4]:
            lines.append('- %s %s %s 责任=%s' % (alert.get('rule'), alert.get('id'),
                         compact(alert.get('workItemId'), 90), compact((alert.get('attribution') or {}).get('component'), 30)))
        latest = read(Path(root)/'.genethub/team/quality/latest.json')
        if not latest:
            return ['质量首行: 未知，尚无小时卡；不能作为达标证据。'] + lines
        value = read(Path(root)/latest['card'])
        if not isinstance(value, dict):
            raise ValueError('missing quality card')
        headline = ('正式分: ' + str(value.get('score'))) if value.get('formal') else ('非正式: ' + str(value.get('provisionalScore')) + '，不能作为达标证据')
        lines.insert(0, '质量首行: ' + headline)
        version = (value.get('versions') or {}).get('teamTemplate') or {}
        lines += ['自然卡: ' + latest['card'], '原生事实: ' + latest['snapshot'],
                  '团队运行样板: ' + compact(canonical(version).strip(), 300),
                  '覆盖: ' + compact(canonical(value.get('coverage')).strip(), 250)]
        if value['window']['endAtMs'] < now//HOUR*HOUR:
            lines.append('本小时尚无新卡；上卡不能替代本小时。')
        losses = sorted(value.get('losses', []), key=lambda x: -(x['loss'] if number(x.get('loss')) else 0))[:3]
        lines.append('最大三个失分或缺口（其余见原卡）:')
        for loss in losses:
            lines.append('- %s 失分=%s %s' % (loss.get('id'), loss.get('loss'), compact(loss.get('reason'), 180)))
        return lines
    except (OSError, ValueError, KeyError, TypeError):
        return ['质量首行: 未知，质量卡读取失败；不能按零失分或达标处理。'] + lines

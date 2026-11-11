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

HOUR = 3600000


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


def native_snapshot(team, sid, machine, since, kernel, cache, budget):
    """Only existing public inspect/rounds/narrative commands; no transcript cache."""
    def call(*args):
        if time.monotonic() >= budget:
            raise TimeoutError('quality capture budget exhausted')
        return team.genet(*args, *team.machine_args(machine), timeout=min(15, max(1, budget-time.monotonic())))
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
    full_history = (coverage.get('basis') == 'native-page-completion/1'
                    and coverage.get('roundsComplete') is True
                    and coverage.get('narrativeComplete') is True)
    covered = old and (old.get('sinceAtMs', since+1) <= since or full_history)
    if stable and covered and old.get('workspaceId')==summary.get('workspaceId') and old.get('status')==summary.get('status') and old.get('inputSummary')==summary.get('inputSummary',{}) and old.get('kernel') == kernel and old.get('updatedAtMs') == summary.get('updatedAtMs'):
        return old
    inspection = call('session', 'inspect', sid)['inspection']
    rounds, cursor, round_digest = [], None, None
    for _ in range(100):
        args = ['session', 'rounds', sid, '--limit', '100']
        if cursor: args += ['--cursor', cursor]
        page = call(*args)['page']
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
    rounds.sort(key=lambda x: (x['startedAtMs'], x['roundId']))
    completed = [x for x in rounds if x.get('endedAtMs', 0) > 0 and x.get('outcome')]
    anchor = completed[-1]['roundId'] if completed else None
    turns, links, cursor, digest = [], [], None, None
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
                if item.get('type') != 'userMessage': continue
                header=item.get('text','').split('\n\n',1)[0]
                if header.startswith('用途: result\n'):
                    ref=next((line[5:] for line in header.splitlines() if line.startswith('ref: ')),None)
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
             'historyCoverage': {'basis':'native-page-completion/1','roundsComplete':rounds_complete,
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



def task_trees(tasks, goal_tasks, controls, native, end, intents=(), log=()):
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
            person=dict(sessionId=sid,readable=own is not None,runs=union_intervals(runs),
                        backgroundRuns=job_intervals(log,sid,task_id,stopped))
            if number(joined):person['openedAtMs']=joined
            sessions.append(person)
        result.append(dict(taskId=task_id,openedAtMs=opened,endedAtMs=stopped,
                           excluded=union_intervals(excluded),sessions=sessions))
    return result


def capture(team, root, end, cutoff, budget_seconds=100, live=False):
    state = Path(root)/'.genethub/team'
    store = state/'quality'
    start = end-HOUR
    metric_start = end-24*HOUR
    from .quality_epoch import context as epoch_context
    lifecycle = epoch_context(root, end)
    if lifecycle['epoch']:
        metric_start = max(metric_start, lifecycle['epoch']['atMs'])
        start = max(start, metric_start)
        if start >= end:raise ValueError('await the first post-adoption measurement hour')
    before = template_digest()
    log = events(root, cutoff)
    tasks = {v['taskId']: v for v in records(state/'tasks')}
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
        changes = [(created, 'active')]+[(x['atMs'], x['state']) for x in controls if x.get('taskId')==task['taskId']]
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
    native, platforms, processes = {}, {}, {}
    for machine in sorted(set(wanted.values()),key=lambda x:x or ""):
        try:
            ctx=capture_call('context',*team.machine_args(machine))['daemon']
            platforms[machine]={'version':ctx['version'],'machineId':ctx['machineId']}
            processes[machine]=capture_call('process','list',*team.machine_args(machine))['processes']
        except Exception as error:
            issues.append({'kind':'machine-facts-unavailable','machine':machine,'error':type(error).__name__})
    order=list(wanted.items())
    if live:
        active={x["sessionId"] for x in records(state/"pending") if x.get("sessionId")}
        critical=active|{i["requester"] for i in work if i.get("sessionId") in active and i.get("requester")}
        order.sort(key=lambda x:(x[0] not in critical,(store/"native"/(x[0]+".json")).exists()))
    for sid,machine in order:
        try:
            if not team.SESSION_ID.fullmatch(sid): raise ValueError('invalid native session identity')
            native[sid]=native_snapshot(team,sid,machine,history_starts.get(sid,metric_start),platforms.get(machine),store/'native'/ (sid+'.json'),budget)
        except Exception as error:
            issues.append({'kind':'native-read-unavailable','sessionId':sid,'error':type(error).__name__})
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
    deliveries = list(delivery_map.values())
    reworked = {i['follows'] for i in work if i.get('follows')}
    resources_complete, idle_complete = True, True
    for item in work:
        own=native.get(item['sessionId'], {})
        stop=min(end,item['conclusionAtMs']) if number(item.get('conclusionAtMs')) else end
        samples=sorted([x for x in observed if x.get('sessionId')==item['sessionId'] and x['atMs'] < stop],key=lambda x:x['atMs'])
        children=[x for x in work if x['requester']==item['sessionId']]
        item['idlePeriods']=idle_periods(samples,own.get('rounds',[]),children,max(metric_start,item['dispatchAtMs']),stop)
        if number(item.get('conclusionAtMs')) and item['conclusionAtMs'] <= end:
            for period in item['idlePeriods']:
                if period['resolvedAtMs'] is None:period['resolvedAtMs']=item['conclusionAtMs']
        if not item['standing'] and item['hasReceipt'] and stop > start and stop-item['dispatchAtMs'] > HOUR:
            left=max(item['dispatchAtMs'],start-HOUR)
            recent=[x for x in samples if x['atMs'] >= left-60000]
            # A minute timer can finish a Task just before its next sample.
            # Use the same existing state freshness as work_activity and the
            # interior-gap proof; a 66-second terminal tail is still observed.
            covered=bool(recent) and recent[0]['atMs'] <= left+60000 and recent[-1]['atMs']+125000 >= stop
            covered=covered and all(b['atMs']-a['atMs'] <= 125000 for a,b in zip(recent,recent[1:]))
            idle_complete=idle_complete and covered
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
    adopted=[i for i in work if i.get('disposition')=='adopted-inferred' and number(i.get('executionMs'))]
    if not baseline and len(adopted)>=20:
        first=sorted(adopted,key=lambda i:(i['conclusionAtMs'],i['id']))[:20]
        baseline={'schema':'team-quality-baseline/1','workItemIds':[i['id'] for i in first],
                  'executionMsPerAdopted':sum(i['executionMs'] for i in first)/20,'frozenAtMs':cutoff}
        team.write_json(str(store/'baseline.json'),baseline)
    from .quality_attribution import context as attribution_context
    attribution = attribution_context(hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                                      hashlib.sha256(Path(team.__file__).read_bytes()).hexdigest())
    return {'schema':'team-quality-facts/1','scoringModel':'tq/2','resourceObligationBasis':'dispatch-resource-obligation/2','evidenceCoverageBasis':'per-source-failure-domain/1','resultAudienceBasis':'source-result-generation/1','idleObservationBasis':'native-minute-freshness/1','attributionContext':attribution,'taskTrees':task_trees(tasks,goal_tasks,controls,native,end,intents,log),
            'executionFacts':{'schema':'team-execution-facts/1','scoreMeaningChanged':False,
                              'backgroundBasis':'registered-native-process-runtime/1',
                              'backgroundRunsAppliedToScore':False,
                              'note':'Measurement foundation; final versioned scoring model will consume timing segments and background runs'},
            'taskTreesSourceComplete':goal_ownership_known,'taskHoursBasis':'task-controls-and-native-rounds/1','team':Path(root).name,'window':{'startAtMs':start,'endAtMs':end},
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
                        'templateAtCapture':before,'eventTemplates':sorted({x['templateSha256'] for x in log if x.get('templateSha256') and start <= x['atMs'] < end})},
            'issues':issues,'observationBasis':'native minute state samples; explicit controls and native handoff timestamps'}


def register(sub):
    p=sub.add_parser('quality',help='deterministic work-quality facts, cards and history; never controls work')
    a=p.add_subparsers(dest='quality_action',required=True)
    a.add_parser('tick')
    c=a.add_parser('card');c.add_argument('--snapshot');c.add_argument('--save',action='store_true')
    c=a.add_parser('execution',help='read-only versioned dispatch/background-work projection; never saves a quality card')
    c.add_argument('--snapshot',required=True)
    a.add_parser('history');a.add_parser('describe');a.add_parser('facts')
    c=a.add_parser('alerts',help='current open redlines or read-only external alert replay');c.add_argument('--snapshot')
    c=a.add_parser('triage',help='record redline attribution without closing a repair');c.add_argument('incident')
    c.add_argument('--attribution',required=True,choices=['team','platform-template','kernel','provider','unknown'])
    c.add_argument('--evidence',required=True)
    c=a.add_parser('resolve',help='verify repaired/adopted evidence and current native obligation before closing a redline')
    c.add_argument('incident');c.add_argument('--repair-evidence',required=True);c.add_argument('--adoption-evidence',required=True)


def _command(team,args):
    root=team.find_root();store=Path(root)/'.genethub/team/quality'
    action=args.quality_action
    if action in ('alerts','triage','resolve'):
        from . import quality_live
        value=(quality_live.replay(read(Path(args.snapshot))) if args.snapshot else quality_live.current(root)) if action=='alerts' else (
            quality_live.triage(team,root,args) if action=='triage' else quality_live.resolve(team,root,args))
        print(canonical(value),end='');return
    if action=='execution':
        from .execution_facts import view
        print(canonical(view(read(Path(args.snapshot)))),end='');return
    if action=='describe':
        from .quality_score import WEIGHTS,INDICATORS
        print(canonical({'model':'tq/2','supportedModels':['tq/1','tq/2'],'r6':{'basis':'task-agent-hours/1','minimumTotalEffectiveMs':1800000,'minimumHourEffectiveMs':900000,'required':2},'weights':WEIGHTS,'indicators':INDICATORS,'redLines':['R1','R2','R3','R4','R5','R6'],
                         'formal':{'knownWeightPct':80,'closedWorkItems':20,'allRedLinesDecidable':True},'window':'red lines: previous complete UTC hour and unresolved old instances; indicators: rolling 24h','inference':'native read-in without follows is tentative adoption'}),end='');return
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
            redstate=read(store/'redline-state.json') or {}
            if any(x['atMs'] >= end for x in redstate.get('measurementEpochs',[])):
                print(canonical({'status':'重新测量中','cardProduced':False,'reason':'await first post-adoption hour; prior immutable cards retained'}),end='');return
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


def briefing(root,now):
    try:
        from .quality_live import briefing as live_briefing
        live_lines=live_briefing(root)
        store=Path(root)/'.genethub/team/quality'
        latest=read(store/'latest.json')
        if not latest:return live_lines+['','## 团队工作质量','未知：尚无小时卡；等待内置质量采集。']
        value=read(Path(root)/latest['card'])
        stale=value['window']['endAtMs'] < now//HOUR*HOUR
        lines=live_lines+['','## 团队工作质量（'+value.get('measurementVersion',value.get('model','tq/1'))+'）',
               '卡：'+latest['card'], '事实：'+latest['snapshot'],
               '正式分：'+str(value['score']) if value['formal'] else '暂定：'+('未知' if value['provisionalScore'] is None else str(value['provisionalScore']))+'，不能作为达标证据。',
               '覆盖：'+canonical(value['coverage']).strip(), '采用版本：'+canonical(value['versions']).strip()]
        if value.get('attribution'):
            lines.append('失分归因（全部计分，责任来源不等于已证实根因）：'+canonical(value['attribution']).strip())
        lines.append('有效在途小时均值（已确认下界/可能上界）：'+canonical(value.get('effectiveInFlight')).strip())
        if value.get('model')=='tq/2':
            lines.append('R6：按任务树实际Agent工时/有效墙钟；累计至少30分钟且本小时至少15分钟才考核，低于2触发；没有合格任务为不适用。只连续计算同一口径的卡。')
            lines.append('任务并行：'+canonical(value.get('taskParallelism')).strip())
        else:
            lines.append('R6：有未完成用户目标期间，小时均值低于2触发；暂停/等用户不计。上下界间的不确定性不能算作达标。')
        if stale:lines.append('当前整点小时尚无卡；上卡不能替代本小时。')
        lines.append('失分与缺口（按卡内顺序）：')
        for loss in value['losses'][:16]:
            detail=dict(loss)
            if detail.get('id')=='R6' and detail.get('loss') is None:
                # A valid goals/starts capture can still await conclusions or
                # activity observations. Do not diagnose missing starts from
                # the score's aggregate uncertainty label; keep the card intact.
                detail['reason']=('原生任务树会话执行区间读取缺失；核对各任务上下界及missingSessionIds。' if value.get('model')=='tq/2' else '目标/开工覆盖、活动观测或后继结论尚不足以判定；核对小时均值上下界与事实快照。')
            lines.append('- '+canonical(detail).strip())
        lines.append('按实际原因自主选择改进；没有新增流程、岗位或改进格式要求。')
        return lines
    except (OSError,ValueError,KeyError,TypeError):
        return ['','## 团队工作质量','未知：质量卡读取失败；不能按零失分或达标处理。']

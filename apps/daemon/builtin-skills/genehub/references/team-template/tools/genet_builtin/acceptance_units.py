"""Acceptance boundaries from dispatch identity, never role names or prose similarity."""
import copy
import re
from .task_hours import clipped, intervals, length, subtract, union

BASIS = 'dispatch-acceptance-unit/1'


def link(t, root, task, operation_id, requester, follows=None, unit_of=None, stage=None):
    """Attach to an existing dispatch; this is not a new registration workflow."""
    if stage not in (None, 'work', 'integration', 'verification'):
        raise ValueError('invalid acceptance stage')
    if follows and unit_of == 'new':
        raise ValueError('rework cannot reset its acceptance unit')
    anchor = follows or (unit_of if unit_of != 'new' else None)
    if anchor:
        if not isinstance(anchor, str) or not re.fullmatch(r'taskop\.[0-9a-f]{64}', anchor):
            raise ValueError('acceptance reference must be an operationId')
        row = t.read_dispatch_record(t.state_dir(root, 'task-dispatch', anchor + '.json'))
        if not row or row.get('request', {}).get('taskId') != task['taskId']:
            raise ValueError('acceptance reference must be an existing dispatch in this task')
        original = row['request'].get('acceptanceUnit') or {}
        unit_id = original.get('id', anchor)
    elif unit_of == 'new':
        unit_id = operation_id
    else:
        from .tasks import records
        rows = [x for x in records(t, root, 'task-dispatch')
                if x.get('sessionId') == requester and x.get('request', {}).get('taskId') == task['taskId']]
        ids = {x['request']['acceptanceUnit']['id'] for x in rows if x['request'].get('acceptanceUnit')}
        if len(ids) == 1:
            unit_id = next(iter(ids))
        elif task.get('acceptanceBasis') == BASIS and not rows:
            from .tasks import identity
            root_id = 'taskop.' + identity(task['taskId'] + ':owner')
            original = t.read_dispatch_record(t.state_dir(root, 'task-dispatch', root_id + '.json'))
            if requester == (task.get('owner') or {}).get('sessionId'):
                # Explicit handover retains the original goal and origin,
                # even when the new Owner has no dispatch of its own.
                unit_id = ((original or {}).get('request', {}).get('acceptanceUnit') or {}).get('id')
                if not unit_id:
                    return None
            elif not task.get('owner') and requester == task.get('front'):
                unit_id = operation_id
            else:
                return None
        else:
            return None  # Old, unlinked work is not a fresh independent iteration.
    return dict(basis=BASIS, id=unit_id, stage=stage or 'work',
                relation='rework' if follows else 'origin' if unit_id == operation_id else 'support')


def collect(tasks, intents, work, trees, native, end):
    """Keep a repair, its integration, and its verification in one clock.

    A support's success alone never closes the iteration. Either the original
    task concludes, or all explicitly linked stages conclude, including both
    integration and verification, and the Owner completes the result-reading
    round. This is a work boundary, not proof of successful product acceptance.
    """
    by_op = {x['operationId']: x for x in intents}
    by_work = {x['id']: x for x in work}
    output = []
    for tree in trees:
        task_id = tree['taskId']; task = tasks[task_id]
        records = [x for x in intents if x.get('request', {}).get('taskId') == task_id
                   and x.get('createdAtMs', end) < end]
        groups, unlinked = {}, []
        for row in records:
            meta = row.get('request', {}).get('acceptanceUnit') or {}
            if meta.get('basis') == BASIS:
                groups.setdefault(meta['id'], []).append(row)
            else:
                unlinked.append(row)
        for unit_id, members in groups.items():
            origin = by_op.get(unit_id)
            if not origin or origin.get('request', {}).get('taskId') != task_id:
                raise ValueError('acceptance origin missing or belongs to another task')
            if origin not in members:
                members.append(origin)
            unlinked = [x for x in unlinked if x['operationId'] != unit_id]
        if unlinked or not groups:
            # A finished original task has a complete native boundary. An old
            # open container has no evidence for its internal iteration starts.
            groups['legacy:' + task_id] = unlinked
        people = {x['sessionId']: x for x in tree['sessions']}
        owner_ids = {x.get('sessionId') for x in [task.get('owner') or {}] + task.get('previousOwners', [])}
        made = []
        for unit_id, members in sorted(groups.items()):
            origin = by_op.get(unit_id)
            opened = origin['createdAtMs'] if origin else tree['openedAtMs']
            stopped = tree['endedAtMs']; boundary = None
            finished = task.get('finished') or {}
            if isinstance(finished.get('atMs'), (int, float)) and finished['atMs'] <= end:
                boundary = dict(kind='task-conclusion', atMs=finished['atMs'])
            elif origin:
                stages = {x.get('request', {}).get('acceptanceUnit', {}).get('stage') for x in members}
                results = [by_work.get(x['operationId'], {}) for x in members]
                if not (task.get('owner') or {}).get('machine') and {'integration', 'verification'} <= stages and all(
                        isinstance(x.get('conclusionAtMs'), (int, float))
                        and isinstance(x.get('consumedAtMs'), (int, float)) for x in results):
                    direct = [x for x in results if x.get('requester') in owner_ids]
                    latest = max(direct, key=lambda x: x['consumedAtMs'], default=None)
                    read = latest['consumedAtMs'] if latest else end+1
                    messages = set(latest.get('deliveryMessageIds', [])) if latest else set()
                    rounds = [x for sid in owner_ids for x in native.get(sid, {}).get('rounds', [])
                              if x.get('outcome') == 'completed' and x.get('userItemId') in messages
                              and isinstance(x.get('endedAtMs'), (int, float)) and read <= x['endedAtMs'] <= end]
                    if rounds:
                        last = min(rounds, key=lambda x: x['endedAtMs'])
                        boundary = dict(kind='linked-stages-and-owner-round', atMs=last['endedAtMs'], roundId=last['roundId'])
            if boundary:
                stopped = min(stopped, boundary['atMs'])
            if stopped <= opened:
                continue
            sids = {x.get('sessionId') for x in members} | owner_ids
            sessions = [copy.deepcopy(people[sid]) for sid in sorted(sids - {None}) if sid in people]
            known = bool(origin or boundary)
            made.append(dict(unitId=unit_id, taskId=task_id, openedAtMs=opened, endedAtMs=stopped,
                             excluded=copy.deepcopy(tree['excluded']), sessions=sessions,
                             boundaryKnown=known, boundaryBasis=BASIS,
                             boundaryReason=None if known else 'legacy-open-goal-has-no-native-iteration-boundary',
                             conclusion=boundary, operationIds=sorted(x['operationId'] for x in members)))
        if len(made) > 1:
            for unit in made:
                origin = by_op.get(unit['unitId'])
                container = (unit['unitId'].startswith('legacy:') or origin is not None
                             and origin.get('request', {}).get('requester') == task.get('front'))
                if container:
                    children = [(x['openedAtMs'], x['endedAtMs']) for x in made if x is not unit]
                    unit['excluded'] = [{'startAtMs': a, 'endAtMs': b}
                        for a,b in union(intervals(unit['excluded']) + children)]
                    unit.update(boundaryKnown=False, boundaryReason='unassociated-container-residual', container=True)
        # One Owner cannot be charged to every concurrent unit. Assign only
        # intervals with exactly one active unit; ambiguous time stays unknown.
        for unit in made:
            other = union(pair for x in made if x is not unit
                          for pair in subtract([[x['openedAtMs'], x['endedAtMs']]], intervals(x['excluded'])))
            for person in unit['sessions']:
                if person['sessionId'] not in owner_ids:
                    continue
                window = [[unit['openedAtMs'], unit['endedAtMs']]]
                own_wall = subtract(window, intervals(unit['excluded']))
                overlap = sum(length(clipped(other,a,b)) for a,b in own_wall)
                original_work = union(intervals(person['runs']) + intervals(person.get('backgroundRuns', [])))
                exclusions = other + intervals(unit['excluded'])
                allocated = subtract(clipped(intervals(person['runs']), unit['openedAtMs'], unit['endedAtMs']), exclusions)
                background = [dict(x, startAtMs=a, endAtMs=b)
                    for x in person.get('backgroundRuns', [])
                    for a,b in subtract([[max(x['startAtMs'],window[0][0]), min(x['endAtMs'],window[0][1])]], exclusions)
                    if b>a]
                person['runs'] = [{'startAtMs': a, 'endAtMs': b} for a,b in allocated]
                person['backgroundRuns'] = background
                if overlap:
                    ambiguous = subtract(clipped(original_work, unit['openedAtMs'], unit['endedAtMs']),
                                         subtract(window, other) + intervals(unit['excluded']))
                    person['partialCoverage'] = bool(ambiguous)
                    person['allocationUnknownRuns'] = [{'startAtMs': a, 'endAtMs': b} for a,b in ambiguous]
                    person['allocationUnknownMs'] = length(ambiguous)
        output.extend(made)
    return output

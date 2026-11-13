"""Task-tree Agent time over effective wall time, independent of conclusions."""
import math

LEGACY_BASIS = 'task-agent-hours/1'
TIERED_BASIS = 'task-agent-hours/2'
BASIS = 'acceptance-unit-agent-hours/3'
TIERS = ((1800000, 0.75), (3600000, 1.5), (7200000, 2))


def policy():
    return dict(basis=BASIS, minimumTotalEffectiveMs=1800000,
                minimumHourEffectiveMs=900000,
                unitBasis='dispatch-acceptance-unit/1',
                executionBasis='registered-native-execution-union/2',
                tiers=[dict(minimumTotalEffectiveMs=minimum, required=required)
                       for minimum, required in TIERS])


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def union(rows):
    result = []
    for a, b in sorted(rows):
        if b <= a:
            continue
        if result and a <= result[-1][1]:
            result[-1][1] = max(result[-1][1], b)
        else:
            result.append([a, b])
    return result


def intervals(rows):
    if not isinstance(rows, list) or any(not isinstance(x, dict)
            or not numeric(x.get('startAtMs')) or not numeric(x.get('endAtMs'))
            or x['endAtMs'] <= x['startAtMs'] for x in rows):
        raise ValueError('invalid task-hour intervals')
    return union((x['startAtMs'], x['endAtMs']) for x in rows)


def subtract(rows, excluded):
    result = union(rows)
    for left, right in excluded:
        next_rows = []
        for a, b in result:
            if right <= a or left >= b:
                next_rows.append([a, b])
            else:
                if a < left:
                    next_rows.append([a, left])
                if right < b:
                    next_rows.append([right, b])
        result = next_rows
    return result


def clipped(rows, left, right):
    return union((max(a, left), min(b, right)) for a, b in rows
                 if min(b, right) > max(a, left))


def length(rows):
    return sum(b-a for a, b in rows)


def evaluate(trees, start, end, basis=LEGACY_BASIS):
    if basis not in (LEGACY_BASIS, TIERED_BASIS, BASIS):
        raise ValueError('unsupported task-hour basis')
    if not isinstance(trees, list):
        raise ValueError('task trees are required for tq/2')
    result, task_ids = [], set()
    for tree in trees:
        task_id = tree.get('unitId') if basis == BASIS else tree.get('taskId')
        opened, stopped = tree.get('openedAtMs'), tree.get('endedAtMs')
        if (not isinstance(task_id, str) or not task_id or task_id in task_ids
                or not numeric(opened) or not numeric(stopped) or stopped < opened):
            raise ValueError('invalid or duplicate task-hour task')
        task_ids.add(task_id)
        excluded = intervals(tree.get('excluded', []))
        if basis == BASIS:
            # Effective unit wall excludes settled waiting gaps. This optional
            # native fact does not remove real Agent effort from time costs,
            # and older frozen /1 or /2 calculations keep their old meaning.
            excluded = union(excluded + intervals(tree.get('concludedIntervals', [])))
        total = subtract(clipped([[opened, stopped]], opened, end), excluded)
        wall = clipped(total, start, end)
        total_ms, wall_ms = length(total), length(wall)
        people = tree.get('sessions')
        if not isinstance(people, list):
            raise ValueError('task-hour sessions are required')
        session_ids, missing, agent_ms, missing_ms = set(), [], 0, 0
        for person in people:
            sid = person.get('sessionId')
            if not isinstance(sid, str) or not sid or sid in session_ids:
                raise ValueError('invalid or duplicate task-hour Session')
            session_ids.add(sid)
            joined = person.get('openedAtMs', opened)
            if not numeric(joined):
                raise ValueError('invalid task-hour Session membership time')
            member_wall = clipped(wall, max(opened, joined), end)
            if person.get('readable') is not True and basis != BASIS:
                if member_wall:
                    missing.append(sid); missing_ms += length(member_wall)
                continue
            runs = intervals(person.get('runs'))
            if basis == BASIS and person.get('readable') is not True:
                runs = intervals(person.get('knownBackgroundRuns', []))
            # Union each Session before summing people. Parallel tools and
            # overlapping execution records cannot manufacture extra Agents.
            known = sum(length(clipped(runs, a, b)) for a, b in member_wall)
            agent_ms += known
            if basis == BASIS and (person.get('readable') is not True or person.get('partialCoverage')):
                missing.append(sid)
                if person.get('readable') is not True:
                    missing_ms += length(member_wall)-known
                else:
                    uncertain = intervals(person.get('allocationUnknownRuns', []))
                    missing_ms += sum(length(clipped(uncertain,a,b)) for a,b in member_wall)
        low = agent_ms/wall_ms if wall_ms else None
        high = low+missing_ms/wall_ms if wall_ms else None
        required = 2
        if basis in (TIERED_BASIS, BASIS):
            required = next((threshold for minimum, threshold in reversed(TIERS)
                             if total_ms >= minimum), None)
        eligible = total_ms >= 1800000 and wall_ms >= 900000
        state = ('not-applicable' if not eligible else
                 'unknown' if basis == BASIS and tree.get('boundaryKnown') is not True else
                 'pass' if low >= required else 'fail' if high < required else 'unknown')
        row = dict(taskId=task_id, totalEffectiveMs=total_ms,
                           hourEffectiveMs=wall_ms, agentMs=agent_ms,
                           low=low, high=high, missingSessionIds=sorted(missing),
                           eligible=eligible, state=state)
        if basis in (TIERED_BASIS, BASIS):
            row['required'] = required
        if basis == BASIS:
            row.update(taskId=tree['taskId'], unitId=task_id, boundaryBasis=tree.get('boundaryBasis'),
                       boundaryKnown=tree.get('boundaryKnown') is True,
                       reason=tree.get('boundaryReason'), operationIds=tree.get('operationIds', []),
                       conclusion=tree.get('conclusion'))
        result.append(row)
    return result

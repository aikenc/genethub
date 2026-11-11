"""Task-tree Agent time over effective wall time, independent of conclusions."""
import math


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


def evaluate(trees, start, end):
    if not isinstance(trees, list):
        raise ValueError('task trees are required for tq/2')
    result, task_ids = [], set()
    for tree in trees:
        task_id = tree.get('taskId')
        opened, stopped = tree.get('openedAtMs'), tree.get('endedAtMs')
        if (not isinstance(task_id, str) or not task_id or task_id in task_ids
                or not numeric(opened) or not numeric(stopped) or stopped < opened):
            raise ValueError('invalid or duplicate task-hour task')
        task_ids.add(task_id)
        total = subtract(clipped([[opened, stopped]], opened, end),
                         intervals(tree.get('excluded', [])))
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
            if person.get('readable') is not True:
                if member_wall:
                    missing.append(sid); missing_ms += length(member_wall)
                continue
            runs = intervals(person.get('runs'))
            # Union each Session before summing people. Parallel tools and
            # overlapping execution records cannot manufacture extra Agents.
            agent_ms += sum(length(clipped(runs, a, b)) for a, b in member_wall)
        low = agent_ms/wall_ms if wall_ms else None
        high = low+missing_ms/wall_ms if wall_ms else None
        eligible = total_ms >= 1800000 and wall_ms >= 900000
        state = ('not-applicable' if not eligible else
                 'pass' if low >= 2 else 'fail' if high < 2 else 'unknown')
        result.append(dict(taskId=task_id, totalEffectiveMs=total_ms,
                           hourEffectiveMs=wall_ms, agentMs=agent_ms,
                           low=low, high=high, missingSessionIds=sorted(missing),
                           eligible=eligible, state=state))
    return result

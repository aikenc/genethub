M = 60_000


def clip(iv, lo, hi):
    return [(max(a, lo), min(b, hi)) for a, b in iv if min(b, hi) > max(a, lo)]


def union(iv):
    out = []
    for a, b in sorted(iv):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def length(iv): return sum(b - a for a, b in union(iv))


def minus(iv, cut):
    res = union(iv)
    for c0, c1 in union(cut):
        nxt = []
        for a, b in res:
            if c1 <= a or c0 >= b: nxt.append((a, b)); continue
            if a < c0: nxt.append((a, c0))
            if c1 < b: nxt.append((c1, b))
        res = nxt
    return res


def r6(tasks, start, end, min_wall=30 * M, required=2):
    """tasks: [{id, open:(a,b), excluded:[...], sessions:{sid:{'runs':[...], 'known':bool}}}]"""
    out = []
    for t in tasks:
        wall = minus(clip([t['open']], start, end), t.get('excluded', []))
        wall_ms = length(wall)
        if wall_ms < min_wall:
            continue  # short tasks are not judged
        known = sum(length(clip(minus(s['runs'], t.get('excluded', [])), *t['open']) and
                    [x for w in wall for x in clip(s['runs'], *w)]) for s in t['sessions'].values() if s['known'])
        missing = [sid for sid, s in t['sessions'].items() if not s['known']]
        low = known / wall_ms
        high = low + len(missing)  # an unread session can add at most 1 over the wall time
        state = 'pass' if low >= required else 'fail' if high < required else 'unknown'
        out.append({'task': t['id'], 'wallMin': round(wall_ms / M), 'parallel': round(low, 2), 'state': state})
    return out


H = 3600_000
cases = [
    {'id': 'short-10min-serial', 'open': (0, 10 * M), 'sessions': {'o': {'runs': [(0, 10 * M)], 'known': True}}},
    {'id': '50min-serial', 'open': (0, 50 * M), 'sessions': {'o': {'runs': [(0, 50 * M)], 'known': True}}},
    {'id': '50min-owner+3', 'open': (0, 50 * M), 'sessions': {
        'o': {'runs': [(0, 5 * M), (45 * M, 50 * M)], 'known': True},
        'a': {'runs': [(5 * M, 45 * M)], 'known': True}, 'b': {'runs': [(5 * M, 40 * M)], 'known': True},
        'c': {'runs': [(10 * M, 45 * M)], 'known': True}}},
    {'id': '60min-paused-40', 'open': (0, 60 * M), 'excluded': [(10 * M, 50 * M)],
     'sessions': {'o': {'runs': [(0, 10 * M), (50 * M, 60 * M)], 'known': True}}},
    {'id': '40min-one-unread', 'open': (0, 40 * M), 'sessions': {
        'o': {'runs': [(0, 40 * M)], 'known': True}, 'r': {'runs': [], 'known': False}}},
]
for row in r6(cases, 0, H):
    print(row)

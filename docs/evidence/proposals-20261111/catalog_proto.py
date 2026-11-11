import re

BANDS = [('veryLow', 0.02), ('low', 0.2), ('medium', 0.6), ('high', 1.2), ('veryHigh', float('inf'))]
LEVEL_X = {'veryLow': 0.01, 'low': 0.1, 'medium': 0.4, 'high': 1.0, 'veryHigh': 2.5}

# family: regex fully matched against the version-free family key
# versions: optional "lo..hi" range on the extracted version (inclusive, open ends allowed)
RULES = [
    {'family': 'claude-fable', 'cap': 'Ultra', 'x': 2.0},
    {'family': 'gpt-astra', 'cap': 'Ultra', 'x': 2.6},
    {'family': 'claude-opus', 'cap': 'Max', 'x': 0.85},
    {'family': 'claude-opus', 'versions': '..4.99', 'cap': 'Max', 'x': 1.0},
    {'family': 'claude-sonnet', 'cap': 'Pro', 'x': 0.43},
    {'family': 'claude-haiku', 'cap': 'Flash', 'x': 0.03},
    {'family': 'claude-haiku', 'versions': '..4.99', 'cap': 'Flash', 'x': 0.2},
    {'family': 'gpt-sol', 'cap': 'Max', 'x': 0.43},
    {'family': 'gpt-sol', 'versions': '5.6..5.6', 'cap': 'Max', 'x': 1.0},
    {'family': 'gpt-terra', 'cap': 'Pro', 'x': 0.21},
    {'family': 'gpt-luna', 'cap': 'Flash', 'x': 0.03},
    {'family': 'deepseek-flash', 'cap': 'Flash', 'x': 0.05},
    {'family': 'deepseek-pro', 'cap': 'Pro', 'x': 0.16},
    {'family': 'kimi-k', 'versions': '3..', 'cap': 'Max', 'x': 0.8},
    {'family': 'kimi-k(-code)?', 'versions': '..2.99', 'cap': 'Pro', 'x': 0.32},
    {'family': 'glm-flash', 'cap': 'Flash', 'x': 0.05},
    {'family': 'glm(-turbo|v-turbo)?', 'cap': 'Pro', 'x': 0.45},
    {'family': 'hy', 'cap': 'Pro', 'x': 0.4},
]
MODIFIERS = {'fast': 2.0}
NOISE = r'-(\d{8}|\d{4}-\d{2}-\d{2}|latest|preview|exp|thinking|1m)$'


def parse(raw):
    s = raw.lower().strip().rsplit('/', 1)[-1]
    s = re.sub(r'^(us|eu|global|apac)\.', '', s)
    s = re.sub(r'^(anthropic|openai|google|moonshot|zai|deepseek)[.:]', '', s)
    s = re.sub(r'[\s_:]+', '-', s)
    mods = []
    while True:
        t = re.sub(NOISE, '', s)
        for m in MODIFIERS:
            if t.endswith('-' + m):
                t = t[:-len(m) - 1]; mods.append(m)
        if t == s: break
        s = t
    s = re.sub(r'(?<=\d)-(?=\d)', '.', s)
    m = re.search(r'(?:^|[-a-z])v?(\d+(?:\.\d+)*)', s)
    ver = tuple(int(p) for p in m.group(1).split('.')) if m else ()
    family = re.sub(r'-?v?\d+(?:\.\d+)*', '', s).strip('-')
    family = re.sub(r'-+', '-', family)
    return s, family, ver, mods


def in_range(ver, spec):
    lo, hi = (spec.split('..') + [''])[:2]
    t = lambda x: tuple(int(p) for p in x.split('.'))
    return (not lo or ver >= t(lo)) and (not hi or ver <= t(hi))


def width(spec):
    if not spec: return float('inf')
    lo, hi = spec.split('..')
    lo = float(lo or 0); hi = float(hi or 1e9)
    return hi - lo


def resolve(raw, user=None):
    if user: return {**user, 'source': 'user'}
    s, family, ver, mods = parse(raw)
    hits = [r for r in RULES if re.fullmatch(r['family'], family) and in_range(ver, r.get('versions', ''))]
    if not hits:
        return {'id': s, 'family': family, 'cap': 'Mini', 'x': LEVEL_X['veryHigh'], 'level': 'veryHigh', 'source': 'fallback'}
    r = min(hits, key=lambda r: width(r.get('versions', '')))
    x = r['x']
    for m in mods: x *= MODIFIERS[m]
    level = next(n for n, hi in BANDS if x < hi)
    return {'id': s, 'family': family, 'ver': ver, 'mods': mods, 'cap': r['cap'], 'x': round(x, 3), 'level': level,
            'rule': r['family'] + (' ' + r['versions'] if 'versions' in r else '')}


CASES = {
    'claude/claude-fable-5-2': ('Ultra', 'veryHigh'), 'claude/claude-fable-6': ('Ultra', 'veryHigh'),
    'codex/gpt-6-astra': ('Ultra', 'veryHigh'), 'bedrock/us.anthropic.claude-opus-5-5-20261001': ('Max', 'high'),
    'claude/claude-opus-4-8-fast': ('Max', 'veryHigh'), 'cursor/claude-sonnet-5.5-thinking': ('Pro', 'medium'),
    'openrouter/anthropic/claude-haiku-5.5': ('Flash', 'low'), 'claude/claude-haiku-4-5': ('Flash', 'medium'),
    'codex/gpt-6.1-sol': ('Max', 'medium'), 'codex/gpt-5.6-sol': ('Max', 'high'), 'codex/gpt-6.2-terra-latest': ('Pro', 'medium'),
    'codex/gpt-6-luna': ('Flash', 'low'), 'codebuddy/deepseek-v4.1-flash': ('Flash', 'low'), 'codebuddy/DeepSeek-V4-Pro': ('Pro', 'low'),
    'codebuddy/GLM-5.2': ('Pro', 'medium'), 'codebuddy/glm-5.3-flash': ('Flash', 'low'), 'codebuddy/GLM-5v-Turbo': ('Pro', 'medium'),
    'codebuddy/Kimi-K3': ('Max', 'high'), 'codebuddy/Kimi-K2.7-Code': ('Pro', 'medium'), 'codebuddy/hy3-preview': ('Pro', 'medium'),
    'foo/bar-1': ('Mini', 'veryHigh'),
}
bad = 0
for raw, want in CASES.items():
    got = resolve(raw)
    ok = (got['cap'], got['level']) == want
    bad += not ok
    print('ok ' if ok else 'BAD', f'{raw:46s}', got)
print('failures', bad)

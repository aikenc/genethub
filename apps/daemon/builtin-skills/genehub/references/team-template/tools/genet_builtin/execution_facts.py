"""Clock-qualified execution observations; these do not select a scoring model."""
import math
import copy


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def dispatch_timing(item, incoming, source_events):
    """Keep source preparation separate from the executor's native input wait.

    Source ACK observations are upper bounds. Never subtract a remote wall
    clock from a source wall clock or silently clamp a negative duration.
    """
    dispatch = item['dispatchAtMs']
    ready = next((x['atMs'] for x in source_events
                  if x['kind'] == 'dispatch-confirmed'), None)
    accepted = next((x['atMs'] for x in source_events
                     if x['kind'] == 'input-accepted' and x.get('purpose') == 'task'), None)
    received, begun = incoming.get('receivedAtMs'), item.get('startedAtMs')
    source_stop = accepted if number(accepted) else ready
    platform = (source_stop-dispatch if number(source_stop) and source_stop >= dispatch else None)
    native = begun-received if number(begun) and number(received) and begun >= received else None
    return {'schema': 'team-dispatch-timing/1',
            'platformPreparation': {'durationMsUpperBound': platform,
                'dispatchAtMs': dispatch, 'preparedObservedAtMs': ready,
                'activationAcceptedObservedAtMs': accepted, 'clock': 'source',
                'component': 'platform-template', 'includes': ['writer-and-workstation-wait', 'native-session-preparation', 'activation-transport'],
                'timeBasis': 'observed-ack-upper-bound'},
            'sessionStart': {'durationMs': native, 'inputReceivedAtMs': received,
                'firstRoundStartedAtMs': begun, 'clock': 'executor',
                'component': 'platform-kernel', 'timeBasis': 'native-input-and-round'},
            'additive': False,
            'reason': 'ACK upper bounds may overlap executor input wait; cross-machine clocks are not subtracted'}


SCORE_BASIS = 'registered-native-execution-union/2'


def project(facts):
    """Union registered native work once per Session and subtract it from stalls.

    One Session remains one Agent, regardless of the number of concurrent
    tools/jobs. Task controls are subtracted by the shared task-hour algebra.
    """
    from .task_hours import intervals, union, subtract, clipped
    if facts.get('schema') != 'team-quality-facts/1':
        raise ValueError('unsupported execution snapshot schema')
    start, end = facts['window']['startAtMs'], facts['window']['endAtMs']
    if not number(start) or not number(end) or start >= end:
        raise ValueError('invalid execution snapshot window')
    result = copy.deepcopy(facts)
    trees = result.get('taskTrees', [])
    background = {}
    for tree in trees + result.get('acceptanceUnits', []):
        opened, stopped = tree['openedAtMs'], tree['endedAtMs']
        for person in tree['sessions']:
            registered = person.get('backgroundRuns', [])
            if not isinstance(registered, list) or any(x.get('basis') != 'registered-native-process-runtime/1'
                    or not isinstance(x.get('jobId'), str) or not x['jobId'] for x in registered):
                raise ValueError('background intervals require native registration evidence')
            work = clipped(intervals(registered), max(opened, person.get('openedAtMs', opened)), min(end, stopped))
            if tree in trees:
                background.setdefault(tree['taskId'], []).extend(subtract(work, intervals(tree.get('excluded', []))))
            person['knownBackgroundRuns'] = [{'startAtMs': a, 'endAtMs': b} for a,b in work]
            person['runs'] = [{'startAtMs': a, 'endAtMs': b}
                              for a, b in union(intervals(person['runs'])+work)]
    stalls = []
    for value in facts.get('stalls', []):
        # Native sampling can record an idle observation at a single instant.
        # It has no elapsed exposure, unlike a reversed or missing interval.
        if number(value.get('startAtMs')) and value.get('endAtMs') == value['startAtMs']:
            continue
        for a, b in subtract(intervals([value]), background.get(value['taskId'], [])):
            stalls.append(dict(value, startAtMs=a, endAtMs=b))
    result['stalls'] = stalls
    return result


def view(facts):
    """Diagnostic projection remains explicitly separate from formal cards."""
    from .task_hours import evaluate
    projected = project(facts)
    start, end = facts['window']['startAtMs'], facts['window']['endAtMs']
    return {'schema': 'team-execution-view/1', 'officialCapture': False,
            'scoreMeaningChanged': False, 'taskParallelism': evaluate(projected['taskTrees'], start, end),
            'taskTrees': projected['taskTrees'], 'stalls': projected['stalls'],
            'dispatchTiming': [{'workItemId': i['id'], 'timing': i['dispatchTiming']}
                               for i in facts.get('workItems', []) if i.get('dispatchTiming')],
            'note': 'Diagnostic projection; current model scores and historical cards are unchanged'}

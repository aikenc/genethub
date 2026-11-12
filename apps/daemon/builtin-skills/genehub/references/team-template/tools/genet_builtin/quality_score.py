"""Deterministic tq/1 arithmetic over a frozen, provenance-bearing snapshot."""
import hashlib
import json
import math

WEIGHTS = {'M1': 25, 'M2': 20, 'M3': 20, 'M4': 15, 'M5': 10, 'M6': 10}
LEVELS = [0, 60, 80, 90, 100]
INDICATORS = [
    ('M1', 'firstPassAdoptionPct', [30, 60, 75, 85, 92], False),
    ('M1', 'reworkPct', [50, 30, 20, 12, 6], True),
    ('M2', 'dispatchToStartP90Min', [60, 20, 10, 5, 2], True),
    ('M2', 'conclusionToDeliveryP90Min', [60, 10, 3, 1.5, .5], True),
    ('M2', 'deliveryToConsumeP90Min', [120, 30, 10, 5, 2], True),
    ('M3', 'unsolicitedHumanInputsPerTaskDay', [10, 4, 2, 1, 0], True),
    ('M4', 'costPerAdoptedVsBaseline', [2, 1.2, 1, .85, .7], True),
    ('M4', 'coordinationSharePct', [60, 40, 30, 22, 15], True),
    ('M5', 'idleWakePct', [50, 25, 12, 6, 2], True),
    ('M6', 'failedTurnPct', [10, 4, 2, 1, .3], True),
    ('M6', 'recoveryP90Min', [240, 60, 20, 10, 5], True),
]


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n'


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def interpolation(value, anchors, lower):
    points = list(zip([-x for x in anchors] if lower else anchors, LEVELS))
    value = -value if lower else value
    if value <= points[0][0]:
        return 0.0
    if value >= points[-1][0]:
        return 100.0
    for (a, x), (b, y) in zip(points, points[1:]):
        if a <= value <= b:
            return round(x + (y-x) * (value-a) / (b-a), 3)
    raise ValueError('invalid anchors')


def p90(values):
    values = sorted(values)
    return values[max(0, math.ceil(len(values)*.9)-1)] if values else None


def intersection(a, b, c, d):
    return max(0, min(b, d) - max(a, c))


def activity_intervals(value):
    if not isinstance(value, dict) or value.get('basis') != 'native-minute-and-rounds/1':
        raise ValueError('unsupported work activity basis')
    groups = []
    for key in ('active','excluded'):
        rows = value.get(key)
        if not isinstance(rows, list) or any(not isinstance(x,dict) or
                not number(x.get('startAtMs')) or not number(x.get('endAtMs')) or
                x['endAtMs'] <= x['startAtMs'] for x in rows):
            raise ValueError('invalid work activity interval')
        groups.append(sorted(rows,key=lambda x:x['startAtMs']))
    merged = sorted(groups[0]+groups[1],key=lambda x:x['startAtMs'])
    if any(a['endAtMs'] > b['startAtMs'] for a,b in zip(merged,merged[1:])):
        raise ValueError('work activity intervals must be disjoint')
    return groups


def score(facts):
    if facts.get('schema') != 'team-quality-facts/1':
        raise ValueError('unsupported quality facts schema')
    model = facts.get('scoringModel', 'tq/1')
    if model not in ('tq/1', 'tq/2'):raise ValueError('unsupported scoring model')
    resource_basis = facts.get('resourceObligationBasis')
    if resource_basis not in (None, 'dispatch-resource-obligation/2'):
        raise ValueError('unsupported resource obligation basis')
    coverage_basis = facts.get('evidenceCoverageBasis')
    if coverage_basis not in (None, 'per-source-failure-domain/1'):
        raise ValueError('unsupported evidence coverage basis')
    audience_basis = facts.get('resultAudienceBasis')
    if audience_basis not in (None, 'source-result-generation/1'):
        raise ValueError('unsupported result audience basis')
    idle_basis = facts.get('idleObservationBasis')
    if idle_basis not in (None, 'native-minute-freshness/1', 'native-minute-freshness/2'):
        raise ValueError('unsupported idle observation basis')
    start, end = facts['window']['startAtMs'], facts['window']['endAtMs']
    cutoff = facts['capturedAtMs']
    if not all(number(x) for x in (start, end, cutoff)) or not start < end <= cutoff:
        raise ValueError('window must be ordered and already ended')
    metric_start = facts.get('measurementWindow', facts['window'])['startAtMs']
    if not number(metric_start) or metric_start > start:
        raise ValueError('measurement horizon must include the card hour')
    coverage = facts.get('coverage', {})
    items = facts.get('workItems', [])
    closed = [i for i in items if number(i.get('conclusionAtMs')) and metric_start <= i['conclusionAtMs'] < end]
    relevant = [i for i in items if number(i.get('dispatchAtMs')) and i['dispatchAtMs'] < end]
    finite = [i for i in closed if not i.get('standing')]
    instances = {key: [] for key in ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']}

    def breach(key, item, due, resolved=None, reason=None):
        if due < end and (resolved is None or resolved >= start) and (resolved is None or resolved > due):
            value = {'workItemId': item['id'], 'dueAtMs': due, 'resolvedAtMs': resolved}
            if reason:value['reason']=reason
            instances[key].append(value)

    delivery_uncertain, idle_uncertain, resource_uncertain = False, False, False
    for item in relevant:
        audience = item.get('deliveryAudience') if audience_basis is not None else None
        if audience is not None and (not isinstance(audience, dict)
                or audience.get('operationId') != item['id']
                or audience.get('primary') != item.get('requester')
                or not isinstance(audience.get('ref'), str)
                or not isinstance(audience.get('watchers'), list)
                or len(audience['watchers']) > 64
                or any(not isinstance(x, str) for x in audience['watchers'])):
            raise ValueError('invalid source result audience')
        dispatched = item['dispatchAtMs']
        confirmed = item.get('confirmedAtMs')
        terminal = item.get('withdrawnAtMs')
        resolved = min([x for x in (confirmed, terminal) if number(x)], default=None)
        if not item.get('exempt') and (number(resolved) or (coverage.get('dispatches') is True and item.get('hasReceipt') is False)):
            breach('R1', item, dispatched + 600000, resolved)
        concluded = item.get('conclusionAtMs')
        if not item.get('standing'):
            if isinstance(item.get('idlePeriods'),list):
                for period in item['idlePeriods']:
                    due=period['startAtMs']+3600000
                    resolved=period.get('resolvedAtMs')
                    if period['observedThroughAtMs'] >= due:
                        breach('R2',item,due,resolved)
                    elif due < min(end,resolved if number(resolved) else end) and (not number(resolved) or resolved >= start):
                        idle_uncertain=True
            elif number(item.get('idleSinceAtMs')):
                breach('R2', item, item['idleSinceAtMs'] + 3600000, concluded)
        if not number(concluded) or concluded >= end:
            continue
        delivered = item.get('deliveredAtMs')
        bounds=item.get('deliveryBounds',[])
        correct_bounds=[x['acceptedUpperBoundMs'] for x in bounds if x['recipient']==item.get('requester')]
        # Bounds overlapping this hour cannot prove historical lateness or
        # absence of duplicate/misroute occurrences. Before-hour bounds can
        # discharge old obligations without manufacturing exact M2 samples.
        if any(x['acceptedUpperBoundMs']>=start for x in bounds):delivery_uncertain=True
        if (coverage.get('deliveries') is True or item.get('deliveryCoverageKnown') is True) and not correct_bounds:
            breach('R3', item, concluded + 600000, delivered)
        if isinstance(item.get('deliveryEvents'), list):
            deliveries = sorted({(x['recipient'],x['messageId']):x for x in item['deliveryEvents']
                                 if number(x.get('acceptedAtMs')) and x['acceptedAtMs'] < end}.values(),
                                key=lambda x:(x['acceptedAtMs'],x['messageId']))
            correct = [x['acceptedAtMs'] for x in deliveries if x['recipient']==item.get('requester')]
            correct += [at for at in correct_bounds if at<start]
            for delivery in deliveries:
                if delivery['recipient'] == item.get('requester'):continue
                if (audience is not None and delivery.get('ref') == audience['ref']
                        and delivery['recipient'] in audience['watchers']):
                    continue
                at=delivery['acceptedAtMs']
                # A later correct delivery closes the wrong-route obligation.
                # A misroute after success is an occurrence in its own hour.
                resolved = at if any(t <= at for t in correct) else min(correct,default=None)
                breach('R3',item,at-1,resolved,'wrong-recipient')
            for index,delivery in enumerate(deliveries):
                prior_bound=any(x['acceptedUpperBoundMs']<=delivery['acceptedAtMs']
                                and (audience_basis is None or x['recipient']==delivery['recipient']) for x in bounds)
                prior = index > 0 if audience_basis is None else any(
                    x['recipient']==delivery['recipient'] for x in deliveries[:index])
                if (prior or prior_bound) and start <= delivery['acceptedAtMs'] < end:
                    instances['R3'].append({'workItemId':item['id'],'reason':'duplicate-result',
                                            'atMs':delivery['acceptedAtMs']})
        else:
            if item.get('recipient') and item.get('recipient') != item.get('requester'):
                instances['R3'].append({'workItemId':item['id'],'reason':'wrong-recipient'})
            if len(set(item.get('deliveryMessageIds', []))) > 1:
                # Legacy IDs without occurrence times cannot place a duplicate
                # in this hour or prove it remains an outstanding obligation.
                delivery_uncertain = True
        if item.get('resourceRequired') and concluded + 600000 < end and item.get('resourceHeld') is not True and not number(item.get('releasedAtMs')):
            resource_uncertain = True
        if item.get('resourceRequired') and item.get('releaseTimeBasis') == 'observed-absence-upper-bound' and number(item.get('releasedAtMs')):
            if concluded + 600000 < min(end,item['releasedAtMs']) and item['releasedAtMs'] >= start:
                resource_uncertain = True
        if item.get('resourceRequired') and (item.get('resourceHeld') is True or (number(item.get('releasedAtMs')) and item.get('releaseTimeBasis') == 'verified-release')):
            breach('R5', item, concluded + 600000, item.get('releasedAtMs'))
    for stall in facts.get('stalls', []):
        if number(stall.get('startAtMs')) and number(stall.get('endAtMs')):
            breach('R4', {'id': stall['taskId']}, stall['startAtMs'] + 900000, stall['endAtMs'])

    intervals = sorted(facts.get('goalIntervals', []), key=lambda s: s['startAtMs'])
    if any(not number(s.get('startAtMs')) or not number(s.get('endAtMs')) or s['endAtMs'] <= s['startAtMs'] for s in intervals):
        raise ValueError('invalid goal interval')
    if any(a['endAtMs'] > b['startAtMs'] for a,b in zip(intervals, intervals[1:])):
        raise ValueError('goal intervals must be a disjoint union')
    active = [s for s in intervals if not s.get('paused') and not s.get('waitingForUser')]
    # Goal intervals are already the union: concurrent user goals do not
    # multiply elapsed time, and overlapping work is integrated exactly.
    active_ms = sum(intersection(start, end, s['startAtMs'], s['endAtMs']) for s in active)
    lower_area, upper_area = 0, 0
    for item in relevant:
        begun = item.get('startedAtMs')
        concluded = item.get('conclusionAtMs')
        if not number(begun):
            continue
        stop = min(concluded, end) if number(concluded) else end
        area = sum(intersection(max(start, begun), stop, s['startAtMs'], s['endAtMs']) for s in active)
        known_area, possible_area = area, area
        if 'workActivity' in item:
            observed_active, excluded = activity_intervals(item['workActivity'])
            def measured(intervals):
                return sum(intersection(max(start,begun,s['startAtMs']),min(stop,s['endAtMs']),
                                        x['startAtMs'],x['endAtMs']) for s in active for x in intervals)
            known_area = measured(observed_active)
            possible_area -= measured(excluded)
        # Old frozen snapshots keep their original arithmetic. New captures
        # expose activity bounds: unknown gaps cannot inflate the lower bound
        # or erase possible work, and pause/wait cannot inflate either bound.
        upper_area += possible_area
        if number(concluded) and concluded <= cutoff:
            lower_area += known_area
    parallel = None if not active_ms else lower_area / active_ms
    possible_parallel = None if not active_ms else upper_area / active_ms
    r6_known = coverage.get('goals') is True and coverage.get('starts') is True and bool(active_ms)
    if r6_known and parallel < 2 <= possible_parallel:
        r6_known = False  # eventual conclusions are still unknown
    if r6_known and possible_parallel < 2:
        instances['R6'].append({'effectiveInFlightMean': round(parallel, 6), 'required': 2})

    task_report = None
    if model == 'tq/2':
        from .task_hours import evaluate, BASIS, LEGACY_BASIS
        r6_basis = facts.get('r6Basis', LEGACY_BASIS)
        task_report = evaluate(facts.get('taskTrees'), start, end, basis=r6_basis)
        eligible = [x for x in task_report if x['eligible']]
        failed = [x for x in eligible if x['state']=='fail']
        instances['R6'] = [dict(taskId=x['taskId'], effectiveParallelism=x['low'],
                               possibleParallelism=x['high'], required=x.get('required', 2),
                               hourEffectiveMs=x['hourEffectiveMs']) for x in failed]
        r6_known = bool(failed) or (facts.get('taskTreesSourceComplete') is True
                                   and all(x['state']!='unknown' for x in eligible))
        wall = sum(x['hourEffectiveMs'] for x in eligible)
        parallel = sum(x['agentMs'] for x in eligible)/wall if wall else None
        possible_parallel = sum(x['high']*x['hourEffectiveMs'] for x in eligible)/wall if wall else None

    required = {'R1': 'dispatches', 'R2': 'idleObligations' if 'idleObligations' in coverage else 'observations', 'R3': 'deliveries', 'R4': 'observations', 'R5': 'resources'}
    lifecycle = facts.get('redlineLifecycle')
    if lifecycle is not None:
        from .quality_epoch import validate
        validate(lifecycle)
        for row in lifecycle['open'] if lifecycle['policy'] == 'verified-repair-adoption/1' else []:
            rule=row['rule']
            if rule not in instances:raise ValueError('unsupported durable redline rule')
            if not instances[rule]:
                instances[rule].append({'workItemId':row['workItemId'],'incidentId':row['id'],
                    'reason':'repair-adoption-unverified','dueAtMs':row['firstSeenAtMs']-1})
    red = {}
    for key in instances:
        known = r6_known if key == 'R6' else coverage.get(required[key]) is True
        if key=='R2' and idle_uncertain:known=False
        if key=='R3' and delivery_uncertain:known=False
        if key=='R5' and resource_uncertain:known=False
        red[key] = {'triggered': True if instances[key] else (False if known else None),
                    'instances': instances[key], 'coverageKnown': known}

    measurements = {}
    def measure(key, values, *, value=None, samples=None, missing='insufficient or missing observations'):
        count = len(values) if samples is None else samples
        measurements[key] = {'value': value if count >= 20 and number(value) else None,
                             'samples': count, 'reason': None if count >= 20 and number(value) else missing}

    disposed = [i for i in finite if i.get('disposition') in ('adopted-inferred', 'rework', 'discarded')]
    adopted = [i for i in disposed if i['disposition'] == 'adopted-inferred']
    measure('firstPassAdoptionPct', disposed, value=100*len(adopted)/len(disposed) if disposed else None)
    measure('reworkPct', disposed, value=100*sum(i['disposition']=='rework' for i in disposed)/len(disposed) if disposed else None)
    for name, a, b in [('dispatchToStartP90Min', 'dispatchAtMs', 'startedAtMs'),
                       ('conclusionToDeliveryP90Min', 'conclusionAtMs', 'deliveredAtMs'),
                       ('deliveryToConsumeP90Min', 'deliveredAtMs', 'consumedAtMs')]:
        values = [(i[b]-i[a])/60000 for i in finite if number(i.get(a)) and number(i.get(b)) and i[b] >= i[a]]
        measure(name, values, value=p90(values))
    inputs = [x for x in facts.get('inputs', []) if number(x.get('deliveredAtMs')) and metric_start <= x['deliveredAtMs'] < end]
    human = [x for x in inputs if x.get('source') == 'user']
    unread_human=any(x.get('source')=='user' and number(x.get('receivedAtMs')) and metric_start <= x['receivedAtMs'] < end and not number(x.get('deliveredAtMs')) for x in facts.get('inputs',[]))
    classified = coverage.get('inputs') is True and not unread_human and all(type(x.get('unsolicited')) is bool for x in human)
    exposure = facts.get('measurementGoalIntervals', facts.get('goalIntervals', []))
    days = sum(intersection(metric_start,end,x['startAtMs'],x['endAtMs']) for x in exposure) / 86400000
    measure('unsolicitedHumanInputsPerTaskDay', [], samples=len(closed) if classified else 0,
            value=sum(x['unsolicited'] for x in human)/days if classified and days else None,
            missing='native source/input classification or active task exposure missing')
    costs = [i['executionMs'] for i in finite if number(i.get('executionMs'))]
    baseline = facts.get('baseline', {})
    ratio = None
    if len(costs) == len(finite) and adopted and number(baseline.get('executionMsPerAdopted')) and baseline['executionMsPerAdopted'] > 0:
        ratio = (sum(costs)/len(adopted)) / baseline['executionMsPerAdopted']
    measure('costPerAdoptedVsBaseline', [], samples=len(finite), value=ratio, missing='frozen own-Team first20 baseline or complete native execution durations missing')
    turns = [x for x in facts.get('turns', []) if number(x.get('finishedAtMs')) and metric_start <= x['finishedAtMs'] < end]
    total_ms = sum(x.get('durationMs', 0) for x in turns if number(x.get('durationMs')))
    coordination = sum(x['durationMs'] for x in turns if x.get('coordination') is True and number(x.get('durationMs')))
    complete_cost = coverage.get('turns') is True and all(type(x.get('coordination')) is bool for x in turns)
    measure('coordinationSharePct', [], samples=len(turns), value=100*coordination/total_ms if complete_cost and total_ms else None)
    wakes = [x for x in facts.get('wakes', []) if metric_start <= x['atMs'] < end]
    known_wakes = [x for x in wakes if type(x.get('ledgerChanged')) is bool]
    measure('idleWakePct', known_wakes, value=100*sum(not x['ledgerChanged'] for x in known_wakes)/len(known_wakes) if known_wakes else None)
    evaluated = [x for x in turns if x.get('outcome') in ('completed', 'failed')]
    measure('failedTurnPct', evaluated, value=100*sum(x['outcome']=='failed' for x in evaluated)/len(evaluated) if evaluated and coverage.get('turns') is True else None)
    recoveries = [x['recoveryMs']/60000 for x in facts.get('failures', []) if number(x.get('recoveryMs'))]
    measure('recoveryP90Min', recoveries, value=p90(recoveries), missing='no measured recovery sample; absence is not zero recovery time')

    indicators = {}
    for metric, name, anchors, lower in INDICATORS:
        value = measurements[name]
        indicators[name] = dict(value, metric=metric,
                                score=interpolation(value['value'], anchors, lower) if value['value'] is not None else None)
    metrics = {}
    for metric in WEIGHTS:
        values = [v['score'] for v in indicators.values() if v['metric']==metric and v['score'] is not None]
        metrics[metric] = round(sum(values)/len(values), 3) if values else None
    weight = sum(WEIGHTS[k] for k,v in metrics.items() if v is not None)
    base = sum(WEIGHTS[k]*v for k,v in metrics.items() if v is not None)/weight if weight else None
    triggered = [k for k,v in red.items() if v['triggered'] is True]
    unknown = [k for k,v in red.items() if v['triggered'] is None]
    penalty = 50*len(triggered)
    provisional = max(0, base-penalty) if base is not None else None
    low = max(0, (base or 0)*weight/100-penalty-50*len(unknown))
    high = max(0, ((base or 0)*weight+100*(100-weight))/100-penalty)
    formal = weight >= 80 and not unknown and len(closed) >= 20 and bool(active_ms)
    losses = []
    route = 'platform:template' if facts.get('mechanismPristine') is True else 'pending'
    for key in triggered:
        losses.append({'id': key, 'loss': 50, 'gapTo80': 50, 'route': route, 'instances': len(instances[key])})
    for key in unknown:
        losses.append({'id':key,'loss':None,'gapTo80':None,'route':'pending','reason':('unread native task-tree Session intervals' if key=='R6' and model=='tq/2'
                                                                 else 'missing coverage: '+required.get(key,'goals/starts'))})
    for name, value in indicators.items():
        if value['score'] is None:
            losses.append({'id': name, 'loss': None, 'gapTo80': None, 'route': 'pending', 'reason': value['reason']})
        else:
            n = sum(v['metric']==value['metric'] and v['score'] is not None for v in indicators.values())
            losses.append({'id': name, 'loss': round(WEIGHTS[value['metric']]/weight/n*(100-value['score']), 3),
                           'gapTo80':round(WEIGHTS[value['metric']]/weight/n*max(0,80-value['score']),3), 'route': 'pending'})
    losses.sort(key=lambda x: (x['gapTo80'] is not None, -(x['gapTo80'] or 0), -(x['loss'] or 0), x['id']))
    result = {'schema': 'team-quality-card/1', 'model': model, 'team': facts.get('team'),
            'window': facts['window'], 'measurementWindow': facts.get('measurementWindow',facts['window']), 'capturedAtMs': cutoff, 'versions': facts.get('versions', {}),
            'factsSha256': hashlib.sha256(canonical(facts).encode()).hexdigest(),
            'score': round(provisional, 3) if formal and provisional is not None else None,
            'provisionalScore': round(provisional, 3) if provisional is not None else None,
            'officialCapture': facts.get('captureKind')=='native-hour' and end % 3600000==0 and end-start==3600000,
            'base': round(base, 3) if base is not None else None, 'penalty': penalty, 'formal': formal,
            'possibleRange': [round(low, 3), round(high, 3)], 'metrics': metrics, 'indicators': indicators,
            'redLines': red, 'coverage': {'knownWeightPct': weight, 'unknownRedLines': unknown, 'closedWorkItems': len(closed)},
            'effectiveInFlight': {'knownMean': parallel, 'possibleMean': possible_parallel, 'activeGoalMs': active_ms},
            'inputSources': {k: sum(x.get('source')==k for x in inputs) for k in ['user', 'agent', 'system']},
            'adoptionBasis': 'inferred after native read-in without a follows rework; not confirmed project acceptance',
            'losses': losses}

    if model == 'tq/2':
        result['taskParallelism'] = task_report
        result['redLines']['R6']['applicable'] = (
            bool(eligible) if facts.get('taskTreesSourceComplete') is True or failed else None)
        result['redLines']['R6']['basis'] = r6_basis
        result['effectiveInFlight']['basis'] = 'eligible-task-weighted-summary/1'
        result['streakCompatibilityKey'] = model
    if resource_basis is not None:result['resourceObligationBasis'] = resource_basis
    if coverage_basis is not None:result['evidenceCoverageBasis'] = coverage_basis
    if audience_basis is not None:result['resultAudienceBasis'] = audience_basis
    if idle_basis is not None:result['idleObservationBasis'] = idle_basis
    bases = ([r6_basis] if model == 'tq/2' and r6_basis == BASIS else [])
    bases += [x for x in (resource_basis,coverage_basis,audience_basis,idle_basis) if x is not None]
    if bases:
        result['measurementVersion'] = '+'.join([model]+bases)
        result['streakCompatibilityKey'] = result['measurementVersion']
    if 'warnings' in facts:
        result['warnings']=facts['warnings']
        result['liveWarningsAsOfMs']=facts.get('liveWarningsAsOfMs')
    if lifecycle is not None:
        from .quality_epoch import attach as attach_epoch
        attach_epoch(result,lifecycle)
    from .quality_attribution import attach
    attach(result, facts)
    return result

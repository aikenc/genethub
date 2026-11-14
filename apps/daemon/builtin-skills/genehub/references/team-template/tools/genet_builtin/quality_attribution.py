"""Explain responsibility for measured losses; never alter scoring arithmetic.

An automatic obligation identifies the responsible mechanism, not a proven
root cause. Native failures without cause evidence remain unresolved. Legacy
snapshots have no context and retain their original canonical card.
"""

COMPONENTS = ('team', 'platform-template', 'kernel', 'provider', 'unresolved')
SCHEMA = 'team-quality-attribution-context/1'
ROUTES = {'team': 'team', 'platform-template': 'platform:template',
          'kernel': 'platform:kernel', 'provider': 'provider', 'unresolved': 'pending'}


def context(collector_sha, coordinator_sha):
    return {'schema': SCHEMA, 'dispatch': 'builtin-task/1',
            'resultQueue': 'template-native-inbox/1',
            'resourceReturn': 'template-reconciler/1',
            'collectorSha256': collector_sha, 'coordinatorSha256': coordinator_sha}


def explanation(component, reason, evidence):
    return {'component': component, 'basis': 'operational-responsibility/1',
            'reason': reason, 'evidence': evidence, 'rootCauseConfirmed': False}


def attach(card, facts):
    ctx = facts.get('attributionContext')
    if ctx is None:
        return
    if not isinstance(ctx, dict) or ctx.get('schema') != SCHEMA:
        raise ValueError('unsupported quality attribution context')
    items = {x['id']: n for n, x in enumerate(facts.get('workItems', []))}

    def obligation(key, instance=None):
        instance = instance or {}
        n = items.get(instance.get('workItemId'))
        base = 'snapshot#/workItems/' + str(n) if n is not None else 'snapshot#/workItems'
        automatic = {
            'R1': ('dispatch', 'builtin-task/1', 'automatic-dispatch-acknowledgement',
                   ['dispatchAtMs', 'confirmedAtMs', 'withdrawnAtMs']),
            'R3': ('resultQueue', 'template-native-inbox/1', 'automatic-result-routing',
                   ['conclusionAtMs', 'deliveredAtMs', 'deliveryEvents']),
            'R5': ('resourceReturn', 'template-reconciler/1', 'automatic-resource-return',
                   ['conclusionAtMs', 'releasedAtMs', 'resourceHeld']),
        }
        if key in automatic:
            field, value, reason, fields = automatic[key]
            if ctx.get(field) == value:
                evidence = ['snapshot#/attributionContext/' + field]
                if n is not None:
                    evidence += [base + '/' + f for f in fields if f in facts['workItems'][n]]
                return explanation('platform-template', reason, evidence)
        if key == 'R6':
            return explanation('team', 'observed-task-parallelism',
                               ['snapshot#/taskTrees' if 'taskTrees' in facts else 'snapshot#/goalIntervals'])
        if key == 'R7':
            return explanation('unresolved', 'scoring-copy-differs-from-native-embedded-package; upgrade-or-edit-cause-unconfirmed',
                               ['snapshot#/scoringIntegrity'])
        return explanation('unresolved', 'native causal evidence is not available for this obligation',
                           ['snapshot#/stalls' if key == 'R4' else base])

    def metric(name):
        if name in ('firstPassAdoptionPct', 'reworkPct'):
            return explanation('team', 'recorded-work-disposition; inferred adoption is not user acceptance',
                               ['snapshot#/workItems'])
        if name in ('costPerAdoptedVsBaseline', 'coordinationSharePct'):
            return explanation('team', 'recorded-execution-usage; business efficiency root cause unconfirmed',
                               ['snapshot#/workItems', 'snapshot#/turns', 'snapshot#/baseline'])
        if name == 'conclusionToDeliveryP90Min' and ctx.get('resultQueue') == 'template-native-inbox/1':
            return explanation('platform-template', 'automatic-result-routing',
                               ['snapshot#/attributionContext/resultQueue', 'snapshot#/workItems'])
        reasons = {
            'dispatchToStartP90Min': 'platform waiting and native execution start have not yet been separated',
            'deliveryToConsumeP90Min': 'native queue acceptance does not establish Agent mid-round read capability',
            'failedTurnPct': 'failure outcome is known; native cause classification is not available',
            'idleWakePct': 'ledger change is measured; wake trigger cause is not classified',
            'unsolicitedHumanInputsPerTaskDay': 'Human input purpose needs native classification',
            'recoveryP90Min': 'measured recovery/cause evidence is insufficient',
        }
        return explanation('unresolved', reasons.get(name, 'native cause evidence is insufficient'),
                           ['snapshot#/turns' if name == 'failedTurnPct' else
                            'snapshot#/wakes' if name == 'idleWakePct' else
                            'snapshot#/inputs' if name == 'unsolicitedHumanInputsPerTaskDay' else
                            'snapshot#/failures' if name == 'recoveryP90Min' else 'snapshot#/workItems'])

    instance_counts = dict.fromkeys(COMPONENTS, 0)
    for key, red in card['redLines'].items():
        for instance in red['instances']:
            value = obligation(key, instance)
            instance['attribution'] = value
            instance_counts[value['component']] += 1
    totals = dict.fromkeys(COMPONENTS, 0)
    unmeasured = 0
    for loss in card['losses']:
        key = loss['id']
        value = obligation(key) if key in card['redLines'] else metric(key)
        if loss['loss'] is None:
            # No measured number: keep measurement uncertainty separate from
            # an observed loss with an unknown causal explanation.
            value = explanation('unresolved', loss.get('reason') or 'measurement is unknown', value['evidence'])
            unmeasured += 1
        else:
            totals[value['component']] += loss['loss']
        loss['attribution'] = value
        loss['route'] = ROUTES[value['component']]
    card['attribution'] = {
        'schema': 'team-quality-loss-attribution/1',
        'basis': 'operational-responsibility/1', 'allLossesCount': True,
        'lossByComponent': {k: round(v, 3) for k, v in totals.items()},
        'redLineInstancesByComponent': instance_counts,
        'unmeasuredLossEntries': unmeasured,
        'totalAccountedLoss': round(sum(totals.values()), 3),
        'note': 'All measured losses still count. Responsibility is not a confirmed root cause; unresolved evidence remains explicit.',
    }
